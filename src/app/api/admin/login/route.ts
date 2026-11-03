import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_PRE_CSRF_COOKIE,
  CSRF_HEADER_NAME,
  generateRandomToken,
  verifyAnonymousCsrf,
  verifyMutationOrigin,
} from '@/lib/auth/csrf';
import { getAuthConfig } from '@/lib/auth/config';
import { normalizeEmail } from '@/lib/auth/bootstrap';
import { verifyPassword } from '@/lib/auth/password';
import { createAdminSession, SESSION_ABSOLUTE_LIFETIME_MS } from '@/lib/auth/session';
import {
  getTrustedSourceIp,
  reserveLoginAttempt,
  finalizeLoginAttempt,
} from '@/lib/auth/rate-limit';
import { COLLECTIONS, AdminDocument } from '@/lib/db/schema';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify Origin (Strictly required for login)
  const originCheck = verifyMutationOrigin(request);
  if (!originCheck.valid) {
    return NextResponse.json(
      {
        error: {
          code: 'origin_rejected',
          message: originCheck.reason || 'Forbidden: Origin validation failed',
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Verify Anonymous CSRF (pre-session cookie and X-CSRF-Token header)
  const xCsrfToken = request.headers.get(CSRF_HEADER_NAME);
  const preCookie = request.cookies.get(ADMIN_PRE_CSRF_COOKIE)?.value;

  if (!xCsrfToken || !preCookie || !verifyAnonymousCsrf(xCsrfToken, preCookie)) {
    return NextResponse.json(
      {
        error: {
          code: 'csrf_rejected',
          message: 'Forbidden: Invalid or missing CSRF token',
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 3. Trusted IP address verification
  const sourceIp = getTrustedSourceIp(request);
  if (!sourceIp.valid || !sourceIp.ip) {
    return NextResponse.json(
      {
        error: {
          code: 'source_untrusted',
          message: sourceIp.reason || 'Service Unavailable: Source IP cannot be verified',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 4. Parse request body
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Invalid JSON payload.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const { email, password } = body || {};
  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Email and password are required.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const normalizedEmail = normalizeEmail(email);
  const db = await getDatabase();

  // 5. Rate Limiting: reserve attempt
  const attemptId = generateRandomToken(16);
  const rateLimitResult = await reserveLoginAttempt(
    db,
    normalizedEmail,
    sourceIp.ip,
    attemptId
  );

  if (!rateLimitResult.allowed) {
    const retryAfter = rateLimitResult.retryAfterSeconds || 60;
    return NextResponse.json(
      {
        error: {
          code: 'rate_limit_exceeded',
          message: 'Too many failed login attempts. Please try again later.',
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfter),
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  // 6. Look up admin document
  const admin = await db
    .collection<AdminDocument>(COLLECTIONS.ADMINS)
    .findOne({ email: normalizedEmail });

  // 7. Verify credentials
  let isValidPassword = false;
  if (admin && admin.status === 'active' && admin.role === 'admin') {
    isValidPassword = await verifyPassword(admin.passwordHash, password);
  }

  // 8. Finalize attempt in limiter
  const finalizeResult = await finalizeLoginAttempt(
    db,
    normalizedEmail,
    sourceIp.ip,
    attemptId,
    isValidPassword
  );

  if (finalizeResult.expired) {
    return NextResponse.json(
      {
        error: {
          code: 'login_attempt_expired',
          message: 'Login attempt expired. Please try again.',
        },
      },
      { status: 409, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (!isValidPassword || !admin || !admin._id) {
    // Return generic error for both non-existent and wrong-password cases
    return NextResponse.json(
      {
        error: {
          code: 'invalid_credentials',
          message: 'Invalid email or password.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 9. Login Succeeded: create admin session
  const sessionResult = await createAdminSession(db, admin._id);
  const { cookieSecure } = getAuthConfig();

  const response = NextResponse.json(
    {
      success: true,
      csrfToken: sessionResult.csrfToken,
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );

  // Set __Host-admin_session cookie
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: sessionResult.sessionToken,
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(SESSION_ABSOLUTE_LIFETIME_MS / 1000),
  });

  // Clear anonymous pre-session cookie
  response.cookies.set({
    name: ADMIN_PRE_CSRF_COOKIE,
    value: '',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });

  return response;
}
