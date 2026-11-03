import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getProjectById } from '@/lib/projects/service';
import { createApiKey, listApiKeys } from '@/lib/api-keys/service';
import { createApiKeySchema, formatApiKeyResponse } from '@/lib/api-keys/schema';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * GET /api/admin/projects/:id/keys
 * Lists all API keys for the specified project. Plaintext secrets are never returned.
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
          message: 'Invalid project ID format',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const project = await getProjectById(db, id);
  if (!project) {
    return NextResponse.json(
      {
        error: {
          code: 'project_not_found',
          message: 'Project not found',
        },
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const keys = await listApiKeys(db, id);
  return NextResponse.json(
    {
      keys: keys.map(formatApiKeyResponse),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * POST /api/admin/projects/:id/keys
 * Issues a new API key for the specified project with at least 256 bits of entropy.
 * The plaintext secret is returned ONLY ONCE in this creation response.
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
      {
        error: {
          code: 'invalid_id',
          message: 'Invalid project ID format',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const project = await getProjectById(db, id);
  if (!project) {
    return NextResponse.json(
      {
        error: {
          code: 'project_not_found',
          message: 'Project not found',
        },
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_request',
          message: 'Malformed JSON payload',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const parsed = createApiKeySchema.safeParse(body);
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
    const result = await createApiKey(db, id, parsed.data);
    return NextResponse.json(
      {
        apiKey: formatApiKeyResponse(result.apiKey),
        secret: result.secret, // Displayed ONLY ONCE
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create API key';
    return NextResponse.json(
      {
        error: {
          code: 'internal_error',
          message,
        },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
