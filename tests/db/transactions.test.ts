import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  getDatabase,
  getMongoClient,
  closeDatabaseConnection,
  withTransaction,
} from '@/lib/db/client';
import { COLLECTIONS } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { ObjectId, ReadConcern, WriteConcern, ReadPreference } from 'mongodb';

describe('MongoDB Transactions Support (Requirement 1, AC 1 & AC 3)', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_tx';
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
    // Clear test collections
    await db.collection(COLLECTIONS.PROJECTS).deleteMany({});
    await db.collection(COLLECTIONS.RATE_COUNTERS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteMany({});
  });

  it('successfully commits multi-document operations atomically in a transaction', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const apiKeyId = new ObjectId();
    const requestId = 'req-tx-commit-001';

    await withTransaction(async (session) => {
      // Operation 1: Insert project
      await db.collection(COLLECTIONS.PROJECTS).insertOne(
        {
          _id: projectId,
          name: 'Transaction Project',
          status: 'active',
          rpmLimit: 60,
          concurrencyLimit: 5,
          allowedModels: ['gemini-default'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { session }
      );

      // Operation 2: Insert rate counter
      await db.collection(COLLECTIONS.RATE_COUNTERS).insertOne(
        {
          projectId,
          windowStart: new Date('2026-11-03T20:00:00.000Z'),
          count: 1,
          createdAt: new Date(),
        },
        { session }
      );

      // Operation 3: Insert admission decision
      await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne(
        {
          projectId,
          apiKeyId,
          requestId,
          attemptId: 'att-001',
          payloadFingerprint: 'fp-1234',
          status: 'running',
          createdAt: new Date(),
          dedupeUntil: new Date(Date.now() + 86400000),
        },
        { session }
      );
    });

    // Verify all 3 documents exist outside the transaction
    const project = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: projectId });
    const counter = await db.collection(COLLECTIONS.RATE_COUNTERS).findOne({ projectId });
    const decision = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).findOne({ requestId });

    expect(project).not.toBeNull();
    expect(counter).not.toBeNull();
    expect(decision).not.toBeNull();
  });

  it('rolls back all operations if an error occurs within the transaction', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const apiKeyId = new ObjectId();
    const requestId = 'req-tx-rollback-001';

    const txPromise = withTransaction(async (session) => {
      await db.collection(COLLECTIONS.PROJECTS).insertOne(
        {
          _id: projectId,
          name: 'Rollback Project',
          status: 'active',
          rpmLimit: 60,
          concurrencyLimit: 5,
          allowedModels: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { session }
      );

      await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne(
        {
          projectId,
          apiKeyId,
          requestId,
          attemptId: 'att-rollback',
          payloadFingerprint: 'fp-rollback',
          status: 'running',
          createdAt: new Date(),
          dedupeUntil: new Date(Date.now() + 86400000),
        },
        { session }
      );

      // Explicitly simulate failure inside transaction
      throw new Error('Simulated upstream failure before commit');
    });

    await expect(txPromise).rejects.toThrow('Simulated upstream failure before commit');

    // Verify rollback: NEITHER document was committed!
    const project = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: projectId });
    const decision = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).findOne({ requestId });

    expect(project).toBeNull();
    expect(decision).toBeNull();
  });

  it('strictly enforces snapshot read concern, majority write concern, and primary read preference', async () => {
    const client = await getMongoClient();
    const originalStartSession = client.startSession.bind(client);

    let capturedOptions: any = undefined;

    vi.spyOn(client, 'startSession').mockImplementation((...args) => {
      const session = originalStartSession(...args);
      const originalWithTransaction = session.withTransaction.bind(session);
      vi.spyOn(session, 'withTransaction').mockImplementation(async (fn, txOpts) => {
        capturedOptions = txOpts;
        return originalWithTransaction(fn, txOpts);
      });
      return session;
    });

    const db = await getDatabase();
    await withTransaction(
      async (session) => {
        await db.collection(COLLECTIONS.PROJECTS).insertOne(
          {
            name: 'Options Enforcement Project',
            status: 'active',
            rpmLimit: 60,
            concurrencyLimit: 5,
            allowedModels: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          { session }
        );
      },
      // Attempt to weaken the contract options
      {
        transactionOptions: {
          readConcern: new ReadConcern('local'),
          writeConcern: new WriteConcern(1),
          readPreference: ReadPreference.secondary,
        } as any,
      }
    );

    expect(capturedOptions).toBeDefined();
    // readConcern must be snapshot, not caller-overridden 'local'
    expect(capturedOptions.readConcern.level).toBe('snapshot');
    // writeConcern must be majority, not caller-overridden 1
    expect(capturedOptions.writeConcern.w).toBe('majority');
    // readPreference must be primary, not caller-overridden 'secondary'
    expect(capturedOptions.readPreference.mode).toBe('primary');

    vi.restoreAllMocks();
  });

  it('guarantees snapshot isolation when sequential transactions update counters', async () => {
    const db = await getDatabase();
    const projectId = new ObjectId();
    const windowStart = new Date('2026-11-03T21:00:00.000Z');

    // Seed initial counter
    await db.collection(COLLECTIONS.RATE_COUNTERS).insertOne({
      projectId,
      windowStart,
      count: 0,
      createdAt: new Date(),
    });

    await withTransaction(async (session) => {
      await db.collection(COLLECTIONS.RATE_COUNTERS).updateOne(
        { projectId, windowStart },
        { $inc: { count: 1 } },
        { session }
      );
    });

    await withTransaction(async (session) => {
      await db.collection(COLLECTIONS.RATE_COUNTERS).updateOne(
        { projectId, windowStart },
        { $inc: { count: 1 } },
        { session }
      );
    });

    const finalCounter = await db
      .collection(COLLECTIONS.RATE_COUNTERS)
      .findOne({ projectId, windowStart });
    expect(finalCounter?.count).toBe(2);
  });
});
