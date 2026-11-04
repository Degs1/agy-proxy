import crypto from 'crypto';
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
import {
  ANTIGRAVITY_ENDPOINTS,
  ANTIGRAVITY_USER_AGENT,
} from '@/lib/antigravity/constants';
import { AntigravityTokenPayload } from '@/lib/antigravity/types';

export interface AntigravityPart {
  text?: string;
  [key: string]: unknown;
}

export interface AntigravityContent {
  role: 'user' | 'model';
  parts: AntigravityPart[];
}

export interface AntigravitySystemInstruction {
  parts: Array<{ text: string }>;
}

export interface AntigravityGenerationConfig {
  candidateCount?: number;
  temperature?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;
}

export interface AntigravityCandidate {
  index?: number;
  content?: {
    role?: string;
    parts?: AntigravityPart[];
  };
  finishReason?: string;
  safetyRatings?: Array<{
    category?: string;
    probability?: string;
    blocked?: boolean;
  }>;
  [key: string]: unknown;
}

export interface AntigravityUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface AntigravityResponsePayload {
  response?: {
    candidates?: AntigravityCandidate[];
    promptFeedback?: {
      blockReason?: string;
    };
    usageMetadata?: AntigravityUsageMetadata;
  };
  candidates?: AntigravityCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
  usageMetadata?: AntigravityUsageMetadata;
  [key: string]: unknown;
}

const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/**
 * Maps OpenAI messages into Antigravity internal format:
 * - Consecutive leading system messages become systemInstruction.
 * - user messages become role: 'user'.
 * - assistant messages become role: 'model'.
 */
export function mapOpenAIMessagesToAntigravity(messages: AdapterChatMessage[]): {
  contents: AntigravityContent[];
  systemInstruction?: AntigravitySystemInstruction;
} {
  const systemParts: Array<{ text: string }> = [];
  const contents: AntigravityContent[] = [];

  let isLeadingSystem = true;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'system') {
      if (isLeadingSystem) {
        systemParts.push({ text: msg.content });
      } else {
        throw new AdapterError(
          'System message cannot appear after user or assistant messages in Antigravity provider.',
          400,
          'invalid_request'
        );
      }
    } else if (msg.role === 'user') {
      isLeadingSystem = false;
      contents.push({
        role: 'user',
        parts: [{ text: msg.content }],
      });
    } else if (msg.role === 'assistant') {
      isLeadingSystem = false;
      contents.push({
        role: 'model',
        parts: [{ text: msg.content }],
      });
    }
  }

  return {
    contents,
    ...(systemParts.length > 0
      ? { systemInstruction: { parts: systemParts } }
      : {}),
  };
}

export class AntigravityAdapter implements ProviderAdapter {
  readonly providerType = 'antigravity';

  private parseTokenPayload(secret: string): AntigravityTokenPayload {
    try {
      const parsed = JSON.parse(secret);
      if (typeof parsed === 'object' && parsed !== null && parsed.access_token) {
        return parsed as AntigravityTokenPayload;
      }
    } catch {
      // Fallback if secret was raw access token
    }
    return {
      access_token: secret,
      refresh_token: '',
      expiry_date: 0,
      token_type: 'Bearer',
    };
  }

