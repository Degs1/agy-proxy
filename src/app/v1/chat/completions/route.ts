import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDatabase } from '@/lib/db/client';
import { authenticateApiKeyRequest } from '@/lib/auth/api-key-guard';
import { validateGatewayRequest } from '@/lib/validation/pipeline';
import { GatewayError } from '@/lib/validation/error';
import { COLLECTIONS, ModelAliasDocument } from '@/lib/db/schema';
import {
  dispatchWithAdmission,
  AdmissionRequestInput,
} from '@/lib/limiter';
import { resolveModelAliasCredential, createAntigravityRefreshTokenCallback } from '@/lib/credentials/resolver';
import {
  getProviderAdapter,
  AdapterError,
  AdapterChatMessage,
} from '@/lib/adapters';
import { handleAdmissionFailure } from '@/lib/gateway/admission-failure';
import { handleStreamingChatCompletion } from '@/lib/gateway/stream-handler';
import { recordUsageLog, recordPreauthRejection } from '@/lib/monitoring';

export const runtime = 'nodejs';
export const maxDuration = 660;
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest | Request): Promise<NextResponse | Response> {
  const startTime = new Date();
  const startTimeMs = startTime.getTime();
  let resolvedProvider: string | null = null;
  const db = await getDatabase();

  // 1. Authenticate Project API Key
  const authResult = await authenticateApiKeyRequest(request, db);
  if (!authResult.valid) {
    const rawReqId = request.headers.get('Idempotency-Key') || request.headers.get('idempotency-key') || null;
    await recordPreauthRejection(db, {
      requestId: rawReqId,
      startTime,
      durationMs: Date.now() - startTimeMs,
      statusCode: authResult.status,
      errorCode: authResult.code,
    }).catch(() => {});
    return authResult.response;
  }

  const projectId = authResult.project._id instanceof ObjectId
    ? authResult.project._id
    : new ObjectId(authResult.project._id);

  const apiKeyId = authResult.apiKey._id instanceof ObjectId
    ? authResult.apiKey._id
    : new ObjectId(authResult.apiKey._id);

  // 2. Validate Request Body, JSON bounds, parameters, roles, and calculate canonical fingerprint
  let processed;
  try {
    processed = await validateGatewayRequest(request);
  } catch (err: unknown) {
    const rawReqId = request.headers.get('Idempotency-Key') || request.headers.get('idempotency-key') || null;
    const errStatusCode = err instanceof GatewayError ? err.httpStatus : 400;
    const errCode = err instanceof GatewayError ? String(err.code) : 'invalid_request';

    await recordUsageLog(db, {
      requestId: rawReqId,
      projectId,
      apiKeyId,
      model: null,
      provider: resolvedProvider ?? null,
      statusCode: errStatusCode,
      durationMs: Date.now() - startTimeMs,
      result: 'error',
      errorCode: errCode,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: false,
      createdAt: startTime,
    }).catch(() => {});

    if (err instanceof GatewayError) {
      return NextResponse.json(err.toResponseObject(), {
        status: err.httpStatus,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }
    return NextResponse.json(
      {
        error: {
          message: err instanceof Error ? err.message : 'Invalid request.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request',
        },
      },
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  const { idempotencyKey, validatedRequest, fingerprint } = processed;
  const modelAlias = validatedRequest.model;

  // 3. Pre-admission verification of Model Alias status
  // Requirement 3.3: Pre-admission check ensures disabled alias gets 403 and missing alias gets 404
  // even if an old rejected decision exists.
  const aliasDoc = await db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .findOne({ projectId, alias: modelAlias });

  if (!aliasDoc) {
    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: resolvedProvider ?? null,
      statusCode: 404,
      durationMs: Date.now() - startTimeMs,
      result: 'error',
      errorCode: 'model_not_found',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: validatedRequest.stream === true,
      createdAt: startTime,
    }).catch(() => {});

    return NextResponse.json(
      {
        error: {
          message: `Model alias '${modelAlias}' not found.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        },
      },
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  if (aliasDoc.status !== 'active') {
    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: resolvedProvider ?? null,
      statusCode: 403,
      durationMs: Date.now() - startTimeMs,
      result: 'error',
      errorCode: 'model_disabled',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: validatedRequest.stream === true,
      createdAt: startTime,
    }).catch(() => {});

    return NextResponse.json(
      {
        error: {
          message: `Model alias '${modelAlias}' is disabled.`,
          type: 'permission_error',
          param: 'model',
          code: 'model_disabled',
        },
      },
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 4. Handle Streaming Request if stream: true
  if (validatedRequest.stream === true) {
    return handleStreamingChatCompletion({
      db,
      request,
      projectId,
      apiKeyId,
      idempotencyKey,
      fingerprint,
      modelAlias,
      validatedRequest,
      startTime,
    });
  }

  // 5. Configure nonstream upstream timeout (default 120s per Requirement 7, AC 3)
  const rawTimeout = process.env.GATEWAY_NONSTREAM_TIMEOUT_MS;
  const parsedTimeout = rawTimeout ? parseInt(rawTimeout, 10) : NaN;
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : 120_000;

  // 6. Distributed Admission & Single-use Dispatch Coordination for Non-stream
  const admissionInput: AdmissionRequestInput = {
    projectId,
    apiKeyId,
    requestId: idempotencyKey,
    payloadFingerprint: fingerprint,
    modelAlias,
  };

  try {
    const outcome = await dispatchWithAdmission(
      db,
      admissionInput,
      async (leaseSignal) => {
        // Setup 120s timeout controller
        const timeoutController = new AbortController();
        let isTimedOut = false;
        const timer = setTimeout(() => {
          isTimedOut = true;
          timeoutController.abort(new Error('Gateway timeout'));
        }, timeoutMs);

        const abortSignals: AbortSignal[] = [timeoutController.signal];
        if (leaseSignal) {
          abortSignals.push(leaseSignal);
        }
        if (request.signal) {
          abortSignals.push(request.signal);
        }
        const combinedSignal = AbortSignal.any(abortSignals);

        try {
          // Decrypt bound provider credential (Safe Zero-Plaintext-Recall)
          // Executed AFTER admission commit. If decryption fails, quota remains committed
          // and provider is NEVER called (Requirement 3.6 & TASK-055).
          const resolution = await resolveModelAliasCredential(
            db,
            projectId,
            modelAlias
          );

          if (resolution.success) {
            resolvedProvider = resolution.credential.provider;
          } else {
            throw new GatewayError({
              message: resolution.message,
              httpStatus: resolution.statusCode,
              code: resolution.errorCode,
              type: 'provider_error',
            });
          }

          if (combinedSignal.aborted) {
            if (isTimedOut || timeoutController.signal.aborted) {
              throw new GatewayError({
                message: 'Gateway timed out waiting for provider.',
                httpStatus: 504,
                code: 'gateway_timeout',
                type: 'server_error',
                param: null,
              });
            }
            throw new GatewayError({
              message: 'Request was aborted',
              httpStatus: 499,
              code: 'client_closed_request',
            });
          }

          // Execute Upstream Provider Adapter
          const adapter = getProviderAdapter(resolution.credential.provider);

          const adapterReq = {
            model: modelAlias,
            messages: validatedRequest.messages as AdapterChatMessage[],
            temperature: validatedRequest.temperature,
            max_tokens: validatedRequest.max_tokens,
            stream: false,
          };

          const adapterCtx = {
            secret: resolution.secret,
            upstreamModel: resolution.upstreamModel,
            signal: combinedSignal,
            onRefreshToken: createAntigravityRefreshTokenCallback(db, resolution.credential, resolution.secret),
          };

          return await adapter.executeNonStream(adapterReq, adapterCtx);
        } catch (err: unknown) {
          if (isTimedOut || timeoutController.signal.aborted) {
            throw new GatewayError({
              message: 'Gateway timed out waiting for provider.',
              httpStatus: 504,
              code: 'gateway_timeout',
              type: 'server_error',
              param: null,
            });
          }

          if (request.signal?.aborted) {
            throw new GatewayError({
              message: 'Request was aborted',
              httpStatus: 499,
              code: 'client_closed_request',
            });
          }

          if (err instanceof AdapterError) {
            throw new GatewayError({
              message: err.message,
              httpStatus: err.statusCode,
              code: err.code as any,
              type: err.errorType,
              param: err.param,
            });
          }

          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
    );

    if (!outcome.success) {
      if ('admissionResult' in outcome) {
        const adm = outcome.admissionResult;
        const statusCode = 'httpStatus' in adm && typeof adm.httpStatus === 'number' ? adm.httpStatus : 503;
        const errorCode = 'errorCode' in adm && adm.errorCode ? adm.errorCode : 'admission_rejected';
        await recordUsageLog(db, {
          requestId: idempotencyKey,
          projectId,
          apiKeyId,
          model: modelAlias,
          provider: resolvedProvider ?? null,
          statusCode,
          durationMs: Date.now() - startTimeMs,
          result: 'error',
          errorCode,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          streaming: false,
          createdAt: startTime,
        }).catch(() => {});
        return handleAdmissionFailure(outcome.admissionResult, idempotencyKey);
      }

      await recordUsageLog(db, {
        requestId: idempotencyKey,
        projectId,
        apiKeyId,
        model: modelAlias,
        provider: resolvedProvider ?? null,
        statusCode: 503,
        durationMs: Date.now() - startTimeMs,
        result: 'error',
        errorCode: 'limiter_unavailable',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        streaming: false,
        createdAt: startTime,
      }).catch(() => {});

      return NextResponse.json(
        {
          error: {
            message: 'Service Unavailable: Rate limiter state is unavailable or unconfirmed',
            type: 'requests',
            param: null,
            code: 'limiter_unavailable',
          },
        },
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'x-request-id': idempotencyKey,
          },
        }
      );
    }

    // Successfully committed terminal decision and released concurrency lease!
    const usage = (outcome.result as any)?.usage;
    const inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
    const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : null;

    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: resolvedProvider ?? 'gemini',
      statusCode: 200,
      durationMs: Date.now() - startTimeMs,
      result: 'success',
      errorCode: null,
      inputTokens,
      outputTokens,
      totalTokens,
      streaming: false,
      createdAt: startTime,
    }).catch(() => {});

    return NextResponse.json(outcome.result, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'x-request-id': idempotencyKey,
      },
    });
  } catch (err: unknown) {
    const isGatewayError = err instanceof GatewayError;
    const statusCode = isGatewayError ? err.httpStatus : 500;
    const errorCode = isGatewayError ? String(err.code) : 'internal_error';
    const result = statusCode === 499 ? 'cancelled' : statusCode === 504 ? 'timeout' : 'error';

    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: resolvedProvider ?? null,
      statusCode,
      durationMs: Date.now() - startTimeMs,
      result,
      errorCode,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: false,
      createdAt: startTime,
    }).catch(() => {});

    if (err instanceof GatewayError) {
      return NextResponse.json(err.toResponseObject(), {
        status: err.httpStatus,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      });
    }

    return NextResponse.json(
      {
        error: {
          message: err instanceof Error ? err.message : 'Internal server error.',
          type: 'server_error',
          param: null,
          code: 'internal_error',
        },
      },
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }
}
