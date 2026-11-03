import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { ProjectDocument, ModelAliasDocument } from '@/lib/db/schema';

/**
 * Validates that a string is a valid MongoDB ObjectId.
 */
export const objectIdSchema = z.string().refine((val) => ObjectId.isValid(val), {
  message: 'Invalid ObjectId format',
});

/**
 * Schema for creating a new project.
 * Enforces positive integer limits for RPM and concurrency per Requirement 3 & PRD FR-005.
 */
export const createProjectSchema = z.object({
  name: z
    .string({ required_error: 'Project name is required' })
    .trim()
    .min(1, 'Project name cannot be empty')
    .max(100, 'Project name cannot exceed 100 characters'),
  description: z
    .string()
    .trim()
    .max(500, 'Description cannot exceed 500 characters')
    .optional(),
  status: z.enum(['active', 'disabled']).default('active'),
  rpmLimit: z
    .number({ invalid_type_error: 'rpmLimit must be a number' })
    .int('rpmLimit must be an integer')
    .positive('rpmLimit must be a positive integer (> 0)')
    .default(60),
  concurrencyLimit: z
    .number({ invalid_type_error: 'concurrencyLimit must be a number' })
    .int('concurrencyLimit must be an integer')
    .positive('concurrencyLimit must be a positive integer (> 0)')
    .default(5),
  allowedModels: z
    .array(z.string().trim().min(1, 'Model alias identifier cannot be empty'))
    .min(1, 'allowedModels must contain at least one model alias')
    .default(['gemini-default']),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateProjectOutput = z.output<typeof createProjectSchema>;

/**
 * Schema for updating an existing project.
 * All fields are optional, but at least one must be provided.
 */
export const updateProjectSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Project name cannot be empty')
      .max(100, 'Project name cannot exceed 100 characters')
      .optional(),
    description: z
      .string()
      .trim()
      .max(500, 'Description cannot exceed 500 characters')
      .optional(),
    status: z.enum(['active', 'disabled']).optional(),
    rpmLimit: z
      .number({ invalid_type_error: 'rpmLimit must be a number' })
      .int('rpmLimit must be an integer')
      .positive('rpmLimit must be a positive integer (> 0)')
      .optional(),
    concurrencyLimit: z
      .number({ invalid_type_error: 'concurrencyLimit must be a number' })
      .int('concurrencyLimit must be an integer')
      .positive('concurrencyLimit must be a positive integer (> 0)')
      .optional(),
    allowedModels: z
      .array(z.string().trim().min(1, 'Model alias identifier cannot be empty'))
      .min(1, 'allowedModels must contain at least one model alias')
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/**
 * Schema for model alias definition.
 * Stores the actual Gemini upstream model and explicit bound credential ID per Requirement 3, AC 1.
 */
export const modelAliasSchema = z.object({
  projectId: z.union([objectIdSchema, z.instanceof(ObjectId)]),
  alias: z
    .string({ required_error: 'alias identifier is required' })
    .trim()
    .min(1, 'alias cannot be empty')
    .max(100, 'alias cannot exceed 100 characters'),
  upstreamModel: z
    .string({ required_error: 'upstreamModel is required' })
    .trim()
    .min(1, 'upstreamModel cannot be empty')
    .max(100, 'upstreamModel cannot exceed 100 characters'),
  boundCredentialId: z.union([objectIdSchema, z.instanceof(ObjectId)], {
    required_error: 'boundCredentialId is required',
  }),
  status: z.enum(['active', 'disabled']).default('active'),
});

export type ModelAliasInput = z.infer<typeof modelAliasSchema>;

/**
 * Formats a ProjectDocument for public JSON responses.
 */
export function formatProjectResponse(project: ProjectDocument) {
  return {
    id: project._id?.toString(),
    name: project.name,
    description: project.description ?? null,
    status: project.status,
    rpmLimit: project.rpmLimit,
    concurrencyLimit: project.concurrencyLimit,
    allowedModels: project.allowedModels,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/**
 * Formats a ModelAliasDocument for public JSON responses.
 */
export function formatModelAliasResponse(alias: ModelAliasDocument) {
  return {
    id: alias._id?.toString(),
    projectId: alias.projectId.toString(),
    alias: alias.alias,
    upstreamModel: alias.upstreamModel,
    boundCredentialId: alias.boundCredentialId.toString(),
    status: alias.status,
    createdAt: alias.createdAt.toISOString(),
    updatedAt: alias.updatedAt.toISOString(),
  };
}
