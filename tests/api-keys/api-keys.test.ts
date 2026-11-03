import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import {
  COLLECTIONS,
  ApiKeyDocument,
  ProjectDocument,
  ProjectLimiterGuardDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createAdminSession } from '@/lib/auth/session';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { createProject } from '@/lib/projects/service';
import { getProjectLimiterGuard } from '@/lib/projects/limiter-guard';
import {
  generateApiKey,
  hashApiKey,
  isValidApiKeyFormat,
  API_KEY_PREFIX,
  RANDOM_BYTES_COUNT,
} from '@/lib/api-keys/crypto';
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  getApiKeyById,
} from '@/lib/api-keys/service';
import {
  verifyApiKeyToken,
  authenticateApiKeyRequest,
} from '@/lib/auth/api-key-guard';
import {
  GET as getProjectKeysRoute,
  POST as createProjectKeyRoute,
} from '@/app/api/admin/projects/[id]/keys/route';
import {
  GET as getKeyByIdRoute,
  DELETE as revokeKeyRoute,
} from '@/app/api/admin/keys/[id]/route';

describe('API Key Management & Bearer Authentication (Requirement 3.2, 3.3, 3.6 & Subtasks 7.1, 7.2, 7.3)', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;
  const APP_ORIGIN = 'http://localhost:3000';

  let testAdminId: ObjectId;
  let validSessionCookie: string;
  let validCsrfToken: string;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_api_keys';
    process.env.APP_ORIGIN = APP_ORIGIN;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    // Create active admin user
    testAdminId = new ObjectId();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      _id: testAdminId,
      email: 'bayu.senior@gateway.local',
      passwordHash: 'dummy_argon2_hash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sessionRes = await createAdminSession(db, testAdminId);
    validSessionCookie = sessionRes.sessionToken;
    validCsrfToken = sessionRes.csrfToken;
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
    process.env = originalEnv;
  });

  beforeEach(async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.PROJECTS).deleteMany({});
    await db.collection(COLLECTIONS.PROJECT_LIMITER_GUARDS).deleteMany({});
    await db.collection(COLLECTIONS.API_KEYS).deleteMany({});
  });

  function createAdminRequest(
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
    options?: {
      body?: any;
      sessionCookie?: string | null;
      csrfToken?: string | null;
      origin?: string | null;
    }
  ): NextRequest {
    const headers = new Headers();
    const effectiveOrigin =
      options?.origin !== undefined ? options.origin : APP_ORIGIN;
    if (effectiveOrigin) {
      headers.set('origin', effectiveOrigin);
    }

    const effectiveCsrf =
      options?.csrfToken !== undefined ? options.csrfToken : validCsrfToken;
    if (effectiveCsrf) {
      headers.set(CSRF_HEADER_NAME, effectiveCsrf);
    }

    const effectiveCookie =
      options?.sessionCookie !== undefined
        ? options.sessionCookie
        : validSessionCookie;
    if (effectiveCookie) {
      headers.set('cookie', `${ADMIN_SESSION_COOKIE}=${effectiveCookie}`);
    }

    if (options?.body) {
      headers.set('content-type', 'application/json');
    }

    return new NextRequest(new URL(url, APP_ORIGIN), {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });
  }

  // =========================================================================
  // 1. SUBTASK 7.1: Key Length, CSPRNG Randomness, and Uniqueness
  // =========================================================================
  describe('Subtask 7.1: Key Length, CSPRNG Randomness, and Formatting', () => {
    it('generates API key with agw_ prefix, exactly 64 hex characters of entropy (256 bits), and total length 68', () => {
      const generated = generateApiKey();
      expect(generated.secret.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(generated.secret.length).toBe(4 + 64); // 68 chars
      const hexSecret = generated.secret.slice(API_KEY_PREFIX.length);
      expect(hexSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.from(hexSecret, 'hex').length).toBe(RANDOM_BYTES_COUNT); // 32 bytes = 256 bits
    });

    it('generates unique keys with zero collisions across 100 consecutive generations', () => {
      const keySet = new Set<string>();
      const hashSet = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        const generated = generateApiKey();
        expect(keySet.has(generated.secret)).toBe(false);
        expect(hashSet.has(generated.keyHash)).toBe(false);
        keySet.add(generated.secret);
        hashSet.add(generated.keyHash);
      }

      expect(keySet.size).toBe(count);
      expect(hashSet.size).toBe(count);
    });

    it('identifies valid vs invalid API key formats accurately', () => {
      const validKey = generateApiKey().secret;
      expect(isValidApiKeyFormat(validKey)).toBe(true);

      // Invalid cases:
      expect(isValidApiKeyFormat('')).toBe(false);
      expect(isValidApiKeyFormat('sk-proj-1234567890')).toBe(false); // wrong prefix
      expect(isValidApiKeyFormat('agw_12345')).toBe(false); // too short
      expect(isValidApiKeyFormat(`agw_${'g'.repeat(64)}`)).toBe(false); // non-hex character
      expect(isValidApiKeyFormat('a'.repeat(64))).toBe(false); // raw 64 hex chars without prefix
    });
  });

  // =========================================================================
  // 2. SUBTASK 7.1 & 7.2: One-Time Secret Display and One-Way Hash Storage
  // =========================================================================
  describe('Subtask 7.1 & 7.2: One-Time Secret Display and One-Way Hash Storage', () => {
    it('returns plaintext secret only at issuance, storing only SHA-256 hash in database', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Key Display Project' });
      const projectId = project._id!;

      const result = await createApiKey(db, projectId, { name: 'Production Key' });

      // Issuance returns the full secret
      expect(result.secret.startsWith('agw_')).toBe(true);
      expect(result.secret.length).toBe(68);

      // Verify what was stored in MongoDB
      const storedDoc = await db
        .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
        .findOne({ _id: result.apiKey._id });

      expect(storedDoc).not.toBeNull();
      // Must NOT contain the plaintext secret anywhere
      expect((storedDoc as any).secret).toBeUndefined();
      // Must store one-way SHA-256 hash
      expect(storedDoc?.keyHash).toBe(hashApiKey(result.secret));
      expect(storedDoc?.keyPrefix).toBe(result.secret.slice(0, 12));
      expect(storedDoc?.status).toBe('active');
    });

    it('GET /api/admin/projects/:id/keys never exposes plaintext secret or keyHash', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Key Listing Project' });
      const projectId = project._id!.toString();

      // Create two keys
      const key1 = await createApiKey(db, projectId, { name: 'Key One' });
      const key2 = await createApiKey(db, projectId, { name: 'Key Two' });

      const req = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${projectId}/keys`,
        'GET'
      );
      const res = await getProjectKeysRoute(req, { params: Promise.resolve({ id: projectId }) });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(Array.isArray(data.keys)).toBe(true);
      expect(data.keys.length).toBe(2);

      for (const k of data.keys) {
        expect(k.keyPrefix).toBeDefined();
        expect(k.name).toBeDefined();
        expect(k.status).toBe('active');
        // Critical security assertions:
        expect(k.secret).toBeUndefined();
        expect(k.keyHash).toBeUndefined();
      }
    });

    it('GET /api/admin/keys/:id never exposes plaintext secret or keyHash', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Single Key Inspect Project' });
      const created = await createApiKey(db, project._id!, { name: 'Inspectable Key' });
      const keyId = created.apiKey._id!.toString();

      const req = createAdminRequest(
        `http://localhost:3000/api/admin/keys/${keyId}`,
        'GET'
      );
      const res = await getKeyByIdRoute(req, { params: Promise.resolve({ id: keyId }) });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.apiKey).toBeDefined();
      expect(data.apiKey.id).toBe(keyId);
      expect(data.apiKey.keyPrefix).toBe(created.apiKey.keyPrefix);
      expect(data.apiKey.secret).toBeUndefined();
      expect(data.apiKey.keyHash).toBeUndefined();
    });

    it('POST /api/admin/projects/:id/keys returns secret in creation response only', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Admin Route Key Creation' });
      const projectId = project._id!.toString();

      const req = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${projectId}/keys`,
        'POST',
        { body: { name: 'CI/CD Key' } }
      );
      const res = await createProjectKeyRoute(req, { params: Promise.resolve({ id: projectId }) });
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.apiKey).toBeDefined();
      expect(data.apiKey.name).toBe('CI/CD Key');
      expect(data.secret).toBeDefined();
      expect(data.secret.startsWith('agw_')).toBe(true);
      expect(data.apiKey.keyHash).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. SUBTASK 7.1: Bearer Authentication
  // =========================================================================
  describe('Subtask 7.1: Bearer Authentication and Admission Guard', () => {
    it('rejects request with missing Authorization header (TC-REQ5-AUTH-01) with 401 invalid_api_key', async () => {
      const db = await getDatabase();
      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {},
      });

      const auth = await authenticateApiKeyRequest(req, db);
      expect(auth.valid).toBe(false);
      if (!auth.valid) {
        expect(auth.status).toBe(401);
        expect(auth.code).toBe('invalid_api_key');
        const json = await auth.response.json();
        expect(json.error.code).toBe('invalid_api_key');
        expect(json.error.type).toBe('invalid_request_error');
        expect(json.error.param).toBeNull();
      }
    });

    it('rejects request with non-Bearer scheme (TC-REQ5-AUTH-02) with 401 invalid_api_key', async () => {
      const db = await getDatabase();
      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: 'Basic dXNlcjpwYXNz',
        },
      });

      const auth = await authenticateApiKeyRequest(req, db);
      expect(auth.valid).toBe(false);
      if (!auth.valid) {
        expect(auth.status).toBe(401);
        expect(auth.code).toBe('invalid_api_key');
      }
    });

    it('rejects request with unrecorded random key (TC-REQ5-AUTH-03) with 401 invalid_api_key', async () => {
      const db = await getDatabase();
      const randomKey = generateApiKey().secret;

      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${randomKey}`,
        },
      });

      const auth = await authenticateApiKeyRequest(req, db);
      expect(auth.valid).toBe(false);
      if (!auth.valid) {
        expect(auth.status).toBe(401);
        expect(auth.code).toBe('invalid_api_key');
      }
    });

    it('authenticates valid active API key successfully and resolves project and key identity', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Valid Project' });
      const created = await createApiKey(db, project._id!, { name: 'Working Key' });

      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${created.secret}`,
        },
      });

      const auth = await authenticateApiKeyRequest(req, db);
      expect(auth.valid).toBe(true);
      if (auth.valid) {
        expect(auth.apiKey._id?.toString()).toBe(created.apiKey._id?.toString());
        expect(auth.project._id?.toString()).toBe(project._id?.toString());
        expect(auth.project.name).toBe('Valid Project');
      }
    });

    it('rejects valid key when owning project is disabled (TC-REQ5-AUTH-07) with 403 project_disabled', async () => {
      const db = await getDatabase();
      const project = await createProject(db, {
        name: 'Disabled Project',
        status: 'disabled',
      });
      const created = await createApiKey(db, project._id!, { name: 'Key on Disabled Project' });

      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${created.secret}`,
        },
      });

      const auth = await authenticateApiKeyRequest(req, db);
      expect(auth.valid).toBe(false);
      if (!auth.valid) {
        expect(auth.status).toBe(403);
        expect(auth.code).toBe('project_disabled');
        const json = await auth.response.json();
        expect(json.error.code).toBe('project_disabled');
        expect(json.error.type).toBe('invalid_request_error');
        expect(json.error.param).toBeNull();
      }
    });

    it('rejects expired API key with 401 invalid_api_key', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Expiration Test Project' });
      const created = await createApiKey(db, project._id!, { name: 'Expiring Key' });

      // Force expiration in DB
      await db.collection(COLLECTIONS.API_KEYS).updateOne(
        { _id: created.apiKey._id },
        { $set: { expiresAt: new Date(Date.now() - 60000) } }
      );

      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${created.secret}`,
        },
      });

      const auth = await authenticateApiKeyRequest(req, db);
      expect(auth.valid).toBe(false);
      if (!auth.valid) {
        expect(auth.status).toBe(401);
        expect(auth.code).toBe('invalid_api_key');
      }
    });
  });

  // =========================================================================
  // 4. SUBTASK 7.2: Key Revocation & Project Limiter Guard Writes
  // =========================================================================
  describe('Subtask 7.2: Key Revocation & Project Limiter Guard Writes (Requirement 3.6)', () => {
    it('revokes key atomically and touches project limiter guard revision', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Revocation Guard Project' });
      const projectId = project._id!;
      const created = await createApiKey(db, projectId, { name: 'To Be Revoked' });
      const keyId = created.apiKey._id!;

      // Check guard revision before revocation
      const guardBefore = await getProjectLimiterGuard(db, projectId);
      expect(guardBefore).not.toBeNull();
      const revisionBefore = guardBefore?.revision ?? 0;

      // Revoke the key
      const revoked = await revokeApiKey(db, keyId);
      expect(revoked).not.toBeNull();
      expect(revoked?.status).toBe('revoked');

      // Check guard revision after revocation (Requirement 3.6: Must touch limiter guard)
      const guardAfter = await getProjectLimiterGuard(db, projectId);
      expect(guardAfter?.revision).toBe(revisionBefore + 1);
      expect(guardAfter?.last_server_time).toBeDefined();

      // Verify that Bearer authentication immediately fails (TC-REQ5-AUTH-04)
      const auth = await verifyApiKeyToken(db, created.secret);
      expect(auth.valid).toBe(false);
      if (!auth.valid) {
        expect(auth.status).toBe(401);
        expect(auth.code).toBe('invalid_api_key');
      }
    });

    it('DELETE /api/admin/keys/:id enforces admin authentication, Origin and CSRF', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Admin Revoke Route Project' });
      const created = await createApiKey(db, project._id!, { name: 'Admin Route Revocation Key' });
      const keyId = created.apiKey._id!.toString();

      // 1. Missing CSRF -> 403 csrf_rejected
      const reqNoCsrf = createAdminRequest(
        `http://localhost:3000/api/admin/keys/${keyId}`,
        'DELETE',
        { csrfToken: '' }
      );
      const resNoCsrf = await revokeKeyRoute(reqNoCsrf, { params: Promise.resolve({ id: keyId }) });
      expect(resNoCsrf.status).toBe(403);
      const jsonNoCsrf = await resNoCsrf.json();
      expect(jsonNoCsrf.error.code).toBe('csrf_rejected');

      // 2. Untrusted Origin -> 403 origin_rejected
      const reqBadOrigin = createAdminRequest(
        `http://localhost:3000/api/admin/keys/${keyId}`,
        'DELETE',
        { origin: 'http://malicious.evil.com' }
      );
      const resBadOrigin = await revokeKeyRoute(reqBadOrigin, { params: Promise.resolve({ id: keyId }) });
      expect(resBadOrigin.status).toBe(403);
      const jsonBadOrigin = await resBadOrigin.json();
      expect(jsonBadOrigin.error.code).toBe('origin_rejected');

      // 3. Valid admin request -> 200 OK
      const reqValid = createAdminRequest(
        `http://localhost:3000/api/admin/keys/${keyId}`,
        'DELETE'
      );
      const resValid = await revokeKeyRoute(reqValid, { params: Promise.resolve({ id: keyId }) });
      expect(resValid.status).toBe(200);
      const jsonValid = await resValid.json();
      expect(jsonValid.success).toBe(true);
      expect(jsonValid.revokedId).toBe(keyId);
      expect(jsonValid.apiKey.status).toBe('revoked');

      // Verify key is now rejected for bearer auth
      const auth = await verifyApiKeyToken(db, created.secret);
      expect(auth.valid).toBe(false);
    });

    it('returns 404 for non-existent key deletion', async () => {
      const fakeId = new ObjectId().toString();
      const req = createAdminRequest(
        `http://localhost:3000/api/admin/keys/${fakeId}`,
        'DELETE'
      );
      const res = await revokeKeyRoute(req, { params: Promise.resolve({ id: fakeId }) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe('key_not_found');
    });
  });

  // =========================================================================
  // 5. SUBTASK 7.3: Stored Hash Rejection as Bearer Key
  // =========================================================================
  describe('Subtask 7.3: Stored Hash Rejection as Bearer Key (Requirement 3.2, AC 2)', () => {
    it('strictly rejects the stored SHA-256 hash when presented as a Bearer key', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Hash Attack Defense Project' });
      const created = await createApiKey(db, project._id!, { name: 'Target Key' });

      // Retrieve the stored hash from MongoDB
      const storedKeyDoc = await db
        .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
        .findOne({ _id: created.apiKey._id });
      expect(storedKeyDoc).not.toBeNull();
      const storedHash = storedKeyDoc!.keyHash;

      // Skenario A: Attacker attempts to use the 64-character stored hash directly
      const reqRawHash = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${storedHash}`,
        },
      });
      const authRaw = await authenticateApiKeyRequest(reqRawHash, db);
      expect(authRaw.valid).toBe(false);
      if (!authRaw.valid) {
        expect(authRaw.status).toBe(401);
        expect(authRaw.code).toBe('invalid_api_key');
      }

      // Skenario B: Attacker prepends 'agw_' to the stored hash
      const fakeKeyWithHash = `${API_KEY_PREFIX}${storedHash}`;
      const reqPrepended = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${fakeKeyWithHash}`,
        },
      });
      const authPrepended = await authenticateApiKeyRequest(reqPrepended, db);
      expect(authPrepended.valid).toBe(false);
      if (!authPrepended.valid) {
        expect(authPrepended.status).toBe(401);
        expect(authPrepended.code).toBe('invalid_api_key');
      }

      // Skenario C: Attacker attempts to use the stored keyPrefix
      const reqPrefix = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${storedKeyDoc!.keyPrefix}`,
        },
      });
      const authPrefix = await authenticateApiKeyRequest(reqPrefix, db);
      expect(authPrefix.valid).toBe(false);
      if (!authPrefix.valid) {
        expect(authPrefix.status).toBe(401);
        expect(authPrefix.code).toBe('invalid_api_key');
      }

      // Skenario D: Direct verification of stored hash string via verifyApiKeyToken
      const directHashAuth = await verifyApiKeyToken(db, storedHash);
      expect(directHashAuth.valid).toBe(false);
      if (!directHashAuth.valid) {
        expect(directHashAuth.status).toBe(401);
        expect(directHashAuth.code).toBe('invalid_api_key');
      }

      // Skenario E: Attacker attempts NoSQL / special char payload
      const reqInjection = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: 'Bearer {"$gt":""}',
        },
      });
      const authInjection = await authenticateApiKeyRequest(reqInjection, db);
      expect(authInjection.valid).toBe(false);
      if (!authInjection.valid) {
        expect(authInjection.status).toBe(401);
        expect(authInjection.code).toBe('invalid_api_key');
      }

      // Sanity check: Legitimate secret still succeeds
      const reqLegit = new NextRequest('http://localhost:3000/v1/chat/completions', {
        headers: {
          authorization: `Bearer ${created.secret}`,
        },
      });
      const authLegit = await authenticateApiKeyRequest(reqLegit, db);
      expect(authLegit.valid).toBe(true);
    });

    it('rejects cross-key hash impersonation when multiple keys exist', async () => {
      const db = await getDatabase();
      const project = await createProject(db, { name: 'Multi Key Project' });
      const key1 = await createApiKey(db, project._id!, { name: 'Key 1' });
      const key2 = await createApiKey(db, project._id!, { name: 'Key 2' });

      // Ensure key 1 hash cannot authenticate
      const key1Doc = await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).findOne({ _id: key1.apiKey._id });
      const auth1 = await verifyApiKeyToken(db, key1Doc!.keyHash);
      expect(auth1.valid).toBe(false);

      // Ensure key 2 hash cannot authenticate
      const key2Doc = await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).findOne({ _id: key2.apiKey._id });
      const auth2 = await verifyApiKeyToken(db, key2Doc!.keyHash);
      expect(auth2.valid).toBe(false);

      // But both secrets work
      expect((await verifyApiKeyToken(db, key1.secret)).valid).toBe(true);
      expect((await verifyApiKeyToken(db, key2.secret)).valid).toBe(true);
    });
  });
});
