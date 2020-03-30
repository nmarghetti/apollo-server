import {
  GraphQLSchema,
  GraphQLFieldResolver,
  specifiedRules,
  DocumentNode,
  getOperationAST,
  ExecutionArgs,
  GraphQLError,
  GraphQLFormattedError,
  validate as graphqlValidate,
  parse as graphqlParse,
  execute as graphqlExecute,
  GraphQLField,
  defaultFieldResolver,
  ResponsePath,
  FieldNode,
  getNamedType,
  GraphQLObjectType,
} from 'graphql';
import {
  GraphQLExtension,
  GraphQLExtensionStack,
  enableGraphQLExtensions,
} from 'graphql-extensions';
import { DataSource } from 'apollo-datasource';
import { PersistedQueryOptions } from '.';
import {
  ApolloError,
  fromGraphQLError,
  SyntaxError,
  ValidationError,
  PersistedQueryNotSupportedError,
  PersistedQueryNotFoundError,
  formatApolloErrors,
} from 'apollo-server-errors';
import {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLRequestContext,
  GraphQLExecutor,
  GraphQLExecutionResult,
  InvalidGraphQLRequestError,
  ValidationRule,
  WithRequired,
} from 'apollo-server-types';
import {
  ApolloServerPlugin,
  GraphQLRequestListener,
  GraphQLRequestContextExecutionDidStart,
  GraphQLRequestContextResponseForOperation,
  GraphQLRequestContextDidResolveOperation,
  GraphQLRequestContextParsingDidStart,
  GraphQLRequestContextValidationDidStart,
  GraphQLRequestContextWillSendResponse,
  GraphQLRequestContextDidEncounterErrors,
} from 'apollo-server-plugin-base';

import { Dispatcher } from './utils/dispatcher';
import {
  InMemoryLRUCache,
  KeyValueCache,
  PrefixingKeyValueCache,
} from 'apollo-server-caching';
import { GraphQLParseOptions } from 'graphql-tools';

export {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLRequestContext,
  InvalidGraphQLRequestError,
};

import createSHA from './utils/createSHA';
import { HttpQueryError } from './runHttpQuery';
import { GraphQLObjectResolver } from "@apollographql/apollo-tools";

export const APQ_CACHE_PREFIX = 'apq:';

function computeQueryHash(query: string) {
  return createSHA('sha256')
    .update(query)
    .digest('hex');
}

export interface GraphQLRequestPipelineConfig<TContext> {
  schema: GraphQLSchema;

  rootValue?: ((document: DocumentNode) => any) | any;
  validationRules?: ValidationRule[];
  executor?: GraphQLExecutor;
  fieldResolver?: GraphQLFieldResolver<any, TContext>;

  dataSources?: () => DataSources<TContext>;

  extensions?: Array<() => GraphQLExtension>;
  persistedQueries?: PersistedQueryOptions;

  formatError?: (error: GraphQLError) => GraphQLFormattedError;
  formatResponse?: (
    response: GraphQLResponse | null,
    requestContext: GraphQLRequestContext<TContext>,
  ) => GraphQLResponse;

  plugins?: ApolloServerPlugin[];
  documentStore?: InMemoryLRUCache<DocumentNode>;

  parseOptions?: GraphQLParseOptions;
}

export type DataSources<TContext> = {
  [name: string]: DataSource<TContext>;
};

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

const symbolPluginDispatcher = Symbol("apolloServerPluginDispatcher");
const symbolPluginsEnabled = Symbol("apolloServerPluginsEnabled");

