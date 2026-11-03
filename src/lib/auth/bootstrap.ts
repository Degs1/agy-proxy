import { Db } from 'mongodb';
import { withTransaction } from '../db/client';
import { COLLECTIONS, BootstrapGuardDocument, AdminDocument } from '../db/schema';
import { hashPassword } from './password';

export const BOOTSTRAP_GUARD_ID = 'bootstrap_singleton';

export interface BootstrapResult {
  success: boolean;
  code?: 'SUCCESS' | 'ALREADY_BOOTSTRAPPED' | 'INVALID_INPUT' | 'TRANSACTION_FAILED';
  message: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Execute transactional bootstrap in MongoDB Atlas.
 * Inserts fixed-ID bootstrap_guard and initial admin in one multi-document transaction.
 * Unique constraint on fixed-ID bootstrap_guard ensures only one bootstrap can succeed.
 */
export async function executeBootstrap(
  db: Db,
  email: string,
  password: string
): Promise<BootstrapResult> {
  const normalizedEmail = normalizeEmail(email);

  // Basic validation
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: 'Invalid email format.',
    };
  }

  if (!password || password.length < 8) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: 'Password must be at least 8 characters long.',
    };
  }

  // Pre-check outside transaction to avoid unnecessary transactions if already bootstrapped
  const existingGuard = await db
    .collection<BootstrapGuardDocument>(COLLECTIONS.BOOTSTRAP_GUARD)
    .findOne({ _id: BOOTSTRAP_GUARD_ID });

  if (existingGuard) {
    return {
      success: false,
      code: 'ALREADY_BOOTSTRAPPED',
      message: 'Initial admin has already been bootstrapped.',
    };
  }

  const existingAdmin = await db
    .collection<AdminDocument>(COLLECTIONS.ADMINS)
    .findOne({ email: normalizedEmail });

  if (existingAdmin) {
    return {
      success: false,
      code: 'ALREADY_BOOTSTRAPPED',
      message: 'Initial admin has already been bootstrapped.',
    };
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  try {
    await withTransaction(async (session) => {
      // 1. Insert bootstrap guard document with fixed singleton ID
      await db.collection<BootstrapGuardDocument>(COLLECTIONS.BOOTSTRAP_GUARD).insertOne(
        {
          _id: BOOTSTRAP_GUARD_ID,
          bootstrappedAt: now,
          initialAdminEmail: normalizedEmail,
        },
        { session }
      );

      // 2. Insert initial admin document
      await db.collection<AdminDocument>(COLLECTIONS.ADMINS).insertOne(
        {
          email: normalizedEmail,
          passwordHash,
          role: 'admin',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        { session }
      );
    });

    return {
      success: true,
      code: 'SUCCESS',
      message: 'Initial admin bootstrapped successfully.',
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('E11000') || errMsg.includes('duplicate key')) {
      return {
        success: false,
        code: 'ALREADY_BOOTSTRAPPED',
        message: 'Initial admin has already been bootstrapped.',
      };
    }

    return {
      success: false,
      code: 'TRANSACTION_FAILED',
      message: 'Bootstrap transaction failed.',
    };
  }
}
