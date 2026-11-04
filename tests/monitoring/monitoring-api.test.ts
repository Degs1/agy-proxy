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
  ProjectDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createAdminSession } from '@/lib/auth/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/auth/csrf';
import {
  recordUsageLog,
  recordPreauthRejection,
} from '@/lib/monitoring/service';
import { GET as getMonitoringSummaryRoute } from '@/app/api/admin/monitoring/summary/route';
import { GET as getMonitoringDetailsRoute } from '@/app/api/admin/monitoring/details/route';

describe('Admin Monitoring API: Summary & Details (Requirement 8.2, 8.3, 8.4 / TASK-063)', () => {
  let replSet: MongoMemoryReplSet;
  let testAdminId: ObjectId;
  let validSessionCookie: string;

  let project1Id: ObjectId;
  let project2Id: ObjectId;
  let apiKey1Id: ObjectId;
  let apiKey2Id: ObjectId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_monitoring_api';

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testAdminId = new ObjectId();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      _id: testAdminId,
      email: 'admin.monitoring@gateway.local',
      passwordHash: 'dummy_hash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sessionRes = await createAdminSession(db, testAdminId);
    validSessionCookie = sessionRes.sessionToken;

    project1Id = new ObjectId();
    project2Id = new ObjectId();
    apiKey1Id = new ObjectId();
    apiKey2Id = new ObjectId();

    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertMany([
      {
        _id: project1Id,
        name: 'Project Orion',
        status: 'active',
        rpmLimit: 60,
        concurrencyLimit: 5,
        allowedModels: ['gemini-default'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        _id: project2Id,
        name: 'Project Pegasus',
        status: 'active',
        rpmLimit: 120,
        concurrencyLimit: 10,
        allowedModels: ['gemini-flash'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
  });

  beforeEach(async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.USAGE_LOGS).deleteMany({});
    await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).deleteMany({});
    await db.collection(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).deleteMany({});
  });

  function createAdminRequest(url: string, cookie?: string): NextRequest {
    const headers = new Headers();
    if (cookie) {
      headers.set('cookie', `${ADMIN_SESSION_COOKIE}=${cookie}`);
    }
    return new NextRequest(new URL(url, 'http://localhost:3000'), {
      method: 'GET',
      headers,
    });
  }

  describe('Authentication & Access Control', () => {
    it('returns 401 Unauthorized for GET /api/admin/monitoring/summary without session cookie', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/monitoring/summary');
      const res = await getMonitoringSummaryRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });

    it('returns 401 Unauthorized for GET /api/admin/monitoring/details without session cookie', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/monitoring/details');
      const res = await getMonitoringDetailsRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('unauthorized');
    });
  });

  describe('GET /api/admin/monitoring/summary (Requirement 8.2)', () => {
    it('returns accurate aggregation and isolates pre-auth rejections without attribution', async () => {
      const db = await getDatabase();
      const baseTime = new Date('2026-11-04T08:00:00.000Z');

      // Seed Project 1 requests
      await recordUsageLog(db, {
        requestId: 'p1-req-1',
        projectId: project1Id,
        apiKeyId: apiKey1Id,
        model: 'gemini-default',
        provider: 'gemini',
        statusCode: 200,
        durationMs: 200,
        result: 'success',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        streaming: false,
        createdAt: baseTime,
      });

      await recordUsageLog(db, {
        requestId: 'p1-req-2',
        projectId: project1Id,
        apiKeyId: apiKey1Id,
        model: 'gemini-default',
        provider: 'gemini',
        statusCode: 502,
        durationMs: 400,
        result: 'error',
        errorCode: 'provider_error',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        streaming: false,
        createdAt: new Date(baseTime.getTime() + 1000),
      });

      // Seed Project 2 requests
      await recordUsageLog(db, {
        requestId: 'p2-req-1',
        projectId: project2Id,
        apiKeyId: apiKey2Id,
        model: 'gemini-flash',
        provider: 'gemini',
        statusCode: 200,
        durationMs: 150,
        result: 'success',
        inputTokens: 300,
        outputTokens: 100,
        totalTokens: 400,
        streaming: true,
        createdAt: new Date(baseTime.getTime() + 2000),
      });

      // Seed Pre-auth rejections (unauthenticated)
      await recordPreauthRejection(db, {
        startTime: baseTime,
        durationMs: 3,
        statusCode: 401,
        errorCode: 'invalid_api_key',
      });
      await recordPreauthRejection(db, {
        startTime: new Date(baseTime.getTime() + 500),
        durationMs: 2,
        statusCode: 401,
        errorCode: 'invalid_api_key',
      });

      const req = createAdminRequest(
        'http://localhost:3000/api/admin/monitoring/summary',
        validSessionCookie
      );
      const res = await getMonitoringSummaryRoute(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.summary).toBeDefined();
      const { summary } = json;

      // Overall requests
      expect(summary.totalRequests).toBe(3);
      expect(summary.successfulRequests).toBe(2);
      expect(summary.failedRequests).toBe(1);
      // Average duration: (200 + 400 + 150) / 3 = 250
      expect(summary.averageDurationMs).toBeCloseTo(250, 1);

      // Total tokens measured: 150 + 400 = 550 total (prompt: 100 + 300 = 400, completion: 50 + 100 = 150)
      expect(summary.totalTokens.promptTokens).toBe(400);
      expect(summary.totalTokens.completionTokens).toBe(150);
      expect(summary.totalTokens.totalTokens).toBe(550);

      // Projects breakdown
      expect(summary.projects).toHaveLength(2);
      const p1 = summary.projects.find((p: any) => p.projectId === project1Id.toString());
      expect(p1).toBeDefined();
      expect(p1.projectName).toBe('Project Orion');
      expect(p1.totalRequests).toBe(2);
      expect(p1.successfulRequests).toBe(1);
      expect(p1.failedRequests).toBe(1);
      expect(p1.promptTokens).toBe(100);
      expect(p1.completionTokens).toBe(50);
      expect(p1.totalTokens).toBe(150);

      const p2 = summary.projects.find((p: any) => p.projectId === project2Id.toString());
      expect(p2).toBeDefined();
      expect(p2.projectName).toBe('Project Pegasus');
      expect(p2.totalRequests).toBe(1);
      expect(p2.successfulRequests).toBe(1);
      expect(p2.failedRequests).toBe(0);
      expect(p2.totalTokens).toBe(400);

      // Provider breakdown
      expect(summary.providers).toHaveLength(1);
      expect(summary.providers[0].provider).toBe('gemini');
      expect(summary.providers[0].totalRequests).toBe(3);
      expect(summary.providers[0].successfulRequests).toBe(2);
      expect(summary.providers[0].failedRequests).toBe(1);

      // Pre-auth rejections isolated completely without project/provider attribution (Requirement 8.2)
      expect(summary.preauthRejections).toBeDefined();
      expect(summary.preauthRejections.total).toBe(2);
    });

    it('returns clean zeroed statistics when no logs exist', async () => {
      const req = createAdminRequest(
        'http://localhost:3000/api/admin/monitoring/summary',
        validSessionCookie
      );
      const res = await getMonitoringSummaryRoute(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.summary.totalRequests).toBe(0);
      expect(json.summary.successfulRequests).toBe(0);
      expect(json.summary.failedRequests).toBe(0);
      expect(json.summary.averageDurationMs).toBe(0);
      expect(json.summary.totalTokens.totalTokens).toBe(0);
      expect(json.summary.preauthRejections.total).toBe(0);
    });
  });

  describe('GET /api/admin/monitoring/details (Requirement 8.2, 8.4)', () => {
    it('returns paginated logs with proper filters and preserves null token values', async () => {
      const db = await getDatabase();
      const baseTime = new Date('2026-11-04T09:00:00.000Z');

      // Create 3 logs for Project 1 and 2 logs for Project 2
      for (let i = 1; i <= 3; i++) {
        await recordUsageLog(db, {
          requestId: `p1-details-${i}`,
          projectId: project1Id,
          apiKeyId: apiKey1Id,
          model: 'gemini-default',
          provider: 'gemini',
          statusCode: 200,
          durationMs: 100 * i,
          result: 'success',
          inputTokens: null, // Test unmeasured tokens remain null!
          outputTokens: null,
          totalTokens: null,
          streaming: false,
          createdAt: new Date(baseTime.getTime() + i * 1000),
        });
      }

      await recordUsageLog(db, {
        requestId: 'p2-details-1',
        projectId: project2Id,
        apiKeyId: apiKey2Id,
        model: 'gemini-flash',
        provider: 'gemini',
        statusCode: 429,
        durationMs: 50,
        result: 'error',
        errorCode: 'rate_limit_exceeded',
        streaming: false,
        createdAt: new Date(baseTime.getTime() + 4000),
      });

      // Query without filter
      const reqAll = createAdminRequest(
        'http://localhost:3000/api/admin/monitoring/details?limit=2&offset=0',
        validSessionCookie
      );
      const resAll = await getMonitoringDetailsRoute(reqAll);
      expect(resAll.status).toBe(200);
      const jsonAll = await resAll.json();

      expect(jsonAll.total).toBe(4);
      expect(jsonAll.limit).toBe(2);
      expect(jsonAll.offset).toBe(0);
      expect(jsonAll.logs).toHaveLength(2);

      // Verify unmeasured token values are null, NOT 0
      const logWithNullTokens = jsonAll.logs.find((l: any) => l.requestId === 'p1-details-3');
      if (logWithNullTokens) {
        expect(logWithNullTokens.inputTokens).toBeNull();
        expect(logWithNullTokens.outputTokens).toBeNull();
        expect(logWithNullTokens.totalTokens).toBeNull();
      }

      // Query filter by projectId
      const reqFilterProj = createAdminRequest(
        `http://localhost:3000/api/admin/monitoring/details?projectId=${project1Id.toString()}`,
        validSessionCookie
      );
      const resFilterProj = await getMonitoringDetailsRoute(reqFilterProj);
      const jsonFilterProj = await resFilterProj.json();

      expect(jsonFilterProj.total).toBe(3);
      expect(jsonFilterProj.logs.every((l: any) => l.projectId === project1Id.toString())).toBe(true);

      // Query filter by provider
      const reqFilterProvider = createAdminRequest(
        'http://localhost:3000/api/admin/monitoring/details?provider=gemini',
        validSessionCookie
      );
      const resFilterProvider = await getMonitoringDetailsRoute(reqFilterProvider);
      const jsonFilterProvider = await resFilterProvider.json();
      expect(jsonFilterProvider.total).toBe(4);

      // Zero-Plaintext-Recall verification on returned logs
      jsonFilterProj.logs.forEach((log: any) => {
        expect(log.apiKey).toBeUndefined();
        expect(log.keyHash).toBeUndefined();
        expect(log.secret).toBeUndefined();
        expect(log.prompt).toBeUndefined();
        expect(log.response).toBeUndefined();
        expect(log.messages).toBeUndefined();
      });
    });

    it('supports querying pre-auth rejection details separately via type=preauth', async () => {
      const db = await getDatabase();
      const now = new Date();

      await recordPreauthRejection(db, {
        startTime: now,
        durationMs: 8,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        requestId: 'preauth-query-1',
      });

      const req = createAdminRequest(
        'http://localhost:3000/api/admin/monitoring/details?type=preauth',
        validSessionCookie
      );
      const res = await getMonitoringDetailsRoute(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.total).toBe(1);
      expect(json.logs).toHaveLength(1);
      const preauth = json.logs[0];
      expect(preauth.statusCode).toBe(401);
      expect(preauth.errorCode).toBe('invalid_api_key');
      expect(preauth.projectId).toBeNull();
      expect(preauth.model).toBeNull();
      expect(preauth.provider).toBeNull();
    });
  });
});
