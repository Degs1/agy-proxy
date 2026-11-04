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
import { resolveModelAliasCredential } from '@/lib/credentials/resolver';
import {
  getProviderAdapter,
  AdapterError,
  AdapterChatMessage,
} from '@/lib/adapters';
import { handleAdmissionFailure } from '@/lib/gateway/admission-failure';
import { handleStreamingChatCompletion } from '@/lib/gateway/stream-handler';

export const runtime = 'nodejs';
export const maxDuration = 660;
export const dynamic = 'force-dynamic';

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
