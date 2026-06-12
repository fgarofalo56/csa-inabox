/**
 * Server-side helper: load the tenant's business-domain list from Cosmos
 * (`tenant-settings` doc `domains:<tenantId>`) in the shape the D2 tier resolver
 * needs. Used by routes that must run a tier check but don't otherwise touch the
 * domains doc (the DLZ capacity panes, workspace member management). Returns []
 * when the doc doesn't exist yet (404) so callers can fail closed cleanly.
 */
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { DomainTierDomain } from './domain-role';

export type LoadedDomain = DomainTierDomain & { id: string; name?: string };

export async function loadTenantDomains(tenantId: string): Promise<LoadedDomain[]> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(`domains:${tenantId}`, tenantId).read<{ items?: LoadedDomain[] }>();
    return (resource?.items || []) as LoadedDomain[];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}
