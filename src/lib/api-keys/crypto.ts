import crypto from 'node:crypto';

export const API_KEY_PREFIX = 'agw_';
export const RANDOM_BYTES_COUNT = 32; // 256 bits of entropy (Requirement 3.2)

export interface GeneratedApiKey {
  secret: string; // The plaintext secret, displayed only once upon issuance
  keyHash: string; // One-way SHA-256 hash stored in MongoDB
  keyPrefix: string; // Public identifier prefix (agw_ + 8 hex chars)
}

/**
 * Generates an API key using a cryptographically secure pseudo-random number generator (CSPRNG).
 * Generates at least 256 bits of entropy per Requirement 3, AC 2 and PRD FR-006.
 */
export function generateApiKey(): GeneratedApiKey {
  const randomBytes = crypto.randomBytes(RANDOM_BYTES_COUNT);
  const secretHex = randomBytes.toString('hex'); // 32 bytes * 2 hex chars = 64 hex chars (256 bits)
  const secret = `${API_KEY_PREFIX}${secretHex}`;
  const keyHash = hashApiKey(secret);
  const keyPrefix = secret.slice(0, 12); // "agw_" + 8 hex chars

  return {
    secret,
    keyHash,
    keyPrefix,
  };
}

/**
 * Computes the one-way cryptographic SHA-256 hash of a bearer key.
 * Used for database storage and index matching.
 */
export function hashApiKey(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Validates whether an incoming token matches the canonical API key format:
 * "agw_" followed by 64 hex characters (256 bits).
 */
export function isValidApiKeyFormat(token: string): boolean {
  if (typeof token !== 'string') return false;
  if (!token.startsWith(API_KEY_PREFIX)) return false;
  const hexPart = token.slice(API_KEY_PREFIX.length);
  return /^[0-9a-fA-F]{64}$/.test(hexPart);
}
