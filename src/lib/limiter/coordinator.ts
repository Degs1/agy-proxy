import { Db, ObjectId } from 'mongodb';
import {
  COLLECTIONS,
  ProjectDocument,
  ApiKeyDocument,
  ModelAliasDocument,
  ProviderCredentialDocument,
  AdmissionIntentDocument,
  AdmissionDecisionDocument,
  AdmissionDecisionOutcome,
  ConcurrencyLeaseDocument,
  RateCounterDocument,
  RejectionCounterDocument,
} from '@/lib/db/schema';
import { touchProjectLimiterGuard } from '@/lib/projects/limiter-guard';
import { withTransaction } from '@/lib/db/client';
import { GatewayError } from '@/lib/validation/error';
import { claimAdmissionIntent } from './claim';
import {
  AdmissionRequestInput,
  AdmissionResult,
  AdmissionHooks,
  LimiterFencedError,
  LimiterUnavailableError,
} from './types';
import crypto from 'crypto';

/**
 * Calculates Retry-After seconds for rate limit retries based on original window or default 1s.
 */
function calculateRetryAfter(decision: AdmissionDecisionDocument, now: Date): number | undefined {
  if (decision.outcome?.originalErrorCode === 'concurrency_limit_exceeded') {
    return 1;
  }
  // Rate limit: remaining seconds until end of minute window based on creation time
  const created = decision.createdAt;
  const windowEnd = new Date(
    Date.UTC(
      created.getUTCFullYear(),
      created.getUTCMonth(),
      created.getUTCDate(),
      created.getUTCHours(),
      created.getUTCMinutes() + 1,
      0,
      0
    )
  );
  const remaining = Math.ceil((windowEnd.getTime() - now.getTime()) / 1000);
  return remaining > 0 ? remaining : undefined;
}

/**
 * Checks an existing decision for deduplication and idempotency rules.
 */
function evaluateExistingDecision(
  decision: AdmissionDecisionDocument,
  payloadFingerprint: string,
  now: Date
): AdmissionResult | null {
  // If deduplication window has expired, allow new admission
  if (now.getTime() >= decision.dedupeUntil.getTime()) {
    return null;
  }

  // Deduplication window still active:
  // 1. Verify payload fingerprint
  if (decision.payloadFingerprint !== payloadFingerprint) {
    return {
      admitted: false,
      conflict: true,
      httpStatus: 409,
      errorCode: 'idempotency_conflict',
      message: 'Payload fingerprint mismatch for idempotent request identity',
    };
  }

  // 2. If decision is running, check if it's currently active
  if (decision.status === 'running') {
    return {
      admitted: false,
      conflict: true,
      httpStatus: 409,
      errorCode: 'request_in_progress',
      message: 'Request is currently processing',
    };
  }

  // 3. If decision is rejected
  if (decision.status === 'rejected') {
    const retryAfter = calculateRetryAfter(decision, now);
    return {
      admitted: false,
      isTerminalRetry: true,
      httpStatus: 429,
      errorCode: (decision.outcome?.originalErrorCode as any) || 'rate_limit_exceeded',
      outcome: decision.outcome!,
      retryAfter,
    };
  }

  // 4. Other terminal statuses (succeeded, failed, cancelled, lease_expired)
  return {
    admitted: false,
    isTerminalRetry: true,
    httpStatus: 409,
    errorCode: 'request_already_processed',
    outcome: decision.outcome!,
  };
}

/**
 * Requests distributed admission for a gateway completion request.
 *
 * Implements:
 * - Pre-transaction majority claim on `admission_intents` with 30s fence.
 * - Multi-document snapshot majority transaction.
 * - FIRST operation: `touchProjectLimiterGuard` for single authoritative server time.
 * - Fencing write verification on `admission_intents`.
 * - Re-authorization of project, API key, model alias, and provider credential.
 * - Deduplication checking (same payload uses old outcome; different payload rejected 409).
 * - Rate limit (1-min UTC window) and Concurrency limits with 1,000/day rejection recording.
 * - Initial 45s concurrency lease and committed status on success.
 */
