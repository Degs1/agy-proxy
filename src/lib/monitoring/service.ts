import { Db, ObjectId } from 'mongodb';
import {
  COLLECTIONS,
  ProjectDocument,
} from '@/lib/db/schema';
import {
  UsageLogDocument,
  PreauthRejectionLogDocument,
  PreauthRejectionCounterDocument,
  RecordUsageLogParams,
  RecordPreauthRejectionParams,
  PreauthRejectionResult,
  MonitoringQueryOptions,
  MonitoringSummaryResult,
  MonitoringDetailsResult,
  MonitoringProjectSummary,
  MonitoringProviderSummary,
  MonitoringDetailsLogItem,
} from './schema';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PREAUTH_PER_MINUTE = 1000;

/**
 * Safely records authenticated usage telemetry asynchronously.
 * Never throws an error or rejects promises to ensure gateway operations are not disrupted.
 * Strictly adheres to Zero-Plaintext-Recall: no secrets, no message/prompt/response content.
 */
export async function recordUsageLog(
  db: Db,
  params: RecordUsageLogParams
): Promise<void> {
  try {
    const now = params.createdAt ?? new Date();
    const expiresAt = new Date(now.getTime() + SEVEN_DAYS_MS);

    const inputTokens = typeof params.inputTokens === 'number' && Number.isFinite(params.inputTokens)
      ? params.inputTokens
      : null;
    const outputTokens = typeof params.outputTokens === 'number' && Number.isFinite(params.outputTokens)
      ? params.outputTokens
      : null;
    const totalTokens = typeof params.totalTokens === 'number' && Number.isFinite(params.totalTokens)
      ? params.totalTokens
      : inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null;

    const doc: UsageLogDocument = {
      requestId: params.requestId ?? null,
      projectId: params.projectId,
      apiKeyId: params.apiKeyId ?? null,
      model: params.model ?? null,
      provider: params.provider ?? null,
      statusCode: params.statusCode,
      durationMs: params.durationMs,
      result: params.result,
      errorCode: params.errorCode ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      streaming: params.streaming,
      createdAt: now,
      expiresAt,
    };

    await db.collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS).insertOne(doc);
  } catch (err: unknown) {
    // Fail-safe: Log operational warning without sensitive information; never throw
    console.error('Safe fail: Failed to record usage log', {
      requestId: params.requestId,
      statusCode: params.statusCode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Safely records pre-authentication rejections with distributed rate limiting:
 * - Capped at 1,000 logs per UTC minute across instances.
 * - Stored in a separate collection without project/provider attribution.
 * - Expires after 7 days.
 * - Never throws.
 */
export async function recordPreauthRejection(
  db: Db,
  params: RecordPreauthRejectionParams
): Promise<PreauthRejectionResult> {
  try {
    const refTime = params.overrideMinute ?? params.startTime;
    const utcMinute = new Date(
      Date.UTC(
        refTime.getUTCFullYear(),
        refTime.getUTCMonth(),
        refTime.getUTCDate(),
        refTime.getUTCHours(),
        refTime.getUTCMinutes(),
        0,
        0
      )
    );

    let allowed = false;

    // 1. Try atomic increment if count < MAX_PREAUTH_PER_MINUTE
    const counterRes = await db
      .collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS)
      .findOneAndUpdate(
        { utcMinute, count: { $lt: MAX_PREAUTH_PER_MINUTE } },
        {
          $inc: { count: 1 },
          $setOnInsert: { createdAt: refTime },
        },
        { upsert: false, returnDocument: 'after' }
      );

    if (counterRes) {
      allowed = true;
    } else {
      // Document might not exist yet for this minute or was just inserted concurrently
      const existing = await db
        .collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS)
        .findOne({ utcMinute });

      if (!existing) {
        try {
          await db
            .collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS)
            .insertOne({
              utcMinute,
              count: 1,
              createdAt: refTime,
            });
          allowed = true;
        } catch (insertErr: any) {
          if (insertErr?.code === 11000) {
            // Concurrent insert collided; retry conditional increment
            const retryRes = await db
              .collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS)
              .findOneAndUpdate(
                { utcMinute, count: { $lt: MAX_PREAUTH_PER_MINUTE } },
                { $inc: { count: 1 } },
                { returnDocument: 'after' }
              );
            allowed = !!retryRes;
          } else {
            throw insertErr;
          }
        }
      } else if (existing.count < MAX_PREAUTH_PER_MINUTE) {
        // Document exists and is still under limit (was created concurrently by another instance)
        const retryRes = await db
          .collection<PreauthRejectionCounterDocument>(COLLECTIONS.PREAUTH_REJECTION_COUNTERS)
          .findOneAndUpdate(
            { utcMinute, count: { $lt: MAX_PREAUTH_PER_MINUTE } },
            { $inc: { count: 1 } },
            { returnDocument: 'after' }
          );
        allowed = !!retryRes;
      } else {
        // Exceeded 1,000 threshold for this minute; individual recording is suppressed
        allowed = false;
      }
    }

    if (!allowed) {
      return { recorded: false };
    }

    // 2. Write individual preauth rejection document (strictly unlinked from projects)
    const expiresAt = new Date(params.startTime.getTime() + SEVEN_DAYS_MS);
    const preauthDoc: PreauthRejectionLogDocument = {
      requestId: params.requestId ?? null,
      startTime: params.startTime,
      durationMs: params.durationMs,
      statusCode: params.statusCode,
      errorCode: params.errorCode ?? null,
      projectId: null,
      model: null,
      provider: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      createdAt: params.startTime,
      expiresAt,
    };

    await db
      .collection<PreauthRejectionLogDocument>(COLLECTIONS.PREAUTH_REJECTION_LOGS)
      .insertOne(preauthDoc);

    return { recorded: true };
  } catch (err: unknown) {
    console.error('Safe fail: Failed to record preauth rejection log', {
      statusCode: params.statusCode,
      error: err instanceof Error ? err.message : String(err),
    });
    return { recorded: false, error: err };
  }
}