export async function processGraphQLRequest<TContext>(
  config: GraphQLRequestPipelineConfig<TContext>,
  requestContext: Mutable<GraphQLRequestContext<TContext>>,
): Promise<GraphQLResponse> {
  // For legacy reasons, this exported method may exist without a `logger` on
  // the context.  We'll need to make sure we account for that, even though
  // all of our own machinery will certainly set it now.
  const logger = requestContext.logger || console;

  const extensionStack = initializeExtensionStack();
  (requestContext.context as any)._extensionStack = extensionStack;

  const dispatcher = initializeRequestListenerDispatcher();
  Object.defineProperty(requestContext.context, symbolPluginDispatcher, {
    value: dispatcher,
  });

  await initializeDataSources();

  const metrics = requestContext.metrics || Object.create(null);
  if (!requestContext.metrics) {
    requestContext.metrics = metrics;
  }

  const request = requestContext.request;

  let { query, extensions } = request;

  let queryHash: string;

  let persistedQueryCache: KeyValueCache | undefined;
  metrics.persistedQueryHit = false;
  metrics.persistedQueryRegister = false;

  if (extensions && extensions.persistedQuery) {
    // It looks like we've received a persisted query. Check if we
    // support them.
    if (!config.persistedQueries || !config.persistedQueries.cache) {
      return await emitErrorAndThrow(new PersistedQueryNotSupportedError());
    } else if (extensions.persistedQuery.version !== 1) {
      return await emitErrorAndThrow(
        new InvalidGraphQLRequestError('Unsupported persisted query version'));
    }

    // We'll store a reference to the persisted query cache so we can actually
    // do the write at a later point in the request pipeline processing.
    persistedQueryCache = config.persistedQueries.cache;

    // This is a bit hacky, but if `config` came from direct use of the old
    // apollo-server 1.0-style middleware (graphqlExpress etc, not via the
    // ApolloServer class), it won't have been converted to
    // PrefixingKeyValueCache yet.
    if (!(persistedQueryCache instanceof PrefixingKeyValueCache)) {
      persistedQueryCache = new PrefixingKeyValueCache(
        persistedQueryCache,
        APQ_CACHE_PREFIX,
      );
    }

    queryHash = extensions.persistedQuery.sha256Hash;

    if (query === undefined) {
      query = await persistedQueryCache.get(queryHash);
      if (query) {
        metrics.persistedQueryHit = true;
      } else {
        return await emitErrorAndThrow(new PersistedQueryNotFoundError());
      }
    } else {
      const computedQueryHash = computeQueryHash(query);

      if (queryHash !== computedQueryHash) {
        return await emitErrorAndThrow(
          new InvalidGraphQLRequestError('provided sha does not match query'));
      }

      // We won't write to the persisted query cache until later.
      // Deferring the writing gives plugins the ability to "win" from use of
      // the cache, but also have their say in whether or not the cache is
      // written to (by interrupting the request with an error).
      metrics.persistedQueryRegister = true;
    }
  } else if (query) {
    // FIXME: We'll compute the APQ query hash to use as our cache key for
    // now, but this should be replaced with the new operation ID algorithm.
    queryHash = computeQueryHash(query);
  } else {
    return await emitErrorAndThrow(
      new InvalidGraphQLRequestError('Must provide query string.'));
  }

  requestContext.queryHash = queryHash;
  requestContext.source = query;

  const requestDidEnd = extensionStack.requestDidStart({
    request: request.http!,
    queryString: request.query,
    operationName: request.operationName,
    variables: request.variables,
    extensions: request.extensions,
    context: requestContext.context,
    persistedQueryHit: metrics.persistedQueryHit,
    persistedQueryRegister: metrics.persistedQueryRegister,
    requestContext: requestContext as WithRequired<
      typeof requestContext,
      'metrics' | 'queryHash'
    >,
  });

  try {
    // If we're configured with a document store (by default, we are), we'll
    // utilize the operation's hash to lookup the AST from the previously
    // parsed-and-validated operation.  Failure to retrieve anything from the
    // cache just means we're committed to doing the parsing and validation.
    if (config.documentStore) {
      try {
        requestContext.document = await config.documentStore.get(queryHash);
      } catch (err) {
        logger.warn(
          'An error occurred while attempting to read from the documentStore. '
          + (err && err.message) || err,
        );
      }
    }

    // If we still don't have a document, we'll need to parse and validate it.
    // With success, we'll attempt to save it into the store for future use.
    if (!requestContext.document) {
      const parsingDidEnd = await dispatcher.invokeDidStartHook(
        'parsingDidStart',
        requestContext as GraphQLRequestContextParsingDidStart<TContext>,
      );

      try {
        requestContext.document = parse(query, config.parseOptions);
        parsingDidEnd();
      } catch (syntaxError) {
        parsingDidEnd(syntaxError);
        return await sendErrorResponse(syntaxError, SyntaxError);
      }

      const validationDidEnd = await dispatcher.invokeDidStartHook(
        'validationDidStart',
        requestContext as GraphQLRequestContextValidationDidStart<TContext>,
      );

      const validationErrors = validate(requestContext.document);

      if (validationErrors.length === 0) {
        validationDidEnd();
      } else {
        validationDidEnd(validationErrors);
        return await sendErrorResponse(validationErrors, ValidationError);
      }

      if (config.documentStore) {
        // The underlying cache store behind the `documentStore` returns a
        // `Promise` which is resolved (or rejected), eventually, based on the
        // success or failure (respectively) of the cache save attempt.  While
        // it's certainly possible to `await` this `Promise`, we don't care about
        // whether or not it's successful at this point.  We'll instead proceed
        // to serve the rest of the request and just hope that this works out.
        // If it doesn't work, the next request will have another opportunity to
        // try again.  Errors will surface as warnings, as appropriate.
        //
        // While it shouldn't normally be necessary to wrap this `Promise` in a
        // `Promise.resolve` invocation, it seems that the underlying cache store
        // is returning a non-native `Promise` (e.g. Bluebird, etc.).
        Promise.resolve(
          config.documentStore.set(queryHash, requestContext.document),
        ).catch(err =>
          logger.warn(
            'Could not store validated document. ' +
            (err && err.message) || err
          )
        );
      }
    }

    // FIXME: If we want to guarantee an operation has been set when invoking
    // `willExecuteOperation` and executionDidStart`, we need to throw an
    // error here and not leave this to `buildExecutionContext` in
    // `graphql-js`.
    const operation = getOperationAST(
      requestContext.document,
      request.operationName,
    );

    requestContext.operation = operation || undefined;
    // We'll set `operationName` to `null` for anonymous operations.  Note that
    // apollo-engine-reporting relies on the fact that the requestContext passed
    // to requestDidStart is mutated to add this field before requestDidEnd is
    // called
    requestContext.operationName =
      (operation && operation.name && operation.name.value) || null;

    try {
      await dispatcher.invokeHookAsync(
        'didResolveOperation',
        requestContext as GraphQLRequestContextDidResolveOperation<TContext>,
      );
    } catch (err) {
      // XXX: The HttpQueryError is special-cased here because we currently
      // depend on `throw`-ing an error from the `didResolveOperation` hook
      // we've implemented in `runHttpQuery.ts`'s `checkOperationPlugin`:
      // https://git.io/fj427.  This could be perceived as a feature, but
      // for the time-being this just maintains existing behavior for what
      // happens when `throw`-ing an `HttpQueryError` in `didResolveOperation`.
      if (err instanceof HttpQueryError) {
        // In order to report this error reliably to the request pipeline, we'll
        // have to regenerate it with the original error message and stack for
        // the purposes of the `didEncounterErrors` life-cycle hook (which
        // expects `GraphQLError`s), but still throw the `HttpQueryError`, so
        // the appropriate status code is enforced by `runHttpQuery.ts`.
        const graphqlError = new GraphQLError(err.message);
        graphqlError.stack = err.stack;
        await didEncounterErrors([graphqlError]);
        throw err;
      }
      return await sendErrorResponse(err);
    }

    // Now that we've gone through the pre-execution phases of the request
    // pipeline, and given plugins appropriate ability to object (by throwing
    // an error) and not actually write, we'll write to the cache if it was
    // determined earlier in the request pipeline that we should do so.
    if (metrics.persistedQueryRegister && persistedQueryCache) {
      Promise.resolve(
        persistedQueryCache.set(
          queryHash,
          query,
          config.persistedQueries &&
            typeof config.persistedQueries.ttl !== 'undefined'
            ? {
                ttl: config.persistedQueries.ttl,
              }
            : Object.create(null),
        ),
      ).catch(logger.warn);
    }

    let response: GraphQLResponse | null = await dispatcher.invokeHooksUntilNonNull(
      'responseForOperation',
      requestContext as GraphQLRequestContextResponseForOperation<TContext>,
    );
    if (response == null) {
      const executionDidEnd = await dispatcher.invokeDidStartHook(
        'executionDidStart',
        requestContext as GraphQLRequestContextExecutionDidStart<TContext>,
      );

      try {
        const result = await execute(
          requestContext as GraphQLRequestContextExecutionDidStart<TContext>,
        );

        if (result.errors) {
          await didEncounterErrors(result.errors);
        }

        response = {
          ...result,
          errors: result.errors ? formatErrors(result.errors) : undefined,
        };

        executionDidEnd();
      } catch (executionError) {
        executionDidEnd(executionError);
        return await sendErrorResponse(executionError);
      }
    }

    const formattedExtensions = extensionStack.format();
    if (Object.keys(formattedExtensions).length > 0) {
      response.extensions = formattedExtensions;
    }

    if (config.formatResponse) {
      const formattedResponse: GraphQLResponse | null = config.formatResponse(
        response,
        requestContext,
      );
      if (formattedResponse != null) {
        response = formattedResponse;
      }
    }

    return sendResponse(response);
  } finally {
    requestDidEnd();
  }

  function parse(
    query: string,
    parseOptions?: GraphQLParseOptions,
  ): DocumentNode {
    const parsingDidEnd = extensionStack.parsingDidStart({
      queryString: query,
    });

    try {
      return graphqlParse(query, parseOptions);
    } finally {
      parsingDidEnd();
    }
  }

  function validate(document: DocumentNode): ReadonlyArray<GraphQLError> {
    let rules = specifiedRules;
    if (config.validationRules) {
      rules = rules.concat(config.validationRules);
    }

    const validationDidEnd = extensionStack.validationDidStart();

    try {
      return graphqlValidate(config.schema, document, rules);
    } finally {
      validationDidEnd();
    }
  }

  async function execute(
    requestContext: GraphQLRequestContextExecutionDidStart<TContext>,
  ): Promise<GraphQLExecutionResult> {
    const { request, document } = requestContext;

    const executionArgs: ExecutionArgs = {
      schema: config.schema,
      document,
      rootValue:
        typeof config.rootValue === 'function'
          ? config.rootValue(document)
          : config.rootValue,
      contextValue: requestContext.context,
      variableValues: request.variables,
      operationName: request.operationName,
      fieldResolver: config.fieldResolver,
    };

    const executionDidEnd = extensionStack.executionDidStart({
      executionArgs,
    });

    try {
      if (config.executor) {
        // XXX Nothing guarantees that the only errors thrown or returned
        // in result.errors are GraphQLErrors, even though other code
        // (eg apollo-engine-reporting) assumes that.
        return await config.executor(requestContext);
      } else {
        return await graphqlExecute(executionArgs);
      }
    } finally {
      executionDidEnd();
    }
  }

  async function sendResponse(
    response: GraphQLResponse,
  ): Promise<GraphQLResponse> {
    // We override errors, data, and extensions with the passed in response,
    // but keep other properties (like http)
    requestContext.response = extensionStack.willSendResponse({
      graphqlResponse: {
        ...requestContext.response,
        errors: response.errors,
        data: response.data,
        extensions: response.extensions,
      },
      context: requestContext.context,
    }).graphqlResponse;
    await dispatcher.invokeHookAsync(
      'willSendResponse',
      requestContext as GraphQLRequestContextWillSendResponse<TContext>,
    );
    return requestContext.response!;
  }

  /**
   * Report an error via `didEncounterErrors` and then `throw` it.
   *
   * Prior to the introduction of this function, some errors were being thrown
   * within the request pipeline and going directly to handling within
   * the `runHttpQuery.ts` module, rather than first being reported to the
   * plugin API's `didEncounterErrors` life-cycle hook (where they are to be
   * expected!).
   *
   * @param error The error to report to the request pipeline plugins prior
   *              to being thrown.
   *
   * @throws
   *
   */
  async function emitErrorAndThrow(error: GraphQLError): Promise<never> {
    await didEncounterErrors([error]);
    throw error;
  }

  async function didEncounterErrors(errors: ReadonlyArray<GraphQLError>) {
    requestContext.errors = errors;
    extensionStack.didEncounterErrors(errors);

    return await dispatcher.invokeHookAsync(
      'didEncounterErrors',
      requestContext as GraphQLRequestContextDidEncounterErrors<TContext>,
    );
  }

  async function sendErrorResponse(
    errorOrErrors: ReadonlyArray<GraphQLError> | GraphQLError,
    errorClass?: typeof ApolloError,
  ) {
    // If a single error is passed, it should still be encapsulated in an array.
    const errors = Array.isArray(errorOrErrors)
      ? errorOrErrors
      : [errorOrErrors];

    await didEncounterErrors(errors);

    return sendResponse({
      errors: formatErrors(
        errors.map(err =>
          fromGraphQLError(
            err,
            errorClass && {
              errorClass,
            },
          ),
        ),
      ),
    });
  }

  function formatErrors(
    errors: ReadonlyArray<GraphQLError>,
  ): ReadonlyArray<GraphQLFormattedError> {
    return formatApolloErrors(errors, {
      formatter: config.formatError,
      debug: requestContext.debug,
    });
  }

  function initializeRequestListenerDispatcher(): Dispatcher<
    GraphQLRequestListener
  > {
    enablePluginsForResolvers(config.schema);

    const requestListeners: GraphQLRequestListener<TContext>[] = [];
    if (config.plugins) {
      for (const plugin of config.plugins) {
        if (!plugin.requestDidStart) continue;
        const listener = plugin.requestDidStart(requestContext);
        if (listener) {
          requestListeners.push(listener);
        }
      }
    }
    return new Dispatcher(requestListeners);
  }

  function initializeExtensionStack(): GraphQLExtensionStack<TContext> {
    enableGraphQLExtensions(config.schema);

    // If custom extension factories were provided, create per-request extension
    // objects.
    const extensions = config.extensions ? config.extensions.map(f => f()) : [];

    return new GraphQLExtensionStack(extensions);
  }

  async function initializeDataSources() {
    if (config.dataSources) {
      const context = requestContext.context;

      const dataSources = config.dataSources();

      const initializers: any[] = [];
      for (const dataSource of Object.values(dataSources)) {
        if (dataSource.initialize) {
          initializers.push(
            dataSource.initialize({
              context,
              cache: requestContext.cache,
            })
          );
        }
      }

      await Promise.all(initializers);

      if ('dataSources' in context) {
        throw new Error(
          'Please use the dataSources config option instead of putting dataSources on the context yourself.',
        );
      }

      (context as any).dataSources = dataSources;
    }
  }
}