export async function requestAdmission(
  db: Db,
  input: AdmissionRequestInput,
  hooks?: AdmissionHooks
): Promise<AdmissionResult> {
  const now = hooks?.clock ? hooks.clock.now() : new Date();

  // 1. Pre-transaction claim
  const claimResult = await claimAdmissionIntent(
    db,
    {
      projectId: input.projectId,
      apiKeyId: input.apiKeyId,
      requestId: input.requestId,
    },
    { clock: hooks?.clock }
  );

  // If claim is active pending from an existing process within 30s
  if (claimResult.status === 'pending_active') {
    throw new LimiterUnavailableError(
      'Service Unavailable: Request identity is currently claimed by an active attempt'
    );
  }

  // If existing claim is committed or terminal, check existing decision
  if (
    claimResult.status === 'existing_committed' ||
    claimResult.status === 'existing_terminal'
  ) {
    const existingDecision = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne(
        {
          projectId: input.projectId,
          apiKeyId: input.apiKeyId,
          requestId: input.requestId,
        },
        {
          readPreference: 'primary',
          readConcern: { level: 'majority' },
        }
      );

    if (existingDecision) {
      const evalResult = evaluateExistingDecision(
        existingDecision,
        input.payloadFingerprint,
        now
      );
      if (evalResult) {
        return evalResult;
      }
    }
  }

  // 2. Fenced Admission Transaction
  try {
    return await withTransaction(async (session) => {
      // Operation 1 (FIRST): Touch limiter guard to serialize and obtain authoritative server time
      const guard = await touchProjectLimiterGuard(db, input.projectId, session);
      const serverTime = hooks?.clock ? hooks.clock.now() : guard.last_server_time;

      // Operation 2: Fencing write on admission_intents (verifies this attempt still holds claim)
      const fenceUpdate = await db
        .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
        .updateOne(
          {
            projectId: input.projectId,
            apiKeyId: input.apiKeyId,
            requestId: input.requestId,
            attemptId: claimResult.attemptId,
            generation: claimResult.generation,
            status: 'pending',
          },
          {
            $set: {
              lastVerifiedAt: serverTime,
            },
          },
          { session }
        );

      if (fenceUpdate.matchedCount === 0) {
        throw new LimiterFencedError(
          'Admission attempt was fenced or invalidated prior to transaction serialization'
        );
      }

      // Operation 3: Re-verify Project status
      const project = await db
        .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
        .findOne({ _id: input.projectId }, { session });

      if (!project || project.status !== 'active') {
        throw new GatewayError({
          message: 'Project is disabled or not found',
          httpStatus: 403,
          code: 'project_disabled',
          type: 'permission_error',
        });
      }

      // Operation 4: Re-verify API Key status
      const apiKey = await db
        .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
        .findOne({ _id: input.apiKeyId, projectId: input.projectId }, { session });

      if (!apiKey || apiKey.status !== 'active') {
        throw new GatewayError({
          message: 'API key is revoked or invalid',
          httpStatus: 401,
          code: 'invalid_api_key',
          type: 'authentication_error',
        });
      }

      // Operation 5: Re-verify Model Alias and bound Provider Credential
      const aliasDoc = await db
        .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
        .findOne({ projectId: input.projectId, alias: input.modelAlias }, { session });

      if (!aliasDoc) {
        throw new GatewayError({
          message: `Model alias '${input.modelAlias}' not found`,
          httpStatus: 404,
          code: 'model_not_found',
          type: 'invalid_request_error',
        });
      }

      if (aliasDoc.status !== 'active') {
        throw new GatewayError({
          message: `Model alias '${input.modelAlias}' is disabled`,
          httpStatus: 403,
          code: 'model_disabled',
          type: 'permission_error',
        });
      }

      const credDoc = await db
        .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
        .findOne(
          { _id: aliasDoc.boundCredentialId, projectId: input.projectId },
          { session }
        );

      if (!credDoc || credDoc.status !== 'active') {
        throw new GatewayError({
          message: 'Bound provider credential is missing or unavailable',
          httpStatus: 503,
          code: 'provider_unavailable',
          type: 'provider_error',
        });
      }

      // Operation 6: Check existing decisions for deduplication inside transaction
      const existingDecision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne(
          {
            projectId: input.projectId,
            apiKeyId: input.apiKeyId,
            requestId: input.requestId,
          },
          { session }
        );

      if (existingDecision) {
        if (serverTime.getTime() >= existingDecision.dedupeUntil.getTime()) {
          // Dedupe window expired: safely remove old decision to allow fresh admission
          await db
            .collection(COLLECTIONS.ADMISSION_DECISIONS)
            .deleteOne({ _id: existingDecision._id }, { session });
        } else {
          // Dedupe window still active
          const evalResult = evaluateExistingDecision(
            existingDecision,
            input.payloadFingerprint,
            serverTime
          );
          if (evalResult) {
            return evalResult;
          }
        }
      }

      // Operation 7: Rate Limit (RPM) Evaluation
      // Fixed 1-minute UTC window start
      const windowStart = new Date(
        Date.UTC(
          serverTime.getUTCFullYear(),
          serverTime.getUTCMonth(),
          serverTime.getUTCDate(),
          serverTime.getUTCHours(),
          serverTime.getUTCMinutes(),
          0,
          0
        )
      );

      const rateDoc = await db
        .collection<RateCounterDocument>(COLLECTIONS.RATE_COUNTERS)
        .findOne({ projectId: input.projectId, windowStart }, { session });

      const currentCount = rateDoc?.count ?? 0;
      const rpmLimit = project.rpmLimit ?? 60;

      if (currentCount >= rpmLimit) {
        // Rate limit exceeded: Record rejected decision if within 1,000 daily quota
        const utcDay = serverTime.toISOString().slice(0, 10);
        const rejectionDoc = await db
          .collection<RejectionCounterDocument>(COLLECTIONS.REJECTION_COUNTERS)
          .findOne({ projectId: input.projectId, utcDay }, { session });

        const rejectionCount = rejectionDoc?.count ?? 0;
        const windowEnd = new Date(windowStart.getTime() + 60_000);
        const retryAfter = Math.max(
          1,
          Math.ceil((windowEnd.getTime() - serverTime.getTime()) / 1000)
        );

        const outcome: AdmissionDecisionOutcome = {
          status: 'rejected',
          originalHttpStatus: 429,
          originalErrorCode: 'rate_limit_exceeded',
          completedAt: serverTime,
        };

        if (rejectionCount < 1000) {
          await db.collection(COLLECTIONS.REJECTION_COUNTERS).updateOne(
            { projectId: input.projectId, utcDay },
            { $inc: { count: 1 }, $setOnInsert: { createdAt: serverTime } },
            { upsert: true, session }
          );

          await db
            .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
            .insertOne(
              {
                projectId: input.projectId,
                apiKeyId: input.apiKeyId,
                requestId: input.requestId,
                attemptId: claimResult.attemptId,
                payloadFingerprint: input.payloadFingerprint,
                status: 'rejected',
                createdAt: serverTime,
                terminalAt: serverTime,
                dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
                outcome,
              },
              { session }
            );

          await db
            .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
            .updateOne(
              {
                projectId: input.projectId,
                apiKeyId: input.apiKeyId,
                requestId: input.requestId,
                attemptId: claimResult.attemptId,
                generation: claimResult.generation,
              },
              {
                $set: {
                  status: 'terminal',
                  dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
                },
              },
              { session }
            );
        } else {
          // Daily quota reached: resolve claim without leaving pending status
          await db
            .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
            .updateOne(
              {
                projectId: input.projectId,
                apiKeyId: input.apiKeyId,
                requestId: input.requestId,
                attemptId: claimResult.attemptId,
                generation: claimResult.generation,
              },
              {
                $set: {
                  status: 'terminal',
                  dedupeUntil: serverTime,
                },
              },
              { session }
            );
        }

        return {
          admitted: false,
          reason: 'rate_limit_exceeded',
          httpStatus: 429,
          retryAfter,
          errorCode: 'rate_limit_exceeded',
          outcome: rejectionCount < 1000 ? outcome : undefined,
        };
      }

      // Operation 8: Concurrency Limit Evaluation
      const activeLeasesCount = await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .countDocuments(
          {
            projectId: input.projectId,
            expiresAt: { $gt: serverTime },
          },
          { session }
        );

      const concurrencyLimit = project.concurrencyLimit ?? 5;

      if (activeLeasesCount >= concurrencyLimit) {
        // Concurrency limit exceeded: Record rejected decision if within 1,000 daily quota
        const utcDay = serverTime.toISOString().slice(0, 10);
        const rejectionDoc = await db
          .collection<RejectionCounterDocument>(COLLECTIONS.REJECTION_COUNTERS)
          .findOne({ projectId: input.projectId, utcDay }, { session });

        const rejectionCount = rejectionDoc?.count ?? 0;

        const outcome: AdmissionDecisionOutcome = {
          status: 'rejected',
          originalHttpStatus: 429,
          originalErrorCode: 'concurrency_limit_exceeded',
          completedAt: serverTime,
        };

        if (rejectionCount < 1000) {
          await db.collection(COLLECTIONS.REJECTION_COUNTERS).updateOne(
            { projectId: input.projectId, utcDay },
            { $inc: { count: 1 }, $setOnInsert: { createdAt: serverTime } },
            { upsert: true, session }
          );

          await db
            .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
            .insertOne(
              {
                projectId: input.projectId,
                apiKeyId: input.apiKeyId,
                requestId: input.requestId,
                attemptId: claimResult.attemptId,
                payloadFingerprint: input.payloadFingerprint,
                status: 'rejected',
                createdAt: serverTime,
                terminalAt: serverTime,
                dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
                outcome,
              },
              { session }
            );

          await db
            .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
            .updateOne(
              {
                projectId: input.projectId,
                apiKeyId: input.apiKeyId,
                requestId: input.requestId,
                attemptId: claimResult.attemptId,
                generation: claimResult.generation,
              },
              {
                $set: {
                  status: 'terminal',
                  dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
                },
              },
              { session }
            );
        } else {
          await db
            .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
            .updateOne(
              {
                projectId: input.projectId,
                apiKeyId: input.apiKeyId,
                requestId: input.requestId,
                attemptId: claimResult.attemptId,
                generation: claimResult.generation,
              },
              {
                $set: {
                  status: 'terminal',
                  dedupeUntil: serverTime,
                },
              },
              { session }
            );
        }

        return {
          admitted: false,
          reason: 'concurrency_limit_exceeded',
          httpStatus: 429,
          retryAfter: 1, // Contract: Concurrency rejection uses Retry-After: 1
          errorCode: 'concurrency_limit_exceeded',
          outcome: rejectionCount < 1000 ? outcome : undefined,
        };
      }

      // Operation 9: Admission Granted!
      // a. Increment rate counter
      await db.collection(COLLECTIONS.RATE_COUNTERS).updateOne(
        { projectId: input.projectId, windowStart },
        { $inc: { count: 1 }, $setOnInsert: { createdAt: serverTime } },
        { upsert: true, session }
      );

      // b. Insert decision document (status: 'running', dispatchStatus: 'undispatched')
      const decisionId = new ObjectId();
      await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .insertOne(
          {
            _id: decisionId,
            projectId: input.projectId,
            apiKeyId: input.apiKeyId,
            requestId: input.requestId,
            attemptId: claimResult.attemptId,
            payloadFingerprint: input.payloadFingerprint,
            status: 'running',
            dispatchStatus: 'undispatched',
            createdAt: serverTime,
            dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
          },
          { session }
        );

      // c. Insert initial concurrency lease (45 seconds)
      const leaseId = crypto.randomUUID();
      await db
        .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
        .insertOne(
          {
            leaseId,
            projectId: input.projectId,
            decisionId,
            expiresAt: new Date(serverTime.getTime() + 45_000),
            createdAt: serverTime,
          },
          { session }
        );

      // d. Mark claim committed atomically
      await db
        .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
        .updateOne(
          {
            projectId: input.projectId,
            apiKeyId: input.apiKeyId,
            requestId: input.requestId,
            attemptId: claimResult.attemptId,
            generation: claimResult.generation,
            status: 'pending',
          },
          {
            $set: {
              status: 'committed',
              committedAt: serverTime,
            },
          },
          { session }
        );

      if (hooks?.beforeCommit) {
        await hooks.beforeCommit();
      }

      if (hooks?.simulateUnknownCommit) {
        const error = new Error('Simulated UnknownTransactionCommitResult');
        (error as any).errorLabels = ['UnknownTransactionCommitResult'];
        throw error;
      }

      return {
        admitted: true,
        decisionId,
        leaseId,
        attemptId: claimResult.attemptId,
        generation: claimResult.generation,
        serverTime,
        dispatchGranted: false,
      };
    });
  } catch (err: unknown) {
    if (err instanceof LimiterFencedError) {
      throw new LimiterUnavailableError(
        'Service Unavailable: Attempt was fenced by concurrent process'
      );
    }
    // Check if error is UnknownTransactionCommitResult simulation
    if (
      typeof err === 'object' &&
      err !== null &&
      'errorLabels' in err &&
      Array.isArray((err as any).errorLabels) &&
      (err as any).errorLabels.includes('UnknownTransactionCommitResult')
    ) {
      // Re-read primary to verify if decision actually committed
      const committed = await verifyUncertainAdmission(db, {
        projectId: input.projectId,
        apiKeyId: input.apiKeyId,
        requestId: input.requestId,
        attemptId: claimResult.attemptId,
      });
      if (committed) {
        return committed;
      }
      throw new LimiterUnavailableError(
        'Service Unavailable: Transaction commit result unknown and unverified'
      );
    }
    throw err;
  }
}

