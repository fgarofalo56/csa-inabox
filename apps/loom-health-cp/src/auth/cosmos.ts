// Cosmos wiring for the Authorization Server's three containers. Same account
// and credential model as src/store/cosmos.ts (managed identity, no keys). The
// containers must exist before start; health-auth-replay and health-auth-grants
// need a default TTL of -1 (per-item `ttl` honoured). That is bicep work owned
// by another lane, listed in the PR.

import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { Config } from '../config.js';
import { CosmosCollection } from '../store/cosmos.js';
import { AUTH_CONTAINER_NAMES, type AuthStores, type FhirUserDoc, type FhirUserStore } from './types.js';

const SYSTEM_FIELDS = ['_rid', '_self', '_attachments', '_ts'] as const;

/** fhirUser mappings in the shared config container: the Collection seam plus delete and a tenant-scoped query. */
export class CosmosFhirUserStore extends CosmosCollection<FhirUserDoc> implements FhirUserStore {
  constructor(private readonly c: Container) {
    super(c);
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.c.item(id, id).delete();
      return true;
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 404) return false;
      throw e;
    }
  }

  async listForTenant(tenant: string, limit: number): Promise<FhirUserDoc[]> {
    const it = this.c.items.query(
      {
        query: 'SELECT * FROM c WHERE c.kind = @kind AND c.tenant = @tenant ORDER BY c.id',
        parameters: [
          { name: '@kind', value: 'fhiruser' },
          { name: '@tenant', value: tenant },
        ],
      },
      { maxItemCount: limit },
    );
    // Same paging rule as CosmosCollection.list: an empty page does not mean the end.
    const rows: Record<string, unknown>[] = [];
    while (rows.length < limit && it.hasMoreResults()) {
      const page = await it.fetchNext();
      rows.push(...((page.resources as Record<string, unknown>[] | undefined) ?? []));
    }
    return rows.slice(0, limit).map((r) => {
      const out = { ...r };
      for (const f of SYSTEM_FIELDS) delete out[f];
      return out as unknown as FhirUserDoc;
    });
  }
}

export function createCosmosAuthStores(cfg: Config): AuthStores {
  const credential = new DefaultAzureCredential({ authorityHost: `https://${cfg.authorityHost}` });
  const db = new CosmosClient({ endpoint: cfg.cosmosEndpoint, aadCredentials: credential }).database(cfg.cosmosDatabase);
  const config = db.container(AUTH_CONTAINER_NAMES.config);
  return {
    bindings: new CosmosCollection(config),
    clients: new CosmosCollection(config),
    fhirUsers: new CosmosFhirUserStore(config),
    replay: new CosmosCollection(db.container(AUTH_CONTAINER_NAMES.replay)),
    grants: new CosmosCollection(db.container(AUTH_CONTAINER_NAMES.grants)),
  };
}
