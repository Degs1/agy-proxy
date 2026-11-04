import { Db, ObjectId } from 'mongodb';
import {
  COLLECTIONS,
  AdmissionIntentDocument,
  AdmissionDecisionDocument,
} from '@/lib/db/schema';
import crypto from 'crypto';

export interface ClaimAdmissionResult {
  status:
    | 'acquired'
    | 'existing_committed'
    | 'existing_terminal'
    | 'pending_active'
    | 'reconciliation_failed';
  claim: AdmissionIntentDocument;
  attemptId: string;
  generation: number;
}

export interface ClaimOptions {
  attemptId?: string;
  clock?: { now: () => Date };
}

/**
 * Claims request identity (projectId, apiKeyId, requestId) prior to running
 * the admission transaction. Uses majority write concern and unique index.
 *
 * Implements:
 * 1. Initial insert with attemptId, generation: 1, status: 'pending', claimExpiresAt: now + 30s.
 * 2. Reconciliation of expired pending/undispatched claims (> 30s) using conditional atomic update.
 * 3. Atomic reuse of terminal claims when dedupe_until <= now.
 */
export async function claimAdmissionIntent(
  db: Db,
  params: {
    projectId: ObjectId;
    apiKeyId: ObjectId;
    requestId: string;
  },
  options?: ClaimOptions
): Promise<ClaimAdmissionResult> {
  const collection = db.collection<AdmissionIntentDocument>(COLLECTIONS.ADMISSION_INTENTS);
  const now = options?.clock ? options.clock.now() : new Date();
  const attemptId = options?.attemptId || crypto.randomUUID();
  const claimExpiresAt = new Date(now.getTime() + 30_000);

  // 1. Try fast-path insert
  try {
    const newClaim: AdmissionIntentDocument = {
      projectId: params.projectId,
      apiKeyId: params.apiKeyId,
      requestId: params.requestId,
      attemptId,
      generation: 1,
      status: 'pending',
      claimedAt: now,
      claimExpiresAt,
    };

    await collection.insertOne(newClaim, {
      writeConcern: { w: 'majority' },
    });

    return {
      status: 'acquired',
      claim: newClaim,
      attemptId,
      generation: 1,
    };
  } catch (err: unknown) {
    const isDuplicate =
      typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000;
    if (!isDuplicate) {
      throw err;
    }
  }

  // 2. Duplicate key: An existing claim exists. Read with majority & primary
  const existing = await collection.findOne(
    {
      projectId: params.projectId,
      apiKeyId: params.apiKeyId,
      requestId: params.requestId,
    },
    {
      readPreference: 'primary',
      readConcern: { level: 'majority' },
    }
  );

  if (!existing) {
    // Edge-case: document deleted right after duplicate key error; retry once
    return claimAdmissionIntent(db, params, options);
  }

  // Case A: Existing claim is committed
  if (existing.status === 'committed') {
    // Check if admission decision was ever dispatched
    const decision = await db
      .collection<AdmissionDecisionDocument>(COLLECTIONS.ADMISSION_DECISIONS)
      .findOne(
        {
          projectId: params.projectId,
          apiKeyId: params.apiKeyId,
          requestId: params.requestId,
        },
        { readPreference: 'primary', readConcern: { level: 'majority' } }
      );

    // If decision is running and undispatched, but claim has expired (> 30s)
    if (
      decision?.status === 'running' &&
      decision?.dispatchStatus === 'undispatched' &&
      now.getTime() >= existing.claimExpiresAt.getTime()
    ) {
      // Claim expired prior to dispatch: another process can take over via fencing
      const fenced = await collection.findOneAndUpdate(
        {
          projectId: params.projectId,
          apiKeyId: params.apiKeyId,
          requestId: params.requestId,
          attemptId: existing.attemptId,
          generation: existing.generation,
          claimExpiresAt: { $lte: now },
        },
        {
          $set: {
            status: 'pending',
            attemptId,
            generation: existing.generation + 1,
            claimedAt: now,
            claimExpiresAt,
            fencedAt: now,
            fencedAttemptId: existing.attemptId,
          },
        },
        {
          returnDocument: 'after',
          writeConcern: { w: 'majority' },
        }
      );

      if (fenced) {
        // Invalidate old undispatched decision and its allocated concurrency lease
        await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteOne({
          _id: decision._id,
          dispatchStatus: 'undispatched',
        });
        await db.collection(COLLECTIONS.CONCURRENCY_LEASES).deleteMany({
          decisionId: decision._id,
        });

        return {
          status: 'acquired',
          claim: fenced,
          attemptId,
          generation: existing.generation + 1,
        };
      }
    }

    return {
      status: 'existing_committed',
      claim: existing,
      attemptId: existing.attemptId,
      generation: existing.generation,
    };
  }

  // Case B: Existing claim is terminal
  if (existing.status === 'terminal') {
    // Boundary check: dedupe_until <= now allows reuse of UUID
    if (existing.dedupeUntil && now.getTime() < existing.dedupeUntil.getTime()) {
      return {
        status: 'existing_terminal',
        claim: existing,
        attemptId: existing.attemptId,
        generation: existing.generation,
      };
    }

    // Expired terminal claim (dedupe_until <= now): atomically take over claim
    const updated = await collection.findOneAndUpdate(
      {
        projectId: params.projectId,
        apiKeyId: params.apiKeyId,
        requestId: params.requestId,
        status: 'terminal',
        dedupeUntil: { $lte: now },
      },
      {
        $set: {
          status: 'pending',
          attemptId,
          generation: existing.generation + 1,
          claimedAt: now,
          claimExpiresAt,
        },
        $unset: {
          dedupeUntil: 1,
          fencedAt: 1,
          fencedAttemptId: 1,
          committedAt: 1,
          lastVerifiedAt: 1,
        },
      },
      {
        returnDocument: 'after',
        writeConcern: { w: 'majority' },
      }
    );

    if (updated) {
      return {
        status: 'acquired',
        claim: updated,
        attemptId,
        generation: existing.generation + 1,
      };
    }

    // Concurrent take-over won; re-read
    return claimAdmissionIntent(db, params, options);
  }

  // Case C: Existing claim is pending
  // If still within 30s window, previous owner is still active
  if (now.getTime() < existing.claimExpiresAt.getTime()) {
    return {
      status: 'pending_active',
      claim: existing,
      attemptId: existing.attemptId,
      generation: existing.generation,
    };
  }

  // Boundary condition: claim has expired (> 30s according to Atlas server time)
  // Reconcile via fenced atomic update with majority write concern
  const fenced = await collection.findOneAndUpdate(
    {
      projectId: params.projectId,
      apiKeyId: params.apiKeyId,
      requestId: params.requestId,
      status: 'pending',
      attemptId: existing.attemptId,
      generation: existing.generation,
      claimExpiresAt: { $lte: now },
    },
    {
      $set: {
        attemptId,
        generation: existing.generation + 1,
        claimedAt: now,
        claimExpiresAt,
        fencedAt: now,
        fencedAttemptId: existing.attemptId,
      },
    },
    {
      returnDocument: 'after',
      writeConcern: { w: 'majority' },
    }
  );

  if (fenced) {
    return {
      status: 'acquired',
      claim: fenced,
      attemptId,
      generation: existing.generation + 1,
    };
  }

  // Another process won the fencing update or original tx committed; read again
  const reRead = await collection.findOne(
    {
      projectId: params.projectId,
      apiKeyId: params.apiKeyId,
      requestId: params.requestId,
    },
    {
      readPreference: 'primary',
      readConcern: { level: 'majority' },
    }
  );

  if (reRead?.status === 'committed') {
    return {
      status: 'existing_committed',
      claim: reRead,
      attemptId: reRead.attemptId,
      generation: reRead.generation,
    };
  }

  if (reRead?.status === 'terminal') {
    return {
      status: 'existing_terminal',
      claim: reRead,
      attemptId: reRead.attemptId,
      generation: reRead.generation,
    };
  }

  return {
    status: 'pending_active',
    claim: reRead || existing,
    attemptId: reRead?.attemptId || existing.attemptId,
    generation: reRead?.generation || existing.generation,
  };
}
