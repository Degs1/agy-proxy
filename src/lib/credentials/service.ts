import { Db, ObjectId, ClientSession } from 'mongodb';
import {
  COLLECTIONS,
  ProviderCredentialDocument,
  ProjectDocument,
} from '@/lib/db/schema';
import { withTransaction } from '@/lib/db/client';
import { touchProjectLimiterGuard } from '@/lib/projects/limiter-guard';
import {
  encryptCredential,
  decryptCredential,
  reEncryptCredential,
  CredentialEncryptionError,
  DecryptionFailedError,
  MissingKeyVersionError,
} from '@/lib/crypto/credential-encryption';
import {
  CreateCredentialInput,
  UpdateCredentialInput,
  createCredentialSchema,
} from './schema';

export class CredentialNotFoundError extends Error {
  constructor(id: string) {
    super(`Credential with id ${id} not found`);
    this.name = 'CredentialNotFoundError';
  }
}

export class CredentialInactiveError extends Error {
  constructor(id: string, status: string) {
    super(`Credential ${id} is not active (current status: ${status})`);
    this.name = 'CredentialInactiveError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project with id ${id} not found`);
    this.name = 'ProjectNotFoundError';
  }
}

/**
 * Creates a new provider credential with authenticated encryption (AES-256-GCM).
 * Persists the encrypted ciphertext, nonce (IV), authTag, and keyVersion in Atlas.
 * Serializes with admission transactions via the project limiter guard (Requirement 3, AC 6).
 */
export async function createCredential(
  db: Db,
  projectId: string | ObjectId,
  input: CreateCredentialInput
): Promise<ProviderCredentialDocument> {
  const pId = typeof projectId === 'string' ? new ObjectId(projectId) : projectId;
  const parsed = createCredentialSchema.parse(input);

  // 1. Verify project exists
  const project = await db
    .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
    .findOne({ _id: pId });
  if (!project) {
    throw new ProjectNotFoundError(pId.toString());
  }

  // 2. Encrypt plaintext secret using authenticated encryption
  const encryptedPayload = encryptCredential(parsed.secret);

  const credId = new ObjectId();
  const now = new Date();

  const credDoc: ProviderCredentialDocument = {
    _id: credId,
    projectId: pId,
    provider: parsed.provider,
    displayName: parsed.displayName,
    credentialType: parsed.credentialType,
    encryptedCredentials: encryptedPayload,
    status: parsed.status,
    maxConcurrent: parsed.maxConcurrent,
    createdAt: now,
    updatedAt: now,
  };

  // 3. Atomically persist credential and touch project limiter guard
  await withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);
    await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .insertOne(credDoc, { session });
  });

  return credDoc;
}

/**
 * Lists all provider credentials for a specific project.
 */
export async function listCredentials(
  db: Db,
  projectId: string | ObjectId,
  filter?: { status?: string; provider?: string }
): Promise<ProviderCredentialDocument[]> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!pId) return [];

  const query: Record<string, unknown> = { projectId: pId };
  if (filter?.status) {
    query.status = filter.status;
  }
  if (filter?.provider) {
    query.provider = filter.provider;
  }

  return db
    .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Retrieves a single credential by ID and project ID.
 */
export async function getCredentialById(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId
): Promise<ProviderCredentialDocument | null> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const cId = typeof credentialId === 'string' ? (ObjectId.isValid(credentialId) ? new ObjectId(credentialId) : null) : credentialId;

  if (!pId || !cId) return null;

  return db
    .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
    .findOne({ _id: cId, projectId: pId });
}

/**
 * Safely decrypts a credential for provider execution.
 * Enforces:
 * - Credential must exist and belong to the project
 * - Credential status must be active (fails closed if disabled/revoked)
 * - Ciphertext, IV, and authTag must verify against configured keyVersion
 * - Never returns fallback plaintext or leaks secrets on error
 */
export async function getSafeDecryptedCredential(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId
): Promise<{ credential: ProviderCredentialDocument; secret: string }> {
  const cred = await getCredentialById(db, projectId, credentialId);
  if (!cred) {
    throw new CredentialNotFoundError(typeof credentialId === 'string' ? credentialId : credentialId.toString());
  }

  if (cred.status !== 'active') {
    throw new CredentialInactiveError(cred._id?.toString() || '', cred.status);
  }

  const secret = decryptCredential(cred.encryptedCredentials);
  return { credential: cred, secret };
}

/**
 * Updates a credential. If secret is updated, it is re-encrypted with the active key.
 * Serializes with limiter guard inside transaction.
 */
