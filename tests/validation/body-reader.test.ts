import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBoundedBody,
  parseBoundedJson,
  MAX_BODY_SIZE_BYTES,
} from '../../src/lib/validation/body-reader.js';
import { GatewayError } from '../../src/lib/validation/error.js';

describe('1.1 Batas Ukuran Body Request (Payload Size)', () => {
  test('TC-REQ5-BODY-01: Tepat pada batas (On-boundary max: 1.048.576 byte)', async () => {
    // Exact 1 MiB body
    const bodyStr = 'x'.repeat(MAX_BODY_SIZE_BYTES);
    const result = await readBoundedBody(bodyStr);
    assert.equal(Buffer.byteLength(result, 'utf8'), MAX_BODY_SIZE_BYTES);
  });

  test('TC-REQ5-BODY-02: Di luar batas atas (Off-boundary +1: 1.048.577 byte)', async () => {
    const oversizedStr = 'x'.repeat(MAX_BODY_SIZE_BYTES + 1);
    await assert.rejects(
      async () => {
        await readBoundedBody(oversizedStr);
      },
      (err: unknown) => {
        assert(err instanceof GatewayError);
        assert.equal(err.httpStatus, 413);
        assert.equal(err.code, 'payload_too_large');
        assert.equal(err.param, null);
        assert.equal(err.type, 'invalid_request_error');
        return true;
      }
    );
  });

  test('TC-REQ5-BODY-02 Stream: Pembacaan stream langsung diputus saat batas 1 MiB terlampaui', async () => {
    let streamCancelled = false;
    const chunkSize = 64 * 1024; // 64 KiB per chunk
    const totalChunks = 20; // 20 * 64 KiB = 1.280 KiB (> 1 MiB)
    let chunksSent = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksSent < totalChunks) {
          controller.enqueue(new Uint8Array(chunkSize).fill(65));
          chunksSent++;
        } else {
          controller.close();
        }
      },
      cancel() {
        streamCancelled = true;
      },
    });

    await assert.rejects(
      async () => {
        await readBoundedBody(stream);
      },
      (err: unknown) => {
        assert(err instanceof GatewayError);
        assert.equal(err.httpStatus, 413);
        assert.equal(err.code, 'payload_too_large');
        assert.equal(err.param, null);
        return true;
      }
    );

    assert.equal(streamCancelled, true, 'Stream reader should have cancelled immediately upon boundary exceed');
  });

  test('TC-REQ5-BODY-03: Di luar batas bawah (Off-boundary 0: Body kosong 0 byte)', async () => {
    await assert.rejects(
      async () => {
        await readBoundedBody('');
      },
      (err: unknown) => {
        assert(err instanceof GatewayError);
        assert.equal(err.httpStatus, 400);
        assert.equal(err.code, 'invalid_request');
        assert.equal(err.param, null);
        return true;
      }
    );
  });

  test('JSON parsing: JSON valid berhasil di-parse', () => {
    const jsonStr = JSON.stringify({ model: 'gemini-default', messages: [{ role: 'user', content: 'Halo' }] });
    const parsed = parseBoundedJson(jsonStr);
    assert.deepEqual(parsed, {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
    });
  });

  test('JSON parsing: JSON tidak valid menghasilkan 400 invalid_request dengan param null', () => {
    assert.throws(
      () => {
        parseBoundedJson('{ malformed json');
      },
      (err: unknown) => {
        assert(err instanceof GatewayError);
        assert.equal(err.httpStatus, 400);
        assert.equal(err.code, 'invalid_request');
        assert.equal(err.param, null);
        return true;
      }
    );
  });
});
