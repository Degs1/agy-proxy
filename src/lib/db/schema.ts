import { ObjectId } from 'mongodb';

/**
 * PROVISIONAL DATA MODELS & COLLECTIONS
 *
 * NOTE: The following collection definitions and interfaces are PROVISIONAL.
 * Contract MVP audit is in progress under TASK-090 (following TASK-004 request changes).
 * This schema is NOT frozen and NOT approved. Changes may occur once TASK-090 audit completes.
 */

export const COLLECTIONS = {
  BOOTSTRAP_GUARD: 'bootstrap_guard',
  ADMINS: 'admins',
  ADMIN_SESSIONS: 'admin_sessions',
  LOGIN_FAILURES: 'login_failures',
  PROJECTS: 'projects',
  API_KEYS: 'api_keys',
  PROVIDER_CREDENTIALS: 'provider_credentials',
  MODEL_ALIASES: 'model_aliases',
  PROJECT_LIMITER_GUARDS: 'project_limiter_guards',
  RATE_COUNTERS: 'rate_counters',
  REJECTION_COUNTERS: 'rejection_counters',
  ADMISSION_INTENTS: 'admission_intents',
  ADMISSION_DECISIONS: 'admission_decisions',
  CONCURRENCY_LEASES: 'concurrency_leases',
  USAGE_RECORDS: 'usage_records',
  USAGE_LOGS: 'usage_logs',
  PREAUTH_REJECTION_COUNTERS: 'preauth_rejection_counters',
  PREAUTH_REJECTION_LOGS: 'preauth_rejection_logs',
  WORKER_HEARTBEATS: 'worker_heartbeats',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

// 1. Bootstrap Guard
export interface BootstrapGuardDocument {
  _id: string; // Fixed ID e.g. "bootstrap_singleton"
  bootstrappedAt: Date;
  initialAdminEmail: string;
}

// 2. Admins
export interface AdminDocument {
  _id?: ObjectId;
  email: string; // Canonical lowercase normalized
  passwordHash: string; // Argon2id hash
  role: 'admin';
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

// 3. Admin Sessions
export interface AdminSessionDocument {
  _id?: ObjectId;
  sessionTokenHash: string; // SHA-256 hash of random session secret
  adminId: ObjectId;
  createdAt: Date;
  expiresAt: Date; // Absolute expiration (e.g. 12 hours)
  lastActivityAt: Date; // Idle timeout tracking (30 minutes)
  isRevoked: boolean;
  csrfTokenHash: string; // Hash of current active session CSRF token
}

// 4. Login Failures & Rate Limit
export interface LoginFailureReservation {
  attemptId: string;
  expiresAt: Date;
}

export interface LoginFailureDocument {
  _id?: ObjectId;
  type: 'email' | 'ip';
  identifier: string; // Normalized email or canonical IP
  failureTimestamps: Date[];
  activeReservations: LoginFailureReservation[];
  updatedAt: Date;
}

// 5. Projects
export interface ProjectDocument {
  _id?: ObjectId;
  name: string;
  description?: string;
  status: 'active' | 'disabled';
  rpmLimit: number; // Default 60
  concurrencyLimit: number; // Default 5
  allowedModels: string[]; // Allowed alias identifiers
  createdAt: Date;
  updatedAt: Date;
}

// 6. API Keys
export interface ApiKeyDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  name: string;
  keyPrefix: string; // e.g. agw_xxxx (first 8 chars)
  keyHash: string; // SHA-256 hash of full bearer secret
  status: 'active' | 'revoked';
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
}

// 7. Provider Credentials
export interface EncryptedCredentialPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export interface ProviderCredentialDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  provider: 'gemini' | string;
  displayName: string;
  credentialType: 'api_key' | 'oauth';
  encryptedCredentials: EncryptedCredentialPayload;
  status: 'active' | 'disabled' | 'cooldown' | 'reauth_required' | 'unsupported' | 'error';
  expiresAt?: Date;
  maxConcurrent?: number;
  lastUsedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

// 8. Model Aliases
export interface ModelAliasDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  alias: string; // e.g. "gemini-default"
  upstreamModel: string; // e.g. "gemini-2.5-flash"
  boundCredentialId: ObjectId; // Explicit binding to a provider credential
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

// 9. Project Limiter Guard
export interface ProjectLimiterGuardDocument {
  _id: ObjectId; // Matches projectId
  revision: number;
  last_server_time: Date;
}

// 10. Rate Counters
export interface RateCounterDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  windowStart: Date; // UTC minute start
  count: number;
  createdAt: Date;
}

