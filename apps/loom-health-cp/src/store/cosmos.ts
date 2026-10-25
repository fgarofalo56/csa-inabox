// Cosmos DB implementation of the store seam. Entra only: the account is
// reached with DefaultAzureCredential (managed identity in Azure), never a key
// or connection string. Containers are created by the bicep follow-up (data
// plane RBAC cannot create them), all partitioned on /id.

import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { Config } from '../config.js';
import { StoreConflictError } from '../http/errors.js';
import { CONTAINER_NAMES, type Collection, type Doc, type Stores } from './types.js';

const SYSTEM_FIELDS = ['_rid', '_self', '_attachments', '_ts'] as const;

function clean<T extends Doc>(raw: Record<string, unknown>): T {
  const out = { ...raw };
  for (const f of SYSTEM_FIELDS) delete out[f];
  return out as unknown as T;
}

function statusOf(e: unknown): number | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

export class CosmosCollection<T extends Doc> implements Collection<T> {
  constructor(private readonly container: Container) {}

  async get(id: string): Promise<T | undefined> {
    try {
      const { resource } = await this.container.item(id, id).read();
      return resource ? clean<T>(resource as Record<string, unknown>) : undefined;
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
  }

  async list(limit: number): Promise<T[]> {
    const { resources } = await this.container.items
      .query({ query: 'SELECT * FROM c ORDER BY c.id', parameters: [] }, { maxItemCount: limit })
      .fetchNext();
    return (resources as Record<string, unknown>[]).slice(0, limit).map((r) => clean<T>(r));
  }

  async create(doc: T): Promise<T> {
    try {
      const { resource } = await this.container.items.create(doc);
      return clean<T>(resource as unknown as Record<string, unknown>);
    } catch (e) {
      if (statusOf(e) === 409) throw new StoreConflictError('exists');
      throw e;
    }
  }

  async replace(doc: T): Promise<T> {
    try {
      const { resource } = await this.container.item(doc.id, doc.id).replace(doc, {
        accessCondition: { type: 'IfMatch', condition: doc._etag ?? '' },
      });
      return clean<T>(resource as unknown as Record<string, unknown>);
    } catch (e) {
      if (statusOf(e) === 412 || statusOf(e) === 404) throw new StoreConflictError('stale');
      throw e;
    }
  }

  async upsert(doc: T): Promise<T> {
    const { resource } = await this.container.items.upsert(doc);
    return clean<T>(resource as unknown as Record<string, unknown>);
  }
}

export function createCosmosStores(cfg: Config): Stores {
  const credential = new DefaultAzureCredential({ authorityHost: `https://${cfg.authorityHost}` });
  const db = new CosmosClient({ endpoint: cfg.cosmosEndpoint, aadCredentials: credential }).database(
    cfg.cosmosDatabase,
  );
  const c = (name: string) => db.container(name);
  return {
    stamps: new CosmosCollection(c(CONTAINER_NAMES.stamps)),
    tenants: new CosmosCollection(c(CONTAINER_NAMES.tenants)),
    routing: new CosmosCollection(c(CONTAINER_NAMES.routing)),
    jobs: new CosmosCollection(c(CONTAINER_NAMES.jobs)),
    slo: new CosmosCollection(c(CONTAINER_NAMES.slo)),
  };
}
