import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDatabaseConfig, maskMongoUri, DatabaseConfigError } from '@/lib/db/config';

describe('Database Configuration & Fail-Safe Handling (Requirement 1, AC 2)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MONGODB_URI;
    delete process.env.MONGODB_DB_NAME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('maskMongoUri URI and query parameter sanitization', () => {
    it('masks standard username and password credentials', () => {
      const uri = 'mongodb://app_user:secret_password@cluster0.example.com:27017/prod_db';
      const masked = maskMongoUri(uri);
      expect(masked).toBe('mongodb://***:***@cluster0.example.com:27017/prod_db');
      expect(masked).not.toContain('app_user');
      expect(masked).not.toContain('secret_password');
    });

    it('masks credentials in mongodb+srv URIs with special characters in password', () => {
      const uri = 'mongodb+srv://admin_svc:p%40ss%3Aword%21@cluster0.mongodb.net/gateway';
      const masked = maskMongoUri(uri);
      expect(masked).toBe('mongodb+srv://***:***@cluster0.mongodb.net/gateway');
      expect(masked).not.toContain('admin_svc');
      expect(masked).not.toContain('p%40ss');
    });

    it('masks user identity even when password is omitted', () => {
      const uri = 'mongodb://operator@internal-mongo.local:27017/db';
      const masked = maskMongoUri(uri);
      expect(masked).toBe('mongodb://***:***@internal-mongo.local:27017/db');
      expect(masked).not.toContain('operator');
    });

    it('masks all query parameter values so query secrets never leak', () => {
      const uri = 'mongodb+srv://user:pass@host/db?authSource=admin&replicaSet=rs0&token=ultra_secret_key&tlsCAFile=/certs/ca.pem';
      const masked = maskMongoUri(uri);
      expect(masked).toContain('mongodb+srv://***:***@host/db?');
      expect(masked).toContain('authSource=***');
      expect(masked).toContain('token=***');
      expect(masked).toContain('replicaSet=***');
      expect(masked).toContain('tlsCAFile=***');
      expect(masked).not.toContain('ultra_secret_key');
      expect(masked).not.toContain('pass');
      expect(masked).not.toContain('admin');
    });

    it('handles non-string or malformed inputs safely without throwing', () => {
      expect(maskMongoUri('')).toBe('[invalid-uri]');
      expect(maskMongoUri(null as unknown as string)).toBe('[invalid-uri]');
      expect(maskMongoUri(undefined as unknown as string)).toBe('[invalid-uri]');
      expect(maskMongoUri('not-a-valid-uri')).toBe('not-a-valid-uri');
    });
  });

  describe('getDatabaseConfig error non-leakage', () => {
    it('fails safely with DatabaseConfigError when MONGODB_URI is missing', () => {
      expect(() => getDatabaseConfig()).toThrow(DatabaseConfigError);
      try {
        getDatabaseConfig();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DatabaseConfigError);
        const configError = err as DatabaseConfigError;
        expect(configError.code).toBe('MISSING_MONGODB_URI');
        expect(configError.message).toContain('MONGODB_URI is not configured');
      }
    });

    it('fails safely when MONGODB_URI is empty or whitespace', () => {
      process.env.MONGODB_URI = '   ';
      expect(() => getDatabaseConfig()).toThrow(DatabaseConfigError);
      try {
        getDatabaseConfig();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DatabaseConfigError);
        const configError = err as DatabaseConfigError;
        expect(configError.code).toBe('MISSING_MONGODB_URI');
      }
    });

    it('fails safely when MONGODB_URI is not a valid mongodb or mongodb+srv scheme without leaking secrets', () => {
      process.env.MONGODB_URI = 'postgres://user:secretpassword@localhost:5432/db';
      expect(() => getDatabaseConfig()).toThrow(DatabaseConfigError);
      try {
        getDatabaseConfig();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DatabaseConfigError);
        const configError = err as DatabaseConfigError;
        expect(configError.code).toBe('INVALID_MONGODB_URI');
        // Crucial: ensure passwords/secrets are NEVER leaked in the error message!
        expect(configError.message).not.toContain('secretpassword');
        expect(configError.message).not.toContain('postgres://');
        expect(configError.message).toBe(
          'Database configuration error: Invalid MONGODB_URI format. URI must be a valid mongodb:// or mongodb+srv:// connection string.'
        );
      }
    });

    it('never leaks user credentials or query secrets in error message for malformed URIs', () => {
      process.env.MONGODB_URI = 'mongodb://superadmin:ultra_secret_pw@malformed-uri??secretQuery=classified_token&&';
      try {
        getDatabaseConfig();
        expect.fail('Should have thrown DatabaseConfigError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DatabaseConfigError);
        const configError = err as DatabaseConfigError;
        expect(configError.code).toBe('INVALID_MONGODB_URI');
        expect(configError.message).not.toContain('ultra_secret_pw');
        expect(configError.message).not.toContain('superadmin');
        expect(configError.message).not.toContain('classified_token');
        expect(configError.message).toBe(
          'Database configuration error: Invalid MONGODB_URI format. URI must be a valid mongodb:// or mongodb+srv:// connection string.'
        );
      }
    });

    it('returns valid configuration and applies default db name when valid URI provided', () => {
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test_db';
      const config = getDatabaseConfig();
      expect(config.uri).toBe('mongodb://127.0.0.1:27017/test_db');
      expect(config.dbName).toBe('antigravity_gateway');
    });

    it('respects MONGODB_DB_NAME when specified in environment', () => {
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
      process.env.MONGODB_DB_NAME = 'custom_gateway_db';
      const config = getDatabaseConfig();
      expect(config.dbName).toBe('custom_gateway_db');
    });
  });
});