/**
 * Verifies if an uncertain transaction commit actually succeeded on Atlas primary.
 */
export async function verifyUncertainAdmission(
  db: Db,
  params: {
    projectId: ObjectId;
    apiKeyId: ObjectId;
    requestId: string;
    attemptId: string;
  }
): Promise<AdmissionResult | null> {
  const decision = await db
    .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
    .findOne(
      {
        projectId: params.projectId,
        apiKeyId: params.apiKeyId,
        requestId: params.requestId,
        attemptId: params.attemptId,
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'majority' },
      }
    );

  if (!decision) {
    return null;
  }

  const lease = await db
    .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
    .findOne(
      { decisionId: decision._id },
      { readPreference: 'primary', readConcern: { level: 'majority' } }
    );

  return {
    admitted: true,
    decisionId: decision._id!,
    leaseId: lease?.leaseId || '',
    attemptId: decision.attemptId,
    generation: 1,
    serverTime: decision.createdAt,
    dispatchGranted: decision.dispatchStatus === 'dispatching',
  };
}

/**
 * Atomically transitions dispatch status from 'undispatched' to 'dispatching'.
 *
 * Requirements:
 * - Ownership check: Verifies that claim is owned by attemptId and generation and committed.
 * - Hook `beforeDispatchTransition` allows simulating pauses between check and atomic transition.
 * - Atomic transition uses transaction or conditional update checking claim validity.
 * - If status is already 'dispatching', dispatch CANNOT be re-issued or stolen.
 * - ONLY confirmed successful transition grants permission to invoke provider!
 */
