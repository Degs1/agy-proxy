import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import {
  getAdminPreCsrfCookieName,
  getAdminSessionCookie,
  createAnonymousCsrf,
  verifyCsrfOriginEvidence,
} from '@/lib/auth/csrf';
import { verifyAdminSession, rotateSessionCsrfToken } from '@/lib/auth/session';
import { getAuthConfig } from '@/lib/auth/config';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Verify Origin evidence according to contract:
  // Same-origin Origin, Sec-Fetch-Site: same-origin, or matching Referer
  const originCheck = verifyCsrfOriginEvidence(request);
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

  const { cookieSecure } = getAuthConfig();
  const sessionCookie = getAdminSessionCookie(request);

  try {
    const db = await getDatabase();

    // 2. If session cookie is present, attempt session verification & CSRF token rotation
    if (sessionCookie) {
      const sessionResult = await verifyAdminSession(db, sessionCookie);
      if (sessionResult.valid && sessionResult.session) {
        // Active session: rotate session CSRF token atomically
        const { csrfToken } = await rotateSessionCsrfToken(db, sessionCookie);

        const response = NextResponse.json(
          { csrfToken },
          {
            status: 200,
            headers: {
              'Cache-Control': 'no-store',
            },
          }
        );
        return response;
      }
    }

    // 3. Pre-login state: issue anonymous CSRF token bound to signed pre-session cookie
    const anonPair = createAnonymousCsrf();
    const response = NextResponse.json(
      { csrfToken: anonPair.token },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );

    // Set signed pre-session cookie with limited lifetime (15 mins)
    response.cookies.set({
      name: getAdminPreCsrfCookieName(),
      value: anonPair.cookieValue,
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: anonPair.maxAge,
    });

    return response;
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Failed to generate CSRF token.',
        },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
