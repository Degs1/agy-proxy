import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import {
  getCredentialById,
  updateCredential,
  revokeCredential,
} from '@/lib/credentials/service';
import {
  updateCredentialSchema,
  formatCredentialResponse,
} from '@/lib/credentials/schema';
import { MissingActiveKeyError } from '@/lib/crypto/credential-encryption';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; credId: string }> | { id: string; credId: string };
}

/**
 * GET /api/admin/projects/:id/credentials/:credId
 * Retrieves a single credential's metadata without revealing secret or ciphertext.
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

  const { id, credId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(credId)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const credential = await getCredentialById(db, id, credId);
  if (!credential) {
    return NextResponse.json(
      { error: { code: 'credential_not_found', message: `Credential ${credId} not found` } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      credential: formatCredentialResponse(credential),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * PATCH /api/admin/projects/:id/credentials/:credId
 * Updates credential metadata or re-encrypts secret.
 * Touches project limiter guard in transaction.
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const db = await getDatabase();
  const auth = await authenticateAdminRequest(request, db, { isMutation: true });
  if (!auth.valid) {
    return auth.response;
  }

  const { id, credId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(credId)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Malformed JSON payload' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const parsed = updateCredentialSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed',
          issues: parsed.error.issues,
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const updated = await updateCredential(db, id, credId, parsed.data);
    if (!updated) {
      return NextResponse.json(
        { error: { code: 'credential_not_found', message: `Credential ${credId} not found` } },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        credential: formatCredentialResponse(updated),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    if (err instanceof MissingActiveKeyError) {
      return NextResponse.json(
        { error: { code: 'encryption_key_unavailable', message: err.message } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Failed to update credential' } },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

/**
 * DELETE /api/admin/projects/:id/credentials/:credId
 * Revokes credential and sets status to disabled.
 * Touches limiter guard in transaction to serialize with gateway admissions.
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

  const { id, credId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(credId)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const revoked = await revokeCredential(db, id, credId);
  if (!revoked) {
    return NextResponse.json(
      { error: { code: 'credential_not_found', message: `Credential ${credId} not found` } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      success: true,
      message: `Credential ${credId} has been revoked`,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
