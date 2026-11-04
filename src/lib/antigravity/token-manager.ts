import { Db, ObjectId } from 'mongodb';
import { COLLECTIONS, ProviderCredentialDocument } from '@/lib/db/schema';
import {
  encryptCredential,
  decryptCredential,
} from '@/lib/crypto/credential-encryption';
import { AntigravityTokenPayload } from './types';
import { refreshAccessToken, loadCodeAssist } from './oauth';

// Mutex lock to prevent duplicate simultaneous refresh requests for the same credential
const refreshLocks = new Map<string, Promise<AntigravityTokenPayload>>();

/**
 * Validates, preemptively refreshes, and returns an active Antigravity token payload.
 * Also automatically resolves companion project_id if missing.
 */
export async function ensureValidAntigravityToken(
  db: Db,
  credential: ProviderCredentialDocument,
  decryptedSecret: string,
  options?: { forceRefresh?: boolean }
): Promise<{ tokenPayload: AntigravityTokenPayload; secret: string }> {
  let tokenPayload: AntigravityTokenPayload;
  try {
    tokenPayload = JSON.parse(decryptedSecret);
  } catch {
    throw new Error('Malformed Antigravity credential secret payload');
  }

  const now = Date.now();
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const isNearExpiry = now + FIVE_MINUTES_MS >= (tokenPayload.expiry_date || 0);
  const needsRefresh = options?.forceRefresh || isNearExpiry || !tokenPayload.access_token;
  const needsProjectId = !tokenPayload.project_id;

  if (!needsRefresh && !needsProjectId) {
    return { tokenPayload, secret: decryptedSecret };
  }

  const credIdStr = credential._id?.toString() || 'default';

  // Check if a refresh is already in-flight for this credential
  const existingLock = refreshLocks.get(credIdStr);
  if (existingLock) {
    const refreshed = await existingLock;
    return { tokenPayload: refreshed, secret: JSON.stringify(refreshed) };
  }

  const refreshPromise = (async (): Promise<AntigravityTokenPayload> => {
    let updatedPayload = { ...tokenPayload };

    if (needsRefresh) {
      if (!tokenPayload.refresh_token) {
        throw new Error('Cannot refresh Antigravity token: no refresh_token present');
      }

      try {
        const refreshRes = await refreshAccessToken(tokenPayload.refresh_token);
        const newExpiry = Date.now() + (refreshRes.expires_in ?? 3600) * 1000;

        updatedPayload.access_token = refreshRes.access_token;
        updatedPayload.expiry_date = newExpiry;
        if (refreshRes.refresh_token) {
          updatedPayload.refresh_token = refreshRes.refresh_token;
        }
      } catch (err: unknown) {
        // If refresh failed because refresh token is invalid/revoked, mark credential as reauth_required
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('invalid_grant')) {
          await db
            .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
            .updateOne(
              { _id: credential._id },
              {
                $set: {
                  status: 'reauth_required',
                  lastError: 'Refresh token revoked or invalid. Reauthentication required.',
                  updatedAt: new Date(),
                },
              }
            )
            .catch(() => {});
        }
        throw err;
      }
    }

    // If companion project ID is missing, resolve it
    if (!updatedPayload.project_id) {
      try {
        const codeAssist = await loadCodeAssist(updatedPayload.access_token);
        if (codeAssist.cloudaicompanionProject) {
          updatedPayload.project_id = codeAssist.cloudaicompanionProject;
        }
      } catch (err) {
        console.warn('Could not resolve cloudaicompanionProject during token refresh:', err);
      }
    }

    // Encrypt and persist updated credential in MongoDB
    const serializedSecret = JSON.stringify(updatedPayload);
    const encrypted = encryptCredential(serializedSecret);

    await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .updateOne(
        { _id: credential._id },
        {
          $set: {
            encryptedCredentials: encrypted,
            expiresAt: new Date(updatedPayload.expiry_date),
            status: 'active',
            updatedAt: new Date(),
          },
        }
      );

    return updatedPayload;
  })();

  refreshLocks.set(credIdStr, refreshPromise);

  try {
    const finalPayload = await refreshPromise;
    return { tokenPayload: finalPayload, secret: JSON.stringify(finalPayload) };
  } finally {
    refreshLocks.delete(credIdStr);
  }
}

