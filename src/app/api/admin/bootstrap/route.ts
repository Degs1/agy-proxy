import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import {
  getAdminPreCsrfCookie,
  CSRF_HEADER_NAME,
  verifyAnonymousCsrf,
  verifyMutationOrigin,
} from '@/lib/auth/csrf';
import { executeBootstrap } from '@/lib/auth/bootstrap';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify Origin (Strictly required for admin mutations)
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
  const preCookie = getAdminPreCsrfCookie(request);

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

  // 3. Parse JSON Body
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
  if (!email || !password) {
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

  try {
    const db = await getDatabase();
    const result = await executeBootstrap(db, email, password);

    if (!result.success) {
      if (result.code === 'ALREADY_BOOTSTRAPPED') {
        return NextResponse.json(
          {
            error: {
              code: 'already_bootstrapped',
              message: result.message,
            },
          },
          { status: 409, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      if (result.code === 'INVALID_INPUT') {
        return NextResponse.json(
          {
            error: {
              code: 'invalid_request',
              message: result.message,
            },
          },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      return NextResponse.json(
        {
          error: {
            code: 'bootstrap_failed',
            message: result.message,
          },
        },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: result.message,
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Bootstrap operation encountered an internal error.',
        },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
