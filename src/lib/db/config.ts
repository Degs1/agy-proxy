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
 * For unparseable or unrecognized inputs without a valid URI scheme, returns the fixed marker '[invalid-uri]'.
 */
export function maskMongoUri(uri: string): string {
  if (!uri || typeof uri !== 'string' || uri.trim() === '') {
    return '[invalid-uri]';
  }

  const trimmed = uri.trim();

  try {
    // A valid URI must start with a recognized scheme prefix: <scheme>://
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(.*)$/s);
    if (!schemeMatch) {
      // Input has no valid URI scheme structure (e.g. 'not-a-valid-uri', bare password, token)
      return '[invalid-uri]';
    }

    const scheme = schemeMatch[1];
    const remainder = schemeMatch[2];

    // Separate query string if present
    const questionIdx = remainder.indexOf('?');
    const mainPart = questionIdx !== -1 ? remainder.slice(0, questionIdx) : remainder;
    const queryString = questionIdx !== -1 ? remainder.slice(questionIdx + 1) : null;

    // Separate authority from path
    const slashIdx = mainPart.indexOf('/');
    const authority = slashIdx !== -1 ? mainPart.slice(0, slashIdx) : mainPart;
    const path = slashIdx !== -1 ? mainPart.slice(slashIdx) : '';

    let sanitizedAuthority: string;

    if (authority.includes('@')) {
      // Handles authority with credentials.
      // If there are multiple '@' characters (e.g. unencoded '@' in username/password,
      // or malformed host injection), the LAST '@' denotes the boundary to the host(s).
      // Everything before the last '@' constitutes userinfo credentials and MUST be masked.
      const lastAtIndex = authority.lastIndexOf('@');
      let hostPart = authority.slice(lastAtIndex + 1).trim();

      if (!hostPart) {
        hostPart = '[invalid-host]';
      } else {
        // Sanitize host part in case port contains passwords instead of numbers
        // e.g. host:secretpassword or multiple colons
        hostPart = hostPart
          .split(',')
          .map((h) => {
            const trimmedHost = h.trim();
            const lastColon = trimmedHost.lastIndexOf(':');
            if (lastColon !== -1) {
              const hostName = trimmedHost.slice(0, lastColon);
              const port = trimmedHost.slice(lastColon + 1);
              if (!/^\d+$/.test(port)) {
                return `${hostName}:***`;
              }
            }
            return trimmedHost;
          })
          .join(',');
      }

      sanitizedAuthority = `***:***@${hostPart}`;
    } else {
      // Authority has no '@'.
      // Check if it looks like malformed credentials without host, e.g. 'username:password'
      // where the part after colon is not a valid numeric port.
      const lastColon = authority.lastIndexOf(':');
      if (lastColon !== -1) {
        const potentialPort = authority.slice(lastColon + 1);
        if (!/^\d+$/.test(potentialPort)) {
          // Non-numeric port in authority without '@' is suspicious credentials (e.g. user:password/db)
          sanitizedAuthority = '***:***@[invalid-host]';
        } else {
          sanitizedAuthority = authority;
        }
      } else if (!authority.trim()) {
        sanitizedAuthority = '[invalid-authority]';
      } else {
        sanitizedAuthority = authority;
      }
    }

    // Sanitize query parameters so values (and bare parameters without '=') are never leaked
    let sanitizedQuery = '';
    if (queryString !== null) {
      sanitizedQuery =
        '?' +
        queryString
          .split('&')
          .map((param) => {
            if (!param) return '';
            const eqIdx = param.indexOf('=');
            if (eqIdx === -1) {
              // Bare parameter without '=' could be a secret token! Mask it completely.
              return '***';
            }
            const key = param.slice(0, eqIdx);
            return `${key}=***`;
          })
          .join('&');
    }

    return `${scheme}${sanitizedAuthority}${path}${sanitizedQuery}`;
  } catch {
    return '[invalid-uri]';
  }
}

/**
 * Safely sanitizes diagnostic messages or driver error strings so that embedded URIs,
 * usernames, passwords, or query parameter secrets are removed.
 */
export function sanitizeDiagnosticText(text: string): string {
  if (!text || typeof text !== 'string') return '';
  // Replace URIs with maskMongoUri
  let sanitized = text.replace(
    /(mongodb(?:\+srv)?:\/\/[^\s"'<>]+)/gi,
    (m) => maskMongoUri(m)
  );
  // Also sanitize any remaining authority patterns with multiple @
  sanitized = sanitized.replace(
    /([a-zA-Z0-9+.-]+:\/\/)(?:[^@/\s]+@)+/gi,
    '$1***:***@'
  );
  // Sanitize any remaining query parameter values
  sanitized = sanitized.replace(/([?&][^=]+)=[^&#\s]*/g, '$1=***');
  return sanitized;
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

    // Public error message is constant and NEVER contains raw or partial URIs to guarantee zero leak.
    // sanitizedUri contains the fully masked URI or '[invalid-uri]' marker.
    throw new DatabaseConfigError(
      'Database configuration error: Invalid MONGODB_URI format. URI must be a valid mongodb:// or mongodb+srv:// connection string.',
      'INVALID_MONGODB_URI',
      sanitized
    );
  }

  return result.data;
}
