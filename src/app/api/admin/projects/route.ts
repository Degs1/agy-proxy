import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { createProject, listProjects } from '@/lib/projects/service';
import {
  createProjectSchema,
  formatProjectResponse,
} from '@/lib/projects/schema';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/projects
 * Lists all projects for the admin dashboard.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const db = await getDatabase();
  const auth = await authenticateAdminRequest(request, db, { isMutation: false });
  if (!auth.valid) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get('status');
  const status =
    statusParam === 'active' || statusParam === 'disabled'
      ? statusParam
      : undefined;

  const projects = await listProjects(db, { status });

  return NextResponse.json(
    {
      projects: projects.map(formatProjectResponse),
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}

/**
 * POST /api/admin/projects
 * Creates a new project along with its limiter guard document within a transaction.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = await getDatabase();
  const auth = await authenticateAdminRequest(request, db, { isMutation: true });
  if (!auth.valid) {
    return auth.response;
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

  const parsed = createProjectSchema.safeParse(body);
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
    const project = await createProject(db, parsed.data);
    return NextResponse.json(
      {
        project: formatProjectResponse(project),
      },
      {
        status: 201,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create project';
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
