import crypto from 'crypto';
import { EncryptedCredentialPayload } from '@/lib/db/schema';

/**
 * Custom error types for credential encryption & decryption.
 * Designed to fail closed and never leak plaintext secrets or keys in messages.
 */
export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEncryptionError';
  }
}

export class MissingActiveKeyError extends CredentialEncryptionError {
  constructor(version: number) {
    super(`Active encryption key version ${version} is not configured in the environment`);
    this.name = 'MissingActiveKeyError';
  }
}

export class MissingKeyVersionError extends CredentialEncryptionError {
  constructor(version: number) {
    super(`Encryption key for version ${version} is missing from environment keys`);
    this.name = 'MissingKeyVersionError';
  }
}

export class DecryptionFailedError extends CredentialEncryptionError {
  constructor(reason: string = 'Integrity verification failed or wrong key') {
    super(`Failed to safely decrypt credential: ${reason}`);
    this.name = 'DecryptionFailedError';
  }
}

export class InvalidKeyFormatError extends CredentialEncryptionError {
  constructor(message: string = 'Encryption key must be exactly 32 bytes (256 bits)') {
    super(message);
    this.name = 'InvalidKeyFormatError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce recommended for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

/**
 * Parses and validates a 32-byte (256-bit) buffer from a key string.
 * Supports hex (64 chars), base64 (44 chars), or raw 32-byte UTF-8 string.
 */
export function parseEncryptionKey(rawKey: string): Buffer {
  if (!rawKey || typeof rawKey !== 'string') {
    throw new InvalidKeyFormatError('Key must be a non-empty string');
  }

  const trimmed = rawKey.trim();

  // 1. Try 64-char hex
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // 2. Try Base64
  try {
    const b64Buf = Buffer.from(trimmed, 'base64');
    if (b64Buf.length === 32) {
      return b64Buf;
    }
  } catch {
    // Continue to check raw buffer
  }

  // 3. Raw 32-byte buffer
  const rawBuf = Buffer.from(trimmed, 'utf8');
  if (rawBuf.length === 32) {
    return rawBuf;
  }

  throw new InvalidKeyFormatError(
    `Encryption key must resolve to exactly 32 bytes (got ${rawBuf.length} bytes)`
  );
}

export interface KeyStore {
  activeVersion: number;
  keys: Map<number, Buffer>;
}

/**
 * Loads encryption keys from environment variables.
 * Sources:
 * - CREDENTIAL_ENCRYPTION_ACTIVE_VERSION: active version number (default 1)
 * - CREDENTIAL_ENCRYPTION_KEY_V<N>: key for version N (e.g. CREDENTIAL_ENCRYPTION_KEY_V1)
 * - CREDENTIAL_ENCRYPTION_KEYS: JSON object mapping versions to key strings { "1": "...", "2": "..." }
 * - CREDENTIAL_ENCRYPTION_KEY: legacy / default single key for version 1
 */
export function loadKeyStoreFromEnv(env: NodeJS.ProcessEnv = process.env): KeyStore {
  const activeVersionStr = env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION || '1';
  const activeVersion = parseInt(activeVersionStr, 10);

  const keys = new Map<number, Buffer>();

  // 1. Check CREDENTIAL_ENCRYPTION_KEYS JSON map
  if (env.CREDENTIAL_ENCRYPTION_KEYS) {
    try {
      const parsed = JSON.parse(env.CREDENTIAL_ENCRYPTION_KEYS);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [vStr, keyVal] of Object.entries(parsed)) {
          const vNum = parseInt(vStr, 10);
          if (!isNaN(vNum) && typeof keyVal === 'string') {
            keys.set(vNum, parseEncryptionKey(keyVal));
          }
        }
      }
    } catch {
      // Ignore JSON parse errors here, individual env vars can still be used
    }
  }

