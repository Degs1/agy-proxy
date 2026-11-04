import { Db, ObjectId } from 'mongodb';
import {
  COLLECTIONS,
  ModelAliasDocument,
  ProviderCredentialDocument,
} from '@/lib/db/schema';
import {
  decryptCredential,
  CredentialEncryptionError,
} from '@/lib/crypto/credential-encryption';
import { ensureValidAntigravityToken } from '@/lib/antigravity/token-manager';

export interface CredentialResolutionFailure {
  success: false;
  statusCode: 403 | 404 | 503;
  errorCode: 'model_not_found' | 'model_disabled' | 'provider_unavailable';
  message: string;
}

export interface CredentialResolutionSuccess {
  success: true;
  alias: ModelAliasDocument;
  credential: ProviderCredentialDocument;
  secret: string;
  upstreamModel: string;
}

export type CredentialResolutionResult =
  | CredentialResolutionFailure
  | CredentialResolutionSuccess;

/**
 * Creates an onRefreshToken callback for the adapter when using Antigravity OAuth.
 */
export function createAntigravityRefreshTokenCallback(
  db: Db,
  credDoc: ProviderCredentialDocument,
  currentSecret: string
): (() => Promise<string>) | undefined {
  if (credDoc.provider !== 'antigravity' || credDoc.credentialType !== 'oauth') {
    return undefined;
  }
  return async () => {
    const { secret } = await ensureValidAntigravityToken(
      db,
      credDoc,
      currentSecret,
      { forceRefresh: true }
    );
    return secret;
  };
}

/**
 * Resolves the credential bound to a model alias for gateway invocation.
 * Strict rules enforced per Requirement 3 (AC 5, AC 6) & Approved Design:
 * - If model alias not found: 404 model_not_found
 * - If model alias disabled: 403 model_disabled
 * - If bound credential does not exist: 503 provider_unavailable
 * - If bound credential disabled/revoked: 503 provider_unavailable
 * - If decryption fails (missing key, wrong key, corrupt ciphertext/IV/tag): 503 provider_unavailable
 * - GATEWAY SHALL NEVER FALL BACK TO ANOTHER CREDENTIAL AUTOMATICALLY!
 * - GATEWAY SHALL NEVER FORWARD UNREADABLE CREDENTIAL OR FALLBACK PLAINTEXT TO PROVIDER!
 */
export async function resolveModelAliasCredential(
  db: Db,
  projectId: string | ObjectId,
  aliasName: string
): Promise<CredentialResolutionResult> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!pId) {
    return {
      success: false,
      statusCode: 404,
      errorCode: 'model_not_found',
      message: `Model alias '${aliasName}' not found`,
    };
  }

  // 1. Locate model alias within the project
  const aliasDoc = await db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .findOne({ projectId: pId, alias: aliasName });

  if (!aliasDoc) {
    return {
      success: false,
      statusCode: 404,
      errorCode: 'model_not_found',
      message: `Model alias '${aliasName}' not found`,
    };
  }

  // 2. Check alias status
  if (aliasDoc.status !== 'active') {
    return {
      success: false,
      statusCode: 403,
      errorCode: 'model_disabled',
      message: `Model alias '${aliasName}' is disabled`,
    };
  }

  // 3. Locate explicit bound credential belonging to this project
  const credDoc = await db
    .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
    .findOne({ _id: aliasDoc.boundCredentialId, projectId: pId });

  if (!credDoc) {
    // Credential is missing or does not belong to this project
    return {
      success: false,
      statusCode: 503,
      errorCode: 'provider_unavailable',
      message: 'Bound provider credential is missing or unavailable',
    };
  }

  // 4. Verify credential status
  if (credDoc.status !== 'active') {
    return {
      success: false,
      statusCode: 503,
      errorCode: 'provider_unavailable',
      message: 'Bound provider credential has been revoked or disabled',
    };
  }

  // 5. Attempt safe authenticated decryption
  let decryptedSecret: string;
  try {
    decryptedSecret = decryptCredential(credDoc.encryptedCredentials);
  } catch (err: unknown) {
    // Safe failure: never leak key, plaintext, or raw trace; do not fall back to other credentials!
    return {
      success: false,
      statusCode: 503,
      errorCode: 'provider_unavailable',
      message: 'Provider credential decryption failed; provider cannot be safely reached',
    };
  }

  // 6. If provider is Antigravity OAuth, proactively verify and refresh token if near expiry
  if (credDoc.provider === 'antigravity' && credDoc.credentialType === 'oauth') {
    try {
      const { secret } = await ensureValidAntigravityToken(db, credDoc, decryptedSecret);
      decryptedSecret = secret;
    } catch (err: unknown) {
      return {
        success: false,
        statusCode: 503,
        errorCode: 'provider_unavailable',
        message: 'Antigravity OAuth token validation or refresh failed',
      };
    }
  }

  return {
    success: true,
    alias: aliasDoc,
    credential: credDoc,
    secret: decryptedSecret,
    upstreamModel: aliasDoc.upstreamModel,
  };
}

/**
 * Executes a provider call strictly guarding against forwarding unreadable credentials.
 * If resolution fails, providerFn is NEVER invoked.
 */
export async function executeWithProviderCredential<T>(
  db: Db,
  projectId: string | ObjectId,
  aliasName: string,
  providerFn: (context: { secret: string; upstreamModel: string }) => Promise<T>
): Promise<{ result?: T; failure?: CredentialResolutionFailure }> {
  const resolution = await resolveModelAliasCredential(db, projectId, aliasName);

  if (!resolution.success) {
    // Provider is NOT called, unreadable credential is NOT forwarded, no fallback credential used!
    return { failure: resolution };
  }

  const result = await providerFn({
    secret: resolution.secret,
    upstreamModel: resolution.upstreamModel,
  });

  return { result };
}
