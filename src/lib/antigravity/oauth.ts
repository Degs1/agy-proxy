import crypto from 'crypto';
import { Db, ObjectId } from 'mongodb';
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_TOKEN_URL,
  ANTIGRAVITY_USERINFO_URL,
  ANTIGRAVITY_ENDPOINTS,
  ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_SCOPES,
} from './constants';
import {
  AntigravityTokenPayload,
  GoogleTokenResponse,
  GoogleUserInfo,
  LoadCodeAssistResponse,
  OAuthSessionState,
} from './types';
import { createCredential } from '@/lib/credentials/service';
import { ProviderCredentialDocument } from '@/lib/db/schema';

/**
 * Base64URL string without padding per RFC 7636.
 */
function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a cryptographically secure random state string.
 */
export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(16));
}

/**
 * Generates PKCE code_verifier (32 bytes) and code_challenge (SHA-256 S256).
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = base64UrlEncode(hash);
  return { codeVerifier, codeChallenge };
}

/**
 * Constructs the Google OAuth authorization URL with PKCE parameters.
 */
export function buildAuthorizationUrl(state: string, codeChallenge: string): string {
  const url = new URL(ANTIGRAVITY_AUTH_URL);
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Exchanges authorization code and PKCE code_verifier for Google tokens.
 */
export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
  });

  const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = (await res.json()) as GoogleTokenResponse;

  if (!res.ok || data.error) {
    const errorMsg = data.error_description || data.error || 'Token exchange failed';
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${errorMsg}`);
  }

  return data;
}

/**
 * Refreshes an expired Google access token using a refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = (await res.json()) as GoogleTokenResponse;

  if (!res.ok || data.error) {
    const errorMsg = data.error_description || data.error || 'Token refresh failed';
    throw new Error(`Google OAuth token refresh failed (${res.status}): ${errorMsg}`);
  }

  return data;
}

/**
 * Retrieves the authenticated user's profile info (email).
 */
export async function getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(ANTIGRAVITY_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    return {};
  }

  return (await res.json()) as GoogleUserInfo;
}

/**
 * Verifies Antigravity access and resolves active companion project ID via loadCodeAssist.
 * Attempts primary and fallback Cloud Code endpoints.
 */
export async function loadCodeAssist(accessToken: string): Promise<LoadCodeAssistResponse> {
  let lastError: Error | null = null;

  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const url = `${endpoint}/v1internal:loadCodeAssist`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
        },
        body: JSON.stringify({
          metadata: {
            ideType: 'ANTIGRAVITY',
          },
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        lastError = new Error(`loadCodeAssist failed (${res.status}) on ${endpoint}: ${errorText}`);
        continue;
      }

      const json = (await res.json()) as LoadCodeAssistResponse;
      return json;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('Failed to reach Cloud Code loadCodeAssist endpoint');
}

/**
 * In-memory store for active OAuth sessions (15-minute TTL).
 */
class OAuthSessionStore {
  private sessions = new Map<string, OAuthSessionState>();

  set(state: string, session: OAuthSessionState) {
    this.cleanExpired();
    this.sessions.set(state, session);
  }

  get(state: string): OAuthSessionState | undefined {
    this.cleanExpired();
    return this.sessions.get(state);
  }

  delete(state: string) {
    this.sessions.delete(state);
  }

  private cleanExpired() {
    const now = Date.now();
    const TTL_MS = 15 * 60 * 1000;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.createdAt > TTL_MS) {
        this.sessions.delete(key);
      }
    }
  }
}

export const oauthSessionStore = new OAuthSessionStore();

/**
 * Orchestrates full OAuth exchange, verification via loadCodeAssist, and saves encrypted credential.
 */
export async function completeOAuthFlow(
  db: Db,
  params: {
    code: string;
    codeVerifier: string;
    projectId: string;
    displayName?: string;
  }
): Promise<ProviderCredentialDocument> {
  // 1. Exchange code for tokens
  const tokenRes = await exchangeAuthorizationCode(params.code, params.codeVerifier);

  if (!tokenRes.access_token) {
    throw new Error('Google OAuth response did not contain an access_token');
  }

  const refreshToken = tokenRes.refresh_token;
  if (!refreshToken) {
    throw new Error(
      'Google OAuth response did not contain a refresh_token. Ensure prompt=consent and access_type=offline were requested.'
    );
  }

  const expiryDate = Date.now() + (tokenRes.expires_in ?? 3600) * 1000;

  // 2. Fetch User Profile Info (Email)
  const userInfo = await getUserInfo(tokenRes.access_token).catch(() => ({}));
  const email = userInfo.email || 'unknown@user';

  // 3. Verify Antigravity & get GCP companion project ID
  let projectId = '';
  let tier = '';
  try {
    const codeAssistRes = await loadCodeAssist(tokenRes.access_token);
    projectId = codeAssistRes.cloudaicompanionProject || '';
    tier = codeAssistRes.currentTier?.tierId || '';
  } catch (err: unknown) {
    console.warn('loadCodeAssist verification warning:', err);
  }

  // 4. Construct token payload
  const tokenPayload: AntigravityTokenPayload = {
    access_token: tokenRes.access_token,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
    token_type: tokenRes.token_type || 'Bearer',
    scope: tokenRes.scope,
    id_token: tokenRes.id_token,
    project_id: projectId,
    email,
    tier,
  };

  const displayName =
    params.displayName?.trim() ||
    `Google Antigravity (${email})`;

  // 5. Encrypt and save credential
  const credDoc = await createCredential(db, params.projectId, {
    displayName,
    provider: 'antigravity',
    credentialType: 'oauth',
    secret: JSON.stringify(tokenPayload),
    status: 'active',
  });

  return credDoc;
}

