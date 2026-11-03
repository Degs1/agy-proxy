import { createInvalidRequestError } from './error.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  return UUID_REGEX.test(value);
}

export function validateIdempotencyKey(keyHeader: string | null | undefined): string {
  if (!keyHeader || typeof keyHeader !== 'string' || keyHeader.trim() === '') {
    throw createInvalidRequestError('Missing required Idempotency-Key header.', 'Idempotency-Key');
  }

  const trimmed = keyHeader.trim();
  if (!isValidUuid(trimmed)) {
    throw createInvalidRequestError('Idempotency-Key header must be a valid RFC 4122 UUID.', 'Idempotency-Key');
  }

  return trimmed;
}
