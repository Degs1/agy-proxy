import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { ProviderCredentialDocument } from '@/lib/db/schema';
import { objectIdSchema } from '@/lib/projects/schema';

/**
 * Validation schema for creating a new provider credential.
 * Plaintext secret is encrypted before storage and never returned in responses.
 */
export const createCredentialSchema = z.object({
  displayName: z
    .string({ required_error: 'displayName is required' })
    .trim()
    .min(1, 'displayName cannot be empty')
    .max(100, 'displayName cannot exceed 100 characters'),
  provider: z
    .string({ required_error: 'provider is required' })
    .trim()
    .min(1, 'provider cannot be empty')
    .default('gemini'),
  credentialType: z.enum(['api_key', 'oauth']).default('api_key'),
  secret: z
    .string({ required_error: 'secret is required' })
    .trim()
    .min(1, 'secret cannot be empty'),
  status: z.enum(['active', 'disabled']).default('active'),
  maxConcurrent: z
    .number({ invalid_type_error: 'maxConcurrent must be a number' })
    .int('maxConcurrent must be an integer')
    .positive('maxConcurrent must be positive')
    .optional(),
});

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

/**
 * Validation schema for updating a provider credential.
 */
export const updateCredentialSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'displayName cannot be empty')
      .max(100, 'displayName cannot exceed 100 characters')
      .optional(),
    status: z.enum(['active', 'disabled']).optional(),
    secret: z
      .string()
      .trim()
      .min(1, 'secret cannot be empty')
      .optional(),
    maxConcurrent: z
      .number()
      .int('maxConcurrent must be an integer')
      .positive('maxConcurrent must be positive')
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;

/**
 * Public response format for ProviderCredentialDocument.
 * STRICT SECURITY REQUIREMENT:
 * Ciphertext, IV, authTag, and plaintext secrets SHALL NEVER be exposed
 * in JSON responses, logs, or dashboards (Requirement 3, AC 4; PRD 10.1).
 */
export function formatCredentialResponse(cred: ProviderCredentialDocument) {
  return {
    id: cred._id?.toString(),
    projectId: cred.projectId.toString(),
    provider: cred.provider,
    displayName: cred.displayName,
    credentialType: cred.credentialType,
    status: cred.status,
    keyVersion: cred.encryptedCredentials.keyVersion,
    maxConcurrent: cred.maxConcurrent ?? null,
    lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.toISOString() : null,
    createdAt: cred.createdAt.toISOString(),
    updatedAt: cred.updatedAt.toISOString(),
  };
}
