import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import {
  getModelAliasById,
  updateModelAlias,
  deleteModelAlias,
  InvalidCredentialBindingError,
  DuplicateAliasError,
} from '@/lib/projects/service';
import {
  updateModelAliasInputSchema,
  formatModelAliasResponse,
} from '@/lib/projects/schema';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; aliasId: string }> | { id: string; aliasId: string };
}

/**
 * GET /api/admin/projects/:id/aliases/:aliasId
 * Retrieves a single model alias by ID.
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

  const { id, aliasId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(aliasId)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const aliasDoc = await getModelAliasById(db, id, aliasId);
  if (!aliasDoc) {
    return NextResponse.json(
      { error: { code: 'alias_not_found', message: `Model alias ${aliasId} not found` } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      alias: formatModelAliasResponse(aliasDoc),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * PATCH /api/admin/projects/:id/aliases/:aliasId
 * Updates a model alias. If rebinding credential, enforces Requirement 3, AC 1 rules.
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

  const { id, aliasId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(aliasId)) {
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

  const parsed = updateModelAliasInputSchema.safeParse(body);
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
    const updated = await updateModelAlias(db, id, aliasId, parsed.data);
    if (!updated) {
      return NextResponse.json(
        { error: { code: 'alias_not_found', message: `Model alias ${aliasId} not found` } },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        alias: formatModelAliasResponse(updated),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
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
      { error: { code: 'internal_error', message: 'Failed to update model alias' } },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

/**
 * DELETE /api/admin/projects/:id/aliases/:aliasId
 * Deletes a model alias. Serializes with limiter guard in transaction.
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

  const { id, aliasId } = await Promise.resolve(context.params);
  if (!ObjectId.isValid(id) || !ObjectId.isValid(aliasId)) {
    return NextResponse.json(
      { error: { code: 'invalid_id', message: 'Invalid ID format' } },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const deleted = await deleteModelAlias(db, id, aliasId);
  if (!deleted) {
    return NextResponse.json(
      { error: { code: 'alias_not_found', message: `Model alias ${aliasId} not found` } },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    {
      success: true,
      message: `Model alias ${aliasId} deleted`,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
