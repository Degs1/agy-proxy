import { hash, verify } from '@node-rs/argon2';

// In @node-rs/argon2, Algorithm.Argon2id is 2 (default).
// Explicit value 2 satisfies isolatedModules.
const ARGON2ID_ALGORITHM = 2;

/**
 * Hash a password using Argon2id.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }

  return hash(password, {
    algorithm: ARGON2ID_ALGORITHM,
    memoryCost: 19456, // 19 MiB recommended default
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

/**
 * Verify a password against an Argon2id hash.
 */
export async function verifyPassword(hashString: string, password: string): Promise<boolean> {
  if (!hashString || !password) {
    return false;
  }

  try {
    return await verify(hashString, password);
  } catch {
    return false;
  }
}
