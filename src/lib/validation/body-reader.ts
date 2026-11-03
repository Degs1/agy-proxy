import { createInvalidRequestError, createPayloadTooLargeError } from './error.js';

export const MAX_BODY_SIZE_BYTES = 1024 * 1024; // 1 MiB = 1,048,576 bytes

export async function readBoundedBody(
  input: Request | ReadableStream<Uint8Array> | string | Buffer,
  maxSizeBytes = MAX_BODY_SIZE_BYTES
): Promise<string> {
  if (typeof input === 'string') {
    const byteLength = Buffer.byteLength(input, 'utf8');
    if (byteLength > maxSizeBytes) {
      throw createPayloadTooLargeError();
    }
    if (byteLength === 0) {
      throw createInvalidRequestError('Request body must not be empty.', null);
    }
    return input;
  }

  if (Buffer.isBuffer(input)) {
    if (input.length > maxSizeBytes) {
      throw createPayloadTooLargeError();
    }
    if (input.length === 0) {
      throw createInvalidRequestError('Request body must not be empty.', null);
    }
    return input.toString('utf8');
  }

  let stream: ReadableStream<Uint8Array>;
  if ('body' in input && input.body !== undefined) {
    if (input.body === null) {
      throw createInvalidRequestError('Request body must not be empty.', null);
    }
    stream = input.body;
  } else if (input instanceof ReadableStream) {
    stream = input;
  } else {
    throw createInvalidRequestError('Invalid request body input.', null);
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxSizeBytes) {
          // Immediately cancel stream to prevent further network/memory consumption
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel error
          }
          throw createPayloadTooLargeError();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw createInvalidRequestError('Request body must not be empty.', null);
  }

  const merged = Buffer.concat(chunks, totalBytes);
  return merged.toString('utf8');
}

export function parseBoundedJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw createInvalidRequestError('Invalid JSON in request body.', null);
  }
}
