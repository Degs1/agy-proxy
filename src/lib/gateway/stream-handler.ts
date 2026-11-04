import { Db, ObjectId } from 'mongodb';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import {
  AdmissionRequestInput,
  requestAdmission,
  acquireDispatchPermission,
  finalizeAdmissionDecision,
  startLeaseHeartbeat,
  AdmissionHooks,
} from '@/lib/limiter';
import { handleAdmissionFailure } from './admission-failure';
import { resolveModelAliasCredential } from '@/lib/credentials/resolver';
import {
  getProviderAdapter,
  AdapterError,
  AdapterChatMessage,
  ChatCompletionChunk,
  StreamEvent,
} from '@/lib/adapters';
import { GatewayError } from '@/lib/validation/error';
import { recordUsageLog } from '@/lib/monitoring';

export interface StreamingChatCompletionOptions {
  hooks?: AdmissionHooks & {
    onBeforeFinalChunkCommit?: () => Promise<void>;
    onAfterFinalChunkCommit?: () => Promise<void>;
    onBeforeErrorCommit?: () => Promise<void>;
  };
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export interface StreamingChatCompletionParams {
  db: Db;
  request: NextRequest | Request;
  projectId: ObjectId;
  apiKeyId: ObjectId;
  idempotencyKey: string;
  fingerprint: string;
  modelAlias: string;
  validatedRequest: {
    model: string;
    messages: AdapterChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
  options?: StreamingChatCompletionOptions;
  startTime?: Date;
}

/**
 * Handles end-to-end SSE streaming completion:
 * - Distributed admission & single-use dispatch permission.
 * - Leases with 15s heartbeat renewal.
 * - Credential decryption after admission.
 * - Delayed headers until first content chunk.
 * - Standard OpenAI SSE format with single [DONE].
 * - Atomic terminal commit prior to final success chunk or error event.
 * - Discards late upstream outputs.
 * - Client cancellation via AbortSignal.
 * - Deterministic 600s total request timeout.
 */
export async function handleStreamingChatCompletion(
  params: StreamingChatCompletionParams
): Promise<Response | NextResponse> {
  const {
    db,
    request,
    projectId,
    apiKeyId,
    idempotencyKey,
    fingerprint,
    modelAlias,
    validatedRequest,
    options,
    startTime: paramStartTime,
  } = params;

  const startTime = paramStartTime ?? new Date();
  const startTimeMs = startTime.getTime();
  let resolution: any = null;

  const logStreamUsage = async (usageParams: {
    statusCode: number;
    result: 'success' | 'error' | 'cancelled' | 'timeout';
    errorCode?: string | null;
    provider?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
  }) => {
    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: usageParams.provider ?? resolution?.credential?.provider ?? null,
      statusCode: usageParams.statusCode,
      durationMs: Date.now() - startTimeMs,
      result: usageParams.result,
      errorCode: usageParams.errorCode ?? null,
      inputTokens: usageParams.inputTokens ?? null,
      outputTokens: usageParams.outputTokens ?? null,
      totalTokens: usageParams.totalTokens ?? null,
      streaming: true,
      createdAt: startTime,
    }).catch(() => {});
  };

  // 1. Configure streaming timeout (default 600s per Requirement 7, AC 3)
  const rawTimeout = process.env.GATEWAY_STREAM_TIMEOUT_MS;
  const parsedTimeout = rawTimeout ? parseInt(rawTimeout, 10) : NaN;
  const timeoutMs =
    options?.timeoutMs ??
    (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 600_000);

  // 2. Distributed Admission
  const admissionInput: AdmissionRequestInput = {
    projectId,
    apiKeyId,
    requestId: idempotencyKey,
    payloadFingerprint: fingerprint,
    modelAlias,
  };

