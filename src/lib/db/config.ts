import { z } from 'zod';

export type DatabaseConfigErrorCode = 'MISSING_MONGODB_URI' | 'INVALID_MONGODB_URI';

export class DatabaseConfigError extends Error {
  public readonly code: DatabaseConfigErrorCode;
  public readonly sanitizedUri?: string;

  constructor(message: string, code: DatabaseConfigErrorCode, sanitizedUri?: string) {
    super(message);
    this.name = 'DatabaseConfigError';
    this.code = code;
    this.sanitizedUri = sanitizedUri;
  }
}

/**
 * Mask sensitive credentials and query parameters from any MongoDB connection string.
 * Strips username/password and masks all query parameter values so no secrets leak into logs or diagnostics.
 */
export function maskMongoUri(uri: string): string {
  if (!uri || typeof uri !== 'string') {
    return '[invalid-uri]';
  }

  try {
    // 1. Mask user credentials in authority: scheme://[credentials@]host
    let masked = uri.replace(
      /^([a-zA-Z0-9+.-]+:\/\/)([^@/\s]+)@/i,
      (_match, scheme) => `${scheme}***:***@`
    );

    // 2. Mask query string parameter values: key=val -> key=***
    const questionIdx = masked.indexOf('?');
    if (questionIdx !== -1) {
      const base = masked.slice(0, questionIdx);
      const queryString = masked.slice(questionIdx + 1);
      const maskedParams = queryString
        .split('&')
        .map((pair) => {
          const eqIdx = pair.indexOf('=');
          if (eqIdx === -1) return pair;
          const key = pair.slice(0, eqIdx);
          return `${key}=***`;
        })
        .join('&');
      masked = `${base}?${maskedParams}`;
    }

    return masked;
  } catch {
    return '***://***:***@masked-host';
  }
}

const DatabaseConfigSchema = z.object({
  uri: z
    .string({
      required_error: 'MONGODB_URI is not configured in the environment',
      invalid_type_error: 'MONGODB_URI must be a string',
    })
    .trim()
    .min(1, 'MONGODB_URI is not configured in the environment')
    .refine(
      (val) => {
        if (!val.startsWith('mongodb://') && !val.startsWith('mongodb+srv://')) {
          return false;
        }
        try {
          const parsed = new URL(val);
          if (!parsed.host) return false;
          // MongoDB connection string requires '/' before query parameters
          const hostAndAfter = val.slice(val.indexOf('://') + 3);
          const slashIdx = hostAndAfter.indexOf('/');
          const questionIdx = hostAndAfter.indexOf('?');
          if (questionIdx !== -1 && (slashIdx === -1 || questionIdx < slashIdx)) {
            return false;
          }
          if (parsed.search.startsWith('??') || parsed.search.includes('&&')) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      {
        message: 'MONGODB_URI must be a valid mongodb:// or mongodb+srv:// connection URI',
      }
    ),
  dbName: z.string().trim().min(1).default('antigravity_gateway'),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export function getDatabaseConfig(): DatabaseConfig {
  const rawUri = process.env.MONGODB_URI;
  const rawDbName = process.env.MONGODB_DB_NAME || 'antigravity_gateway';

  if (!rawUri || rawUri.trim() === '') {
    throw new DatabaseConfigError(
      'Database configuration error: MONGODB_URI is not configured in the environment. Operations requiring Atlas fail safely.',
      'MISSING_MONGODB_URI'
    );
  }

  const result = DatabaseConfigSchema.safeParse({
    uri: rawUri,
    dbName: rawDbName,
  });

  if (!result.success) {
    const issue = result.error.issues[0];
    const isMissing = issue?.message.includes('not configured');
    const sanitized = maskMongoUri(rawUri);

    if (isMissing) {
      throw new DatabaseConfigError(
        'Database configuration error: MONGODB_URI is not configured in the environment.',
        'MISSING_MONGODB_URI'
      );
    }

    // Public error message is constant and NEVER contains raw or partial URIs to guarantee zero leak
    throw new DatabaseConfigError(
      'Database configuration error: Invalid MONGODB_URI format. URI must be a valid mongodb:// or mongodb+srv:// connection string.',
      'INVALID_MONGODB_URI',
      sanitized
    );
  }

  return result.data;
}
