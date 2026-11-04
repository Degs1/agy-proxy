import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import { COLLECTIONS, ProjectDocument, ApiKeyDocument, ModelAliasDocument, ProviderCredentialDocument } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  claimAdmissionIntent,
  requestAdmission,
  acquireDispatchPermission,
  finalizeAdmissionDecision,
  dispatchWithAdmission,
} from '@/lib/limiter';
import { GatewayError } from '@/lib/validation/error';

describe('TASK-045: Pengujian Klaim & Admission Dua Proses Terdistribusi', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;

  let testProjectId: ObjectId;
  let testApiKeyId: ObjectId;
  let testCredentialId: ObjectId;
  const testModelAlias = 'gemini-default';

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_task045';
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

    // Clean up all limiter-related collections
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

    // Seed test project, api key, credential, and alias
    testProjectId = new ObjectId();
    testApiKeyId = new ObjectId();
    testCredentialId = new ObjectId();

    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Task 045 Project',
      status: 'active',
      rpmLimit: 10,
      concurrencyLimit: 2,
      allowedModels: [testModelAlias],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId,
      projectId: testProjectId,
      name: 'Test Key',
      keyPrefix: 'agw_test',
      keyHash: 'hash-test-045',
      status: 'active',
      createdAt: new Date(),
    });

    await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).insertOne({
      _id: testCredentialId,
      projectId: testProjectId,
      provider: 'gemini',
      displayName: 'Test Gemini',
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

  it('1. Klaim serentak dua proses: tepat satu pemenang berhasil acquired, proses kedua pending_active', async () => {
    const db = await getDatabase();
    const requestId = 'req-concurrent-001';

    const p1 = claimAdmissionIntent(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId,
    });

    const p2 = claimAdmissionIntent(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId,
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    const results = [res1.status, res2.status];

    // Exactly one acquired, the other detected active pending
    expect(results).toContain('acquired');
    expect(results).toContain('pending_active');

    // Document in database has generation 1
    const intent = await db.collection(COLLECTIONS.ADMISSION_INTENTS).findOne({
      projectId: testProjectId,
      requestId,
    });
    expect(intent).toBeDefined();
    expect(intent?.generation).toBe(1);
    expect(intent?.status).toBe('pending');
  });

  it('2. Pagar setelah 30 detik: proses kedua merekonsiliasi klaim kedaluwarsa dengan attemptId baru & generation++', async () => {
    const db = await getDatabase();
    const requestId = 'req-fencing-30s-001';

    const t0 = new Date('2026-11-04T08:00:00.000Z');
    // Process 1 claims at t0
    const claim1 = await claimAdmissionIntent(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
      },
      { clock: { now: () => t0 } }
    );

    expect(claim1.status).toBe('acquired');
    expect(claim1.generation).toBe(1);

    // Process 1 crashes / abandons. Time advances past 30 seconds (31s later)
    const t31s = new Date('2026-11-04T08:00:31.000Z');

    // Process 2 arrives and claims
    const claim2 = await claimAdmissionIntent(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
      },
      { clock: { now: () => t31s } }
    );

    expect(claim2.status).toBe('acquired');
    expect(claim2.generation).toBe(2);
    expect(claim2.attemptId).not.toBe(claim1.attemptId);

    // Verify database document was fenced
    const intent = await db.collection(COLLECTIONS.ADMISSION_INTENTS).findOne({
      projectId: testProjectId,
      requestId,
    });
    expect(intent?.attemptId).toBe(claim2.attemptId);
    expect(intent?.generation).toBe(2);
    expect(intent?.fencedAttemptId).toBe(claim1.attemptId);
    expect(intent?.fencedAt).toEqual(t31s);
  });

  it('3. Rollback saat balapan: percobaan lama yang dipagar gagal saat verifikasi penulisan transaksi', async () => {
    const db = await getDatabase();
    const requestId = 'req-rollback-001';

    const t0 = new Date('2026-11-04T08:00:00.000Z');
    const claim1 = await claimAdmissionIntent(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
      },
      { clock: { now: () => t0 } }
    );

    // Process 2 fences claim 1 at t+35s
    const t35s = new Date('2026-11-04T08:00:35.000Z');
    await claimAdmissionIntent(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
      },
      { clock: { now: () => t35s } }
    );

    // Now if Process 1 attempts admission transaction with its old attemptId1 & generation1
    await expect(
      requestAdmission(
        db,
        {
          projectId: testProjectId,
          apiKeyId: testApiKeyId,
          requestId,
          payloadFingerprint: 'fingerprint-abc',
          modelAlias: testModelAlias,
        },
        {
          clock: { now: () => t35s },
        }
      )
    ).rejects.toThrow();

    // Verify rate counter was NOT leaked (should be 0)
    const rateCount = await db.collection(COLLECTIONS.RATE_COUNTERS).countDocuments({});
    expect(rateCount).toBe(0);

    // Verify no running decision exists for attempt1
    const decision = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      attemptId: claim1.attemptId,
    });
    expect(decision).toBeNull();
  });

  it('4. Batas menit UTC: rate limit terisolasi per menit UTC dan reset pada awal menit berikutnya', async () => {
    const db = await getDatabase();
    // Set project limit to exactly 2 RPM
    await db.collection(COLLECTIONS.PROJECTS).updateOne(
      { _id: testProjectId },
      { $set: { rpmLimit: 2 } }
    );

    const t0_10 = new Date('2026-11-04T08:00:10.000Z');
    const t0_50 = new Date('2026-11-04T08:00:50.000Z');
    const t0_55 = new Date('2026-11-04T08:00:55.000Z');
    const t1_00 = new Date('2026-11-04T08:01:00.000Z'); // Exact boundary of next UTC minute

    // Req 1 at 08:00:10
    const res1 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-rpm-1',
        payloadFingerprint: 'fp-1',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0_10 } }
    );
    expect(res1.admitted).toBe(true);

    // Req 2 at 08:00:50
    const res2 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-rpm-2',
        payloadFingerprint: 'fp-2',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0_50 } }
    );
    expect(res2.admitted).toBe(true);

    // Req 3 at 08:00:55 -> must be rejected (429)
    const res3 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-rpm-3',
        payloadFingerprint: 'fp-3',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0_55 } }
    );
    expect(res3.admitted).toBe(false);
    if (!res3.admitted && 'reason' in res3) {
      expect(res3.httpStatus).toBe(429);
      expect(res3.reason).toBe('rate_limit_exceeded');
      expect(res3.retryAfter).toBeGreaterThanOrEqual(1);
    }

    // Req 4 at 08:01:00 -> new UTC minute! Must be admitted!
    const res4 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-rpm-4',
        payloadFingerprint: 'fp-4',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t1_00 } }
    );
    expect(res4.admitted).toBe(true);
  });

  it('5. Kuota 1.000 penolakan harian: pencatatan berhenti pada 1.000 tanpa meninggalkan pending', async () => {
    const db = await getDatabase();
    // Set project limit to 0 RPM so all requests reject
    await db.collection(COLLECTIONS.PROJECTS).updateOne(
      { _id: testProjectId },
      { $set: { rpmLimit: 0 } }
    );

    const testDate = new Date('2026-11-04T10:00:00.000Z');
    const utcDay = testDate.toISOString().slice(0, 10);

    // Pre-populate rejection counter at 999
    await db.collection(COLLECTIONS.REJECTION_COUNTERS).insertOne({
      projectId: testProjectId,
      utcDay,
      count: 999,
      createdAt: testDate,
    });

    // Request 1000th: should record decision and increment counter to 1000
    const res1000 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-rej-1000',
        payloadFingerprint: 'fp-1000',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => testDate } }
    );
    expect(res1000.admitted).toBe(false);

    const counter1000 = await db.collection(COLLECTIONS.REJECTION_COUNTERS).findOne({
      projectId: testProjectId,
      utcDay,
    });
    expect(counter1000?.count).toBe(1000);

    const decision1000 = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      requestId: 'req-rej-1000',
    });
    expect(decision1000).toBeDefined();
    expect(decision1000?.status).toBe('rejected');

    // Request 1001st: counter is already 1000! Must return 429 without storing new decision
    const res1001 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-rej-1001',
        payloadFingerprint: 'fp-1001',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => testDate } }
    );
    expect(res1001.admitted).toBe(false);
    if (!res1001.admitted) {
      expect(res1001.httpStatus).toBe(429);
    }

    // Counter must remain capped at 1000
    const counter1001 = await db.collection(COLLECTIONS.REJECTION_COUNTERS).findOne({
      projectId: testProjectId,
      utcDay,
    });
    expect(counter1001?.count).toBe(1000);

    // No decision document recorded for 1001st request
    const decision1001 = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      requestId: 'req-rej-1001',
    });
    expect(decision1001).toBeNull();

    // Intent must NOT be left pending
    const intent1001 = await db.collection(COLLECTIONS.ADMISSION_INTENTS).findOne({
      requestId: 'req-rej-1001',
    });
    expect(intent1001?.status).toBe('terminal');
  });

  it('6. Commit tidak diketahui (UnknownTransactionCommitResult): 503 jika tidak dapat dipastikan di primary', async () => {
    const db = await getDatabase();
    const requestId = 'req-unknown-commit-001';

    await expect(
      requestAdmission(
        db,
        {
          projectId: testProjectId,
          apiKeyId: testApiKeyId,
          requestId,
          payloadFingerprint: 'fp-unknown',
          modelAlias: testModelAlias,
        },
        {
          simulateUnknownCommit: true,
        }
      )
    ).rejects.toThrowError(/Service Unavailable: Transaction commit result unknown/);
  });

  it('7. Uji Balapan 1: Jeda pemilik pertama tepat setelah pemeriksaan dan sebelum transisi dispatch atomik', async () => {
    const db = await getDatabase();
    const requestId = 'req-race-pause-before-dispatch';

    let providerCallCount = 0;
    const mockProvider = async () => {
      providerCallCount++;
      return { output: 'success' };
    };

    const t0 = new Date('2026-11-04T12:00:00.000Z');
    let resumeProcess1: () => void = () => {};
    let signalProcess1Paused: () => void = () => {};
    const waitSignal = new Promise<void>((resolve) => {
      resumeProcess1 = resolve;
    });
    const pausedSignal = new Promise<void>((resolve) => {
      signalProcess1Paused = resolve;
    });

    // Process 1 starts admission and pauses in beforeDispatchTransition hook
    const process1Promise = dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
        payloadFingerprint: 'fp-race-1',
        modelAlias: testModelAlias,
      },
      mockProvider,
      {
        hooks: {
          clock: { now: () => t0 },
          beforeDispatchTransition: async () => {
            signalProcess1Paused();
            // Pause process 1 here!
            await waitSignal;
          },
        },
      }
    );

    // Wait deterministically for process 1 to reach pause point
    await pausedSignal;

    // While Process 1 is paused, time advances > 30s according to Atlas
    const t35s = new Date('2026-11-04T12:00:35.000Z');

    // Process 2 arrives and takes over the expired claim
    const claim2 = await claimAdmissionIntent(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
      },
      { clock: { now: () => t35s } }
    );
    expect(claim2.status).toBe('acquired');
    expect(claim2.generation).toBe(2);

    // Now resume Process 1
    resumeProcess1();

    const p1Result = await process1Promise;
    // Process 1 dispatch MUST fail because its claim was fenced!
    expect(p1Result.success).toBe(false);
    if (!p1Result.success && 'dispatchFailed' in p1Result) {
      expect(p1Result.dispatchFailed).toBe(true);
    }

    // ZERO provider calls from process 1!
    expect(providerCallCount).toBe(0);
  });

  it('8. Uji Balapan 2: Jeda pemilik pertama tepat setelah transisi dispatch atomik', async () => {
    const db = await getDatabase();
    const requestId = 'req-race-pause-after-dispatch';

    let providerCallCount = 0;
    const mockProvider = async () => {
      providerCallCount++;
      return { output: 'success' };
    };

    const t0 = new Date('2026-11-04T13:00:00.000Z');
    let resumeProcess1: () => void = () => {};
    let signalProcess1Dispatched: () => void = () => {};
    const waitSignal = new Promise<void>((resolve) => {
      resumeProcess1 = resolve;
    });
    const dispatchedSignal = new Promise<void>((resolve) => {
      signalProcess1Dispatched = resolve;
    });

    // Process 1 starts admission and pauses AFTER dispatch transition confirmed
    const process1Promise = dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId,
        payloadFingerprint: 'fp-race-2',
        modelAlias: testModelAlias,
      },
      mockProvider,
      {
        hooks: {
          clock: { now: () => t0 },
          afterDispatchTransition: async () => {
            signalProcess1Dispatched();
            // Pause process 1 while dispatch is active!
            await waitSignal;
          },
        },
      }
    );

    // Wait deterministically for process 1 to complete dispatch transition
    await dispatchedSignal;

    // Verify decision is now 'dispatching' in database
    const decision = await db.collection<any>(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      requestId,
    });
    expect(decision?.dispatchStatus).toBe('dispatching');

    // Process 2 attempts to acquire dispatch permission on the same decision
    const p2Dispatch = await acquireDispatchPermission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId,
      attemptId: decision.attemptId,
      generation: 1,
      decisionId: decision._id,
    });

    // Process 2 MUST be denied dispatch!
    expect(p2Dispatch.granted).toBe(false);
    expect(p2Dispatch.reason).toBe('already_dispatching_or_fenced');

    // Resume Process 1
    resumeProcess1();

    const p1Result = await process1Promise;
    expect(p1Result.success).toBe(true);

    // Exactly one provider call occurred!
    expect(providerCallCount).toBe(1);
  });
});
