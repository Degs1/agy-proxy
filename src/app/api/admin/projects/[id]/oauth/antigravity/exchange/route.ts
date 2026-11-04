import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getProjectById } from '@/lib/projects/service';
import {
  completeOAuthFlow,
  oauthSessionStore,
} from '@/lib/antigravity/oauth';
import { formatCredentialResponse } from '@/lib/credentials/schema';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * POST /api/admin/projects/:id/oauth/antigravity/exchange
 * Exchanges authorization code for tokens, verifies Antigravity access, and persists credential.
 * Supports both automatic local server callback and manual user input.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const db = await getDatabase();
  const auth = await authenticateAdminRequest(request, db, { isMutation: true });
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

  const project = await getProjectById(db, id);
  if (!project) {
    return NextResponse.json(
      { error: { code: 'project_not_found', message: `Project ${id} not found` } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body: {
    code?: string;
    state?: string;
    codeVerifier?: string;
    displayName?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Malformed JSON payload' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let rawCode = body.code?.trim() || '';
  let state = body.state?.trim() || '';
  let codeVerifier = body.codeVerifier?.trim() || '';

  // Handle case where user pasted the full redirect URL
  if (rawCode.includes('?') || rawCode.startsWith('http')) {
    try {
      const parsedUrl = new URL(rawCode);
      const urlCode = parsedUrl.searchParams.get('code');
      const urlState = parsedUrl.searchParams.get('state');
      if (urlCode) rawCode = urlCode;
      if (urlState && !state) state = urlState;
    } catch {
      // Not a standard URL, continue with rawCode
    }
  }

  if (!rawCode) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Authorization code is required' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // If codeVerifier was not passed, check sessionStore via state
  if (!codeVerifier && state) {
    const session = oauthSessionStore.get(state);
    if (session) {
      codeVerifier = session.codeVerifier;
    }
  }

  if (!codeVerifier) {
    return NextResponse.json(
      {
        error: {
          code: 'missing_pkce_verifier',
          message:
            'PKCE code_verifier is missing. Please initiate authorization again.',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const credDoc = await completeOAuthFlow(db, {
      code: rawCode,
      codeVerifier,
      projectId: id,
      displayName: body.displayName,
    });

    if (state) {
      const session = oauthSessionStore.get(state);
      if (session) {
        session.status = 'completed';
        session.credentialId = credDoc._id?.toString();
      }
    }

    return NextResponse.json(
      {
        success: true,
        credential: formatCredentialResponse(credDoc),
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'OAuth exchange failed';
    return NextResponse.json(
      {
        error: {
          code: 'oauth_exchange_failed',
          message,
        },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

