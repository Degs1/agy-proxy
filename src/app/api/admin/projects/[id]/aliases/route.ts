import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getProjectById } from '@/lib/projects/service';
import {
  createModelAlias,
  listModelAliases,
  InvalidCredentialBindingError,
  DuplicateAliasError,
} from '@/lib/projects/service';
import {
  createModelAliasInputSchema,
  formatModelAliasResponse,
} from '@/lib/projects/schema';
import { ProjectNotFoundError } from '@/lib/credentials/service';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * GET /api/admin/projects/:id/aliases
 * Lists all model aliases configured for a project.
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

  const aliases = await listModelAliases(db, id);

  return NextResponse.json(
    {
      aliases: aliases.map(formatModelAliasResponse),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * POST /api/admin/projects/:id/aliases
 * Creates a model alias bound to an active Gemini provider credential belonging to the project.
 * Rejects cross-project, inactive, revoked, or non-Gemini credentials (Requirement 3, AC 1).
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

  const parsed = createModelAliasInputSchema.safeParse(body);
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
    const aliasDoc = await createModelAlias(db, id, parsed.data);
    return NextResponse.json(
      {
        alias: formatModelAliasResponse(aliasDoc),
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
    if (err instanceof InvalidCredentialBindingError) {
      return NextResponse.json(
        {
          error: {
            code: err.reason,
            message: err.message,
          },
        },
        { status: 422, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (err instanceof DuplicateAliasError) {
      return NextResponse.json(
        { error: { code: 'duplicate_alias', message: err.message } },
        { status: 409, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Failed to create model alias' } },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
