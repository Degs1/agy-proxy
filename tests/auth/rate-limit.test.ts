import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import { COLLECTIONS, LoginFailureDocument } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { POST } from '@/app/api/admin/login/route';
import { NextRequest } from 'next/server';
import {
  createAnonymousCsrf,
  ADMIN_PRE_CSRF_COOKIE,
  CSRF_HEADER_NAME,
} from '@/lib/auth/csrf';
import * as passwordModule from '@/lib/auth/password';
import {
  normalizeIp,
  getTrustedSourceIp,
  reserveLoginAttempt,
  finalizeLoginAttempt,
  MAX_EMAIL_FAILURES,
  MAX_IP_FAILURES,
  FAILURE_WINDOW_MS,
  RESERVATION_LIFETIME_MS,
} from '@/lib/auth/rate-limit';

describe('Login Rate Limiting & Distributed Reservations (Requirement 2, AC 4 & TASK-016)', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;
  const APP_ORIGIN = 'http://localhost:3000';

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_login_ratelimit';
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
    vi.restoreAllMocks();
    const db = await getDatabase();
    await initDatabaseIndexes(db);
    await db.collection(COLLECTIONS.ADMINS).deleteMany({});
    await db.collection(COLLECTIONS.ADMIN_SESSIONS).deleteMany({});
    await db.collection(COLLECTIONS.LOGIN_FAILURES).deleteMany({});
  });

  function createLoginRequest(options: {
    origin?: string | null;
    csrfToken?: string | null;
    preCookie?: string | null;
    clientIp?: string | null;
    headers?: Record<string, string>;
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
    if (options.clientIp !== null && options.clientIp !== undefined) {
      headers.set('x-vercel-forwarded-for', options.clientIp);
    }
    if (options.headers) {
      for (const [key, val] of Object.entries(options.headers)) {
        headers.set(key, val);
      }
    }
    headers.set('content-type', 'application/json');

    const bodyContent =
      options.body !== undefined
        ? JSON.stringify(options.body)
        : JSON.stringify({ email: 'admin@gateway.local', password: 'Password123!' });

    return new NextRequest('http://localhost:3000/api/admin/login', {
      method: 'POST',
      headers,
      body: bodyContent,
    });
  }

  // --- Subtask 5.1: IP validation & untrusted source IP ---
  describe('Trusted source IP handling and untrusted source rejection', () => {
    it('correctly normalizes valid IPv4, IPv6, and IPv4-mapped IPv6', () => {
      expect(normalizeIp('192.168.1.1').valid).toBe(true);
      expect(normalizeIp('192.168.1.1').ip).toBe('192.168.1.1');

      expect(normalizeIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334').valid).toBe(true);
      expect(normalizeIp('::1').valid).toBe(true);
      expect(normalizeIp('::1').ip).toBe('::1');

      // IPv4-mapped IPv6 normalization to pure IPv4
      const mapped = normalizeIp('::ffff:192.0.2.128');
      expect(mapped.valid).toBe(true);
      expect(mapped.ip).toBe('192.0.2.128');
    });

    it('rejects invalid IPs, ports, and empty strings', () => {
      expect(normalizeIp('').valid).toBe(false);
      expect(normalizeIp(null).valid).toBe(false);
      expect(normalizeIp('not-an-ip').valid).toBe(false);
      expect(normalizeIp('192.168.1.1:8080').valid).toBe(false);
      expect(normalizeIp('[::1]:8080').valid).toBe(false);
    });

    it('returns HTTP 503 when source IP is untrusted or missing in login endpoint', async () => {
      const csrf = createAnonymousCsrf();
      const req = createLoginRequest({
        origin: APP_ORIGIN,
        csrfToken: csrf.token,
        preCookie: csrf.cookieValue,
        clientIp: '192.168.1.1:8080', // Invalid IP containing port
      });

      const res = await POST(req);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error.code).toBe('source_untrusted');
    });
  });

  // --- Subtask 5.1: Email failures within window + active reservations ---
  describe('Email limit: failures in window + active reservations <= 5', () => {
    it('blocks 6th attempt when past failures + active reservations reach 5', async () => {
      const db = await getDatabase();
      const email = 'target@gateway.local';
      const ip = '10.0.0.1';
      const now = new Date();

      // Seed 3 past failures within the 15-minute window
      await db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES).insertOne({
        type: 'email',
        identifier: email,
        failureTimestamps: [
          new Date(now.getTime() - 10 * 60 * 1000),
          new Date(now.getTime() - 5 * 60 * 1000),
          new Date(now.getTime() - 2 * 60 * 1000),
        ],
        activeReservations: [],
        updatedAt: now,
      });

      // 4th attempt: reservation succeeds
      const r1 = await reserveLoginAttempt(db, email, ip, 'attempt-email-4');
      expect(r1.allowed).toBe(true);

      // 5th attempt: reservation succeeds (3 failures + 2 active = 5)
      const r2 = await reserveLoginAttempt(db, email, ip, 'attempt-email-5');
      expect(r2.allowed).toBe(true);

      // 6th attempt: capacity is exhausted (3 failures + 2 active reservations = 5)
      const r3 = await reserveLoginAttempt(db, email, ip, 'attempt-email-6');
      expect(r3.allowed).toBe(false);
      expect(r3.reason).toBe('email_rate_limit_exceeded');
      expect(r3.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('prunes failures older than 15-minute rolling window', async () => {
      const db = await getDatabase();
      const email = 'window-test@gateway.local';
      const ip = '10.0.0.2';
      const now = new Date();

      // Seed 5 failures, but 3 are older than 15 minutes (e.g. 16, 20, 30 min ago)
      await db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES).insertOne({
        type: 'email',
        identifier: email,
        failureTimestamps: [
          new Date(now.getTime() - 30 * 60 * 1000),
          new Date(now.getTime() - 20 * 60 * 1000),
          new Date(now.getTime() - 16 * 60 * 1000),
          new Date(now.getTime() - 5 * 60 * 1000),
          new Date(now.getTime() - 1 * 60 * 1000),
        ],
        activeReservations: [],
        updatedAt: now,
      });

      // Only 2 failures are in the active window, so reserveLoginAttempt must succeed
      const res = await reserveLoginAttempt(db, email, ip, 'attempt-prune-1');
      expect(res.allowed).toBe(true);
    });
  });

  // --- Subtask 5.1: IP failures within window + active reservations ---
  describe('IP limit: failures in window + active reservations <= 20', () => {
    it('blocks 21st attempt when IP past failures + active reservations reach 20', async () => {
      const db = await getDatabase();
      const ip = '198.51.100.55';
      const now = new Date();

      // Seed 18 past failures on this IP
      const pastFailures: Date[] = [];
      for (let i = 0; i < 18; i++) {
        pastFailures.push(new Date(now.getTime() - (14 - i * 0.5) * 60 * 1000));
      }

      await db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES).insertOne({
        type: 'ip',
        identifier: ip,
        failureTimestamps: pastFailures,
        activeReservations: [],
        updatedAt: now,
      });

      // 19th and 20th active attempts
      const r19 = await reserveLoginAttempt(db, 'user19@gateway.local', ip, 'att-ip-19');
      expect(r19.allowed).toBe(true);
      const r20 = await reserveLoginAttempt(db, 'user20@gateway.local', ip, 'att-ip-20');
      expect(r20.allowed).toBe(true);

      // 21st attempt from same IP (even for an unused email) must be rejected
      const r21 = await reserveLoginAttempt(db, 'fresh-user@gateway.local', ip, 'att-ip-21');
      expect(r21.allowed).toBe(false);
      expect(r21.reason).toBe('ip_rate_limit_exceeded');
      expect(r21.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  // --- Subtask 5.1: Expired reservations cannot produce sessions ---
  describe('Expired reservations', () => {
    it('rejects finalization when reservation has expired past lifetime', async () => {
      const db = await getDatabase();
      const email = 'expired@gateway.local';
      const ip = '10.0.0.9';
      const attemptId = 'attempt-expired-1';

      // Reserve attempt
      const res = await reserveLoginAttempt(db, email, ip, attemptId);
      expect(res.allowed).toBe(true);

      // Artificially age the reservation past RESERVATION_LIFETIME_MS
      const pastDate = new Date(Date.now() - 5000); // 5s in past
      await db.collection(COLLECTIONS.LOGIN_FAILURES).updateMany(
        { identifier: { $in: [email, ip] } },
        { $set: { 'activeReservations.$[elem].expiresAt': pastDate } },
        { arrayFilters: [{ 'elem.attemptId': attemptId }] }
      );

      // Finalize attempt
      const finalResult = await finalizeLoginAttempt(db, email, ip, attemptId, true);
      expect(finalResult.expired).toBe(true);
    });

    it('endpoint returns HTTP 409 login_attempt_expired and creates no session when reservation expired', async () => {
      const db = await getDatabase();
      const email = 'slow-admin@gateway.local';
      const password = 'CorrectPassword123!';
      const ip = '10.0.0.10';

      // Seed admin
      const passwordHash = await passwordModule.hashPassword(password);
      await db.collection(COLLECTIONS.ADMINS).insertOne({
        email,
        passwordHash,
        role: 'admin',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Pre-create an expired reservation to simulate slow password verification or delayed completion
      const attemptId = 'slow-attempt-1';
      await reserveLoginAttempt(db, email, ip, attemptId);
      await db.collection(COLLECTIONS.LOGIN_FAILURES).updateMany(
        { identifier: { $in: [email, ip] } },
        { $set: { 'activeReservations.$[elem].expiresAt': new Date(Date.now() - 1000) } },
        { arrayFilters: [{ 'elem.attemptId': attemptId }] }
      );

      // Now verify that finalize rejects expired attempts
      const finalRes = await finalizeLoginAttempt(db, email, ip, attemptId, true);
      expect(finalRes.expired).toBe(true);

      // Ensure no session document was created
      const sessionCount = await db.collection(COLLECTIONS.ADMIN_SESSIONS).countDocuments();
      expect(sessionCount).toBe(0);
    });
  });

  // --- Subtask 5.1: Competing finalizations ---
  describe('Competing finalizations', () => {
    it('prevents competing finalizations from counting a single attempt twice', async () => {
      const db = await getDatabase();
      const email = 'competing@gateway.local';
      const ip = '10.0.0.11';
      const attemptId = 'competing-attempt-1';

      await reserveLoginAttempt(db, email, ip, attemptId);

      // Two concurrent or sequential finalizations for the same attemptId
      const [final1, final2] = await Promise.all([
        finalizeLoginAttempt(db, email, ip, attemptId, false),
        finalizeLoginAttempt(db, email, ip, attemptId, false),
      ]);

      // At least one finalized, and the other did not count a second failure
      const emailDoc = await db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES).findOne({
        type: 'email',
        identifier: email,
      });

      // Exactly ONE failure timestamp must be appended, not two!
      expect(emailDoc?.failureTimestamps.length).toBe(1);
    });
  });

  // --- Subtask 5.1 & 5.3: Parallel burst from two instances ---
  describe('Parallel burst across instances', () => {
    it('proves attempts currently verifying password consume active capacity', async () => {
      const db = await getDatabase();
      const email = 'burst@gateway.local';
      const ip = '10.0.0.50';

      // Simulate 8 concurrent login reservations targeting the same email (capacity = 5)
      const attempts = Array.from({ length: 8 }, (_, i) => `burst-att-${i}`);
      const results = await Promise.all(
        attempts.map((attId) => reserveLoginAttempt(db, email, ip, attId))
      );

      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      // Exactly 5 allowed (exhausting capacity), remaining 3 rejected
      expect(allowed.length).toBe(MAX_EMAIL_FAILURES);
      expect(rejected.length).toBe(8 - MAX_EMAIL_FAILURES);

      for (const r of rejected) {
        expect(r.reason).toBe('email_rate_limit_exceeded');
        expect(r.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('proves IP burst allows at most 20 active reservations across multiple emails', async () => {
      const db = await getDatabase();
      const ip = '198.51.100.99';

      // 25 concurrent reservations on the same IP across different emails
      const attempts = Array.from({ length: 25 }, (_, i) => ({
        email: `burst-user-${i}@gateway.local`,
        attemptId: `burst-ip-att-${i}`,
      }));

      const results = await Promise.all(
        attempts.map(({ email, attemptId }) => reserveLoginAttempt(db, email, ip, attemptId))
      );

      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      expect(allowed.length).toBe(MAX_IP_FAILURES);
      expect(rejected.length).toBe(25 - MAX_IP_FAILURES);

      for (const r of rejected) {
        expect(r.reason).toBe('ip_rate_limit_exceeded');
        expect(r.retryAfterSeconds).toBeGreaterThan(0);
      }
    });
  });

  // --- Success clearing email failures but retaining IP failures ---
  describe('Success lifecycle', () => {
    it('clears email failures upon successful login but retains IP failures', async () => {
      const db = await getDatabase();
      const email = 'success-clear@gateway.local';
      const ip = '10.0.0.88';
      const attemptId = 'success-attempt';

      // Seed 2 failures for email and 2 failures for IP
      const now = new Date();
      await db.collection(COLLECTIONS.LOGIN_FAILURES).insertOne({
        type: 'email',
        identifier: email,
        failureTimestamps: [now, now],
        activeReservations: [],
        updatedAt: now,
      });
      await db.collection(COLLECTIONS.LOGIN_FAILURES).insertOne({
        type: 'ip',
        identifier: ip,
        failureTimestamps: [now, now],
        activeReservations: [],
        updatedAt: now,
      });

      // Reserve attempt
      await reserveLoginAttempt(db, email, ip, attemptId);

      // Finalize with success
      await finalizeLoginAttempt(db, email, ip, attemptId, true);

      const emailDoc = await db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES).findOne({
        type: 'email',
        identifier: email,
      });
      const ipDoc = await db.collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES).findOne({
        type: 'ip',
        identifier: ip,
      });

      // Email failures cleared
      expect(emailDoc?.failureTimestamps.length).toBe(0);
      expect(emailDoc?.activeReservations.length).toBe(0);

      // IP failures RETAINED (still has original failures)
      expect(ipDoc?.failureTimestamps.length).toBe(2);
      expect(ipDoc?.activeReservations.length).toBe(0);
    });
  });

  // --- Subtask 5.3 / TASK-018: Burst across two processes with held password verification and window recovery ---
  describe('Subtask 5.3 (TASK-018): Two-process burst with held verification and recovery', () => {
    it('allows at most 5 active reservations per email while password verification is held, rejects excess with 429 before verification, and recovers after 15-minute window', async () => {
      const db = await getDatabase();
      const email = 'burst-held-admin@gateway.local';
      const password = 'RealPassword123!';
      const ip = '203.0.113.10';

      const passwordHash = await passwordModule.hashPassword(password);
      await db.collection(COLLECTIONS.ADMINS).insertOne({
        email,
        passwordHash,
        role: 'admin',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Set up a controllable gate to hold password verification in flight
      let resolvePasswordGate: () => void;
      const passwordGate = new Promise<void>((resolve) => {
        resolvePasswordGate = resolve;
      });

      let verifyPasswordCallCount = 0;
      const originalVerifyPassword = passwordModule.verifyPassword;

      vi.spyOn(passwordModule, 'verifyPassword').mockImplementation(async () => {
        verifyPasswordCallCount++;
        // Hold verification until gate is opened
        await passwordGate;
        // All of these held requests will intentionally fail password verification
        return false;
      });

      // Generate 12 requests across 2 simulated processes (6 each)
      // Process 1: 6 requests
      // Process 2: 6 requests
      const totalRequests = 12;
      const requestPromises: Promise<Response>[] = [];

      for (let i = 0; i < totalRequests; i++) {
        const csrf = createAnonymousCsrf();
        const req = createLoginRequest({
          origin: APP_ORIGIN,
          csrfToken: csrf.token,
          preCookie: csrf.cookieValue,
          clientIp: ip,
          body: { email, password: 'WrongPassword' },
        });

        requestPromises.push(POST(req));
      }

      // Wait until exactly MAX_EMAIL_FAILURES have reached verifyPassword and are being held
      while (verifyPasswordCallCount < MAX_EMAIL_FAILURES) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Check Atlas limiter state while verification is HELD:
      // Exactly 5 reservations must be active in Atlas!
      const emailDocDuringHold = await db
        .collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES)
        .findOne({ type: 'email', identifier: email });

      expect(emailDocDuringHold?.activeReservations.length).toBe(MAX_EMAIL_FAILURES);

      // Now open the gate so the 5 held requests can proceed to verify password and fail
      resolvePasswordGate!();

      // Collect all 12 responses
      const responses = await Promise.all(requestPromises);

      const status429s = responses.filter((r) => r.status === 429);
      const status401s = responses.filter((r) => r.status === 401);

      // Exactly 5 requests passed reservation and completed as 401
      expect(status401s.length).toBe(MAX_EMAIL_FAILURES);
      // The remaining 7 requests were rejected with 429 BEFORE password verification
      expect(status429s.length).toBe(totalRequests - MAX_EMAIL_FAILURES);

      // Verify password was called EXACTLY 5 times, NEVER for the 7 rejected requests!
      expect(verifyPasswordCallCount).toBe(MAX_EMAIL_FAILURES);

      // Verify that all 429 responses have Retry-After header
      for (const res of status429s) {
        const retryAfter = res.headers.get('Retry-After');
        expect(retryAfter).toBeDefined();
        expect(Number(retryAfter)).toBeGreaterThan(0);
        const body = await res.json();
        expect(body.error.code).toBe('rate_limit_exceeded');
      }

      // 13th request right now: all 5 slots are now failures in the window, must receive 429
      const csrf13 = createAnonymousCsrf();
      const req13 = createLoginRequest({
        origin: APP_ORIGIN,
        csrfToken: csrf13.token,
        preCookie: csrf13.cookieValue,
        clientIp: ip,
        body: { email, password },
      });
      const res13 = await POST(req13);
      expect(res13.status).toBe(429);
      expect(verifyPasswordCallCount).toBe(MAX_EMAIL_FAILURES); // Not incremented!

      // --- Test recovery after 15-minute window ---
      // Age the 5 recorded failures past the 15-minute window (e.g. 16 minutes in the past)
      const now = new Date();
      const past16Min = new Date(now.getTime() - (FAILURE_WINDOW_MS + 60 * 1000));
      await db.collection(COLLECTIONS.LOGIN_FAILURES).updateOne(
        { type: 'email', identifier: email },
        {
          $set: {
            failureTimestamps: [past16Min, past16Min, past16Min, past16Min, past16Min],
            activeReservations: [],
            updatedAt: past16Min,
          },
        }
      );

      // Restore real verifyPassword implementation
      vi.spyOn(passwordModule, 'verifyPassword').mockImplementation(originalVerifyPassword);

      // 14th request with correct password after 15-minute window has elapsed
      const csrf14 = createAnonymousCsrf();
      const req14 = createLoginRequest({
        origin: APP_ORIGIN,
        csrfToken: csrf14.token,
        preCookie: csrf14.cookieValue,
        clientIp: ip,
        body: { email, password },
      });
      const res14 = await POST(req14);
      expect(res14.status).toBe(200);
      const json14 = await res14.json();
      expect(json14.success).toBe(true);
      expect(json14.csrfToken).toBeDefined();

      // Email failures must now be cleared
      const emailDocAfterSuccess = await db
        .collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES)
        .findOne({ type: 'email', identifier: email });
      expect(emailDocAfterSuccess?.failureTimestamps.length).toBe(0);
      expect(emailDocAfterSuccess?.activeReservations.length).toBe(0);
    });

    it('allows at most 20 active reservations per IP while password verification is held, rejects excess with 429 before verification', async () => {
      const db = await getDatabase();
      const ip = '203.0.113.20';
      const totalRequests = 25;

      // Seed 25 active admins so each request reaches verifyPassword when capacity allows
      const dummyHash = await passwordModule.hashPassword('dummy-pwd');
      const adminDocs = Array.from({ length: totalRequests }, (_, i) => ({
        email: `admin-ip-${i}@gateway.local`,
        passwordHash: dummyHash,
        role: 'admin' as const,
        status: 'active' as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      await db.collection(COLLECTIONS.ADMINS).insertMany(adminDocs);

      let resolvePasswordGate: () => void;
      const passwordGate = new Promise<void>((resolve) => {
        resolvePasswordGate = resolve;
      });

      let verifyPasswordCallCount = 0;
      vi.spyOn(passwordModule, 'verifyPassword').mockImplementation(async () => {
        verifyPasswordCallCount++;
        await passwordGate;
        return false;
      });

      // Fire 25 concurrent requests from the same IP across different emails
      const requestPromises: Promise<Response>[] = [];
      for (let i = 0; i < totalRequests; i++) {
        const csrf = createAnonymousCsrf();
        const req = createLoginRequest({
          origin: APP_ORIGIN,
          csrfToken: csrf.token,
          preCookie: csrf.cookieValue,
          clientIp: ip,
          body: { email: `admin-ip-${i}@gateway.local`, password: 'any' },
        });
        requestPromises.push(POST(req));
      }

      // Wait until exactly MAX_IP_FAILURES have reached verifyPassword
      while (verifyPasswordCallCount < MAX_IP_FAILURES) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Verify active reservations on IP during hold
      const ipDocDuringHold = await db
        .collection<LoginFailureDocument>(COLLECTIONS.LOGIN_FAILURES)
        .findOne({ type: 'ip', identifier: ip });
      expect(ipDocDuringHold?.activeReservations.length).toBe(MAX_IP_FAILURES);

      // Open gate
      resolvePasswordGate!();
      const responses = await Promise.all(requestPromises);

      const status429s = responses.filter((r) => r.status === 429);
      const status401s = responses.filter((r) => r.status === 401);

      expect(status401s.length).toBe(MAX_IP_FAILURES);
      expect(status429s.length).toBe(totalRequests - MAX_IP_FAILURES);
      expect(verifyPasswordCallCount).toBe(MAX_IP_FAILURES);
    });
  });
});
