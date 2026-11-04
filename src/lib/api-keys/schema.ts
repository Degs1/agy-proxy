import { z } from 'zod';
import { ApiKeyDocument } from '@/lib/db/schema';

/**
 * Validation schema for creating a project API key.
 * Allows optional or null expiresAt for permanent keys.
 */
export const createApiKeySchema = z.object({
  name: z
    .string({ required_error: 'Key name is required' })
    .trim()
    .min(1, 'Key name cannot be empty')
    .max(100, 'Key name cannot exceed 100 characters'),
  expiresAt: z
    .string()
    .datetime({ message: 'expiresAt must be a valid ISO 8601 date string' })
    .transform((val) => new Date(val))
    .refine((date) => date.getTime() > Date.now(), {
      message: 'expiresAt must be in the future',
    })
    .nullish()
    .transform((val) => (val ? val : undefined)),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/**
 * Public response format for an API key.
 * Never leaks the plaintext secret or stored hash.
 */
export function formatApiKeyResponse(apiKey: ApiKeyDocument) {
  return {
    id: apiKey._id?.toString(),
    projectId: apiKey.projectId.toString(),
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    status: apiKey.status,
    expiresAt: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
    lastUsedAt: apiKey.lastUsedAt ? apiKey.lastUsedAt.toISOString() : null,
    createdAt: apiKey.createdAt.toISOString(),
  };
}
