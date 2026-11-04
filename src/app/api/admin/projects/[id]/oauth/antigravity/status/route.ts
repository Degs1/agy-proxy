import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { oauthSessionStore } from '@/lib/antigravity/oauth';
import { getCredentialById } from '@/lib/credentials/service';
import { formatCredentialResponse } from '@/lib/credentials/schema';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * GET /api/admin/projects/:id/oauth/antigravity/status?state=...
 * Returns the status of an ongoing local OAuth flow.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const db = await getDatabase();
  const auth = await authenticateAdminRequest(request, db, { isMutation: false });
  if (!auth.valid) {
    return auth.response;
  }

  const { id } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid project ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const { searchParams } = new URL(request.url);
  const state = searchParams.get('state');

  if (!state) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Parameter state is required' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const session = oauthSessionStore.get(state);
  if (!session) {
    return NextResponse.json(
      { status: 'expired', message: 'Session not found or expired' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (session.status === 'completed' && session.credentialId) {
    const cred = await getCredentialById(db, id, session.credentialId);
    return NextResponse.json(
      {
        status: 'completed',
        credential: cred ? formatCredentialResponse(cred) : null,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      status: session.status,
      error: session.error || null,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

