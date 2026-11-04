export interface AntigravityTokenPayload {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // Unix timestamp in milliseconds
  token_type: string;
  scope?: string;
  id_token?: string;
  project_id?: string; // GCP Project ID returned from loadCodeAssist
  email?: string; // Authenticated user's email
  tier?: string;
}

export interface OAuthSessionState {
  state: string;
  codeVerifier: string;
  projectId: string;
  displayName?: string;
  createdAt: number;
  status: 'pending' | 'completed' | 'error';
  error?: string;
  credentialId?: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleUserInfo {
  id?: string;
  email?: string;
  verified_email?: boolean;
  name?: string;
  picture?: string;
}

export interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  currentTier?: {
    tierId?: string;
  };
  gcpManaged?: boolean;
  [key: string]: unknown;
}

