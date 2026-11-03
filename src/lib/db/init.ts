import { getDatabase } from './client';
import { initDatabaseIndexes } from './indexes';

export async function initDb(): Promise<void> {
  const db = await getDatabase();
  await initDatabaseIndexes(db);
}

// Support direct CLI invocation: npx tsx src/lib/db/init.ts
if (typeof require !== 'undefined' && require.main === module) {
  initDb()
    .then(() => {
      console.log('Database indexes initialized successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to initialize database indexes:', err.message);
      process.exit(1);
    });
}
