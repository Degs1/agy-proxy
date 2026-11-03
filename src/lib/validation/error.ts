export type GatewayErrorCode =
  | 'invalid_request'
  | 'unsupported_feature'
  | 'payload_too_large'
  | 'invalid_api_key'
  | 'project_disabled'
  | 'model_disabled'
  | 'model_not_found'
  | 'idempotency_conflict'
  | 'request_in_progress'
  | 'request_already_processed'
  | 'rate_limit_exceeded'
  | 'concurrency_limit_exceeded'
  | 'provider_error'
  | 'provider_output_blocked'
  | 'provider_empty_response'
  | 'provider_unavailable'
  | 'limiter_unavailable'
  | 'gateway_timeout';

export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'requests'
  | 'provider_error'
  | 'server_error';

export interface PublicErrorPayload {
  error: {
    message: string;
    type: GatewayErrorType | string;
    param: string | null;
    code: GatewayErrorCode | string;
  };
}

export class GatewayError extends Error {
  public readonly httpStatus: number;
  public readonly code: GatewayErrorCode | string;
  public readonly type: GatewayErrorType | string;
  public readonly param: string | null;

  constructor(options: {
    message: string;
    httpStatus: number;
    code: GatewayErrorCode | string;
    type?: GatewayErrorType | string;
    param?: string | null;
  }) {
    super(options.message);
    this.name = 'GatewayError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.param = options.param ?? null;
    this.type = options.type ?? this.resolveDefaultType(options.httpStatus, options.code);
  }

  private resolveDefaultType(status: number, code: string): GatewayErrorType {
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 409 || status === 429) return 'requests';
    if (status === 502) return 'provider_error';
    if (status === 503) return code === 'provider_unavailable' ? 'provider_error' : 'requests';
    if (status === 504) return 'server_error';
    return 'invalid_request_error';
  }

  public toResponseObject(): PublicErrorPayload {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

export function createInvalidRequestError(message: string, param: string | null = null): GatewayError {
  return new GatewayError({
    message,
    httpStatus: 400,
    code: 'invalid_request',
    type: 'invalid_request_error',
    param,
  });
}

export function createUnsupportedFeatureError(featureName: string): GatewayError {
  return new GatewayError({
    message: `The feature '${featureName}' is not supported in the MVP specification.`,
    httpStatus: 400,
    code: 'unsupported_feature',
    type: 'invalid_request_error',
    param: featureName,
  });
}

export function createPayloadTooLargeError(): GatewayError {
  return new GatewayError({
    message: 'Payload exceeds the 1 MiB (1,048,576 bytes) limit.',
    httpStatus: 413,
    code: 'payload_too_large',
    type: 'invalid_request_error',
    param: null,
  });
}
