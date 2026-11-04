import { Db } from 'mongodb';
import { COLLECTIONS } from './schema';

export class DatabaseIndexError extends Error {
  public readonly code = 'INDEXES_NOT_INITIALIZED';
  public readonly missingIndexes: string[];

  constructor(message: string, missingIndexes: string[] = []) {
    super(message);
    this.name = 'DatabaseIndexError';
    this.missingIndexes = missingIndexes;
  }
}

export interface RequiredIndexSpec {
  collection: string;
  name: string;
  unique?: boolean;
  ttlSeconds?: number;
  description: string;
}

/**
 * Core unique indexes and identity constraints required for safe operation.
 * Absence of any of these indexes compromises data integrity (e.g. duplicate admission decisions).
 */
export const CRITICAL_REQUIRED_INDEXES: readonly RequiredIndexSpec[] = [
  {
    collection: COLLECTIONS.ADMISSION_DECISIONS,
    name: 'uniq_admission_decision_identity',
    unique: true,
    description: 'Prevents duplicate admission decisions for same project, apiKeyId, requestId',
  },
  {
    collection: COLLECTIONS.ADMISSION_INTENTS,
    name: 'uniq_admission_intent_identity',
    unique: true,
    description: 'Prevents duplicate concurrent admission claims',
  },
  {
    collection: COLLECTIONS.RATE_COUNTERS,
    name: 'uniq_project_rate_window',
    unique: true,
    description: 'Enforces atomic rate limit fixed window uniqueness per project',
  },
  {
    collection: COLLECTIONS.CONCURRENCY_LEASES,
    name: 'uniq_concurrency_lease_id',
    unique: true,
    description: 'Enforces concurrency lease identity uniqueness',
  },
  {
    collection: COLLECTIONS.API_KEYS,
    name: 'uniq_api_key_hash',
    unique: true,
    description: 'Enforces API key hash uniqueness across projects',
  },
  {
    collection: COLLECTIONS.ADMINS,
    name: 'uniq_admin_email',
    unique: true,
    description: 'Enforces admin email identity uniqueness',
  },
  {
    collection: COLLECTIONS.ADMIN_SESSIONS,
    name: 'uniq_admin_session_token',
    unique: true,
    description: 'Enforces session token hash uniqueness',
  },
] as const;

/**
 * Initialize all database indexes across MongoDB collections.
 * Operations are idempotent (MongoDB createIndex creates only if missing).
 *
 * NOTE: Collections and indexes are PROVISIONAL pending formal audit approval
 * on TASK-090 (TASK-004 request changes).
 */
