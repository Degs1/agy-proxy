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
  ConcurrencyLeaseDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  requestAdmission,
  finalizeAdmissionDecision,
  extendConcurrencyLease,
  reconcileExpiredLeases,
  dispatchWithAdmission,
} from '@/lib/limiter';
import { GatewayError } from '@/lib/validation/error';

describe('TASK-046: Koordinator Admission & Lease Terdistribusi', () => {
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
    process.env.MONGODB_DB_NAME = 'test_gateway_task046';
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
    testApiKeyId = new ObjectId();
    testCredentialId = new ObjectId();

    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Task 046 Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 2,
      allowedModels: [testModelAlias],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.collection<ApiKeyDocument>(COLLECTIONS.API_KEYS).insertOne({
      _id: testApiKeyId,
      projectId: testProjectId,
      name: 'Test Key 046',
      keyPrefix: 'agw_46',
      keyHash: 'hash-test-046',
      status: 'active',
      createdAt: new Date(),
    });

    await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).insertOne({
      _id: testCredentialId,
      projectId: testProjectId,
      provider: 'gemini',
      displayName: 'Test Gemini 046',
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

  it('1. Penulisan pertama transaksi wajib memutakhirkan project_limiter_guards dan increment revision', async () => {
    const db = await getDatabase();
    const requestId = 'req-guard-001';

    const res = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId,
      payloadFingerprint: 'fp-guard',
      modelAlias: testModelAlias,
    });

    expect(res.admitted).toBe(true);

    const guard = await db.collection(COLLECTIONS.PROJECT_LIMITER_GUARDS).findOne({
      _id: testProjectId,
    });
    expect(guard).toBeDefined();
    expect(guard?.revision).toBeGreaterThanOrEqual(1);
    expect(guard?.last_server_time).toBeInstanceOf(Date);
  });

  it('2. Otorisasi ulang: project yang dinonaktifkan ditolak 403 project_disabled', async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.PROJECTS).updateOne(
      { _id: testProjectId },
      { $set: { status: 'disabled' } }
    );

    await expect(
      requestAdmission(db, {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-disabled-project',
        payloadFingerprint: 'fp-dp',
        modelAlias: testModelAlias,
      })
    ).rejects.toThrowError(/Project is disabled/);
  });

  it('3. Otorisasi ulang: API key yang dicabut ditolak 401 invalid_api_key', async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.API_KEYS).updateOne(
      { _id: testApiKeyId },
      { $set: { status: 'revoked' } }
    );

    await expect(
      requestAdmission(db, {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-revoked-key',
        payloadFingerprint: 'fp-rk',
        modelAlias: testModelAlias,
      })
    ).rejects.toThrowError(/API key is revoked/);
  });

  it('4. Otorisasi ulang: Model alias dinonaktifkan ditolak 403 model_disabled', async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.MODEL_ALIASES).updateOne(
      { projectId: testProjectId, alias: testModelAlias },
      { $set: { status: 'disabled' } }
    );

    await expect(
      requestAdmission(db, {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-disabled-model',
        payloadFingerprint: 'fp-dm',
        modelAlias: testModelAlias,
      })
    ).rejects.toThrowError(/is disabled/);
  });

  it('5. Otorisasi ulang: Credential provider dinonaktifkan ditolak 503 provider_unavailable', async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).updateOne(
      { _id: testCredentialId },
      { $set: { status: 'disabled' } }
    );

    await expect(
      requestAdmission(db, {
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: 'req-disabled-cred',
        payloadFingerprint: 'fp-dc',
        modelAlias: testModelAlias,
      })
    ).rejects.toThrowError(/Bound provider credential is missing or unavailable/);
  });

  it('6. Concurrency limit: slot penuh ditolak 429 concurrency_limit_exceeded dengan Retry-After: 1', async () => {
    const db = await getDatabase();
    // Project has concurrencyLimit: 2

    // Admission 1
    const adm1 = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-conc-1',
      payloadFingerprint: 'fp-c1',
      modelAlias: testModelAlias,
    });
    expect(adm1.admitted).toBe(true);

    // Admission 2
    const adm2 = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-conc-2',
      payloadFingerprint: 'fp-c2',
      modelAlias: testModelAlias,
    });
    expect(adm2.admitted).toBe(true);

    // Admission 3: Concurrency slot full (2 active leases)
    const adm3 = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-conc-3',
      payloadFingerprint: 'fp-c3',
      modelAlias: testModelAlias,
    });

    expect(adm3.admitted).toBe(false);
    if (!adm3.admitted && 'reason' in adm3) {
      expect(adm3.httpStatus).toBe(429);
      expect(adm3.reason).toBe('concurrency_limit_exceeded');
      expect(adm3.retryAfter).toBe(1);
    }
  });

  it('7. Perpanjangan lease: lease diperpanjang 45 detik saat masih aktif', async () => {
    const db = await getDatabase();
    const adm = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-ext-1',
      payloadFingerprint: 'fp-ext',
      modelAlias: testModelAlias,
    });
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    const initialLease = await db.collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES).findOne({
      leaseId: adm.leaseId,
    });
    expect(initialLease).toBeDefined();

    // Extend lease
    const extResult = await extendConcurrencyLease(db, {
      projectId: testProjectId,
      decisionId: adm.decisionId,
      leaseId: adm.leaseId,
    });

    expect(extResult.success).toBe(true);
    expect(extResult.expiresAt).toBeDefined();
    expect(extResult.expiresAt!.getTime()).toBeGreaterThan(initialLease!.expiresAt.getTime());
  });

  it('8. Finalisasi transaksi terminal melepas lease dan menetapkan dedupe_until 24 jam', async () => {
    const db = await getDatabase();
    const adm = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-fin-1',
      payloadFingerprint: 'fp-fin',
      modelAlias: testModelAlias,
    });
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    const fin = await finalizeAdmissionDecision(db, {
      projectId: testProjectId,
      decisionId: adm.decisionId,
      leaseId: adm.leaseId,
      attemptId: adm.attemptId,
      finalStatus: 'succeeded',
      originalHttpStatus: 200,
    });

    expect(fin.success).toBe(true);

    // Lease was deleted (released slot)
    const lease = await db.collection(COLLECTIONS.CONCURRENCY_LEASES).findOne({
      leaseId: adm.leaseId,
    });
    expect(lease).toBeNull();

    // Decision is succeeded with dedupeUntil ~24 hours later
    const decision = await db.collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      _id: adm.decisionId,
    });
    expect(decision?.status).toBe('succeeded');
    expect(decision?.dispatchStatus).toBe('dispatched');
    expect(decision?.terminalAt).toBeDefined();
    expect(decision?.dedupeUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 3600 * 1000);
  });

  it('9. Pekerja terlambat: finalisasi ditolak jika lease telah kedaluwarsa', async () => {
    const db = await getDatabase();
    const adm = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-late-worker',
      payloadFingerprint: 'fp-late',
      modelAlias: testModelAlias,
    });
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    // Manually expire the lease in database
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).updateOne(
      { leaseId: adm.leaseId },
      { $set: { expiresAt: new Date(Date.now() - 5000) } }
    );

    // Late worker attempts to finalize
    const fin = await finalizeAdmissionDecision(db, {
      projectId: testProjectId,
      decisionId: adm.decisionId,
      leaseId: adm.leaseId,
      attemptId: adm.attemptId,
      finalStatus: 'succeeded',
      originalHttpStatus: 200,
    });

    expect(fin.success).toBe(false);
    expect(fin.reason).toBe('lease_expired');

    // Decision must NOT be marked succeeded
    const decision = await db.collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      _id: adm.decisionId,
    });
    expect(decision?.status).toBe('running');
  });

  it('10. Pemulihan lease kedaluwarsa (reconcileExpiredLeases): menandai lease_expired dan melepas slot tanpa memanggil provider', async () => {
    const db = await getDatabase();
    const adm = await requestAdmission(db, {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: 'req-reconcile-lease',
      payloadFingerprint: 'fp-rec',
      modelAlias: testModelAlias,
    });
    expect(adm.admitted).toBe(true);
    if (!adm.admitted) return;

    // Manually expire lease
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).updateOne(
      { leaseId: adm.leaseId },
      { $set: { expiresAt: new Date(Date.now() - 10000) } }
    );

    // Run reconciliation
    const reconciledCount = await reconcileExpiredLeases(db, testProjectId);
    expect(reconciledCount).toBe(1);

    // Decision was marked lease_expired
    const decision = await db.collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS).findOne({
      _id: adm.decisionId,
    });
    expect(decision?.status).toBe('lease_expired');
    expect(decision?.outcome?.status).toBe('lease_expired');

    // Lease was deleted
    const lease = await db.collection(COLLECTIONS.CONCURRENCY_LEASES).findOne({
      leaseId: adm.leaseId,
    });
    expect(lease).toBeNull();
  });
});
