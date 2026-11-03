import { Db } from 'mongodb';
import { COLLECTIONS } from './schema';

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
}
