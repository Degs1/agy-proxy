import { Db, ObjectId, ClientSession } from 'mongodb';
import { COLLECTIONS, AdminSessionDocument, AdminDocument } from '../db/schema';
import { generateRandomToken, hashToken, timingSafeEqualString } from './csrf';

// Constants
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours
export const SESSION_IDLE_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes

export interface CreateSessionResult {
  sessionToken: string;
  csrfToken: string;
  session: AdminSessionDocument;
}

export interface VerifySessionResult {
  valid: boolean;
  admin?: AdminDocument;
  session?: AdminSessionDocument;
  reason?:
    | 'no_token'
    | 'session_not_found'
    | 'session_revoked'
    | 'session_expired_absolute'
    | 'session_expired_idle'
    | 'admin_not_found'
    | 'admin_inactive'
    | 'admin_forbidden';
}

/**
 * Creates a new admin session in MongoDB Atlas.
 * Stores only hashes of the session token and CSRF token.
 */
export async function createAdminSession(
  db: Db,
  adminId: ObjectId,
  mongoSession?: ClientSession
): Promise<CreateSessionResult> {
  const sessionToken = generateRandomToken(32);
  const csrfToken = generateRandomToken(32);

  const sessionTokenHash = hashToken(sessionToken);
  const csrfTokenHash = hashToken(csrfToken);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_LIFETIME_MS);

  const sessionDoc: AdminSessionDocument = {
    sessionTokenHash,
    adminId,
    createdAt: now,
    expiresAt,
    lastActivityAt: now,
    isRevoked: false,
    csrfTokenHash,
  };

  const options = mongoSession ? { session: mongoSession } : {};
  const insertResult = await db
    .collection<AdminSessionDocument>(COLLECTIONS.ADMIN_SESSIONS)
    .insertOne(sessionDoc, options);

  sessionDoc._id = insertResult.insertedId;

  return {
    sessionToken,
    csrfToken,
    session: sessionDoc,
  };
}

/**
 * Verifies an admin session against MongoDB Atlas.
 * Checks token validity, absolute expiry, idle expiry, revocation, and admin permissions.
 * Updates lastActivityAt on valid requests.
 */
export async function verifyAdminSession(
  db: Db,
  rawSessionToken: string | null | undefined,
  options?: { skipTouchActivity?: boolean }
): Promise<VerifySessionResult> {
  if (!rawSessionToken || typeof rawSessionToken !== 'string') {
    return { valid: false, reason: 'no_token' };
  }

  const tokenHash = hashToken(rawSessionToken);

  const session = await db
    .collection<AdminSessionDocument>(COLLECTIONS.ADMIN_SESSIONS)
    .findOne({ sessionTokenHash: tokenHash });

  if (!session) {
    return { valid: false, reason: 'session_not_found' };
  }

  if (session.isRevoked) {
    return { valid: false, reason: 'session_revoked' };
  }

  const now = new Date();

  // Check absolute expiration (12 hours)
  if (now > session.expiresAt) {
    return { valid: false, reason: 'session_expired_absolute' };
  }

  // Check idle timeout (30 minutes)
  const idleElapsed = now.getTime() - session.lastActivityAt.getTime();
  if (idleElapsed > SESSION_IDLE_LIFETIME_MS) {
    return { valid: false, reason: 'session_expired_idle' };
  }

  // Query admin document to verify active admin status
  const admin = await db
    .collection<AdminDocument>(COLLECTIONS.ADMINS)
    .findOne({ _id: session.adminId });

  if (!admin) {
    return { valid: false, reason: 'admin_not_found' };
  }

  if (admin.status !== 'active') {
    return { valid: false, reason: 'admin_inactive' };
  }

  if (admin.role !== 'admin') {
    return { valid: false, reason: 'admin_forbidden' };
  }

  // Update last activity timestamp in Atlas unless explicitly skipped
  if (!options?.skipTouchActivity) {
    await db
      .collection<AdminSessionDocument>(COLLECTIONS.ADMIN_SESSIONS)
      .updateOne({ _id: session._id }, { $set: { lastActivityAt: now } });
    session.lastActivityAt = now;
  }

  return {
    valid: true,
    admin,
    session,
  };
}

/**
 * Revokes an admin session in Atlas immediately across all instances.
 */
export async function revokeAdminSession(
  db: Db,
  rawSessionToken: string | null | undefined
): Promise<boolean> {
  if (!rawSessionToken) {
    return false;
  }

  const tokenHash = hashToken(rawSessionToken);

  const result = await db
    .collection<AdminSessionDocument>(COLLECTIONS.ADMIN_SESSIONS)
    .updateOne({ sessionTokenHash: tokenHash }, { $set: { isRevoked: true } });

  return result.modifiedCount > 0;
}

/**
 * Rotates the session CSRF token atomically.
 * Returns the new raw CSRF token. The old CSRF token is immediately invalidated.
 */
export async function rotateSessionCsrfToken(
  db: Db,
  rawSessionToken: string
): Promise<{ csrfToken: string }> {
  const tokenHash = hashToken(rawSessionToken);
  const newCsrfToken = generateRandomToken(32);
  const newCsrfTokenHash = hashToken(newCsrfToken);

  const result = await db
    .collection<AdminSessionDocument>(COLLECTIONS.ADMIN_SESSIONS)
    .findOneAndUpdate(
      { sessionTokenHash: tokenHash, isRevoked: false },
      { $set: { csrfTokenHash: newCsrfTokenHash, lastActivityAt: new Date() } },
      { returnDocument: 'after' }
    );

  if (!result) {
    throw new Error('Active session not found for CSRF rotation');
  }

  return { csrfToken: newCsrfToken };
}

/**
 * Verifies that a received mutation CSRF token matches the session's active CSRF token hash.
 */
export function verifySessionCsrfToken(
  session: AdminSessionDocument,
  receivedCsrfToken: string | null | undefined
): boolean {
  if (!receivedCsrfToken || !session.csrfTokenHash) {
    return false;
  }

  const receivedHash = hashToken(receivedCsrfToken);
  return timingSafeEqualString(receivedHash, session.csrfTokenHash);
}