export async function acquireDispatchPermission(
  db: Db,
  params: {
    projectId: ObjectId;
    apiKeyId: ObjectId;
    requestId: string;
    attemptId: string;
    generation: number;
    decisionId: ObjectId;
  },
  hooks?: AdmissionHooks
): Promise<{ granted: boolean; reason?: string }> {
  // 1. Initial ownership check
  const initialClaim = await db
    .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
    .findOne(
      {
        projectId: params.projectId,
        apiKeyId: params.apiKeyId,
        requestId: params.requestId,
        attemptId: params.attemptId,
        generation: params.generation,
        status: 'committed',
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'majority' },
      }
    );

  if (!initialClaim) {
    return {
      granted: false,
      reason: 'claim_fenced_or_invalid',
    };
  }

  const initialDecision = await db
    .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
    .findOne({ _id: params.decisionId });

  if (!initialDecision) {
    return {
      granted: false,
      reason: 'decision_not_found',
    };
  }

  // 2. Pause hook: EXACTLY after ownership check and BEFORE atomic dispatch transition
  if (hooks?.beforeDispatchTransition) {
    await hooks.beforeDispatchTransition(initialClaim, initialDecision);
  }

  // 3. Atomic dispatch transition: re-verify claim has not been fenced
  const txResult = await withTransaction(async (session) => {
    const guard = await touchProjectLimiterGuard(db, params.projectId, session);
    const serverTime = hooks?.clock ? hooks.clock.now() : guard.last_server_time;

    // Ensure lease has not expired before granting dispatch
    const activeLease = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne(
        { decisionId: params.decisionId, expiresAt: { $gt: serverTime } },
        { session }
      );

    if (!activeLease) {
      return {
        granted: false,
        reason: 'lease_expired',
      };
    }

    const currentClaim = await db
      .collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS)
      .findOne(
        {
          projectId: params.projectId,
          apiKeyId: params.apiKeyId,
          requestId: params.requestId,
          attemptId: params.attemptId,
          generation: params.generation,
          status: 'committed',
        },
        { session }
      );

    if (!currentClaim || currentClaim.fencedAt) {
      return {
        granted: false,
        reason: 'claim_fenced_or_invalid',
      };
    }

    const updated = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOneAndUpdate(
        {
          _id: params.decisionId,
          attemptId: params.attemptId,
          status: 'running',
          dispatchStatus: 'undispatched',
        },
        {
          $set: {
            dispatchStatus: 'dispatching',
            dispatchedAt: serverTime,
          },
        },
        {
          returnDocument: 'after',
          session,
        }
      );

    if (!updated) {
      return {
        granted: false,
        reason: 'already_dispatching_or_fenced',
      };
    }

    return { granted: true, claim: currentClaim, updated };
  });

  if (txResult.granted && hooks?.afterDispatchTransition) {
    await hooks.afterDispatchTransition(txResult.claim!, txResult.updated!);
  }

  return { granted: txResult.granted, reason: txResult.reason };
}

