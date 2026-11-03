import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateGatewayRequest } from '../../src/lib/validation/pipeline.js';
import { GatewayError } from '../../src/lib/validation/error.js';

describe('Gateway Request Validation Pipeline', () => {
  test('Valid request executes full pipeline cleanly', async () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000';
    const payload = JSON.stringify({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo dari client' }],
      temperature: 0.7,
    });

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': validUuid,
      },
      body: payload,
    });

    const result = await validateGatewayRequest(req);
    assert.equal(result.idempotencyKey, validUuid);
    assert.equal(result.validatedRequest.model, 'gemini-default');
    assert.equal(result.validatedRequest.messages.length, 1);
    assert.equal(result.validatedRequest.temperature, 0.7);
    assert.equal(result.validatedRequest.stream, undefined);
    assert.equal(typeof result.fingerprint, 'string');
    assert.equal(result.fingerprint.length, 64);
  });

  test('Pipeline catches invalid Idempotency-Key header before reading body', async () => {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'not-a-uuid',
      },
      body: JSON.stringify({ model: 'gemini-default', messages: [{ role: 'user', content: 'Halo' }] }),
    });

    await assert.rejects(
      async () => {
        await validateGatewayRequest(req);
      },
      (err: unknown) => {
        assert(err instanceof GatewayError);
        assert.equal(err.httpStatus, 400);
        assert.equal(err.code, 'invalid_request');
        assert.equal(err.param, 'Idempotency-Key');
        return true;
      }
    );
  });

  test('Pipeline catches oversized payload with 413 payload_too_large', async () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000';
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': validUuid,
      },
      body: oversizedBody,
    });

    await assert.rejects(
      async () => {
        await validateGatewayRequest(req);
      },
      (err: unknown) => {
        assert(err instanceof GatewayError);
        assert.equal(err.httpStatus, 413);
        assert.equal(err.code, 'payload_too_large');
        assert.equal(err.param, null);
        return true;
      }
    );
  });
});
