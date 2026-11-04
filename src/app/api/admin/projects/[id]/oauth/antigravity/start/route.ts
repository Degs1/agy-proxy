import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getProjectById } from '@/lib/projects/service';
import {
  generatePkce,
  generateState,
  buildAuthorizationUrl,
  oauthSessionStore,
} from '@/lib/antigravity/oauth';
import { startLocalOAuthListener } from '@/lib/antigravity/local-server';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * POST /api/admin/projects/:id/oauth/antigravity/start
 * Initializes Google Antigravity OAuth flow:
 * - Generates PKCE code_verifier and code_challenge (S256)
 * - Generates cryptographically secure state
 * - Starts local callback listener on port 51121
 * - Returns authorization URL and state
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

  let body: { displayName?: string } = {};
  try {
    body = (await request.json()) as { displayName?: string };
  } catch {}

  // Generate PKCE & State
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = generateState();

  // Store active session state
  oauthSessionStore.set(state, {
    state,
    codeVerifier,
    projectId: id,
    displayName: body.displayName?.trim(),
    createdAt: Date.now(),
    status: 'pending',
  });

  // Attempt to start local HTTP listener on port 51121
  const listenerRes = await startLocalOAuthListener();

  const authUrl = buildAuthorizationUrl(state, codeChallenge);

  return NextResponse.json(
    {
      authUrl,
      state,
      codeVerifier,
      localListenerRunning: listenerRes.success,
      redirectUri: 'http://localhost:51121/oauth-callback',
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

