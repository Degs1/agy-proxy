import { Db } from 'mongodb';
import { COLLECTIONS, LoginFailureDocument, LoginFailureReservation } from '../db/schema';
import { withTransaction } from '../db/client';
import net from 'net';

export const MAX_EMAIL_FAILURES = 5;
export const MAX_IP_FAILURES = 20;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const RESERVATION_LIFETIME_MS = 30 * 1000; // 30 seconds

export interface IpExtractionResult {
  valid: boolean;
  ip?: string;
  reason?: string;
}

/**
 * Normalizes an IPv4 or IPv6 string.
 * Normalizes IPv4-mapped IPv6 (::ffff:192.0.2.1) to pure IPv4.
 * Rejects ports, lists, or invalid IPs.
 */
export function normalizeIp(rawIp: string | null | undefined): IpExtractionResult {
  if (!rawIp || typeof rawIp !== 'string') {
    return { valid: false, reason: 'IP is missing' };
  }

  let trimmed = rawIp.trim();

  // If multiple comma-separated IPs appear, take first if from trusted ingress
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim());
    trimmed = parts[0];
  }

  // Reject ports:
  // - IPv4 with port: e.g. 192.168.1.1:8080 (contains dot then colon and port digits)
  // - IPv6 bracketed with port: e.g. [2001:db8::1]:8080 or [::1]:8080
  if (/\.\d+:\d+$/.test(trimmed) || /^\[.+\]:\d+$/.test(trimmed)) {
    return { valid: false, reason: 'IP with port is not accepted' };
  }

  // Check IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  const ipv4MappedMatch = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedMatch) {
    trimmed = ipv4MappedMatch[1];
  }

  // Strip brackets from standard bracketed IPv6 without port: [::1] -> ::1
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    trimmed = trimmed.slice(1, -1);
  }

  const ipType = net.isIP(trimmed);
  if (ipType === 0) {
    return { valid: false, reason: 'Invalid IP address' };
  }

  return { valid: true, ip: trimmed.toLowerCase() };
}

/**
 * Extract trusted source IP from request headers.
 */
export function getTrustedSourceIp(request: Request): IpExtractionResult {
  // In Vercel, x-vercel-forwarded-for contains client IP set by edge ingress
  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  if (vercelIp) {
    return normalizeIp(vercelIp);
  }

  // Fallback to x-forwarded-for or x-real-ip in test/dev environments
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    return normalizeIp(xForwardedFor);
  }

  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) {
    return normalizeIp(xRealIp);
  }

  // In test environments or direct Node requests
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
    return normalizeIp('127.0.0.1');
  }

  return { valid: false, reason: 'Untrusted or missing source IP' };
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: 'email_rate_limit_exceeded' | 'ip_rate_limit_exceeded';
}

/**
 * Filter failure timestamps within the rolling 15-minute window.
 */
function cleanTimestamps(timestamps: Date[], now: Date): Date[] {
  const cutoff = now.getTime() - FAILURE_WINDOW_MS;
  return (timestamps || []).filter((ts) => new Date(ts).getTime() > cutoff);
}

/**
 * Filter active reservations that have not yet expired according to reference time.
 */
function cleanReservations(reservations: LoginFailureReservation[], now: Date): {
  active: LoginFailureReservation[];
} {
  const active: LoginFailureReservation[] = [];
  for (const r of reservations || []) {
    if (new Date(r.expiresAt).getTime() > now.getTime()) {
      active.push(r);
    }
  }
  return { active };
}

/**
 * Calculate the earliest time when capacity will drop below the limit.
 */
function calculateEarliestCapacityTime(
  failures: Date[],
  activeReservations: LoginFailureReservation[],
  now: Date,
  limit: number
): Date {
  const expiryTimes: number[] = [];

  for (const f of failures) {
    expiryTimes.push(new Date(f).getTime() + FAILURE_WINDOW_MS);
  }
  for (const r of activeReservations) {
    expiryTimes.push(new Date(r.expiresAt).getTime());
  }

  expiryTimes.sort((a, b) => a - b);

  const currentCount = expiryTimes.length;
  const needed = currentCount - limit + 1;

  if (needed <= 0 || expiryTimes.length === 0) {
    return new Date(now.getTime() + 1000);
  }

  const targetIndex = Math.min(needed - 1, expiryTimes.length - 1);
  return new Date(expiryTimes[targetIndex]);
}