  const admission = await requestAdmission(db, admissionInput, options?.hooks);
  if (!admission.admitted) {
    const statusCode = 'httpStatus' in admission && typeof admission.httpStatus === 'number' ? admission.httpStatus : 503;
    const errorCode = 'errorCode' in admission && admission.errorCode ? admission.errorCode : 'admission_rejected';
    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: null,
      statusCode,
      durationMs: Date.now() - startTimeMs,
      result: 'error',
      errorCode,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: true,
      createdAt: startTime,
    }).catch(() => {});
    return handleAdmissionFailure(admission, idempotencyKey);
  }

  // 3. Acquire atomic dispatch permission
  const dispatch = await acquireDispatchPermission(
    db,
    {
      projectId,
      apiKeyId,
      requestId: idempotencyKey,
      attemptId: admission.attemptId,
      generation: admission.generation,
      decisionId: admission.decisionId,
    },
    options?.hooks
  );

  if (!dispatch.granted) {
    await recordUsageLog(db, {
      requestId: idempotencyKey,
      projectId,
      apiKeyId,
      model: modelAlias,
      provider: null,
      statusCode: 503,
      durationMs: Date.now() - startTimeMs,
      result: 'error',
      errorCode: 'limiter_unavailable',
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      streaming: true,
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

  // 4. Start lease heartbeat (perpanjang tiap 15 detik)
  const leaseCtrl = startLeaseHeartbeat(
    db,
    {
      projectId,
      decisionId: admission.decisionId,
      leaseId: admission.leaseId,
    },
    {
      heartbeatIntervalMs: options?.heartbeatIntervalMs,
      clock: options?.hooks?.clock,
    }
  );

  // 5. Setup 600s timeout controller and combined AbortSignal
  const timeoutController = new AbortController();
  let isTimedOut = false;
  const timer = setTimeout(() => {
    isTimedOut = true;
    timeoutController.abort(new Error('Gateway timeout'));
  }, timeoutMs);

  const abortSignals: AbortSignal[] = [timeoutController.signal];
  if (leaseCtrl.signal) {
    abortSignals.push(leaseCtrl.signal);
  }
  if (request.signal) {
    abortSignals.push(request.signal);
  }
  const combinedSignal = AbortSignal.any(abortSignals);

  // 6. Decrypt bound provider credential (Safe Zero-Plaintext-Recall)
  // resolution assigned in try block
  try {
    resolution = await resolveModelAliasCredential(db, projectId, modelAlias);
  } catch {
    clearTimeout(timer);
    leaseCtrl.stop();
    await finalizeAdmissionDecision(
      db,
      {
        projectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
        attemptId: admission.attemptId,
        finalStatus: 'failed',
        originalHttpStatus: 503,
        originalErrorCode: 'provider_unavailable',
      },
      { clock: options?.hooks?.clock }
    );
    await logStreamUsage({ statusCode: 503, result: 'error', errorCode: 'provider_unavailable' });
    return NextResponse.json(
      {
        error: {
          message: 'Provider is unreachable.',
          type: 'provider_error',
          param: null,
          code: 'provider_unavailable',
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

  if (!resolution.success) {
    clearTimeout(timer);
    leaseCtrl.stop();
    await finalizeAdmissionDecision(
      db,
      {
        projectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
        attemptId: admission.attemptId,
        finalStatus: 'failed',
        originalHttpStatus: resolution.statusCode,
        originalErrorCode: resolution.errorCode,
      },
      { clock: options?.hooks?.clock }
    );
    await logStreamUsage({ statusCode: resolution.statusCode, result: 'error', errorCode: resolution.errorCode });
    return NextResponse.json(
      {
        error: {
          message: resolution.message,
          type: 'provider_error',
          param: null,
          code: resolution.errorCode,
        },
      },
      {
        status: resolution.statusCode,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 7. Fast abort check before upstream call
  if (combinedSignal.aborted) {
    clearTimeout(timer);
    leaseCtrl.stop();
    let statusCode = 499;
    let errorCode = 'client_closed_request';
    let message = 'Request was aborted';
    let errorType = 'requests';
    let finalStatus: 'failed' | 'cancelled' = 'cancelled';

    if (isTimedOut || timeoutController.signal.aborted) {
      statusCode = 504;
      errorCode = 'gateway_timeout';
      message = 'Gateway timed out waiting for provider.';
      errorType = 'server_error';
      finalStatus = 'failed';
    } else if (leaseCtrl.signal.aborted || leaseCtrl.isExpired()) {
      statusCode = 503;
      errorCode = 'limiter_unavailable';
      message = 'Service Unavailable: Concurrency lease lost or expired.';
      errorType = 'requests';
      finalStatus = 'failed';
    }

    await finalizeAdmissionDecision(
      db,
      {
        projectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
        attemptId: admission.attemptId,
        finalStatus,
        originalHttpStatus: statusCode,
        originalErrorCode: errorCode,
      },
      { clock: options?.hooks?.clock }
    );
    await logStreamUsage({ statusCode, result: finalStatus === 'cancelled' ? 'cancelled' : statusCode === 504 ? 'timeout' : 'error', errorCode });
    return NextResponse.json(
      {
        error: {
          message,
          type: errorType,
          param: null,
          code: errorCode,
        },
      },
      {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 8. Start Upstream Adapter Stream Generator
  const adapter = getProviderAdapter(resolution.credential.provider);
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const adapterReq = {
    model: modelAlias,
    messages: validatedRequest.messages,
    temperature: validatedRequest.temperature,
    max_tokens: validatedRequest.max_tokens,
    stream: true,
  };

  const adapterCtx = {
    secret: resolution.secret,
    upstreamModel: resolution.upstreamModel,
    signal: combinedSignal,
    id: responseId,
    created,
  };

  let streamGen: AsyncGenerator<StreamEvent, void, unknown>;
  try {
    streamGen = adapter.executeStream(adapterReq, adapterCtx);
  } catch (err: unknown) {
    clearTimeout(timer);
    leaseCtrl.stop();
    const statusCode = err instanceof AdapterError ? err.statusCode : 502;
    const errorCode = err instanceof AdapterError ? err.code : 'provider_error';
    const message = err instanceof AdapterError ? err.message : 'Provider failed to process request.';
    const errorType = err instanceof AdapterError ? err.errorType : 'provider_error';
    const param = err instanceof AdapterError ? err.param : null;

    await finalizeAdmissionDecision(
      db,
      {
        projectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
        attemptId: admission.attemptId,
        finalStatus: 'failed',
        originalHttpStatus: statusCode,
        originalErrorCode: errorCode,
      },
      { clock: options?.hooks?.clock }
    );
    await logStreamUsage({ statusCode, result: 'error', errorCode });

    return NextResponse.json(
      {
        error: {
          message,
          type: errorType,
          param,
          code: errorCode,
        },
      },
      {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  const iterator = streamGen[Symbol.asyncIterator]();

  // 9. DELAYED HEADERS PHASE:
  // Pull from iterator until the first text chunk is available.
  // If an error, timeout, or empty response occurs BEFORE the first text chunk,
  // DO NOT OPEN SSE; return HTTP error JSON directly.
  const bufferedChunks: ChatCompletionChunk[] = [];
  let earlyError: any = null;
  let hasFirstContentChunk = false;

  try {
    while (!hasFirstContentChunk) {
      if (combinedSignal.aborted) {
        throw new Error('Aborted');
      }

      const next = await iterator.next();
      if (next.done) {
        break;
      }

      const event: StreamEvent = next.value;
      if (event.type === 'chunk') {
        bufferedChunks.push(event.chunk);
        const deltaContent = event.chunk.choices[0]?.delta?.content;
        if (typeof deltaContent === 'string' && deltaContent.length > 0) {
          hasFirstContentChunk = true;
        }
      } else if (event.type === 'error') {
        earlyError = event.error;
        break;
      }
    }
  } catch (err: unknown) {
    earlyError = err;
  }

  // Handle failure BEFORE headers sent
  if (earlyError || !hasFirstContentChunk) {
    clearTimeout(timer);
    leaseCtrl.stop();
    try {
      await iterator.return?.();
    } catch {}

    let statusCode = 502;
    let errorCode = 'provider_error';
    let message = 'Provider failed to process request.';
    let errorType = 'provider_error';
    let param: string | null = null;
    let finalStatus: 'failed' | 'cancelled' = 'failed';

    if (isTimedOut || timeoutController.signal.aborted) {
      statusCode = 504;
      errorCode = 'gateway_timeout';
      message = 'Gateway timed out waiting for provider.';
      errorType = 'server_error';
    } else if (request.signal?.aborted) {
      statusCode = 499;
      errorCode = 'client_closed_request';
      message = 'Request was aborted';
      errorType = 'requests';
      finalStatus = 'cancelled';
    } else if (leaseCtrl.signal.aborted || leaseCtrl.isExpired()) {
      statusCode = 503;
      errorCode = 'limiter_unavailable';
      message = 'Service Unavailable: Concurrency lease lost or expired.';
      errorType = 'requests';
    } else if (earlyError instanceof AdapterError) {
      statusCode = earlyError.statusCode;
      errorCode = earlyError.code;
      message = earlyError.message;
      errorType = earlyError.errorType;
      param = earlyError.param;
    } else if (earlyError instanceof GatewayError) {
      statusCode = earlyError.httpStatus;
      errorCode = String(earlyError.code);
      message = earlyError.message;
      errorType = earlyError.type;
      param = earlyError.param;
    } else if (!hasFirstContentChunk && !earlyError) {
      statusCode = 502;
      errorCode = 'provider_empty_response';
      message = 'Provider returned empty response.';
      errorType = 'provider_error';
    }

    await finalizeAdmissionDecision(
      db,
      {
        projectId,
        decisionId: admission.decisionId,
        leaseId: admission.leaseId,
        attemptId: admission.attemptId,
        finalStatus,
        originalHttpStatus: statusCode,
        originalErrorCode: errorCode,
      },
      { clock: options?.hooks?.clock }
    );
    await logStreamUsage({
      statusCode,
      result: finalStatus === 'cancelled' ? 'cancelled' : statusCode === 504 ? 'timeout' : 'error',
      errorCode,
    });

    return NextResponse.json(
      {
        error: {
          message,
          type: errorType,
          param,
          code: errorCode,
        },
      },
      {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'x-request-id': idempotencyKey,
        },
      }
    );
  }

  // 10. STREAM OPENED PHASE (HTTP 200 text/event-stream):
  // Headers are opened now that first text content is verified!
  const encoder = new TextEncoder();
  let isStreamTerminated = false;
  let isTerminalCommitted = false;

  const readableStream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (text: string) => {
        if (isStreamTerminated) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          isStreamTerminated = true;
        }
      };

      const emitChunk = (chunk: ChatCompletionChunk) => {
        safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      const emitError = (errObj: {
        message: string;
        type: string;
        param: string | null;
        code: string;
      }) => {
        safeEnqueue(`data: ${JSON.stringify({ error: errObj })}\n\n`);
      };

      const emitDone = () => {
        safeEnqueue('data: [DONE]\n\n');
      };

      // Emit initial buffered chunks (role chunk and first content chunk)
      if (bufferedChunks.length > 0) {
        const initialText = bufferedChunks
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join('');
        safeEnqueue(initialText);
      }

      // Continue reading downstream chunks from the generator
      try {
        while (!isStreamTerminated) {
          if (combinedSignal.aborted) {
            throw new Error('Aborted');
          }

          const next = await iterator.next();
          if (next.done) {
            break;
          }

          const event: StreamEvent = next.value;

          if (event.type === 'chunk') {
            const hasFinishReason =
              event.chunk.choices[0]?.finish_reason !== null &&
              event.chunk.choices[0]?.finish_reason !== undefined;

            if (hasFinishReason) {
              // FINAL SUCCESS CHUNK:
              // MUST commit terminal succeeded BEFORE emitting final chunk or [DONE]!
              clearTimeout(timer);
              leaseCtrl.stop();

              if (options?.hooks?.onBeforeFinalChunkCommit) {
                await options.hooks.onBeforeFinalChunkCommit();
              }

              const finalizeRes = await finalizeAdmissionDecision(
                db,
                {
                  projectId,
                  decisionId: admission.decisionId,
                  leaseId: admission.leaseId,
                  attemptId: admission.attemptId,
                  finalStatus: 'succeeded',
                  originalHttpStatus: 200,
                  originalErrorCode: null,
                },
                { clock: options?.hooks?.clock }
              );

              isTerminalCommitted = true;

              if (options?.hooks?.onAfterFinalChunkCommit) {
                await options.hooks.onAfterFinalChunkCommit();
              }

              // Only emit final chunk and [DONE] if terminal commit confirmed!
              if (finalizeRes.success) {
                const usage = event.chunk.usage;
                const inputTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
                const outputTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
                const totalTokens = typeof usage?.total_tokens === 'number' ? usage.total_tokens : null;
                await logStreamUsage({ statusCode: 200, result: 'success', inputTokens, outputTokens, totalTokens });
                emitChunk(event.chunk);
                emitDone();
              }

              isStreamTerminated = true;
              try {
                controller.close();
              } catch {}
              return;
            } else {
              emitChunk(event.chunk);
            }
          } else if (event.type === 'error') {
            // Error occurred after stream began
            clearTimeout(timer);
            leaseCtrl.stop();

            if (request.signal?.aborted) {
              await finalizeAdmissionDecision(
                db,
                {
                  projectId,
                  decisionId: admission.decisionId,
                  leaseId: admission.leaseId,
                  attemptId: admission.attemptId,
                  finalStatus: 'cancelled',
                  originalHttpStatus: 499,
                  originalErrorCode: 'client_closed_request',
                },
                { clock: options?.hooks?.clock }
              ).catch(() => {});
              await logStreamUsage({ statusCode: 200, result: 'cancelled', errorCode: 'client_closed_request' });
              isTerminalCommitted = true;
              isStreamTerminated = true;
              try {
                controller.close();
              } catch {}
              return;
            } else if (isTimedOut || timeoutController.signal.aborted) {
              if (options?.hooks?.onBeforeErrorCommit) {
                await options.hooks.onBeforeErrorCommit();
              }
              const finalizeRes = await finalizeAdmissionDecision(
                db,
                {
                  projectId,
                  decisionId: admission.decisionId,
                  leaseId: admission.leaseId,
                  attemptId: admission.attemptId,
                  finalStatus: 'failed',
                  originalHttpStatus: 504,
                  originalErrorCode: 'gateway_timeout',
                  },
                  { clock: options?.hooks?.clock }
                ).catch((e) => {
                console.warn('[StreamHandler] Failed to finalize decision on timeout error event:', e);
                return { success: false, reason: 'error' } as const;
              });
              if (!finalizeRes.success) {
                console.warn('[StreamHandler] Admission finalization was not successful on timeout error event:', finalizeRes);
              }
              await logStreamUsage({ statusCode: 200, result: 'timeout', errorCode: 'gateway_timeout' });
              isTerminalCommitted = true;
              emitError({
                message: 'Gateway timed out waiting for provider.',
                type: 'server_error',
                param: null,
                code: 'gateway_timeout',
              });
              emitDone();
              isStreamTerminated = true;
              try {
                controller.close();
              } catch {}
              return;
            }

            const errCode = event.error.code || 'provider_error';
            const errMsg = event.error.message || 'Provider failed to process request.';
            const errType = event.error.errorType || 'provider_error';
            const errParam = event.error.param || null;
            const httpStatus = event.error.statusCode || 502;

            if (options?.hooks?.onBeforeErrorCommit) {
              await options.hooks.onBeforeErrorCommit();
            }

            const finalizeRes = await finalizeAdmissionDecision(
              db,
              {
                projectId,
                decisionId: admission.decisionId,
                leaseId: admission.leaseId,
                attemptId: admission.attemptId,
                finalStatus: 'failed',
                originalHttpStatus: httpStatus,
                originalErrorCode: errCode,
                },
                { clock: options?.hooks?.clock }
              ).catch((e) => {
              console.warn('[StreamHandler] Failed to finalize decision on error event:', e);
              return { success: false, reason: 'error' } as const;
            });
            if (!finalizeRes.success) {
              console.warn('[StreamHandler] Admission finalization was not successful on error event:', finalizeRes);
            }
            await logStreamUsage({ statusCode: 200, result: 'error', errorCode: errCode });

            isTerminalCommitted = true;
            emitError({
              message: errMsg,
              type: errType,
              param: errParam,
              code: errCode,
            });
            emitDone();
            isStreamTerminated = true;
            try {
              controller.close();
            } catch {}
            return;
          } else if (event.type === 'done') {
            if (!isTerminalCommitted) {
              clearTimeout(timer);
              leaseCtrl.stop();
              const finalizeRes = await finalizeAdmissionDecision(
                db,
                {
                  projectId,
                  decisionId: admission.decisionId,
                  leaseId: admission.leaseId,
                  attemptId: admission.attemptId,
                  finalStatus: 'succeeded',
                  originalHttpStatus: 200,
                },
                { clock: options?.hooks?.clock }
              );
              isTerminalCommitted = true;
              if (finalizeRes.success) {
                emitDone();
              }
            }
            isStreamTerminated = true;
            try {
              controller.close();
            } catch {}
            return;
          }
        }
      } catch (err: unknown) {
        if (isTerminalCommitted || isStreamTerminated) {
          // Late output discarded
          return;
        }

        clearTimeout(timer);
        leaseCtrl.stop();

        let statusCode = 502;
        let errorCode = 'provider_error';
        let message = 'Provider failed to process request.';
        let errorType = 'provider_error';
        let param: string | null = null;
        let finalStatus: 'failed' | 'cancelled' = 'failed';

        if (isTimedOut || timeoutController.signal.aborted) {
          statusCode = 504;
          errorCode = 'gateway_timeout';
          message = 'Gateway timed out waiting for provider.';
          errorType = 'server_error';
        } else if (request.signal?.aborted) {
          statusCode = 499;
          errorCode = 'client_closed_request';
          message = 'Request was aborted';
          errorType = 'requests';
          finalStatus = 'cancelled';
        } else if (leaseCtrl.signal.aborted || leaseCtrl.isExpired()) {
          statusCode = 503;
          errorCode = 'limiter_unavailable';
          message = 'Service Unavailable: Concurrency lease lost or expired.';
          errorType = 'requests';
        } else if (err instanceof AdapterError) {
          statusCode = err.statusCode;
          errorCode = err.code;
          message = err.message;
          errorType = err.errorType;
          param = err.param;
        }

        if (options?.hooks?.onBeforeErrorCommit) {
          await options.hooks.onBeforeErrorCommit();
        }

        const finalizeRes = await finalizeAdmissionDecision(
          db,
          {
            projectId,
            decisionId: admission.decisionId,
            leaseId: admission.leaseId,
            attemptId: admission.attemptId,
            finalStatus,
            originalHttpStatus: statusCode,
            originalErrorCode: errorCode,
          },
          { clock: options?.hooks?.clock }
        ).catch((e) => {
          console.warn('[StreamHandler] Failed to finalize decision on catch block:', e);
          return { success: false, reason: 'error' } as const;
        });
        if (!finalizeRes.success) {
          console.warn('[StreamHandler] Admission finalization was not successful on catch block:', finalizeRes);
        }

        await logStreamUsage({
          statusCode,
          result: finalStatus === 'cancelled' ? 'cancelled' : statusCode === 504 ? 'timeout' : 'error',
          errorCode,
        });

        isTerminalCommitted = true;

        // On client abort, do NOT send extra error or [DONE] chunks
        if (!request.signal?.aborted) {
          emitError({
            message,
            type: errorType,
            param,
            code: errorCode,
          });
          emitDone();
        }
        isStreamTerminated = true;

        try {
          controller.close();
        } catch {}
      } finally {
        clearTimeout(timer);
        leaseCtrl.stop();
        try {
          await iterator.return?.();
        } catch {
          // Ignore iterator return errors
        }
      }
    },

    async cancel() {
      if (isStreamTerminated || isTerminalCommitted) return;
      isStreamTerminated = true;
      clearTimeout(timer);
      leaseCtrl.stop();
      timeoutController.abort();

      try {
        await iterator.return?.();
      } catch {}

      const finalizeRes = await finalizeAdmissionDecision(
        db,
        {
          projectId,
          decisionId: admission.decisionId,
          leaseId: admission.leaseId,
          attemptId: admission.attemptId,
          finalStatus: 'cancelled',
          originalHttpStatus: 499,
          originalErrorCode: 'client_closed_request',
        },
        { clock: options?.hooks?.clock }
      ).catch((e) => {
        console.warn('[StreamHandler] Failed to finalize decision on cancel:', e);
        return { success: false, reason: 'error' } as const;
      });
      if (!finalizeRes.success) {
        console.warn('[StreamHandler] Admission finalization was not successful on cancel:', finalizeRes);
      }
      await logStreamUsage({
        statusCode: 499,
        result: 'cancelled',
        errorCode: 'client_closed_request',
      });
      isTerminalCommitted = true;
    },
  });

  return new Response(readableStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'x-request-id': idempotencyKey,
    },
  });
}
