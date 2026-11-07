/** In-memory ApiplaneRepo for tests. Partitioned by tenantId like the real containers. */
import type { ApiplaneDoc, ApiplaneRepo } from '../../types';

export class InMemoryApiplaneRepo<T extends ApiplaneDoc = ApiplaneDoc> implements ApiplaneRepo<T> {
  private readonly parts = new Map<string, Map<string, T>>();

  async upsert(doc: T): Promise<T> {
    if (!doc.tenantId) throw new Error('tenantId (partition key) is required');
    const p = this.parts.get(doc.tenantId) ?? new Map<string, T>();
    p.set(doc.id, structuredClone(doc));
    this.parts.set(doc.tenantId, p);
    return doc;
  }

  async get(tenantId: string, id: string): Promise<T | undefined> {
    const d = this.parts.get(tenantId)?.get(id);
    return d ? structuredClone(d) : undefined;
  }

  async list(tenantId: string, docType?: string): Promise<T[]> {
    const all = [...(this.parts.get(tenantId)?.values() ?? [])];
    return all.filter((d) => docType === undefined || d.docType === docType).map((d) => structuredClone(d));
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return this.parts.get(tenantId)?.delete(id) ?? false;
  }
}
