import {
  createInvalidRequestError,
  createUnsupportedFeatureError,
} from './error';

export interface ValidatedChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ValidatedChatCompletionRequest {
  model: string;
  messages: ValidatedChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'temperature',
  'max_tokens',
]);

const UNSUPPORTED_FEATURES = new Set([
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'response_format',
  'logprobs',
  'stream_options',
  'n',
  'image_url',
]);

const ALLOWED_MESSAGE_FIELDS = new Set(['role', 'content']);
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
const MAX_MESSAGE_COUNT = 64;
const MAX_CONTENT_BYTES = 32 * 1024; // 32 KiB = 32,768 bytes

export function validateChatCompletionRequest(body: unknown): ValidatedChatCompletionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw createInvalidRequestError('Request body must be a JSON object.', null);
  }

  const raw = body as Record<string, unknown>;

  // Check top-level fields for unsupported features or unexpected fields
  for (const key of Object.keys(raw)) {
    if (UNSUPPORTED_FEATURES.has(key)) {
      throw createUnsupportedFeatureError(key);
    }
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      throw createInvalidRequestError(`Unrecognized request field: '${key}'.`, key);
    }
  }

  // 1. Validate 'model'
  if (!('model' in raw) || typeof raw.model !== 'string' || raw.model.trim() === '') {
    throw createInvalidRequestError("Field 'model' must be a non-empty string.", 'model');
  }
  const model = raw.model;

  // 2. Validate 'messages'
  if (!('messages' in raw) || !Array.isArray(raw.messages)) {
    throw createInvalidRequestError("Field 'messages' must be an array.", 'messages');
  }

  const rawMessages = raw.messages;
  if (rawMessages.length < 1 || rawMessages.length > MAX_MESSAGE_COUNT) {
    throw createInvalidRequestError(
      `Field 'messages' must contain between 1 and ${MAX_MESSAGE_COUNT} items.`,
      'messages'
    );
  }

  let hasUserMessage = false;

  for (let i = 0; i < rawMessages.length; i++) {
    const item = rawMessages[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw createInvalidRequestError(`Message at index ${i} must be an object.`, 'messages');
    }

    const msgObj = item as Record<string, unknown>;

    // Strict schema: only 'role' and 'content' allowed
    for (const key of Object.keys(msgObj)) {
      if (!ALLOWED_MESSAGE_FIELDS.has(key)) {
        throw createInvalidRequestError(
          `Message item contains unrecognized field: '${key}'.`,
          `messages[${i}].${key}`
        );
      }
    }

    // Role check
    if (!('role' in msgObj) || typeof msgObj.role !== 'string' || !ALLOWED_ROLES.has(msgObj.role)) {
      throw createInvalidRequestError(
        "Invalid message role. Supported roles are 'system', 'user', or 'assistant'.",
        `messages[${i}].role`
      );
    }

    const role = msgObj.role as 'system' | 'user' | 'assistant';
    if (role === 'user') {
      hasUserMessage = true;
    }

    // Content check
    if (!('content' in msgObj)) {
      throw createInvalidRequestError('Message content is missing.', `messages[${i}].content`);
    }

    const rawContent = msgObj.content;
    if (typeof rawContent !== 'string') {
      // Check if it looks like multimodal input
      if (typeof rawContent === 'object' && rawContent !== null) {
        throw createUnsupportedFeatureError(`messages[${i}].content`);
      }
      throw createInvalidRequestError('Message content must be a string.', `messages[${i}].content`);
    }

    if (rawContent === '') {
      throw createInvalidRequestError('Message content must not be empty.', `messages[${i}].content`);
    }

    const contentBytes = Buffer.byteLength(rawContent, 'utf8');
    if (contentBytes > MAX_CONTENT_BYTES) {
      throw createInvalidRequestError(
        `Message content exceeds maximum allowed size of 32 KiB (32,768 bytes).`,
        `messages[${i}].content`
      );
    }
  }

  // Message sequence rules
  if (!hasUserMessage) {
    throw createInvalidRequestError('Conversation must contain at least one user message.', 'messages');
  }

  if (rawMessages[0].role === 'assistant') {
    throw createInvalidRequestError('Conversation cannot start with assistant role.', 'messages[0].role');
  }

  let conversationStarted = false;
  let expectedRole: 'user' | 'assistant' = 'user';

  for (let i = 0; i < rawMessages.length; i++) {
    const role = rawMessages[i].role as 'system' | 'user' | 'assistant';

    if (!conversationStarted) {
      if (role === 'system') {
        continue;
      }
      if (role === 'user') {
        conversationStarted = true;
        expectedRole = 'assistant';
      }
    } else {
      if (role === 'system') {
        throw createInvalidRequestError(
          'System message cannot appear after conversation has started.',
          `messages[${i}].role`
        );
      }
      if (role !== expectedRole) {
        if (role === 'user') {
          throw createInvalidRequestError('Consecutive user messages are not allowed.', `messages[${i}].role`);
        } else {
          throw createInvalidRequestError('Consecutive assistant messages are not allowed.', `messages[${i}].role`);
        }
      }
      expectedRole = expectedRole === 'assistant' ? 'user' : 'assistant';
    }
  }

  const lastIndex = rawMessages.length - 1;
  if (rawMessages[lastIndex].role !== 'user') {
    throw createInvalidRequestError(
      'Conversation must end with a user message.',
      `messages[${lastIndex}].role`
    );
  }

  // 3. Validate 'stream'
  let stream: boolean | undefined = undefined;
  if ('stream' in raw) {
    if (typeof raw.stream !== 'boolean') {
      throw createInvalidRequestError("Field 'stream' must be a boolean.", 'stream');
    }
    stream = raw.stream;
  }

  // 4. Validate 'temperature'
  let temperature: number | undefined = undefined;
  if ('temperature' in raw) {
    const temp = raw.temperature;
    if (typeof temp !== 'number' || Number.isNaN(temp) || !Number.isFinite(temp) || temp < 0 || temp > 2) {
      throw createInvalidRequestError("Field 'temperature' must be a number between 0 and 2.", 'temperature');
    }
    temperature = temp;
  }

  // 5. Validate 'max_tokens'
  let max_tokens: number | undefined = undefined;
  if ('max_tokens' in raw) {
    const mt = raw.max_tokens;
    if (typeof mt !== 'number' || !Number.isInteger(mt) || mt < 1 || mt > 8192) {
      throw createInvalidRequestError("Field 'max_tokens' must be an integer between 1 and 8192.", 'max_tokens');
    }
    max_tokens = mt;
  }

  return {
    model,
    messages: rawMessages as ValidatedChatMessage[],
    stream,
    temperature,
    max_tokens,
  };
}
