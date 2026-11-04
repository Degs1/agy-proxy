import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
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
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createApiKey } from '@/lib/api-keys/service';
import { createCredential } from '@/lib/credentials/service';
import { encryptCredential } from '@/lib/crypto/credential-encryption';
import { reconcileExpiredLeases } from '@/lib/limiter';
import { POST } from '@/app/v1/chat/completions/route';

describe('TASK-056: Server-Sent Events (SSE) Streaming POST /v1/chat/completions', () => {
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
    process.env.MONGODB_DB_NAME = 'test_gateway_sse_stream';
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
    delete process.env.GATEWAY_STREAM_TIMEOUT_MS;
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
      name: 'SSE Stream Gateway Test Project',
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
      name: 'Stream Test API Key',
    });
    testApiKeyDoc = keyResult.apiKey;
    testBearerKey = keyResult.secret;

    // Create Provider Credential
    testCredentialDoc = await createCredential(db, testProjectId, {
      provider: 'gemini',
      credentialType: 'api_key',
      status: 'active',
      secret: geminiSecret,
      displayName: 'Default Test Gemini Credential',
    });

    // Create Active Model Alias
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

  function buildStreamRequest(options: {
    bearerToken?: string | null;
    idempotencyKey?: string | null;
    body?: any;
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

    const bodyContent =
      options.body !== undefined
        ? JSON.stringify(options.body)
        : JSON.stringify({
            model: testModelAlias,
            messages: [{ role: 'user', content: 'Halo dari klien SSE' }],
            stream: true,
          });

    return new NextRequest('http://localhost:3000/v1/chat/completions', {
      method: 'POST',
      headers,
      body: bodyContent,
      signal: options.signal,
    });
  }

  function createMockGeminiStreamResponse(
    events: Array<string | object>,
    options?: {
      delayMs?: number;
      signal?: AbortSignal;
      onAbort?: () => void;
    }
  ): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            options.onAbort?.();
            try {
              controller.error(new Error('Aborted'));
            } catch {}
          });
        }

        for (const ev of events) {
          if (options?.delayMs) {
            await new Promise((r) => setTimeout(r, options.delayMs));
          }
          if (options?.signal?.aborted) {
            options.onAbort?.();
            try {
              controller.error(new Error('Aborted'));
            } catch {}
            return;
          }
          const text = typeof ev === 'string' ? ev : `data: ${JSON.stringify(ev)}\n\n`;
          controller.enqueue(encoder.encode(text));
        }
        controller.close();
      },
      cancel() {
        options?.onAbort?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
      },
    });
  }

  async function parseSseStream(response: Response | NextResponse): Promise<{
    chunks: any[];
    errorEvent: any | null;
    doneCount: number;
    rawText: string;
  }> {
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let rawText = '';
    const chunks: any[] = [];
    let errorEvent: any | null = null;
    let doneCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawText += decoder.decode(value, { stream: true });
    }

    const lines = rawText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') {
        doneCount++;
      } else {
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.error) {
            errorEvent = parsed.error;
          } else {
            chunks.push(parsed);
          }
        } catch {}
      }
    }

    return { chunks, errorEvent, doneCount, rawText };
  }

  // =========================================================================
  // SUB-TASK 15.1 (TASK-057): Urutan Chunk, Header Delay, Error & Timeout
  // =========================================================================
  describe('TASK-057: Urutan Chunk, Delay Header, Error & Timeout (Requirement 7)', () => {
    it('TC-STREAM-SEQ-01: Respons SSE sukses standar (finish_reason: "stop") dengan ID konsisten dan tepat 1 [DONE]', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const geminiEvents = [
        {
          candidates: [
            {
              index: 0,
              content: { role: 'model', parts: [{ text: 'Halo ' }] },
            },
          ],
        },
        {
          candidates: [
            {
              index: 0,
              content: { role: 'model', parts: [{ text: 'dunia!' }] },
            },
          ],
        },
        {
          candidates: [
            {
              index: 0,
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 6,
            totalTokenCount: 18,
          },
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(geminiEvents));

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('connection')).toBe('keep-alive');
      expect(res.headers.get('x-request-id')).toBe(idempotencyKey);

      const parsed = await parseSseStream(res);
      expect(parsed.doneCount).toBe(1);
      expect(parsed.errorEvent).toBeNull();
      expect(parsed.chunks.length).toBe(4);

      // Verify ID and created timestamp are consistent across all chunks
      const firstId = parsed.chunks[0].id;
      const firstCreated = parsed.chunks[0].created;
      expect(firstId).toMatch(/^chatcmpl-/);
      expect(typeof firstCreated).toBe('number');

      for (const ch of parsed.chunks) {
        expect(ch.id).toBe(firstId);
        expect(ch.created).toBe(firstCreated);
        expect(ch.model).toBe(testModelAlias);
        expect(ch.object).toBe('chat.completion.chunk');
      }

      // Chunk 0: Role assistant
      expect(parsed.chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
      expect(parsed.chunks[0].choices[0].finish_reason).toBeNull();

      // Chunk 1: Content 'Halo '
      expect(parsed.chunks[1].choices[0].delta).toEqual({ content: 'Halo ' });
      expect(parsed.chunks[1].choices[0].finish_reason).toBeNull();

      // Chunk 2: Content 'dunia!'
      expect(parsed.chunks[2].choices[0].delta).toEqual({ content: 'dunia!' });
      expect(parsed.chunks[2].choices[0].finish_reason).toBeNull();

      // Chunk 3: Final chunk with finish_reason 'stop' and usage
      expect(parsed.chunks[3].choices[0].delta).toEqual({});
      expect(parsed.chunks[3].choices[0].finish_reason).toBe('stop');
      expect(parsed.chunks[3].usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      });

      // Verify Atlas state: succeeded and lease deleted
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision).toBeDefined();
      expect(decision?.status).toBe('succeeded');
      expect(decision?.outcome?.status).toBe('succeeded');
      expect(decision?.outcome?.originalHttpStatus).toBe(200);

      const leases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: decision?._id })
        .toArray();
      expect(leases.length).toBe(0);
    });

    it('TC-STREAM-SEQ-02: Selesai batas panjang (finish_reason: "length" dari MAX_TOKENS)', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const geminiEvents = [
        {
          candidates: [
            {
              index: 0,
              content: { role: 'model', parts: [{ text: 'Teks panjang...' }] },
            },
          ],
        },
        {
          candidates: [
            {
              index: 0,
              finishReason: 'MAX_TOKENS',
            },
          ],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(geminiEvents));

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      const parsed = await parseSseStream(res);
      expect(parsed.doneCount).toBe(1);

      const finalChunk = parsed.chunks[parsed.chunks.length - 1];
      expect(finalChunk.choices[0].finish_reason).toBe('length');

      // Atlas state succeeded
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('succeeded');
    });

    it('TC-STREAM-CHUNK-01: Teks disalurkan secara progresif sebelum generasi selesai', async () => {
      const idempotencyKey = crypto.randomUUID();

      // Simulate provider with 40ms interval between chunks
      const geminiEvents = [
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Bagian 1 ' }] } }],
        },
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Bagian 2 ' }] } }],
        },
        {
          candidates: [{ index: 0, finishReason: 'STOP' }],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockGeminiStreamResponse(geminiEvents, { delayMs: 40 })
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read first emitted chunk
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);
      const firstText = decoder.decode(firstRead.value);
      expect(firstText).toContain('Bagian 1');
      // Bagian 2 must not be in the first read
      expect(firstText).not.toContain('Bagian 2');

      // Now read second chunk
      const secondRead = await reader.read();
      expect(secondRead.done).toBe(false);
      const secondText = decoder.decode(secondRead.value);
      expect(secondText).toContain('Bagian 2');

      reader.releaseLock();
    });

    it('TC-STREAM-ERR-PRE-01: Provider Error SEBELUM header menghasilkan HTTP 502 JSON (tanpa header SSE)', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Provider fails with HTTP 500 before returning stream
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Upstream internal error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        })
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);

      // Verify HTTP JSON error before stream started
      expect(res.status).toBe(502);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('content-type')).not.toContain('text/event-stream');

      const body = await res.json();
      expect(body.error).toEqual({
        message: 'Provider failed to process request.',
        type: 'provider_error',
        param: null,
        code: 'provider_error',
      });

      // Verify Atlas decision committed as failed and lease released
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalHttpStatus).toBe(502);
      expect(decision?.outcome?.originalErrorCode).toBe('provider_error');

      const leases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: decision?._id })
        .toArray();
      expect(leases.length).toBe(0);
    });

    it('TC-STREAM-ERR-PRE-02: Safety Block SEBELUM header menghasilkan HTTP 502 provider_output_blocked JSON', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const blockedEvents = [
        {
          promptFeedback: {
            blockReason: 'SAFETY',
          },
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(blockedEvents));

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(502);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json();
      expect(body.error.code).toBe('provider_output_blocked');
      expect(body.error.message).toBe('Provider output blocked due to safety or policy.');

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalErrorCode).toBe('provider_output_blocked');
    });

    it('TC-STREAM-ERR-PRE-03: Empty Response SEBELUM header menghasilkan HTTP 502 provider_empty_response JSON', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Stream with no candidates or empty text
      const emptyEvents = [
        {
          candidates: [],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(emptyEvents));

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(502);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json();
      expect(body.error.code).toBe('provider_empty_response');

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
    });

    it('TC-STREAM-ERR-PRE-04: Timeout SEBELUM header menghasilkan HTTP 504 gateway_timeout JSON', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();
      process.env.GATEWAY_STREAM_TIMEOUT_MS = '60'; // 60ms fast timeout

      // Provider hangs indefinitely before producing any text
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(createMockGeminiStreamResponse([]));
            }, 500);
          })
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(504);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json();
      expect(body.error.code).toBe('gateway_timeout');
      expect(body.error.message).toBe('Gateway timed out waiting for provider.');

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalHttpStatus).toBe(504);
      expect(decision?.outcome?.originalErrorCode).toBe('gateway_timeout');
    });

    it('TC-STREAM-ERR-POST-01: Provider Error SESUDAH header menghasilkan event SSE error + tepat 1 [DONE]', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      // Provider sends first text chunk, then aborts/fails abruptly
      const encoder = new TextEncoder();
      let pulled = 0;
      const failingStream = new ReadableStream({
        pull(controller) {
          pulled++;
          if (pulled === 1) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Halo awal' }] } }],
                })}\n\n`
              )
            );
          } else {
            controller.error(new Error('Connection unexpectedly reset by upstream'));
          }
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(failingStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const parsed = await parseSseStream(res);
      expect(parsed.errorEvent).toBeDefined();
      expect(parsed.errorEvent.code).toBe('provider_unavailable');
      expect(parsed.doneCount).toBe(1);

      // Verify no success final chunk
      const hasFinalSuccessChunk = parsed.chunks.some((c) => c.choices[0]?.finish_reason === 'stop');
      expect(hasFinalSuccessChunk).toBe(false);

      // Atlas state must be failed
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.status).toBe('failed');

      const leases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: decision?._id })
        .toArray();
      expect(leases.length).toBe(0);
    });

    it('TC-STREAM-ERR-POST-02: Safety Block SESUDAH header menghasilkan event provider_output_blocked + [DONE]', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const events = [
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Awal ' }] } }],
        },
        {
          candidates: [{ index: 0, finishReason: 'SAFETY' }],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(events));

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      const parsed = await parseSseStream(res);
      expect(parsed.errorEvent).toBeDefined();
      expect(parsed.errorEvent.code).toBe('provider_output_blocked');
      expect(parsed.doneCount).toBe(1);

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalErrorCode).toBe('provider_output_blocked');
    });

    it('TC-STREAM-ABORT-01: Pembatalan klien membatalkan upstream dan mencatat status cancelled (499)', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();
      const clientAbortCtrl = new AbortController();
      let upstreamAborted = false;

      const events = [
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Chunk 1' }] } }],
        },
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Chunk 2' }] } }],
        },
      ];

      globalThis.fetch = vi.fn().mockImplementation((_url, init) =>
        Promise.resolve(
          createMockGeminiStreamResponse(events, {
            delayMs: 150,
            signal: init?.signal,
            onAbort: () => {
              upstreamAborted = true;
            },
          })
        )
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
        signal: clientAbortCtrl.signal,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read chunk 1
      const read1 = await reader.read();
      expect(read1.done).toBe(false);
      expect(decoder.decode(read1.value)).toContain('Chunk 1');

      // Abort client connection
      clientAbortCtrl.abort();

      // Reader cancel
      await reader.cancel();

      // Allow async abort cleanup to finalize
      await new Promise((r) => setTimeout(r, 80));

      expect(upstreamAborted).toBe(true);

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('cancelled');
      expect(decision?.outcome?.status).toBe('cancelled');
      expect(decision?.outcome?.originalHttpStatus).toBe(499);
      expect(decision?.outcome?.originalErrorCode).toBe('client_closed_request');

      const leases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: decision?._id })
        .toArray();
      expect(leases.length).toBe(0);
    });

    it('TC-STREAM-TO-01: Timeout aplikasi 600 detik membatalkan upstream dan mengirim event gateway_timeout + [DONE]', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();
      process.env.GATEWAY_STREAM_TIMEOUT_MS = '70'; // 70ms fast test timeout

      let upstreamAborted = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Send first chunk
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Teks sebelum timeout' }] } }],
              })}\n\n`
            )
          );
          // Provider then stalls indefinitely
        },
        cancel() {
          upstreamAborted = true;
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      const parsed = await parseSseStream(res);
      expect(parsed.errorEvent).toBeDefined();
      expect(parsed.errorEvent.code).toBe('gateway_timeout');
      expect(parsed.errorEvent.message).toBe('Gateway timed out waiting for provider.');
      expect(parsed.doneCount).toBe(1);

      // Verify no success final chunk or [DONE] duplication
      const hasFinalSuccessChunk = parsed.chunks.some((c) => c.choices[0]?.finish_reason !== null);
      expect(hasFinalSuccessChunk).toBe(false);

      // Verify terminal decision committed as failed with 504
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('failed');
      expect(decision?.outcome?.originalHttpStatus).toBe(504);
      expect(decision?.outcome?.originalErrorCode).toBe('gateway_timeout');

      // Verify lease is released
      const leases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: decision?._id })
        .toArray();
      expect(leases.length).toBe(0);
    });
  });

  // =========================================================================
  // SUB-TASK 15.3 (TASK-059): Commit Terminal Sebelum Chunk Akhir, [DONE] & Dua Proses
  // =========================================================================
  describe('TASK-059: Keputusan Terminal Atomik, Single [DONE], dan Pemulihan Dua Proses', () => {
    it('TC-STREAM-TERM-01: Commit terminal succeeded terkonfirmasi di Atlas SEBELUM chunk akhir dan [DONE] tiba di klien', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const geminiEvents = [
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Halo' }] } }],
        },
        {
          candidates: [{ index: 0, finishReason: 'STOP' }],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(geminiEvents));

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let raw = '';
      let verifiedDatabaseStatusBeforeDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });

        // When final chunk or [DONE] appears in the client buffer, check Atlas immediately
        if (raw.includes('"finish_reason":"stop"') || raw.includes('data: [DONE]')) {
          const doc = await db
            .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
            .findOne({ requestId: idempotencyKey });
          if (doc?.status === 'succeeded') {
            verifiedDatabaseStatusBeforeDone = true;
          }
        }
      }

      expect(verifiedDatabaseStatusBeforeDone).toBe(true);

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('succeeded');
    });

    it('TC-STREAM-LATE-01: Pembuangan keluaran upstream yang terlambat (Late output discarded)', async () => {
      const db = await getDatabase();
      const idempotencyKey = crypto.randomUUID();

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // 1. Initial text chunk
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Teks sah' }] } }],
              })}\n\n`
            )
          );
          // 2. Normal completion
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ index: 0, finishReason: 'STOP' }],
              })}\n\n`
            )
          );
          // 3. Late rogue chunks after stream completion
          setTimeout(() => {
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'TEKS TERLAMBAT HARUS DIBUANG' }] } }],
                  })}\n\n`
                )
              );
              controller.close();
            } catch {}
          }, 40);
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const req = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey,
      });

      const res = await POST(req);
      const parsed = await parseSseStream(res);

      expect(parsed.rawText).not.toContain('TEKS TERLAMBAT HARUS DIBUANG');
      expect(parsed.doneCount).toBe(1);

      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: idempotencyKey });
      expect(decision?.status).toBe('succeeded');
    });

    it('TC-STREAM-PROC-01: Uji dua proses: pemilik stream mati tanpa request lanjutan, pemulih menandai lease_expired, proses 2 dapat slot', async () => {
      const db = await getDatabase();

      // Configure concurrency limit = 1 on Project
      await db.collection(COLLECTIONS.PROJECTS).updateOne(
        { _id: testProjectId },
        { $set: { concurrencyLimit: 1 } }
      );

      const process1Key = crypto.randomUUID();
      const process2Key = crypto.randomUUID();

      // Process 1: Starts a stream that stays open
      let process1Controller: ReadableStreamDefaultController<Uint8Array>;
      const p1Stream = new ReadableStream({
        start(controller) {
          process1Controller = controller;
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Halo P1' }] } }],
              })}\n\n`
            )
          );
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(p1Stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const reqP1 = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey: process1Key,
      });

      const resP1 = await POST(reqP1);
      expect(resP1.status).toBe(200);

      // Verify Process 1 holds the 1 active concurrency slot
      const p1Decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: process1Key });
      expect(p1Decision?.status).toBe('running');

      const p1Leases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: p1Decision?._id })
        .toArray();
      expect(p1Leases.length).toBe(1);

      // Process 2: Attempts request while Process 1 is holding the slot -> Rejected 429
      const reqP2Initial = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey: process2Key,
      });

      const resP2Initial = await POST(reqP2Initial);
      expect(resP2Initial.status).toBe(429);
      const rejBody = await resP2Initial.json();
      expect(rejBody.error.code).toBe('concurrency_limit_exceeded');

      // Process 1 owner stops / crashes without finalizing (e.g. process terminated)
      // We manually expire Process 1's lease in MongoDB to simulate 45s passage
      const pastTime = new Date(Date.now() - 50_000);
      await db.collection(COLLECTIONS.CONCURRENCY_LEASES).updateOne(
        { leaseId: p1Leases[0].leaseId },
        { $set: { expiresAt: pastTime } }
      );

      // Recovery worker sweeps expired leases
      const reconciled = await reconcileExpiredLeases(db, testProjectId);
      expect(reconciled).toBe(1);

      // Verify Process 1 is now lease_expired
      const p1DecisionReconciled = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ requestId: process1Key });
      expect(p1DecisionReconciled?.status).toBe('lease_expired');
      expect(p1DecisionReconciled?.outcome?.status).toBe('lease_expired');

      // Process 2 attempts again: now slot is freed, Process 2 succeeds!
      const p2Events = [
        {
          candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Halo dari P2' }] } }],
        },
        {
          candidates: [{ index: 0, finishReason: 'STOP' }],
        },
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(createMockGeminiStreamResponse(p2Events));

      const process2RetryKey = crypto.randomUUID();
      const reqP2Second = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey: process2RetryKey,
      });
      const resP2Second = await POST(reqP2Second);
      expect(resP2Second.status).toBe(200);
      const parsedP2 = await parseSseStream(resP2Second);
      expect(parsedP2.doneCount).toBe(1);
      expect(parsedP2.rawText).toContain('Halo dari P2');

      // Process 1 retry now returns 409 request_already_processed with outcome lease_expired
      const reqP1Retry = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey: process1Key,
      });
      const resP1Retry = await POST(reqP1Retry);
      expect(resP1Retry.status).toBe(409);
      const retryBody = await resP1Retry.json();
      expect(retryBody.error.code).toBe('request_already_processed');
      expect(retryBody.outcome.status).toBe('lease_expired');
      expect(retryBody.outcome.originalErrorCode).toBe('lease_expired');
    });

    it('TC-STREAM-PREAUTH-01: Pre-admission check menolak model nonaktif (403) atau tidak ada (404) untuk stream: true', async () => {
      // 1. Missing alias -> 404 model_not_found
      const reqMissing = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: 'nonexistent-model',
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        },
      });

      const resMissing = await POST(reqMissing);
      expect(resMissing.status).toBe(404);
      const missingJson = await resMissing.json();
      expect(missingJson.error.code).toBe('model_not_found');

      // 2. Disabled alias -> 403 model_disabled
      const db = await getDatabase();
      await db.collection(COLLECTIONS.MODEL_ALIASES).updateOne(
        { _id: testAliasDoc._id },
        { $set: { status: 'disabled' } }
      );

      const reqDisabled = buildStreamRequest({
        bearerToken: testBearerKey,
        idempotencyKey: crypto.randomUUID(),
        body: {
          model: testModelAlias,
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        },
      });

      const resDisabled = await POST(reqDisabled);
      expect(resDisabled.status).toBe(403);
      const disabledJson = await resDisabled.json();
      expect(disabledJson.error.code).toBe('model_disabled');
    });
  });
});
