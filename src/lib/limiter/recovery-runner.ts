import { Db, ObjectId } from 'mongodb';
import os from 'os';
import crypto from 'crypto';
import { COLLECTIONS, WorkerHeartbeatDocument, ConcurrencyLeaseDocument } from '@/lib/db/schema';
import { reconcileExpiredLeases } from './coordinator';

export interface RecoveryRunnerOptions {
  instanceId?: string;
  scanIntervalMs?: number; // default: 5000 ms (5s)
  clock?: { now: () => Date };
  onScanComplete?: (result: { reconciledCount: number; durationMs: number }) => void;
  onError?: (err: Error) => void;
}

export interface RecoveryAlert {
  code:
    | 'no_healthy_heartbeat_15s'
    | 'scan_interval_exceeded_10s'
    | 'repeated_transaction_failures'
    | 'backlog_expired_leases'
    | 'no_active_recovery_instances';
  message: string;
  severity: 'warning' | 'critical';
  details?: Record<string, any>;
}

export interface HealthEvaluationResult {
  healthy: boolean;
  activeInstances: number;
  alerts: RecoveryAlert[];
}

/**
 * Background Recovery Runner.
 *
 * Requirements:
 * - Scans at startup and every 5 seconds (interval <= 5s, max gap <= 10s between scan starts).
 * - Multi-document transaction per project limiter guard.
 * - Reconciles expired leases to `lease_expired` and releases concurrency slot atomically.
 * - Records heartbeat and scan start time per instance in MongoDB Atlas.
 * - Safe for concurrent execution across two worker instances without double-processing.
 * - Graceful shutdown on SIGTERM / stop().
 */
export class LeaseRecoveryRunner {
  public readonly instanceId: string;
  public readonly scanIntervalMs: number;
  private readonly db: Db;
  private readonly clock?: { now: () => Date };
  private readonly onScanComplete?: (result: { reconciledCount: number; durationMs: number }) => void;
  private readonly onError?: (err: Error) => void;

  private isRunning: boolean = false;
  private isStopped: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private consecutiveErrors: number = 0;
  private reconciledCountTotal: number = 0;
  private startedAt: Date;
  private lastScanStartedAt: Date;

