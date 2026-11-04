import { getDatabase, closeDatabaseConnection } from '../src/lib/db/client';
import { executeBootstrap } from '../src/lib/auth/bootstrap';

async function main() {
  const email = process.argv[2] || 'admin@internal.net';
  const password = process.argv[3] || 'AdminPassword123!';

  console.log(`Bootstrapping initial admin account (${email})...`);
  const db = await getDatabase();
  const result = await executeBootstrap(db, email, password);
  console.log('Bootstrap result:', result);
  await closeDatabaseConnection();

  if (!result.success && result.code !== 'ALREADY_BOOTSTRAPPED') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