/**
 * Finalizes an admission decision upon completion, error, or cancellation.
 * Releases the concurrency lease in the same transaction.
 *
 * Requirements:
 * - Operates within multi-document transaction.
 * - FIRST operation: `touchProjectLimiterGuard` for server time.
 * - Verifies decision is still `running`, `attemptId` matches, and `expiresAt > serverTime`.
 * - Tightly prevents late workers whose lease expired from releasing another job's lease.
 */
export async function finalizeAdmissionDecision(
  db: Db,
  params: {
    projectId: ObjectId;
    decisionId: ObjectId;
    leaseId: string;
    attemptId: string;
    finalStatus: 'succeeded' | 'failed' | 'cancelled';
    originalHttpStatus: number;
    originalErrorCode?: string | null;
  },
  options?: {
    clock?: { now: () => Date };
  }
): Promise<{ success: boolean; reason?: string; completedAt?: Date }> {
  return withTransaction(async (session) => {
    // 1. Touch limiter guard
    const guard = await touchProjectLimiterGuard(db, params.projectId, session);
    const serverTime = options?.clock ? options.clock.now() : guard.last_server_time;

    // 2. Verify lease is still active (expiresAt > serverTime)
    const lease = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne(
        {
          leaseId: params.leaseId,
          projectId: params.projectId,
          decisionId: params.decisionId,
          expiresAt: { $gt: serverTime },
        },
        { session }
      );

    if (!lease) {
      return {
        success: false,
        reason: 'lease_expired',
      };
    }

    // 3. Verify decision is still running with matching attemptId
    const decision = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne(
        {
          _id: params.decisionId,
          attemptId: params.attemptId,
          status: 'running',
        },
        { session }
      );

    if (!decision) {
      return {
        success: false,
        reason: 'decision_not_running',
      };
    }

    // 4. Update decision to terminal status
    const outcome: AdmissionDecisionOutcome = {
      status: params.finalStatus,
      originalHttpStatus: params.originalHttpStatus,
      originalErrorCode: params.originalErrorCode,
      completedAt: serverTime,
    };

    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).updateOne(
      { _id: params.decisionId },
      {
        $set: {
          status: params.finalStatus,
          dispatchStatus: 'dispatched',
          terminalAt: serverTime,
          dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
          outcome,
        },
      },
      { session }
    );

    // 5. Update claim to terminal
    await db.collection(COLLECTIONS.ADMISSION_INTENTS).updateOne(
      {
        projectId: params.projectId,
        requestId: decision.requestId,
        attemptId: params.attemptId,
      },
      {
        $set: {
          status: 'terminal',
          dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
        },
      },
      { session }
    );

    // 6. Release concurrency lease
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).deleteOne(
      { leaseId: params.leaseId },
      { session }
    );

    return {
      success: true,
      completedAt: serverTime,
    };
  });
}

