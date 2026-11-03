import crypto from 'crypto';
import { getAuthConfig, normalizeOrigin } from './config';

export const ADMIN_SESSION_COOKIE = '__Host-admin_session';
export const ADMIN_PRE_CSRF_COOKIE = '__Host-admin_csrf_pre';
export const CSRF_HEADER_NAME = 'x-csrf-token';

// 15 minutes validity for anonymous pre-session CSRF tokens
export const ANONYMOUS_CSRF_MAX_AGE_SECONDS = 15 * 60;

/**
 * Generate cryptographically secure random bytes as hex string.
 * Default 32 bytes = 256 bits of entropy.
 */
export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * SHA-256 hash of a token string.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Timing-safe string comparison.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Create HMAC-SHA256 signature for data.
 */
function signData(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export interface AnonymousCsrfPair {
  token: string;
  cookieValue: string;
  maxAge: number;
}

/**
 * Creates an anonymous CSRF token and its cryptographically bound signed cookie value.
 */
export function createAnonymousCsrf(secret?: string): AnonymousCsrfPair {
  const authSecret = secret || getAuthConfig().authSecret;
  const token = generateRandomToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + ANONYMOUS_CSRF_MAX_AGE_SECONDS * 1000;

  const dataToSign = `${tokenHash}:${expiresAt}`;
  const signature = signData(authSecret, dataToSign);

  const cookieValue = `${tokenHash}.${expiresAt}.${signature}`;

  return {
    token,
    cookieValue,
    maxAge: ANONYMOUS_CSRF_MAX_AGE_SECONDS,
  };
}

/**
 * Verifies that a raw anonymous CSRF token matches the signed pre-session cookie.
 */
export function verifyAnonymousCsrf(
  token: string | null | undefined,
  cookieValue: string | null | undefined,
  secret?: string
): boolean {
  if (!token || !cookieValue || typeof token !== 'string' || typeof cookieValue !== 'string') {
    return false;
  }

  const parts = cookieValue.split('.');
  if (parts.length !== 3) {
    return false;
  }

  const [cookieTokenHash, expiresAtStr, signature] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    return false; // Expired
  }

  const authSecret = secret || getAuthConfig().authSecret;
  const expectedSignature = signData(authSecret, `${cookieTokenHash}:${expiresAtStr}`);

  if (!timingSafeEqualString(signature, expectedSignature)) {
    return false; // Tampered or wrong secret
  }

  const actualTokenHash = hashToken(token);
  return timingSafeEqualString(cookieTokenHash, actualTokenHash);
}

/**
 * Verify Origin header for admin mutations (POST, PUT, PATCH, DELETE).
 * Requirement 2 AC 2:
 * "Setiap operasi administrasi yang mengubah state, termasuk logout, SHALL mensyaratkan
 * Origin yang sama dengan origin aplikasi... Login SHALL mensyaratkan Origin yang sama."
 */
export function verifyMutationOrigin(
  request: Request,
  expectedOrigin?: string
): { valid: boolean; reason?: string } {
  const targetOrigin = expectedOrigin || getAuthConfig().appOrigin;
  const originHeader = request.headers.get('origin');

  if (!originHeader) {
    return { valid: false, reason: 'Origin header is required for admin mutations' };
  }

  if (originHeader === 'null') {
    return { valid: false, reason: 'Origin null is rejected' };
  }

  const normalizedHeaderOrigin = normalizeOrigin(originHeader);
  if (normalizedHeaderOrigin !== targetOrigin) {
    return { valid: false, reason: `Origin mismatch: expected ${targetOrigin}, got ${normalizedHeaderOrigin}` };
  }

  return { valid: true };
}

/**
 * Origin evidence verification specifically for GET /api/admin/csrf.
 * Approved Design lines 171-172 & PRD:
 * - If Origin is present: must match appOrigin exactly. (Origin: null is rejected).
 * - If Origin is absent: check Sec-Fetch-Site. Must be "same-origin" ("cross-site" / "same-site" rejected).
 * - If Sec-Fetch-Site is absent: check Referer origin. Must match appOrigin exactly.
 * - If multiple origin headers present but conflict: reject.
 * - If no origin evidence at all: reject.
 */
export function verifyCsrfOriginEvidence(
  request: Request,
  expectedOrigin?: string
): { valid: boolean; reason?: string } {
  const targetOrigin = expectedOrigin || getAuthConfig().appOrigin;
  const originHeader = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');
  const referer = request.headers.get('referer');

  // If origin is present
  if (originHeader) {
    if (originHeader === 'null') {
      return { valid: false, reason: 'Origin null is rejected' };
    }
    const normalizedOrigin = normalizeOrigin(originHeader);
    if (normalizedOrigin !== targetOrigin) {
      return { valid: false, reason: `Origin mismatch: expected ${targetOrigin}, got ${normalizedOrigin}` };
    }

    // Check conflict with Referer if also present
    if (referer) {
      try {
        const refererOrigin = normalizeOrigin(new URL(referer).origin);
        if (refererOrigin !== normalizedOrigin) {
          return { valid: false, reason: 'Origin and Referer conflict' };
        }
      } catch {
        return { valid: false, reason: 'Invalid Referer URL' };
      }
    }

    return { valid: true };
  }

  // Origin is not present: check Sec-Fetch-Site
  if (secFetchSite) {
    if (secFetchSite.toLowerCase() !== 'same-origin') {
      return { valid: false, reason: `Sec-Fetch-Site "${secFetchSite}" is rejected; only "same-origin" is allowed` };
    }

    // Check conflict with Referer if also present
    if (referer) {
      try {
        const refererOrigin = normalizeOrigin(new URL(referer).origin);
        if (refererOrigin !== targetOrigin) {
          return { valid: false, reason: 'Referer does not match expected application origin' };
        }
      } catch {
        return { valid: false, reason: 'Invalid Referer URL' };
      }
    }

    return { valid: true };
  }

  // Sec-Fetch-Site is not present: fallback to Referer
  if (referer) {
    try {
      const refererOrigin = normalizeOrigin(new URL(referer).origin);
      if (refererOrigin !== targetOrigin) {
        return { valid: false, reason: `Referer origin "${refererOrigin}" does not match "${targetOrigin}"` };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'Invalid Referer URL' };
    }
  }

  // No origin evidence at all
  return { valid: false, reason: 'No valid origin evidence provided (Origin, Sec-Fetch-Site, or Referer missing)' };
}
