import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import { getDatabase, closeDatabaseConnection } from '@/lib/db/client';
import {
  COLLECTIONS,
  ProjectDocument,
  ApiKeyDocument,
  ModelAliasDocument,
  ProviderCredentialDocument,
  AdmissionDecisionDocument,
  ConcurrencyLeaseDocument,
  AdmissionIntentDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  requestAdmission,
  acquireDispatchPermission,
  finalizeAdmissionDecision,
  extendConcurrencyLease,
  reconcileExpiredLeases,
  verifyTerminalCommit,
  dispatchWithAdmission,
  startLeaseHeartbeat,
} from '@/lib/limiter';

describe('TASK-049: Siklus Lease Concurrency & Keputusan Terminal', () => {
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
    process.env.MONGODB_DB_NAME = 'test_gateway_task049';
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
    await db.collection(COLLECTIONS.ADMISSION_INTENTS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteMany({});
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).deleteMany({});
    await db.collection(COLLECTIONS.RATE_COUNTERS).deleteMany({});
    await db.collection(COLLECTIONS.REJECTION_COUNTERS).deleteMany({});

    testProjectId = new ObjectId();
    testApiKeyId = new ObjectId();
    testCredentialId = new ObjectId();

    const now = new Date();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Test Project Lease Lifecycle',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: [testModelAlias],
      createdAt: now,
      updatedAt: now,
    });

    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId,
      projectId: testProjectId,
      name: 'Test Key',
      keyPrefix: 'agw_test',
      keyHash: 'hash_test_key_task049',
      status: 'active',
      createdAt: now,
    });

    await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .insertOne({
        _id: testCredentialId,
        projectId: testProjectId,
        provider: 'gemini',
        displayName: 'Test Gemini 049',
        credentialType: 'api_key',
        encryptedCredentials: {
          ciphertext: 'mock',
          iv: 'mock',
          authTag: 'mock',
          keyVersion: 1,
        },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: testModelAlias,
      upstreamModel: 'gemini-1.5-flash',
      boundCredentialId: testCredentialId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('1. Perpanjangan sebelum expires_at: T + 15s dan T + 44.999s berhasil memperbarui expires_at', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    const admission = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-extend-valid-001',
        payloadFingerprint: 'fp-extend-valid',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );

    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    // Check initial lease expires at T0 + 45s
    const initialLease = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne({ leaseId: admission.leaseId });
    expect(initialLease?.expiresAt.toISOString()).toBe('2026-11-04T12:00:45.000Z');

    // Extend at T + 15s
    const t15 = new Date(t0.getTime() + 15_000);
    const ext1 = await extendConcurrencyLease(
      db,
      {
        projectId: testProjectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
      },
      { clock: { now: () => t15 } }
    );

    expect(ext1.success).toBe(true);
    expect(ext1.expiresAt?.toISOString()).toBe(
      new Date(t15.getTime() + 45_000).toISOString()
    );

    // Extend at T + 44.999s relative to new expiresAt
    const tBeforeExpiry = new Date(ext1.expiresAt!.getTime() - 1); // 1ms before expiry
    const ext2 = await extendConcurrencyLease(
      db,
      {
        projectId: testProjectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
      },
      { clock: { now: () => tBeforeExpiry } }
    );

    expect(ext2.success).toBe(true);
    expect(ext2.expiresAt?.getTime()).toBe(tBeforeExpiry.getTime() + 45_000);
  });

  it('2. Perpanjangan tepat pada batas expires_at (T + 45.000s) ditolak sebagai kedaluwarsa', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    const admission = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-extend-boundary-002',
        payloadFingerprint: 'fp-extend-boundary',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );

    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    // Exact boundary: serverTime == expiresAt (T0 + 45.000s)
    const tExactExpiry = new Date(t0.getTime() + 45_000);
    const extExact = await extendConcurrencyLease(
      db,
      {
        projectId: testProjectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
      },
      { clock: { now: () => tExactExpiry } }
    );

    expect(extExact.success).toBe(false);
    expect(extExact.reason).toBe('lease_expired');
  });

  it('3. Perpanjangan sesudah batas expires_at (T + 45.001s) ditolak sebagai kedaluwarsa', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    const admission = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-extend-after-003',
        payloadFingerprint: 'fp-extend-after',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );

    expect(admission.admitted).toBe(true);
    if (!admission.admitted) return;

    // Past boundary: serverTime = expiresAt + 1ms (T0 + 45.001s)
    const tPastExpiry = new Date(t0.getTime() + 45_001);
    const extPast = await extendConcurrencyLease(
      db,
      {
        projectId: testProjectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
      },
      { clock: { now: () => tPastExpiry } }
    );

    expect(extPast.success).toBe(false);
    expect(extPast.reason).toBe('lease_expired');
  });

  it('4. Proses pemilik mati: slot concurrency pulih secara atomik saat disapu pemulih setelah 45s', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    // Fill all 5 concurrency slots
    for (let i = 1; i <= 5; i++) {
      const adm = await requestAdmission(
        db,
        {
          projectId: testProjectId,
          apiKeyId: testApiKeyId,
          requestId: `req-crash-slot-${i}`,
          payloadFingerprint: `fp-crash-${i}`,
          modelAlias: testModelAlias,
        },
        { clock: { now: () => t0 } }
      );
      expect(adm.admitted).toBe(true);
    }

    // 6th request at T0 is rejected due to concurrency limit (5/5 full)
    const adm6Rejected = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-crash-slot-6',
        payloadFingerprint: 'fp-crash-6',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );
    expect(adm6Rejected.admitted).toBe(false);
    if (!adm6Rejected.admitted) {
      expect(adm6Rejected.errorCode).toBe('concurrency_limit_exceeded');
    }

    // Process of slot 1 crashes and never sends heartbeat or terminal decision.
    // At T + 45.001s, recovery sweeps expired leases
    const tRecovery = new Date(t0.getTime() + 45_001);
    const sweptCount = await reconcileExpiredLeases(db, testProjectId, {
      clock: { now: () => tRecovery },
    });
    expect(sweptCount).toBe(5); // all 5 un-extended leases were swept

    // Now slot 6 retries with new attempt or new request: succeeds!
    const adm7 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-after-recovery-007',
        payloadFingerprint: 'fp-after-recovery-7',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => tRecovery } }
    );
    expect(adm7.admitted).toBe(true);
  });

  it('5. Keluaran terlambat (late worker): pekerja dengan lease kedaluwarsa ditolak commit terminalnya dan tidak melepas lease milik request lain', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    // Request 1 takes slot 1
    const adm1 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-late-worker-001',
        payloadFingerprint: 'fp-late-worker-1',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );
    expect(adm1.admitted).toBe(true);
    if (!adm1.admitted) return;

    // Time passes to T + 46s (lease 1 expired and swept)
    const t46 = new Date(t0.getTime() + 46_000);
    await reconcileExpiredLeases(db, testProjectId, { clock: { now: () => t46 } });

    // Request 2 now enters and acquires a new lease in that slot
    const adm2 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-legit-worker-002',
        payloadFingerprint: 'fp-legit-worker-2',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t46 } }
    );
    expect(adm2.admitted).toBe(true);
    if (!adm2.admitted) return;

    // Late worker 1 now finishes provider at T + 50s and tries to commit succeeded
    const t50 = new Date(t0.getTime() + 50_000);
    const lateCommit = await finalizeAdmissionDecision(
      db,
      {
        projectId: testProjectId,
        decisionId: adm1.decisionId,
        leaseId: adm1.leaseId,
        attemptId: adm1.attemptId,
        finalStatus: 'succeeded',
        originalHttpStatus: 200,
      },
      { clock: { now: () => t50 } }
    );

    // Must be rejected!
    expect(lateCommit.success).toBe(false);
    expect(lateCommit.reason).toBe('lease_expired');

    // Verify request 1 decision status was NOT corrupted (remains lease_expired)
    const dec1 = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne({ _id: adm1.decisionId });
    expect(dec1?.status).toBe('lease_expired');

    // Verify request 2 lease was NOT deleted by late worker 1
    const lease2 = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne({ leaseId: adm2.leaseId });
    expect(lease2).not.toBeNull();
    expect(lease2?.decisionId.toHexString()).toBe(adm2.decisionId.toHexString());
  });

  it('6. Commit terminal tidak pasti: gateway memverifikasi status commit di Atlas sebelum menyatakan sukses', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    const adm = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-uncertain-commit-001',
        payloadFingerprint: 'fp-uncertain',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    // Case A: Simulate uncertain commit that aborted -> throws LimiterUnavailableError and does NOT declare success
    await expect(
      finalizeAdmissionDecision(
        db,
        {
          projectId: testProjectId,
          decisionId: adm.decisionId,
          leaseId: adm.leaseId,
          attemptId: adm.attemptId,
          finalStatus: 'succeeded',
          originalHttpStatus: 200,
        },
        {
          clock: { now: () => t0 },
          simulateUnknownCommit: true,
        }
      )
    ).rejects.toThrowError(/Service Unavailable: Terminal transaction commit result unknown/);

    // Case B: Clean commit succeeded on Atlas primary -> verifyTerminalCommit confirms it
    const normalFinalize = await finalizeAdmissionDecision(
      db,
      {
        projectId: testProjectId,
        decisionId: adm.decisionId,
        leaseId: adm.leaseId,
        attemptId: adm.attemptId,
        finalStatus: 'succeeded',
        originalHttpStatus: 200,
      },
      { clock: { now: () => t0 } }
    );
    expect(normalFinalize.success).toBe(true);

    const verified = await verifyTerminalCommit(db, {
      decisionId: adm.decisionId,
      attemptId: adm.attemptId,
    });
    expect(verified.confirmed).toBe(true);
    expect(verified.status).toBe('succeeded');
  });

  it('7. Admission berstatus dispatching: pemulih boleh menutupnya, tetapi tidak membuka kesempatan dispatch ulang', async () => {
    const db = await getDatabase();
    const t0 = new Date('2026-11-04T12:00:00.000Z');

    const adm = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dispatching-protection-001',
        payloadFingerprint: 'fp-dispatching',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => t0 } }
    );
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    // Transition to dispatching
    const dispatch = await acquireDispatchPermission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dispatching-protection-001',
        attemptId: adm.attemptId,
        generation: adm.generation,
        decisionId: adm.decisionId,
      },
      { clock: { now: () => t0 } }
    );
    expect(dispatch.granted).toBe(true);

    // Verify it is dispatching
    const decBefore = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne({ _id: adm.decisionId });
    expect(decBefore?.dispatchStatus).toBe('dispatching');
    expect(decBefore?.status).toBe('running');

    // Lease expires at T + 45.001s; recovery sweeper runs
    const tExpired = new Date(t0.getTime() + 45_001);
    const swept = await reconcileExpiredLeases(db, testProjectId, {
      clock: { now: () => tExpired },
    });
    expect(swept).toBe(1);

    // Decision was safely closed to lease_expired
    const decAfter = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne({ _id: adm.decisionId });
    expect(decAfter?.status).toBe('lease_expired');

    // Dispatch CANNOT be re-granted or stolen by another attempt
    const secondDispatch = await acquireDispatchPermission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-dispatching-protection-001',
      attemptId: adm.attemptId,
      generation: adm.generation,
      decisionId: adm.decisionId,
    });
    expect(secondDispatch.granted).toBe(false);

    // Client retry with same UUID returns 409 request_already_processed with outcome lease_expired
    const retry = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dispatching-protection-001',
        payloadFingerprint: 'fp-dispatching',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => tExpired } }
    );
    expect(retry.admitted).toBe(false);
    if (!retry.admitted && 'isTerminalRetry' in retry) {
      expect(retry.httpStatus).toBe(409);
      expect(retry.errorCode).toBe('request_already_processed');
      expect(retry.outcome.status).toBe('lease_expired');
    }
  });

  it('8. Heartbeat berkala & pembatalan upstream: AbortSignal aktif membatalkan provider saat lease kedaluwarsa', async () => {
    const db = await getDatabase();
    let currentTime = new Date('2026-11-04T12:00:00.000Z');

    const adm = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-heartbeat-abort-001',
        payloadFingerprint: 'fp-heartbeat-abort',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => currentTime } }
    );
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    let expiredNotified = false;
    const leaseCtrl = startLeaseHeartbeat(
      db,
      {
        projectId: testProjectId,
        decisionId: adm.decisionId,
        leaseId: adm.leaseId,
      },
      {
        heartbeatIntervalMs: 50,
        clock: { now: () => currentTime },
        onExpired: () => {
          expiredNotified = true;
        },
      }
    );

    expect(leaseCtrl.signal.aborted).toBe(false);

    // Advance clock past 45s (T0 + 46s)
    currentTime = new Date(currentTime.getTime() + 46_000);

    // Trigger heartbeat
    const success = await leaseCtrl.triggerHeartbeatNow();
    expect(success).toBe(false);
    expect(leaseCtrl.signal.aborted).toBe(true);
    expect(leaseCtrl.isExpired()).toBe(true);
    expect(expiredNotified).toBe(true);

    leaseCtrl.stop();
  });
});
