import { NextRequest, NextResponse } from 'next/server';
import { Db, ClientSession } from 'mongodb';
import { COLLECTIONS, ApiKeyDocument, ProjectDocument } from '@/lib/db/schema';
import { hashApiKey, isValidApiKeyFormat } from '@/lib/api-keys/crypto';

export interface ApiKeyAuthContext {
  valid: true;
  apiKey: ApiKeyDocument;
  project: ProjectDocument;
}

export interface ApiKeyAuthError {
  valid: false;
  status: 401 | 403;
  code: 'invalid_api_key' | 'project_disabled';
  message: string;
  response: NextResponse;
}

export type ApiKeyAuthResult = ApiKeyAuthContext | ApiKeyAuthError;

/**
 * Builds standard RFC/OpenAI compatible error response per Requirement 5, AC 3.
 * Format: { error: { message, type, param: null, code } }
 */
export function buildGatewayAuthErrorResponse(
  status: 401 | 403,
  code: 'invalid_api_key' | 'project_disabled',
  message: string
): NextResponse {
  return NextResponse.json(
    {
      error: {
        message,
        type: 'invalid_request_error',
        param: null,
        code,
      },
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Verifies a raw bearer token string against Atlas database collections.
 * Handles one-way hash lookup, revocation check, expiration, and project status.
 */
export async function verifyApiKeyToken(
  db: Db,
  bearerToken: string,
  options?: { session?: ClientSession }
): Promise<ApiKeyAuthResult> {
  const sessionOptions = options?.session ? { session: options.session } : {};

  // 1. Format check: Bearer token must match canonical "agw_<64-hex>" format.
  // Directly prevents using raw SHA-256 hashes (which do not have 'agw_' prefix) as bearer keys.
  if (!isValidApiKeyFormat(bearerToken)) {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'Invalid API key format or credentials.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'Invalid API key format or credentials.'
      ),
    };
  }

  // 2. Compute one-way SHA-256 hash
  const computedHash = hashApiKey(bearerToken);

  // 3. Look up API key by hash
  const apiKey = await db
    .collection<ApiKeyDocument>(COLLECTIONS.API_KEYS)
    .findOne({ keyHash: computedHash }, sessionOptions);

  if (!apiKey) {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'Invalid API key.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'Invalid API key.'
      ),
    };
  }

  // 4. Verify revocation status (Requirement 3.3 & PRD FR-006)
  if (apiKey.status === 'revoked') {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'API key has been revoked.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'API key has been revoked.'
      ),
    };
  }

  // 5. Verify expiration if set
  if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'API key has expired.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'API key has expired.'
      ),
    };
  }

  // 6. Look up owning project
  const project = await db
    .collection<ProjectDocument>(COLLECTIONS.PROJECTS)
    .findOne({ _id: apiKey.projectId }, sessionOptions);

  if (!project) {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'Associated project not found.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'Associated project not found.'
      ),
    };
  }

  // 7. Verify project active status (Requirement 3, AC 3)
  if (project.status === 'disabled') {
    return {
      valid: false,
      status: 403,
      code: 'project_disabled',
      message: 'Project is disabled.',
      response: buildGatewayAuthErrorResponse(
        403,
        'project_disabled',
        'Project is disabled.'
      ),
    };
  }

  return {
    valid: true,
    apiKey,
    project,
  };
}

/**
 * Extracts and authenticates Bearer API Key from an incoming HTTP request.
 * Enforces TC-REQ5-AUTH-01 through TC-REQ5-AUTH-04 and TC-REQ5-AUTH-07.
 */
export async function authenticateApiKeyRequest(
  request: Request | NextRequest,
  db: Db,
  options?: { session?: ClientSession }
): Promise<ApiKeyAuthResult> {
  const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');

  // TC-REQ5-AUTH-01: Header Auth missing
  if (!authHeader) {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'Authorization header is missing.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'Authorization header is missing.'
      ),
    };
  }

  // TC-REQ5-AUTH-02: Format must be "Bearer <token>"
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return {
      valid: false,
      status: 401,
      code: 'invalid_api_key',
      message: 'Authorization format must be Bearer <API_KEY>.',
      response: buildGatewayAuthErrorResponse(
        401,
        'invalid_api_key',
        'Authorization format must be Bearer <API_KEY>.'
      ),
    };
  }

  const bearerToken = match[1].trim();
  return verifyApiKeyToken(db, bearerToken, options);
}
