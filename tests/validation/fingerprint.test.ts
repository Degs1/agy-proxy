import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateChatCompletionRequest } from '../../src/lib/validation/chat-completion.js';
import {
  computePayloadFingerprint,
  serializeCanonicalJson,
} from '../../src/lib/validation/fingerprint.js';

describe('Requirement 6.4 Sidik Payload Kanonis & Equivalence Tests', () => {
  test('TC-REQ6-IDM-06: Equivalence - Urutan Key JSON menghasilkan sidik SHA-256 identik', () => {
    // Payload A: model first, then messages
    const payloadA = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo dunia' }],
      stream: false,
    };

    // Payload B: messages first, then stream, then model
    const payloadB = {
      messages: [{ content: 'Halo dunia', role: 'user' }],
      stream: false,
      model: 'gemini-default',
    };

    const validatedA = validateChatCompletionRequest(payloadA);
    const validatedB = validateChatCompletionRequest(payloadB);

    const fpA = computePayloadFingerprint(validatedA);
    const fpB = computePayloadFingerprint(validatedB);

    assert.equal(fpA.canonicalJson, fpB.canonicalJson);
    assert.equal(fpA.fingerprint, fpB.fingerprint);
    assert.equal(typeof fpA.fingerprint, 'string');
    assert.equal(fpA.fingerprint.length, 64); // SHA-256 hex string
  });

  test('TC-REQ6-IDM-06 Permutasi Lengkap: Seluruh permutasi urutan field top-level menghasilkan sidik identik', () => {
    const p1 = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      stream: false,
      temperature: 0.5,
      max_tokens: 100,
    };

    const p2 = {
      max_tokens: 100,
      temperature: 0.5,
      stream: false,
      messages: [{ role: 'user', content: 'Halo' }],
      model: 'gemini-default',
    };

    const p3 = {
      stream: false,
      model: 'gemini-default',
      temperature: 0.5,
      max_tokens: 100,
      messages: [{ content: 'Halo', role: 'user' }],
    };

    const fp1 = computePayloadFingerprint(validateChatCompletionRequest(p1));
    const fp2 = computePayloadFingerprint(validateChatCompletionRequest(p2));
    const fp3 = computePayloadFingerprint(validateChatCompletionRequest(p3));

    assert.equal(fp1.fingerprint, fp2.fingerprint);
    assert.equal(fp1.fingerprint, fp3.fingerprint);
    assert.equal(fp1.canonicalJson, fp2.canonicalJson);
    assert.equal(fp1.canonicalJson, fp3.canonicalJson);
  });

  test('TC-REQ6-IDM-07: Equivalence - Stream Boolean ("stream": false vs field stream dihilangkan)', () => {
    // Payload with stream: false explicitly
    const payloadExplicit = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      stream: false,
    };

    // Payload with stream omitted
    const payloadOmitted = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
    };

    const validatedExplicit = validateChatCompletionRequest(payloadExplicit);
    const validatedOmitted = validateChatCompletionRequest(payloadOmitted);

    const fpExplicit = computePayloadFingerprint(validatedExplicit);
    const fpOmitted = computePayloadFingerprint(validatedOmitted);

    assert.equal(
      fpExplicit.canonicalJson,
      fpOmitted.canonicalJson,
      'Canonical JSON string must be identical when stream is omitted vs false'
    );
    assert.equal(fpExplicit.fingerprint, fpOmitted.fingerprint);
  });

  test('TC-REQ6-IDM-08: Equivalence - Angka Numerik (temperature: 1 vs temperature: 1.0)', () => {
    const payloadInt = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 1,
      max_tokens: 500,
    };

    const payloadFloat = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 1.0,
      max_tokens: 500.0,
    };

    const validatedInt = validateChatCompletionRequest(payloadInt);
    const validatedFloat = validateChatCompletionRequest(payloadFloat);

    const fpInt = computePayloadFingerprint(validatedInt);
    const fpFloat = computePayloadFingerprint(validatedFloat);

    assert.equal(
      fpInt.canonicalJson,
      fpFloat.canonicalJson,
      'Canonical JSON must compare numeric values purely without trailing zero distinction'
    );
    assert.equal(fpInt.fingerprint, fpFloat.fingerprint);
  });

  test('TC-REQ6-IDM-08 Ekstensi: temperature: 0 vs 0.0 dan 2 vs 2.0 menghasilkan sidik identik', () => {
    const pZeroInt = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 0,
    });
    const pZeroFloat = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 0.0,
    });

    assert.equal(
      computePayloadFingerprint(pZeroInt).fingerprint,
      computePayloadFingerprint(pZeroFloat).fingerprint
    );

    const pTwoInt = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 2,
    });
    const pTwoFloat = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 2.0,
    });

    assert.equal(
      computePayloadFingerprint(pTwoInt).fingerprint,
      computePayloadFingerprint(pTwoFloat).fingerprint
    );
  });

  test('TC-REQ6-IDM-09: Non-equivalence - Omitted vs Explicit parameter', () => {
    // temperature omitted
    const payloadOmitted = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
    };

    // temperature explicitly 1.0
    const payloadExplicit = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 1.0,
    };

    const validatedOmitted = validateChatCompletionRequest(payloadOmitted);
    const validatedExplicit = validateChatCompletionRequest(payloadExplicit);

    const fpOmitted = computePayloadFingerprint(validatedOmitted);
    const fpExplicit = computePayloadFingerprint(validatedExplicit);

    assert.notEqual(
      fpOmitted.canonicalJson,
      fpExplicit.canonicalJson,
      'Omitted parameter must produce distinct canonical JSON from explicitly sent parameter'
    );
    assert.notEqual(
      fpOmitted.fingerprint,
      fpExplicit.fingerprint,
      'Fingerprints must not match when temperature is omitted vs explicit'
    );
  });

  test('TC-REQ6-IDM-09 Ekstensi: temperature: 0 eksplisit vs temperature dihilangkan harus berbeda', () => {
    const pOmitted = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
    });
    const pZero = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 0,
    });

    assert.notEqual(
      computePayloadFingerprint(pOmitted).fingerprint,
      computePayloadFingerprint(pZero).fingerprint
    );
  });

  test('Non-equivalence - max_tokens omitted vs max_tokens: 100', () => {
    const payloadOmitted = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
    };

    const payloadExplicit = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      max_tokens: 100,
    };

    const validatedOmitted = validateChatCompletionRequest(payloadOmitted);
    const validatedExplicit = validateChatCompletionRequest(payloadExplicit);

    const fpOmitted = computePayloadFingerprint(validatedOmitted);
    const fpExplicit = computePayloadFingerprint(validatedExplicit);

    assert.notEqual(fpOmitted.fingerprint, fpExplicit.fingerprint);
  });

  test('Non-equivalence - stream: true vs stream: false', () => {
    const payloadStream = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      stream: true,
    };

    const payloadNonStream = {
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo' }],
      stream: false,
    };

    const validatedStream = validateChatCompletionRequest(payloadStream);
    const validatedNonStream = validateChatCompletionRequest(payloadNonStream);

    const fpStream = computePayloadFingerprint(validatedStream);
    const fpNonStream = computePayloadFingerprint(validatedNonStream);

    assert.notEqual(fpStream.fingerprint, fpNonStream.fingerprint);
  });

  test('Non-equivalence - Beda konten atau peran pesan', () => {
    const req1 = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo 1' }],
    });
    const req2 = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Halo 2' }],
    });

    assert.notEqual(
      computePayloadFingerprint(req1).fingerprint,
      computePayloadFingerprint(req2).fingerprint
    );
  });

  test('Perbandingan Unicode: Tanpa normalisasi Unicode tambahan (NFC vs NFD menghasilkan hash berbeda)', () => {
    // \u00e9 is é in NFC (1 codepoint, 2 bytes UTF-8)
    // e\u0301 is e + combining acute in NFD (2 codepoints, 3 bytes UTF-8)
    const nfcString = 'caf\u00e9';
    const nfdString = 'cafe\u0301';
    assert.notEqual(nfcString, nfdString);

    const reqNfc = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: nfcString }],
    });
    const reqNfd = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: nfdString }],
    });

    assert.notEqual(
      computePayloadFingerprint(reqNfc).fingerprint,
      computePayloadFingerprint(reqNfd).fingerprint,
      'Contract mandates no extra Unicode normalization: raw parsed JSON strings are compared directly'
    );
  });

  test('Deterministic SHA-256 formatting', () => {
    const req = validateChatCompletionRequest({
      model: 'gemini-default',
      messages: [{ role: 'user', content: 'Uji deterministik' }],
      stream: false,
      temperature: 0.7,
      max_tokens: 1000,
    });

    const res1 = computePayloadFingerprint(req);
    const res2 = computePayloadFingerprint(req);

    assert.equal(res1.fingerprint, res2.fingerprint);
    assert(/^[0-9a-f]{64}$/.test(res1.fingerprint));
  });
});
