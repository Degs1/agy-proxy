import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { revokeApiKey, getApiKeyById } from '@/lib/api-keys/service';
import { formatApiKeyResponse } from '@/lib/api-keys/schema';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * GET /api/admin/keys/:id
 * Retrieves metadata for a specific API key (no secrets or hashes).
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
      {
        error: {
          code: 'invalid_id',
          message: 'Invalid key ID format',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const key = await getApiKeyById(db, id);
  if (!key) {
    return NextResponse.json(
      {
        error: {
          code: 'key_not_found',
          message: 'API key not found',
        },
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      apiKey: formatApiKeyResponse(key),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * DELETE /api/admin/keys/:id
 * Revokes an API key.
 * Requirement 3, AC 6: Writes to the project limiter guard in an atomic transaction
 * so any concurrent or subsequent admission transactions immediately reject the revoked key.
 */
export async function DELETE(
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
      {
        error: {
          code: 'invalid_id',
          message: 'Invalid key ID format',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const revoked = await revokeApiKey(db, id);
    if (!revoked) {
      return NextResponse.json(
        {
          error: {
            code: 'key_not_found',
            message: 'API key not found',
          },
        },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        success: true,
        revokedId: id,
        apiKey: formatApiKeyResponse(revoked),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    console.error('Failed to revoke API key:', err);
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message: 'Failed to revoke API key',
        },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