/**
 * Extends an active concurrency lease by 45 seconds from current server time.
 */
export async function extendConcurrencyLease(
  db: Db,
  params: {
    projectId: ObjectId;
    decisionId: ObjectId;
    leaseId: string;
  }
): Promise<{ success: boolean; expiresAt?: Date; reason?: string }> {
  return withTransaction(async (session) => {
    const guard = await touchProjectLimiterGuard(db, params.projectId, session);
    const serverTime = guard.last_server_time;

    const lease = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .findOne(
        {
          leaseId: params.leaseId,
          projectId: params.projectId,
          decisionId: params.decisionId,
          expiresAt: { $gt: serverTime },
        },
        { session }
      );

    if (!lease) {
      return { success: false, reason: 'lease_expired' };
    }

    const newExpiresAt = new Date(serverTime.getTime() + 45_000);
    await db.collection(COLLECTIONS.CONCURRENCY_LEASES).updateOne(
      { leaseId: params.leaseId },
      { $set: { expiresAt: newExpiresAt } },
      { session }
    );

    return { success: true, expiresAt: newExpiresAt };
  });
}

/**
 * Reconciles expired concurrency leases (e.g. after worker crash or timeout).
 * Marks orphaned decisions as `lease_expired` and deletes the expired leases.
 */
