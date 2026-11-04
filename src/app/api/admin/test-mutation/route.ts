import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import {
  getAdminSessionCookie,
  CSRF_HEADER_NAME,
  verifyMutationOrigin,
} from '@/lib/auth/csrf';
import { verifyAdminSession, verifySessionCsrfToken } from '@/lib/auth/session';

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

  // 2. Verify Session
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

  // 3. Verify Session CSRF Token
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

  return NextResponse.json(
    {
      success: true,
      mutated: true,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
