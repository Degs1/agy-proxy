import { Db, ObjectId, ClientSession } from 'mongodb';
import {
  COLLECTIONS,
  ProjectDocument,
  ModelAliasDocument,
  ProviderCredentialDocument,
} from '@/lib/db/schema';
import { withTransaction } from '@/lib/db/client';
import {
  CreateProjectInput,
  UpdateProjectInput,
  createProjectSchema,
  CreateModelAliasInput,
  UpdateModelAliasInput,
  createModelAliasInputSchema,
  updateModelAliasInputSchema,
} from './schema';
import { touchProjectLimiterGuard } from './limiter-guard';
import { ProjectNotFoundError } from '@/lib/credentials/service';

export class InvalidCredentialBindingError extends Error {
  readonly reason: 'credential_not_found' | 'cross_project' | 'credential_inactive' | 'non_gemini_provider';
  constructor(
    reason: 'credential_not_found' | 'cross_project' | 'credential_inactive' | 'non_gemini_provider',
    message: string
  ) {
    super(message);
    this.name = 'InvalidCredentialBindingError';
    this.reason = reason;
  }
}

export class DuplicateAliasError extends Error {
  constructor(alias: string) {
    super(`Model alias '${alias}' already exists in this project`);
    this.name = 'DuplicateAliasError';
  }
}

export class AliasNotFoundError extends Error {
  constructor(id: string) {
    super(`Model alias with id '${id}' not found`);
    this.name = 'AliasNotFoundError';
  }
}

/**
 * Validates that a credential can be bound to an alias in this project.
 * Enforces Requirement 3, AC 1:
 * - Credential must exist
 * - Credential must belong to the exact same project (No cross-project binding!)
 * - Credential status must be 'active' (No disabled/revoked credentials!)
 * - Credential provider must be 'gemini' (Official Gemini provider only!)
 */
export async function validateCredentialForBinding(
  db: Db,
  projectId: ObjectId,
  credentialId: ObjectId,
  session?: ClientSession
): Promise<ProviderCredentialDocument> {
  const cred = await db
    .collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS)
    .findOne({ _id: credentialId }, { session });

  if (!cred) {
    throw new InvalidCredentialBindingError(
      'credential_not_found',
      `Credential ${credentialId} does not exist`
    );
  }

  if (!cred.projectId.equals(projectId)) {
    throw new InvalidCredentialBindingError(
      'cross_project',
      `Credential ${credentialId} belongs to project ${cred.projectId}, not project ${projectId}. Cross-project credential binding is strictly forbidden.`
    );
  }

  if (cred.status !== 'active') {
    throw new InvalidCredentialBindingError(
      'credential_inactive',
      `Credential ${credentialId} is not active (current status: ${cred.status}). Only active credentials can be bound to an alias.`
    );
  }

  if (cred.provider !== 'gemini') {
    throw new InvalidCredentialBindingError(
      'non_gemini_provider',
      `Credential ${credentialId} is for provider '${cred.provider}'. Aliases may only bind to official Gemini provider credentials.`
    );
  }

  return cred;
}

/**
 * Creates a new project along with its limiter guard within an atomic transaction.
 */
export async function createProject(
  db: Db,
  input: CreateProjectInput
): Promise<ProjectDocument> {
  const parsed = createProjectSchema.parse(input);
  const projectId = new ObjectId();
  const now = new Date();

  const projectDoc: ProjectDocument = {
    _id: projectId,
    name: parsed.name,
    description: parsed.description,
    status: parsed.status,
    rpmLimit: parsed.rpmLimit,
    concurrencyLimit: parsed.concurrencyLimit,
    allowedModels: parsed.allowedModels,
    createdAt: now,
    updatedAt: now,
  };

  await withTransaction(async (session: ClientSession) => {
    // 1. Initialize project limiter guard as part of project creation transaction
    await touchProjectLimiterGuard(db, projectId, session);

    // 2. Insert project document
    await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .insertOne(projectDoc, { session });
  });

  return projectDoc;
}

/**
 * Lists all projects with optional status filtering.
 */