export async function reconcileExpiredLeases(
  db: Db,
  projectId: ObjectId
): Promise<number> {
  return withTransaction(async (session) => {
    const guard = await touchProjectLimiterGuard(db, projectId, session);
    const serverTime = guard.last_server_time;

    const expiredLeases = await db
      .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
      .find(
        {
          projectId,
          expiresAt: { $lte: serverTime },
        },
        { session }
      )
      .toArray();

    let reconciledCount = 0;

    for (const lease of expiredLeases) {
      const decision = await db
        .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
        .findOne({ _id: lease.decisionId, status: 'running' }, { session });

      if (decision) {
        const outcome: AdmissionDecisionOutcome = {
          status: 'lease_expired',
          originalHttpStatus: 409,
          originalErrorCode: 'lease_expired',
          completedAt: serverTime,
        };

        await db.collection(COLLECTIONS.ADMISSION_DECISIONS).updateOne(
          { _id: decision._id },
          {
            $set: {
              status: 'lease_expired',
              terminalAt: serverTime,
              dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
              outcome,
            },
          },
          { session }
        );

        await db.collection(COLLECTIONS.ADMISSION_INTENTS).updateOne(
          {
            projectId,
            requestId: decision.requestId,
            attemptId: decision.attemptId,
          },
          {
            $set: {
              status: 'terminal',
              dedupeUntil: new Date(serverTime.getTime() + 24 * 3600 * 1000),
            },
          },
          { session }
        );
      }

      await db.collection(COLLECTIONS.CONCURRENCY_LEASES).deleteOne(
        { leaseId: lease.leaseId },
        { session }
      );
      reconciledCount++;
    }

    return reconciledCount;
  });
}

