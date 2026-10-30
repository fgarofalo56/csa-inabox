/**
 * Production wiring of the registry ports: Cosmos `apiplane-desired`, the host
 * ARM port, and the shared audit-log container. Routes import this; tests mock it.
 */
import type { Container } from '@azure/cosmos';
import { apiplaneDesiredContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { detectCloud } from '@/lib/azure/cloud-endpoints';
import type { ApiplaneRepo } from '../types';
import { hostArmPort } from './arm-port';
import type { RegistryDeps } from './gateway-service';
import type { GatewayDoc } from './types';

function cosmosRepo(get: () => Promise<Container>): ApiplaneRepo<GatewayDoc> {
  return {
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

export function registryDeps(): RegistryDeps {
  return {
    repo: cosmosRepo(apiplaneDesiredContainer),
    arm: hostArmPort(),
    async writeAudit(rec) {
      const al = await auditLogContainer();
      await al.items.create(rec);
    },
    cloud: () => detectCloud(),
  };
}
