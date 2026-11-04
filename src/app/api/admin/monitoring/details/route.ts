import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getMonitoringDetails } from '@/lib/monitoring/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/monitoring/details
 * Returns paginated, detailed usage logs or preauth rejection logs with filters.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const db = await getDatabase();
  const auth = await authenticateAdminRequest(request, db, { isMutation: false });
  if (!auth.valid) {
    return auth.response;
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId') || undefined;
  const provider = searchParams.get('provider') || undefined;
  const status = searchParams.get('status') || undefined;
  const type = searchParams.get('type') === 'preauth' ? 'preauth' : 'all';

  const rawStart = searchParams.get('startDate');
  const rawEnd = searchParams.get('endDate');
  const startDate = rawStart ? new Date(rawStart) : undefined;
  const endDate = rawEnd ? new Date(rawEnd) : undefined;

  const rawLimit = searchParams.get('limit');
  const rawOffset = searchParams.get('offset');
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
  const offset = rawOffset ? parseInt(rawOffset, 10) : undefined;

  const details = await getMonitoringDetails(db, {
    projectId,
    provider,
    status,
    type,
    startDate: startDate && !isNaN(startDate.getTime()) ? startDate : undefined,
    endDate: endDate && !isNaN(endDate.getTime()) ? endDate : undefined,
    limit: limit && !isNaN(limit) ? limit : undefined,
    offset: offset && !isNaN(offset) ? offset : undefined,
  });

  return NextResponse.json(details, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
