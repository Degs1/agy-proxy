import { NextResponse } from 'next/server';
import { getDatabase, DatabaseConnectionError } from '@/lib/db/client';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const db = await getDatabase();
    await db.command({ ping: 1 });

    return NextResponse.json(
      {
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    // Log diagnostics internally for operational observability without exposing internal details to clients
    if (process.env.NODE_ENV !== 'test') {
      const code = err instanceof DatabaseConnectionError ? err.code : 'UNKNOWN_ERROR';
      console.error('[Health Check Failure]', {
        code,
        timestamp: new Date().toISOString(),
      });
    }

    // Always return a fixed, safe error string: zero leakage of URIs, credentials, or driver internals
    return NextResponse.json(
      {
        status: 'degraded',
        database: 'unavailable',
        error: 'DATABASE_UNAVAILABLE',
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
