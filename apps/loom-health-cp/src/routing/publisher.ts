// Builds the tenant -> stamp routing map from the registries (ADR-006) and
// publishes it as the single 'current' document. The edge (W1-6) consumes it
// with a 60 s cache and last-known-good; this side adds its own guard: an
// empty result never replaces a non-empty published map.

import { createHash } from 'node:crypto';
import { conflict } from '../http/errors.js';
import type { StampDoc, TenantDoc } from '../registry/types.js';
import type { Collection } from '../store/types.js';
import type { RoutingEntry, RoutingMapDoc } from './types.js';

export const ROUTING_CACHE_TTL_SECONDS = 60;
export const PAUSED_RETRY_AFTER_SECONDS = 60;

export interface BuiltMap {
  entries: RoutingEntry[];
  /** Tenants left out of the map, with the reason (ids only, no clinical data). */
  skipped: { tenantSlug: string; reason: string }[];
}

export function buildRoutingMap(stamps: StampDoc[], tenants: TenantDoc[]): BuiltMap {
  const byId = new Map(stamps.map((s) => [s.id, s]));
  const entries: RoutingEntry[] = [];
  const skipped: BuiltMap['skipped'] = [];

  for (const t of [...tenants].sort((a, b) => a.id.localeCompare(b.id))) {
    if (t.status === 'destroying') {
      skipped.push({ tenantSlug: t.id, reason: 'tenant-destroying' });
      continue;
    }
    // A draining tenant keeps routing to its SOURCE stamp until cutover (ADR-006).
    const stamp = byId.get(t.stampId);
    if (!stamp) {
      skipped.push({ tenantSlug: t.id, reason: 'stamp-not-registered' });
      continue;
    }
    const base = { tenantSlug: t.id, stampId: stamp.id, stampBaseUrl: stamp.baseUrl };
    if (stamp.status === 'paused') {
      entries.push({
        ...base,
        status: 'paused',
        retryAfterSeconds: PAUSED_RETRY_AFTER_SECONDS,
        reason: stamp.pauseReason ?? 'stamp-paused',
      });
    } else if (stamp.status === 'creating' || stamp.status === 'evacuated') {
      entries.push({ ...base, status: 'unavailable', reason: `stamp-${stamp.status}` });
    } else if (t.status === 'creating') {
      entries.push({ ...base, status: 'unavailable', reason: 'tenant-provisioning' });
    } else if (t.status === 'suspended') {
      entries.push({ ...base, status: 'unavailable', reason: 'tenant-suspended' });
    } else {
      entries.push({ ...base, status: 'active' });
    }
  }
  return { entries, skipped };
}

export function versionOf(entries: RoutingEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export interface PublishResult {
  published: boolean;
  version: string;
  entryCount: number;
  skipped: BuiltMap['skipped'];
}

export class RoutingPublisher {
  constructor(
    private readonly stamps: Collection<StampDoc>,
    private readonly tenants: Collection<TenantDoc>,
    private readonly routing: Collection<RoutingMapDoc>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  current(): Promise<RoutingMapDoc | undefined> {
    return this.routing.get('current');
  }

  async publish(): Promise<PublishResult> {
    const [stamps, tenants, existing] = await Promise.all([
      this.stamps.list(500),
      this.tenants.list(500),
      this.current(),
    ]);
    const { entries, skipped } = buildRoutingMap(stamps, tenants);
    const version = versionOf(entries);
    if (entries.length === 0 && existing && existing.entries.length > 0) {
      throw conflict('refusing to replace a non-empty routing map with an empty one');
    }
    if (existing && existing.version === version) {
      return { published: false, version, entryCount: entries.length, skipped };
    }
    await this.routing.upsert({
      id: 'current',
      version,
      generatedAt: this.now().toISOString(),
      cacheTtlSeconds: ROUTING_CACHE_TTL_SECONDS,
      entries,
    });
    return { published: true, version, entryCount: entries.length, skipped };
  }
}
