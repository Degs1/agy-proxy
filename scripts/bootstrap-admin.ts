import { getDatabase, closeDatabaseConnection } from '../src/lib/db/client';
import { executeBootstrap } from '../src/lib/auth/bootstrap';
import { COLLECTIONS } from '../src/lib/db/schema';

async function main() {
  const args = process.argv.slice(2);
  const isForce = args.includes('--force') || args.includes('-f');
  const cleanArgs = args.filter((arg) => arg !== '--force' && arg !== '-f');

  const email = cleanArgs[0] || 'admin@internal.net';
  const password = cleanArgs[1] || 'AdminPassword123!';

  console.log(`Bootstrapping initial admin account (${email})...`);
  const db = await getDatabase();

  const adminCount = await db.collection(COLLECTIONS.ADMINS).countDocuments();
  const guardCount = await db.collection(COLLECTIONS.BOOTSTRAP_GUARD).countDocuments();

  if (isForce) {
    console.log('Force flag detected: clearing existing bootstrap guard and admin records...');
    await db.collection(COLLECTIONS.BOOTSTRAP_GUARD).deleteMany({});
    await db.collection(COLLECTIONS.ADMINS).deleteMany({});
  } else if (guardCount > 0 && adminCount === 0) {
    console.warn('Orphaned bootstrap guard detected (no admins found in database). Auto-recovering guard...');
    await db.collection(COLLECTIONS.BOOTSTRAP_GUARD).deleteMany({});
  }

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
