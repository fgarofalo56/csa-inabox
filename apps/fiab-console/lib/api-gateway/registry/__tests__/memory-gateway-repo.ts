/** In-memory GatewayRepo: Cosmos-like `_etag` per write and an all-or-nothing replaceBatch. */
import { InMemoryApiplaneRepo } from '../../__tests__/repos/in-memory-repo';
import { ClassificationConflictError } from '../../environments/types';
import type { GatewayRepo } from '../gateway-service';
import type { GatewayDoc } from '../types';

export class MemoryGatewayRepo extends InMemoryApiplaneRepo<GatewayDoc> implements GatewayRepo {
  private n = 0;
  /** Number of documents written, for "nothing was written" assertions. */
  writes = 0;

  override async upsert(doc: GatewayDoc): Promise<GatewayDoc> {
    this.writes++;
    return super.upsert({ ...doc, _etag: `etag-${++this.n}` });
  }

  async replaceBatch(tenantId: string, items: Array<{ doc: GatewayDoc; expectedEtag?: string }>): Promise<void> {
    for (const { doc, expectedEtag } of items) {
      const cur = await this.get(tenantId, doc.id);
      if (!cur || (expectedEtag !== undefined && cur._etag !== expectedEtag)) throw new ClassificationConflictError(doc.id);
    }
    for (const { doc } of items) {
      this.writes++;
      await super.upsert({ ...doc, _etag: `etag-${++this.n}` });
    }
  }
}
