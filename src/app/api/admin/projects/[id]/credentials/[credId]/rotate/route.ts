import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import {
  rotateCredentialKeyVersion,
  verifyCredentialDecryption,
  CredentialNotFoundError,
} from '@/lib/credentials/service';
import { formatCredentialResponse } from '@/lib/credentials/schema';
import {
  MissingActiveKeyError,
  MissingKeyVersionError,
  DecryptionFailedError,
} from '@/lib/crypto/credential-encryption';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; credId: string }> | { id: string; credId: string };
}

const rotateInputSchema = z.object({
  targetVersion: z.number().int().positive().optional(),
});

/**
 * POST /api/admin/projects/:id/credentials/:credId/rotate
 * Re-encrypts an existing credential using the active (or specified) key version.
 * Verifies round-trip decryption before persisting changes in Atlas.
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

  const { id, credId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(credId)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let targetVersion: number | undefined;
  try {
    const text = await request.text();
    if (text && text.trim().length > 0) {
      const parsedBody = JSON.parse(text);
      const val = rotateInputSchema.safeParse(parsedBody);
      if (val.success) {
        targetVersion = val.data.targetVersion;
      }
    }
  } catch {
    // Empty or omitted body is allowed (defaults to activeVersion)
  }

  try {
    const rotated = await rotateCredentialKeyVersion(db, id, credId, targetVersion);
    return NextResponse.json(
      {
        credential: formatCredentialResponse(rotated),
        message: `Credential key version rotated successfully to version ${rotated.encryptedCredentials.keyVersion}`,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    if (err instanceof CredentialNotFoundError) {
      return NextResponse.json(
        { error: { code: 'credential_not_found', message: err.message } },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (err instanceof MissingKeyVersionError || err instanceof MissingActiveKeyError) {
      return NextResponse.json(
        { error: { code: 'key_version_unavailable', message: err.message } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (err instanceof DecryptionFailedError) {
      return NextResponse.json(
        { error: { code: 'decryption_failed', message: err.message } },
        { status: 422, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Failed to rotate credential key' } },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
