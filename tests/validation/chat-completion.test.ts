import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateChatCompletionRequest } from '../../src/lib/validation/chat-completion.js';
import { validateIdempotencyKey } from '../../src/lib/validation/uuid.js';
import { GatewayError } from '../../src/lib/validation/error.js';

describe('Requirement 5 Contract & Boundary Tests', () => {
  describe('1.2 Batas Panjang Array Messages', () => {
    test('TC-REQ5-MSG-LEN-01: Di luar batas bawah (0 item: messages: [])', () => {
      assert.throws(
        () => validateChatCompletionRequest({ model: 'gemini-default', messages: [] }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages');
          return true;
        }
      );
    });

    test('TC-REQ5-MSG-LEN-02: Tepat pada batas bawah (1 item: [user])', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
      });
      assert.equal(res.messages.length, 1);
      assert.equal(res.messages[0].role, 'user');
    });

    test('TC-REQ5-MSG-LEN-03: Tepat pada batas atas (64 item pergantian peran sah)', () => {
      // 64 items: alternating assistant and user starting with user
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let i = 0; i < 64; i++) {
        messages.push({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Pesan ${i}`,
        });
      }
      // Note: if 64 items, i=63 has role 'assistant'. But rule says conversation MUST end with user!
      // So if there are leading system messages, e.g. 1 system, then 63 messages alternating starting user, ending user:
      // index 0: system
      // index 1: user, index 2: assistant, ..., index 63: user -> total 64 messages!
      const valid64Messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: 'Instruction' },
      ];
      for (let i = 1; i < 64; i++) {
        // i=1 (odd) -> user; i=2 (even) -> assistant; ...; i=63 (odd) -> user.
        valid64Messages.push({
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Pesan ${i}`,
        });
      }

      assert.equal(valid64Messages.length, 64);
      assert.equal(valid64Messages[valid64Messages.length - 1].role, 'user');

      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: valid64Messages,
      });
      assert.equal(res.messages.length, 64);
    });

    test('TC-REQ5-MSG-LEN-04: Di luar batas atas (65 item)', () => {
      const messages65: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      for (let i = 0; i < 65; i++) {
        messages65.push({ role: 'user', content: 'Halo' });
      }

      assert.throws(
        () => validateChatCompletionRequest({ model: 'gemini-default', messages: messages65 }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages');
          return true;
        }
      );
    });

    test('TC-REQ5-MSG-LEN-05: Di luar batas tipe (messages berupa string atau object)', () => {
      assert.throws(
        () => validateChatCompletionRequest({ model: 'gemini-default', messages: 'not an array' }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages');
          return true;
        }
      );

      assert.throws(
        () => validateChatCompletionRequest({ model: 'gemini-default', messages: { role: 'user', content: 'hi' } }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages');
          return true;
        }
      );
    });
  });

  describe('1.3 Batas Ukuran Konten Pesan (Content Size)', () => {
    test('TC-REQ5-CNT-LEN-01: Di luar batas bawah (Konten string kosong "")', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: '' }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].content');
          return true;
        }
      );
    });

    test('TC-REQ5-CNT-LEN-02: Tepat pada batas bawah (Konten 1 byte UTF-8: "A")', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'A' }],
      });
      assert.equal(res.messages[0].content, 'A');
    });

    test('TC-REQ5-CNT-LEN-03: Tepat pada batas atas (Konten tepat 32.768 byte UTF-8)', () => {
      const maxContent = 'x'.repeat(32768);
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: maxContent }],
      });
      assert.equal(res.messages[0].content.length, 32768);
    });

    test('TC-REQ5-CNT-LEN-04: Di luar batas atas (Konten 32.769 byte UTF-8)', () => {
      const oversized = 'x'.repeat(32769);
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: oversized }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].content');
          return true;
        }
      );
    });

    test('TC-REQ5-CNT-LEN-05: Batas multi-byte UTF-8 (8.192 emoji 4-byte = tepat 32.768 byte)', () => {
      // Emoji 🚀 is 4 bytes in UTF-8
      const emoji4Byte = '🚀';
      assert.equal(Buffer.byteLength(emoji4Byte, 'utf8'), 4);
      const emojiContent = emoji4Byte.repeat(8192); // 8192 * 4 = 32768 bytes
      assert.equal(Buffer.byteLength(emojiContent, 'utf8'), 32768);

      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: emojiContent }],
      });
      assert.equal(Buffer.byteLength(res.messages[0].content, 'utf8'), 32768);
    });

    test('TC-REQ5-CNT-LEN-06: Di luar batas multi-byte (8.193 emoji 4-byte = 32.772 byte)', () => {
      const emoji4Byte = '🚀';
      const oversizedEmoji = emoji4Byte.repeat(8193); // 32772 bytes
      assert.equal(Buffer.byteLength(oversizedEmoji, 'utf8'), 32772);

      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: oversizedEmoji }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].content');
          return true;
        }
      );
    });
  });

  describe('1.4 Batas Peran dan Pola Urutan Pesan (Roles & Sequence)', () => {
    test('TC-REQ5-SEQ-01: Tepat pada batas (Minimal valid: [user])', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
      });
      assert.equal(res.messages.length, 1);
    });

    test('TC-REQ5-SEQ-02: Tepat pada batas (Multi-system awal: [system, system, user])', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [
          { role: 'system', content: 'Sys 1' },
          { role: 'system', content: 'Sys 2' },
          { role: 'user', content: 'Halo' },
        ],
      });
      assert.equal(res.messages.length, 3);
      assert.equal(res.messages[0].role, 'system');
      assert.equal(res.messages[1].role, 'system');
      assert.equal(res.messages[2].role, 'user');
    });

    test('TC-REQ5-SEQ-03: Tepat pada batas (Percakapan panjang sah)', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [
          { role: 'system', content: 'Instruksi' },
          { role: 'user', content: 'Tanya 1' },
          { role: 'assistant', content: 'Jawab 1' },
          { role: 'user', content: 'Tanya 2' },
          { role: 'assistant', content: 'Jawab 2' },
          { role: 'user', content: 'Tanya 3' },
        ],
      });
      assert.equal(res.messages.length, 6);
    });

    test('TC-REQ5-SEQ-04: Di luar batas (Awal bukan user/sys: [assistant, user])', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              { role: 'assistant', content: 'Halo saya AI' },
              { role: 'user', content: 'Halo' },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].role');
          return true;
        }
      );
    });

    test('TC-REQ5-SEQ-05: Di luar batas (Akhir bukan user: [user, assistant])', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              { role: 'user', content: 'Halo' },
              { role: 'assistant', content: 'Ada yang bisa dibantu?' },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[1].role');
          return true;
        }
      );
    });

    test('TC-REQ5-SEQ-06: Di luar batas (Hanya system tanpa user: [system, system])', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              { role: 'system', content: 'Sys 1' },
              { role: 'system', content: 'Sys 2' },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages');
          return true;
        }
      );
    });

    test('TC-REQ5-SEQ-07: Di luar batas (System terlambat: [user, system, user])', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              { role: 'user', content: 'Halo' },
              { role: 'system', content: 'System instruksi terlambat' },
              { role: 'user', content: 'Tanya lagi' },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[1].role');
          return true;
        }
      );
    });

    test('TC-REQ5-SEQ-08: Di luar batas (User berturut-turut: [user, user])', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              { role: 'user', content: 'Pesan 1' },
              { role: 'user', content: 'Pesan 2' },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[1].role');
          return true;
        }
      );
    });

    test('TC-REQ5-SEQ-09: Di luar batas (Assistant berturut: [user, assistant, assistant, user])', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              { role: 'user', content: 'Pesan 1' },
              { role: 'assistant', content: 'Jawab 1' },
              { role: 'assistant', content: 'Jawab 2' },
              { role: 'user', content: 'Pesan 2' },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[2].role');
          return true;
        }
      );
    });

    test('TC-REQ5-SEQ-10: Di luar batas (Peran tidak sah: role "tool" atau "developer")', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'tool', content: 'Output alat' }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].role');
          return true;
        }
      );

      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'developer', content: 'Prompt pengembang' }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].role');
          return true;
        }
      );
    });
  });

  describe('1.5 Batas Parameter Numerik dan Opsional', () => {
    test('TC-REQ5-NUM-TMP-01: temperature 0 / 0.0 (Batas bawah inklusif)', () => {
      const res1 = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        temperature: 0,
      });
      assert.equal(res1.temperature, 0);

      const res2 = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        temperature: 0.0,
      });
      assert.equal(res2.temperature, 0.0);
    });

    test('TC-REQ5-NUM-TMP-02: temperature -0.001 (Di luar batas bawah)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            temperature: -0.001,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'temperature');
          return true;
        }
      );
    });

    test('TC-REQ5-NUM-TMP-03: temperature 2 / 2.0 (Batas atas inklusif)', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        temperature: 2,
      });
      assert.equal(res.temperature, 2);
    });

    test('TC-REQ5-NUM-TMP-04: temperature 2.001 (Di luar batas atas)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            temperature: 2.001,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'temperature');
          return true;
        }
      );
    });

    test('TC-REQ5-NUM-TMP-05: temperature dihilangkan (omitted)', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
      });
      assert.equal(res.temperature, undefined);
    });

    test('TC-REQ5-NUM-TOK-01: max_tokens 1 (Batas bawah inklusif)', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        max_tokens: 1,
      });
      assert.equal(res.max_tokens, 1);
    });

    test('TC-REQ5-NUM-TOK-02: max_tokens 0 (Di luar batas bawah)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            max_tokens: 0,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'max_tokens');
          return true;
        }
      );
    });

    test('TC-REQ5-NUM-TOK-03: max_tokens 8192 (Batas atas inklusif)', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        max_tokens: 8192,
      });
      assert.equal(res.max_tokens, 8192);
    });

    test('TC-REQ5-NUM-TOK-04: max_tokens 8193 (Di luar batas atas)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            max_tokens: 8193,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'max_tokens');
          return true;
        }
      );
    });

    test('TC-REQ5-NUM-TOK-05: max_tokens 100.5 (Bukan integer)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            max_tokens: 100.5,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'max_tokens');
          return true;
        }
      );
    });

    test('TC-REQ5-NUM-STR-01: stream false', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        stream: false,
      });
      assert.equal(res.stream, false);
    });

    test('TC-REQ5-NUM-STR-02: stream true', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
        stream: true,
      });
      assert.equal(res.stream, true);
    });

    test('TC-REQ5-NUM-STR-03: stream dihilangkan (omitted)', () => {
      const res = validateChatCompletionRequest({
        model: 'gemini-default',
        messages: [{ role: 'user', content: 'Halo' }],
      });
      assert.equal(res.stream, undefined);
    });

    test('TC-REQ5-NUM-STR-04: stream bukan boolean ("true" atau 1)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            stream: 'true',
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'stream');
          return true;
        }
      );

      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            stream: 1,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'stream');
          return true;
        }
      );
    });
  });

  describe('1.6 Batas Idempotency-Key Header', () => {
    test('TC-REQ5-IDEM-01: Tepat pada batas format UUID v4 valid', () => {
      const validUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
      const result = validateIdempotencyKey(validUuid);
      assert.equal(result, validUuid);
    });

    test('TC-REQ5-IDEM-02: Di luar batas (Format non-UUID)', () => {
      assert.throws(
        () => validateIdempotencyKey('request-number-12345'),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'Idempotency-Key');
          return true;
        }
      );
    });

    test('TC-REQ5-IDEM-03: Di luar batas (Header hilang / null / undefined / empty)', () => {
      assert.throws(
        () => validateIdempotencyKey(null),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'Idempotency-Key');
          return true;
        }
      );

      assert.throws(
        () => validateIdempotencyKey(''),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'Idempotency-Key');
          return true;
        }
      );
    });
  });

  describe('1.7 Penolakan Field di Luar Cakupan (Strict Schema Rejection)', () => {
    test('TC-REQ5-EXT-01: tools ditolak sebagai unsupported_feature', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            tools: [],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'unsupported_feature');
          assert.equal(err.param, 'tools');
          return true;
        }
      );
    });

    test('TC-REQ5-EXT-02: functions ditolak sebagai unsupported_feature', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            functions: [],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'unsupported_feature');
          assert.equal(err.param, 'functions');
          return true;
        }
      );
    });

    test('TC-REQ5-EXT-03: n ditolak sebagai unsupported_feature (meski n: 1)', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            n: 1,
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'unsupported_feature');
          assert.equal(err.param, 'n');
          return true;
        }
      );
    });

    test('TC-REQ5-EXT-04: response_format ditolak sebagai unsupported_feature', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            response_format: { type: 'json_object' },
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'unsupported_feature');
          assert.equal(err.param, 'response_format');
          return true;
        }
      );
    });

    test('Unsupported features tambahan: tool_choice, function_call, logprobs, stream_options', () => {
      for (const feat of ['tool_choice', 'function_call', 'logprobs', 'stream_options', 'image_url']) {
        assert.throws(
          () =>
            validateChatCompletionRequest({
              model: 'gemini-default',
              messages: [{ role: 'user', content: 'Halo' }],
              [feat]: 'any',
            }),
          (err: unknown) => {
            assert(err instanceof GatewayError);
            assert.equal(err.httpStatus, 400);
            assert.equal(err.code, 'unsupported_feature');
            assert.equal(err.param, feat);
            return true;
          }
        );
      }
    });

    test('TC-REQ5-EXT-05: Field asing sembarang (unknown_prop) ditolak dengan invalid_request', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo' }],
            unknown_prop: 'val',
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'unknown_prop');
          return true;
        }
      );
    });

    test('TC-REQ5-EXT-06: Field asing dalam item pesan (name, id) ditolak dengan invalid_request', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 'Halo', name: 'User1' }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].name');
          return true;
        }
      );
    });

    test('TC-REQ5-EXT-07: Input multimodal (object / array) ditolak sebagai unsupported_feature', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [
              {
                role: 'user',
                content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
              },
            ],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'unsupported_feature');
          assert.equal(err.param, 'messages[0].content');
          return true;
        }
      );
    });

    test('Input content bukan string bukan multimodal (misal number) ditolak sebagai invalid_request', () => {
      assert.throws(
        () =>
          validateChatCompletionRequest({
            model: 'gemini-default',
            messages: [{ role: 'user', content: 12345 }],
          }),
        (err: unknown) => {
          assert(err instanceof GatewayError);
          assert.equal(err.httpStatus, 400);
          assert.equal(err.code, 'invalid_request');
          assert.equal(err.param, 'messages[0].content');
          return true;
        }
      );
    });
  });
});
