import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import {
  getProjectById,
  updateProject,
  deleteProject,
} from '@/lib/projects/service';
import {
  updateProjectSchema,
  formatProjectResponse,
} from '@/lib/projects/schema';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

/**
 * GET /api/admin/projects/:id
 * Retrieves a single project by ID.
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

  return NextResponse.json(
    {
      project: formatProjectResponse(project),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * PATCH /api/admin/projects/:id
 * Updates project configuration and writes to the limiter guard within a transaction.
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

  const parsed = updateProjectSchema.safeParse(body);
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
    const updated = await updateProject(db, id, parsed.data);
    if (!updated) {
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

    return NextResponse.json(
      {
        project: formatProjectResponse(updated),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update project';
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

/**
 * DELETE /api/admin/projects/:id
 * Deletes a project and its limiter guard within a transaction, revoking associated API keys.
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
          message: 'Invalid project ID format',
        },
      },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const success = await deleteProject(db, id);
    if (!success) {
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

    return NextResponse.json(
      {
        success: true,
        deletedId: id,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete project';
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
