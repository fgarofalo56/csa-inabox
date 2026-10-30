/** Production wiring: Cosmos `apiplane-observed` repo + the registry's gateway repo + the ARM source. */
import { apiplaneObservedContainer } from '@/lib/azure/cosmos-client';
import { cosmosGatewayRepo } from '../registry/deps';
import type { ApiplaneRepo } from '../types';
import { armObserveSource } from './arm-source';
import type { SyncDeps } from './sync';
import type { ObservedDoc } from './types';

export function cosmosObservedRepo(): ApiplaneRepo<ObservedDoc> {
  return {
    async upsert(doc) {
      const c = await apiplaneObservedContainer();
      await c.items.upsert(doc);
      return doc;
    },
    async get(tenantId, id) {
      const c = await apiplaneObservedContainer();
      try {
        return (await c.item(id, tenantId).read<ObservedDoc>()).resource;
      } catch (e) {
        if ((e as { code?: number })?.code === 404) return undefined;
        throw e;
      }
    },
    async list(tenantId, docType) {
      const c = await apiplaneObservedContainer();
      const q = docType
        ? { query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.docType = @d', parameters: [{ name: '@t', value: tenantId }, { name: '@d', value: docType }] }
        : { query: 'SELECT * FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: tenantId }] };
      const { resources } = await c.items.query<ObservedDoc>(q, { partitionKey: tenantId }).fetchAll();
      return resources;
    },
    async remove(tenantId, id) {
      const c = await apiplaneObservedContainer();
      try {
        await c.item(id, tenantId).delete();
        return true;
      } catch (e) {
        if ((e as { code?: number })?.code === 404) return false;
        throw e;
      }
    },
  };
}

export function syncDeps(): SyncDeps {
  return { gateways: cosmosGatewayRepo(), observed: cosmosObservedRepo(), source: armObserveSource };
}
