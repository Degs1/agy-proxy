/**
 * Authentication and Security Configuration
 */

export interface AuthConfig {
  appOrigin: string;
  authSecret: string;
  cookieSecure: boolean;
}

export function normalizeOrigin(urlOrOrigin: string): string {
  try {
    const parsed = new URL(urlOrOrigin);
    return parsed.origin.toLowerCase();
  } catch {
    return urlOrOrigin.trim().toLowerCase().replace(/\/+$/, '');
  }
}

export function getAuthConfig(): AuthConfig {
  const rawOrigin =
    process.env.APP_ORIGIN ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000';
  const appOrigin = normalizeOrigin(rawOrigin);

  const authSecret =
    process.env.AUTH_SECRET ||
    process.env.SESSION_SECRET ||
    'default_dev_secret_must_be_at_least_32_bytes_long_1234567890';

  const isProd = process.env.NODE_ENV === 'production';
  const cookieSecure =
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === 'true'
      : isProd;

  return {
    appOrigin,
    authSecret,
    cookieSecure,
  };
}
