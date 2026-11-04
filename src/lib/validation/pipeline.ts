import { readBoundedBody, parseBoundedJson } from './body-reader';
import { validateChatCompletionRequest, type ValidatedChatCompletionRequest } from './chat-completion';
import { computePayloadFingerprint } from './fingerprint';
import { validateIdempotencyKey } from './uuid';

export interface ProcessedGatewayRequest {
  idempotencyKey: string;
  validatedRequest: ValidatedChatCompletionRequest;
  fingerprint: string;
  canonicalJson: string;
}

export async function validateGatewayRequest(
  request: Request | { headers: Headers | Record<string, string | null | undefined>; body?: any }
): Promise<ProcessedGatewayRequest> {
  let idempotencyHeader: string | null | undefined = null;
  if ('headers' in request) {
    if (request.headers instanceof Headers) {
      idempotencyHeader = request.headers.get('Idempotency-Key') ?? request.headers.get('idempotency-key');
    } else if (typeof request.headers === 'object' && request.headers !== null) {
      const h = request.headers as Record<string, string | null | undefined>;
      idempotencyHeader = h['Idempotency-Key'] ?? h['idempotency-key'];
    }
  }

  const idempotencyKey = validateIdempotencyKey(idempotencyHeader);
  const rawBody = await readBoundedBody(request as any);
  const parsedJson = parseBoundedJson(rawBody);
  const validatedRequest = validateChatCompletionRequest(parsedJson);
  const { fingerprint, canonicalJson } = computePayloadFingerprint(validatedRequest);

  return {
    idempotencyKey,
    validatedRequest,
    fingerprint,
    canonicalJson,
  };
}