// 11. Rejection Counters
export interface RejectionCounterDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  utcDay: string; // YYYY-MM-DD
  count: number;
  createdAt: Date;
}

// 12. Admission Intents
export interface AdmissionIntentDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  apiKeyId: ObjectId;
  requestId: string; // UUID from client Idempotency-Key
  attemptId: string;
  generation: number;
  status: 'pending' | 'committed' | 'terminal';
  claimedAt: Date;
  claimExpiresAt: Date;
  fencedAt?: Date;
  fencedAttemptId?: string;
  committedAt?: Date;
  lastVerifiedAt?: Date;
  dedupeUntil?: Date;
}

// 13. Admission Decisions
export type AdmissionDecisionStatus =
  | 'running'
  | 'rejected'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lease_expired';

export type DispatchStatus = 'undispatched' | 'dispatching' | 'dispatched';

export interface AdmissionDecisionOutcome {
  status: AdmissionDecisionStatus;
  originalHttpStatus: number;
  originalErrorCode?: string | null;
  completedAt: Date;
}

export interface AdmissionDecisionDocument {
  _id?: ObjectId;
  projectId: ObjectId;
  apiKeyId: ObjectId;
  requestId: string;
  attemptId: string;
  payloadFingerprint: string;
  status: AdmissionDecisionStatus;
  dispatchStatus?: DispatchStatus;
  dispatchedAt?: Date;
  createdAt: Date;
  terminalAt?: Date;
  dedupeUntil: Date;
  outcome?: AdmissionDecisionOutcome;
}

// 14. Concurrency Leases
export interface ConcurrencyLeaseDocument {
  _id?: ObjectId;
  leaseId: string;
  projectId: ObjectId;
  decisionId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
}

// 15. Usage Records (Operational Telemetry)
export interface UsageRecordDocument {
  _id?: ObjectId;
  requestId: string;
  projectId: ObjectId;
  apiKeyId: ObjectId;
  alias?: string | null;
  provider?: string | null;
  statusCode: number;
  errorCode?: string | null;
  latencyMs: number;
  streaming: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  createdAt: Date;
  expiresAt: Date; // For 30-day TTL cleanup
}

export interface UsageLogDocument {
  _id?: ObjectId;
  requestId?: string | null;
  projectId: ObjectId;
  apiKeyId?: ObjectId | null;
  model?: string | null;
  provider?: string | null;
  statusCode: number;
  durationMs: number;
  result: 'success' | 'error' | 'cancelled' | 'timeout';
  errorCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  streaming: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export interface PreauthRejectionLogDocument {
  _id?: ObjectId;
  requestId?: string | null;
  startTime: Date;
  durationMs: number;
  statusCode: number;
  errorCode: string | null;
  projectId: null;
  model: null;
  provider: null;
  inputTokens: null;
  outputTokens: null;
  totalTokens: null;
  createdAt: Date;
  expiresAt: Date;
}

// 16. Preauth Rejection Counters
export interface PreauthRejectionCounterDocument {
  _id?: ObjectId;
  utcMinute: Date;
  count: number;
  createdAt: Date;
}

// 17. Worker Heartbeats & Health Telemetry
export interface WorkerHeartbeatDocument {
  _id?: ObjectId;
  workerType: 'recovery';
  instanceId: string;
  hostname?: string;
  pid?: number;
  lastHeartbeatAt: Date;
  lastScanStartedAt: Date;
  lastScanDurationMs?: number;
  scanIntervalMs: number;
  status: 'healthy' | 'degraded' | 'stopped' | 'dead';
  reconciledCountTotal: number;
  consecutiveErrors: number;
  lastError?: string | null;
  startedAt: Date;
  updatedAt: Date;
}
