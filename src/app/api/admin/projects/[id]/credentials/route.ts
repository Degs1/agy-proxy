import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getProjectById } from '@/lib/projects/service';
import {
  createCredential,
  listCredentials,
  ProjectNotFoundError,
} from '@/lib/credentials/service';
import {
  createCredentialSchema,
  formatCredentialResponse,
} from '@/lib/credentials/schema';
import { MissingActiveKeyError } from '@/lib/crypto/credential-encryption';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * GET /api/admin/projects/:id/credentials
 * Lists all provider credentials for a project without disclosing encrypted payloads or secrets.
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

  const project = await getProjectById(db, id);
  if (!project) {
    return NextResponse.json(
      { error: { code: 'project_not_found', message: `Project ${id} not found` } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || undefined;
  const provider = searchParams.get('provider') || undefined;

  const credentials = await listCredentials(db, id, { status, provider });

  return NextResponse.json(
    {
      credentials: credentials.map(formatCredentialResponse),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * POST /api/admin/projects/:id/credentials
 * Creates and encrypts a new provider credential using authenticated encryption (AES-256-GCM).
 * Touches project limiter guard in transaction to serialize with admissions.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Malformed JSON payload' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const parsed = createCredentialSchema.safeParse(body);
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
    const credential = await createCredential(db, id, parsed.data);
    return NextResponse.json(
      {
        credential: formatCredentialResponse(credential),
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json(
        { error: { code: 'project_not_found', message: err.message } },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (err instanceof MissingActiveKeyError) {
      return NextResponse.json(
        { error: { code: 'encryption_key_unavailable', message: err.message } },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Failed to create credential' } },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
