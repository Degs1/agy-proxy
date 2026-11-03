import {
  MongoClient,
  Db,
  ClientSession,
  TransactionOptions,
  ReadConcern,
  WriteConcern,
  ReadPreference,
} from 'mongodb';
import { getDatabaseConfig, maskMongoUri, DatabaseConfigError } from './config';

export type DatabaseConnectionErrorCode = 'CONFIGURATION_MISSING' | 'CONNECTION_FAILED';

export class DatabaseConnectionError extends Error {
  public readonly code: DatabaseConnectionErrorCode;
  public readonly diagnostics?: string;

  constructor(message: string, code: DatabaseConnectionErrorCode, diagnostics?: string) {
    super(message);
    this.name = 'DatabaseConnectionError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

// Global cache for MongoClient across hot reloads / serverless invocations
declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var _mongoClientInstance: MongoClient | undefined;
}

/**
 * Acquire the shared MongoClient instance with safe error handling.
 * Guarantees no sensitive credentials leak on connection failure.
 */
export async function getMongoClient(): Promise<MongoClient> {
  let config;
  try {
    config = getDatabaseConfig();
  } catch (err) {
    if (err instanceof DatabaseConfigError) {
      throw new DatabaseConnectionError(
        'Database configuration is invalid or missing.',
        'CONFIGURATION_MISSING',
        err.message
      );
    }
    throw new DatabaseConnectionError(
      'Database configuration is invalid or missing.',
      'CONFIGURATION_MISSING'
    );
  }

  if (globalThis._mongoClientInstance) {
    return globalThis._mongoClientInstance;
  }

  if (!globalThis._mongoClientPromise) {
    let client: MongoClient;
    try {
      client = new MongoClient(config.uri, {
        maxPoolSize: 50,
        minPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
    } catch (err: unknown) {
      globalThis._mongoClientPromise = undefined;
      globalThis._mongoClientInstance = undefined;

      const masked = maskMongoUri(config.uri);
      const originalMessage = err instanceof Error ? err.message : String(err);
      const sanitizedDetails = originalMessage
        .replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***:***@')
        .replace(/([?&][^=]+)=[^&#\s]*/g, '$1=***');

      const internalDiagnostics = `Host: [${masked}], DriverError: ${sanitizedDetails}`;

      throw new DatabaseConnectionError(
        'Database connection failed: Unable to connect to MongoDB Atlas.',
        'CONNECTION_FAILED',
        internalDiagnostics
      );
    }

    globalThis._mongoClientPromise = client
      .connect()
      .then((connectedClient) => {
        globalThis._mongoClientInstance = connectedClient;
        return connectedClient;
      })
      .catch((err: unknown) => {
        // Reset cached promise so subsequent attempts can retry cleanly
        globalThis._mongoClientPromise = undefined;
        globalThis._mongoClientInstance = undefined;

        const masked = maskMongoUri(config.uri);
        const originalMessage = err instanceof Error ? err.message : String(err);

        // Sanitize any URIs or query credentials in driver error output
        const sanitizedDetails = originalMessage
          .replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***:***@')
          .replace(/([?&][^=]+)=[^&#\s]*/g, '$1=***');

        const internalDiagnostics = `Host: [${masked}], DriverError: ${sanitizedDetails}`;

        // Return a fixed, safe message to prevent secret or topology leakage
        throw new DatabaseConnectionError(
          'Database connection failed: Unable to connect to MongoDB Atlas.',
          'CONNECTION_FAILED',
          internalDiagnostics
        );
      });
  }

  return globalThis._mongoClientPromise;
}

/**
 * Returns the active MongoDB Db instance.
 */
export async function getDatabase(dbName?: string): Promise<Db> {
  const config = getDatabaseConfig();
  const client = await getMongoClient();
  return client.db(dbName || config.dbName);
}

/**
 * Closes the active database connection. Used primarily in test teardown and graceful shutdown.
 */
export async function closeDatabaseConnection(): Promise<void> {
  if (globalThis._mongoClientInstance) {
    try {
      await globalThis._mongoClientInstance.close();
    } catch {
      // Ignore close errors during teardown
    }
    globalThis._mongoClientInstance = undefined;
    globalThis._mongoClientPromise = undefined;
  }
}

/**
 * Transaction execution options restricted to parameters that do not undermine
 * mandatory consistency and isolation guarantees.
 */
export type AllowedTransactionOptions = Omit<
  TransactionOptions,
  'readConcern' | 'writeConcern' | 'readPreference'
>;

export interface TransactionExecutionOptions {
  transactionOptions?: AllowedTransactionOptions;
}

/**
 * Execute an operation within a multi-document transaction using snapshot read concern,
 * majority write concern, and primary read preference per contract requirements.
 * Guarantees callers cannot weaken mandatory transaction options.
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options?: TransactionExecutionOptions
): Promise<T> {
  const client = await getMongoClient();
  const session = client.startSession();

  // Enforce mandatory consistency and isolation constraints:
  // - readConcern: 'snapshot'
  // - writeConcern: 'majority'
  // - readPreference: 'primary'
  // Placed after options?.transactionOptions to ensure callers cannot weaken them.
  const effectiveTxOptions: TransactionOptions = {
    ...options?.transactionOptions,
    readConcern: new ReadConcern('snapshot'),
    writeConcern: new WriteConcern('majority'),
    readPreference: ReadPreference.primary,
  };

  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, effectiveTxOptions);
    return result!;
  } finally {
    await session.endSession();
  }
}
