import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AntigravityAdapter,
  antigravityAdapter,
  mapOpenAIMessagesToAntigravity,
} from '@/lib/adapters/antigravity';
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
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_ENDPOINTS,
  ANTIGRAVITY_USER_AGENT,
} from '@/lib/antigravity/constants';

describe('Google Antigravity Provider Adapter', () => {
  const secretPayload = JSON.stringify({
    access_token: 'test-antigravity-token-ya29',
    refresh_token: 'test-antigravity-refresh-token',
    expiry_date: Date.now() + 3600000,
    project_id: 'projects/test-project-12345',
    email: 'bayu@example.com',
  });

  const upstreamModel = 'gemini-2.5-pro';
  const requestedModel = 'gemini-pro-alias';

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. Registration in Provider Registry', () => {
    it('returns antigravity adapter when getProviderAdapter("antigravity") is called', () => {
      const adapter = getProviderAdapter('antigravity');
      expect(adapter).toBeDefined();
      expect(adapter.providerType).toBe('antigravity');
    });
  });

  describe('2. Message & Parameter Mapping', () => {
    it('maps leading system instruction to systemInstruction parts', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'system', content: 'You are an AI pair programmer.' },
        { role: 'user', content: 'Hello Antigravity' },
      ];

      const { contents, systemInstruction } = mapOpenAIMessagesToAntigravity(messages);

      expect(systemInstruction).toBeDefined();
      expect(systemInstruction?.parts).toEqual([{ text: 'You are an AI pair programmer.' }]);
      expect(contents).toHaveLength(1);
      expect(contents[0]).toEqual({
        role: 'user',
        parts: [{ text: 'Hello Antigravity' }],
      });
    });

    it('maps alternating user and assistant messages with user and model roles', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'user', content: 'Halo' },
        { role: 'assistant', content: 'Halo juga!' },
        { role: 'user', content: 'Apa kabar?' },
      ];

      const { contents } = mapOpenAIMessagesToAntigravity(messages);

      expect(contents).toHaveLength(3);
      expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'Halo' }] });
      expect(contents[1]).toEqual({ role: 'model', parts: [{ text: 'Halo juga!' }] });
      expect(contents[2]).toEqual({ role: 'user', parts: [{ text: 'Apa kabar?' }] });
    });

    it('rejects system message appearing after conversation has started', () => {
      const messages: AdapterChatMessage[] = [
        { role: 'user', content: 'Halo' },
        { role: 'system', content: 'Late system' },
      ];

      expect(() => mapOpenAIMessagesToAntigravity(messages)).toThrowError(AdapterError);
    });
  });

  describe('3. Non-stream Execution', () => {
    it('successfully processes non-stream request by aggregating stream chunks', async () => {
      const ssePayload = [
        'data: ' +
          JSON.stringify({
            response: {
              candidates: [
                {
                  content: { parts: [{ text: 'Halo dari ' }] },
                },
              ],
            },
          }),
        'data: ' +
          JSON.stringify({
            response: {
              candidates: [
                {
                  content: { parts: [{ text: 'Google Antigravity!' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 15,
                totalTokenCount: 25,
              },
            },
          }),
        'data: [DONE]',
      ].join('\n\n') + '\n\n';

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        expect(init.headers).toMatchObject({
          Authorization: 'Bearer test-antigravity-token-ya29',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
        });

        const body = JSON.parse(init.body as string);
        expect(body.project).toBe('projects/test-project-12345');
        expect(body.model).toBe(upstreamModel);
        expect(body.userAgent).toBe('antigravity');

        return new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const adapter = new AntigravityAdapter();
      const res = await adapter.executeNonStream(
        {
          model: requestedModel,
          messages: [{ role: 'user', content: 'Halo' }],
        },
        {
          secret: secretPayload,
          upstreamModel,
        }
      );

      expect(res.object).toBe('chat.completion');
      expect(res.model).toBe(requestedModel);
      expect(res.choices[0].message.content).toBe('Halo dari Google Antigravity!');
      expect(res.choices[0].finish_reason).toBe('stop');
      expect(res.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25,
      });
    });

    it('throws ProviderEmptyResponseError when upstream returns no text parts', async () => {
      const ssePayload = 'data: ' + JSON.stringify({ response: { candidates: [] } }) + '\n\n';

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const adapter = new AntigravityAdapter();
      await expect(
        adapter.executeNonStream(
          { model: requestedModel, messages: [{ role: 'user', content: 'Halo' }] },
          { secret: secretPayload, upstreamModel }
        )
      ).rejects.toThrowError(ProviderEmptyResponseError);
    });

    it('throws ProviderOutputBlockedError when finishReason is SAFETY', async () => {
      const ssePayload =
        'data: ' +
        JSON.stringify({
          response: {
            candidates: [
              {
                finishReason: 'SAFETY',
              },
            ],
          },
        }) +
        '\n\n';

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const adapter = new AntigravityAdapter();
      await expect(
        adapter.executeNonStream(
          { model: requestedModel, messages: [{ role: 'user', content: 'Halo' }] },
          { secret: secretPayload, upstreamModel }
        )
      ).rejects.toThrowError(ProviderOutputBlockedError);
    });

    it('triggers onRefreshToken callback and retries on 401 Unauthorized', async () => {
      let callCount = 0;
      const onRefreshToken = vi.fn().mockImplementation(async () => {
        return JSON.stringify({
          access_token: 'refreshed-token-ya29',
          refresh_token: 'test-antigravity-refresh-token',
          expiry_date: Date.now() + 3600000,
          project_id: 'projects/test-project-12345',
        });
      });

      const ssePayload =
        'data: ' +
        JSON.stringify({
          response: {
            candidates: [
              {
                content: { parts: [{ text: 'Berhasil setelah refresh!' }] },
                finishReason: 'STOP',
              },
            ],
          },
        }) +
        '\n\n';

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return new Response('Unauthorized', { status: 401 });
        }
        expect(init.headers).toMatchObject({
          Authorization: 'Bearer refreshed-token-ya29',
        });
        return new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });

      const adapter = new AntigravityAdapter();
      const res = await adapter.executeNonStream(
        { model: requestedModel, messages: [{ role: 'user', content: 'Halo' }] },
        { secret: secretPayload, upstreamModel, onRefreshToken }
      );

      expect(callCount).toBe(2);
      expect(onRefreshToken).toHaveBeenCalledTimes(1);
      expect(res.choices[0].message.content).toBe('Berhasil setelah refresh!');
    });
  });

  describe('4. Streaming Execution', () => {
    it('yields incremental chunk events and terminates with done event', async () => {
      const ssePayload = [
        'data: ' +
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Chunk 1 ' }] },
              },
            ],
          }),
        'data: ' +
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Chunk 2' }] },
                finishReason: 'STOP',
              },
            ],
          }),
        'data: [DONE]',
      ].join('\n\n') + '\n\n';

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(ssePayload, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      );

      const adapter = new AntigravityAdapter();
      const stream = adapter.executeStream(
        { model: requestedModel, messages: [{ role: 'user', content: 'Halo' }] },
        { secret: secretPayload, upstreamModel }
      );

      const events = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('chunk');
      expect((events[0] as any).chunk.choices[0].delta.content).toBe('Chunk 1 ');
      expect((events[0] as any).chunk.choices[0].delta.role).toBe('assistant');

      expect(events[1].type).toBe('chunk');
      expect((events[1] as any).chunk.choices[0].delta.content).toBe('Chunk 2');
      expect((events[1] as any).chunk.choices[0].finish_reason).toBe('stop');

      expect(events[2].type).toBe('done');
    });

    it('throws ProviderUnavailableError when fetch fails with network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const adapter = new AntigravityAdapter();
      const stream = adapter.executeStream(
        { model: requestedModel, messages: [{ role: 'user', content: 'Halo' }] },
        { secret: secretPayload, upstreamModel }
      );

      await expect(async () => {
        for await (const event of stream) {}
      }).rejects.toThrowError(ProviderUnavailableError);
    });
  });
});

