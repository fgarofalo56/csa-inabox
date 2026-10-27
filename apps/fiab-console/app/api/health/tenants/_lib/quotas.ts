/**
 * Tenant quota validation. Bounds mirror the control plane's QuotasSchema
 * (apps/loom-health-cp/src/registry/types.ts) so the editor gets a precise 400
 * here; the control plane remains the authority and re-validates.
 */
export const QUOTA_BOUNDS = {
  maxRequestsPerMinute: { min: 1, max: 1_000_000 },
  maxStorageGiB: { min: 1, max: 10_000_000 },
} as const;

export interface Quotas { maxRequestsPerMinute: number; maxStorageGiB: number }

export function parseQuotas(body: unknown): { quotas: Quotas } | { error: string } {
  const q = (body as { quotas?: Record<string, unknown> } | null)?.quotas;
  if (!q || typeof q !== 'object') return { error: 'quotas: an object with maxRequestsPerMinute and maxStorageGiB is required' };
  const out: Partial<Quotas> = {};
  for (const key of ['maxRequestsPerMinute', 'maxStorageGiB'] as const) {
    const v = q[key];
    const { min, max } = QUOTA_BOUNDS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      return { error: `quotas.${key}: must be an integer from ${min} to ${max}` };
    }
    out[key] = v;
  }
  return { quotas: out as Quotas };
}