function enablePluginsForResolvers(
  schema: GraphQLSchema & { [symbolPluginsEnabled]?: boolean },
) {
  if (schema[symbolPluginsEnabled]) {
    return schema;
  }
  Object.defineProperty(schema, symbolPluginsEnabled, {
    value: true,
  });

  forEachField(schema, wrapField);

  return schema;
}

function wrapField(field: GraphQLField<any, any>): void {
  const fieldResolver = field.resolve || defaultFieldResolver;

  field.resolve = (source, args, context, info) => {
    // This is a bit of a hack, but since `ResponsePath` is a linked list,
    // a new object gets created every time a path segment is added.
    // So we can use that to share our `whenObjectResolved` promise across
    // all field resolvers for the same object.
    const parentPath = info.path.prev as ResponsePath & {
      __fields?: Record<string, ReadonlyArray<FieldNode>>;
      __whenObjectResolved?: Promise<any>;
    };

    // The technique for implementing a  "did resolve field" is accomplished by
    // returning a function from the `willResolveField` handler.  The
    // dispatcher will return a callback which will invoke all of those handlers
    // and we'll save that to call when the object resolution is complete.
    const endHandler = context && context[symbolPluginDispatcher] &&
      (context[symbolPluginDispatcher] as Dispatcher<GraphQLRequestListener>)
        .invokeDidStartHook('willResolveField', source, args, context, info) ||
          ((_err: Error | null, _result?: any) => { /* do nothing */ });

    const resolveObject: GraphQLObjectResolver<
      any,
      any
    > = (info.parentType as any).resolveObject;

    let whenObjectResolved: Promise<any> | undefined;

    if (parentPath && resolveObject) {
      if (!parentPath.__fields) {
        parentPath.__fields = {};
      }

      parentPath.__fields[info.fieldName] = info.fieldNodes;

      whenObjectResolved = parentPath.__whenObjectResolved;
      if (!whenObjectResolved) {
        // Use `Promise.resolve().then()` to delay executing
        // `resolveObject()` so we can collect all the fields first.
        whenObjectResolved = Promise.resolve().then(() => {
          return resolveObject(source, parentPath.__fields!, context, info);
        });
        parentPath.__whenObjectResolved = whenObjectResolved;
      }
    }

    try {
      let result: any;
      if (whenObjectResolved) {
        result = whenObjectResolved.then((resolvedObject: any) => {
          return fieldResolver(resolvedObject, args, context, info);
        });
      } else {
        result = fieldResolver(source, args, context, info);
      }

      // Call the stack's handlers either immediately (if result is not a
      // Promise) or once the Promise is done. Then return that same
      // maybe-Promise value.
      whenResultIsFinished(result, endHandler);
      return result;
    } catch (error) {
      // Normally it's a bad sign to see an error both handled and
      // re-thrown. But it is useful to allow extensions to track errors while
      // still handling them in the normal GraphQL way.
      endHandler(error);
      throw error;
    }
  };;
}

