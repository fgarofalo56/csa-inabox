/**
 * Production wiring for the environment routes.
 *
 * Catalog, leases and audit are Cosmos-backed here. The classification store,
 * the applied-publication port and the findings source belong to other lanes
 * (W1-2 registry, W2 publications, W1-3 inventory): they plug in through the
 * register* functions below at module load, and until they do the routes say
 * so honestly instead of returning empty data.
 */
import type { Container } from '@azure/cosmos';
import type { ApiplaneAuditRecord } from '../types';
import { lockOrder } from './locks';
import type { FindingsSource } from './findings-source';
import type { EnvironmentDeps } from './service';
import {
  ENVIRONMENT_CATALOG_ID,
  type CatalogStore, type ClassificationStore, type EnvironmentCatalogDoc, type LockPort, type PublicationPort,
} from './types';

let classification: ClassificationStore | undefined;
let publications: PublicationPort | undefined;
let findingsSource: FindingsSource | undefined;

export function registerClassificationStore(s: ClassificationStore | undefined): void { classification = s; }
export function registerPublicationPort(p: PublicationPort | undefined): void { publications = p; }
export function registerFindingsSource(f: FindingsSource | undefined): void { findingsSource = f; }
export function getFindingsSource(): FindingsSource | undefined { return findingsSource; }

async function desired(): Promise<Container> {
  const m = await import('@/lib/azure/cosmos-client');
  return m.apiplaneDesiredContainer();
}

export const cosmosCatalogStore: CatalogStore = {
  async get(tenantId) {
    const c = await desired();
    const { resource } = await c.item(ENVIRONMENT_CATALOG_ID, tenantId).read<EnvironmentCatalogDoc>();
    return resource;
  },
  async save(doc) {
    const c = await desired();
    await c.items.upsert(doc);
  },
};

/** Atomic lease: items.create is the compare-and-set (409 = held); an expired lease is deleted and retaken. */
export const cosmosLockPort: LockPort = {
  async acquire(tenantId, scopes, ttlMs) {
    const c = await desired();
    const ordered = lockOrder(scopes);
    const taken: string[] = [];
    const releaseAll = async () => { for (const id of taken) await c.item(id, tenantId).delete().catch(() => undefined); };
    for (const scope of ordered) {
      const id = `lease:${scope}`;
      const doc = { id, tenantId, docType: 'lease', expiresAt: Date.now() + ttlMs, ttl: Math.ceil(ttlMs / 1000) * 2 };
      let got = false;
      for (let attempt = 0; attempt < 2 && !got; attempt++) {
        try {
          await c.items.create(doc);
          got = true;
        } catch (e) {
          if ((e as { code?: number }).code !== 409) { await releaseAll(); throw e; }
          const { resource } = await c.item(id, tenantId).read<{ expiresAt: number }>();
          if (resource && resource.expiresAt > Date.now()) break;
          await c.item(id, tenantId).delete().catch(() => undefined);
        }
      }
      if (!got) { await releaseAll(); return undefined; }
      taken.push(id);
    }
    return releaseAll;
  },
};

async function writeAudit(rec: ApiplaneAuditRecord): Promise<void> {
  const m = await import('@/lib/azure/cosmos-client');
  const c = await m.auditLogContainer();
  await c.items.create(rec);
}

export function getEnvironmentDeps(): EnvironmentDeps {
  return {
    catalog: cosmosCatalogStore,
    locks: cosmosLockPort,
    classification,
    publications,
    writeAudit,
  };
}
