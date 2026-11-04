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
  WorkerHeartbeatDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  requestAdmission,
  dispatchWithAdmission,
  LeaseRecoveryRunner,
  evaluateRecoveryHealth,
  finalizeAdmissionDecision,
} from '@/lib/limiter';

describe('TASK-051: Pengujian Recovery Worker Multi-Instance & Alerting', () => {
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
    process.env.MONGODB_DB_NAME = 'test_gateway_task051';
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
    await db.collection(COLLECTIONS.WORKER_HEARTBEATS).deleteMany({});

    testProjectId = new ObjectId();
    testApiKeyId = new ObjectId();
    testCredentialId = new ObjectId();

    const now = new Date();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Test Project Recovery',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 2,
      allowedModels: [testModelAlias],
      createdAt: now,
      updatedAt: now,
    });

    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId,
      projectId: testProjectId,
      name: 'Test Key',
      keyPrefix: 'agw_test',
      keyHash: 'hash_test_key_task051',
      status: 'active',
      createdAt: now,
    });

    await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .insertOne({
        _id: testCredentialId,
        projectId: testProjectId,
        provider: 'gemini',
        displayName: 'Test Gemini 051',
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

  it('1. Persaingan antara pemilik dan 2 instance pemulih: sweep bersamaan aman, tepat 1 keputusan terminal lease_expired tercatat', async () => {
    const db = await getDatabase();
    let simTime = new Date('2026-11-04T12:00:00.000Z');

    // Create admission with active lease
    const adm = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-multi-recovery-001',
        payloadFingerprint: 'fp-multi-1',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => simTime } }
    );
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    // Create 2 recovery runner instances
    const worker1 = new LeaseRecoveryRunner(db, {
      instanceId: 'worker-instance-1',
      scanIntervalMs: 5000,
      clock: { now: () => simTime },
    });
    const worker2 = new LeaseRecoveryRunner(db, {
      instanceId: 'worker-instance-2',
      scanIntervalMs: 5000,
      clock: { now: () => simTime },
    });

    // Phase 1: While lease is active at T0, both workers run scan
    const scanActive1 = await worker1.runScan();
    const scanActive2 = await worker2.runScan();
    expect(scanActive1.reconciledCount).toBe(0);
    expect(scanActive2.reconciledCount).toBe(0);

    // Verify lease remains active in database
    const leaseStillActive = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne({ leaseId: adm.leaseId });
    expect(leaseStillActive).not.toBeNull();

    // Phase 2: Advance time past 45 seconds (T0 + 46s)
    simTime = new Date('2026-11-04T12:00:46.000Z');

    // Both workers scan concurrently
    const [res1, res2] = await Promise.all([
      worker1.runScan(),
      worker2.runScan(),
    ]);

    // Exactly 1 worker reconciled the lease; sum of reconciledCount must be 1
    expect(res1.reconciledCount + res2.reconciledCount).toBe(1);

    // Concurrency lease document is deleted
    const leaseDeleted = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne({ leaseId: adm.leaseId });
    expect(leaseDeleted).toBeNull();

    // Exactly 1 decision record exists and is marked lease_expired
    const dec = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne({ _id: adm.decisionId });
    expect(dec?.status).toBe('lease_expired');
    expect(dec?.outcome?.status).toBe('lease_expired');
  });

  it('2. Pemilik mati tanpa request lanjutan: background worker memulihkan slot dan proses aplikasi kedua langsung dapat masuk', async () => {
    const db = await getDatabase();
    let simTime = new Date('2026-11-04T12:00:00.000Z');

    // Fill concurrency capacity (limit: 2)
    const adm1 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dead-owner-1',
        payloadFingerprint: 'fp-dead-1',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => simTime } }
    );
    const adm2 = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dead-owner-2',
        payloadFingerprint: 'fp-dead-2',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => simTime } }
    );
    expect(adm1.admitted).toBe(true);
    expect(adm2.admitted).toBe(true);

    // 3rd request is blocked by concurrency limit
    const adm3Rejected = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dead-owner-3',
        payloadFingerprint: 'fp-dead-3',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => simTime } }
    );
    expect(adm3Rejected.admitted).toBe(false);

    // Both owner processes crash and never complete.
    // Time advances past 45s without any incoming user requests
    simTime = new Date('2026-11-04T12:00:46.000Z');

    const worker = new LeaseRecoveryRunner(db, {
      instanceId: 'worker-autonomous-sweep',
      scanIntervalMs: 5000,
      clock: { now: () => simTime },
    });

    // Worker sweeps autonomously without user intervention
    const sweepResult = await worker.runScan();
    expect(sweepResult.reconciledCount).toBe(2);

    // Second application process / request can now enter immediately
    const adm4Success = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-process2-fresh',
        payloadFingerprint: 'fp-fresh',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => simTime } }
    );
    expect(adm4Success.admitted).toBe(true);
  });

  it('3. Penanda sukses baru dikirim setelah commit terminal terkonfirmasi', async () => {
    const db = await getDatabase();
    const simTime = new Date('2026-11-04T12:00:00.000Z');

    let providerCalled = false;
    const mockProvider = async () => {
      providerCalled = true;
      return { answer: 'Valid provider output' };
    };

    // dispatchWithAdmission runs full cycle
    const result = await dispatchWithAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-dispatch-terminal-confirm-001',
        payloadFingerprint: 'fp-confirm-success',
        modelAlias: testModelAlias,
      },
      mockProvider,
      {
        hooks: {
          clock: { now: () => simTime },
        },
      }
    );

    // Verify success was only returned after terminal commit succeeded
    expect(result.success).toBe(true);
    expect(providerCalled).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({ answer: 'Valid provider output' });

      // Check database reflects confirmed succeeded decision
      const dec = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ _id: result.decisionId });
      expect(dec?.status).toBe('succeeded');
      expect(dec?.outcome?.status).toBe('succeeded');
      expect(dec?.outcome?.originalHttpStatus).toBe(200);

      // Concurrency lease was atomically released
      const activeLeases = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .find({ decisionId: result.decisionId })
        .toArray();
      expect(activeLeases.length).toBe(0);
    }
  });

  it('4. Perekaman scan start dan heartbeat per instance di Atlas', async () => {
    const db = await getDatabase();
    const tStart = new Date('2026-11-04T12:00:00.000Z');

    const worker = new LeaseRecoveryRunner(db, {
      instanceId: 'worker-telemetry-instance-1',
      scanIntervalMs: 5000,
      clock: { now: () => tStart },
    });

    await worker.start();

    // Verify heartbeat record was created in Atlas
    const hb = await db
      .collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS)
      .findOne({ instanceId: 'worker-telemetry-instance-1' });

    expect(hb).not.toBeNull();
    expect(hb?.workerType).toBe('recovery');
    expect(hb?.instanceId).toBe('worker-telemetry-instance-1');
    expect(hb?.status).toBe('healthy');
    expect(hb?.scanIntervalMs).toBe(5000);
    expect(hb?.lastHeartbeatAt.toISOString()).toBe(tStart.toISOString());
    expect(hb?.lastScanStartedAt.toISOString()).toBe(tStart.toISOString());

    await worker.stop();

    const hbStopped = await db
      .collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS)
      .findOne({ instanceId: 'worker-telemetry-instance-1' });
    expect(hbStopped?.status).toBe('stopped');
  });

  it('5. Alert operasional: 15s heartbeat, 10s scan interval, consecutive errors, dan backlog lease', async () => {
    const db = await getDatabase();
    const tBase = new Date('2026-11-04T12:00:00.000Z');

    // 1. Seed worker with stale heartbeat (20s old)
    await db.collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS).insertOne({
      workerType: 'recovery',
      instanceId: 'worker-stale-hb',
      lastHeartbeatAt: new Date(tBase.getTime() - 20_000), // 20s ago (exceeds 15s threshold)
      lastScanStartedAt: new Date(tBase.getTime() - 20_000),
      scanIntervalMs: 5000,
      status: 'healthy',
      consecutiveErrors: 0,
      reconciledCountTotal: 10,
      startedAt: new Date(tBase.getTime() - 60_000),
      updatedAt: new Date(tBase.getTime() - 20_000),
    });

    // 2. Seed worker with scan interval gap (12s old scan start)
    await db.collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS).insertOne({
      workerType: 'recovery',
      instanceId: 'worker-scan-lag',
      lastHeartbeatAt: new Date(tBase.getTime() - 2_000), // recent heartbeat
      lastScanStartedAt: new Date(tBase.getTime() - 12_000), // 12s ago (exceeds 10s threshold)
      scanIntervalMs: 5000,
      status: 'healthy',
      consecutiveErrors: 0,
      reconciledCountTotal: 5,
      startedAt: new Date(tBase.getTime() - 60_000),
      updatedAt: new Date(tBase.getTime() - 2_000),
    });

    // 3. Seed worker with repeated failures (consecutiveErrors: 3)
    await db.collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS).insertOne({
      workerType: 'recovery',
      instanceId: 'worker-failing',
      lastHeartbeatAt: new Date(tBase.getTime() - 1_000),
      lastScanStartedAt: new Date(tBase.getTime() - 1_000),
      scanIntervalMs: 5000,
      status: 'degraded',
      consecutiveErrors: 4,
      lastError: 'Transaction error: network timeout',
      reconciledCountTotal: 0,
      startedAt: new Date(tBase.getTime() - 60_000),
      updatedAt: new Date(tBase.getTime() - 1_000),
    });

    // 4. Seed an expired lease backlog
    await db.collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES).insertOne({
      leaseId: 'lease-backlog-1',
      projectId: testProjectId,
      decisionId: new ObjectId(),
      expiresAt: new Date(tBase.getTime() - 5_000), // expired 5s ago
      createdAt: new Date(tBase.getTime() - 50_000),
    });

    // Evaluate health
    const health = await evaluateRecoveryHealth(db, {
      clock: { now: () => tBase },
    });

    expect(health.healthy).toBe(false);
    expect(health.alerts.length).toBeGreaterThanOrEqual(4);

    const alertCodes = health.alerts.map((a) => a.code);
    expect(alertCodes).toContain('no_healthy_heartbeat_15s');
    expect(alertCodes).toContain('scan_interval_exceeded_10s');
    expect(alertCodes).toContain('repeated_transaction_failures');
    expect(alertCodes).toContain('backlog_expired_leases');
  });

  it('6. Reza menguji restart satu instance: instance kedua terus memindai dan memulihkan lease secara mandiri', async () => {
    const db = await getDatabase();
    let simTime = new Date('2026-11-04T12:00:00.000Z');

    // Instance A and Instance B running
    const workerA = new LeaseRecoveryRunner(db, {
      instanceId: 'worker-instance-A',
      scanIntervalMs: 5000,
      clock: { now: () => simTime },
    });
    const workerB = new LeaseRecoveryRunner(db, {
      instanceId: 'worker-instance-B',
      scanIntervalMs: 5000,
      clock: { now: () => simTime },
    });

    await workerA.start();
    await workerB.start();

    // Create a request with lease
    const adm = await requestAdmission(
      db,
      {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-restart-resilience',
        payloadFingerprint: 'fp-restart',
        modelAlias: testModelAlias,
      },
      { clock: { now: () => simTime } }
    );
    expect(adm.admitted).toBe(true);

    // Simulate restart of Instance A (SIGTERM -> graceful stop)
    await workerA.stop();

    // Advance time past 45s (lease expires)
    simTime = new Date('2026-11-04T12:00:46.000Z');

    // Instance B continues scanning
    const sweepB = await workerB.runScan();
    expect(sweepB.reconciledCount).toBe(1);

    // Verify lease was successfully recovered by Instance B
    const dec = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne({ _id: (adm as any).decisionId });
    expect(dec?.status).toBe('lease_expired');

    await workerB.stop();
  });
});
