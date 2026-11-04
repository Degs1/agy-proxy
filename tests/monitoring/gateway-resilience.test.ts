import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  ApiKeyDocument,
  ProviderCredentialDocument,
  ModelAliasDocument,
  ProjectLimiterGuardDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { encryptCredential } from '@/lib/crypto/credential-encryption';
import { hashApiKey } from '@/lib/api-keys/crypto';
import { createAdminSession } from '@/lib/auth/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/auth/csrf';
import { POST as chatCompletionsRoute } from '@/app/v1/chat/completions/route';
import { GET as getMonitoringDetailsRoute } from '@/app/api/admin/monitoring/details/route';
import * as monitoringService from '@/lib/monitoring/service';
import { UsageLogDocument } from '@/lib/monitoring/schema';

describe('Gateway Logging Failure Resilience & Null Token Invariance (TASK-064, Requirement 8.1, 8.3)', () => {
  let replSet: MongoMemoryReplSet;
  const encryptionKeyHex = crypto.randomBytes(32).toString('hex');

  let testProjectId: ObjectId;
  let testApiKeyId: ObjectId;
  let testBearerKey: string;
  let testAdminId: ObjectId;
  let validSessionCookie: string;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_resilience';
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = encryptionKeyHex;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testAdminId = new ObjectId();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      _id: testAdminId,
      email: 'admin.resilience@gateway.local',
      passwordHash: 'dummy_hash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sessionRes = await createAdminSession(db, testAdminId);
    validSessionCookie = sessionRes.sessionToken;

    // 1. Create Project
    testProjectId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Resilience Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-resilience'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS).insertOne({
      _id: testProjectId,
      revision: 1,
      last_server_time: new Date(),
    });

    // 2. Create API Key (agw_<64-hex>)
    testApiKeyId = new ObjectId();
    const rawSecretHex = crypto.randomBytes(32).toString('hex');
    testBearerKey = `agw_${rawSecretHex}`;
    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId,
      projectId: testProjectId,
      name: 'Resilience Test Key',
      keyPrefix: testBearerKey.slice(0, 8),
      keyHash: hashApiKey(testBearerKey),
      status: 'active',
      createdAt: new Date(),
    });

    // 3. Create Provider Credential
    const credId = new ObjectId();
    const encrypted = encryptCredential('test-gemini-secret-api-key');
    await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).insertOne({
      _id: credId,
      projectId: testProjectId,
      provider: 'gemini',
      displayName: 'Resilience Gemini Credential',
      credentialType: 'api_key',
      encryptedCredentials: encrypted,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 4. Create Model Alias
    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      projectId: testProjectId,
      alias: 'gemini-resilience',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: credId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    const db = await getDatabase();
    await db.collection(COLLECTIONS.USAGE_LOGS).deleteMany({});
    await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).deleteMany({});
    await db.collection(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_INTENTS).deleteMany({});
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).deleteMany({});
  });

  function buildRequest(body: Record<string, unknown>, headersInit?: Record<string, string>): NextRequest {
    const headers = new Headers({
      'Content-Type': 'application/json',
      ...headersInit,
    });
    return new NextRequest(new URL('http://localhost:3000/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  describe('1. Non-stream Gateway Response Resilience to Logging Failures', () => {
    it('returns standard 200 completion response even if recordUsageLog fails with write error', async () => {
      // Mock Gemini API upstream call
      const mockGeminiResponse = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Resilient response from Gemini' }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 25,
          totalTokenCount: 40,
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => mockGeminiResponse,
      } as any);

      // Force recordUsageLog to throw internal MongoWriteConcernError
      const recordSpy = vi.spyOn(monitoringService, 'recordUsageLog').mockImplementation(async () => {
        throw new Error('MongoWriteConcernError: secondary write acknowledgement timed out');
      });

      const idempotencyKey = crypto.randomUUID();
      const req = buildRequest(
        {
          model: 'gemini-resilience',
          messages: [{ role: 'user', content: 'Testing resilience' }],
        },
        {
          Authorization: `Bearer ${testBearerKey}`,
          'Idempotency-Key': idempotencyKey,
        }
      );

      const res = await chatCompletionsRoute(req);

      // Gateway MUST succeed with 200 and valid completion choices!
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.object).toBe('chat.completion');
      expect(data.choices[0].message.content).toBe('Resilient response from Gemini');
      expect(data.choices[0].finish_reason).toBe('stop');
      expect(data.usage.prompt_tokens).toBe(15);
      expect(data.usage.completion_tokens).toBe(25);
      expect(data.usage.total_tokens).toBe(40);

      // Verify that recordUsageLog was called and its failure did NOT break gateway
      expect(recordSpy).toHaveBeenCalled();
    });

    it('returns standard 401 when auth header is missing even if preauth rejection logging fails', async () => {
      vi.spyOn(monitoringService, 'recordPreauthRejection').mockImplementation(async () => {
        throw new Error('MongoNetworkTimeoutError: connection to replica set primary lost');
      });

      const req = buildRequest(
        {
          model: 'gemini-resilience',
          messages: [{ role: 'user', content: 'Unauthenticated test' }],
        },
        {} // No Authorization header
      );

      const res = await chatCompletionsRoute(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_api_key');
      expect(data.error.message).toContain('Authorization header is missing');
    });
  });

  describe('2. Unmeasured Token Null Invariance (Requirement 5.2, 8.3 / AC 16.3)', () => {
    it('stores token counts as null and outputs null when provider reports no token usage', async () => {
      const db = await getDatabase();

      // Mock Gemini API without usageMetadata
      const mockGeminiNoTokens = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Response without tokens' }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        // usageMetadata omitted
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => mockGeminiNoTokens,
      } as any);

      const idempotencyKey = crypto.randomUUID();
      const req = buildRequest(
        {
          model: 'gemini-resilience',
          messages: [{ role: 'user', content: 'No tokens test' }],
        },
        {
          Authorization: `Bearer ${testBearerKey}`,
          'Idempotency-Key': idempotencyKey,
        }
      );

      const res = await chatCompletionsRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();

      // Requirement 5, AC 2: usage SHALL be null when unmeasured
      expect(data.usage).toBeNull();

      // Check database usage_logs collection
      const log = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).findOne({ requestId: idempotencyKey });
      expect(log).not.toBeNull();
      expect(log?.inputTokens).toBeNull();
      expect(log?.outputTokens).toBeNull();
      expect(log?.totalTokens).toBeNull();
      expect(log?.inputTokens).not.toBe(0);
      expect(log?.outputTokens).not.toBe(0);
      expect(log?.totalTokens).not.toBe(0);

      // Verify in Admin Monitoring Details API: displays null, NEVER 0
      const adminReq = new NextRequest(
        new URL(`http://localhost:3000/api/admin/monitoring/details?projectId=${testProjectId.toString()}`),
        {
          headers: new Headers({
            cookie: `${ADMIN_SESSION_COOKIE}=${validSessionCookie}`,
          }),
        }
      );
      const detailsRes = await getMonitoringDetailsRoute(adminReq);
      expect(detailsRes.status).toBe(200);
      const detailsJson = await detailsRes.json();
      const queriedLog = detailsJson.logs.find((l: any) => l.requestId === idempotencyKey);
      expect(queriedLog).toBeDefined();
      expect(queriedLog.inputTokens).toBeNull();
      expect(queriedLog.outputTokens).toBeNull();
      expect(queriedLog.totalTokens).toBeNull();
    });
  });

  describe('3. Streaming Gateway Usage Logging Integration & Resilience', () => {
    function createMockStream(chunks: string[]): Response {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    it('records usage log when streaming fails during Delayed Headers Phase (early error before first text chunk)', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Mock provider 502 error response before SSE opened
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () => JSON.stringify({ error: { message: 'Upstream bad gateway' } }),
      } as any);

      const req = buildRequest(
        {
          model: 'gemini-resilience',
          messages: [{ role: 'user', content: 'Stream error test' }],
          stream: true,
        },
        {
          Authorization: `Bearer ${testBearerKey}`,
          'Idempotency-Key': idempotencyKey,
        }
      );

      const res = await chatCompletionsRoute(req);
      expect(res.status).toBe(502);
      expect(res.headers.get('Content-Type')).toBe('application/json');

      // Verify that usage log is recorded in DB despite failure in delayed headers phase
      const log = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).findOne({ requestId: idempotencyKey });
      expect(log).not.toBeNull();
      expect(log?.streaming).toBe(true);
      expect(log?.result).toBe('error');
      expect(log?.statusCode).toBe(502);
      expect(log?.model).toBe('gemini-resilience');
      expect(log?.inputTokens).toBeNull();
      expect(log?.outputTokens).toBeNull();
    });

    it('records usage log with measured tokens upon successful stream completion', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const geminiEvents = [
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Streaming ' }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'success!' }] } }] })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        })}\n\n`,
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockStream(geminiEvents));

      const req = buildRequest(
        {
          model: 'gemini-resilience',
          messages: [{ role: 'user', content: 'Stream success test' }],
          stream: true,
        },
        {
          Authorization: `Bearer ${testBearerKey}`,
          'Idempotency-Key': idempotencyKey,
        }
      );

      const res = await chatCompletionsRoute(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/event-stream');

      // Drain the response stream so the generator finishes
      const reader = res.body?.getReader();
      if (reader) {
        while (!(await reader.read()).done) {}
      }

      // Check usage log recorded in database
      const log = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).findOne({ requestId: idempotencyKey });
      expect(log).not.toBeNull();
      expect(log?.streaming).toBe(true);
      expect(log?.result).toBe('success');
      expect(log?.statusCode).toBe(200);
      expect(log?.inputTokens).toBe(10);
      expect(log?.outputTokens).toBe(5);
      expect(log?.totalTokens).toBe(15);
    });

    it('stream Delayed Headers Phase failure returns 502 even if recordUsageLog throws write error', async () => {
      // Mock recordUsageLog to throw error
      vi.spyOn(monitoringService, 'recordUsageLog').mockImplementation(async () => {
        throw new Error('MongoWriteConcernError: secondary write failed');
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () => JSON.stringify({ error: { message: 'Upstream bad gateway' } }),
      } as any);

      const req = buildRequest(
        {
          model: 'gemini-resilience',
          messages: [{ role: 'user', content: 'Stream resilience error' }],
          stream: true,
        },
        {
          Authorization: `Bearer ${testBearerKey}`,
          'Idempotency-Key': crypto.randomUUID(),
        }
      );

      const res = await chatCompletionsRoute(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toBeDefined();
    });
  });
});
