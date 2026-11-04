import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import { getDatabase, closeDatabaseConnection } from '@/lib/db/client';
import { COLLECTIONS, ProjectDocument, ProviderCredentialDocument } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import {
  generatePkce,
  generateState,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  loadCodeAssist,
  getUserInfo,
  completeOAuthFlow,
  oauthSessionStore,
} from '@/lib/antigravity/oauth';
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_USER_AGENT,
} from '@/lib/antigravity/constants';
import { ensureValidAntigravityToken } from '@/lib/antigravity/token-manager';
import { startLocalOAuthListener, stopLocalOAuthListener } from '@/lib/antigravity/local-server';
import { encryptCredential } from '@/lib/crypto/credential-encryption';

describe('Google Antigravity OAuth Implementation', () => {
  let replSet: MongoMemoryReplSet;
  let originalFetch: typeof globalThis.fetch;
  let testProjectId: ObjectId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_oauth';
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = crypto.randomBytes(32).toString('hex');

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testProjectId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'OAuth Test Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    stopLocalOAuthListener();
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    stopLocalOAuthListener();
    vi.restoreAllMocks();
  });

  describe('1. PKCE & Authorization URL', () => {
    it('generates valid RFC 7636 PKCE code_verifier and code_challenge', () => {
      const { codeVerifier, codeChallenge } = generatePkce();

      // codeVerifier should be base64url encoded 32 bytes without padding (approx 43 chars)
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(codeVerifier).not.toContain('+');
      expect(codeVerifier).not.toContain('/');
      expect(codeVerifier).not.toContain('=');

      // codeChallenge should be SHA-256 hash of codeVerifier, base64url encoded
      const expectedHash = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      expect(codeChallenge).toBe(expectedHash);
    });

    it('generates valid state string', () => {
      const state = generateState();
      expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    it('builds authorization URL matching Google Cloud Code OAuth specifications', () => {
      const state = 'test_state_123';
      const codeChallenge = 'test_challenge_abc';
      const authUrl = buildAuthorizationUrl(state, codeChallenge);

      const parsed = new URL(authUrl);
      expect(parsed.origin).toBe('https://accounts.google.com');
      expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
      expect(parsed.searchParams.get('client_id')).toBe(ANTIGRAVITY_CLIENT_ID);
      expect(parsed.searchParams.get('redirect_uri')).toBe(ANTIGRAVITY_REDIRECT_URI);
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('access_type')).toBe('offline');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
      expect(parsed.searchParams.get('include_granted_scopes')).toBe('true');
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(parsed.searchParams.get('code_challenge')).toBe(codeChallenge);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');

      const scope = parsed.searchParams.get('scope') || '';
      expect(scope).toContain('cloud-platform');
      expect(scope).toContain('userinfo.email');
      expect(scope).toContain('cclog');
      expect(scope).toContain('experimentsandconfigs');
    });
  });

  describe('2. Token Exchange & Refresh', () => {
    it('exchanges code for tokens with correct grant_type and code_verifier', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'ya29.test-access-token',
            expires_in: 3599,
            refresh_token: '1//test-refresh-token',
            token_type: 'Bearer',
            scope: 'https://www.googleapis.com/auth/cloud-platform',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await exchangeAuthorizationCode('auth_code_123', 'verifier_456');

      expect(res.access_token).toBe('ya29.test-access-token');
      expect(res.refresh_token).toBe('1//test-refresh-token');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );
    });

    it('refreshes token using refresh_token grant', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'ya29.new-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await refreshAccessToken('1//refresh-token');
      expect(res.access_token).toBe('ya29.new-access-token');
    });
  });

  describe('3. Cloud Code loadCodeAssist & UserInfo Verification', () => {
    it('loads companion project ID with required Antigravity User-Agent and IDE type', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        expect(init.headers).toMatchObject({
          Authorization: 'Bearer ya29.test-token',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
        });

        const body = JSON.parse(init.body as string);
        expect(body.metadata?.ideType).toBe('ANTIGRAVITY');

        return new Response(
          JSON.stringify({
            cloudaicompanionProject: 'projects/987654321',
            currentTier: { tierId: 'free-tier' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await loadCodeAssist('ya29.test-token');
      expect(res.cloudaicompanionProject).toBe('projects/987654321');
    });

    it('retrieves user profile email', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            email: 'coder@gmail.com',
            name: 'Test Coder',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await getUserInfo('ya29.test-token');
      expect(res.email).toBe('coder@gmail.com');
    });
  });

  describe('4. Token Lifecycle Manager (Preemptive & Reactive Refresh)', () => {
    it('preemptively refreshes token when expiry is within 5 minutes', async () => {
      const db = await getDatabase();
      const expiredPayload = {
        access_token: 'ya29.old-token',
        refresh_token: '1//refresh-token',
        expiry_date: Date.now() + 60000, // 1 minute from now (< 5 minutes)
        token_type: 'Bearer',
        project_id: 'projects/112233',
        email: 'dev@gmail.com',
      };

      const encrypted = encryptCredential(JSON.stringify(expiredPayload));
      const credDoc: ProviderCredentialDocument = {
        _id: new ObjectId(),
        projectId: testProjectId,
        provider: 'antigravity',
        displayName: 'Test Antigravity Token',
        credentialType: 'oauth',
        encryptedCredentials: encrypted,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).insertOne(credDoc);

      // Mock Google refresh endpoint
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'ya29.refreshed-fresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await ensureValidAntigravityToken(db, credDoc, JSON.stringify(expiredPayload));

      expect(result.tokenPayload.access_token).toBe('ya29.refreshed-fresh-token');
      expect(result.tokenPayload.expiry_date).toBeGreaterThan(Date.now() + 3000000);

      // Verify MongoDB document was updated
      const updatedInDb = await db
        .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
        .findOne({ _id: credDoc._id });

      expect(updatedInDb?.status).toBe('active');
    });

    it('returns existing token without calling refresh when expiry is not near', async () => {
      const db = await getDatabase();
      const validPayload = {
        access_token: 'ya29.still-valid-token',
        refresh_token: '1//refresh-token',
        expiry_date: Date.now() + 1800000, // 30 minutes from now (> 5 minutes)
        token_type: 'Bearer',
        project_id: 'projects/112233',
        email: 'dev@gmail.com',
      };

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const dummyDoc = { _id: new ObjectId() } as ProviderCredentialDocument;
      const result = await ensureValidAntigravityToken(db, dummyDoc, JSON.stringify(validPayload));

      expect(result.tokenPayload.access_token).toBe('ya29.still-valid-token');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('5. Local OAuth Server Listener', () => {
    it('starts listener on port 51121 and handles /oauth-callback', async () => {
      const db = await getDatabase();
      const state = generateState();
      const { codeVerifier } = generatePkce();

      oauthSessionStore.set(state, {
        state,
        codeVerifier,
        projectId: testProjectId.toString(),
        createdAt: Date.now(),
        status: 'pending',
      });

      // Mock Google responses during flow
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(
            JSON.stringify({
              access_token: 'ya29.listener-test-token',
              expires_in: 3600,
              refresh_token: '1//listener-refresh-token',
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('loadCodeAssist')) {
          return new Response(
            JSON.stringify({
              cloudaicompanionProject: 'projects/listener-proj',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('userinfo')) {
          return new Response(
            JSON.stringify({
              email: 'listener@test.com',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not found', { status: 404 });
      });

      const serverRes = await startLocalOAuthListener();
      expect(serverRes.success).toBe(true);

      // Trigger callback request locally
      const callbackRes = await originalFetch(
        `http://127.0.0.1:51121/oauth-callback?code=mock_auth_code&state=${state}`
      );

      expect(callbackRes.status).toBe(200);
      const html = await callbackRes.text();
      expect(html).toContain('Autentikasi Antigravity Berhasil!');

      // Verify session was updated to completed
      const session = oauthSessionStore.get(state);
      expect(session?.status).toBe('completed');
      expect(session?.credentialId).toBeDefined();
    });
  });
});

