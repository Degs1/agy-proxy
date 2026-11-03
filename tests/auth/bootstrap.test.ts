import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import { COLLECTIONS } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { POST } from '@/app/api/admin/bootstrap/route';
import { NextRequest } from 'next/server';
import {
  createAnonymousCsrf,
  ADMIN_PRE_CSRF_COOKIE,
  CSRF_HEADER_NAME,
} from '@/lib/auth/csrf';
import { verifyPassword } from '@/lib/auth/password';

describe('Admin Bootstrap API (Requirement 2, AC 1 & Subtask 4.1)', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;
  const APP_ORIGIN = 'http://localhost:3000';

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_bootstrap';
    process.env.APP_ORIGIN = APP_ORIGIN;
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
    process.env = originalEnv;
  });

  beforeEach(async () => {
    const db = await getDatabase();
    await initDatabaseIndexes(db);
    await db.collection(COLLECTIONS.BOOTSTRAP_GUARD).deleteMany({});
    await db.collection(COLLECTIONS.ADMINS).deleteMany({});
  });

  function createBootstrapRequest(options: {
    origin?: string | null;
    csrfToken?: string | null;
    preCookie?: string | null;
    body?: any;
  }): NextRequest {
    const headers = new Headers();
    if (options.origin !== null && options.origin !== undefined) {
      headers.set('origin', options.origin);
    }
    if (options.csrfToken !== null && options.csrfToken !== undefined) {
      headers.set(CSRF_HEADER_NAME, options.csrfToken);
    }
    if (options.preCookie !== null && options.preCookie !== undefined) {
      headers.set('cookie', `${ADMIN_PRE_CSRF_COOKIE}=${options.preCookie}`);
    }
    headers.set('content-type', 'application/json');

    const bodyContent =
      options.body !== undefined
        ? JSON.stringify(options.body)
        : JSON.stringify({ email: 'admin@gateway.local', password: 'SuperSecretPassword123!' });

    return new NextRequest('http://localhost:3000/api/admin/bootstrap', {
      method: 'POST',
      headers,
      body: bodyContent,
    });
  }

  it('successfully bootstraps initial admin with valid Origin, pre-session cookie, and CSRF token', async () => {
    const anonPair = createAnonymousCsrf();
    const req = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: anonPair.token,
      preCookie: anonPair.cookieValue,
      body: { email: 'Admin@Gateway.Local', password: 'StrongPassword123!' },
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.success).toBe(true);

    // Verify database state: guard document and admin document exist
    const db = await getDatabase();
    const guard = await db.collection(COLLECTIONS.BOOTSTRAP_GUARD).findOne({ _id: 'bootstrap_singleton' as any });
    expect(guard).toBeDefined();
    expect(guard?.initialAdminEmail).toBe('admin@gateway.local');

    const admin = await db.collection(COLLECTIONS.ADMINS).findOne({ email: 'admin@gateway.local' });
    expect(admin).toBeDefined();
    expect(admin?.role).toBe('admin');
    expect(admin?.status).toBe('active');

    // Verify Argon2id password hash
    const isPasswordValid = await verifyPassword(admin?.passwordHash, 'StrongPassword123!');
    expect(isPasswordValid).toBe(true);
  });

  it('rejects bootstrap when Origin header is missing without changing database state', async () => {
    const anonPair = createAnonymousCsrf();
    const req = createBootstrapRequest({
      origin: null, // missing origin
      csrfToken: anonPair.token,
      preCookie: anonPair.cookieValue,
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('origin_rejected');

    // Verify zero state change in DB
    const db = await getDatabase();
    const adminCount = await db.collection(COLLECTIONS.ADMINS).countDocuments();
    expect(adminCount).toBe(0);
  });

  it('rejects bootstrap when Origin does not match application origin', async () => {
    const anonPair = createAnonymousCsrf();
    const req = createBootstrapRequest({
      origin: 'https://malicious-site.com',
      csrfToken: anonPair.token,
      preCookie: anonPair.cookieValue,
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('origin_rejected');
  });

  it('rejects bootstrap when X-CSRF-Token is missing', async () => {
    const anonPair = createAnonymousCsrf();
    const req = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: null,
      preCookie: anonPair.cookieValue,
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('csrf_rejected');
  });

  it('rejects bootstrap when X-CSRF-Token is invalid', async () => {
    const anonPair = createAnonymousCsrf();
    const req = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: 'invalid_token_does_not_match',
      preCookie: anonPair.cookieValue,
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('csrf_rejected');
  });

  it('rejects bootstrap when pre-session cookie is missing', async () => {
    const anonPair = createAnonymousCsrf();
    const req = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: anonPair.token,
      preCookie: null, // Missing pre-session cookie
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('csrf_rejected');
  });

  it('rejects duplicate bootstrap with HTTP 409 already_bootstrapped', async () => {
    const anonPair1 = createAnonymousCsrf();
    const req1 = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: anonPair1.token,
      preCookie: anonPair1.cookieValue,
      body: { email: 'first@admin.com', password: 'PasswordFirst123!' },
    });

    const res1 = await POST(req1);
    expect(res1.status).toBe(201);

    // Second bootstrap attempt must fail
    const anonPair2 = createAnonymousCsrf();
    const req2 = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: anonPair2.token,
      preCookie: anonPair2.cookieValue,
      body: { email: 'second@admin.com', password: 'PasswordSecond123!' },
    });

    const res2 = await POST(req2);
    expect(res2.status).toBe(409);
    const json2 = await res2.json();
    expect(json2.error.code).toBe('already_bootstrapped');

    // Verify only the first admin exists in DB
    const db = await getDatabase();
    const adminCount = await db.collection(COLLECTIONS.ADMINS).countDocuments();
    expect(adminCount).toBe(1);
    const firstAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ email: 'first@admin.com' });
    expect(firstAdmin).toBeDefined();
  });

  it('allows only ONE bootstrap to succeed when two requests execute concurrently', async () => {
    const anonPair1 = createAnonymousCsrf();
    const anonPair2 = createAnonymousCsrf();

    const req1 = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: anonPair1.token,
      preCookie: anonPair1.cookieValue,
      body: { email: 'concurrent1@admin.com', password: 'ConcurrentPass123!' },
    });

    const req2 = createBootstrapRequest({
      origin: APP_ORIGIN,
      csrfToken: anonPair2.token,
      preCookie: anonPair2.cookieValue,
      body: { email: 'concurrent2@admin.com', password: 'ConcurrentPass123!' },
    });

    // Execute both in parallel
    const [res1, res2] = await Promise.all([POST(req1), POST(req2)]);

    const statuses = [res1.status, res2.status].sort();
    // Exactly one must be 201 Created and the other must be 409 Conflict
    expect(statuses).toEqual([201, 409]);

    const db = await getDatabase();
    const adminCount = await db.collection(COLLECTIONS.ADMINS).countDocuments();
    expect(adminCount).toBe(1);
    const guardCount = await db.collection(COLLECTIONS.BOOTSTRAP_GUARD).countDocuments();
    expect(guardCount).toBe(1);
  });
});
