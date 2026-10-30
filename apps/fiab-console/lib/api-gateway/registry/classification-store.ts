/**
 * API Gateway Plane - gateway side of the environment classification contract (W1-2).
 *
 * Implements `ClassificationStore` (environments/types.ts) over the gateway
 * registry. `environmentKey` is written ONLY here; registration and inventory
 * refreshes preserve it (gateway-service.refreshAccess).
 */
import {
  ClassificationConflictError,
  type ClassifiableResource,
  type ClassificationChange,
  type ClassificationStore,
  type ResourceKind,
} from '../environments/types';
import type { GatewayRepo } from './gateway-service';
import type { GatewayDoc } from './types';

function toResource(g: GatewayDoc): ClassifiableResource {
  return {
    kind: 'gateway',
    id: g.id,
    displayName: g.displayName,
    environmentKey: g.environmentKey ?? null,
    etag: g._etag,
    armTags: g.armTags,
  };
}

export function createGatewayClassificationStore(repo: () => GatewayRepo): ClassificationStore {
  return {
    async list(tenantId: string, kind?: ResourceKind) {
      if (kind && kind !== 'gateway') return [];
      return (await repo().list(tenantId, 'gateway')).map(toResource);
    },

    async applyBatch(tenantId: string, changes: Array<ClassificationChange & { expectedEtag?: string }>) {
      const r = repo();
      const items: Array<{ doc: GatewayDoc; expectedEtag?: string }> = [];
      for (const c of changes) {
        if (c.kind !== 'gateway') {
          throw new Error(`The gateway registry cannot classify a '${c.kind}' record (${c.id}).`);
        }
        const cur = await r.get(tenantId, c.id);
        if (!cur || cur.docType !== 'gateway') throw new ClassificationConflictError(c.id);
        if (c.expectedEtag !== undefined && cur._etag !== c.expectedEtag) throw new ClassificationConflictError(c.id);
        // Replace only environmentKey; every other authored field is carried over from the read.
        items.push({ doc: { ...cur, environmentKey: c.environmentKey }, expectedEtag: cur._etag });
      }
      // One atomic replace against each etag: a concurrent write between the read above and
      // here is a stale etag and the repository writes nothing.
      await r.replaceBatch(tenantId, items);
    },
  };
}
