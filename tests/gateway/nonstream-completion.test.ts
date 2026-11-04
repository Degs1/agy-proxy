import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { getDatabase, closeDatabaseConnection } from '@/lib/db/client';
import {
  COLLECTIONS,
  ProjectDocument,
  ApiKeyDocument,
  ModelAliasDocument,
  ProviderCredentialDocument,
  ProjectLimiterGuardDocument,
  AdmissionDecisionDocument,
  ConcurrencyLeaseDocument,
  RateCounterDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createApiKey } from '@/lib/api-keys/service';
import { createCredential } from '@/lib/credentials/service';
import { encryptCredential } from '@/lib/crypto/credential-encryption';
import { POST } from '@/app/v1/chat/completions/route';

describe('TASK-052: Endpoint Non-Stream POST /v1/chat/completions', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;
  let originalFetch: typeof globalThis.fetch;

  const keyV1Hex = crypto.randomBytes(32).toString('hex');
  const geminiSecret = 'AIzaSyFakeGeminiApiKey1234567890';

  let testProjectId: ObjectId;
  let testApiKeyDoc: ApiKeyDocument;
  let testBearerKey: string;
  let testCredentialDoc: ProviderCredentialDocument;
  let testAliasDoc: ModelAliasDocument;
  const testModelAlias = 'gemini-default';

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_nonstream';
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

    originalFetch = globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
    process.env = originalEnv;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete process.env.GATEWAY_NONSTREAM_TIMEOUT_MS;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    // Clean all collections
    await db.collection(COLLECTIONS.PROJECTS).deleteMany({});
    await db.collection(COLLECTIONS.API_KEYS).deleteMany({});
    await db.collection(COLLECTIONS.MODEL_ALIASES).deleteMany({});
    await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).deleteMany({});
    await db.collection(COLLECTIONS.PROJECT_LIMITER_GUARDS).deleteMany({});
    await db.collection(COLLECTIONS.RATE_COUNTERS).deleteMany({});
    await db.collection(COLLECTIONS.REJECTION_COUNTERS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_INTENTS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteMany({});
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).deleteMany({});

    // Setup base Project
    testProjectId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Nonstream Gateway Test Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: [testModelAlias],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Setup Project Limiter Guard
    await db.collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS).insertOne({
      _id: testProjectId,
      revision: 1,
      last_server_time: new Date(),
    });

    // Create API Key
    const keyResult = await createApiKey(db, testProjectId, {
      name: 'Default Test API Key',
    });
    testApiKeyDoc = keyResult.apiKey;
    testBearerKey = keyResult.secret;

    // Create Credential
    testCredentialDoc = await createCredential(db, testProjectId, {
      provider: 'gemini',
      credentialType: 'api_key',
      status: 'active',
      secret: geminiSecret,
      displayName: 'Default Test Gemini Credential',
    });

    // Create Model Alias bound to Credential
    testAliasDoc = {
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: testModelAlias,
      upstreamModel: 'gemini-1.5-flash',
      boundCredentialId: testCredentialDoc._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne(testAliasDoc);
  });

  function buildRequest(options: {
    bearerToken?: string | null;
    idempotencyKey?: string | null;
    body?: any;
    rawBody?: string;
    signal?: AbortSignal;
  }): NextRequest {
    const headers = new Headers();
    if (options.bearerToken !== null && options.bearerToken !== undefined) {
      headers.set('Authorization', `Bearer ${options.bearerToken}`);
    }
    if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }
    headers.set('Content-Type', 'application/json');

    const bodyContent = options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
      ? JSON.stringify(options.body)
      : JSON.stringify({
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Halo dari klien' }],
        });

    return new NextRequest('http://localhost:3000/v1/chat/completions', {
      method: 'POST',
      headers,
      body: bodyContent,
      signal: options.signal,
    });
  }

  // =========================================================================
  // SUB-TASK 14.1 (TASK-053): Sukses & Penggunaan Token
  // =========================================================================
  describe('TASK-053: Respons Sukses & Penggunaan Token (TC-REQ5-RES-01..05)', () => {
    it('TC-REQ5-RES-01: Respons sukses standar (finish_reason: "stop") dengan token usage terukur', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Mock Gemini API successful response
      const mockGeminiRes = {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Halo dunia' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockGeminiRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
        body: {
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Halo' }],
          temperature: 0.7,
          max_tokens: 100,
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      expect(res.headers.get('x-request-id')).toBe(idempotencyKey);

      const data = await res.json();
      expect(data.object).toBe('chat.completion');
      expect(data.model).toBe(testModelAlias);
      expect(typeof data.id).toBe('string');
      expect(data.id.startsWith('chatcmpl-')).toBe(true);
      expect(typeof data.created).toBe('number');
      expect(data.choices).toHaveLength(1);
      expect(data.choices[0]).toEqual({
        index: 0,
        message: {
          role: 'assistant',
          content: 'Halo dunia',
        },
        finish_reason: 'stop',
      });
      expect(data.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });

      // Verify atomic terminal commit & concurrency lease release in Atlas
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision).toBeDefined();
      expect(decision?.status).toBe('succeeded');
      expect(decision?.outcome?.status).toBe('succeeded');
      expect(decision?.outcome?.originalHttpStatus).toBe(200);

      const activeLeases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .countDocuments({ decisionId: decision?._id });
      expect(activeLeases).toBe(0);
    });

    it('TC-REQ5-RES-02: Selesai batas panjang (finish_reason: "length" dari MAX_TOKENS)', async () => {
      const idempotencyKey = crypto.randomUUID();

      const mockGeminiRes = {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Respons terpotong' }],
            },
            finishReason: 'MAX_TOKENS',
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockGeminiRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.choices[0].finish_reason).toBe('length');
    });

    it('TC-REQ5-RES-03: Penggabungan multi-parts teks tanpa pemisah tambahan', async () => {
      const idempotencyKey = crypto.randomUUID();

      const mockGeminiRes = {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Halo ' }, { text: 'dunia!' }],
            },
            finishReason: 'STOP',
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockGeminiRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.choices[0].message.content).toBe('Halo dunia!');
    });

    it('TC-REQ5-RES-04: Multi-kandidat dari provider: hanya kandidat indeks 0 yang dipakai', async () => {
      const idempotencyKey = crypto.randomUUID();

      const mockGeminiRes = {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Kandidat pertama sah' }],
            },
            finishReason: 'STOP',
          },
          {
            index: 1,
            content: {
              role: 'model',
              parts: [{ text: 'Kandidat kedua harus dibuang' }],
            },
            finishReason: 'STOP',
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockGeminiRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.choices).toHaveLength(1);
      expect(data.choices[0].message.content).toBe('Kandidat pertama sah');
    });

    it('TC-REQ5-RES-05: Token usage tidak tersedia dari provider menghasilkan usage: null', async () => {
      const idempotencyKey = crypto.randomUUID();

      const mockGeminiRes = {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ text: 'Teks tanpa token metadata' }],
            },
            finishReason: 'STOP',
          },
        ],
        // usageMetadata omitted
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockGeminiRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.usage).toBeNull();
    });
  });

  // =========================================================================
  // SUB-TASK 14.1 (TASK-053): Seluruh Error Sebelum Respons (400, 401, 403, 404, 413)
  // =========================================================================
  describe('TASK-053: Penolakan Validasi & Otorisasi Sebelum Respons', () => {
    it('TC-REQ5-AUTH-01: Header Authorization hilang ditolak 401 invalid_api_key', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const req = buildRequest({
        bearerToken: null,
        idempotencyKey: crypto.randomUUID(),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_api_key');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('TC-REQ5-AUTH-02: Format auth bukan Bearer ditolak 401 invalid_api_key', async () => {
      const headers = new Headers();
      headers.set('Authorization', 'Basic dXNlcjpwYXNz');
      headers.set('Idempotency-Key', crypto.randomUUID());
      headers.set('Content-Type', 'application/json');

      const req = new NextRequest('http://localhost:3000/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Halo' }],
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_api_key');
    });

    it('TC-REQ5-AUTH-03: Key salah/tidak terdaftar ditolak 401 invalid_api_key', async () => {
      const req = buildRequest({
        bearerToken: `agw_${crypto.randomBytes(32).toString('hex')}`,
        idempotencyKey: crypto.randomUUID(),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_api_key');
    });

    it('TC-REQ5-AUTH-04: Key dicabut (revoked) ditolak 401 invalid_api_key', async () => {
      const db = await getDatabase();
      await db
        .collection(COLLECTIONS.API_KEYS)
        .updateOne({ _id: testApiKeyDoc._id }, { $set: { status: 'revoked' } });

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_api_key');
    });

    it('TC-REQ5-AUTH-07: Project nonaktif (disabled) ditolak 403 project_disabled', async () => {
      const db = await getDatabase();
      await db
        .collection(COLLECTIONS.PROJECTS)
        .updateOne({ _id: testProjectId }, { $set: { status: 'disabled' } });

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe('project_disabled');
    });

    it('TC-REQ5-AUTH-06: Model alias tidak terdaftar ditolak 404 model_not_found', async () => {
      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: 'gpt-4o-unknown',
          messages: [{ role: 'user', content: 'Halo' }],
        },
      });

      const res = await POST(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe('model_not_found');
    });

    it('TC-REQ5-AUTH-08: Model alias nonaktif ditolak 403 model_disabled', async () => {
      const db = await getDatabase();
      await db
        .collection(COLLECTIONS.MODEL_ALIASES)
        .updateOne({ _id: testAliasDoc._id }, { $set: { status: 'disabled' } });

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error.code).toBe('model_disabled');
    });

    it('TC-REQ5-IDEM-02 & 03: Header Idempotency-Key hilang atau non-UUID ditolak 400 invalid_request', async () => {
      // 1. Missing Idempotency-Key
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: null,
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(400);
      const data1 = await res1.json();
      expect(data1.error.code).toBe('invalid_request');
      expect(data1.error.param).toBe('Idempotency-Key');

      // 2. Non-UUID format
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: 'not-a-valid-uuid',
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(400);
      const data2 = await res2.json();
      expect(data2.error.code).toBe('invalid_request');
      expect(data2.error.param).toBe('Idempotency-Key');
    });

    it('TC-REQ5-BODY-02: Body > 1 MiB ditolak 413 payload_too_large', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      // 1 MiB + 1 byte
      const oversizedContent = 'a'.repeat(1024 * 1024 + 1);
      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        rawBody: JSON.stringify({
          model: testModelAlias,
          messages: [{ role: 'user', content: oversizedContent }],
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.error.code).toBe('payload_too_large');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('TC-REQ5-BODY-03: Body kosong 0-byte ditolak 400 invalid_request', async () => {
      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        rawBody: '',
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe('invalid_request');
    });

    it('TC-REQ5-MSG-LEN-01 & 04: Messages kosong atau > 64 item ditolak 400 invalid_request', async () => {
      // 0 messages
      const reqEmpty = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: { model: testModelAlias, messages: [] },
      });
      const resEmpty = await POST(reqEmpty);
      expect(resEmpty.status).toBe(400);
      expect((await resEmpty.json()).error.param).toBe('messages');

      // 65 messages
      const msgs65 = [];
      for (let i = 0; i < 65; i++) {
        msgs65.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Pesan ${i}` });
      }
      const req65 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: { model: testModelAlias, messages: msgs65 },
      });
      const res65 = await POST(req65);
      expect(res65.status).toBe(400);
      expect((await res65.json()).error.param).toBe('messages');
    });

    it('TC-REQ5-SEQ-04 & 05: Urutan peran tidak valid ditolak 400 invalid_request', async () => {
      // Starts with assistant
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: testModelAlias,
          messages: [
            { role: 'assistant', content: 'Halo' },
            { role: 'user', content: 'Hai' },
          ],
        },
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(400);
      expect((await res1.json()).error.param).toBe('messages[0].role');

      // Ends with assistant
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: testModelAlias,
          messages: [
            { role: 'user', content: 'Hai' },
            { role: 'assistant', content: 'Halo' },
          ],
        },
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(400);
      expect((await res2.json()).error.param).toBe('messages[1].role');
    });

    it('TC-REQ5-EXT-01..05: Field tidak didukung atau asing ditolak 400 unsupported_feature / invalid_request', async () => {
      // Top-level tools
      const reqTools = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Hai' }],
          tools: [{ type: 'function' }],
        },
      });
      const resTools = await POST(reqTools);
      expect(resTools.status).toBe(400);
      const dataTools = await resTools.json();
      expect(dataTools.error.code).toBe('unsupported_feature');
      expect(dataTools.error.param).toBe('tools');

      // stream: true in nonstream endpoint
      const reqStream = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Hai' }],
          stream: true,
        },
      });
      const resStream = await POST(reqStream);
      expect(resStream.status).toBe(400);
      expect((await resStream.json()).error.code).toBe('unsupported_feature');
    });
  });

  // =========================================================================
  // SUB-TASK 14.1 (TASK-053): Error Provider Mapping (502, 503) & Zero Secret Leak
  // =========================================================================
  describe('TASK-053: Error Provider & Upstream Mapping (TC-REQ5-ERR-01..07)', () => {
    it('TC-REQ5-ERR-01: Provider output blocked (safety/policy) menghasilkan 502 provider_output_blocked', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const mockBlockedRes = {
        candidates: [
          {
            index: 0,
            finishReason: 'SAFETY',
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockBlockedRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error.code).toBe('provider_output_blocked');
      expect(data.error.type).toBe('provider_error');
      expect(JSON.stringify(data)).not.toContain(geminiSecret);

      // Terminal status failed in Atlas & lease released
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalErrorCode).toBe('provider_output_blocked');

      const activeLeases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .countDocuments({ decisionId: decision?._id });
      expect(activeLeases).toBe(0);
    });

    it('TC-REQ5-ERR-02: Provider empty response menghasilkan 502 provider_empty_response', async () => {
      const idempotencyKey = crypto.randomUUID();

      const mockEmptyRes = {
        candidates: [],
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockEmptyRes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error.code).toBe('provider_empty_response');
    });

    it('TC-REQ5-ERR-05: Upstream HTTP 500 menghasilkan 502 provider_error tanpa bocor rahasia', async () => {
      const idempotencyKey = crypto.randomUUID();

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Internal Upstream Google Error with secret info AIzaSyFake', {
          status: 500,
        })
      );

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error.code).toBe('provider_error');
      expect(JSON.stringify(data)).not.toContain(geminiSecret);
    });

    it('TC-REQ5-ERR-07: Provider unreachable (network error) menghasilkan 503 provider_unavailable', async () => {
      const idempotencyKey = crypto.randomUUID();

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error.code).toBe('provider_unavailable');
    });
  });

  // =========================================================================
  // SUB-TASK 14.1 (TASK-053): Retry Terminal & Idempotensi
  // =========================================================================
  describe('TASK-053: Retry Terminal & Idempotensi (TC-REQ6-IDM-01..05)', () => {
    it('TC-REQ6-IDM-01: Idempotency conflict dengan payload berbeda menghasilkan 409 idempotency_conflict', async () => {
      const idempotencyKey = crypto.randomUUID();
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'Response payload A' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      // Request 1 with payload A
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
        body: {
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Payload A' }],
        },
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);

      // Request 2 with same key but different payload B
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
        body: {
          model: testModelAlias,
          messages: [{ role: 'user', content: 'Payload B yang berbeda' }],
        },
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(409);
      const data2 = await res2.json();
      expect(data2.error.code).toBe('idempotency_conflict');
      expect(data2.error.message).toBe('Idempotency key already used with different payload.');
    });

    it('TC-REQ6-IDM-04: Request konkuren yang sedang berlangsung menghasilkan 409 request_in_progress', async () => {
      const idempotencyKey = crypto.randomUUID();

      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });

      globalThis.fetch = vi.fn().mockImplementation(() => fetchPromise);

      // Request 1 starts but hangs in provider fetch
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const p1 = POST(req1);

      // Wait a tick for req1 to acquire admission and enter execution
      await new Promise((r) => setTimeout(r, 60));

      // Request 2 with identical key and identical payload arrives concurrently
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(409);
      const data2 = await res2.json();
      expect(data2.error.code).toBe('request_in_progress');
      expect(data2.error.message).toBe('Request is currently in progress.');

      // Complete Request 1
      resolveFetch(
        new Response(
          JSON.stringify({
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'Sukses req 1' }] },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res1 = await p1;
      expect(res1.status).toBe(200);
    });

    it('TC-REQ6-IDM-02: Retry setelah sukses mengembalikan 409 request_already_processed dengan outcome tanpa panggil ulang provider', async () => {
      const idempotencyKey = crypto.randomUUID();
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'Sukses pertama' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      globalThis.fetch = fetchSpy;

      // First call (successful)
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Retry with identical key and payload
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(409);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // Provider NOT called again!

      const data2 = await res2.json();
      expect(data2.error.code).toBe('request_already_processed');
      expect(data2.outcome).toBeDefined();
      expect(data2.outcome.status).toBe('succeeded');
      expect(data2.outcome.original_http_status).toBe(200);
      expect(data2.outcome.original_error_code).toBeNull();
      expect(typeof data2.outcome.completed_at).toBe('number');
    });

    it('TC-REQ6-IDM-03: Retry setelah gagal mengembalikan 409 request_already_processed dengan status terminal failed', async () => {
      const idempotencyKey = crypto.randomUUID();

      // Mock first call failing with 502 safety block
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ index: 0, finishReason: 'SAFETY' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(502);

      // Retry with same UUID
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(409);
      const data2 = await res2.json();
      expect(data2.error.code).toBe('request_already_processed');
      expect(data2.outcome.status).toBe('failed');
      expect(data2.outcome.original_http_status).toBe(502);
      expect(data2.outcome.original_error_code).toBe('provider_output_blocked');
    });

    it('TC-REQ6-IDM-10: Isolasi API Key: UUID sama pada Key B di project yang sama diproses secara independen', async () => {
      const db = await getDatabase();
      const sharedRequestId = crypto.randomUUID();

      // Create a second API key for the same project
      const keyResult2 = await createApiKey(db, testProjectId, {
        name: 'Second Test API Key',
      });
      const bearerKey2 = keyResult2.secret;

      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                { index: 0, content: { role: 'model', parts: [{ text: 'Response from Key' }] }, finishReason: 'STOP' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      );

      // Request from Key 1
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: sharedRequestId,
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);

      // Request from Key 2 with identical UUID
      const req2 = buildRequest({
        bearerToken: bearerKey2,
        idempotencyKey: sharedRequestId,
      });
      const res2 = await POST(req2);
      // Independent fresh admission, NOT a 409 conflict or cached outcome from Key 1!
      expect(res2.status).toBe(200);
    });

    it('TC-REQ6-RPM-03 & TC-REQ6-IDM-04A: Rate limit exceeded ditolak 429 dan retry menyertakan outcome rejected', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Set project rpmLimit to 1
      await db
        .collection(COLLECTIONS.PROJECTS)
        .updateOne({ _id: testProjectId }, { $set: { rpmLimit: 1 } });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              { index: 0, content: { role: 'model', parts: [{ text: 'First call ok' }] }, finishReason: 'STOP' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      // Request 1: consumes the 1 RPM quota
      const req1 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);

      // Request 2: rejected 429 rate_limit_exceeded
      const req2 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(429);
      expect(res2.headers.get('Retry-After')).toBeDefined();
      const data2 = await res2.json();
      expect(data2.error.code).toBe('rate_limit_exceeded');

      // Request 3: Retry same rejected UUID -> 429 with outcome
      const req3 = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });
      const res3 = await POST(req3);
      expect(res3.status).toBe(429);
      const data3 = await res3.json();
      expect(data3.error.code).toBe('rate_limit_exceeded');
      expect(data3.outcome).toBeDefined();
      expect(data3.outcome.status).toBe('rejected');
      expect(data3.outcome.original_http_status).toBe(429);
      expect(data3.outcome.original_error_code).toBe('rate_limit_exceeded');
    });

    it('TC-REQ6-CNC-02: Concurrency limit exceeded ditolak 429 concurrency_limit_exceeded dengan Retry-After: 1', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Set project concurrencyLimit to 1
      await db
        .collection(COLLECTIONS.PROJECTS)
        .updateOne({ _id: testProjectId }, { $set: { concurrencyLimit: 1 } });

      // Simulate an active held lease for another request
      const activeDecisionId = new ObjectId();
      await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne({
        _id: activeDecisionId,
        projectId: testProjectId,
        apiKeyId: testApiKeyDoc._id!,
        requestId: crypto.randomUUID(),
        payloadFingerprint: 'dummy-fingerprint',
        status: 'running',
        dispatchStatus: 'dispatching',
        createdAt: new Date(),
        dedupeUntil: new Date(Date.now() + 86400000),
      });

      await db.collection(COLLECTIONS.CONCURRENCY_LEASES).insertOne({
        leaseId: 'held-lease-001',
        projectId: testProjectId,
        decisionId: activeDecisionId,
        expiresAt: new Date(Date.now() + 45000),
        createdAt: new Date(),
      });

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('1');
      const data = await res.json();
      expect(data.error.code).toBe('concurrency_limit_exceeded');
    });
  });

  // =========================================================================
  // SUB-TASK 14.1 (TASK-053): Timeout 120 Detik (TC-REQ5-ERR-06)
  // =========================================================================
  describe('TASK-053: Timeout Upstream 120 Detik (TC-REQ5-ERR-06)', () => {
    it('TC-REQ5-ERR-06: Eksekusi provider melampaui timeout membatalkan upstream via AbortSignal dan menghasilkan 504 gateway_timeout', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Configure fast timeout for test determinism
      process.env.GATEWAY_NONSTREAM_TIMEOUT_MS = '150';

      // Mock fetch that hangs or observes abort
      let signalAborted = false;
      globalThis.fetch = vi.fn().mockImplementation((_url: any, init?: any) => {
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            signalAborted = true;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
          // Do not resolve normally
        });
      });

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(504);
      expect(signalAborted).toBe(true);

      const data = await res.json();
      expect(data.error.code).toBe('gateway_timeout');
      expect(data.error.message).toBe('Gateway timed out waiting for provider.');

      // Terminal status failed in Atlas & lease released
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalErrorCode).toBe('gateway_timeout');
      expect(decision?.outcome?.originalHttpStatus).toBe(504);

      const activeLeases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .countDocuments({ decisionId: decision?._id });
      expect(activeLeases).toBe(0);
    });

    it('TC-REQ7-CLT-01: Pembatalan klien saat provider in-flight mengembalikan 499 client_closed_request dan mencatat terminal failed', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const clientAbortCtrl = new AbortController();
      let fetchAborted = false;
      let fetchStarted!: () => void;
      const fetchStartedPromise = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });

      globalThis.fetch = vi.fn().mockImplementation((_url: any, init?: any) => {
        fetchStarted();
        return new Promise((resolve, reject) => {
          if (init?.signal?.aborted) {
            fetchAborted = true;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            return reject(err);
          }
          init?.signal?.addEventListener('abort', () => {
            fetchAborted = true;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
        signal: clientAbortCtrl.signal,
      });

      const postPromise = POST(req);

      // Wait until provider call is definitely in-flight, then abort from client
      await fetchStartedPromise;
      clientAbortCtrl.abort();

      const res = await postPromise;
      expect(res.status).toBe(499);
      expect(fetchAborted).toBe(true);

      const data = await res.json();
      expect(data.error.code).toBe('client_closed_request');
      expect(data.error.message).toBe('Request was aborted');

      // Terminal status failed in Atlas
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalErrorCode).toBe('client_closed_request');
      expect(decision?.outcome?.originalHttpStatus).toBe(499);

      // Concurrency lease released
      const activeLeases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .countDocuments({ decisionId: decision?._id });
      expect(activeLeases).toBe(0);
    });
  });

  // =========================================================================
  // SUB-TASK 14.3 (TASK-055): Kegagalan Dekripsi Pasca-Admission Tetap Memakai Kuota
  // =========================================================================
  describe('TASK-055: Kegagalan Dekripsi Pasca-Admission (Requirement 3.6)', () => {
    it('kegagalan dekripsi setelah admission tetap memakai kuota rate yang sudah commit dan tidak memanggil provider', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      // Corrupt the ciphertext of the bound credential in Atlas so decryption fails
      await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).updateOne(
        { _id: testCredentialDoc._id },
        {
          $set: {
            'encryptedCredentials.ciphertext': 'corrupted-invalid-hex-ciphertext-tag',
            'encryptedCredentials.authTag': 'corrupted-tag',
          },
        }
      );

      // Verify initial rate counter is 0
      const initialCounters = await db
        .collection<RateCounterDocument>(COLLECTIONS.RATE_COUNTERS)
        .find({ projectId: testProjectId })
        .toArray();
      const initialCount = initialCounters.reduce((acc, c) => acc + c.count, 0);
      expect(initialCount).toBe(0);

      const req = buildRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      // Call route handler
      const res = await POST(req);
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error.code).toBe('provider_unavailable');
      expect(data.error.message).toContain('Provider credential decryption failed');

      // 1. Upstream provider was NEVER called!
      expect(fetchSpy).not.toHaveBeenCalled();

      // 2. Rate quota remains committed and consumed!
      const finalCounters = await db
        .collection<RateCounterDocument>(COLLECTIONS.RATE_COUNTERS)
        .find({ projectId: testProjectId })
        .toArray();
      const finalCount = finalCounters.reduce((acc, c) => acc + c.count, 0);
      expect(finalCount).toBeGreaterThanOrEqual(1);

      // 3. Admission decision is recorded as terminal failed
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision).toBeDefined();
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.status).toBe('failed');
      expect(decision?.outcome?.originalHttpStatus).toBe(503);
      expect(decision?.outcome?.originalErrorCode).toBe('provider_unavailable');

      // 4. Concurrency lease was released
      const activeLeases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .countDocuments({ decisionId: decision?._id });
      expect(activeLeases).toBe(0);
    });
  });
});
