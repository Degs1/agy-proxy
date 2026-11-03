import { NextRequest, NextResponse } from 'next/server';
import { Db } from 'mongodb';
import {
  ADMIN_SESSION_COOKIE,
  CSRF_HEADER_NAME,
  verifyMutationOrigin,
} from '@/lib/auth/csrf';
import { verifyAdminSession, verifySessionCsrfToken } from '@/lib/auth/session';
import { AdminDocument, AdminSessionDocument } from '@/lib/db/schema';

export interface AdminAuthContext {
  valid: true;
  admin: AdminDocument;
  session: AdminSessionDocument;
}

export type AdminAuthResult =
  | AdminAuthContext
  | {
      valid: false;
      response: NextResponse;
    };

/**
 * Validates admin request authentication and CSRF protection.
 * For mutations (POST, PATCH, DELETE, PUT), enforces same-origin and session CSRF token.
 */
export async function authenticateAdminRequest(
  request: NextRequest,
  db: Db,
  options?: { isMutation?: boolean }
): Promise<AdminAuthResult> {
  const isMutation = options?.isMutation ?? false;

  // 1. If mutation, verify Origin strictly
  if (isMutation) {
    const originCheck = verifyMutationOrigin(request);
    if (!originCheck.valid) {
      return {
        valid: false,
        response: NextResponse.json(
          {
            error: {
              code: 'origin_rejected',
              message: originCheck.reason || 'Forbidden: Origin validation failed',
            },
          },
          { status: 403, headers: { 'Cache-Control': 'no-store' } }
        ),
      };
    }
  }

  // 2. Verify Session Cookie
  const sessionCookie = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!sessionCookie) {
    return {
      valid: false,
      response: NextResponse.json(
        {
          error: {
            code: 'unauthorized',
            message: 'Authentication session required.',
          },
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      ),
    };
  }

  const sessionResult = await verifyAdminSession(db, sessionCookie);
  if (!sessionResult.valid || !sessionResult.admin || !sessionResult.session) {
    const status = sessionResult.reason === 'admin_forbidden' ? 403 : 401;
    return {
      valid: false,
      response: NextResponse.json(
        {
          error: {
            code: status === 403 ? 'forbidden' : 'unauthorized',
            message: 'Invalid or expired session.',
          },
        },
        { status, headers: { 'Cache-Control': 'no-store' } }
      ),
    };
  }

  // 3. If mutation, verify CSRF token
  if (isMutation) {
    const receivedCsrfToken = request.headers.get(CSRF_HEADER_NAME);
    if (!verifySessionCsrfToken(sessionResult.session, receivedCsrfToken)) {
      return {
        valid: false,
        response: NextResponse.json(
          {
            error: {
              code: 'csrf_rejected',
              message: 'Forbidden: Invalid or missing CSRF token',
            },
          },
          { status: 403, headers: { 'Cache-Control': 'no-store' } }
        ),
      };
    }
  }

  return {
    valid: true,
    admin: sessionResult.admin,
    session: sessionResult.session,
  };
}