  constructor(db: Db, options?: RecoveryRunnerOptions) {
    this.db = db;
    this.instanceId = options?.instanceId || `recovery-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.scanIntervalMs = options?.scanIntervalMs ?? 5_000;
    this.clock = options?.clock;
    this.onScanComplete = options?.onScanComplete;
    this.onError = options?.onError;
    const now = this.now();
    this.startedAt = now;
    this.lastScanStartedAt = now;
  }

  private now(): Date {
    return this.clock ? this.clock.now() : new Date();
  }

  /**
   * Starts the recovery runner.
   * Performs an immediate scan on startup, then schedules periodic scans every 5 seconds.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isStopped = false;
    this.isRunning = true;
    this.startedAt = this.now();

    // Register initial heartbeat in Atlas
    await this.recordHeartbeat('healthy');

    // Immediate initial scan at startup
    await this.runScan();

    // Schedule periodic scanning
    this.timer = setInterval(() => {
      void this.runScan();
    }, this.scanIntervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Executes a single recovery scan cycle.
   */
  public async runScan(): Promise<{ reconciledCount: number; durationMs: number }> {
    if (this.isStopped) {
      return { reconciledCount: 0, durationMs: 0 };
    }
    if (this.isScanning) {
      // Prevent overlapping runs within the same instance
      return { reconciledCount: 0, durationMs: 0 };
    }

    this.isScanning = true;
    const scanStartTime = this.now();
    this.lastScanStartedAt = scanStartTime;

    try {
      // Record scan start in Atlas
      await this.db.collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS).updateOne(
        { workerType: 'recovery', instanceId: this.instanceId },
        {
          $set: {
            lastScanStartedAt: scanStartTime,
            lastHeartbeatAt: scanStartTime,
            status: this.consecutiveErrors >= 3 ? 'degraded' : 'healthy',
            updatedAt: scanStartTime,
          },
        },
        { upsert: true }
      );

      // Reconcile expired leases across all projects using guarded transactions
      const reconciledCount = await reconcileExpiredLeases(
        this.db,
        undefined,
        this.clock ? { clock: this.clock } : undefined
      );

      const scanEndTime = this.now();
      const durationMs = scanEndTime.getTime() - scanStartTime.getTime();

      this.reconciledCountTotal += reconciledCount;
      this.consecutiveErrors = 0;

      // Update heartbeat record
      await this.recordHeartbeat('healthy', {
        durationMs,
        reconciledCount,
      });

      this.onScanComplete?.({ reconciledCount, durationMs });
      return { reconciledCount, durationMs };
    } catch (err: unknown) {
      this.consecutiveErrors++;
      const error = err instanceof Error ? err : new Error(String(err));
      const status = this.consecutiveErrors >= 3 ? 'degraded' : 'healthy';

      await this.recordHeartbeat(status, {
        lastError: error.message,
      });

      this.onError?.(error);
      return { reconciledCount: 0, durationMs: 0 };
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Records heartbeat and status in Atlas.
   */
  private async recordHeartbeat(
    status: 'healthy' | 'degraded' | 'stopped',
    extra?: {
      durationMs?: number;
      reconciledCount?: number;
      lastError?: string;
    }
  ): Promise<void> {
    const now = this.now();
    const updateDoc: any = {
      workerType: 'recovery',
      instanceId: this.instanceId,
      hostname: os.hostname(),
      pid: process.pid,
      lastHeartbeatAt: now,
      scanIntervalMs: this.scanIntervalMs,
      status,
      consecutiveErrors: this.consecutiveErrors,
      reconciledCountTotal: this.reconciledCountTotal,
      updatedAt: now,
    };

    if (extra?.durationMs !== undefined) {
      updateDoc.lastScanDurationMs = extra.durationMs;
    }
    if (extra?.lastError !== undefined) {
      updateDoc.lastError = extra.lastError;
    }

    await this.db.collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS).updateOne(
      { workerType: 'recovery', instanceId: this.instanceId },
      {
        $set: updateDoc,
        $setOnInsert: {
          startedAt: this.startedAt,
          lastScanStartedAt: this.lastScanStartedAt,
        },
      },
      { upsert: true }
    );
  }

  /**
   * Gracefully shuts down the recovery runner.
   */
  public async stop(): Promise<void> {
    this.isStopped = true;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.recordHeartbeat('stopped');
  }
}

/**
 * Evaluates the health of running recovery worker instances and detects operational alerts.
 *
 * Alert triggers:
 * 1. `no_healthy_heartbeat_15s`: No healthy heartbeat from an active instance for >= 15 seconds.
 * 2. `scan_interval_exceeded_10s`: Time between scan starts exceeds 10 seconds.
 * 3. `repeated_transaction_failures`: Consecutive errors >= 3 on any instance.
 * 4. `backlog_expired_leases`: Growing backlog of un-reconciled expired leases in the database.
 */
export async function evaluateRecoveryHealth(
  db: Db,
  options?: {
    clock?: { now: () => Date };
  }
): Promise<HealthEvaluationResult> {
  const now = options?.clock ? options.clock.now() : new Date();
  const alerts: RecoveryAlert[] = [];

  // Query active worker heartbeat records (not stopped or dead, and updated within last 1 hour)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const activeWorkers = await db
    .collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS)
    .find({
      workerType: 'recovery',
      status: { $nin: ['stopped', 'dead'] },
      lastHeartbeatAt: { $gte: oneHourAgo },
    })
    .toArray();

  let liveWorkersCount = 0;

  for (const worker of activeWorkers) {
    const heartbeatAgeMs = now.getTime() - worker.lastHeartbeatAt.getTime();
    const scanAgeMs = now.getTime() - worker.lastScanStartedAt.getTime();

    // If an instance has been unresponsive for >= 10 minutes (container terminated abruptly without SIGTERM),
    // mark its status as 'dead' in Atlas so it no longer triggers persistent false alarms on replaced containers.
    if (heartbeatAgeMs >= 10 * 60 * 1000) {
      await db
        .collection<WorkerHeartbeatDocument>(COLLECTIONS.WORKER_HEARTBEATS)
        .updateOne(
          { _id: worker._id },
          { $set: { status: 'dead', updatedAt: now } }
        );
      continue;
    }

    liveWorkersCount++;

    // 1. Alert: No healthy heartbeat for 15s
    if (heartbeatAgeMs >= 15_000) {
      alerts.push({
        code: 'no_healthy_heartbeat_15s',
        message: `Instance ${worker.instanceId} has not sent a heartbeat in ${Math.round(heartbeatAgeMs / 1000)}s (threshold: 15s)`,
        severity: 'critical',
        details: { instanceId: worker.instanceId, heartbeatAgeMs },
      });
    }

    // 2. Alert: Scan interval gap exceeded 10s
    if (scanAgeMs > 10_000) {
      alerts.push({
        code: 'scan_interval_exceeded_10s',
        message: `Instance ${worker.instanceId} has not initiated a scan in ${Math.round(scanAgeMs / 1000)}s (threshold: 10s)`,
        severity: 'warning',
        details: { instanceId: worker.instanceId, scanAgeMs },
      });
    }

    // 3. Alert: Repeated transaction failures
    if (worker.consecutiveErrors >= 3) {
      alerts.push({
        code: 'repeated_transaction_failures',
        message: `Instance ${worker.instanceId} experienced ${worker.consecutiveErrors} consecutive transaction failures`,
        severity: 'critical',
        details: {
          instanceId: worker.instanceId,
          consecutiveErrors: worker.consecutiveErrors,
          lastError: worker.lastError,
        },
      });
    }
  }

  // 4. Alert: No active recovery worker instances running
  if (liveWorkersCount === 0) {
    alerts.push({
      code: 'no_active_recovery_instances',
      message: 'No active recovery worker instances detected; concurrency slot auto-recovery is inactive',
      severity: 'critical',
      details: { activeInstances: 0 },
    });
  }

  // 5. Alert: Backlog of expired leases in database
  const expiredLeaseCount = await db
    .collection<ConcurrencyLeaseDocument>(COLLECTIONS.CONCURRENCY_LEASES)
    .countDocuments({
      expiresAt: { $lte: now },
    });

  if (expiredLeaseCount > 0) {
    alerts.push({
      code: 'backlog_expired_leases',
      message: `There are ${expiredLeaseCount} expired concurrency leases awaiting recovery in the database`,
      severity: expiredLeaseCount >= 5 ? 'critical' : 'warning',
      details: { expiredLeaseCount },
    });
  }

  return {
    healthy: alerts.length === 0,
    activeInstances: liveWorkersCount,
    alerts,
  };
}
