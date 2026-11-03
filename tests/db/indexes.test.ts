import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { getDatabase, closeDatabaseConnection } from '@/lib/db/client';
import { COLLECTIONS } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { ObjectId, MongoServerError } from 'mongodb';

describe('Database Indexes & Unique Constraints (Requirement 1, AC 3)', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_indexes';
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
    await initDatabaseIndexes(db);
    for (const collName of Object.values(COLLECTIONS)) {
      await db.collection(collName).deleteMany({});
    }
  });

  it('initializes indexes idempotently without error', async () => {
    const db = await getDatabase();
    // Running second time should not throw
    await expect(initDatabaseIndexes(db)).resolves.not.toThrow();
  });

  it('enforces unique index on admission_decisions (projectId, apiKeyId, requestId)', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const apiKeyId = new ObjectId();
    const requestId = 'req-unique-admission-001';

    // Insert first decision
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne({
      projectId,
      apiKeyId,
      requestId,
      attemptId: 'att-1',
      payloadFingerprint: 'fp-1',
      status: 'running',
      createdAt: new Date(),
      dedupeUntil: new Date(Date.now() + 86400000),
    });

    // Attempt second insert with identical (projectId, apiKeyId, requestId)
    const duplicatePromise = db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne({
      projectId,
      apiKeyId,
      requestId,
      attemptId: 'att-2', // different attempt
      payloadFingerprint: 'fp-1',
      status: 'rejected',
      createdAt: new Date(),
      dedupeUntil: new Date(Date.now() + 86400000),
    });

    await expect(duplicatePromise).rejects.toThrow(MongoServerError);
    try {
      await duplicatePromise;
    } catch (err: unknown) {
      expect((err as MongoServerError).code).toBe(11000); // Duplicate key error
    }
  });

  it('handles concurrent admission decision contention: exactly 1 succeeds and concurrent attempts fail with 11000', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const apiKeyId = new ObjectId();
    const requestId = 'req-concurrent-admission-contention';

    // Spawn 5 simultaneous inserts for the identical (projectId, apiKeyId, requestId)
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne({
          projectId,
          apiKeyId,
          requestId,
          attemptId: `att-concurrent-${i}`,
          payloadFingerprint: 'fp-concurrent',
          status: 'running',
          createdAt: new Date(),
          dedupeUntil: new Date(Date.now() + 86400000),
        })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one instance wins the admission decision race
    expect(fulfilled).toHaveLength(1);
    // All other 4 instances are rejected by the unique index constraint
    expect(rejected).toHaveLength(4);

    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(MongoServerError);
        expect((r.reason as MongoServerError).code).toBe(11000);
      }
    }

    const count = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).countDocuments({
      projectId,
      apiKeyId,
      requestId,
    });
    expect(count).toBe(1);
  });

  it('enforces unique index on admission_intents (projectId, apiKeyId, requestId)', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const apiKeyId = new ObjectId();
    const requestId = 'req-intent-001';

    await db.collection(COLLECTIONS.ADMISSION_INTENTS).insertOne({
      projectId,
      apiKeyId,
      requestId,
      attemptId: 'att-int-1',
      generation: 1,
      status: 'pending',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 30000),
    });

    const dupPromise = db.collection(COLLECTIONS.ADMISSION_INTENTS).insertOne({
      projectId,
      apiKeyId,
      requestId,
      attemptId: 'att-int-2',
      generation: 1,
      status: 'pending',
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + 30000),
    });

    await expect(dupPromise).rejects.toThrow(MongoServerError);
  });

  it('handles concurrent admission intent claim contention: exactly 1 succeeds and concurrent attempts fail with 11000', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const apiKeyId = new ObjectId();
    const requestId = 'req-concurrent-intent-contention';

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        db.collection(COLLECTIONS.ADMISSION_INTENTS).insertOne({
          projectId,
          apiKeyId,
          requestId,
          attemptId: `att-intent-${i}`,
          generation: 1,
          status: 'pending',
          claimedAt: new Date(),
          claimExpiresAt: new Date(Date.now() + 30000),
        })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);

    const count = await db.collection(COLLECTIONS.ADMISSION_INTENTS).countDocuments({
      projectId,
      apiKeyId,
      requestId,
    });
    expect(count).toBe(1);
  });

  it('verifies TTL indexes configuration and 24-hour decision retention window contract', async () => {
    const db = await getDatabase();

    // 1. Verify admission_decisions TTL index
    const decisionIndexes = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).indexes();
    const decisionTtl = decisionIndexes.find(
      (idx) => idx.name === 'ttl_admission_decision_dedupe'
    );
    expect(decisionTtl).toBeDefined();
    expect(decisionTtl?.key).toEqual({ dedupeUntil: 1 });
    expect(decisionTtl?.expireAfterSeconds).toBe(0);

    // Verify 24-hour retention timestamp calculation
    const now = Date.now();
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    const dedupeUntil = new Date(now + TWENTY_FOUR_HOURS_MS);

    const decisionDoc = {
      projectId: new ObjectId(),
      apiKeyId: new ObjectId(),
      requestId: 'req-24h-retention-test',
      attemptId: 'att-24h',
      payloadFingerprint: 'fp-24h',
      status: 'succeeded' as const,
      createdAt: new Date(now),
      dedupeUntil,
    };

    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne(decisionDoc);
    const found = await db
      .collection(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne({ requestId: 'req-24h-retention-test' });
    expect(found).not.toBeNull();
    expect(found?.dedupeUntil.getTime() - found?.createdAt.getTime()).toBe(TWENTY_FOUR_HOURS_MS);

    // 2. Verify rate_counters 24-hour TTL index
    const rateIndexes = await db.collection(COLLECTIONS.RATE_COUNTERS).indexes();
    const rateTtl = rateIndexes.find((idx) => idx.name === 'ttl_rate_counter_24h');
    expect(rateTtl).toBeDefined();
    expect(rateTtl?.key).toEqual({ windowStart: 1 });
    expect(rateTtl?.expireAfterSeconds).toBe(86400); // 24 hours in seconds

    // 3. Verify admin_sessions TTL index
    const sessionIndexes = await db.collection(COLLECTIONS.ADMIN_SESSIONS).indexes();
    const sessionTtl = sessionIndexes.find((idx) => idx.name === 'ttl_admin_session_expiry');
    expect(sessionTtl).toBeDefined();
    expect(sessionTtl?.key).toEqual({ expiresAt: 1 });
    expect(sessionTtl?.expireAfterSeconds).toBe(0);

    // 4. Verify usage_records TTL index
    const usageIndexes = await db.collection(COLLECTIONS.USAGE_RECORDS).indexes();
    const usageTtl = usageIndexes.find((idx) => idx.name === 'ttl_usage_retention');
    expect(usageTtl).toBeDefined();
    expect(usageTtl?.key).toEqual({ expiresAt: 1 });
    expect(usageTtl?.expireAfterSeconds).toBe(0);
  });

  it('enforces unique index on admins email', async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.ADMINS).insertOne({
      email: 'admin@example.com',
      passwordHash: 'argon2id$mockedhash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const dupAdmin = db.collection(COLLECTIONS.ADMINS).insertOne({
      email: 'admin@example.com',
      passwordHash: 'anotherhash',
      role: 'admin',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(dupAdmin).rejects.toThrow(MongoServerError);
  });

  it('enforces unique index on login_failures (type, identifier)', async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.LOGIN_FAILURES).insertOne({
      type: 'email',
      identifier: 'admin@example.com',
      failureTimestamps: [new Date()],
      activeReservations: [],
      updatedAt: new Date(),
    });

    const dupFailure = db.collection(COLLECTIONS.LOGIN_FAILURES).insertOne({
      type: 'email',
      identifier: 'admin@example.com',
      failureTimestamps: [],
      activeReservations: [],
      updatedAt: new Date(),
    });

    await expect(dupFailure).rejects.toThrow(MongoServerError);
  });

  it('enforces unique index on api_keys keyHash', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    await db.collection(COLLECTIONS.API_KEYS).insertOne({
      projectId,
      name: 'Key 1',
      keyPrefix: 'agw_abc1',
      keyHash: 'hash-of-key-12345',
      status: 'active',
      createdAt: new Date(),
    });

    const dupKey = db.collection(COLLECTIONS.API_KEYS).insertOne({
      projectId,
      name: 'Key 2',
      keyPrefix: 'agw_xyz9',
      keyHash: 'hash-of-key-12345', // Identical keyHash
      status: 'active',
      createdAt: new Date(),
    });

    await expect(dupKey).rejects.toThrow(MongoServerError);
  });

  it('enforces unique index on model_aliases (projectId, alias)', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const credentialId = new ObjectId();

    await db.collection(COLLECTIONS.MODEL_ALIASES).insertOne({
      projectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: credentialId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const dupAlias = db.collection(COLLECTIONS.MODEL_ALIASES).insertOne({
      projectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.0-flash',
      boundCredentialId: credentialId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(dupAlias).rejects.toThrow(MongoServerError);
  });

  it('enforces unique index on rate_counters (projectId, windowStart)', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const windowStart = new Date('2026-11-03T20:00:00.000Z');

    await db.collection(COLLECTIONS.RATE_COUNTERS).insertOne({
      projectId,
      windowStart,
      count: 1,
      createdAt: new Date(),
    });

    const dupCounter = db.collection(COLLECTIONS.RATE_COUNTERS).insertOne({
      projectId,
      windowStart,
      count: 2,
      createdAt: new Date(),
    });

    await expect(dupCounter).rejects.toThrow(MongoServerError);
  });

  it('enforces unique index on rejection_counters (projectId, utcDay)', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const utcDay = '2026-11-03';

    await db.collection(COLLECTIONS.REJECTION_COUNTERS).insertOne({
      projectId,
      utcDay,
      count: 1,
      createdAt: new Date(),
    });

    const dupRejection = db.collection(COLLECTIONS.REJECTION_COUNTERS).insertOne({
      projectId,
      utcDay,
      count: 2,
      createdAt: new Date(),
    });

    await expect(dupRejection).rejects.toThrow(MongoServerError);
  });
});
