import { Db, ObjectId, ClientSession } from 'mongodb';
import { COLLECTIONS, ProjectDocument, ModelAliasDocument } from '@/lib/db/schema';
import { withTransaction } from '@/lib/db/client';
import { CreateProjectInput, UpdateProjectInput, createProjectSchema } from './schema';
import { touchProjectLimiterGuard } from './limiter-guard';

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

