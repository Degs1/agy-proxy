import {
  AdapterRequest,
  AdapterContext,
  AdapterChatMessage,
  ProviderAdapter,
  ChatCompletionResponse,
  ChatCompletionChunk,
  StreamEvent,
  UsageMetadata,
  AdapterError,
  ProviderError,
  ProviderOutputBlockedError,
  ProviderEmptyResponseError,
  ProviderUnavailableError,
} from './types';

export interface GeminiPart {
  text?: string;
  inlineData?: Record<string, unknown>;
  functionCall?: Record<string, unknown>;
  functionResponse?: Record<string, unknown>;
  fileData?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiSystemInstruction {
  parts: Array<{ text: string }>;
}

export interface GeminiGenerationConfig {
  candidateCount?: number;
  temperature?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;
}

export interface GeminiPayload {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  generationConfig?: GeminiGenerationConfig;
}

export interface GeminiCandidate {
  index?: number;
  content?: {
    role?: string;
    parts?: GeminiPart[];
  };
  finishReason?: string;
  safetyRatings?: Array<{
    category?: string;
    probability?: string;
    blocked?: boolean;
  }>;
  [key: string]: unknown;
}

export interface GeminiPromptFeedback {
  blockReason?: string;
  safetyRatings?: Array<{
    category?: string;
    probability?: string;
    blocked?: boolean;
  }>;
  [key: string]: unknown;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: GeminiPromptFeedback;
  usageMetadata?: GeminiUsageMetadata;
  [key: string]: unknown;
}

/**
 * Maps OpenAI messages into Gemini API format:
 * - Consecutive system messages at the start become systemInstruction.parts in original order.
 * - user messages become Gemini role: 'user'.
 * - assistant messages become Gemini role: 'model'.
 * - Preserves order and text content strictly.
 */
export function mapOpenAIMessagesToGemini(messages: AdapterChatMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
} {
  const systemParts: Array<{ text: string }> = [];
  const contents: GeminiContent[] = [];

  let isLeadingSystem = true;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system' && isLeadingSystem) {
      systemParts.push({ text: msg.content });
      continue;
    }

    isLeadingSystem = false;

    if (msg.role === 'system') {
      throw new AdapterError(
        'System message cannot appear after conversation has started.',
        400,
        'invalid_request'
      );
    }

    const geminiRole: 'user' | 'model' = msg.role === 'user' ? 'user' : 'model';
    contents.push({
      role: geminiRole,
      parts: [{ text: msg.content }],
    });
  }

  const result: { contents: GeminiContent[]; systemInstruction?: GeminiSystemInstruction } = {
    contents,
  };

  if (systemParts.length > 0) {
    result.systemInstruction = { parts: systemParts };
  }

  return result;
}

/**
 * Maps generation config from request options.
 */
export function mapGenerationConfig(request: AdapterRequest): GeminiGenerationConfig {
  const config: GeminiGenerationConfig = {
    candidateCount: 1,
  };

  if (request.temperature !== undefined) {
    config.temperature = request.temperature;
  }

  if (request.max_tokens !== undefined) {
    config.maxOutputTokens = request.max_tokens;
  }

  return config;
}

const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/**
 * Normalizes a completed Gemini response into the OpenAI ChatCompletion format.
 */