export async function updateCredential(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId,
  input: UpdateCredentialInput
): Promise<ProviderCredentialDocument | null> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const cId = typeof credentialId === 'string' ? (ObjectId.isValid(credentialId) ? new ObjectId(credentialId) : null) : credentialId;

  if (!pId || !cId) return null;

  return withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);

    const existing = await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .findOne({ _id: cId, projectId: pId }, { session });

    if (!existing) return null;

    const updates: Partial<ProviderCredentialDocument> = {
      updatedAt: new Date(),
    };

    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.status !== undefined) updates.status = input.status;
    if (input.maxConcurrent !== undefined) updates.maxConcurrent = input.maxConcurrent;

    if (input.secret !== undefined) {
      updates.encryptedCredentials = encryptCredential(input.secret);
    }

    const result = await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .findOneAndUpdate(
        { _id: cId, projectId: pId },
        { $set: updates },
        { returnDocument: 'after', session }
      );

    return result as ProviderCredentialDocument | null;
  });
}

/**
 * Revokes / disables a credential within an atomic transaction.
 * Immediately invalidates subsequent gateway admissions via limiter guard (Requirement 3, AC 6).
 */
export async function revokeCredential(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId
): Promise<boolean> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const cId = typeof credentialId === 'string' ? (ObjectId.isValid(credentialId) ? new ObjectId(credentialId) : null) : credentialId;

  if (!pId || !cId) return false;

  return withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);

    const res = await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .updateOne(
        { _id: cId, projectId: pId },
        { $set: { status: 'disabled', updatedAt: new Date() } },
        { session }
      );

    return res.modifiedCount > 0;
  });
}

/**
 * Permanently deletes a credential within an atomic transaction.
 * Immediately invalidates subsequent gateway admissions via limiter guard.
 */
export async function deleteCredential(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId
): Promise<boolean> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const cId = typeof credentialId === 'string' ? (ObjectId.isValid(credentialId) ? new ObjectId(credentialId) : null) : credentialId;

  if (!pId || !cId) return false;

  return withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);

    const res = await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .deleteOne({ _id: cId, projectId: pId }, { session });

    return res.deletedCount > 0;
  });
}

/**
 * Migrates a credential's encryption key to the active key version (or specified targetVersion).
 * Decrypts with the previous key version, re-encrypts with the target key version,
 * verifies round-trip decryption, and atomically saves the new ciphertext.
 */
export async function rotateCredentialKeyVersion(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId,
  targetVersion?: number
): Promise<ProviderCredentialDocument> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const cId = typeof credentialId === 'string' ? (ObjectId.isValid(credentialId) ? new ObjectId(credentialId) : null) : credentialId;

  if (!pId || !cId) {
    throw new CredentialNotFoundError(String(credentialId));
  }

  return withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);

    const existing = await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .findOne({ _id: cId, projectId: pId }, { session });

    if (!existing) {
      throw new CredentialNotFoundError(cId.toString());
    }

    // Re-encrypt and verify against targetVersion
    const newEncrypted = reEncryptCredential(existing.encryptedCredentials, { targetVersion });

    const result = await db
      .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
      .findOneAndUpdate(
        { _id: cId, projectId: pId },
        {
          $set: {
            encryptedCredentials: newEncrypted,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after', session }
      );

    return result as ProviderCredentialDocument;
  });
}

/**
 * Migrates all credentials for a project to the target / active key version.
 * Returns the count of migrated documents.
 */
export async function rotateAllProjectCredentials(
  db: Db,
  projectId: string | ObjectId,
  targetVersion?: number
): Promise<{ total: number; migrated: number }> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!pId) {
    throw new ProjectNotFoundError(String(projectId));
  }

  const credentials = await listCredentials(db, pId);
  let migrated = 0;

  for (const cred of credentials) {
    await rotateCredentialKeyVersion(db, pId, cred._id!, targetVersion);
    migrated++;
  }

  return { total: credentials.length, migrated };
}

/**
 * Verifies that a credential can be successfully decrypted using its stored keyVersion.
 * Safe check: returns true/false without exposing the secret.
 */
export async function verifyCredentialDecryption(
  db: Db,
  projectId: string | ObjectId,
  credentialId: string | ObjectId
): Promise<{ valid: boolean; keyVersion: number; error?: string }> {
  const cred = await getCredentialById(db, projectId, credentialId);
  if (!cred) {
    return { valid: false, keyVersion: 0, error: 'Credential not found' };
  }

  try {
    decryptCredential(cred.encryptedCredentials);
    return { valid: true, keyVersion: cred.encryptedCredentials.keyVersion };
  } catch (err: unknown) {
    return {
      valid: false,
      keyVersion: cred.encryptedCredentials.keyVersion,
      error: err instanceof Error ? err.message : 'Decryption verification failed',
    };
  }
}
