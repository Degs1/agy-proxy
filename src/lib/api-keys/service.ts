import { Db, ObjectId, ClientSession } from 'mongodb';
import { COLLECTIONS, ApiKeyDocument, ProjectDocument } from '@/lib/db/schema';
import { withTransaction } from '@/lib/db/client';
import { touchProjectLimiterGuard } from '@/lib/projects/limiter-guard';
import { generateApiKey } from './crypto';
import { CreateApiKeyInput, createApiKeySchema } from './schema';

export interface CreateApiKeyResult {
  apiKey: ApiKeyDocument;
  secret: string; // Plaintext secret displayed only once upon issuance
}

/**
 * Creates and issues a new API key for a project within a multi-document transaction.
 * Writes to the project limiter guard to serialize with concurrent admissions and admin mutations.
 */
export async function createApiKey(
  db: Db,
  projectId: string | ObjectId,
  input: CreateApiKeyInput
): Promise<CreateApiKeyResult> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!pId) {
    throw new Error('Invalid project ID');
  }

  const parsed = createApiKeySchema.parse(input);
  const { secret, keyHash, keyPrefix } = generateApiKey();
  const apiKeyId = new ObjectId();
  const now = new Date();

  const apiKeyDoc: ApiKeyDocument = {
    _id: apiKeyId,
    projectId: pId,
    name: parsed.name,
    keyPrefix,
    keyHash,
    status: 'active',
    expiresAt: parsed.expiresAt,
    createdAt: now,
  };

  await withTransaction(async (session: ClientSession) => {
    // 1. Verify project exists
    const project = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .findOne({ _id: pId }, { session });

    if (!project) {
      throw new Error('Project not found');
    }

    // 2. Touch project limiter guard as part of admin mutation (Requirement 3.6)
    await touchProjectLimiterGuard(db, pId, session);

    // 3. Insert new API key document (storing only one-way hash, never the secret)
    await db
      .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
      .insertOne(apiKeyDoc, { session });
  });

  return {
    apiKey: apiKeyDoc,
    secret,
  };
}

/**
 * Revokes an API key within a multi-document transaction that writes to the project limiter guard.
 * Requirement 3, AC 6: Revocations MUST write to the project limiter guard so concurrent admissions
 * see the change and reject revoked keys immediately.
 */
export async function revokeApiKey(
  db: Db,
  keyId: string | ObjectId,
  options?: { projectId?: string | ObjectId }
): Promise<ApiKeyDocument | null> {
  const kId = typeof keyId === 'string' ? (ObjectId.isValid(keyId) ? new ObjectId(keyId) : null) : keyId;
  if (!kId) {
    return null;
  }

  return withTransaction(async (session: ClientSession) => {
    // 1. Locate key document
    const query: { _id: ObjectId; projectId?: ObjectId } = { _id: kId };
    if (options?.projectId) {
      const pId = typeof options.projectId === 'string'
        ? (ObjectId.isValid(options.projectId) ? new ObjectId(options.projectId) : null)
        : options.projectId;
      if (pId) {
        query.projectId = pId;
      }
    }

    const existingKey = await db
      .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
      .findOne(query, { session });

    if (!existingKey) {
      return null;
    }

    // 2. Touch project limiter guard as the FIRST operation (Requirement 3.6)
    await touchProjectLimiterGuard(db, existingKey.projectId, session);

    // 3. Update status to 'revoked'
    const result = await db
      .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
      .findOneAndUpdate(
        { _id: kId },
        { $set: { status: 'revoked' } },
        { returnDocument: 'after', session }
      );

    return result as ApiKeyDocument | null;
  });
}

/**
 * Lists all API keys for a project.
 */
export async function listApiKeys(
  db: Db,
  projectId: string | ObjectId
): Promise<ApiKeyDocument[]> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!pId) {
    return [];
  }

  return db
    .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
    .find({ projectId: pId })
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Retrieves a single API key by its ObjectId.
 */
export async function getApiKeyById(
  db: Db,
  keyId: string | ObjectId
): Promise<ApiKeyDocument | null> {
  const kId = typeof keyId === 'string' ? (ObjectId.isValid(keyId) ? new ObjectId(keyId) : null) : keyId;
  if (!kId) {
    return null;
  }

  return db
    .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
    .findOne({ _id: kId });
}