export function normalizeGeminiNonStreamResponse(
  geminiRes: GeminiResponse,
  request: AdapterRequest,
  context: AdapterContext
): ChatCompletionResponse {
  // 1. Check prompt feedback block
  if (geminiRes.promptFeedback?.blockReason) {
    throw new ProviderOutputBlockedError('Provider output blocked due to safety or policy.');
  }

  // 2. Check candidates existence
  const candidates = geminiRes.candidates;
  if (!candidates || candidates.length === 0) {
    throw new ProviderEmptyResponseError('Provider returned empty response.');
  }

  // Multi-candidate rule: only index 0 is used, candidate 1+ ignored
  const candidate0 = candidates[0];

  // Check candidate block / finishReason
  if (candidate0.finishReason && BLOCKED_FINISH_REASONS.has(candidate0.finishReason)) {
    throw new ProviderOutputBlockedError('Provider output blocked due to safety or policy.');
  }

  // 3. Inspect parts
  const parts = candidate0.content?.parts || [];
  if (parts.length === 0) {
    throw new ProviderEmptyResponseError('Provider returned empty response.');
  }

  const textParts: string[] = [];
  let nonTextPartsCount = 0;

  for (const part of parts) {
    if (typeof part.text === 'string') {
      textParts.push(part.text);
    } else {
      nonTextPartsCount++;
    }
  }

  if (textParts.length === 0) {
    if (nonTextPartsCount > 0) {
      throw new ProviderError('Provider returned unhandled non-text output.');
    }
    throw new ProviderEmptyResponseError('Provider returned empty response.');
  }

  const combinedText = textParts.join('');
  if (combinedText.length === 0) {
    throw new ProviderEmptyResponseError('Provider returned empty response.');
  }

  // 4. Map finishReason
  let mappedFinishReason: 'stop' | 'length';
  if (candidate0.finishReason === 'STOP') {
    mappedFinishReason = 'stop';
  } else if (candidate0.finishReason === 'MAX_TOKENS') {
    mappedFinishReason = 'length';
  } else {
    throw new ProviderError('Provider error occurred.');
  }

  // 5. Map usage
  let usage: UsageMetadata | null = null;
  if (geminiRes.usageMetadata) {
    const promptCount = geminiRes.usageMetadata.promptTokenCount;
    const candidatesCount = geminiRes.usageMetadata.candidatesTokenCount;
    const totalCount = geminiRes.usageMetadata.totalTokenCount;

    if (typeof promptCount === 'number' || typeof candidatesCount === 'number') {
      const p = typeof promptCount === 'number' ? promptCount : 0;
      const c = typeof candidatesCount === 'number' ? candidatesCount : 0;
      const t = typeof totalCount === 'number' ? totalCount : p + c;
      usage = {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: t,
      };
    }
  }

  const id = context.id || `chatcmpl-${crypto.randomUUID()}`;
  const created = context.created || Math.floor(Date.now() / 1000);

  return {
    id,
    object: 'chat.completion',
    created,
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: combinedText,
        },
        finish_reason: mappedFinishReason,
      },
    ],
    usage,
  };
}

/**
 * Builds the official Gemini endpoint URL.
 */
export function buildGeminiUrl(upstreamModel: string, stream = false): string {
  const modelPath = upstreamModel.startsWith('models/') ? upstreamModel : `models/${upstreamModel}`;
  const action = stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
  return `https://generativelanguage.googleapis.com/v1beta/${modelPath}${action}`;
}

/**
 * Gemini Official Provider Adapter.
 */
export class GeminiAdapter implements ProviderAdapter {
  public readonly providerType = 'gemini';

  async executeNonStream(
    request: AdapterRequest,
    context: AdapterContext
  ): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = mapOpenAIMessagesToGemini(request.messages);
    const generationConfig = mapGenerationConfig(request);

