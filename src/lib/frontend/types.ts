export interface AdminUser {
  id: string;
  email: string;
  role: 'admin';
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'disabled';
  rpmLimit: number;
  concurrencyLimit: number;
  allowedModels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyItem {
  id: string;
  projectId: string;
  name: string;
  keyPrefix: string;
  status: 'active' | 'revoked';
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCredential {
  id: string;
  projectId: string;
  provider: string;
  displayName: string;
  credentialType: string;
  status: 'active' | 'disabled';
  keyVersion: number;
  maxConcurrent: number | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelAlias {
  id: string;
  projectId: string;
  alias: string;
  upstreamModel: string;
  boundCredentialId: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryAfter?: number;
  issues?: unknown[];
}