export async function listProjects(
  db: Db,
  filter?: { status?: 'active' | 'disabled' }
): Promise<ProjectDocument[]> {
  const query = filter?.status ? { status: filter.status } : {};
  return db
    .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Retrieves a single project by its ObjectId.
 */
export async function getProjectById(
  db: Db,
  id: string | ObjectId
): Promise<ProjectDocument | null> {
  const objectId = typeof id === 'string' ? (ObjectId.isValid(id) ? new ObjectId(id) : null) : id;
  if (!objectId) {
    return null;
  }

  return db
    .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
    .findOne({ _id: objectId });
}

/**
 * Updates a project within an atomic transaction that writes to the project limiter guard.
 * Ensures any concurrent admission or admin transactions are serialized via the limiter guard.
 */
export async function updateProject(
  db: Db,
  id: string | ObjectId,
  input: UpdateProjectInput
): Promise<ProjectDocument | null> {
  const objectId = typeof id === 'string' ? (ObjectId.isValid(id) ? new ObjectId(id) : null) : id;
  if (!objectId) {
    return null;
  }

  return withTransaction(async (session: ClientSession) => {
    // 1. Touch project limiter guard as the FIRST operation to serialize concurrent updates & admissions
    await touchProjectLimiterGuard(db, objectId, session);

    // 2. Check if project exists
    const existing = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .findOne({ _id: objectId }, { session });

    if (!existing) {
      return null;
    }

    // 3. Prepare updates
    const updateFields: Partial<ProjectDocument> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updateFields.name = input.name;
    if (input.description !== undefined) updateFields.description = input.description;
    if (input.status !== undefined) updateFields.status = input.status;
    if (input.rpmLimit !== undefined) updateFields.rpmLimit = input.rpmLimit;
    if (input.concurrencyLimit !== undefined) updateFields.concurrencyLimit = input.concurrencyLimit;
    if (input.allowedModels !== undefined) updateFields.allowedModels = input.allowedModels;

    const result = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .findOneAndUpdate(
        { _id: objectId },
        { $set: updateFields },
        { returnDocument: 'after', session }
      );

    return result as ProjectDocument | null;
  });
}

/**
 * Deletes a project within an atomic transaction.
 * Revokes all associated API keys and cleans up the limiter guard.
 */
export async function deleteProject(
  db: Db,
  id: string | ObjectId
): Promise<boolean> {
  const objectId = typeof id === 'string' ? (ObjectId.isValid(id) ? new ObjectId(id) : null) : id;
  if (!objectId) {
    return false;
  }

  return withTransaction(async (session: ClientSession) => {
    // 1. Touch limiter guard
    await touchProjectLimiterGuard(db, objectId, session);

    // 2. Check if project exists
    const existing = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .findOne({ _id: objectId }, { session });

    if (!existing) {
      return false;
    }

    // 3. Revoke all associated API keys per PRD requirement
    await db
      .collection(COLLECTIONS.API_KEYS)
      .updateMany(
        { projectId: objectId },
        { $set: { status: 'revoked' } },
        { session }
      );

    // 4. Delete limiter guard
    await db
      .collection(COLLECTIONS.PROJECT_LIMITER_GUARDS)
      .deleteOne({ _id: objectId }, { session });

    // 5. Delete project document
    const deleteResult = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .deleteOne({ _id: objectId }, { session });

    return deleteResult.deletedCount > 0;
  });
}

/**
 * Creates a model alias bound to an active Gemini credential belonging to the project.
 * Serializes with admission transactions by writing project limiter guard (Requirement 3, AC 6).
 */
export async function createModelAlias(
  db: Db,
  projectId: string | ObjectId,
  input: CreateModelAliasInput
): Promise<ModelAliasDocument> {
  const pId = typeof projectId === 'string' ? new ObjectId(projectId) : projectId;
  const parsed = createModelAliasInputSchema.parse(input);
  const boundCredId =
    typeof parsed.boundCredentialId === 'string'
      ? new ObjectId(parsed.boundCredentialId)
      : parsed.boundCredentialId;

  const project = await db
    .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
    .findOne({ _id: pId });
  if (!project) {
    throw new ProjectNotFoundError(pId.toString());
  }

  // 1. Validate bound credential against Requirement 3, AC 1 rules
  await validateCredentialForBinding(db, pId, boundCredId);

  // 2. Check duplicate alias name
  const existing = await db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .findOne({ projectId: pId, alias: parsed.alias });
  if (existing) {
    throw new DuplicateAliasError(parsed.alias);
  }

  const aliasDoc: ModelAliasDocument = {
    _id: new ObjectId(),
    projectId: pId,
    alias: parsed.alias,
    upstreamModel: parsed.upstreamModel,
    boundCredentialId: boundCredId,
    status: parsed.status,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // 3. Persist alias and touch limiter guard atomically
  await withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);
    await db
      .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
      .insertOne(aliasDoc, { session });

    // Ensure alias is in project allowedModels
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).updateOne(
      { _id: pId },
      { $addToSet: { allowedModels: parsed.alias }, $set: { updatedAt: new Date() } },
      { session }
    );
  });

  return aliasDoc;
}

