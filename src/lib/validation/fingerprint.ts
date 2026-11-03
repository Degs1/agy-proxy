import { createHash } from 'node:crypto';
import type { ValidatedChatCompletionRequest } from './chat-completion.js';

export function serializeCanonicalJson(val: unknown): string {
  if (val === null || val === undefined) {
    return 'null';
  }

  if (typeof val === 'number') {
    // In IEEE 754 JavaScript, 1 and 1.0 have the exact same representation.
    // JSON.stringify formats numbers without trailing .0, ensuring numeric equivalence.
    return JSON.stringify(val);
  }

  if (typeof val === 'boolean' || typeof val === 'string') {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    const items = val.map((item) => serializeCanonicalJson(item));
    return `[${items.join(',')}]`;
  }

  if (typeof val === 'object') {
    const record = val as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const parts: string[] = [];

    for (const key of sortedKeys) {
      const propVal = record[key];
      if (propVal !== undefined) {
        parts.push(`${JSON.stringify(key)}:${serializeCanonicalJson(propVal)}`);
      }
    }

    return `{${parts.join(',')}}`;
  }

  return JSON.stringify(val);
}

export function buildCanonicalPayload(
  validatedReq: ValidatedChatCompletionRequest
): Record<string, unknown> {
  const canonicalMessages = validatedReq.messages.map((msg) => ({
    content: msg.content,
    role: msg.role,
  }));

  const canonical: Record<string, unknown> = {
    messages: canonicalMessages,
    model: validatedReq.model,
    stream: validatedReq.stream ?? false, // Normalization: omitted stream becomes false
  };

  if (validatedReq.temperature !== undefined) {
    canonical.temperature = validatedReq.temperature;
  }

  if (validatedReq.max_tokens !== undefined) {
    canonical.max_tokens = validatedReq.max_tokens;
  }

  return canonical;
}

export function computePayloadFingerprint(
  validatedReq: ValidatedChatCompletionRequest
): { fingerprint: string; canonicalJson: string } {
  const canonicalObj = buildCanonicalPayload(validatedReq);
  const canonicalJson = serializeCanonicalJson(canonicalObj);
  const fingerprint = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');

  return { fingerprint, canonicalJson };
}
