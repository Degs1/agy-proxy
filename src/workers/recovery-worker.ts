import { getDatabase, closeDatabaseConnection } from '../lib/db/client';
import { LeaseRecoveryRunner } from '../lib/limiter/recovery-runner';

async function main() {
  console.log('[RecoveryWorker] Starting background lease recovery worker...');
  const db = await getDatabase();
  const runner = new LeaseRecoveryRunner(db, {
    scanIntervalMs: 5000,
    onScanComplete: ({ reconciledCount, durationMs }) => {
      if (reconciledCount > 0) {
        console.log(
          `[RecoveryWorker] Reconciled ${reconciledCount} expired leases in ${durationMs}ms`
        );
      }
    },
    onError: (err) => {
      console.error('[RecoveryWorker] Error during recovery cycle:', err);
    },
  });

  await runner.start();
  console.log(
    `[RecoveryWorker] Worker instance ${runner.instanceId} started. Scanning every 5s.`
  );

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[RecoveryWorker] Received ${signal}. Shutting down gracefully...`);
    try {
      await runner.stop();
      await closeDatabaseConnection();
      console.log('[RecoveryWorker] Graceful shutdown completed.');
      process.exit(0);
    } catch (err) {
      console.error('[RecoveryWorker] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[RecoveryWorker] Fatal startup error:', err);
  process.exit(1);
});
