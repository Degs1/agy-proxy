import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import {
  COLLECTIONS,
  ProjectDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  recordUsageLog,
  recordPreauthRejection,
  getMonitoringSummary,
} from '@/lib/monitoring/service';
import {
  UsageLogDocument,
  PreauthRejectionLogDocument,
  PreauthRejectionCounterDocument,
} from '@/lib/monitoring/schema';

describe('Usage & Preauth Logging, 1,000/min Rate Limit, 7-Day Retention & Resilience (TASK-062, Requirement 8)', () => {
  let replSet: MongoMemoryReplSet;
  let testProjectId: ObjectId;
  let testApiKeyId: ObjectId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_monitoring';

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testProjectId = new ObjectId();
    testApiKeyId = new ObjectId();

    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Monitoring Test Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
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
    const db = await getDatabase();
    await db.collection(COLLECTIONS.USAGE_LOGS).deleteMany({});
    await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).deleteMany({});
    await db.collection(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).deleteMany({});
  });

  describe('1. Authenticated Usage Logging (Requirement 8.1, 8.4)', () => {
    it('records complete operational metadata for successful request without leaking secrets or payload', async () => {
      const db = await getDatabase();
      const startTime = new Date();
      const durationMs = 245;

      await recordUsageLog(db, {
        requestId: 'req-uuid-12345',
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        model: 'gemini-default',
        provider: 'gemini',
        statusCode: 200,
        durationMs,
        result: 'success',
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        streaming: false,
        createdAt: startTime,
      });

      const logs = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).find({}).toArray();
      expect(logs).toHaveLength(1);
      const log = logs[0];

      expect(log.requestId).toBe('req-uuid-12345');
      expect(log.projectId.toString()).toBe(testProjectId.toString());
      expect(log.apiKeyId?.toString()).toBe(testApiKeyId.toString());
      expect(log.model).toBe('gemini-default');
      expect(log.provider).toBe('gemini');
      expect(log.statusCode).toBe(200);
      expect(log.durationMs).toBe(245);
      expect(log.result).toBe('success');
      expect(log.errorCode).toBeNull();
      expect(log.inputTokens).toBe(120);
      expect(log.outputTokens).toBe(45);
      expect(log.totalTokens).toBe(165);
      expect(log.streaming).toBe(false);

      // Zero-Plaintext-Recall validation: NO prompt, NO response body, NO auth secrets
      const rawDoc = log as Record<string, unknown>;
      expect(rawDoc.prompt).toBeUndefined();
      expect(rawDoc.messages).toBeUndefined();
      expect(rawDoc.response).toBeUndefined();
      expect(rawDoc.content).toBeUndefined();
      expect(rawDoc.secret).toBeUndefined();
      expect(rawDoc.apiKey).toBeUndefined();
      expect(rawDoc.bearerToken).toBeUndefined();
    });

    it('records partial metadata with null model/provider when request fails before resolution', async () => {
      const db = await getDatabase();
      const startTime = new Date();

      // Case: Validation failure on request body (invalid JSON or schema violation)
      await recordUsageLog(db, {
        requestId: 'req-val-fail-1',
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        model: null,
        provider: null,
        statusCode: 400,
        durationMs: 12,
        result: 'error',
        errorCode: 'invalid_request',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        streaming: false,
        createdAt: startTime,
      });

      const logs = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).find({}).toArray();
      expect(logs).toHaveLength(1);
      const log = logs[0];

      expect(log.projectId.toString()).toBe(testProjectId.toString());
      expect(log.model).toBeNull();
      expect(log.provider).toBeNull();
      expect(log.statusCode).toBe(400);
      expect(log.errorCode).toBe('invalid_request');
      expect(log.inputTokens).toBeNull();
      expect(log.outputTokens).toBeNull();
      expect(log.totalTokens).toBeNull();
    });

    it('records unmeasured token usage as null, never as 0 (Requirement 8.3)', async () => {
      const db = await getDatabase();
      const startTime = new Date();

      await recordUsageLog(db, {
        requestId: 'req-no-tokens',
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        model: 'gemini-default',
        provider: 'gemini',
        statusCode: 200,
        durationMs: 310,
        result: 'success',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        streaming: true,
        createdAt: startTime,
      });

      const log = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).findOne({ requestId: 'req-no-tokens' });
      expect(log).not.toBeNull();
      expect(log?.inputTokens).toBeNull();
      expect(log?.outputTokens).toBeNull();
      expect(log?.totalTokens).toBeNull();
      expect(log?.inputTokens).not.toBe(0);
      expect(log?.outputTokens).not.toBe(0);
      expect(log?.totalTokens).not.toBe(0);
    });
  });

  describe('2. Pre-authentication Rejection Logging (Requirement 8.1, 8.4)', () => {
    it('records pre-auth rejection in separate collection with null project/model/provider/tokens', async () => {
      const db = await getDatabase();
      const startTime = new Date();

      await recordPreauthRejection(db, {
        startTime,
        durationMs: 5,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        requestId: 'req-preauth-401',
      });

      const preauthLogs = await db.collection<PreauthRejectionLogDocument>(COLLECTIONS.PREAUTH_REJECTION_LOGS).find({}).toArray();
      expect(preauthLogs).toHaveLength(1);
      const log = preauthLogs[0];

      expect(log.statusCode).toBe(401);
      expect(log.errorCode).toBe('invalid_api_key');
      expect(log.durationMs).toBe(5);
      expect(log.projectId).toBeNull();
      expect(log.model).toBeNull();
      expect(log.provider).toBeNull();
      expect(log.inputTokens).toBeNull();
      expect(log.outputTokens).toBeNull();
      expect(log.totalTokens).toBeNull();

      // Zero-Plaintext-Recall: ensure no auth tokens or headers stored
      const rawDoc = log as Record<string, unknown>;
      expect(rawDoc.authorization).toBeUndefined();
      expect(rawDoc.bearer).toBeUndefined();
      expect(rawDoc.key).toBeUndefined();
    });
  });

  describe('3. Rate Limit 1,000 Logs per UTC Minute Across Instances (Requirement 8.1)', () => {
    it('strictly caps preauth rejection individual logs at 1,000 per UTC minute', async () => {
      const db = await getDatabase();
      const fixedMinute = new Date('2026-11-04T10:15:00.000Z');

      // Pre-seed counter to 998 for fixedMinute to test the boundary
      await db.collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).insertOne({
        utcMinute: fixedMinute,
        count: 998,
        createdAt: fixedMinute,
      });

      // 999th attempt: Should be recorded
      const res999 = await recordPreauthRejection(db, {
        startTime: new Date('2026-11-04T10:15:10.000Z'),
        durationMs: 2,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        overrideMinute: fixedMinute,
      });
      expect(res999.recorded).toBe(true);

      // 1000th attempt: Should be recorded (hits exact limit)
      const res1000 = await recordPreauthRejection(db, {
        startTime: new Date('2026-11-04T10:15:20.000Z'),
        durationMs: 2,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        overrideMinute: fixedMinute,
      });
      expect(res1000.recorded).toBe(true);

      // 1001st attempt: Exceeds 1,000 - MUST NOT record individual log
      const res1001 = await recordPreauthRejection(db, {
        startTime: new Date('2026-11-04T10:15:30.000Z'),
        durationMs: 2,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        overrideMinute: fixedMinute,
      });
      expect(res1001.recorded).toBe(false);

      // 1002nd attempt: Exceeds 1,000 - MUST NOT record individual log
      const res1002 = await recordPreauthRejection(db, {
        startTime: new Date('2026-11-04T10:15:40.000Z'),
        durationMs: 2,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        overrideMinute: fixedMinute,
      });
      expect(res1002.recorded).toBe(false);

      // Check database: only exactly 2 individual logs inserted (for 999 and 1000)
      const totalLogs = await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).countDocuments();
      expect(totalLogs).toBe(2);

      // Verify next minute resets limit and allows recording again
      const nextMinute = new Date('2026-11-04T10:16:00.000Z');
      const resNextMin = await recordPreauthRejection(db, {
        startTime: new Date('2026-11-04T10:16:05.000Z'),
        durationMs: 3,
        statusCode: 401,
        errorCode: 'invalid_api_key',
        overrideMinute: nextMinute,
      });
      expect(resNextMin.recorded).toBe(true);
      const totalLogsAfterNextMin = await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).countDocuments();
      expect(totalLogsAfterNextMin).toBe(3);
    });

    it('coordinates atomic increments across concurrent simulated instances', async () => {
      const db = await getDatabase();
      const concurrentMinute = new Date('2026-11-04T11:00:00.000Z');

      // Pre-seed at 980
      await db.collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).insertOne({
        utcMinute: concurrentMinute,
        count: 980,
        createdAt: concurrentMinute,
      });

      // Fire 30 concurrent rejections (slots available: 981 to 1000 = 20 slots; 10 should be rejected)
      const promises = Array.from({ length: 30 }, (_, i) =>
        recordPreauthRejection(db, {
          startTime: new Date('2026-11-04T11:00:10.000Z'),
          durationMs: 2,
          statusCode: 401,
          errorCode: 'invalid_api_key',
          overrideMinute: concurrentMinute,
          requestId: `concurrent-${i}`,
        })
      );

      const results = await Promise.all(promises);
      const recordedCount = results.filter((r) => r.recorded).length;
      const suppressedCount = results.filter((r) => !r.recorded).length;

      expect(recordedCount).toBe(20);
      expect(suppressedCount).toBe(10);

      const logsInDb = await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).countDocuments();
      expect(logsInDb).toBe(20);
    });
  });

  describe('4. 7-Day Retention Policy (Requirement 8.1)', () => {
    it('sets expiresAt exactly 7 days (604,800,000 ms) after createdAt', async () => {
      const db = await getDatabase();
      const now = new Date('2026-11-04T12:00:00.000Z');

      await recordUsageLog(db, {
        requestId: 'retention-test-1',
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        model: 'gemini-default',
        provider: 'gemini',
        statusCode: 200,
        durationMs: 150,
        result: 'success',
        streaming: false,
        createdAt: now,
      });

      await recordPreauthRejection(db, {
        startTime: now,
        durationMs: 4,
        statusCode: 401,
        errorCode: 'invalid_api_key',
      });

      const usageLog = await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).findOne({ requestId: 'retention-test-1' });
      expect(usageLog).not.toBeNull();
      const expectedUsageExpires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      expect(usageLog?.expiresAt.getTime()).toBe(expectedUsageExpires.getTime());

      const preauthLog = await db.collection<PreauthRejectionLogDocument>(COLLECTIONS.PREAUTH_REJECTION_LOGS).findOne({});
      expect(preauthLog).not.toBeNull();
      const expectedPreauthExpires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      expect(preauthLog?.expiresAt.getTime()).toBe(expectedPreauthExpires.getTime());
    });

    it('verifies TTL indexes on USAGE_LOGS and PREAUTH_REJECTION_LOGS collections', async () => {
      const db = await getDatabase();
      const usageIndexes = await db.collection(COLLECTIONS.USAGE_LOGS).indexes();
      const usageTtl = usageIndexes.find((idx: { name?: string; key?: unknown; expireAfterSeconds?: number }) => idx.name === 'ttl_usage_logs_7d');
      expect(usageTtl).toBeDefined();
      expect(usageTtl?.key).toEqual({ expiresAt: 1 });
      expect(usageTtl?.expireAfterSeconds).toBe(0);

      const preauthIndexes = await db.collection(COLLECTIONS.PREAUTH_REJECTION_LOGS).indexes();
      const preauthTtl = preauthIndexes.find((idx: { name?: string; key?: unknown; expireAfterSeconds?: number }) => idx.name === 'ttl_preauth_rejection_logs_7d');
      expect(preauthTtl).toBeDefined();
      expect(preauthTtl?.key).toEqual({ expiresAt: 1 });
      expect(preauthTtl?.expireAfterSeconds).toBe(0);
    });
  });

  describe('5. Logging Resilience to Database Failures (Requirement 8.1, AC 16.3)', () => {
    it('recordUsageLog does not throw when database insert fails', async () => {
      // Mock db object that throws on insertOne
      const brokenDb = {
        collection: () => ({
          insertOne: async () => {
            throw new Error('MongoWriteConcernError: Atlas connection lost');
          },
        }),
      } as any;

      // Must NOT throw
      await expect(
        recordUsageLog(brokenDb, {
          requestId: 'fail-resilience-1',
          projectId: testProjectId,
          apiKeyId: testApiKeyId,
          statusCode: 200,
          durationMs: 100,
          result: 'success',
          streaming: false,
          createdAt: new Date(),
        })
      ).resolves.not.toThrow();
    });

    it('recordPreauthRejection does not throw when database fails', async () => {
      const brokenDb = {
        collection: () => ({
          findOneAndUpdate: async () => {
            throw new Error('MongoNetworkTimeoutError: Atlas primary election');
          },
          insertOne: async () => {
            throw new Error('MongoNetworkTimeoutError');
          },
        }),
      } as any;

      const result = await recordPreauthRejection(brokenDb, {
        startTime: new Date(),
        durationMs: 5,
        statusCode: 401,
        errorCode: 'invalid_api_key',
      });

      expect(result.recorded).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