  // 2. Check CREDENTIAL_ENCRYPTION_KEY_V<N>
  for (const [envKey, envVal] of Object.entries(env)) {
    const match = envKey.match(/^CREDENTIAL_ENCRYPTION_KEY_V(\d+)$/);
    if (match && envVal) {
      const vNum = parseInt(match[1], 10);
      keys.set(vNum, parseEncryptionKey(envVal));
    }
  }

  // 3. Check single fallback CREDENTIAL_ENCRYPTION_KEY (version 1)
  if (!keys.has(1) && env.CREDENTIAL_ENCRYPTION_KEY) {
    keys.set(1, parseEncryptionKey(env.CREDENTIAL_ENCRYPTION_KEY));
  }

  return {
    activeVersion: isNaN(activeVersion) ? 1 : activeVersion,
    keys,
  };
}

/**
 * Encrypts a plaintext secret using AES-256-GCM and the active (or specified) key version.
 * Returns ciphertext, 12-byte IV/nonce, 16-byte authTag, and the keyVersion.
 */
export function encryptCredential(
  plaintext: string,
  options?: {
    version?: number;
    keyStore?: KeyStore;
  }
): EncryptedCredentialPayload {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new CredentialEncryptionError('Plaintext credential cannot be empty');
  }

  const keyStore = options?.keyStore ?? loadKeyStoreFromEnv();
  const version = options?.version ?? keyStore.activeVersion;

  const key = keyStore.keys.get(version);
  if (!key) {
    throw new MissingActiveKeyError(version);
  }

  // Generate cryptographically secure 12-byte IV for GCM
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion: version,
  };
}

/**
 * Decrypts an authenticated ciphertext payload using the key version specified in the payload.
 * Throws DecryptionFailedError or MissingKeyVersionError on failure.
 * Never returns fallback plaintext or leaks keys.
 */
export function decryptCredential(
  payload: EncryptedCredentialPayload,
  options?: {
    keyStore?: KeyStore;
  }
): string {
  if (!payload || !payload.ciphertext || !payload.iv || !payload.authTag) {
    throw new DecryptionFailedError('Missing required encrypted payload components');
  }

  if (typeof payload.keyVersion !== 'number') {
    throw new DecryptionFailedError('Invalid or missing keyVersion in encrypted payload');
  }

  const keyStore = options?.keyStore ?? loadKeyStoreFromEnv();
  const key = keyStore.keys.get(payload.keyVersion);

  if (!key) {
    throw new MissingKeyVersionError(payload.keyVersion);
  }

  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');

    if (iv.length !== IV_LENGTH) {
      throw new DecryptionFailedError('Invalid IV length');
    }

    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new DecryptionFailedError('Invalid authentication tag length');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (err: unknown) {
    if (err instanceof CredentialEncryptionError) {
      throw err;
    }
    // Any GCM verification failure or parsing error fails safely
    throw new DecryptionFailedError(
      err instanceof Error ? err.message : 'Ciphertext verification failed'
    );
  }
}

/**
 * Re-encrypts an existing payload with the active key version (or specified target version).
 * Verifies that the new ciphertext can be decrypted successfully before returning.
 */
export function reEncryptCredential(
  payload: EncryptedCredentialPayload,
  options?: {
    targetVersion?: number;
    keyStore?: KeyStore;
  }
): EncryptedCredentialPayload {
  const keyStore = options?.keyStore ?? loadKeyStoreFromEnv();
  const targetVersion = options?.targetVersion ?? keyStore.activeVersion;

  // 1. Decrypt using the current payload's key version
  const decrypted = decryptCredential(payload, { keyStore });

  // 2. Encrypt using the target version
  const reEncrypted = encryptCredential(decrypted, {
    version: targetVersion,
    keyStore,
  });

  // 3. Immediately verify the new ciphertext can be decrypted
  const verified = decryptCredential(reEncrypted, { keyStore });
  if (verified !== decrypted) {
    throw new CredentialEncryptionError('Key rotation verification check failed');
  }

  return reEncrypted;
}
