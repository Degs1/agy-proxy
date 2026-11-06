import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import {
  COLLECTIONS,
  ProjectDocument,
  ApiKeyDocument,
  ModelAliasDocument,
  ProviderCredentialDocument,
  AdmissionDecisionDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  requestAdmission,
  acquireDispatchPermission,
  finalizeAdmissionDecision,
  reconcileExpiredLeases,
  dispatchWithAdmission,
  claimAdmissionIntent,
} from '@/lib/limiter';

describe('TASK-047: Uji Retry, Idempotensi, dan Isolasi Izin Dispatch', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;

  let testProjectId: ObjectId;
  let testApiKeyId1: ObjectId;
  let testApiKeyId2: ObjectId;
  let testCredentialId: ObjectId;
  const testModelAlias = 'gemini-default';

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_task047';
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
    process.env = originalEnv;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    const db = await getDatabase();
    await initDatabaseIndexes(db);

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

    testProjectId = new ObjectId();
    testApiKeyId1 = new ObjectId();
    testApiKeyId2 = new ObjectId();
    testCredentialId = new ObjectId();

    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Task 047 Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: [testModelAlias],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId1,
      projectId: testProjectId,
      name: 'Key 1',
      keyPrefix: 'agw_47_1',
      keyHash: 'hash-test-047-1',
      status: 'active',
      createdAt: new Date(),
    });

    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId2,
      projectId: testProjectId,
      name: 'Key 2',
      keyPrefix: 'agw_47_2',
      keyHash: 'hash-test-047-2',
      status: 'active',
      createdAt: new Date(),
    });

    await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).insertOne({
      _id: testCredentialId,
      projectId: testProjectId,
      provider: 'gemini',
      displayName: 'Test Gemini 047',
      credentialType: 'api_key',
      encryptedCredentials: {
        ciphertext: 'mock',
        iv: 'mock',
        authTag: 'mock',
        keyVersion: 1,
      },
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      projectId: testProjectId,
      alias: testModelAlias,
      upstreamModel: 'gemini-1.5-flash',
      boundCredentialId: testCredentialId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('1. Retry dengan Key, UUID, dan Sidik yang sama: mengembalikan outcome lama tanpa panggilan provider baru', async () => {
    const db = await getDatabase();
    const requestId = 'req-retry-identical-001';
    const payloadFingerprint = 'fp-identical-123';

    let providerCalls = 0;
    const providerFn = async () => {
      providerCalls++;
      return { text: 'Hello from model' };
    };

    // First request: succeeds
    const res1 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint,
        modelAlias: testModelAlias,
      },
      providerFn
    );

    expect(res1.success).toBe(true);
    expect(providerCalls).toBe(1);

    // Second request: retry with identical Key, UUID, and payload fingerprint
    const res2 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint,
        modelAlias: testModelAlias,
      },
      providerFn
    );

    // Admission rejected as terminal retry with outcome
    expect(res2.success).toBe(false);
    if (!res2.success && 'admissionResult' in res2) {
      expect(res2.admissionResult.admitted).toBe(false);
      expect((res2.admissionResult as any).isTerminalRetry).toBe(true);
      expect((res2.admissionResult as any).outcome?.status).toBe('succeeded');
    }

    // Provider was NOT called again (exactly 1 call total)
    expect(providerCalls).toBe(1);
  });

  it('2. Retry dengan UUID sama tetapi sidik payload berbeda: ditolak 409 idempotency_conflict', async () => {
    const db = await getDatabase();
    const requestId = 'req-conflict-diff-fp';

    let providerCalls = 0;
    const providerFn = async () => {
      providerCalls++;
      return { text: 'Hello' };
    };

    // First request with fp-alpha
    await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-alpha',
        modelAlias: testModelAlias,
      },
      providerFn
    );
    expect(providerCalls).toBe(1);

    // Second request with SAME UUID but DIFFERENT payload fp-beta
    const res2 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-beta',
        modelAlias: testModelAlias,
      },
      providerFn
    );

    expect(res2.success).toBe(false);
    if (!res2.success && 'admissionResult' in res2) {
      expect(res2.admissionResult.admitted).toBe(false);
      expect((res2.admissionResult as any).conflict).toBe(true);
      expect((res2.admissionResult as any).httpStatus).toBe(409);
      expect((res2.admissionResult as any).errorCode).toBe('idempotency_conflict');
    }

    // Provider call count remains 1
    expect(providerCalls).toBe(1);
  });

  it('3. Key berbeda untuk RequestId sama: terisolasi per apiKeyId secara unik', async () => {
    const db = await getDatabase();
    const sharedRequestId = 'req-shared-uuid-across-keys';

    let providerCalls = 0;
    const providerFn = async () => {
      providerCalls++;
      return { ok: true };
    };

    // Key 1
    const res1 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId: sharedRequestId,
        payloadFingerprint: 'fp-key1',
        modelAlias: testModelAlias,
      },
      providerFn
    );
    expect(res1.success).toBe(true);
    expect(providerCalls).toBe(1);

    // Key 2 with same requestId has independent admission
    const res2 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId2,
        requestId: sharedRequestId,
        payloadFingerprint: 'fp-key2',
        modelAlias: testModelAlias,
      },
      providerFn
    );
    expect(res2.success).toBe(true);
    expect(providerCalls).toBe(2);
  });

  it('4. Perubahan konfigurasi commit sebelum admission: pencabutan API key atau credential menggagalkan admission', async () => {
    const db = await getDatabase();
    const requestId = 'req-config-change-revocation';

    // Revoke key before admission commits
    await db.collection(COLLECTIONS.API_KEYS).updateOne(
      { _id: testApiKeyId1 },
      { $set: { status: 'revoked' } }
    );

    let providerCalls = 0;
    const providerFn = async () => {
      providerCalls++;
      return { ok: true };
    };

    await expect(
      dispatchWithAdmission(
        db,
        {
          projectId: testProjectId,
          apiKeyId: testApiKeyId1,
          requestId,
          payloadFingerprint: 'fp-rev',
          modelAlias: testModelAlias,
        },
        providerFn
      )
    ).rejects.toThrowError(/API key is revoked/);

    expect(providerCalls).toBe(0);
  });

  it('5. Jeda setelah pemeriksaan tetapi sebelum transisi: pemilik lama gagal transisi dan melakukan nol panggilan provider', async () => {
    const db = await getDatabase();
    const requestId = 'req-race-pause-old-owner';

    const providerCallLog: string[] = [];
    const mockProvider = async (workerId: string) => {
      providerCallLog.push(workerId);
      return { result: workerId };
    };

    const t0 = new Date('2026-11-04T15:00:00.000Z');
    let resumeWorker1: () => void = () => {};
    let signalWorker1Paused: () => void = () => {};
    const waitSignal = new Promise<void>((resolve) => {
      resumeWorker1 = resolve;
    });
    const pausedSignal = new Promise<void>((resolve) => {
      signalWorker1Paused = resolve;
    });

    // Worker 1 runs and pauses in beforeDispatchTransition (after ownership check, before atomic transition)
    const worker1Promise = dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-race-5',
        modelAlias: testModelAlias,
      },
      () => mockProvider('worker-1'),
      {
        hooks: {
          clock: { now: () => t0 },
          beforeDispatchTransition: async () => {
            signalWorker1Paused();
            await waitSignal;
          },
        },
      }
    );

    // Wait deterministically for worker 1 to reach pause point
    await pausedSignal;

    // While Worker 1 is paused, time advances > 30s according to Atlas
    const t35s = new Date('2026-11-04T15:00:35.000Z');

    // Worker 2 arrives, fences the expired claim, and takes over
    const claim2 = await claimAdmissionIntent(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
      },
      { clock: { now: () => t35s } }
    );
    expect(claim2.status).toBe('acquired');
    expect(claim2.generation).toBe(2);

    // Resume Worker 1
    resumeWorker1();

    const w1Result = await worker1Promise;
    expect(w1Result.success).toBe(false);
    if (!w1Result.success && 'dispatchFailed' in w1Result) {
      expect(w1Result.dispatchFailed).toBe(true);
    }

    // Worker 1 performed ZERO provider calls!
    expect(providerCallLog).toHaveLength(0);
  });

  it('6. Jeda setelah transisi: pemilik kedua tidak dapat mengambil izin dispatch bahkan setelah lease dipulihkan', async () => {
    const db = await getDatabase();
    const requestId = 'req-race-pause-after-dispatch-no-steal';

    const providerCallLog: string[] = [];
    const mockProvider = async (workerId: string) => {
      providerCallLog.push(workerId);
      return { result: workerId };
    };

    const t0 = new Date('2026-11-04T16:00:00.000Z');
    let resumeWorker1: () => void = () => {};
    let signalWorker1Dispatched: () => void = () => {};
    const waitSignal = new Promise<void>((resolve) => {
      resumeWorker1 = resolve;
    });
    const dispatchedSignal = new Promise<void>((resolve) => {
      signalWorker1Dispatched = resolve;
    });

    // Worker 1 runs and pauses in afterDispatchTransition (after dispatchStatus: 'dispatching' committed)
    const worker1Promise = dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-race-6',
        modelAlias: testModelAlias,
      },
      () => mockProvider('worker-1'),
      {
        hooks: {
          clock: { now: () => t0 },
          afterDispatchTransition: async () => {
            signalWorker1Dispatched();
            await waitSignal;
          },
        },
      }
    );

    // Wait deterministically for worker 1 to complete dispatch transition
    await dispatchedSignal;

    // Decision is dispatching
    const decision = await db.collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      requestId,
    });
    expect(decision?.dispatchStatus).toBe('dispatching');

    // Simulate background sweeper running concurrently
    await reconcileExpiredLeases(db, testProjectId, { clock: { now: () => t0 } });

    // Worker 2 arrives and tries to acquire dispatch permission or run admission
    const p2Dispatch = await acquireDispatchPermission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        attemptId: decision!.attemptId,
        generation: 1,
        decisionId: decision!._id,
      },
      { clock: { now: () => t0 } }
    );

    // Worker 2 MUST NOT be granted dispatch!
    expect(p2Dispatch.granted).toBe(false);

    // Resume Worker 1
    resumeWorker1();

    const w1Result = await worker1Promise;
    expect(w1Result.success).toBe(true);

    // Provider was called AT MOST ONCE per admission
    expect(providerCallLog).toEqual(['worker-1']);
  });

  it('7. Log provider tiruan membuktikan paling banyak satu pemilik memanggil provider per admission (tidak ada admission ganda atau kebocoran kuota)', async () => {
    const db = await getDatabase();
    const requestId = 'req-at-most-once-provider';

    const providerCallLog: string[] = [];
    const mockProvider = async (caller: string) => {
      providerCallLog.push(caller);
      return { answer: 42 };
    };

    // Run 5 concurrent processes attempting to admit the same request identity
    const promises = Array.from({ length: 5 }, (_, idx) =>
      dispatchWithAdmission(
        db,
        {
          projectId: testProjectId,
          apiKeyId: testApiKeyId1,
          requestId,
          payloadFingerprint: 'fp-single-call',
          modelAlias: testModelAlias,
        },
        () => mockProvider(`process-${idx}`)
      ).catch((err) => ({ success: false, error: err }))
    );

    await Promise.all(promises);

    // Exactly one provider call occurred!
    expect(providerCallLog).toHaveLength(1);

    // Rate counter increased by exactly 1
    const rateDoc = await db.collection(COLLECTIONS.RATE_COUNTERS).findOne({
      projectId: testProjectId,
    });
    expect(rateDoc?.count).toBe(1);
  });

  it('8. Penggunaan kembali UUID setelah dedupe_until 24 jam: diizinkan dengan payload baru', async () => {
    const db = await getDatabase();
    const requestId = 'req-reuse-after-24h';

    const t0 = new Date('2026-11-04T08:00:00.000Z');
    let providerCalls = 0;
    const providerFn = async () => {
      providerCalls++;
      return { done: true };
    };

    // First request at t0
    const res1 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-day1',
        modelAlias: testModelAlias,
      },
      providerFn,
      { hooks: { clock: { now: () => t0 } } }
    );
    expect(res1.success).toBe(true);
    expect(providerCalls).toBe(1);

    // Attempt before 24h (e.g. at 23h59m): retry uses old decision
    const t23h = new Date('2026-11-05T07:59:00.000Z');
    const res2 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-day1',
        modelAlias: testModelAlias,
      },
      providerFn,
      { hooks: { clock: { now: () => t23h } } }
    );
    expect(res2.success).toBe(false);
    expect(providerCalls).toBe(1);

    // Exact boundary at or after 24h: UUID can be reused, even with different payload!
    const t25h = new Date('2026-11-05T09:00:00.000Z');
    const res3 = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId1,
        requestId,
        payloadFingerprint: 'fp-day2-new-payload',
        modelAlias: testModelAlias,
      },
      providerFn,
      { hooks: { clock: { now: () => t25h } } }
    );
    expect(res3.success).toBe(true);
    expect(providerCalls).toBe(2);
  });
});
