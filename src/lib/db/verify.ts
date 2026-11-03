import { Db, ObjectId, MongoServerError } from 'mongodb';
import { getDatabase, getMongoClient, withTransaction, closeDatabaseConnection } from './client';
import { getDatabaseConfig, maskMongoUri, sanitizeDiagnosticText } from './config';
import {
  verifyDatabaseIndexes,
  assertAdmissionIndexesReady,
  initDatabaseIndexes,
  IndexVerificationResult,
} from './indexes';
import { COLLECTIONS } from './schema';

export interface VerificationResult {
  success: boolean;
  sanitizedUri: string;
  checks: {
    connectionPing: boolean;
    requiredIndexes: boolean;
    transactionCommit: boolean;
    transactionRollback: boolean;
    uniqueConstraintEnforcement: boolean;
  };
  indexVerification: IndexVerificationResult;
  diagnostics?: string;
}

/**
 * Perform end-to-end integration verification against a target MongoDB (e.g. MongoDB Atlas cluster).
 * Tests connectivity, index presence, transaction commit/rollback atomicity, and unique index constraint enforcement.
 * Guarantees zero secret leakage in all outputs and error messages.
 */
export async function runDatabaseVerification(options?: {
  autoInitIfMissing?: boolean;
}): Promise<VerificationResult> {
  const config = getDatabaseConfig();
  const maskedUri = maskMongoUri(config.uri);

  const checks = {
    connectionPing: false,
    requiredIndexes: false,
    transactionCommit: false,
    transactionRollback: false,
    uniqueConstraintEnforcement: false,
  };

  const db = await getDatabase();

  // 1. Connection Ping
  await db.command({ ping: 1 });
  checks.connectionPing = true;

  // 2. Check indexes
  let indexStatus = await verifyDatabaseIndexes(db);
  if (!indexStatus.ready && options?.autoInitIfMissing) {
    await initDatabaseIndexes(db);
    indexStatus = await verifyDatabaseIndexes(db);
  }
  checks.requiredIndexes = indexStatus.ready;

  if (checks.requiredIndexes) {
    await assertAdmissionIndexesReady(db);
  }

  // 3. Multi-document Transaction Commit
  const testProjectId = new ObjectId();
  const testApiKeyId = new ObjectId();
  const testRequestId = `verify-tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await withTransaction(async (session) => {
    await db.collection(COLLECTIONS.PROJECTS).insertOne(
      {
        _id: testProjectId,
        name: 'Verification Test Project',
        status: 'active',
        rpmLimit: 60,
        concurrencyLimit: 5,
        allowedModels: ['gemini-default'],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { session }
    );
  });

  const committedProject = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: testProjectId });
  if (committedProject) {
    checks.transactionCommit = true;
    // Clean up committed test project
    await db.collection(COLLECTIONS.PROJECTS).deleteOne({ _id: testProjectId });
  }

  // 4. Multi-document Transaction Rollback
  const rollbackProjectId = new ObjectId();
  try {
    await withTransaction(async (session) => {
      await db.collection(COLLECTIONS.PROJECTS).insertOne(
        {
          _id: rollbackProjectId,
          name: 'Rollback Test Project',
          status: 'active',
          rpmLimit: 60,
          concurrencyLimit: 5,
          allowedModels: ['gemini-default'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { session }
      );
      throw new Error('SIMULATED_ABORT_FOR_VERIFICATION');
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'SIMULATED_ABORT_FOR_VERIFICATION') {
      const rolledBack = await db.collection(COLLECTIONS.PROJECTS).findOne({ _id: rollbackProjectId });
      if (!rolledBack) {
        checks.transactionRollback = true;
      }
    } else {
      throw err;
    }
  }

  // 5. Unique Index Constraint Enforcement on Admission Decisions
  if (checks.requiredIndexes) {
    const admissionDoc = {
      projectId: testProjectId,
      apiKeyId: testApiKeyId,
      requestId: testRequestId,
      attemptId: 'att-verify-1',
      payloadFingerprint: 'fp-verify-1',
      status: 'running' as const,
      createdAt: new Date(),
      dedupeUntil: new Date(Date.now() + 60000),
    };

    // First insert succeeds
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne(admissionDoc);

    // Duplicate insert MUST fail with code 11000
    try {
      await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne(admissionDoc);
      checks.uniqueConstraintEnforcement = false;
    } catch (err: unknown) {
      if (err instanceof MongoServerError && err.code === 11000) {
        checks.uniqueConstraintEnforcement = true;
      } else {
        checks.uniqueConstraintEnforcement = false;
      }
    } finally {
      // Clean up test document
      await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteOne({
        projectId: testProjectId,
        apiKeyId: testApiKeyId,
        requestId: testRequestId,
      });
    }
  }

  const success =
    checks.connectionPing &&
    checks.requiredIndexes &&
    checks.transactionCommit &&
    checks.transactionRollback &&
    checks.uniqueConstraintEnforcement;

  return {
    success,
    sanitizedUri: maskedUri,
    checks,
    indexVerification: indexStatus,
  };
}

// Support direct CLI invocation: tsx src/lib/db/verify.ts
if (typeof require !== 'undefined' && require.main === module) {
  const autoInit = process.argv.includes('--init');

  runDatabaseVerification({ autoInitIfMissing: autoInit })
    .then((result) => {
      console.log('=== Database Verification Report ===');
      console.log(`Target URI: ${result.sanitizedUri}`);
      console.log(`Connection Ping: ${result.checks.connectionPing ? 'PASS' : 'FAIL'}`);
      console.log(`Required Indexes: ${result.checks.requiredIndexes ? 'PASS' : 'FAIL'}`);
      if (!result.checks.requiredIndexes) {
        console.log(`Missing Indexes (${result.indexVerification.missing.length}):`);
        result.indexVerification.missing.forEach((idx) => console.log(`  - ${idx}`));
        console.log("Tip: Run 'npm run db:init' to create required indexes.");
      }
      console.log(`Transaction Commit: ${result.checks.transactionCommit ? 'PASS' : 'FAIL'}`);
      console.log(`Transaction Rollback: ${result.checks.transactionRollback ? 'PASS' : 'FAIL'}`);
      console.log(`Unique Constraint: ${result.checks.uniqueConstraintEnforcement ? 'PASS' : 'FAIL'}`);
      console.log(`Overall Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);

      closeDatabaseConnection().then(() => {
        process.exit(result.success ? 0 : 1);
      });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Database verification failed:', sanitizeDiagnosticText(msg));
      closeDatabaseConnection().then(() => {
        process.exit(1);
      });
    });
}
