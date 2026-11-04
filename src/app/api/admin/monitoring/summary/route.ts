import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/client';
import { authenticateAdminRequest } from '@/lib/auth/admin-guard';
import { getMonitoringSummary } from '@/lib/monitoring/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/monitoring/summary
 * Returns aggregated usage statistics, project breakdown, provider breakdown,
 * and separate pre-authentication rejection counts.
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

  const rawStart = searchParams.get('startDate');
  const rawEnd = searchParams.get('endDate');
  const startDate = rawStart ? new Date(rawStart) : undefined;
  const endDate = rawEnd ? new Date(rawEnd) : undefined;

  const summary = await getMonitoringSummary(db, {
    projectId,
    provider,
    startDate: startDate && !isNaN(startDate.getTime()) ? startDate : undefined,
    endDate: endDate && !isNaN(endDate.getTime()) ? endDate : undefined,
  });

  return NextResponse.json(
    { summary },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
