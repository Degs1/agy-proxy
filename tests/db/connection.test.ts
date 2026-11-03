import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMongoClient, closeDatabaseConnection, DatabaseConnectionError } from '@/lib/db/client';

describe('Database Connection Fail-Safe Handling (Requirement 1, AC 2)', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    await closeDatabaseConnection();
  });

  afterEach(async () => {
    await closeDatabaseConnection();
    process.env = originalEnv;
  });

  it('fails safely with DatabaseConnectionError when connecting to an unreachable host', async () => {
    // Port 19999 on 127.0.0.1 is unreachable
    process.env.MONGODB_URI =
      'mongodb://app_user:super_secret_password@127.0.0.1:19999/test?serverSelectionTimeoutMS=500&connectTimeoutMS=500&appName=test_app';

    await expect(getMongoClient()).rejects.toThrow(DatabaseConnectionError);

    try {
      await getMongoClient();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DatabaseConnectionError);
      const connErr = err as DatabaseConnectionError;
      expect(connErr.code).toBe('CONNECTION_FAILED');

      // The public error message MUST be a constant safe message without leaking URI or secrets
      expect(connErr.message).toBe('Database connection failed: Unable to connect to MongoDB Atlas.');
      expect(connErr.message).not.toContain('super_secret_password');
      expect(connErr.message).not.toContain('app_user');
      expect(connErr.message).not.toContain('127.0.0.1:19999');

      // Internal diagnostics must be sanitized: no passwords or query secret values
      expect(connErr.diagnostics).toBeDefined();
      expect(connErr.diagnostics).toContain('***:***@127.0.0.1:19999');
      expect(connErr.diagnostics).toContain('appName=***');
      expect(connErr.diagnostics).not.toContain('super_secret_password');
      expect(connErr.diagnostics).not.toContain('app_user');
    }
  });

  it('fails safely with DatabaseConnectionError when URI has unsupported driver options without leaking secrets', async () => {
    process.env.MONGODB_URI =
      'mongodb://admin:super_secret_classified@127.0.0.1:27017/test?customSecretParam=classified_val';

    await expect(getMongoClient()).rejects.toThrow(DatabaseConnectionError);

    try {
      await getMongoClient();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DatabaseConnectionError);
      const connErr = err as DatabaseConnectionError;
      expect(connErr.code).toBe('CONNECTION_FAILED');
      expect(connErr.message).toBe('Database connection failed: Unable to connect to MongoDB Atlas.');
      expect(connErr.message).not.toContain('super_secret_classified');
      expect(connErr.message).not.toContain('classified_val');
      expect(connErr.diagnostics).toContain('***:***@127.0.0.1:27017');
      expect(connErr.diagnostics).not.toContain('super_secret_classified');
    }
  });

  it('fails safely when MONGODB_URI is absent upon client acquisition', async () => {
    delete process.env.MONGODB_URI;
    await expect(getMongoClient()).rejects.toThrow(DatabaseConnectionError);
    try {
      await getMongoClient();
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(DatabaseConnectionError);
      const connErr = err as DatabaseConnectionError;
      expect(connErr.code).toBe('CONFIGURATION_MISSING');
      expect(connErr.message).toBe('Database configuration is invalid or missing.');
    }
  });
});
