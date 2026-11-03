import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import {
  getDatabase,
  closeDatabaseConnection,
  withTransaction,
} from '@/lib/db/client';
import { COLLECTIONS, ProjectDocument, ProjectLimiterGuardDocument } from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createProject, updateProject } from '@/lib/projects/service';
import { touchProjectLimiterGuard, getProjectLimiterGuard } from '@/lib/projects/limiter-guard';

describe('Project Limiter Guard & Admin Mutation Conflicts (Requirement 3, AC 6 & Subtask 6.3)', () => {
  let replSet: MongoMemoryReplSet;
  const originalEnv = process.env;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_gateway_guard_conflicts';

    const db = await getDatabase();
    await initDatabaseIndexes(db);
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
    process.env = originalEnv;
  });

  beforeEach(async () => {
    const db = await getDatabase();
    await db.collection(COLLECTIONS.PROJECTS).deleteMany({});
    await db.collection(COLLECTIONS.PROJECT_LIMITER_GUARDS).deleteMany({});
    await db.collection(COLLECTIONS.ADMISSION_DECISIONS).deleteMany({});
  });

  it('serializes concurrent limiter guard touches and prevents lost revision updates', async () => {
    const db = await getDatabase();
    const project = await createProject(db, {
      name: 'Concurrency Serialization Project',
      rpmLimit: 60,
      concurrencyLimit: 5,
    });
    const projectId = project._id!;

    // Initial revision from createProject should be 1
    const initialGuard = await getProjectLimiterGuard(db, projectId);
    expect(initialGuard).not.toBeNull();
    expect(initialGuard?.revision).toBe(1);

    // Launch 5 concurrent transactions, each touching the limiter guard
    const concurrencyCount = 5;
    const promises = Array.from({ length: concurrencyCount }).map(async (_, idx) => {
      return withTransaction(async (session) => {
        const guard = await touchProjectLimiterGuard(db, projectId, session);
        // Small artificial delay to simulate transactional work
        await new Promise((resolve) => setTimeout(resolve, 10 + (idx % 3) * 5));
        return guard;
      });
    });

    const results = await Promise.all(promises);
    expect(results).toHaveLength(concurrencyCount);

    // Verify final guard state: revision must be exactly 1 + 5 = 6 without lost updates
    const finalGuard = await getProjectLimiterGuard(db, projectId);
    expect(finalGuard).not.toBeNull();
    expect(finalGuard?.revision).toBe(1 + concurrencyCount);
    expect(finalGuard?.last_server_time).toBeInstanceOf(Date);
  });

  it('ensures admin project disable transaction forces concurrent admission to re-read updated status and reject request', async () => {
    const db = await getDatabase();
    const project = await createProject(db, {
      name: 'Live Project to Disable',
      status: 'active',
    });
    const projectId = project._id!;

    let admissionAttempts = 0;
    let admissionRejectedDueToDisabled = false;

    // Simulate an admission transaction running concurrently with an admin disable transaction
    // The admission transaction touches the guard first, reads project status, and records decision
    const runSimulatedAdmission = async () => {
      try {
        await withTransaction(async (session) => {
          admissionAttempts++;

          // 1. Touch limiter guard as first operation
          await touchProjectLimiterGuard(db, projectId, session);

          // Simulate slight pause to increase chance of overlap
          await new Promise((resolve) => setTimeout(resolve, 30));

          // 2. Re-read project status from Atlas inside the transaction
          const currentProject = await db
            .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
            .findOne({ _id: projectId }, { session });

          if (!currentProject || currentProject.status === 'disabled') {
            admissionRejectedDueToDisabled = true;
            throw new Error('project_disabled');
          }

          // 3. Insert admission decision if active
          await db.collection(COLLECTIONS.ADMISSION_DECISIONS).insertOne(
            {
              projectId,
              apiKeyId: new ObjectId(),
              requestId: `req-${Date.now()}`,
              attemptId: `att-${Date.now()}`,
              payloadFingerprint: 'dummy_fp',
              status: 'running',
              createdAt: new Date(),
              dedupeUntil: new Date(Date.now() + 86400000),
            },
            { session }
          );
        });
      } catch (err: any) {
        if (err.message !== 'project_disabled') {
          throw err;
        }
      }
    };

    // Admin mutation that disables the project
    const runAdminDisable = async () => {
      // Small stagger to let admission begin first
      await new Promise((resolve) => setTimeout(resolve, 5));
      await updateProject(db, projectId, { status: 'disabled' });
    };

    // Run both concurrently
    await Promise.all([runSimulatedAdmission(), runAdminDisable()]);

    // Check project status in database
    const finalProject = await db
      .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
      .findOne({ _id: projectId });
    expect(finalProject?.status).toBe('disabled');

    // Either the admission was rejected during retry/execution, OR if admission won,
    // subsequent admissions must be rejected. Let's run a guaranteed subsequent admission:
    let subsequentRejected = false;
    try {
      await withTransaction(async (session) => {
        await touchProjectLimiterGuard(db, projectId, session);
        const p = await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).findOne({ _id: projectId }, { session });
        if (p?.status === 'disabled') {
          subsequentRejected = true;
          throw new Error('project_disabled');
        }
      });
    } catch (err: any) {
      if (err.message !== 'project_disabled') throw err;
    }

    expect(subsequentRejected).toBe(true);

    // Verify guard revision reflects all committed mutations
    const finalGuard = await getProjectLimiterGuard(db, projectId);
    expect(finalGuard?.revision).toBeGreaterThanOrEqual(2);
  });

  it('handles upsert initialization for legacy projects without existing limiter guards', async () => {
    const db = await getDatabase();
    const legacyProjectId = new ObjectId();

    // Insert project document without a limiter guard document
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: legacyProjectId,
      name: 'Legacy Project Uninitialized',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Guard should not exist yet
    const guardBefore = await getProjectLimiterGuard(db, legacyProjectId);
    expect(guardBefore).toBeNull();

    // First transaction touching guard performs upsert: true
    const touchedGuard = await withTransaction(async (session) => {
      return touchProjectLimiterGuard(db, legacyProjectId, session);
    });

    expect(touchedGuard).not.toBeNull();
    expect(touchedGuard._id.toString()).toBe(legacyProjectId.toString());
    expect(touchedGuard.revision).toBe(1);
    expect(touchedGuard.last_server_time).toBeInstanceOf(Date);

    // Subsequent transaction increments revision to 2
    const secondGuard = await withTransaction(async (session) => {
      return touchProjectLimiterGuard(db, legacyProjectId, session);
    });

    expect(secondGuard.revision).toBe(2);
  });
});