/**
 * Aggregates monitoring summary:
 * - Total requests, success/fail counts, average latency
 * - Measured token usage (prompt, completion, total)
 * - Per-project breakdown
 * - Per-provider breakdown
 * - Pre-authentication rejections (completely separate)
 */
export async function getMonitoringSummary(
  db: Db,
  options?: MonitoringQueryOptions
): Promise<MonitoringSummaryResult> {
  const query: Record<string, unknown> = {};

  if (options?.projectId) {
    try {
      query.projectId = new ObjectId(options.projectId);
    } catch {
      // Invalid ObjectId; will match nothing
      query.projectId = new ObjectId();
    }
  }

  if (options?.provider) {
    query.provider = options.provider;
  }

  if (options?.startDate || options?.endDate) {
    const dateQuery: Record<string, unknown> = {};
    if (options.startDate) {
      dateQuery.$gte = options.startDate;
    }
    if (options.endDate) {
      dateQuery.$lte = options.endDate;
    }
    query.createdAt = dateQuery;
  }

  // 1. Aggregation pipeline to compute stats inside MongoDB without memory spikes
  const pipeline = [
    { $match: query },
    {
      $facet: {
        overall: [
          {
            $group: {
              _id: null,
              totalRequests: { $sum: 1 },
              successfulRequests: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ['$statusCode', 200] },
                        { $lt: ['$statusCode', 400] },
                        { $eq: ['$result', 'success'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              failedRequests: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $lt: ['$statusCode', 200] },
                        { $gte: ['$statusCode', 400] },
                        { $ne: ['$result', 'success'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              totalDurationMs: { $sum: '$durationMs' },
              promptTokensTotal: { $sum: { $ifNull: ['$inputTokens', 0] } },
              completionTokensTotal: { $sum: { $ifNull: ['$outputTokens', 0] } },
              totalTokensTotal: {
                $sum: {
                  $ifNull: [
                    '$totalTokens',
                    { $add: [{ $ifNull: ['$inputTokens', 0] }, { $ifNull: ['$outputTokens', 0] }] },
                  ],
                },
              },
            },
          },
        ],
        byProject: [
          { $match: { projectId: { $ne: null } } },
          {
            $group: {
              _id: '$projectId',
              totalRequests: { $sum: 1 },
              successfulRequests: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ['$statusCode', 200] },
                        { $lt: ['$statusCode', 400] },
                        { $eq: ['$result', 'success'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              failedRequests: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $lt: ['$statusCode', 200] },
                        { $gte: ['$statusCode', 400] },
                        { $ne: ['$result', 'success'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              promptTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              completionTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              totalTokens: {
                $sum: {
                  $ifNull: [
                    '$totalTokens',
                    { $add: [{ $ifNull: ['$inputTokens', 0] }, { $ifNull: ['$outputTokens', 0] }] },
                  ],
                },
              },
            },
          },
        ],
        byProvider: [
          { $match: { provider: { $ne: null } } },
          {
            $group: {
              _id: '$provider',
              totalRequests: { $sum: 1 },
              successfulRequests: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ['$statusCode', 200] },
                        { $lt: ['$statusCode', 400] },
                        { $eq: ['$result', 'success'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              failedRequests: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $lt: ['$statusCode', 200] },
                        { $gte: ['$statusCode', 400] },
                        { $ne: ['$result', 'success'] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              promptTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              completionTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              totalTokens: {
                $sum: {
                  $ifNull: [
                    '$totalTokens',
                    { $add: [{ $ifNull: ['$inputTokens', 0] }, { $ifNull: ['$outputTokens', 0] }] },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ];

  const [aggregateResult] = await db
    .collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS)
    .aggregate(pipeline)
    .toArray();

  const overall = aggregateResult?.overall?.[0] ?? {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalDurationMs: 0,
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    totalTokensTotal: 0,
  };

  const totalRequests = overall.totalRequests;
  const successfulRequests = overall.successfulRequests;
  const failedRequests = overall.failedRequests;
  const averageDurationMs = totalRequests > 0 ? overall.totalDurationMs / totalRequests : 0;
  const promptTokensTotal = overall.promptTokensTotal;
  const completionTokensTotal = overall.completionTokensTotal;
  const totalTokensTotal = overall.totalTokensTotal;

  // 2. Fetch project documents to attach project names
  const byProject = aggregateResult?.byProject ?? [];
  const projectIds = byProject.map((p: any) =>
    p._id instanceof ObjectId ? p._id : new ObjectId(p._id)
  );
  const projects =
    projectIds.length > 0
      ? await db
          .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
          .find({ _id: { $in: projectIds } })
          .toArray()
      : [];
  const projectNameMap = new Map(projects.map((p) => [p._id.toString(), p.name]));

  const projectSummaries: MonitoringProjectSummary[] = byProject.map((p: any) => {
    const pId = p._id.toString();
    return {
      projectId: pId,
      projectName: projectNameMap.get(pId) || 'Unknown Project',
      totalRequests: p.totalRequests,
      successfulRequests: p.successfulRequests,
      failedRequests: p.failedRequests,
      promptTokens: p.promptTokens,
      completionTokens: p.completionTokens,
      totalTokens: p.totalTokens,
    };
  });

  const byProvider = aggregateResult?.byProvider ?? [];
  const providerSummaries: MonitoringProviderSummary[] = byProvider.map((p: any) => ({
    provider: String(p._id),
    totalRequests: p.totalRequests,
    successfulRequests: p.successfulRequests,
    failedRequests: p.failedRequests,
    promptTokens: p.promptTokens,
    completionTokens: p.completionTokens,
    totalTokens: p.totalTokens,
  }));

  // 3. Pre-auth rejections (isolated, never attributed to projects or providers)
  const preauthQuery: Record<string, unknown> = {};
  if (options?.startDate || options?.endDate) {
    const dateQuery: Record<string, unknown> = {};
    if (options.startDate) {
      dateQuery.$gte = options.startDate;
    }
    if (options.endDate) {
      dateQuery.$lte = options.endDate;
    }
    preauthQuery.createdAt = dateQuery;
  }
  const preauthTotal = await db
    .collection(COLLECTIONS.PREAUTH_REJECTION_LOGS)
    .countDocuments(preauthQuery);

  return {
    totalRequests,
    successfulRequests,
    failedRequests,
    averageDurationMs,
    totalTokens: {
      promptTokens: promptTokensTotal,
      completionTokens: completionTokensTotal,
      totalTokens: totalTokensTotal,
    },
    projects: projectSummaries,
    providers: providerSummaries,
    preauthRejections: {
      total: preauthTotal,
    },
  };
}

/**
 * Returns detailed, paginated request logs with optional filtering.
 */
export async function getMonitoringDetails(
  db: Db,
  options?: MonitoringQueryOptions
): Promise<MonitoringDetailsResult> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
  const offset = Math.max(options?.offset ?? 0, 0);

  // Check if caller explicitly requested preauth logs
  if (options?.type === 'preauth') {
    const preauthQuery: Record<string, unknown> = {};
    if (options.startDate || options.endDate) {
      const dateQuery: Record<string, unknown> = {};
      if (options.startDate) dateQuery.$gte = options.startDate;
      if (options.endDate) dateQuery.$lte = options.endDate;
      preauthQuery.createdAt = dateQuery;
    }

    const total = await db
      .collection<PreauthRejectionLogDocument>(COLLECTIONS.PREAUTH_REJECTION_LOGS)
      .countDocuments(preauthQuery);

    const docs = await db
      .collection<PreauthRejectionLogDocument>(COLLECTIONS.PREAUTH_REJECTION_LOGS)
      .find(preauthQuery)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    const logs: MonitoringDetailsLogItem[] = docs.map((doc) => ({
      id: doc._id?.toString() ?? '',
      requestId: doc.requestId,
      projectId: null,
      projectName: null,
      model: null,
      provider: null,
      statusCode: doc.statusCode,
      durationMs: doc.durationMs,
      result: 'error',
      errorCode: doc.errorCode,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: false,
      createdAt: doc.createdAt.toISOString(),
    }));

    return { logs, total, limit, offset };
  }

  // Standard usage logs
  const query: Record<string, unknown> = {};
  if (options?.projectId) {
    try {
      query.projectId = new ObjectId(options.projectId);
    } catch {
      query.projectId = new ObjectId();
    }
  }

  if (options?.provider) {
    query.provider = options.provider;
  }

  if (options?.status) {
    if (['success', 'error', 'cancelled', 'timeout'].includes(options.status)) {
      query.result = options.status;
    } else {
      const parsedStatus = parseInt(options.status, 10);
      if (!isNaN(parsedStatus)) {
        query.statusCode = parsedStatus;
      }
    }
  }

  if (options?.startDate || options?.endDate) {
    const dateQuery: Record<string, unknown> = {};
    if (options.startDate) dateQuery.$gte = options.startDate;
    if (options.endDate) dateQuery.$lte = options.endDate;
    query.createdAt = dateQuery;
  }

  const total = await db
    .collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS)
    .countDocuments(query);

  const docs = await db
    .collection<UsageLogDocument>(COLLECTIONS.USAGE_LOGS)
    .find(query)
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();

  // Lookup project names
  const projectIds = Array.from(new Set(docs.map((d) => d.projectId)));
  const projects = await db
    .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
    .find({ _id: { $in: projectIds } })
    .toArray();
  const projectNameMap = new Map(projects.map((p) => [p._id.toString(), p.name]));

  const logs: MonitoringDetailsLogItem[] = docs.map((doc) => ({
    id: doc._id?.toString() ?? '',
    requestId: doc.requestId,
    projectId: doc.projectId.toString(),
    projectName: projectNameMap.get(doc.projectId.toString()) || 'Unknown Project',
    model: doc.model ?? null,
    provider: doc.provider ?? null,
    statusCode: doc.statusCode,
    durationMs: doc.durationMs,
    result: doc.result,
    errorCode: doc.errorCode ?? null,
    inputTokens: doc.inputTokens ?? null,
    outputTokens: doc.outputTokens ?? null,
    totalTokens: doc.totalTokens ?? null,
    streaming: doc.streaming,
    createdAt: doc.createdAt.toISOString(),
  }));

  return { logs, total, limit, offset };
}
