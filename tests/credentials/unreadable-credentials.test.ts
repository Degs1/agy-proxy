import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import crypto from 'crypto';
import {
  getDatabase,
  closeDatabaseConnection,
} from '@/lib/db/client';
import {
  COLLECTIONS,
  ProjectDocument,
  ProviderCredentialDocument,
  ModelAliasDocument,
} from '@/lib/db/schema';
import { initDatabaseIndexes } from '@/lib/db/indexes';
import { createCredential } from '@/lib/credentials/service';
import {
  resolveModelAliasCredential,
  executeWithProviderCredential,
} from '@/lib/credentials/resolver';

describe('Unreadable Credentials & Non-Forwarding Defense (Requirement 3, AC 5, 3.6 / TASK-030)', () => {
  let replSet: MongoMemoryReplSet;
  const keyV1Hex = crypto.randomBytes(32).toString('hex');
  const keyV2Hex = crypto.randomBytes(32).toString('hex');

  let testProjectId: ObjectId;
  let validSecret: string;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB_NAME = 'test_unreadable_credentials';
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
    process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;

    const db = await getDatabase();
    await initDatabaseIndexes(db);

    testProjectId = new ObjectId();
    await db.collection<ProjectDocument>(COLLECTIONS.PROJECTS).insertOne({
      _id: testProjectId,
      name: 'Unreadable Defense Project',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDatabaseConnection();
    if (replSet) {
      await replSet.stop();
    }
  });

  beforeEach(async () => {
    process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
    process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;
    validSecret = 'AIzaSyActualWorkingGeminiKey999';

    const db = await getDatabase();
    await db.collection(COLLECTIONS.PROVIDER_CREDENTIALS).deleteMany({});
    await db.collection(COLLECTIONS.MODEL_ALIASES).deleteMany({});
  });

  it('fails safely with HTTP 503 provider_unavailable when key version is missing and NEVER calls provider', async () => {
    const db = await getDatabase();

    // 1. Create credential encrypted with Key V1
    const cred = await createCredential(db, testProjectId, {
      displayName: 'V1 Key Credential',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: validSecret,
      status: 'active',
    });

    // 2. Bind alias "gemini-default" to this credential
    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: cred._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 3. Remove Key V1 from environment (simulating missing key version)
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;

    // 4. Mock provider call spy
    const providerSpy = vi.fn().mockResolvedValue({ text: 'Should never run' });

    const execution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    // Assert: provider was NOT called
    expect(providerSpy).not.toHaveBeenCalled();

    // Assert: safe 503 provider_unavailable failure
    expect(execution.result).toBeUndefined();
    expect(execution.failure).toBeDefined();
    expect(execution.failure!.statusCode).toBe(503);
    expect(execution.failure!.errorCode).toBe('provider_unavailable');
    expect(execution.failure!.message).not.toContain(validSecret);
  });

  it('fails safely with 503 when ciphertext is corrupted and NEVER forwards corrupted data to provider', async () => {
    const db = await getDatabase();

    const cred = await createCredential(db, testProjectId, {
      displayName: 'Corrupted Ciphertext Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: validSecret,
      status: 'active',
    });

    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: cred._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Corrupt the ciphertext in Atlas
    const badCiphertext = Buffer.from('completely_corrupted_garbage').toString('base64');
    await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).updateOne(
      { _id: cred._id },
      { $set: { 'encryptedCredentials.ciphertext': badCiphertext } }
    );

    const providerSpy = vi.fn().mockResolvedValue({ text: 'Response' });

    const execution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    expect(providerSpy).not.toHaveBeenCalled();
    expect(execution.failure?.statusCode).toBe(503);
    expect(execution.failure?.errorCode).toBe('provider_unavailable');
  });

  it('fails safely with 503 when auth tag or IV is tampered with and NEVER calls provider', async () => {
    const db = await getDatabase();

    const cred = await createCredential(db, testProjectId, {
      displayName: 'Tampered Tag Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: validSecret,
      status: 'active',
    });

    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: cred._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Corrupt authTag
    const badTag = Buffer.from('bad_tag_16_bytes').toString('base64');
    await db.collection<ProviderCredentialDocument>(COLLECTIONS.PROVIDER_CREDENTIALS).updateOne(
      { _id: cred._id },
      { $set: { 'encryptedCredentials.authTag': badTag } }
    );

    const providerSpy = vi.fn().mockResolvedValue({ text: 'Response' });

    const execution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    expect(providerSpy).not.toHaveBeenCalled();
    expect(execution.failure?.statusCode).toBe(503);
    expect(execution.failure?.errorCode).toBe('provider_unavailable');
  });

  it('DOES NOT automatically switch to another active credential when bound credential fails (No Auto-Failover)', async () => {
    const db = await getDatabase();

    // Credential 1: Bound to alias, but its key is missing
    const cred1 = await createCredential(db, testProjectId, {
      displayName: 'Primary Bound Key (Unreadable)',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: 'secret-primary-broken',
      status: 'active',
    });

    // Credential 2: Another active credential for this project (perfectly healthy)
    const backupSecret = 'AIzaSyBackupHealthyKey456';
    const cred2 = await createCredential(db, testProjectId, {
      displayName: 'Secondary Healthy Key (Not Bound)',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: backupSecret,
      status: 'active',
    });

    // Bind alias to Credential 1
    const aliasId = new ObjectId();
    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: aliasId,
      projectId: testProjectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: cred1._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Invalidate Key V1 so Credential 1 cannot be decrypted
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;

    const providerSpy = vi.fn().mockResolvedValue({ text: 'Response' });

    // Request for gemini-default MUST FAIL with 503 and MUST NOT automatically switch to Credential 2!
    const execution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    expect(providerSpy).not.toHaveBeenCalled();
    expect(execution.failure?.statusCode).toBe(503);
    expect(execution.failure?.errorCode).toBe('provider_unavailable');

    // Restore Key V1 and verify that only explicit rebinding allows Credential 2 to be used
    process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

    // Explicit re-binding by admin
    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).updateOne(
      { _id: aliasId },
      { $set: { boundCredentialId: cred2._id! } }
    );

    const rebindExecution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy).toHaveBeenCalledWith({
      secret: backupSecret,
      upstreamModel: 'gemini-2.5-flash',
    });
  });

  it('fails safely with 503 when bound credential has been revoked or disabled, without switching credentials', async () => {
    const db = await getDatabase();

    const cred = await createCredential(db, testProjectId, {
      displayName: 'Revoked Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: validSecret,
      status: 'disabled', // disabled / revoked
    });

    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: cred._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const providerSpy = vi.fn();
    const execution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    expect(providerSpy).not.toHaveBeenCalled();
    expect(execution.failure?.statusCode).toBe(503);
    expect(execution.failure?.errorCode).toBe('provider_unavailable');
  });

  it('successfully executes provider when credential and alias are active and safely readable', async () => {
    const db = await getDatabase();

    const cred = await createCredential(db, testProjectId, {
      displayName: 'Working Key',
      provider: 'gemini',
      credentialType: 'api_key',
      secret: validSecret,
      status: 'active',
    });

    await db.collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES).insertOne({
      _id: new ObjectId(),
      projectId: testProjectId,
      alias: 'gemini-default',
      upstreamModel: 'gemini-2.5-flash',
      boundCredentialId: cred._id!,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const providerSpy = vi.fn().mockResolvedValue({ output: 'Hello from Gemini!' });

    const execution = await executeWithProviderCredential(
      db,
      testProjectId,
      'gemini-default',
      providerSpy
    );

    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy).toHaveBeenCalledWith({
      secret: validSecret,
      upstreamModel: 'gemini-2.5-flash',
    });
    expect(execution.result).toEqual({ output: 'Hello from Gemini!' });
    expect(execution.failure).toBeUndefined();
  });
});
