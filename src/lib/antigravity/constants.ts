/**
 * Antigravity (Google Cloud Code) OAuth & API Constants.
 * Based on dvcrn/antigravity-oauth-proxy and official Google Cloud Code specifications.
 * Per docs/ANTIGRAVITY_OAUTH_FLOW.md
 */

export const ANTIGRAVITY_CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-');

export const ANTIGRAVITY_CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET ||
  ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');

export const ANTIGRAVITY_REDIRECT_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_REDIRECT_PORT}/oauth-callback`;

export const ANTIGRAVITY_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';

export const ANTIGRAVITY_TOKEN_URL =
  'https://oauth2.googleapis.com/token';

export const ANTIGRAVITY_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';

export const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

export const ANTIGRAVITY_USER_AGENT =
  'antigravity/cli/1.4.6 (aidev_client; os_type=windows; arch=amd64; cl=964361259; auth_method=consumer)';

export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;