  async executeNonStream(
    request: AdapterRequest,
    context: AdapterContext
  ): Promise<ChatCompletionResponse> {
    const responseId = context.id || `chatcmpl-${crypto.randomUUID()}`;
    const created = context.created || Math.floor(Date.now() / 1000);

    const stream = this.executeStream(request, context);
    let fullText = '';
    let lastFinishReason: 'stop' | 'length' = 'stop';
    let finalUsage: UsageMetadata | null = null;

    for await (const event of stream) {
      if (event.type === 'chunk') {
        const choice = event.chunk.choices[0];
        if (choice?.delta?.content) {
          fullText += choice.delta.content;
        }
        if (choice?.finish_reason) {
          lastFinishReason = choice.finish_reason;
        }
        if (event.chunk.usage) {
          finalUsage = event.chunk.usage;
        }
      }
    }

    if (!fullText) {
      throw new ProviderEmptyResponseError('Antigravity provider returned empty response.');
    }

    return {
      id: responseId,
      object: 'chat.completion',
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: fullText,
          },
          finish_reason: lastFinishReason,
        },
      ],
      usage: finalUsage,
    };
  }

  async *executeStream(
    request: AdapterRequest,
    context: AdapterContext
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const { contents, systemInstruction } = mapOpenAIMessagesToAntigravity(request.messages);

    const generationConfig: AntigravityGenerationConfig = {
      candidateCount: 1,
    };
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.max_tokens !== undefined) {
      generationConfig.maxOutputTokens = request.max_tokens;
    }

    let tokenPayload = this.parseTokenPayload(context.secret);
    const sessionId = `ses_${crypto.randomUUID()}`;

    const makePayload = () => ({
      project: tokenPayload.project_id || 'default',
      model: context.upstreamModel,
      request: {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig,
        sessionId,
      },
      userAgent: 'antigravity',
      requestType: 'agent',
      requestId: `antigravity-${crypto.randomUUID()}`,
    });

    let res: Response | null = null;
    let didRetryAuth = false;

    // Retry loop for 401 reactive refresh
    while (!res) {
      let fetchError: Error | null = null;
      let shouldRetryWithFreshToken = false;

      for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
        const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              Authorization: `Bearer ${tokenPayload.access_token}`,
              'User-Agent': ANTIGRAVITY_USER_AGENT,
            },
            body: JSON.stringify(makePayload()),
            signal: context.signal,
          });

          if (res.status === 401 && !didRetryAuth && context.onRefreshToken) {
            shouldRetryWithFreshToken = true;
            res = null;
            break;
          }

          if (res.ok) {
            break;
          }

          // If endpoint gave 404 or connection error, try fallback endpoint
          if (res.status === 404 || res.status >= 500) {
            continue;
          }

          // Non-retryable error
          break;
        } catch (err: unknown) {
          if (
            context.signal?.aborted ||
            (err instanceof Error && (err.name === 'AbortError' || err.message === 'Aborted'))
          ) {
            throw err;
          }
          fetchError = err instanceof Error ? err : new Error(String(err));
        }
      }

      if (shouldRetryWithFreshToken) {
        didRetryAuth = true;
        try {
          const newSecret = await context.onRefreshToken!();
          tokenPayload = this.parseTokenPayload(newSecret);
          continue; // retry while loop with the updated token!
        } catch {
          throw new ProviderError('Antigravity authentication refresh failed.', 'unauthorized');
        }
      }

      if (!res) {
        throw new ProviderUnavailableError('Antigravity provider is unreachable.');
      }
    }

    if (!res.ok) {
      if (res.status === 401) {
        throw new AdapterError(
          'Antigravity authentication expired or unauthorized.',
          401,
          'unauthorized',
          'provider_error'
        );
      }
      throw new ProviderError(
        `Antigravity provider returned status ${res.status}`,
        'provider_error'
      );
    }

    if (!res.body) {
      throw new ProviderUnavailableError('Antigravity provider returned empty response body.');
    }

    const responseId = context.id || `chatcmpl-${crypto.randomUUID()}`;
    const created = context.created || Math.floor(Date.now() / 1000);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let hasSentRole = false;
    let usageMetadata: UsageMetadata | null = null;
    let isBlocked = false;

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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          let data: AntigravityResponsePayload;
          try {
            data = JSON.parse(jsonStr) as AntigravityResponsePayload;
          } catch {
            continue;
          }

          // Check block reasons
          const promptBlock =
            data.response?.promptFeedback?.blockReason || data.promptFeedback?.blockReason;
          if (promptBlock) {
            isBlocked = true;
            throw new ProviderOutputBlockedError(
              'Antigravity provider output blocked due to safety or policy.'
            );
          }

          // Extract usage
          const rawUsage = data.response?.usageMetadata || data.usageMetadata;
          if (rawUsage) {
            const p = rawUsage.promptTokenCount ?? 0;
            const c = rawUsage.candidatesTokenCount ?? 0;
            const t = rawUsage.totalTokenCount ?? p + c;
            usageMetadata = { prompt_tokens: p, completion_tokens: c, total_tokens: t };
          }

          // Extract candidates
          const candidates = data.response?.candidates || data.candidates || [];
          if (candidates.length === 0) continue;

          const cand = candidates[0];

          if (cand.finishReason && BLOCKED_FINISH_REASONS.has(cand.finishReason)) {
            isBlocked = true;
            throw new ProviderOutputBlockedError(
              'Antigravity provider output blocked due to safety or policy.'
            );
          }

          const parts = cand.content?.parts || [];
          let textDelta = '';
          for (const part of parts) {
            if (typeof part.text === 'string') {
              textDelta += part.text;
            }
          }

          let mappedFinishReason: 'stop' | 'length' | null = null;
          if (cand.finishReason === 'STOP') {
            mappedFinishReason = 'stop';
          } else if (cand.finishReason === 'MAX_TOKENS') {
            mappedFinishReason = 'length';
          }

          if (textDelta || mappedFinishReason) {
            const chunk: ChatCompletionChunk = {
              id: responseId,
              object: 'chat.completion.chunk',
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    ...(hasSentRole ? {} : { role: 'assistant' }),
                    ...(textDelta ? { content: textDelta } : {}),
                  },
                  finish_reason: mappedFinishReason,
                },
              ],
              ...(usageMetadata ? { usage: usageMetadata } : {}),
            };
            hasSentRole = true;
            yield { type: 'chunk', chunk };
          }
        }
      }

      // Check remaining buffer
      if (buffer.trim().startsWith('data:')) {
        const jsonStr = buffer.trim().slice(5).trim();
        if (jsonStr && jsonStr !== '[DONE]') {
          try {
            const data = JSON.parse(jsonStr) as AntigravityResponsePayload;
            const rawUsage = data.response?.usageMetadata || data.usageMetadata;
            if (rawUsage) {
              const p = rawUsage.promptTokenCount ?? 0;
              const c = rawUsage.candidatesTokenCount ?? 0;
              const t = rawUsage.totalTokenCount ?? p + c;
              usageMetadata = { prompt_tokens: p, completion_tokens: c, total_tokens: t };
            }
          } catch {}
        }
      }

      yield { type: 'done' };
    } finally {
      if (context.signal) {
        context.signal.removeEventListener('abort', onAbort);
      }
    }
  }
}

export const antigravityAdapter = new AntigravityAdapter();
