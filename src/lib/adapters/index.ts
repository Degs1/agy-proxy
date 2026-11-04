export * from './types';
export * from './gemini';
export * from './antigravity';

import { ProviderAdapter, ProviderUnavailableError } from './types';
import { geminiAdapter } from './gemini';
import { antigravityAdapter } from './antigravity';

/**
 * Returns the registered adapter for the given provider type.
 * Supports official Gemini API and Google Antigravity OAuth.
 */
export function getProviderAdapter(providerType: string): ProviderAdapter {
  if (providerType === 'gemini') {
    return geminiAdapter;
  }
  if (providerType === 'antigravity') {
    return antigravityAdapter;
  }
  throw new ProviderUnavailableError(
    `Provider adapter '${providerType}' is unsupported for MVP.`
  );
}
