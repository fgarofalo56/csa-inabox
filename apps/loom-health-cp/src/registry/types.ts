import { z } from 'zod';
import type { Doc } from '../store/types.js';

// Identity slugs: used in URLs (/{tenantSlug}/fhir) and resource names, so they
// are lowercase DNS-label-like. Anything else is rejected before it reaches a
// store key or a routing map.
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
const slug = z.string().regex(SLUG, 'must be 2-40 chars of a-z, 0-9 and hyphen, not starting or ending with hyphen');

export const STAMP_STATUSES = ['creating', 'healthy', 'draining', 'paused', 'evacuated'] as const;
export type StampStatus = (typeof STAMP_STATUSES)[number];

export const TENANT_STATUSES = ['creating', 'active', 'draining', 'suspended', 'destroying'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

const httpsUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, 'must be an https URL without credentials, query or fragment');

const text = z.string().trim().min(1).max(120);

export const StampCreateSchema = z.strictObject({
  id: slug,
  displayName: text,
  cloud: z.enum(['commercial', 'gcc', 'gcc-high', 'il5', 'dod']),
  region: z.string().regex(/^[a-z0-9]{3,30}$/),
  class: z.enum(['S', 'M', 'L']),
  baseUrl: httpsUrl,
});

export const StampPatchSchema = z
  .strictObject({
    displayName: text,
    status: z.enum(STAMP_STATUSES),
    class: z.enum(['S', 'M', 'L']),
    baseUrl: httpsUrl,
    deploySha: z.string().regex(/^[0-9a-f]{7,40}$/),
    engineVersions: z.record(z.string().max(60), z.string().max(60)).refine((r) => Object.keys(r).length <= 20),
    pauseReason: z.string().trim().min(1).max(200),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'at least one field is required');

const QuotasSchema = z.strictObject({
  maxRequestsPerMinute: z.number().int().min(1).max(1_000_000),
  maxStorageGiB: z.number().int().min(1).max(10_000_000),
});

export const TenantCreateSchema = z.strictObject({
  id: slug,
  displayName: text,
  stampId: slug,
  quotas: QuotasSchema,
});

export const TenantPatchSchema = z
  .strictObject({
    displayName: text,
    status: z.enum(TENANT_STATUSES),
    quotas: QuotasSchema,
    policyBundleVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    drainTargetStampId: slug,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'at least one field is required');

export interface StampDoc extends Doc {
  displayName: string;
  cloud: 'commercial' | 'gcc' | 'gcc-high' | 'il5' | 'dod';
  region: string;
  class: 'S' | 'M' | 'L';
  status: StampStatus;
  baseUrl: string;
  deploySha?: string;
  engineVersions: Record<string, string>;
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface TenantDoc extends Doc {
  displayName: string;
  stampId: string;
  status: TenantStatus;
  quotas: { maxRequestsPerMinute: number; maxStorageGiB: number };
  policyBundleVersion?: string;
  drainTargetStampId?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}