/**
 * Atomically obtain Atlas server time using an update pipeline with $$NOW.
 */
async function getAtlasServerTime(db: Db, session: any): Promise<Date> {
  const guard = await db.collection(COLLECTIONS.LOGIN_FAILURES).findOneAndUpdate(
    { type: 'guard' as any, identifier: 'global_login_guard' },
    [
      {
        $set: {
          lastServerTime: '$$NOW',
          revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { upsert: true, returnDocument: 'after', session }
  );

  return guard?.lastServerTime ? new Date(guard.lastServerTime) : new Date();
}

/**
 * Check rate limit and create reservation for login attempt across Atlas.
 * Runs atomically inside a multi-document transaction using Atlas server time.
 */
export async function reserveLoginAttempt(
  db: Db,
  normalizedEmail: string,
  sourceIp: string,
  attemptId: string
): Promise<RateLimitCheckResult> {
  return withTransaction(async (session) => {
    // 1. Obtain Atlas server time
    const now = await getAtlasServerTime(db, session);
    const col = db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES);

    // 2. Process Email limiter
    const emailDoc = await col.findOne(
      { type: 'email', identifier: normalizedEmail },
      { session }
    );
    const emailFailures = emailDoc ? cleanTimestamps(emailDoc.failureTimestamps, now) : [];
    const emailRes = emailDoc ? cleanReservations(emailDoc.activeReservations, now) : { active: [] };

    if (emailFailures.length + emailRes.active.length >= MAX_EMAIL_FAILURES) {
      const earliestAvailable = calculateEarliestCapacityTime(
        emailFailures,
        emailRes.active,
        now,
        MAX_EMAIL_FAILURES
      );
      const retryAfter = Math.ceil((earliestAvailable.getTime() - now.getTime()) / 1000);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, retryAfter),
        reason: 'email_rate_limit_exceeded',
      };
    }

    // 3. Process IP limiter
    const ipDoc = await col.findOne(
      { type: 'ip', identifier: sourceIp },
      { session }
    );
    const ipFailures = ipDoc ? cleanTimestamps(ipDoc.failureTimestamps, now) : [];
    const ipRes = ipDoc ? cleanReservations(ipDoc.activeReservations, now) : { active: [] };

    if (ipFailures.length + ipRes.active.length >= MAX_IP_FAILURES) {
      const earliestAvailable = calculateEarliestCapacityTime(
        ipFailures,
        ipRes.active,
        now,
        MAX_IP_FAILURES
      );
      const retryAfter = Math.ceil((earliestAvailable.getTime() - now.getTime()) / 1000);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, retryAfter),
        reason: 'ip_rate_limit_exceeded',
      };
    }

    // 4. Save reservation on both email and IP atomically
    const reservationExpiresAt = new Date(now.getTime() + RESERVATION_LIFETIME_MS);
    const newReservation: LoginFailureReservation = {
      attemptId,
      expiresAt: reservationExpiresAt,
    };

    await col.updateOne(
      { type: 'email', identifier: normalizedEmail },
      {
        $set: {
          failureTimestamps: emailFailures,
          activeReservations: [...emailRes.active, newReservation],
          updatedAt: now,
        },
      },
      { upsert: true, session }
    );

    await col.updateOne(
      { type: 'ip', identifier: sourceIp },
      {
        $set: {
          failureTimestamps: ipFailures,
          activeReservations: [...ipRes.active, newReservation],
          updatedAt: now,
        },
      },
      { upsert: true, session }
    );

    return { allowed: true };
  });
}

