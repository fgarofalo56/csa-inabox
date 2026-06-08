/**
 * CosmosDataProductStore — the Azure-native DEFAULT DataProductStore.
 *
 * Backed by the `dataproducts` Cosmos container (PK `/governanceDomainId`,
 * created lazily in cosmos-client.ts `ensure()`). All reads/writes are real
 * Cosmos data-plane calls — no mocks (per .claude/rules/no-vaporware.md).
 *
 * The per-step PATCH uses Cosmos optimistic concurrency: `item().replace()`
 * is issued with `accessCondition: { type: 'IfMatch', condition: <_etag> }`.
 * If another writer changed the doc since the dialog read it, Cosmos returns
 * HTTP 412 and we raise {@link ETagConflictError} so the lost-update is
 * blocked rather than silently clobbered.
 */

import { dataproductsContainer } from '@/lib/azure/cosmos-client';
import {
  type DataProductDoc,
  type DataProductPatch,
  type DataProductStore,
  ETagConflictError,
  mergeDataProductPatch,
} from './store';

export class CosmosDataProductStore implements DataProductStore {
  async get(id: string): Promise<DataProductDoc | null> {
    const c = await dataproductsContainer();
    // id is globally unique; the partition (governanceDomainId) isn't known to
    // every caller, so this is an intentional cross-partition point lookup.
    const { resources } = await c.items
      .query<DataProductDoc>({
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: id }],
      })
      .fetchAll();
    return resources?.[0] ?? null;
  }

  async patch(id: string, patch: DataProductPatch, etag: string): Promise<DataProductDoc> {
    if (!etag) throw new Error('patch requires an If-Match ETag');
    const c = await dataproductsContainer();
    const current = await this.get(id);
    if (!current) {
      const e: any = new Error(`data product ${id} not found`);
      e.status = 404;
      throw e;
    }
    const next = mergeDataProductPatch(current, patch);
    try {
      const { resource } = await c
        .item(id, current.governanceDomainId)
        .replace(next, { accessCondition: { type: 'IfMatch', condition: etag } });
      return resource as DataProductDoc;
    } catch (e: any) {
      // Cosmos returns 412 Precondition Failed when the If-Match ETag is stale.
      if (e?.code === 412 || e?.statusCode === 412 || e?.status === 412) {
        throw new ETagConflictError();
      }
      throw e;
    }
  }

  async findByName(name: string, excludeId = ''): Promise<DataProductDoc | null> {
    const c = await dataproductsContainer();
    const { resources } = await c.items
      .query<DataProductDoc>({
        // Case-insensitive exact-name match; exclude the product being edited.
        query:
          'SELECT TOP 1 * FROM c WHERE LOWER(c.name) = LOWER(@name) AND (@excludeId = "" OR c.id != @excludeId)',
        parameters: [
          { name: '@name', value: name },
          { name: '@excludeId', value: excludeId },
        ],
      })
      .fetchAll();
    return resources?.[0] ?? null;
  }
}
