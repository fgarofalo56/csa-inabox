/**
 * Production wiring of the registry ports: Cosmos `apiplane-desired`, the host
 * ARM port, and the shared audit-log container. Routes import this; tests mock it.
 */
import { BulkOperationType, type Container, type OperationInput } from '@azure/cosmos';
import { apiplaneDesiredContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { detectCloud } from '@/lib/azure/cloud-endpoints';
import { ClassificationConflictError } from '../environments/types';
import { hostArmPort } from './arm-port';
import type { GatewayRepo, RegistryDeps } from './gateway-service';
import type { GatewayDoc } from './types';

function cosmosRepo(get: () => Promise<Container>): GatewayRepo {
  return {
    /** One Cosmos transactional batch (single partition = tenantId); any 412 (stale _etag) aborts all. */
    async replaceBatch(tenantId, items) {
      if (items.length === 0) return;
      const c = await get();
      const ops = items.map(({ doc, expectedEtag }) => ({
        operationType: BulkOperationType.Replace as typeof BulkOperationType.Replace,
        id: doc.id,
        resourceBody: doc as unknown as Record<string, unknown>,
        ifMatch: expectedEtag,
      })) as OperationInput[];
      const res = await c.items.batch(ops, tenantId);
      const results = res.result ?? [];
      const failed = results.findIndex((r) => r.statusCode >= 400 && r.statusCode !== 424);
      if (failed >= 0 || (res.code !== undefined && res.code >= 400)) {
        const idx = failed >= 0 ? failed : 0;
        if (failed < 0 || results[failed].statusCode === 412 || results[failed].statusCode === 404) {
          throw new ClassificationConflictError(items[idx].doc.id);
        }
        throw new Error(`Gateway batch replace failed with status ${results[failed].statusCode}`);
      }
    },
    async upsert(doc) {
      const c = await get();
      await c.items.upsert(doc);
      return doc;
    },
    async get(tenantId, id) {
      const c = await get();
      try {
        const r = await c.item(id, tenantId).read<GatewayDoc>();
        return r.resource;
      } catch (e) {
        if ((e as { code?: number })?.code === 404) return undefined;
        throw e;
      }
    },
    async list(tenantId, docType) {
      const c = await get();
      const q = docType
        ? { query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.docType = @d', parameters: [{ name: '@t', value: tenantId }, { name: '@d', value: docType }] }
        : { query: 'SELECT * FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: tenantId }] };
      const { resources } = await c.items.query<GatewayDoc>(q, { partitionKey: tenantId }).fetchAll();
      return resources;
    },
    async remove(tenantId, id) {
      const c = await get();
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

export function cosmosGatewayRepo(): GatewayRepo {
  return cosmosRepo(apiplaneDesiredContainer);
}

export function registryDeps(): RegistryDeps {
  return {
    repo: cosmosGatewayRepo(),
    arm: hostArmPort(),
    async writeAudit(rec) {
      const al = await auditLogContainer();
      await al.items.create(rec);
    },
    cloud: () => detectCloud(),
  };
}
