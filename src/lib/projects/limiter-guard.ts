import { Db, ObjectId, ClientSession } from 'mongodb';
import { COLLECTIONS, ProjectLimiterGuardDocument } from '@/lib/db/schema';

/**
 * Touches the project limiter guard document in a multi-document transaction.
 *
 * Requirements:
 * - Operates as the FIRST operation in every project configuration and admission transaction.
 * - Uses update pipeline with `$$NOW` and atomically increments `revision`.
 * - Uses `upsert: true` for projects created prior to guard bootstrap.
 * - Returns the updated guard document whose `last_server_time` serves as the authoritative
 *   server timestamp for all rate-window, lease-expiry, and timeout calculations.
 */
export async function touchProjectLimiterGuard(
  db: Db,
  projectId: ObjectId,
  session: ClientSession
): Promise<ProjectLimiterGuardDocument> {
  const result = await db
    .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
    .findOneAndUpdate(
      { _id: projectId },
      [
        {
          $set: {
            revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
            last_server_time: '$$NOW',
          },
        },
      ],
      {
        upsert: true,
        returnDocument: 'after',
        session,
      }
    );

  if (!result) {
    throw new Error(
      `Failed to touch project limiter guard for project ID: ${projectId.toString()}`
    );
  }

  return result as ProjectLimiterGuardDocument;
}

/**
 * Retrieves the project limiter guard document directly.
 */
export async function getProjectLimiterGuard(
  db: Db,
  projectId: ObjectId,
  session?: ClientSession
): Promise<ProjectLimiterGuardDocument | null> {
  const options = session ? { session } : {};
  return db
    .collection<ProjectLimiterGuardDocument>(COLLECTIONS.PROJECT_LIMITER_GUARDS)
    .findOne({ _id: projectId }, options);
}