/**
 * Full end-to-end execution wrapper that coordinates admission, checks atomic dispatch,
 * executes the provider callback, and finalizes the terminal decision and lease.
 */
export async function dispatchWithAdmission<T>(
  db: Db,
  input: AdmissionRequestInput,
  providerFn: () => Promise<T>,
  options?: {
    hooks?: AdmissionHooks;
  }
): Promise<
  | { success: true; result: T; decisionId: ObjectId; completedAt: Date }
  | { success: false; admissionResult: AdmissionResult }
  | { success: false; dispatchFailed: true; reason: string }
> {
  // 1. Request admission
  const admission = await requestAdmission(db, input, options?.hooks);
  if (!admission.admitted) {
    return { success: false, admissionResult: admission };
  }

  // 2. Acquire atomic dispatch permission
  const dispatch = await acquireDispatchPermission(
    db,
    {
      projectId: input.projectId,
      apiKeyId: input.apiKeyId,
      requestId: input.requestId,
      attemptId: admission.attemptId,
      generation: admission.generation,
      decisionId: admission.decisionId,
    },
    options?.hooks
  );

  if (!dispatch.granted) {
    return {
      success: false,
      dispatchFailed: true,
      reason: dispatch.reason || 'dispatch_permission_denied',
    };
  }

  // 3. Dispatch to provider (ONLY confirmed transitions reach here)
  let result: T;
  try {
    result = await providerFn();
  } catch (err: unknown) {
    // Finalize failure
    const originalHttpStatus =
      err instanceof GatewayError ? err.httpStatus : 502;
    const originalErrorCode =
      err instanceof GatewayError ? String(err.code) : 'provider_error';

    await finalizeAdmissionDecision(
      db,
      {
        projectId: input.projectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
        attemptId: admission.attemptId,
        finalStatus: 'failed',
        originalHttpStatus,
        originalErrorCode,
      },
      { clock: options?.hooks?.clock }
    );

    throw err;
  }

  // 4. Finalize success terminal transaction
  const finalization = await finalizeAdmissionDecision(
    db,
    {
      projectId: input.projectId,
      decisionId: admission.decisionId,
      leaseId: admission.leaseId,
      attemptId: admission.attemptId,
      finalStatus: 'succeeded',
      originalHttpStatus: 200,
    },
    { clock: options?.hooks?.clock }
  );

  if (!finalization.success) {
    return {
      success: false,
      dispatchFailed: true,
      reason: finalization.reason || 'terminal_finalization_failed',
    };
  }

  return {
    success: true,
    result,
    decisionId: admission.decisionId,
    completedAt: finalization.completedAt || new Date(),
  };
}
