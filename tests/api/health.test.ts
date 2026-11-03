import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '@/app/api/health/route';
import * as clientModule from '@/lib/db/client';
import * as indexesModule from '@/lib/db/indexes';

describe('Health Check API Route (/api/health)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns 200 healthy when database ping succeeds', async () => {
    const mockDb = {
      command: vi.fn().mockResolvedValue({ ok: 1 }),
    };
    vi.spyOn(clientModule, 'getDatabase').mockResolvedValue(mockDb as any);
    vi.spyOn(indexesModule, 'verifyDatabaseIndexes').mockResolvedValue({ ready: true, missing: [] });

    const response = await GET();
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.status).toBe('healthy');
    expect(json.database).toBe('connected');
    expect(json.timestamp).toBeDefined();
    expect(mockDb.command).toHaveBeenCalledWith({ ping: 1 });
  });

  it('returns 503 degraded and safe fixed error code when database connection fails', async () => {
    vi.spyOn(clientModule, 'getDatabase').mockRejectedValue(
      new clientModule.DatabaseConnectionError(
        'Database connection failed: Unable to connect to MongoDB Atlas.',
        'CONNECTION_FAILED',
        'Host: [mongodb://***:***@cluster0.net/?secretToken=***]; Driver: Connection timeout'
      )
    );

    const response = await GET();
    expect(response.status).toBe(503);

    const json = await response.json();
    expect(json.status).toBe('degraded');
    expect(json.database).toBe('unavailable');
    // Ensure public error contains ONLY fixed safe code, zero leakage
    expect(json.error).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(json)).not.toContain('mongodb');
    expect(JSON.stringify(json)).not.toContain('Driver');
    expect(JSON.stringify(json)).not.toContain('secretToken');
  });
});