export async function initDatabaseIndexes(db: Db): Promise<void> {
  // 1. Admission Decisions
  // Requirement 1 AC 3: Unique index SHALL prevent more than one admission decision
  // for the same combination of project, API key identity, and request identity.
  await db.collection(COLLECTIONS.ADMISSION_DECISIONS).createIndex(
    { projectId: 1, apiKeyId: 1, requestId: 1 },
    { unique: true, name: 'uniq_admission_decision_identity' }
  );
  await db.collection(COLLECTIONS.ADMISSION_DECISIONS).createIndex(
    { dedupeUntil: 1 },
    { expireAfterSeconds: 0, name: 'ttl_admission_decision_dedupe' }
  );

  // 2. Admission Intents
  await db.collection(COLLECTIONS.ADMISSION_INTENTS).createIndex(
    { projectId: 1, apiKeyId: 1, requestId: 1 },
    { unique: true, name: 'uniq_admission_intent_identity' }
  );

  // 3. Admins
  await db.collection(COLLECTIONS.ADMINS).createIndex(
    { email: 1 },
    { unique: true, name: 'uniq_admin_email' }
  );

  // 4. Admin Sessions
  await db.collection(COLLECTIONS.ADMIN_SESSIONS).createIndex(
    { sessionTokenHash: 1 },
    { unique: true, name: 'uniq_admin_session_token' }
  );
  await db.collection(COLLECTIONS.ADMIN_SESSIONS).createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'ttl_admin_session_expiry' }
  );

  // 5. Login Failures & Rate Limit
  await db.collection(COLLECTIONS.LOGIN_FAILURES).createIndex(
    { type: 1, identifier: 1 },
    { unique: true, name: 'uniq_login_failure_identity' }
  );

  // 6. Projects
  await db.collection(COLLECTIONS.PROJECTS).createIndex(
    { status: 1 },
    { name: 'idx_project_status' }
  );

  // 7. API Keys
  await db.collection(COLLECTIONS.API_KEYS).createIndex(
    { keyHash: 1 },
    { unique: true, name: 'uniq_api_key_hash' }
  );
  await db.collection(COLLECTIONS.API_KEYS).createIndex(
    { projectId: 1, status: 1 },
    { name: 'idx_api_key_project_status' }
  );

  // 8. Provider Credentials
  await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).createIndex(
    { projectId: 1, status: 1 },
    { name: 'idx_provider_cred_project_status' }
  );

  // 9. Model Aliases
  await db.collection(COLLECTIONS.MODEL_ALIASES).createIndex(
    { projectId: 1, alias: 1 },
    { unique: true, name: 'uniq_project_model_alias' }
  );

  // 10. Rate Counters (Fixed window 1-minute UTC per project)
  await db.collection(COLLECTIONS.RATE_COUNTERS).createIndex(
    { projectId: 1, windowStart: 1 },
    { unique: true, name: 'uniq_project_rate_window' }
  );
  await db.collection(COLLECTIONS.RATE_COUNTERS).createIndex(
    { windowStart: 1 },
    { expireAfterSeconds: 86400, name: 'ttl_rate_counter_24h' }
  );

  // 11. Rejection Counters (Max 1000 per project per UTC day)
  await db.collection(COLLECTIONS.REJECTION_COUNTERS).createIndex(
    { projectId: 1, utcDay: 1 },
    { unique: true, name: 'uniq_project_rejection_day' }
  );
  await db.collection(COLLECTIONS.REJECTION_COUNTERS).createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 604800, name: 'ttl_rejection_counter_7d' }
  );

  // 12. Concurrency Leases
  await db.collection(COLLECTIONS.CONCURRENCY_LEASES).createIndex(
    { leaseId: 1 },
    { unique: true, name: 'uniq_concurrency_lease_id' }
  );
  await db.collection(COLLECTIONS.CONCURRENCY_LEASES).createIndex(
    { projectId: 1, expiresAt: 1 },
    { name: 'idx_concurrency_lease_project_expiry' }
  );
  await db.collection(COLLECTIONS.CONCURRENCY_LEASES).createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 300, name: 'ttl_concurrency_lease_fallback' }
  );

  // 13. Usage Records
  await db.collection(COLLECTIONS.USAGE_RECORDS).createIndex(
    { projectId: 1, createdAt: -1 },
    { name: 'idx_usage_project_created' }
  );
  await db.collection(COLLECTIONS.USAGE_RECORDS).createIndex(
    { createdAt: -1 },
    { name: 'idx_usage_created' }
  );
  await db.collection(COLLECTIONS.USAGE_RECORDS).createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'ttl_usage_retention' }
  );

  // 14. Preauth Rejection Counters
  await db.collection(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).createIndex(
    { utcMinute: 1 },
    { unique: true, name: 'uniq_preauth_rejection_minute' }
  );
  await db.collection(COLLECTIONS.PREAUTH_REJECTION_COUNTERS).createIndex(
    { utcMinute: 1 },
    { expireAfterSeconds: 604800, name: 'ttl_preauth_rejection_7d' }
  );

  // 15. Worker Heartbeats & Health Telemetry
  await db.collection(COLLECTIONS.WORKER_HEARTBEATS).createIndex(
    { workerType: 1, instanceId: 1 },
    { unique: true, name: 'uniq_worker_instance' }
  );
  await db.collection(COLLECTIONS.WORKER_HEARTBEATS).createIndex(
    { lastHeartbeatAt: 1 },
    { name: 'idx_worker_heartbeat_time' }
  );
  await db.collection(COLLECTIONS.WORKER_HEARTBEATS).createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 604800, name: 'ttl_worker_heartbeats_7d' }
  );
}

export interface IndexVerificationResult {
  ready: boolean;
  missing: string[];
  present: string[];
}

/**
 * Verify whether all critical database indexes exist on the target MongoDB database.
 * Returns ready: false if collections are fresh/empty and indexes have not yet been initialized.
 */
export async function verifyDatabaseIndexes(db: Db): Promise<IndexVerificationResult> {
  const missing: string[] = [];
  const present: string[] = [];

  for (const spec of CRITICAL_REQUIRED_INDEXES) {
    try {
      const existingIndexes = await db.collection(spec.collection).indexes();
      const hasIndex = existingIndexes.some((idx) => idx.name === spec.name);
      if (hasIndex) {
        present.push(`${spec.collection}.${spec.name}`);
      } else {
        missing.push(`${spec.collection}.${spec.name}`);
      }
    } catch {
      // Collection does not exist or namespace not found -> index is missing
      missing.push(`${spec.collection}.${spec.name}`);
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    present,
  };
}

/**
 * Assert that critical admission unique indexes are present before allowing admission operations.
 * Throws DatabaseIndexError when indexes are missing to prevent duplicate decisions on uninitialized databases.
 */
export async function assertAdmissionIndexesReady(db: Db): Promise<void> {
  try {
    const existing = await db.collection(COLLECTIONS.ADMISSION_DECISIONS).indexes();
    const hasUniqDecision = existing.some(
      (idx) => idx.name === 'uniq_admission_decision_identity' && idx.unique === true
    );

    if (!hasUniqDecision) {
      throw new DatabaseIndexError(
        "Database initialization incomplete: Required unique index 'uniq_admission_decision_identity' is missing. Operations requiring Atlas fail safely to prevent duplicate admission decisions.",
        [`${COLLECTIONS.ADMISSION_DECISIONS}.uniq_admission_decision_identity`]
      );
    }
  } catch (err: unknown) {
    if (err instanceof DatabaseIndexError) {
      throw err;
    }
    // Collection does not exist yet
    throw new DatabaseIndexError(
      "Database initialization incomplete: Required unique index 'uniq_admission_decision_identity' is missing. Operations requiring Atlas fail safely to prevent duplicate admission decisions.",
      [`${COLLECTIONS.ADMISSION_DECISIONS}.uniq_admission_decision_identity`]
    );
  }
}