function isPromise(x: any): boolean {
  return x && typeof x.then === 'function';
}

// Given result (which may be a Promise or an array some of whose elements are
// promises) Promises, set up 'callback' to be invoked when result is fully
// resolved.
export function whenResultIsFinished(
  result: any,
  callback: (err: Error | null, result?: any) => void,
) {
  if (isPromise(result)) {
    result.then((r: any) => callback(null, r), (err: Error) => callback(err));
  } else if (Array.isArray(result)) {
    if (result.some(isPromise)) {
      Promise.all(result).then(
        (r: any) => callback(null, r),
        (err: Error) => callback(err),
      );
    } else {
      callback(null, result);
    }
  } else {
    callback(null, result);
  }
}

function forEachField(schema: GraphQLSchema, fn: FieldIteratorFn): void {
  const typeMap = schema.getTypeMap();
  Object.keys(typeMap).forEach(typeName => {
    const type = typeMap[typeName];

    if (
      !getNamedType(type).name.startsWith('__') &&
      type instanceof GraphQLObjectType
    ) {
      const fields = type.getFields();
      Object.keys(fields).forEach(fieldName => {
        const field = fields[fieldName];
        fn(field, typeName, fieldName);
      });
    }
  });
}

type FieldIteratorFn = (
  fieldDef: GraphQLField<any, any>,
  typeName: string,
  fieldName: string,
) => void;
