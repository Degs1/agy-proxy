import { getDatabase, closeDatabaseConnection } from './client';
import { getDatabaseConfig, maskMongoUri, sanitizeDiagnosticText } from './config';
import { initDatabaseIndexes, verifyDatabaseIndexes, IndexVerificationResult } from './indexes';

export interface InitDbResult {
  initialized: boolean;
  sanitizedUri: string;
  verification: IndexVerificationResult;
}

export async function initDb(): Promise<InitDbResult> {
  const config = getDatabaseConfig();
  const db = await getDatabase();

  await initDatabaseIndexes(db);
  const verification = await verifyDatabaseIndexes(db);

  return {
    initialized: verification.ready,
    sanitizedUri: maskMongoUri(config.uri),
    verification,
  };
}

// Support direct CLI invocation: tsx src/lib/db/init.ts
if (typeof require !== 'undefined' && require.main === module) {
  initDb()
    .then((result) => {
      console.log(`Database indexes initialized successfully on ${result.sanitizedUri}.`);
      console.log(`Verified ${result.verification.present.length} critical indexes.`);
      closeDatabaseConnection().then(() => {
        process.exit(result.initialized ? 0 : 1);
      });
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to initialize database indexes:', sanitizeDiagnosticText(msg));
      closeDatabaseConnection().then(() => {
        process.exit(1);
      });
    });
}
