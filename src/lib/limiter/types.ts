import { ObjectId } from 'mongodb';
import {
  AdmissionDecisionStatus,
  AdmissionDecisionOutcome,
  DispatchStatus,
  AdmissionIntentDocument,
  AdmissionDecisionDocument,
} from '@/lib/db/schema';
import { GatewayError } from '@/lib/validation/error';

export interface AdmissionRequestInput {
  projectId: ObjectId;
  apiKeyId: ObjectId;
  requestId: string; // Canonical UUID v4 from Idempotency-Key
  payloadFingerprint: string; // Canonical SHA-256
  modelAlias: string;
}

export interface AdmissionAdmittedResult {
  admitted: true;
  decisionId: ObjectId;
  leaseId: string;
  attemptId: string;
  generation: number;
  serverTime: Date;
  dispatchGranted: boolean;
}

export interface AdmissionRejectedResult {
  admitted: false;
  reason: 'rate_limit_exceeded' | 'concurrency_limit_exceeded';
  httpStatus: 429;
  retryAfter?: number;
  errorCode: 'rate_limit_exceeded' | 'concurrency_limit_exceeded';
  outcome?: AdmissionDecisionOutcome;
}

export interface AdmissionTerminalRetryResult {
  admitted: false;
  isTerminalRetry: true;
  httpStatus: number;
  errorCode?: string | null;
  outcome: AdmissionDecisionOutcome;
  retryAfter?: number;
}

export interface AdmissionConflictResult {
  admitted: false;
  conflict: true;
  httpStatus: 409;
  errorCode: 'idempotency_conflict' | 'request_in_progress' | 'request_already_processed';
  message: string;
  outcome?: AdmissionDecisionOutcome;
}

export type AdmissionResult =
  | AdmissionAdmittedResult
  | AdmissionRejectedResult
  | AdmissionTerminalRetryResult
  | AdmissionConflictResult;

export interface AdmissionHooks {
  /**
   * Hook called immediately after ownership check and BEFORE atomic dispatch transition.
   * Enables simulating race conditions where the original owner is paused and claim expires.
   */
  beforeDispatchTransition?: (
    claim: AdmissionIntentDocument,
    decision: AdmissionDecisionDocument
  ) => Promise<void>;

  /**
   * Hook called immediately AFTER atomic dispatch transition has confirmed.
   * Enables simulating race conditions where a second process attempts to steal dispatch.
   */
  afterDispatchTransition?: (
    claim: AdmissionIntentDocument,
    decision: AdmissionDecisionDocument
  ) => Promise<void>;

  /**
   * Hook called inside transaction right before commit.
   */
  beforeCommit?: () => Promise<void>;

  /**
   * If true, simulates an UnknownTransactionCommitResult error or uncertainty.
   */
  simulateUnknownCommit?: boolean;

  /**
   * Custom clock for testing deterministic time boundaries.
   */
  clock?: {
    now: () => Date;
  };
}

export class LimiterFencedError extends Error {
  constructor(message = 'Admission attempt was fenced by a concurrent process') {
    super(message);
    this.name = 'LimiterFencedError';
  }
}

export class LimiterUnavailableError extends GatewayError {
  constructor(message = 'Service Unavailable: Rate limiter state is unavailable or unconfirmed') {
    super({
      message,
      httpStatus: 503,
      code: 'limiter_unavailable',
      type: 'requests',
      param: null,
    });
    this.name = 'LimiterUnavailableError';
  }
}
