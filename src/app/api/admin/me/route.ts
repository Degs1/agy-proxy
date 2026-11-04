import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import { getAdminSessionCookie } from '@/lib/auth/csrf';
import { verifyAdminSession } from '@/lib/auth/session';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sessionCookie = getAdminSessionCookie(request);
  if (!sessionCookie) {
    return NextResponse.json(
      {
        error: {
          code: 'unauthorized',
          message: 'Authentication session required.',
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const db = await getDatabase();
  const sessionResult = await verifyAdminSession(db, sessionCookie);

  if (!sessionResult.valid || !sessionResult.admin) {
    const status = sessionResult.reason === 'admin_forbidden' ? 403 : 401;
    return NextResponse.json(
      {
        error: {
          code: status === 403 ? 'forbidden' : 'unauthorized',
          message: 'Invalid or expired session.',
        },
      },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      admin: {
        id: sessionResult.admin._id?.toString(),
        email: sessionResult.admin.email,
        role: sessionResult.admin.role,
        status: sessionResult.admin.status,
      },
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
