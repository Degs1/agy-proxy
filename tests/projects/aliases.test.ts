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
  ModelAliasDocument,
  ProjectLimiterGuardDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createAdminSession } from '@/lib/auth/session';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { createCredential } from '@/lib/credentials/service';
import {
  GET as listAliasesRoute,
  POST as createAliasRoute,
} from '@/app/api/admin/projects/[id]/aliases/route';
import {
  GET as getAliasRoute,
  PATCH as updateAliasRoute,
  DELETE as deleteAliasRoute,
} from '@/app/api/admin/projects/[id]/aliases/[aliasId]/route';

describe('Model Alias Configuration & Strict Credential Binding API (Requirement 3, AC 1, 3.6 / TASK-031)', () => {
  let replSet: MongoMemoryReplSet;
  const APP_ORIGIN = 'http://localhost:3000';
  const keyV1Hex = crypto.randomBytes(32).toString('hex');

  let testAdminId: ObjectId;
  let validSessionCookie: string;
  let validCsrfToken: string;

  let projectAId: ObjectId;
  let projectBId: ObjectId;

  let credAActiveGemini: ObjectId;
  let credADisabledGemini: ObjectId;
  let credANonGemini: ObjectId;
  let credAAntigravity: ObjectId;
  let credBActiveGemini: ObjectId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_aliases';
    process.env.APP_ORIGIN = APP_ORIGIN;
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testAdminId = new ObjectId();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      _id: testAdminId,
      email: 'bayu.alias@gateway.local',
      passwordHash: 'dummy_hash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sessionRes = await createAdminSession(db, testAdminId);
    validSessionCookie = sessionRes.sessionToken;
    validCsrfToken = sessionRes.csrfToken;

    // Create Project A
    projectAId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: projectAId,
      name: 'Project Alpha',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS).insertOne({
      _id: projectAId,
      revision: 1,
      last_server_time: new Date(),
    });

    // Create Project B
    projectBId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: projectBId,
      name: 'Project Beta',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS).insertOne({
      _id: projectBId,
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
    const db = await getDatabase();
    await db.collection(COLLECTIONS.MODEL_ALIASES).deleteMany({});
    await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).deleteMany({});

    // 1. Project A: Active Gemini credential
    const credA = await createCredential(db, projectAId, {
      displayName: 'Project A Active Gemini Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: 'AIzaSySecretProjectAActive123',
      status: 'active',
    });
    credAActiveGemini = credA._id!;

    // 2. Project A: Disabled / revoked Gemini credential
    const credADisabled = await createCredential(db, projectAId, {
      displayName: 'Project A Revoked Gemini Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: 'AIzaSySecretProjectADisabled',
      status: 'disabled',
    });
    credADisabledGemini = credADisabled._id!;

    // 3. Project A: Non-Gemini provider credential (e.g. mock openai)
    const credANonGem = await createCredential(db, projectAId, {
      displayName: 'Project A Non-Gemini Key',
      provider: 'openai',
      credentialType: 'api_key',
      secret: 'sk-proj-non-gemini-secret',
      status: 'active',
    });
    credANonGemini = credANonGem._id!;

    // 3b. Project A: Antigravity provider credential
    const credAAnti = await createCredential(db, projectAId, {
      displayName: 'Project A Antigravity OAuth',
      provider: 'antigravity',
      credentialType: 'oauth',
      secret: JSON.stringify({
        accessToken: 'ya29.test-access-token',
        refreshToken: '1//test-refresh-token',
        expiresAt: Date.now() + 3600000,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        tokenType: 'Bearer',
      }),
      status: 'active',
    });
    credAAntigravity = credAAnti._id!;

    // 4. Project B: Active Gemini credential (belongs to Project B!)
    const credB = await createCredential(db, projectBId, {
      displayName: 'Project B Active Gemini Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: 'AIzaSySecretProjectBActive789',
      status: 'active',
    });
    credBActiveGemini = credB._id!;
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

  describe('1. Model Alias Creation & Valid Gemini Credential Binding (Requirement 3, AC 1)', () => {
    it('successfully creates model alias bound to active Gemini credential of same project', async () => {
      const db = await getDatabase();
      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectAId });

      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'gemini-flash',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credAActiveGemini.toString(),
          status: 'active',
        }
      );

      const res = await createAliasRoute(req, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(201);
      const json = await res.json();

      expect(json.alias).toHaveProperty('id');
      expect(json.alias.projectId).toBe(projectAId.toString());
      expect(json.alias.alias).toBe('gemini-flash');
      expect(json.alias.upstreamModel).toBe('gemini-2.5-flash');
      expect(json.alias.boundCredentialId).toBe(credAActiveGemini.toString());
      expect(json.alias.status).toBe('active');

      // Verify limiter guard revision incremented (Requirement 3, AC 6)
      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectAId });
      expect(guardAfter!.revision).toBe(guardBefore!.revision + 1);

      // Verify alias is added to allowedModels in Project document
      const proj = await db
        .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
        .findOne({ _id: projectAId });
      expect(proj!.allowedModels).toContain('gemini-flash');
    });

    it('rejects duplicate alias name within the same project with 409 Conflict', async () => {
      const req1 = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'duplicate-alias',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credAActiveGemini.toString(),
        }
      );
      const res1 = await createAliasRoute(req1, { params: { id: projectAId.toString() } });
      expect(res1.status).toBe(201);

      // Duplicate attempt
      const req2 = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'duplicate-alias',
          upstreamModel: 'gemini-2.5-pro',
          boundCredentialId: credAActiveGemini.toString(),
        }
      );
      const res2 = await createAliasRoute(req2, { params: { id: projectAId.toString() } });
      expect(res2.status).toBe(409);
      const json = await res2.json();
      expect(json.error.code).toBe('duplicate_alias');
    });
  });

  describe('2. Strict Credential Binding Rejections (Requirement 3, AC 1)', () => {
    it('REJECTS cross-project credential binding with 422 Unprocessable (cross_project)', async () => {
      // Attempting to bind Project B credential to Project A's alias!
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'cross-project-test',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credBActiveGemini.toString(), // Belongs to Project B!
          status: 'active',
        }
      );

      const res = await createAliasRoute(req, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe('cross_project');
      expect(json.error.message).toContain('Cross-project credential binding is strictly forbidden');
    });

    it('REJECTS inactive / disabled / revoked credential binding with 422 Unprocessable (credential_inactive)', async () => {
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'inactive-cred-test',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credADisabledGemini.toString(), // status: disabled
          status: 'active',
        }
      );

      const res = await createAliasRoute(req, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe('credential_inactive');
      expect(json.error.message).toContain('Only active credentials can be bound to an alias');
    });

    it('ALLOWS Antigravity provider credential binding with 201 Created', async () => {
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'claude-3-5',
          upstreamModel: 'claude-3-5-sonnet',
          boundCredentialId: credAAntigravity.toString(),
          status: 'active',
        }
      );

      const res = await createAliasRoute(req, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.alias.alias).toBe('claude-3-5');
      expect(json.alias.upstreamModel).toBe('claude-3-5-sonnet');
      expect(json.alias.boundCredentialId).toBe(credAAntigravity.toString());
    });

    it('REJECTS non-Gemini provider credential binding with 422 Unprocessable (non_gemini_provider)', async () => {
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'non-gemini-test',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credANonGemini.toString(), // provider: 'openai'
          status: 'active',
        }
      );

      const res = await createAliasRoute(req, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe('non_gemini_provider');
      expect(json.error.message).toContain('Aliases may only bind to official Gemini provider credentials');
    });

    it('REJECTS non-existent credential ID with 422 Unprocessable (credential_not_found)', async () => {
      const nonExistentId = new ObjectId().toString();
      const req = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'missing-cred-test',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: nonExistentId,
          status: 'active',
        }
      );

      const res = await createAliasRoute(req, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe('credential_not_found');
    });
  });

  describe('3. Model Alias Retrieval, Rebinding & Updating', () => {
    it('lists model aliases for a project and retrieves single alias', async () => {
      const reqCreate = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'alias-to-read',
          upstreamModel: 'gemini-2.5-pro',
          boundCredentialId: credAActiveGemini.toString(),
        }
      );
      const resCreate = await createAliasRoute(reqCreate, { params: { id: projectAId.toString() } });
      const createdJson = await resCreate.json();

      // List
      const reqList = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`
      );
      const resList = await listAliasesRoute(reqList, { params: { id: projectAId.toString() } });
      expect(resList.status).toBe(200);
      const listJson = await resList.json();
      expect(listJson.aliases.length).toBe(1);
      expect(listJson.aliases[0].alias).toBe('alias-to-read');

      // Single
      const reqSingle = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases/${createdJson.alias.id}`
      );
      const resSingle = await getAliasRoute(reqSingle, {
        params: { id: projectAId.toString(), aliasId: createdJson.alias.id },
      });
      expect(resSingle.status).toBe(200);
      const singleJson = await resSingle.json();
      expect(singleJson.alias.alias).toBe('alias-to-read');
    });

    it('updates alias status to disabled and serializes via limiter guard', async () => {
      const db = await getDatabase();
      const reqCreate = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'alias-to-disable',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credAActiveGemini.toString(),
          status: 'active',
        }
      );
      const resCreate = await createAliasRoute(reqCreate, { params: { id: projectAId.toString() } });
      const created = await resCreate.json();

      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectAId });

      const reqPatch = createAuthRequest(
        'PATCH',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases/${created.alias.id}`,
        { status: 'disabled' }
      );
      const resPatch = await updateAliasRoute(reqPatch, {
        params: { id: projectAId.toString(), aliasId: created.alias.id },
      });
      expect(resPatch.status).toBe(200);
      const patchJson = await resPatch.json();
      expect(patchJson.alias.status).toBe('disabled');

      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectAId });
      expect(guardAfter!.revision).toBe(guardBefore!.revision + 1);
    });

    it('enforces binding rules during PATCH when rebinding boundCredentialId', async () => {
      const reqCreate = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'alias-rebind-test',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credAActiveGemini.toString(),
        }
      );
      const resCreate = await createAliasRoute(reqCreate, { params: { id: projectAId.toString() } });
      const created = await resCreate.json();

      // Attempt rebinding to cross-project credential during PATCH
      const reqBadRebind = createAuthRequest(
        'PATCH',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases/${created.alias.id}`,
        { boundCredentialId: credBActiveGemini.toString() }
      );
      const resBad = await updateAliasRoute(reqBadRebind, {
        params: { id: projectAId.toString(), aliasId: created.alias.id },
      });
      expect(resBad.status).toBe(422);
      const badJson = await resBad.json();
      expect(badJson.error.code).toBe('cross_project');

      // Attempt rebinding to inactive credential during PATCH
      const reqInactiveRebind = createAuthRequest(
        'PATCH',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases/${created.alias.id}`,
        { boundCredentialId: credADisabledGemini.toString() }
      );
      const resInactive = await updateAliasRoute(reqInactiveRebind, {
        params: { id: projectAId.toString(), aliasId: created.alias.id },
      });
      expect(resInactive.status).toBe(422);
      const inactiveJson = await resInactive.json();
      expect(inactiveJson.error.code).toBe('credential_inactive');
    });

    it('deletes model alias and serializes with limiter guard', async () => {
      const db = await getDatabase();
      const reqCreate = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'alias-to-delete',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credAActiveGemini.toString(),
        }
      );
      const resCreate = await createAliasRoute(reqCreate, { params: { id: projectAId.toString() } });
      const created = await resCreate.json();

      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectAId });

      const reqDelete = createAuthRequest(
        'DELETE',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases/${created.alias.id}`
      );
      const resDelete = await deleteAliasRoute(reqDelete, {
        params: { id: projectAId.toString(), aliasId: created.alias.id },
      });
      expect(resDelete.status).toBe(200);

      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectAId });
      expect(guardAfter!.revision).toBe(guardBefore!.revision + 1);

      // Verify gone
      const checkDoc = await db
        .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
        .findOne({ _id: new ObjectId(created.alias.id) });
      expect(checkDoc).toBeNull();
    });
  });

  describe('4. Admin Authentication & CSRF Protection on Aliases API', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const unauthReq = createAuthRequest(
        'GET',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        undefined,
        { noCookie: true }
      );
      const res = await listAliasesRoute(unauthReq, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(401);
    });

    it('rejects mutations without CSRF token with 403 Forbidden', async () => {
      const noCsrfReq = createAuthRequest(
        'POST',
        `http://localhost:3000/api/admin/projects/${projectAId}/aliases`,
        {
          alias: 'alias-no-csrf',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: credAActiveGemini.toString(),
        },
        { noCsrf: true }
      );
      const res = await createAliasRoute(noCsrfReq, { params: { id: projectAId.toString() } });
      expect(res.status).toBe(403);
    });
  });
});
