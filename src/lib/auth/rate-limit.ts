import { Db } from 'mongodb';
import { COLLECTIONS, LoginFailureDocument, LoginFailureReservation } from '../db/schema';
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

  // If multiple comma-separated IPs appear, take first if from trusted ingress or check ambiguity
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim());
    trimmed = parts[0];
  }

  // Check IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  const ipv4MappedMatch = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedMatch) {
    trimmed = ipv4MappedMatch[1];
  }

  // Reject ports (e.g. 192.168.1.1:8080 or [::1]:8080)
  if (/:\d+$/.test(trimmed) && !trimmed.includes('::')) {
    return { valid: false, reason: 'IP with port is not accepted' };
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
  return normalizeIp('127.0.0.1');
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
  return timestamps.filter((ts) => ts.getTime() > cutoff);
}

/**
 * Filter active reservations that have not yet expired.
 */
function cleanReservations(reservations: LoginFailureReservation[], now: Date): {
  active: LoginFailureReservation[];
  expiredCount: number;
} {
  const active: LoginFailureReservation[] = [];
  let expiredCount = 0;

  for (const r of reservations) {
    if (r.expiresAt.getTime() > now.getTime()) {
      active.push(r);
    } else {
      expiredCount++;
    }
  }

  return { active, expiredCount };
}

/**
 * Check rate limit and create reservation for login attempt across Atlas.
 */
export async function reserveLoginAttempt(
  db: Db,
  normalizedEmail: string,
  sourceIp: string,
  attemptId: string
): Promise<RateLimitCheckResult> {
  const now = new Date();
  const col = db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES);

  // 1. Process Email limiter
  const emailDoc = await col.findOne({ type: 'email', identifier: normalizedEmail });
  let emailFailures = emailDoc ? cleanTimestamps(emailDoc.failureTimestamps, now) : [];
  const emailRes = emailDoc ? cleanReservations(emailDoc.activeReservations, now) : { active: [], expiredCount: 0 };
  // Expired reservations count once as failures
  if (emailRes.expiredCount > 0) {
    for (let i = 0; i < emailRes.expiredCount; i++) {
      emailFailures.push(now);
    }
  }

  if (emailFailures.length + emailRes.active.length >= MAX_EMAIL_FAILURES) {
    const oldest = emailFailures[0] || now;
    const retryAfter = Math.ceil((oldest.getTime() + FAILURE_WINDOW_MS - now.getTime()) / 1000);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfter),
      reason: 'email_rate_limit_exceeded',
    };
  }

  // 2. Process IP limiter
  const ipDoc = await col.findOne({ type: 'ip', identifier: sourceIp });
  let ipFailures = ipDoc ? cleanTimestamps(ipDoc.failureTimestamps, now) : [];
  const ipRes = ipDoc ? cleanReservations(ipDoc.activeReservations, now) : { active: [], expiredCount: 0 };
  if (ipRes.expiredCount > 0) {
    for (let i = 0; i < ipRes.expiredCount; i++) {
      ipFailures.push(now);
    }
  }

  if (ipFailures.length + ipRes.active.length >= MAX_IP_FAILURES) {
    const oldest = ipFailures[0] || now;
    const retryAfter = Math.ceil((oldest.getTime() + FAILURE_WINDOW_MS - now.getTime()) / 1000);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfter),
      reason: 'ip_rate_limit_exceeded',
    };
  }

  // 3. Save reservation on both email and IP
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
    { upsert: true }
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
    { upsert: true }
  );

  return { allowed: true };
}

/**
 * Finalize login attempt:
 * - On success: removes reservation, clears email failure timestamps, retains IP failures.
 * - On failure: removes reservation, appends new failure timestamp to both email and IP.
 */
export async function finalizeLoginAttempt(
  db: Db,
  normalizedEmail: string,
  sourceIp: string,
  attemptId: string,
  success: boolean
): Promise<{ expired: boolean }> {
  const now = new Date();
  const col = db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES);

  // Check if attempt reservation is still valid (not expired)
  const emailDoc = await col.findOne({ type: 'email', identifier: normalizedEmail });
  const ipDoc = await col.findOne({ type: 'ip', identifier: sourceIp });

  const emailRes = emailDoc?.activeReservations.find((r) => r.attemptId === attemptId);
  const ipRes = ipDoc?.activeReservations.find((r) => r.attemptId === attemptId);

  if (!emailRes || !ipRes || now > emailRes.expiresAt || now > ipRes.expiresAt) {
    // Attempt expired
    return { expired: true };
  }

  // Remove reservation from email and IP
  const remainingEmailRes = (emailDoc?.activeReservations || []).filter((r) => r.attemptId !== attemptId);
  const remainingIpRes = (ipDoc?.activeReservations || []).filter((r) => r.attemptId !== attemptId);

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
      }
    );

    await col.updateOne(
      { type: 'ip', identifier: sourceIp },
      {
        $set: {
          activeReservations: remainingIpRes,
          updatedAt: now,
        },
      }
    );
  } else {
    // Failure: append current timestamp to email and IP
    await col.updateOne(
      { type: 'email', identifier: normalizedEmail },
      {
        $push: { failureTimestamps: now },
        $set: {
          activeReservations: remainingEmailRes,
          updatedAt: now,
        },
      }
    );

    await col.updateOne(
      { type: 'ip', identifier: sourceIp },
      {
        $push: { failureTimestamps: now },
        $set: {
          activeReservations: remainingIpRes,
          updatedAt: now,
        },
      }
    );
  }

  return { expired: false };
}
