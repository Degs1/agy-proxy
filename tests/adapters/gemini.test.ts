import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GeminiAdapter,
  geminiAdapter,
  mapOpenAIMessagesToGemini,
  mapGenerationConfig,
  normalizeGeminiNonStreamResponse,
  buildGeminiUrl,
} from '@/lib/adapters/gemini';
import {
  getProviderAdapter,
  AdapterRequest,
  AdapterContext,
  AdapterChatMessage,
  AdapterError,
  ProviderError,
  ProviderOutputBlockedError,
  ProviderEmptyResponseError,
  ProviderUnavailableError,
} from '@/lib/adapters';

describe('Gemini Official Provider Adapter (Requirement 4 & Requirement 5 AC 5)', () => {
  const secretKey = 'test-gemini-secret-api-key-12345';
  const upstreamModel = 'gemini-1.5-flash';
  const requestedModel = 'gemini-default';

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. Message & Config Mapping (Requirement 4, AC 2 & Requirement 5, AC 1)', () => {
    it('maps single leading system message to systemInstruction in original order', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      const { contents, systemInstruction } = mapOpenAIMessagesToGemini(messages);

      expect(systemInstruction).toBeDefined();
      expect(systemInstruction?.parts).toEqual([{ text: 'You are a helpful assistant.' }]);
      expect(contents).toEqual([
        {
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      ]);
    });

    it('maps multiple leading system messages to separate parts in original order', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'system', content: 'System instruction 1' },
        { role: 'system', content: 'System instruction 2' },
        { role: 'user', content: 'Hello' },
      ];

      const { contents, systemInstruction } = mapOpenAIMessagesToGemini(messages);

      expect(systemInstruction?.parts).toHaveLength(2);
      expect(systemInstruction?.parts[0]).toEqual({ text: 'System instruction 1' });
      expect(systemInstruction?.parts[1]).toEqual({ text: 'System instruction 2' });
      expect(contents).toHaveLength(1);
      expect(contents[0].role).toBe('user');
    });

    it('maps alternating user and assistant messages with exact roles and text preserved', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: 'Answer 1' },
        { role: 'user', content: 'Question 2' },
      ];

      const { contents, systemInstruction } = mapOpenAIMessagesToGemini(messages);

      expect(systemInstruction).toBeUndefined();
      expect(contents).toHaveLength(3);
      expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'Question 1' }] });
      expect(contents[1]).toEqual({ role: 'model', parts: [{ text: 'Answer 1' }] });
      expect(contents[2]).toEqual({ role: 'user', parts: [{ text: 'Question 2' }] });
    });

    it('rejects system message appearing after conversation has started', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Illegal system message' },
        { role: 'user', content: 'Continue' },
      ];

      expect(() => mapOpenAIMessagesToGemini(messages)).toThrowError(AdapterError);
      try {
        mapOpenAIMessagesToGemini(messages);
      } catch (err: unknown) {
        const error = err as AdapterError;
        expect(error.statusCode).toBe(400);
        expect(error.code).toBe('invalid_request');
        expect(error.errorType).toBe('invalid_request_error');
      }
    });

    it('rejects request containing only system messages with 400 invalid_request', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'system', content: 'System instruction without conversation' },
      ];

      expect(() => mapOpenAIMessagesToGemini(messages)).toThrowError(AdapterError);
      try {
        mapOpenAIMessagesToGemini(messages);
      } catch (err: unknown) {
        const error = err as AdapterError;
        expect(error.statusCode).toBe(400);
        expect(error.code).toBe('invalid_request');
        expect(error.errorType).toBe('invalid_request_error');
        expect(error.message).toContain('At least one user or assistant message is required');
      }
    });

    it('maps generationConfig with candidateCount=1 and optional temperature and max_tokens', () => {
      const reqWithParams: AdapterRequest = {
        model: requestedModel,
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        max_tokens: 1024,
      };

      const configWithParams = mapGenerationConfig(reqWithParams);
      expect(configWithParams.candidateCount).toBe(1);
      expect(configWithParams.temperature).toBe(0.7);
      expect(configWithParams.maxOutputTokens).toBe(1024);

      const reqWithoutParams: AdapterRequest = {
        model: requestedModel,
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const configWithoutParams = mapGenerationConfig(reqWithoutParams);
      expect(configWithoutParams.candidateCount).toBe(1);
      expect(configWithoutParams.temperature).toBeUndefined();
      expect(configWithoutParams.maxOutputTokens).toBeUndefined();
    });

    it('builds official Gemini URL correctly for nonstream and stream endpoints', () => {
      const nonStreamUrl = buildGeminiUrl('gemini-1.5-flash', false);
      expect(nonStreamUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
      );

      const streamUrl = buildGeminiUrl('gemini-1.5-flash', true);
      expect(streamUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse'
      );

      // Handles models/ prefix cleanly without duplication
      const prefixedUrl = buildGeminiUrl('models/gemini-2.0-flash', false);
      expect(prefixedUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
      );
    });
  });

  describe('2. Candidates & Parts Normalization (Requirement 5, AC 2 & AC 5)', () => {
    const defaultReq: AdapterRequest = {
      model: requestedModel,
      messages: [{ role: 'user', content: 'Hello' }],
    };

    const defaultCtx: AdapterContext = {
      secret: secretKey,
      upstreamModel,
      id: 'chatcmpl-test-123',
      created: 1793664000,
    };

    it('TC-REQ5-RES-01: maps standard STOP response with text and usage metadata', () => {
      const geminiRes = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Halo dunia' }],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      const result = normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);

      expect(result.id).toBe('chatcmpl-test-123');
      expect(result.object).toBe('chat.completion');
      expect(result.created).toBe(1793664000);
      expect(result.model).toBe(requestedModel);
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0]).toEqual({
        index: 0,
        message: {
          role: 'assistant',
          content: 'Halo dunia',
        },
        finish_reason: 'stop',
      });
      expect(result.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
    });

    it('TC-REQ5-RES-02: maps MAX_TOKENS finishReason to length', () => {
      const geminiRes = {
        candidates: [
          {
            content: {
              parts: [{ text: 'This text was cut off' }],
            },
            finishReason: 'MAX_TOKENS',
          },
        ],
      };

      const result = normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      expect(result.choices[0].finish_reason).toBe('length');
      expect(result.choices[0].message.content).toBe('This text was cut off');
    });

    it('TC-REQ5-RES-03: concatenates multiple text parts without extra separator', () => {
      const geminiRes = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Halo ' }, { text: 'dunia!' }],
            },
            finishReason: 'STOP',
          },
        ],
      };

      const result = normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      expect(result.choices[0].message.content).toBe('Halo dunia!');
    });

    it('TC-REQ5-RES-04: multi-candidates: uses only candidate[0], ignores candidate 1+', () => {
      const geminiRes = {
        candidates: [
          {
            content: { parts: [{ text: 'First candidate' }] },
            finishReason: 'STOP',
            index: 0,
          },
          {
            content: { parts: [{ text: 'Second candidate should be ignored' }] },
            finishReason: 'STOP',
            index: 1,
          },
        ],
      };

      const result = normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0].message.content).toBe('First candidate');
    });

    it('TC-REQ5-RES-05: returns usage: null when usageMetadata is missing or unavailable', () => {
      const geminiRes = {
        candidates: [
          {
            content: { parts: [{ text: 'Response without usage' }] },
            finishReason: 'STOP',
          },
        ],
      };

      const result = normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      expect(result.usage).toBeNull();
    });

    it('handles text parts followed by non-text parts (e.g. function call) when finishReason is STOP', () => {
      const geminiRes = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Halo' },
                { functionCall: { name: 'unsupportedFunction', args: {} } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };

      const result = normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      expect(result.choices[0].message.content).toBe('Halo');
    });

    it('TC-REQ5-ERR-03: throws ProviderError when response contains only non-text parts', () => {
      const geminiRes = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      };

      expect(() =>
        normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx)
      ).toThrowError(ProviderError);

      try {
        normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      } catch (err: unknown) {
        const error = err as ProviderError;
        expect(error.statusCode).toBe(502);
        expect(error.code).toBe('provider_error');
        expect(error.message).toBe('Provider returned unhandled non-text output.');
      }
    });

    it('TC-REQ5-ERR-02: throws ProviderEmptyResponseError when candidates array is empty or parts empty', () => {
      // Empty candidates
      expect(() =>
        normalizeGeminiNonStreamResponse({ candidates: [] }, defaultReq, defaultCtx)
      ).toThrowError(ProviderEmptyResponseError);

      // Empty parts
      expect(() =>
        normalizeGeminiNonStreamResponse(
          { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
          defaultReq,
          defaultCtx
        )
      ).toThrowError(ProviderEmptyResponseError);

      // Empty string text
      expect(() =>
        normalizeGeminiNonStreamResponse(
          { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] },
          defaultReq,
          defaultCtx
        )
      ).toThrowError(ProviderEmptyResponseError);
    });

    it('TC-REQ5-ERR-04: throws ProviderError when finishReason is OTHER or unknown', () => {
      const geminiRes = {
        candidates: [
          {
            content: { parts: [{ text: 'Some text' }] },
            finishReason: 'OTHER',
          },
        ],
      };

      expect(() =>
        normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx)
      ).toThrowError(ProviderError);

      try {
        normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      } catch (err: unknown) {
        const error = err as ProviderError;
        expect(error.statusCode).toBe(502);
        expect(error.code).toBe('provider_error');
        expect(error.message).toBe('Provider error occurred.');
      }
    });
  });

  describe('3. Content Blocking & Safety (Requirement 4, AC 3 & Requirement 5, AC 5)', () => {
    const defaultReq: AdapterRequest = {
      model: requestedModel,
      messages: [{ role: 'user', content: 'Blocked prompt' }],
    };

    const defaultCtx: AdapterContext = {
      secret: secretKey,
      upstreamModel,
    };

    it('TC-REQ5-ERR-01: throws ProviderOutputBlockedError when promptFeedback indicates blocked', () => {
      const geminiRes = {
        promptFeedback: {
          blockReason: 'SAFETY',
        },
        candidates: [],
      };

      expect(() =>
        normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx)
      ).toThrowError(ProviderOutputBlockedError);

      try {
        normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx);
      } catch (err: unknown) {
        const error = err as ProviderOutputBlockedError;
        expect(error.statusCode).toBe(502);
        expect(error.code).toBe('provider_output_blocked');
        expect(error.message).toBe('Provider output blocked due to safety or policy.');
      }
    });

    it('TC-REQ5-ERR-01: throws ProviderOutputBlockedError when candidate finishReason is SAFETY or BLOCKLIST', () => {
      const blockedReasons = ['SAFETY', 'BLOCKLIST', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII'];

      for (const reason of blockedReasons) {
        const geminiRes = {
          candidates: [
            {
              content: { parts: [{ text: 'Partial text before block' }] },
              finishReason: reason,
            },
          ],
        };

        expect(() =>
          normalizeGeminiNonStreamResponse(geminiRes, defaultReq, defaultCtx)
        ).toThrowError(ProviderOutputBlockedError);
      }
    });
  });

  describe('4. Upstream Execution & Zero Credential Leakage (Requirement 4, AC 2-3 & Requirement 5, AC 5)', () => {
    const adapter = new GeminiAdapter();
    const req: AdapterRequest = {
      model: requestedModel,
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const ctx: AdapterContext = {
      secret: secretKey,
      upstreamModel,
    };

    it('sends request to official endpoint with x-goog-api-key header and correct payload', async () => {
      let capturedUrl = '';
      let capturedHeaders: HeadersInit | undefined;
      let capturedBody = '';

      globalThis.fetch = vi.fn().mockImplementation(async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers;
        capturedBody = String(init?.body);

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Hello from Gemini!' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 5,
              totalTokenCount: 10,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const response = await adapter.executeNonStream(req, ctx);

      expect(capturedUrl).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
      );
      expect((capturedHeaders as Record<string, string>)['x-goog-api-key']).toBe(secretKey);
      expect((capturedHeaders as Record<string, string>)['Content-Type']).toBe('application/json');

      const parsedBody = JSON.parse(capturedBody);
      expect(parsedBody.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
      expect(parsedBody.generationConfig).toEqual({ candidateCount: 1 });

      expect(response.choices[0].message.content).toBe('Hello from Gemini!');
      expect(response.choices[0].finish_reason).toBe('stop');
    });

    it('TC-REQ5-ERR-05: upstream HTTP 5xx returns 502 provider_error without leaking secret', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 500,
              message: `Internal error mentioning secret ${secretKey} and https://generativelanguage.googleapis.com`,
              status: 'INTERNAL',
            },
          }),
          { status: 500 }
        )
      );

      await expect(adapter.executeNonStream(req, ctx)).rejects.toThrowError(ProviderError);

      try {
        await adapter.executeNonStream(req, ctx);
      } catch (err: unknown) {
        const error = err as ProviderError;
        expect(error.statusCode).toBe(502);
        expect(error.code).toBe('provider_error');
        expect(error.message).toBe('Provider failed to process request.');
        expect(error.message).not.toContain(secretKey);
        expect(error.message).not.toContain('googleapis.com');
      }
    });

    it('TC-REQ5-ERR-07: network failure returns 503 provider_unavailable without leaking secret', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error(`fetch failed to reach endpoint with ${secretKey}`));

      await expect(adapter.executeNonStream(req, ctx)).rejects.toThrowError(ProviderUnavailableError);

      try {
        await adapter.executeNonStream(req, ctx);
      } catch (err: unknown) {
        const error = err as ProviderUnavailableError;
        expect(error.statusCode).toBe(503);
        expect(error.code).toBe('provider_unavailable');
        expect(error.message).toBe('Provider is unreachable.');
        expect(error.message).not.toContain(secretKey);
      }
    });

    it('TC-REQ5-ERR-06: abort signal propagates cancellation cleanly', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      await expect(
        adapter.executeNonStream(req, { ...ctx, signal: abortController.signal })
      ).rejects.toThrowError('The operation was aborted');
    });
  });

  describe('5. Streaming SSE Execution & Intermediate Elements (Requirement 7, AC 1-5)', () => {
    const adapter = new GeminiAdapter();
    const req: AdapterRequest = {
      model: requestedModel,
      messages: [{ role: 'user', content: 'Stream test' }],
      stream: true,
    };
    const ctx: AdapterContext = {
      secret: secretKey,
      upstreamModel,
      id: 'chatcmpl-stream-test-456',
      created: 1793664000,
    };

    /**
     * Helper to create a mock ReadableStream yielding SSE chunks.
     */
    function createMockSseStream(chunks: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
    }

    it('processes successful stream: emits role chunk on first text, text chunks, and final chunk on STOP followed by done', async () => {
      const sseChunks = [
        'data: {"candidates": [{"content": {"parts": [{"text": "Halo"}]}}]}\n\n',
        'data: {"candidates": [{"content": {"parts": [{"text": " dunia"}]}}]}\n\n',
        'data: {"candidates": [{"finishReason": "STOP", "content": {"parts": []}}], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 5, "totalTokenCount": 10}}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const events: any[] = [];
      for await (const event of adapter.executeStream(req, ctx)) {
        events.push(event);
      }

      // Expected event sequence:
      // 1. Role chunk (role: 'assistant')
      // 2. Text chunk ("Halo")
      // 3. Text chunk (" dunia")
      // 4. Final chunk (finish_reason: "stop", usage metadata)
      // 5. Done event
      expect(events).toHaveLength(5);

      expect(events[0].type).toBe('chunk');
      expect(events[0].chunk.id).toBe('chatcmpl-stream-test-456');
      expect(events[0].chunk.choices[0].delta).toEqual({ role: 'assistant' });
      expect(events[0].chunk.choices[0].finish_reason).toBeNull();

      expect(events[1].type).toBe('chunk');
      expect(events[1].chunk.choices[0].delta).toEqual({ content: 'Halo' });
      expect(events[1].chunk.choices[0].finish_reason).toBeNull();

      expect(events[2].type).toBe('chunk');
      expect(events[2].chunk.choices[0].delta).toEqual({ content: ' dunia' });
      expect(events[2].chunk.choices[0].finish_reason).toBeNull();

      expect(events[3].type).toBe('chunk');
      expect(events[3].chunk.choices[0].delta).toEqual({});
      expect(events[3].chunk.choices[0].finish_reason).toBe('stop');
      expect(events[3].chunk.usage).toEqual({
        prompt_tokens: 5,
        completion_tokens: 5,
        total_tokens: 10,
      });

      expect(events[4].type).toBe('done');
    });

    it('handles temporary intermediate elements (metadata only or no candidates) safely without error', async () => {
      const sseChunks = [
        // 1. Metadata only (no candidates) - temporary valid state
        'data: {"usageMetadata": {"promptTokenCount": 5}}\n\n',
        // 2. Text part without finishReason
        'data: {"candidates": [{"content": {"parts": [{"text": "Hello"}]}}]}\n\n',
        // 3. Finish with MAX_TOKENS
        'data: {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": []}}]}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const events: any[] = [];
      for await (const event of adapter.executeStream(req, ctx)) {
        events.push(event);
      }

      expect(events).toHaveLength(4);
      expect(events[0].chunk.choices[0].delta).toEqual({ role: 'assistant' });
      expect(events[1].chunk.choices[0].delta).toEqual({ content: 'Hello' });
      expect(events[2].chunk.choices[0].finish_reason).toBe('length');
      expect(events[3].type).toBe('done');
    });

    it('throws ProviderOutputBlockedError before any text is emitted if promptFeedback is blocked', async () => {
      const sseChunks = [
        'data: {"promptFeedback": {"blockReason": "SAFETY"}}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const gen = adapter.executeStream(req, ctx);
      await expect(gen.next()).rejects.toThrowError(ProviderOutputBlockedError);
    });

    it('emits error event and done if blockReason or SAFETY finishReason occurs after text has started', async () => {
      const sseChunks = [
        'data: {"candidates": [{"content": {"parts": [{"text": "Safe text"}]}}]}\n\n',
        'data: {"candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const events: any[] = [];
      for await (const event of adapter.executeStream(req, ctx)) {
        events.push(event);
      }

      // Should have: role chunk, text chunk, error event, done
      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('chunk');
      expect(events[1].type).toBe('chunk');
      expect(events[2].type).toBe('error');
      expect(events[2].error.code).toBe('provider_output_blocked');
      expect(events[3].type).toBe('done');
    });

    it('emits error event if stream ends with conflicting finish reasons', async () => {
      const sseChunks = [
        'data: {"candidates": [{"content": {"parts": [{"text": "Valid text"}]}}]}\n\n',
        'data: {"candidates": [{"finishReason": "STOP", "content": {"parts": []}}]}\n\n',
        'data: {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": []}}]}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const events: any[] = [];
      for await (const event of adapter.executeStream(req, ctx)) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.code).toBe('provider_error');
    });

    it('emits error event if stream ends with OTHER or unhandled finish reason after text started', async () => {
      const sseChunks = [
        'data: {"candidates": [{"content": {"parts": [{"text": "Some text"}]}}]}\n\n',
        'data: {"candidates": [{"finishReason": "OTHER", "content": {"parts": []}}]}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(createMockSseStream(sseChunks), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const events: any[] = [];
      for await (const event of adapter.executeStream(req, ctx)) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.code).toBe('provider_error');
      expect(events[events.length - 1].type).toBe('done');
    });

    it('cancels stream immediately when AbortSignal triggers mid-stream', async () => {
      const abortController = new AbortController();

      let cancelCalled = false;
      const customMockStream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode('data: {"candidates": [{"content": {"parts": [{"text": "First chunk"}]}}]}\n\n')
          );
        },
        cancel() {
          cancelCalled = true;
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(customMockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const gen = adapter.executeStream(req, {
        ...ctx,
        signal: abortController.signal,
      });

      // Receive first chunk (roleChunk)
      const first = await gen.next();
      expect(first.value?.type).toBe('chunk');

      // Abort controller
      abortController.abort();

      // Draining next iteration must reject with AbortError
      await expect(async () => {
        while (true) {
          const res = await gen.next();
          if (res.done) break;
        }
      }).rejects.toThrowError(/abort/i);

      expect(cancelCalled).toBe(true);
    });

    it('cancels upstream reader and releases lock when consumer terminates stream prematurely', async () => {
      let cancelCalled = false;
      const customMockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n'
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"world!"}]}}]}\n\n'
            )
          );
        },
        cancel() {
          cancelCalled = true;
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(customMockStream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const gen = adapter.executeStream(req, ctx);

      for await (const event of gen) {
        if (event.type === 'chunk') {
          break; // Consumer breaks early
        }
      }

      expect(cancelCalled).toBe(true);
    });
  });

  describe('6. Provider Registry & Fallback Prohibition (Requirement 4, AC 1, AC 4)', () => {
    it('returns official gemini adapter for providerType gemini', () => {
      const resolved = getProviderAdapter('gemini');
      expect(resolved).toBe(geminiAdapter);
      expect(resolved.providerType).toBe('gemini');
    });

    it('rejects unsupported providers (anthropic, openai, etc.) with 503 provider_unavailable', () => {
      expect(() => getProviderAdapter('anthropic')).toThrowError(ProviderUnavailableError);
      expect(() => getProviderAdapter('openai')).toThrowError(ProviderUnavailableError);

      try {
        getProviderAdapter('anthropic');
      } catch (err: unknown) {
        const error = err as ProviderUnavailableError;
        expect(error.statusCode).toBe(503);
        expect(error.code).toBe('provider_unavailable');
        expect(error.message).toContain('unsupported for MVP');
      }
    });
  });

  describe('7. Strict OpenAI REST Public Contract Conformity (Requirement 4, AC 4 & Requirement 5, AC 2, AC 5)', () => {
    const adapter = new GeminiAdapter();
    const req: AdapterRequest = {
      model: requestedModel,
      messages: [{ role: 'user', content: 'Public contract check' }],
    };
    const ctx: AdapterContext = {
      secret: secretKey,
      upstreamModel,
      id: 'chatcmpl-contract-check-999',
      created: 1793664000,
    };

    it('ensures nonstream response matches exact OpenAI ChatCompletion schema without Gemini fields leaking', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'Clean response' }] },
                finishReason: 'STOP',
                safetyRatings: [{ category: 'HARM', probability: 'NEGLIGIBLE' }],
              },
            ],
            promptFeedback: { safetyRatings: [] },
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 8,
              totalTokenCount: 20,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await adapter.executeNonStream(req, ctx);

      // Validate exact keys present on root
      const rootKeys = Object.keys(res).sort();
      expect(rootKeys).toEqual(['choices', 'created', 'id', 'model', 'object', 'usage'].sort());

      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe(requestedModel);
      expect(res.choices).toHaveLength(1);

      const choiceKeys = Object.keys(res.choices[0]).sort();
      expect(choiceKeys).toEqual(['finish_reason', 'index', 'message'].sort());
      expect(res.choices[0].index).toBe(0);
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.choices[0].message).toEqual({
        role: 'assistant',
        content: 'Clean response',
      });

      expect(res.usage).toEqual({
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
      });

      // Assert Gemini internal fields are NOT present
      const resAny = res as any;
      expect(resAny.candidates).toBeUndefined();
      expect(resAny.promptFeedback).toBeUndefined();
      expect(resAny.safetyRatings).toBeUndefined();
    });

    it('ensures error envelopes strictly follow OpenAI error format', () => {
      const blockedErr = new ProviderOutputBlockedError();
      const emptyErr = new ProviderEmptyResponseError();
      const provErr = new ProviderError();
      const unavailErr = new ProviderUnavailableError();

      for (const err of [blockedErr, emptyErr, provErr, unavailErr]) {
        const json = err.toResponseJson();
        expect(Object.keys(json)).toEqual(['error']);
        expect(Object.keys(json.error).sort()).toEqual(['code', 'message', 'param', 'type'].sort());
        expect(json.error.param).toBeNull();
        expect(typeof json.error.message).toBe('string');
        expect(typeof json.error.code).toBe('string');
        expect(typeof json.error.type).toBe('string');
      }
    });
  });
});