    const payload: GeminiPayload = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig,
    };

    const url = buildGeminiUrl(context.upstreamModel, false);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': context.secret,
        },
        body: JSON.stringify(payload),
        signal: context.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      // Zero secret leak on network failure
      throw new ProviderUnavailableError('Provider is unreachable.');
    }

    if (!res.ok) {
      // Upstream failed with non-200. Zero secret leak.
      throw new ProviderError('Provider failed to process request.');
    }

    let json: GeminiResponse;
    try {
      json = (await res.json()) as GeminiResponse;
    } catch {
      throw new ProviderError('Provider failed to process request.');
    }

    return normalizeGeminiNonStreamResponse(json, request, context);
  }

  async *executeStream(
    request: AdapterRequest,
    context: AdapterContext
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const { contents, systemInstruction } = mapOpenAIMessagesToGemini(request.messages);
    const generationConfig = mapGenerationConfig(request);

    const payload: GeminiPayload = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig,
    };

    const url = buildGeminiUrl(context.upstreamModel, true);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-goog-api-key': context.secret,
        },
        body: JSON.stringify(payload),
        signal: context.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new ProviderUnavailableError('Provider is unreachable.');
    }

    if (!res.ok) {
      throw new ProviderError('Provider failed to process request.');
    }

    if (!res.body) {
      throw new ProviderUnavailableError('Provider is unreachable.');
    }

    const responseId = context.id || `chatcmpl-${crypto.randomUUID()}`;
    const created = context.created || Math.floor(Date.now() / 1000);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const onAbort = () => {
      try {
        reader.cancel().catch(() => {});
      } catch {}
    };

    if (context.signal) {
      if (context.signal.aborted) {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      context.signal.addEventListener('abort', onAbort, { once: true });
    }

    let buffer = '';
    let textEmitted = false;
    let finishReasonReceived: string | null = null;
    let hasConflictingFinishReasons = false;
    let onlyNonTextParts = false;
    let anyCandidatesSeen = false;
    let totalTextLength = 0;
    let isBlocked = false;
    let usageMetadata: UsageMetadata | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          let data: GeminiResponse;
          try {
            data = JSON.parse(jsonStr) as GeminiResponse;
          } catch {
            continue;
          }

          // Accumulate usage
          if (data.usageMetadata) {
            const promptCount = data.usageMetadata.promptTokenCount;
            const candidatesCount = data.usageMetadata.candidatesTokenCount;
            const totalCount = data.usageMetadata.totalTokenCount;
            if (typeof promptCount === 'number' || typeof candidatesCount === 'number') {
              const p = typeof promptCount === 'number' ? promptCount : 0;
              const c = typeof candidatesCount === 'number' ? candidatesCount : 0;
              const t = typeof totalCount === 'number' ? totalCount : p + c;
              usageMetadata = { prompt_tokens: p, completion_tokens: c, total_tokens: t };
            }
          }

          // Check prompt block
          if (data.promptFeedback?.blockReason) {
            isBlocked = true;
          }

          const candidates = data.candidates;
          if (candidates && candidates.length > 0) {
            anyCandidatesSeen = true;
            const c0 = candidates[0];

            if (c0.finishReason) {
              if (BLOCKED_FINISH_REASONS.has(c0.finishReason)) {
                isBlocked = true;
              } else if (finishReasonReceived && finishReasonReceived !== c0.finishReason) {
                hasConflictingFinishReasons = true;
              } else {
                finishReasonReceived = c0.finishReason;
              }
            }

            const parts = c0.content?.parts || [];
            let chunkText = '';
            let hasNonText = false;

            for (const part of parts) {
              if (typeof part.text === 'string') {
                chunkText += part.text;
              } else {
                hasNonText = true;
              }
            }

            if (parts.length > 0 && chunkText.length === 0 && hasNonText) {
              if (totalTextLength === 0) {
                onlyNonTextParts = true;
              }
            }

            if (chunkText.length > 0 && !isBlocked) {
              onlyNonTextParts = false;
              totalTextLength += chunkText.length;

              if (!textEmitted) {
                // Emit initial role chunk right before first text
                const roleChunk: ChatCompletionChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model: request.model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: 'assistant' },
                      finish_reason: null,
                    },
                  ],
                };
                yield { type: 'chunk', chunk: roleChunk };
                textEmitted = true;
              }

              const textChunk: ChatCompletionChunk = {
                id: responseId,
                object: 'chat.completion.chunk',
                created,
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: chunkText },
                    finish_reason: null,
                  },
                ],
              };
              yield { type: 'chunk', chunk: textChunk };
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      if (!textEmitted) {
        throw new ProviderUnavailableError('Provider is unreachable.');
      } else {
        yield { type: 'error', error: new ProviderUnavailableError('Provider is unreachable.') };
        yield { type: 'done' };
        return;
      }
    } finally {
      if (context.signal) {
        context.signal.removeEventListener('abort', onAbort);
      }
      try {
        reader.releaseLock();
      } catch {}
    }

    // Evaluate accumulated state at stream end
    if (isBlocked) {
      const err = new ProviderOutputBlockedError('Provider output blocked due to safety or policy.');
      if (!textEmitted) throw err;
      yield { type: 'error', error: err };
      yield { type: 'done' };
      return;
    }

    if (!anyCandidatesSeen || totalTextLength === 0) {
      if (onlyNonTextParts) {
        const err = new ProviderError('Provider returned unhandled non-text output.');
        if (!textEmitted) throw err;
        yield { type: 'error', error: err };
        yield { type: 'done' };
        return;
      }
      const err = new ProviderEmptyResponseError('Provider returned empty response.');
      if (!textEmitted) throw err;
      yield { type: 'error', error: err };
      yield { type: 'done' };
      return;
    }

    if (hasConflictingFinishReasons) {
      const err = new ProviderError('Provider error occurred.');
      if (!textEmitted) throw err;
      yield { type: 'error', error: err };
      yield { type: 'done' };
      return;
    }

    let mappedFinishReason: 'stop' | 'length';
    if (finishReasonReceived === 'STOP') {
      mappedFinishReason = 'stop';
    } else if (finishReasonReceived === 'MAX_TOKENS') {
      mappedFinishReason = 'length';
    } else {
      const err = new ProviderError('Provider error occurred.');
      if (!textEmitted) throw err;
      yield { type: 'error', error: err };
      yield { type: 'done' };
      return;
    }

    // Success final chunk
    const finalChunk: ChatCompletionChunk = {
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: mappedFinishReason,
        },
      ],
      ...(usageMetadata ? { usage: usageMetadata } : {}),
    };

    yield { type: 'chunk', chunk: finalChunk };
    yield { type: 'done' };
  }
}

export const geminiAdapter = new GeminiAdapter();
