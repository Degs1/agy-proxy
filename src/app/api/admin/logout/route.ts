import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import {
  ADMIN_SESSION_COOKIE,
  DEV_ADMIN_SESSION_COOKIE,
  getAdminSessionCookie,
  CSRF_HEADER_NAME,
  verifyMutationOrigin,
} from '@/lib/auth/csrf';
import {
  verifyAdminSession,
  verifySessionCsrfToken,
  revokeAdminSession,
} from '@/lib/auth/session';
import { getAuthConfig } from '@/lib/auth/config';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify Origin
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

  // 2. Extract session cookie
  const sessionCookie = getAdminSessionCookie(request);
  if (!sessionCookie) {
    return NextResponse.json(
      {
        error: {
          code: 'unauthorized',
          message: 'No active session found',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const db = await getDatabase();
  const sessionResult = await verifyAdminSession(db, sessionCookie);
  if (!sessionResult.valid || !sessionResult.session) {
    return NextResponse.json(
      {
        error: {
          code: 'unauthorized',
          message: 'Session is invalid or expired',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 3. Verify session CSRF token
  const receivedCsrfToken = request.headers.get(CSRF_HEADER_NAME);
  if (!verifySessionCsrfToken(sessionResult.session, receivedCsrfToken)) {
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

  // 4. Revoke session in Atlas
  await revokeAdminSession(db, sessionCookie);

  const { cookieSecure } = getAuthConfig();
  const response = NextResponse.json(
    {
      success: true,
      message: 'Logged out successfully',
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );

  // Clear session cookies (both production and dev)
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  response.cookies.set({
    name: DEV_ADMIN_SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });

  return response;
}
