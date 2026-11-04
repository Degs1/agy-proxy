import { Db, ObjectId } from 'mongodb';
import { extendConcurrencyLease } from './coordinator';

export interface LeaseHeartbeatParams {
  projectId: ObjectId;
  decisionId: ObjectId;
  leaseId: string;
}

export interface LeaseHeartbeatOptions {
  /**
   * Interval in milliseconds between heartbeats.
   * Default: 15,000 ms (15 seconds).
   */
  heartbeatIntervalMs?: number;

  /**
   * Custom clock for testing deterministic time boundaries.
   */
  clock?: { now: () => Date };

  /**
   * Callback invoked if the lease is detected as expired or extension fails.
   */
  onExpired?: (reason: string) => void;

  /**
   * Callback invoked on unexpected extension error.
   */
  onError?: (err: Error) => void;
}

export interface ActiveLeaseController {
  readonly signal: AbortSignal;
  stop: () => void;
  isExpired: () => boolean;
  getAbortController: () => AbortController;
  triggerHeartbeatNow: () => Promise<boolean>;
}

/**
 * Starts a background periodic heartbeat for an active concurrency lease.
 *
 * Contract:
 * - Default 15s interval, 45s validity.
 * - Checks and extends lease using `extendConcurrencyLease`.
 * - If extension fails or server time >= expires_at, immediately triggers AbortSignal
 *   to cancel upstream provider requests and stops processing.
 */
export function startLeaseHeartbeat(
  db: Db,
  params: LeaseHeartbeatParams,
  options?: LeaseHeartbeatOptions
): ActiveLeaseController {
  const abortController = new AbortController();
  const intervalMs = options?.heartbeatIntervalMs ?? 15_000;
  let expired = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function performHeartbeat(): Promise<boolean> {
    if (running || expired || abortController.signal.aborted) {
      return false;
    }
    running = true;
    try {
      const result = await extendConcurrencyLease(
        db,
        params,
        options?.clock ? { clock: options.clock } : undefined
      );

      if (!result.success) {
        expired = true;
        const reason = result.reason || 'lease_expired';
        abortController.abort(new Error(`Lease extension failed: ${reason}`));
        options?.onExpired?.(reason);
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        return false;
      }
      return true;
    } catch (err: unknown) {
      expired = true;
      const error = err instanceof Error ? err : new Error(String(err));
      abortController.abort(error);
      options?.onError?.(error);
      options?.onExpired?.('heartbeat_error');
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return false;
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => {
    void performHeartbeat();
  }, intervalMs);

  if (timer.unref) {
    timer.unref();
  }

  return {
    get signal() {
      return abortController.signal;
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    isExpired: () => expired,
    getAbortController: () => abortController,
    triggerHeartbeatNow: performHeartbeat,
  };
}