/**
 * Finalize login attempt atomically across Atlas:
 * - On success: removes reservation, clears email failure timestamps, retains IP failures.
 * - On failure: removes reservation, appends new failure timestamp to both email and IP.
 * - Expired reservations cannot produce sessions.
 * - Competing finalizations cannot count an attempt twice.
 */
export async function finalizeLoginAttempt(
  db: Db,
  normalizedEmail: string,
  sourceIp: string,
  attemptId: string,
  success: boolean
): Promise<{ expired: boolean; alreadyFinalized?: boolean }> {
  return withTransaction(async (session) => {
    // 1. Obtain Atlas server time
    const now = await getAtlasServerTime(db, session);
    const col = db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES);

    // 2. Check if attempt reservation exists and is active
    const emailDoc = await col.findOne(
      { type: 'email', identifier: normalizedEmail },
      { session }
    );
    const ipDoc = await col.findOne(
      { type: 'ip', identifier: sourceIp },
      { session }
    );

    const emailRes = emailDoc?.activeReservations.find((r) => r.attemptId === attemptId);
    const ipRes = ipDoc?.activeReservations.find((r) => r.attemptId === attemptId);

    // If reservation is not present on either document, it was already finalized
    if (!emailRes && !ipRes) {
      return { expired: false, alreadyFinalized: true };
    }

    const isExpired =
      !emailRes ||
      !ipRes ||
      new Date(emailRes.expiresAt).getTime() <= now.getTime() ||
      new Date(ipRes.expiresAt).getTime() <= now.getTime();

    // Clean remaining reservations (removing attemptId and any expired ones)
    const remainingEmailRes = (emailDoc?.activeReservations || []).filter(
      (r) => r.attemptId !== attemptId && new Date(r.expiresAt).getTime() > now.getTime()
    );
    const remainingIpRes = (ipDoc?.activeReservations || []).filter(
      (r) => r.attemptId !== attemptId && new Date(r.expiresAt).getTime() > now.getTime()
    );

    const cleanEmailFailures = emailDoc ? cleanTimestamps(emailDoc.failureTimestamps, now) : [];
    const cleanIpFailures = ipDoc ? cleanTimestamps(ipDoc.failureTimestamps, now) : [];

    if (isExpired) {
      // Remove expired reservation from both documents
      await col.updateOne(
        { type: 'email', identifier: normalizedEmail },
        {
          $set: {
            failureTimestamps: cleanEmailFailures,
            activeReservations: remainingEmailRes,
            updatedAt: now,
          },
        },
        { session }
      );

      await col.updateOne(
        { type: 'ip', identifier: sourceIp },
        {
          $set: {
            failureTimestamps: cleanIpFailures,
            activeReservations: remainingIpRes,
            updatedAt: now,
          },
        },
        { session }
      );

      return { expired: true };
    }

    if (success) {
      // Success: clear email failure timestamps, retain IP failures
      await col.updateOne(
        { type: 'email', identifier: normalizedEmail },
        {
          $set: {
            failureTimestamps: [],
            activeReservations: remainingEmailRes,
            updatedAt: now,
          },
        },
        { session }
      );

      await col.updateOne(
        { type: 'ip', identifier: sourceIp },
        {
          $set: {
            failureTimestamps: cleanIpFailures,
            activeReservations: remainingIpRes,
            updatedAt: now,
          },
        },
        { session }
      );
    } else {
      // Failure: append current timestamp to both email and IP
      await col.updateOne(
        { type: 'email', identifier: normalizedEmail },
        {
          $set: {
            failureTimestamps: [...cleanEmailFailures, now],
            activeReservations: remainingEmailRes,
            updatedAt: now,
          },
        },
        { session }
      );

      await col.updateOne(
        { type: 'ip', identifier: sourceIp },
        {
          $set: {
            failureTimestamps: [...cleanIpFailures, now],
            activeReservations: remainingIpRes,
            updatedAt: now,
          },
        },
        { session }
      );
    }

    return { expired: false, alreadyFinalized: false };
  });
}
