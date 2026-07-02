/**
 * CosmosDataProductStore — Azure-native DEFAULT adapter for DataProductStore.
 *
 * Stores data-product catalog records in the `dataproducts` Cosmos container
 * (partitioned by /tenantId). Follows the connections-store.ts pattern: every
 * write goes through the @azure/cosmos SDK (not a data-plane REST client) so
 * ChainedTokenCredential auth is handled centrally by cosmos-client.ts ensure().
 *
 * The `tenantId` on each doc is the caller's Entra tenant/object id (the same
 * value loadOwnedItem / connections-store use as the partition key). Callers
 * pass it explicitly on register/update so this adapter is side-effect-free on
 * session state.
 *
 * No Microsoft Fabric / Purview-unified-catalog dependency on this default path
 * (.claude/rules/no-fabric-dependency.md). Real Cosmos queries, never mocks
 * (.claude/rules/no-vaporware.md).
 *
 * Grounded in the @azure/cosmos SDK:
 *   https://learn.microsoft.com/javascript/api/@azure/cosmos/items
 */
import { randomUUID } from 'node:crypto';
import { dataProductsContainer } from '@/lib/azure/cosmos-client';
import type { SqlParameter } from '@azure/cosmos';
import type { DataProductStore } from './store';
import type {
  PurviewDataProduct,
  PurviewDataProductPayload,
} from '@/lib/azure/purview-client';

/** Internal Cosmos document shape (a superset of the public PurviewDataProduct). */
interface DataProductDoc extends PurviewDataProduct {
  tenantId: string;
  createdAt: string;
}

/** Strip the internal-only fields before returning to callers. */
function toProduct(doc: DataProductDoc): PurviewDataProduct {
  const { tenantId: _t, createdAt: _c, ...rest } = doc;
  return rest;
}

export class CosmosDataProductStore implements DataProductStore {
  /** Cross-partition read of the raw doc (the id alone doesn't carry the pk). */
  private async getDoc(id: string): Promise<DataProductDoc | null> {
    const c = await dataProductsContainer();
    const { resources } = await c.items
      .query<DataProductDoc>({
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    return resources?.[0] ?? null;
  }

  async register(payload: PurviewDataProductPayload): Promise<PurviewDataProduct> {
    const tenantId = (payload.tenantId as string | undefined)?.trim();
    if (!tenantId) {
      throw Object.assign(
        new Error('CosmosDataProductStore.register: payload.tenantId is required'),
        { status: 400 },
      );
    }
    const c = await dataProductsContainer();
    const now = new Date().toISOString();
    const existing = payload.id ? await this.getDoc(payload.id) : null;
    const doc: DataProductDoc = {
      id: payload.id ?? randomUUID(),
      tenantId,
      name: (payload.displayName ?? payload.name ?? existing?.name ?? '').trim(),
      description: payload.description ?? existing?.description,
      domain: payload.domain ?? existing?.domain,
      status: existing?.status ?? 'DRAFT',
      type: payload.type ?? existing?.type,
      endorsed: payload.endorsed ?? existing?.endorsed ?? false,
      contacts: existing?.contacts,
      documentation: existing?.documentation,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
      raw: { ...((existing?.raw as object) ?? {}), ...payload },
    };
    const { resource } = await c.items.upsert<DataProductDoc>(doc);
    return toProduct(resource ?? doc);
  }

  async get(id: string): Promise<PurviewDataProduct | null> {
    const doc = await this.getDoc(id);
    return doc ? toProduct(doc) : null;
  }

  async list(domain?: string): Promise<PurviewDataProduct[]> {
    const c = await dataProductsContainer();
    const spec = domain
      ? {
          query: 'SELECT * FROM c WHERE c.domain = @d ORDER BY c.name',
          parameters: [{ name: '@d', value: domain }],
        }
      : { query: 'SELECT * FROM c ORDER BY c.name', parameters: [] as SqlParameter[] };
    const { resources } = await c.items.query<DataProductDoc>(spec).fetchAll();
    return (resources ?? []).map(toProduct);
  }

  async update(id: string, payload: Partial<PurviewDataProductPayload>): Promise<PurviewDataProduct> {
    const existing = await this.getDoc(id);
    if (!existing) throw Object.assign(new Error(`DataProduct ${id} not found`), { status: 404 });
    const c = await dataProductsContainer();
    const now = new Date().toISOString();
    const merged: DataProductDoc = {
      ...existing,
      tenantId: (payload.tenantId as string | undefined)?.trim() || existing.tenantId,
      name: (payload.displayName ?? payload.name ?? existing.name).trim(),
      description: payload.description ?? existing.description,
      domain: payload.domain ?? existing.domain,
      type: payload.type ?? existing.type,
      endorsed: payload.endorsed ?? existing.endorsed,
      updatedAt: now,
      raw: { ...((existing.raw as object) ?? {}), ...payload },
    };
    const { resource } = await c.items.upsert<DataProductDoc>(merged);
    return toProduct(resource ?? merged);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.getDoc(id);
    if (!existing) return;
    const c = await dataProductsContainer();
    try {
      await c.item(id, existing.tenantId).delete();
    } catch (e: any) {
      if (e?.code === 404) return;
      throw e;
    }
  }
}
