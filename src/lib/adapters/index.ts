export * from './types';
export * from './gemini';

import { ProviderAdapter, ProviderUnavailableError } from './types';
import { geminiAdapter } from './gemini';

/**
 * Returns the registered adapter for the given provider type.
 * For MVP, Gemini API is the only supported active provider.
 * Any other provider (including Antigravity) is rejected with provider_unavailable.
 */
export function getProviderAdapter(providerType: string): ProviderAdapter {
  if (providerType === 'gemini') {
    return geminiAdapter;
  }
  throw new ProviderUnavailableError(
    `Provider adapter '${providerType}' is unsupported for MVP.`
  );
}