/**
 * Updates a model alias. If rebinding credential, validates against Requirement 3, AC 1 rules.
 * Serializes with admission transactions via limiter guard.
 */
export async function updateModelAlias(
  db: Db,
  projectId: string | ObjectId,
  aliasId: string | ObjectId,
  input: UpdateModelAliasInput
): Promise<ModelAliasDocument | null> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const aId = typeof aliasId === 'string' ? (ObjectId.isValid(aliasId) ? new ObjectId(aliasId) : null) : aliasId;
  if (!pId || !aId) return null;

  const parsed = updateModelAliasInputSchema.parse(input);

  return withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);

    const existing = await db
      .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
      .findOne({ _id: aId, projectId: pId }, { session });

    if (!existing) {
      return null;
    }

    let boundCredId = existing.boundCredentialId;
    if (parsed.boundCredentialId !== undefined) {
      boundCredId =
        typeof parsed.boundCredentialId === 'string'
          ? new ObjectId(parsed.boundCredentialId)
          : parsed.boundCredentialId;
      await validateCredentialForBinding(db, pId, boundCredId, session);
    }

    if (parsed.alias !== undefined && parsed.alias !== existing.alias) {
      const dup = await db
        .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
        .findOne({ projectId: pId, alias: parsed.alias, _id: { $ne: aId } }, { session });
      if (dup) {
        throw new DuplicateAliasError(parsed.alias);
      }
    }

    const updates: Partial<ModelAliasDocument> = {
      updatedAt: new Date(),
    };
    if (parsed.alias !== undefined) updates.alias = parsed.alias;
    if (parsed.upstreamModel !== undefined) updates.upstreamModel = parsed.upstreamModel;
    if (parsed.boundCredentialId !== undefined) updates.boundCredentialId = boundCredId;
    if (parsed.status !== undefined) updates.status = parsed.status;

    const result = await db
      .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
      .findOneAndUpdate(
        { _id: aId, projectId: pId },
        { $set: updates },
        { returnDocument: 'after', session }
      );

    return result as ModelAliasDocument | null;
  });
}

/**
 * Deletes a model alias within a transaction touching the limiter guard.
 */
export async function deleteModelAlias(
  db: Db,
  projectId: string | ObjectId,
  aliasId: string | ObjectId
): Promise<boolean> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const aId = typeof aliasId === 'string' ? (ObjectId.isValid(aliasId) ? new ObjectId(aliasId) : null) : aliasId;
  if (!pId || !aId) return false;

  return withTransaction(async (session: ClientSession) => {
    await touchProjectLimiterGuard(db, pId, session);

    const res = await db
      .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
      .deleteOne({ _id: aId, projectId: pId }, { session });

    return res.deletedCount > 0;
  });
}

/**
 * Retrieves all model aliases for a specific project.
 */
export async function listModelAliases(
  db: Db,
  projectId: string | ObjectId
): Promise<ModelAliasDocument[]> {
  const objectId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!objectId) {
    return [];
  }

  return db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .find({ projectId: objectId })
    .sort({ createdAt: 1 })
    .toArray();
}

/**
 * Retrieves a single model alias by project and alias identifier.
 */
export async function getModelAlias(
  db: Db,
  projectId: string | ObjectId,
  alias: string
): Promise<ModelAliasDocument | null> {
  const objectId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  if (!objectId) {
    return null;
  }

  return db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .findOne({ projectId: objectId, alias });
}

/**
 * Retrieves a model alias by its ObjectId and projectId.
 */
export async function getModelAliasById(
  db: Db,
  projectId: string | ObjectId,
  aliasId: string | ObjectId
): Promise<ModelAliasDocument | null> {
  const pId = typeof projectId === 'string' ? (ObjectId.isValid(projectId) ? new ObjectId(projectId) : null) : projectId;
  const aId = typeof aliasId === 'string' ? (ObjectId.isValid(aliasId) ? new ObjectId(aliasId) : null) : aliasId;
  if (!pId || !aId) return null;

  return db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .findOne({ _id: aId, projectId: pId });
}
