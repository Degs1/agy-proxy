import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import {
  COLLECTIONS,
  ProjectDocument,
  ProviderCredentialDocument,
  ProjectLimiterGuardDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createAdminSession } from '@/lib/auth/session';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import {
  createCredential,
  listCredentials,
  getCredentialById,
  getSafeDecryptedCredential,
  revokeCredential,
  rotateCredentialKeyVersion,
  rotateAllProjectCredentials,
  verifyCredentialDecryption,
  CredentialInactiveError,
  CredentialNotFoundError,
} from '@/lib/credentials/service';
import {
  GET as listCredentialsRoute,
  POST as createCredentialRoute,
} from '@/app/api/admin/projects/[id]/credentials/route';
import {
  GET as getCredentialRoute,
  PATCH as updateCredentialRoute,
  DELETE as deleteCredentialRoute,
} from '@/app/api/admin/projects/[id]/credentials/[credId]/route';
import { POST as rotateCredentialRoute } from '@/app/api/admin/projects/[id]/credentials/[credId]/rotate/route';

describe('Provider Credential API, Versioned Ciphertext & Key Rotation (Requirement 3, AC 4, 3.5, 3.6 / TASK-029)', () => {
  let replSet: MongoMemoryReplSet;
  const APP_ORIGIN = 'http://localhost:3000';

  const keyV1Hex = crypto.randomBytes(32).toString('hex');
  const keyV2Hex = crypto.randomBytes(32).toString('hex');

  let testAdminId: ObjectId;
  let validSessionCookie: string;
  let validCsrfToken: string;
  let testProjectId: ObjectId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_credentials';
    process.env.APP_ORIGIN = APP_ORIGIN;
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
    process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testAdminId = new ObjectId();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      _id: testAdminId,
      email: 'bayu.cred@gateway.local',
      passwordHash: 'dummy_hash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sessionRes = await createAdminSession(db, testAdminId);
    validSessionCookie = sessionRes.sessionToken;
    validCsrfToken = sessionRes.csrfToken;

    // Create a base project
    testProjectId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Test Project Alpha',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Initialize limiter guard
    await db.collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS).insertOne({
      _id: testProjectId,
      revision: 1,
      last_server_time: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
  });

  beforeEach(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
    process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;
    const db = await getDatabase();
    await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).deleteMany({});
  });

  function createAuthRequest(
    method: string,
    url: string,
    body?: unknown,
    options?: { noCsrf?: boolean; noCookie?: boolean }
  ): NextRequest {
    const headers = new Headers();
    headers.set('host', 'localhost:3000');
    headers.set('Origin', APP_ORIGIN);
    headers.set('Content-Type', 'application/json');

    if (!options?.noCookie) {
      headers.set('Cookie', `${ADMIN_SESSION_COOKIE}=${validSessionCookie}`);
    }
    if (!options?.noCsrf) {
      headers.set(CSRF_HEADER_NAME, validCsrfToken);
    }

    return new NextRequest(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  describe('1. Credential Creation & Encryption at Rest (Requirement 3, AC 4)', () => {
    it('creates and encrypts credential, storing ciphertext, iv, authTag, and keyVersion in Atlas', async () => {
      const db = await getDatabase();
      const secret = 'AIzaSyActualSecretGeminiKey12345';

      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials`,
        {
          displayName: 'Production Gemini API Key',
          provider: 'gemini',
          credentialType: 'api_key',
          secret,
          status: 'active',
        }
      );

      const res = await createCredentialRoute(req, { params: { id: testProjectId.toString() } });
      expect(res.status).toBe(201);
      const json = await res.json();

      expect(json.credential).toHaveProperty('id');
      expect(json.credential.displayName).toBe('Production Gemini API Key');
      expect(json.credential.provider).toBe('gemini');
      expect(json.credential.keyVersion).toBe(1);
      expect(json.credential.status).toBe('active');

      // CRITICAL: Public API MUST NOT leak secret or ciphertext!
      expect(json.credential).not.toHaveProperty('secret');
      expect(json.credential).not.toHaveProperty('ciphertext');
      expect(json.credential).not.toHaveProperty('iv');
      expect(json.credential).not.toHaveProperty('authTag');

      // Verify in MongoDB Atlas that data is encrypted
      const doc = await db
        .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
        .findOne({ _id: new ObjectId(json.credential.id) });

      expect(doc).not.toBeNull();
      expect(doc!.encryptedCredentials).toBeDefined();
      expect(doc!.encryptedCredentials.keyVersion).toBe(1);
      expect(doc!.encryptedCredentials.ciphertext).toBeDefined();
      expect(doc!.encryptedCredentials.iv).toBeDefined();
      expect(doc!.encryptedCredentials.authTag).toBeDefined();

      // Database does not store plaintext
      expect(JSON.stringify(doc)).not.toContain(secret);
    });

    it('increments project limiter guard revision on credential creation (Requirement 3, AC 6)', async () => {
      const db = await getDatabase();
      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: testProjectId });

      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials`,
        {
          displayName: 'Guard Test Key',
          provider: 'gemini',
          secret: 'secret-test-guard',
        }
      );
      await createCredentialRoute(req, { params: { id: testProjectId.toString() } });

      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: testProjectId });

      expect(guardAfter!.revision).toBe(guardBefore!.revision + 1);
    });

    it('fails with 503 if active encryption key is missing in environment', async () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;

      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials`,
        {
          displayName: 'Missing Key Test',
          provider: 'gemini',
          secret: 'secret-missing-key',
        }
      );

      const res = await createCredentialRoute(req, { params: { id: testProjectId.toString() } });
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error.code).toBe('encryption_key_unavailable');
    });

    it('rejects invalid credential input with 400 Bad Request', async () => {
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials`,
        {
          displayName: '', // empty
          secret: '',
        }
      );

      const res = await createCredentialRoute(req, { params: { id: testProjectId.toString() } });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('invalid_request');
    });
  });

  describe('2. Credential Listing, Retrieval & Updates', () => {
    it('lists credentials for a project without leaking secrets or ciphertexts', async () => {
      const db = await getDatabase();
      await createCredential(db, testProjectId, {
        displayName: 'Key 1',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'sec-1',
        status: 'active',
      });
      await createCredential(db, testProjectId, {
        displayName: 'Key 2',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'sec-2',
        status: 'disabled',
      });

      const req = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials`
      );
      const res = await listCredentialsRoute(req, { params: { id: testProjectId.toString() } });
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.credentials.length).toBe(2);
      expect(json.credentials[0]).not.toHaveProperty('secret');
      expect(json.credentials[0]).not.toHaveProperty('ciphertext');

      // Filter by status=disabled
      const filterReq = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials?status=disabled`
      );
      const filterRes = await listCredentialsRoute(filterReq, { params: { id: testProjectId.toString() } });
      const filterJson = await filterRes.json();
      expect(filterJson.credentials.length).toBe(1);
      expect(filterJson.credentials[0].displayName).toBe('Key 2');
    });

    it('retrieves single credential metadata and returns 404 for non-existent credential', async () => {
      const db = await getDatabase();
      const created = await createCredential(db, testProjectId, {
        displayName: 'Single Key',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'sec-single',
        status: 'active',
      });

      const req = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials/${created._id}`
      );
      const res = await getCredentialRoute(req, {
        params: { id: testProjectId.toString(), credId: created._id!.toString() },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.credential.displayName).toBe('Single Key');

      // 404 for unknown id
      const notFoundReq = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials/${new ObjectId()}`
      );
      const notFoundRes = await getCredentialRoute(notFoundReq, {
        params: { id: testProjectId.toString(), credId: new ObjectId().toString() },
      });
      expect(notFoundRes.status).toBe(404);
    });

    it('updates credential metadata and touches limiter guard', async () => {
      const db = await getDatabase();
      const created = await createCredential(db, testProjectId, {
        displayName: 'Initial Name',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'sec-initial',
        status: 'active',
      });

      const req = createAuthRequest(
        'PATCH',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials/${created._id}`,
        {
          displayName: 'Renamed Credential',
          maxConcurrent: 10,
        }
      );
      const res = await updateCredentialRoute(req, {
        params: { id: testProjectId.toString(), credId: created._id!.toString() },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.credential.displayName).toBe('Renamed Credential');
      expect(json.credential.maxConcurrent).toBe(10);
    });
  });

  describe('3. Credential Revocation (Requirement 3, AC 6)', () => {
    it('revoking a credential sets status to disabled and increments limiter guard', async () => {
      const db = await getDatabase();
      const created = await createCredential(db, testProjectId, {
        displayName: 'Revoke Key',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'secret-to-revoke',
        status: 'active',
      });

      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: testProjectId });

      const req = createAuthRequest(
        'DELETE',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials/${created._id}`
      );
      const res = await deleteCredentialRoute(req, {
        params: { id: testProjectId.toString(), credId: created._id!.toString() },
      });
      expect(res.status).toBe(200);

      // Verify status in DB is disabled
      const updated = await db
        .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
        .findOne({ _id: created._id });
      expect(updated!.status).toBe('disabled');

      // Limiter guard revision incremented
      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: testProjectId });
      expect(guardAfter!.revision).toBe(guardBefore!.revision + 1);
    });

    it('permanently deletes credential when permanent=true query is provided', async () => {
      const db = await getDatabase();
      const created = await createCredential(db, testProjectId, {
        displayName: 'Key To Delete Permanently',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'AIzaSyPermanentDeleteSecret',
        status: 'active',
      });

      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: testProjectId });

      const req = createAuthRequest(
        'DELETE',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials/${created._id}?permanent=true`
      );
      const res = await deleteCredentialRoute(req, {
        params: { id: testProjectId.toString(), credId: created._id!.toString() },
      });
      expect(res.status).toBe(200);

      // Verify document in DB is permanently deleted
      const updated = await db
        .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
        .findOne({ _id: created._id });
      expect(updated).toBeNull();

      // Limiter guard revision incremented
      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: testProjectId });
      expect(guardAfter!.revision).toBe(guardBefore!.revision + 1);
    });
  });

  describe('4. Safe Decryption Helper & Access Controls', () => {
    it('safely decrypts active credential returning original plaintext', async () => {
      const db = await getDatabase();
      const rawSecret = 'MyActualGeminiSecret123';
      const created = await createCredential(db, testProjectId, {
        displayName: 'Safe Decrypt Key',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: rawSecret,
        status: 'active',
      });

      const decryptedResult = await getSafeDecryptedCredential(db, testProjectId, created._id!);
      expect(decryptedResult.secret).toBe(rawSecret);
      expect(decryptedResult.credential._id!.toString()).toBe(created._id!.toString());
    });

    it('refuses to decrypt inactive or revoked credential with CredentialInactiveError', async () => {
      const db = await getDatabase();
      const created = await createCredential(db, testProjectId, {
        displayName: 'Disabled Key',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'secret-disabled',
        status: 'disabled',
      });

      await expect(
        getSafeDecryptedCredential(db, testProjectId, created._id!)
      ).rejects.toThrow(CredentialInactiveError);
    });

    it('rejects cross-project access: cannot read credential using another projectId', async () => {
      const db = await getDatabase();
      const created = await createCredential(db, testProjectId, {
        displayName: 'Cross Project Key',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'secret-cross',
        status: 'active',
      });

      const otherProjectId = new ObjectId();
      await expect(
        getSafeDecryptedCredential(db, otherProjectId, created._id!)
      ).rejects.toThrow(CredentialNotFoundError);
    });
  });

  describe('5. Key Rotation & Migration Process (Requirement 3, AC 5)', () => {
    it('rotates credential key version from V1 to V2 via rotate API', async () => {
      const db = await getDatabase();
      const rawSecret = 'RotationTestSecret-V1toV2';

      // 1. Create with Key V1
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
      const created = await createCredential(db, testProjectId, {
        displayName: 'Rotating Key',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: rawSecret,
        status: 'active',
      });
      expect(created.encryptedCredentials.keyVersion).toBe(1);

      // 2. Set active key to V2 in environment
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2';

      // Verify V1 credential is still safely readable before rotation
      const preDecrypted = await getSafeDecryptedCredential(db, testProjectId, created._id!);
      expect(preDecrypted.secret).toBe(rawSecret);

      // 3. Trigger rotate API
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${testProjectId}/credentials/${created._id}/rotate`,
        { targetVersion: 2 }
      );
      const res = await rotateCredentialRoute(req, {
        params: { id: testProjectId.toString(), credId: created._id!.toString() },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.credential.keyVersion).toBe(2);

      // 4. Verify in DB that new keyVersion is 2 and ciphertext changed
      const updatedDoc = await db
        .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
        .findOne({ _id: created._id });
      expect(updatedDoc!.encryptedCredentials.keyVersion).toBe(2);
      expect(updatedDoc!.encryptedCredentials.ciphertext).not.toBe(
        created.encryptedCredentials.ciphertext
      );

      // 5. Verify round-trip decryption using verifyCredentialDecryption
      const verification = await verifyCredentialDecryption(db, testProjectId, created._id!);
      expect(verification.valid).toBe(true);
      expect(verification.keyVersion).toBe(2);

      // 6. If V1 is removed from environment, the rotated credential still decrypts cleanly!
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;
      const postDecrypted = await getSafeDecryptedCredential(db, testProjectId, created._id!);
      expect(postDecrypted.secret).toBe(rawSecret);
    });

    it('batch migrates all project credentials via rotateAllProjectCredentials', async () => {
      const db = await getDatabase();
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';

      const cred1 = await createCredential(db, testProjectId, {
        displayName: 'Batch Key 1',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'batch-sec-1',
        status: 'active',
      });
      const cred2 = await createCredential(db, testProjectId, {
        displayName: 'Batch Key 2',
        provider: 'gemini',
        credentialType: 'api_key',
        secret: 'batch-sec-2',
        status: 'active',
      });

      // Switch active version to 2
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2';

      const result = await rotateAllProjectCredentials(db, testProjectId, 2);
      expect(result.total).toBe(2);
      expect(result.migrated).toBe(2);

      // Verify both now have keyVersion 2 and decrypt correctly
      const dec1 = await getSafeDecryptedCredential(db, testProjectId, cred1._id!);
      const dec2 = await getSafeDecryptedCredential(db, testProjectId, cred2._id!);
      expect(dec1.secret).toBe('batch-sec-1');
      expect(dec1.credential.encryptedCredentials.keyVersion).toBe(2);
      expect(dec2.secret).toBe('batch-sec-2');
      expect(dec2.credential.encryptedCredentials.keyVersion).toBe(2);
    });
  });
});
