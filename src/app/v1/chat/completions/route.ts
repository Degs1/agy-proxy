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
  AdmissionResult,
} from '@/lib/limiter';
import { resolveModelAliasCredential } from '@/lib/credentials/resolver';
import {
  getProviderAdapter,
  AdapterError,
  AdapterChatMessage,
} from '@/lib/adapters';

export const runtime = 'nodejs';
export const maxDuration = 660;
export const dynamic = 'force-dynamic';

/**
 * Maps admission or limiter rejection / conflict to standard HTTP NextResponse.
 */
function handleAdmissionFailure(
  admissionResult: AdmissionResult,
  idempotencyKey: string
): NextResponse {
  // 1. Conflict (idempotency_conflict, request_in_progress)
  if ('conflict' in admissionResult) {
    let message = admissionResult.message;
    if (admissionResult.errorCode === 'idempotency_conflict') {
      message = 'Idempotency key already used with different payload.';
    } else if (admissionResult.errorCode === 'request_in_progress') {
      message = 'Request is currently in progress.';
    }

    return NextResponse.json(
      {
        error: {
          message,
          type: 'requests',
          param: null,
          code: admissionResult.errorCode,
        },
      },
      {
        status: admissionResult.httpStatus,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 2. Terminal Retry (succeeded, failed, cancelled, lease_expired, or rejected retry)
  if ('isTerminalRetry' in admissionResult) {
    let message = 'Request has already been processed.';
    if (admissionResult.errorCode === 'rate_limit_exceeded') {
      message = 'Rate limit exceeded.';
    } else if (admissionResult.errorCode === 'concurrency_limit_exceeded') {
      message = 'Concurrency limit exceeded.';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'x-request-id': idempotencyKey,
    };

    if (admissionResult.retryAfter !== undefined) {
      headers['Retry-After'] = String(admissionResult.retryAfter);
    }

    const outcome = {
      status: admissionResult.outcome.status,
      original_http_status: admissionResult.outcome.originalHttpStatus,
      original_error_code: admissionResult.outcome.originalErrorCode ?? null,
      completed_at: Math.floor(new Date(admissionResult.outcome.completedAt).getTime() / 1000),
    };

    return NextResponse.json(
      {
        error: {
          message,
          type: 'requests',
          param: null,
          code: admissionResult.errorCode || 'request_already_processed',
        },
        outcome,
      },
      {
        status: admissionResult.httpStatus,
        headers,
      }
    );
  }

  // 3. Fresh rejection (rate_limit_exceeded, concurrency_limit_exceeded)
  if ('reason' in admissionResult) {
    let message = 'Too Many Requests';
    if (admissionResult.reason === 'rate_limit_exceeded') {
      message = 'Rate limit exceeded.';
    } else if (admissionResult.reason === 'concurrency_limit_exceeded') {
      message = 'Concurrency limit exceeded.';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'x-request-id': idempotencyKey,
    };

    if (admissionResult.retryAfter !== undefined) {
      headers['Retry-After'] = String(admissionResult.retryAfter);
    }

    return NextResponse.json(
      {
        error: {
          message,
          type: 'requests',
          param: null,
          code: admissionResult.errorCode,
        },
      },
      {
        status: admissionResult.httpStatus,
        headers,
      }
    );
  }

  // Fallback limiter unavailable
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

export async function POST(request: NextRequest | Request): Promise<NextResponse | Response> {
  const db = await getDatabase();

  // 1. Authenticate Project API Key
  const authResult = await authenticateApiKeyRequest(request, db);
  if (!authResult.valid) {
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

  // Reject streaming in this nonstream endpoint milestone
  if (validatedRequest.stream === true) {
    return NextResponse.json(
      {
        error: {
          message: "The feature 'stream' is not supported in the nonstream completion endpoint.",
          type: 'invalid_request_error',
          param: 'stream',
          code: 'unsupported_feature',
        },
      },
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 3. Pre-admission verification of Model Alias status
  // Requirement 3.3: Pre-admission check ensures disabled alias gets 403 and missing alias gets 404
  // even if an old rejected decision exists.
  const aliasDoc = await db
    .collection<ModelAliasDocument>(COLLECTIONS.MODEL_ALIASES)
    .findOne({ projectId, alias: modelAlias });

  if (!aliasDoc) {
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

  // 4. Configure upstream timeout (default 120s per Requirement 7, AC 3)
  const rawTimeout = process.env.GATEWAY_NONSTREAM_TIMEOUT_MS;
  const parsedTimeout = rawTimeout ? parseInt(rawTimeout, 10) : NaN;
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : 120_000;

  // 5. Distributed Admission & Single-use Dispatch Coordination
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

          if (!resolution.success) {
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
        return handleAdmissionFailure(outcome.admissionResult, idempotencyKey);
      }

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
    return NextResponse.json(outcome.result, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'x-request-id': idempotencyKey,
      },
    });
  } catch (err: unknown) {
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
