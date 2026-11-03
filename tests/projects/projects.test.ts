import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';
import { ObjectId } from 'mongodb';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import { COLLECTIONS, ProjectLimiterGuardDocument, ModelAliasDocument } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createAdminSession } from '@/lib/auth/session';
import { ADMIN_SESSION_COOKIE, CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { GET as getProjects, POST as createProjectRoute } from '@/app/api/admin/projects/route';
import {
  GET as getProjectByIdRoute,
  PATCH as updateProjectRoute,
  DELETE as deleteProjectRoute,
} from '@/app/api/admin/projects/[id]/route';
import { modelAliasSchema } from '@/lib/projects/schema';
import { listModelAliases, getModelAlias } from '@/lib/projects/service';

describe('Project CRUD, Positive Integer Limits, and Model Alias Shapes (Requirement 3, AC 1, 3.6 & Subtask 6.1)', () => {
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
    process.env.MONGODB_DB_NAME = 'test_gateway_projects';
    process.env.APP_ORIGIN = APP_ORIGIN;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    // Create an active admin user
    testAdminId = new ObjectId();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      _id: testAdminId,
      email: 'bayu.admin@gateway.local',
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
    await db.collection(COLLECTIONS.MODEL_ALIASES).deleteMany({});
    await db.collection(COLLECTIONS.API_KEYS).deleteMany({});
  });

  function createAdminRequest(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

    headers.set('content-type', 'application/json');

    return new NextRequest(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  }

  describe('1. Project CRUD & Limiter Guard Creation', () => {
    it('creates a project with default values (rpm: 60, concurrency: 5, status: active) and creates limiter guard in Atlas', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: {
          name: 'Core Project Alpha',
          description: 'Primary customer gateway project',
        },
      });

      const res = await createProjectRoute(req);
      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.project).toBeDefined();
      expect(json.project.name).toBe('Core Project Alpha');
      expect(json.project.description).toBe('Primary customer gateway project');
      expect(json.project.status).toBe('active');
      expect(json.project.rpmLimit).toBe(60);
      expect(json.project.concurrencyLimit).toBe(5);
      expect(json.project.allowedModels).toEqual(['gemini-default']);
      expect(json.project.id).toBeDefined();

      // Verify database state: project exists and limiter guard exists with matching _id
      const db = await getDatabase();
      const projectId = new ObjectId(json.project.id);

      const projectDoc = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: projectId });
      expect(projectDoc).not.toBeNull();
      expect(projectDoc?.name).toBe('Core Project Alpha');

      const guardDoc = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectId });
      expect(guardDoc).not.toBeNull();
      expect(guardDoc?._id.toString()).toBe(projectId.toString());
      expect(guardDoc?.revision).toBeGreaterThanOrEqual(1);
      expect(guardDoc?.last_server_time).toBeInstanceOf(Date);
    });

    it('lists all projects and fetches single project by ID', async () => {
      // Create 2 projects
      const req1 = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Project 1' },
      });
      const res1 = await createProjectRoute(req1);
      const json1 = await res1.json();

      const req2 = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Project 2' },
      });
      await createProjectRoute(req2);

      // List projects
      const listReq = createAdminRequest('http://localhost:3000/api/admin/projects', 'GET');
      const listRes = await getProjects(listReq);
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.projects).toHaveLength(2);

      // Get project 1 by ID
      const getReq = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${json1.project.id}`,
        'GET'
      );
      const getRes = await getProjectByIdRoute(getReq, {
        params: Promise.resolve({ id: json1.project.id }),
      });
      expect(getRes.status).toBe(200);
      const getJson = await getRes.json();
      expect(getJson.project.id).toBe(json1.project.id);
      expect(getJson.project.name).toBe('Project 1');
    });

    it('updates project configuration and increments limiter guard revision in transaction', async () => {
      const createReq = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Original Name', rpmLimit: 60, concurrencyLimit: 5 },
      });
      const createRes = await createProjectRoute(createReq);
      const { project } = await createRes.json();

      const db = await getDatabase();
      const projectId = new ObjectId(project.id);
      const guardBefore = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectId });

      const patchReq = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${project.id}`,
        'PATCH',
        {
          body: {
            name: 'Updated Name',
            rpmLimit: 120,
            concurrencyLimit: 10,
            allowedModels: ['gemini-default', 'gemini-2.5-pro'],
          },
        }
      );
      const patchRes = await updateProjectRoute(patchReq, {
        params: Promise.resolve({ id: project.id }),
      });
      expect(patchRes.status).toBe(200);

      const patchJson = await patchRes.json();
      expect(patchJson.project.name).toBe('Updated Name');
      expect(patchJson.project.rpmLimit).toBe(120);
      expect(patchJson.project.concurrencyLimit).toBe(10);
      expect(patchJson.project.allowedModels).toEqual(['gemini-default', 'gemini-2.5-pro']);

      // Verify limiter guard revision increased and last_server_time updated
      const guardAfter = await db
        .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
        .findOne({ _id: projectId });
      expect(guardAfter?.revision).toBeGreaterThan(guardBefore!.revision);
      expect(guardAfter?.last_server_time.getTime()).toBeGreaterThanOrEqual(
        guardBefore!.last_server_time.getTime()
      );
    });

    it('deletes a project, deletes its limiter guard, and revokes associated API keys', async () => {
      const createReq = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'To Be Deleted' },
      });
      const createRes = await createProjectRoute(createReq);
      const { project } = await createRes.json();
      const projectId = new ObjectId(project.id);

      const db = await getDatabase();
      // Insert mock API key for this project
      await db.collection(COLLECTIONS.API_KEYS).insertOne({
        projectId,
        name: 'Key to revoke',
        keyPrefix: 'agw_1234',
        keyHash: 'dummy_hash',
        status: 'active',
        createdAt: new Date(),
      });

      const deleteReq = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${project.id}`,
        'DELETE'
      );
      const deleteRes = await deleteProjectRoute(deleteReq, {
        params: Promise.resolve({ id: project.id }),
      });
      expect(deleteRes.status).toBe(200);

      // Verify project is deleted
      const foundProject = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: projectId });
      expect(foundProject).toBeNull();

      // Verify limiter guard is cleaned up
      const foundGuard = await db.collection(COLLECTIONS.PROJECT_LIMITER_GUARDS).findOne({ _id: projectId });
      expect(foundGuard).toBeNull();

      // Verify API key is marked revoked
      const apiKey = await db.collection(COLLECTIONS.API_KEYS).findOne({ projectId });
      expect(apiKey?.status).toBe('revoked');
    });
  });

  describe('2. Positive Integer Limits (Batas Bilangan Bulat Positif)', () => {
    it('rejects rpmLimit <= 0 (e.g. 0, -1) with 400 Bad Request', async () => {
      const reqZero = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Invalid RPM', rpmLimit: 0 },
      });
      const resZero = await createProjectRoute(reqZero);
      expect(resZero.status).toBe(400);
      const jsonZero = await resZero.json();
      expect(jsonZero.error.code).toBe('invalid_request');
      expect(jsonZero.error.message).toContain('rpmLimit');

      const reqNegative = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Negative RPM', rpmLimit: -15 },
      });
      const resNeg = await createProjectRoute(reqNegative);
      expect(resNeg.status).toBe(400);
    });

    it('rejects non-integer rpmLimit (e.g. 60.5, "60") with 400 Bad Request', async () => {
      const reqFloat = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Float RPM', rpmLimit: 60.5 },
      });
      const resFloat = await createProjectRoute(reqFloat);
      expect(resFloat.status).toBe(400);

      const reqString = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'String RPM', rpmLimit: '60' },
      });
      const resString = await createProjectRoute(reqString);
      expect(resString.status).toBe(400);
    });

    it('rejects concurrencyLimit <= 0 (e.g. 0, -1) with 400 Bad Request', async () => {
      const reqZero = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Zero Concurrency', concurrencyLimit: 0 },
      });
      const resZero = await createProjectRoute(reqZero);
      expect(resZero.status).toBe(400);

      const reqNeg = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Negative Concurrency', concurrencyLimit: -1 },
      });
      const resNeg = await createProjectRoute(reqNeg);
      expect(resNeg.status).toBe(400);
    });

    it('rejects non-integer concurrencyLimit (e.g. 5.5, "5") with 400 Bad Request', async () => {
      const reqFloat = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Float Concurrency', concurrencyLimit: 5.5 },
      });
      const resFloat = await createProjectRoute(reqFloat);
      expect(resFloat.status).toBe(400);
    });

    it('accepts valid positive integer limits on create and update', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Valid Limits', rpmLimit: 1, concurrencyLimit: 1 },
      });
      const res = await createProjectRoute(req);
      expect(res.status).toBe(201);
      const { project } = await res.json();
      expect(project.rpmLimit).toBe(1);
      expect(project.concurrencyLimit).toBe(1);

      const patchReq = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${project.id}`,
        'PATCH',
        {
          body: { rpmLimit: 500, concurrencyLimit: 50 },
        }
      );
      const patchRes = await updateProjectRoute(patchReq, {
        params: Promise.resolve({ id: project.id }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = await patchRes.json();
      expect(patchJson.project.rpmLimit).toBe(500);
      expect(patchJson.project.concurrencyLimit).toBe(50);
    });
  });

  describe('3. Disabled Status (Status Nonaktif)', () => {
    it('supports creating a project directly with status disabled', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Disabled From Start', status: 'disabled' },
      });
      const res = await createProjectRoute(req);
      expect(res.status).toBe(201);

      const { project } = await res.json();
      expect(project.status).toBe('disabled');

      const db = await getDatabase();
      const doc = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: new ObjectId(project.id) });
      expect(doc?.status).toBe('disabled');
    });

    it('updates an active project to disabled status and persists in Atlas', async () => {
      const createReq = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        body: { name: 'Active Project' },
      });
      const createRes = await createProjectRoute(createReq);
      const { project } = await createRes.json();
      expect(project.status).toBe('active');

      const patchReq = createAdminRequest(
        `http://localhost:3000/api/admin/projects/${project.id}`,
        'PATCH',
        {
          body: { status: 'disabled' },
        }
      );
      const patchRes = await updateProjectRoute(patchReq, {
        params: Promise.resolve({ id: project.id }),
      });
      expect(patchRes.status).toBe(200);
      const patchJson = await patchRes.json();
      expect(patchJson.project.status).toBe('disabled');

      const db = await getDatabase();
      const doc = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: new ObjectId(project.id) });
      expect(doc?.status).toBe('disabled');
    });

    it('filters projects by status in GET /api/admin/projects?status=disabled', async () => {
      await createProjectRoute(
        createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
          body: { name: 'Active 1', status: 'active' },
        })
      );
      await createProjectRoute(
        createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
          body: { name: 'Disabled 1', status: 'disabled' },
        })
      );

      const reqActive = createAdminRequest(
        'http://localhost:3000/api/admin/projects?status=active',
        'GET'
      );
      const resActive = await getProjects(reqActive);
      const jsonActive = await resActive.json();
      expect(jsonActive.projects).toHaveLength(1);
      expect(jsonActive.projects[0].status).toBe('active');

      const reqDisabled = createAdminRequest(
        'http://localhost:3000/api/admin/projects?status=disabled',
        'GET'
      );
      const resDisabled = await getProjects(reqDisabled);
      const jsonDisabled = await resDisabled.json();
      expect(jsonDisabled.projects).toHaveLength(1);
      expect(jsonDisabled.projects[0].status).toBe('disabled');
    });
  });

  describe('4. Model Alias Data Shape & Explicit Bindings (Without testing credential binding)', () => {
    it('validates explicit model alias schema storing actual Gemini model and bound credential ID', () => {
      const projectId = new ObjectId();
      const boundCredentialId = new ObjectId();

      const validAlias = {
        projectId: projectId.toString(),
        alias: 'gemini-default',
        upstreamModel: 'gemini-2.5-flash',
        boundCredentialId: boundCredentialId.toString(),
        status: 'active',
      };

      const parsed = modelAliasSchema.safeParse(validAlias);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.alias).toBe('gemini-default');
        expect(parsed.data.upstreamModel).toBe('gemini-2.5-flash');
        expect(parsed.data.boundCredentialId.toString()).toBe(boundCredentialId.toString());
        expect(parsed.data.status).toBe('active');
      }
    });

    it('rejects model alias missing upstreamModel (actual Gemini model is mandatory)', () => {
      const aliasMissingModel = {
        projectId: new ObjectId().toString(),
        alias: 'gemini-default',
        boundCredentialId: new ObjectId().toString(),
        status: 'active',
      };

      const parsed = modelAliasSchema.safeParse(aliasMissingModel);
      expect(parsed.success).toBe(false);
    });

    it('rejects model alias missing boundCredentialId (explicit binding is mandatory)', () => {
      const aliasMissingCred = {
        projectId: new ObjectId().toString(),
        alias: 'gemini-default',
        upstreamModel: 'gemini-2.5-flash',
        status: 'active',
      };

      const parsed = modelAliasSchema.safeParse(aliasMissingCred);
      expect(parsed.success).toBe(false);
    });

    it('rejects invalid ObjectId formats for projectId and boundCredentialId', () => {
      const aliasInvalidId = {
        projectId: 'not-an-object-id',
        alias: 'gemini-default',
        upstreamModel: 'gemini-2.5-flash',
        boundCredentialId: '12345',
        status: 'active',
      };

      const parsed = modelAliasSchema.safeParse(aliasInvalidId);
      expect(parsed.success).toBe(false);
    });

    it('stores and retrieves model alias documents in Atlas conforming to ModelAliasDocument schema', async () => {
      const db = await getDatabase();
      const projectId = new ObjectId();
      const credentialId = new ObjectId();

      const aliasDoc: ModelAliasDocument = {
        projectId,
        alias: 'gemini-pro-custom',
        upstreamModel: 'gemini-2.5-pro',
        boundCredentialId: credentialId,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const insertRes = await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne(aliasDoc);
      expect(insertRes.insertedId).toBeDefined();

      const fetched = await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).findOne({
        projectId,
        alias: 'gemini-pro-custom',
      });

      expect(fetched).not.toBeNull();
      expect(fetched?.upstreamModel).toBe('gemini-2.5-pro');
      expect(fetched?.boundCredentialId.toString()).toBe(credentialId.toString());
      expect(fetched?.status).toBe('active');
    });

    it('queries model aliases via listModelAliases and getModelAlias helpers', async () => {
      const db = await getDatabase();
      const projectId = new ObjectId();
      const cred1 = new ObjectId();
      const cred2 = new ObjectId();

      await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertMany([
        {
          projectId,
          alias: 'gemini-default',
          upstreamModel: 'gemini-2.5-flash',
          boundCredentialId: cred1,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          projectId,
          alias: 'gemini-pro',
          upstreamModel: 'gemini-2.5-pro',
          boundCredentialId: cred2,
          status: 'disabled',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const aliases = await listModelAliases(db, projectId);
      expect(aliases).toHaveLength(2);

      const defaultAlias = await getModelAlias(db, projectId, 'gemini-default');
      expect(defaultAlias).not.toBeNull();
      expect(defaultAlias?.upstreamModel).toBe('gemini-2.5-flash');
      expect(defaultAlias?.boundCredentialId.toString()).toBe(cred1.toString());

      const notFound = await getModelAlias(db, projectId, 'non-existent');
      expect(notFound).toBeNull();
    });
  });

  describe('5. Admin Authentication & CSRF Protection on Projects API', () => {
    it('rejects requests without session cookie with 401 Unauthorized', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/projects', 'GET', {
        sessionCookie: null,
      });
      const res = await getProjects(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('rejects mutations without CSRF token with 403 Forbidden', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        csrfToken: null,
        body: { name: 'CSRF Attack' },
      });
      const res = await createProjectRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('csrf_rejected');
    });

    it('rejects mutations with mismatched Origin with 403 Forbidden', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/projects', 'POST', {
        origin: 'https://malicious-website.com',
        body: { name: 'Origin Spoof' },
      });
      const res = await createProjectRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('origin_rejected');
    });
  });
});
