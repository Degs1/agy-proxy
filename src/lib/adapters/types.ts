/**
 * Generic provider adapter types and interfaces.
 * Defines standard contracts for request mapping, execution, normalization, streaming, and error handling.
 * Per Requirement 4 (AC 1-4), Requirement 5 (AC 1-5), and Approved Design.
 */

export interface AdapterChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AdapterRequest {
  model: string; // The requested model alias (e.g. "gemini-default")
  messages: AdapterChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface AdapterContext {
  secret: string; // Decrypted credential secret
  upstreamModel: string; // Actual upstream model name (e.g. "gemini-1.5-flash")
  signal?: AbortSignal;
  id?: string;
  created?: number;
  onRefreshToken?: () => Promise<string>;
}

export interface UsageMetadata {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: 0;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: 'stop' | 'length';
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [ChatCompletionChoice];
  usage: UsageMetadata | null;
}

export interface ChatCompletionChunkChoice {
  index: 0;
  delta: {
    role?: 'assistant';
    content?: string;
  };
  finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: [ChatCompletionChunkChoice];
  usage?: UsageMetadata | null;
}

// Stream events emitted by adapter
export type StreamEvent =
  | { type: 'chunk'; chunk: ChatCompletionChunk }
  | { type: 'error'; error: AdapterError }
  | { type: 'done' };

/**
 * Standard Adapter Error class conforming to OpenAI error response envelope:
 * { "error": { "message": string, "type": string, "param": string | null, "code": string } }
 * Guarantees zero credential leakage.
 */
export class AdapterError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly errorType: string;
  public readonly param: string | null;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    errorType = 'provider_error',
    param: string | null = null
  ) {
    super(message);
    this.name = 'AdapterError';
    this.statusCode = statusCode;
    this.code = code;
    this.errorType = errorType;
    this.param = param;
  }

  toResponseJson() {
    return {
      error: {
        message: this.message,
        type: this.errorType,
        param: this.param,
        code: this.code,
      },
    };
  }
}

/**
 * HTTP 502: Provider output blocked by safety or policy.
 */
export class ProviderOutputBlockedError extends AdapterError {
  constructor(message = 'Provider output blocked due to safety or policy.') {
    super(message, 502, 'provider_output_blocked', 'provider_error', null);
    this.name = 'ProviderOutputBlockedError';
  }
}

/**
 * HTTP 502: Provider returned an empty response.
 */
export class ProviderEmptyResponseError extends AdapterError {
  constructor(message = 'Provider returned empty response.') {
    super(message, 502, 'provider_empty_response', 'provider_error', null);
    this.name = 'ProviderEmptyResponseError';
  }
}

/**
 * HTTP 502: Provider returned an error (upstream 5xx / rejection / unhandled non-text / unknown finish reason).
 */
export class ProviderError extends AdapterError {
  constructor(message = 'Provider failed to process request.', code = 'provider_error') {
    super(message, 502, code, 'provider_error', null);
    this.name = 'ProviderError';
  }
}

/**
 * HTTP 503: Provider unreachable (network / connection / DNS failure).
 */
export class ProviderUnavailableError extends AdapterError {
  constructor(message = 'Provider is unreachable.') {
    super(message, 503, 'provider_unavailable', 'provider_unavailable', null);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Generic Provider Adapter Interface.
 * Allows adding new provider implementations without altering the public REST contract.
 */
export interface ProviderAdapter {
  readonly providerType: string;
  executeNonStream(request: AdapterRequest, context: AdapterContext): Promise<ChatCompletionResponse>;
  executeStream(request: AdapterRequest, context: AdapterContext): AsyncGenerator<StreamEvent, void, unknown>;
}
