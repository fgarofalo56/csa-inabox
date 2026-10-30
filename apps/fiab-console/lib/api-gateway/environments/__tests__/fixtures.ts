/** Test doubles for the environment ports, built on the W1-1 in-memory repo. */
import { InMemoryApiplaneRepo } from '../../__tests__/repos/in-memory-repo';
import type { ApiplaneAuditRecord, ApiplaneDoc } from '../../types';
import { InMemoryLockPort } from '../locks';
import type { EnvironmentDeps } from '../service';
import {
  ClassificationConflictError, ENVIRONMENT_CATALOG_ID,
  type AppliedPublication, type CatalogStore, type ClassifiableResource, type ClassificationStore, type EnvironmentCatalogDoc,
} from '../types';

export const TENANT = 't-1';

interface ResourceDoc extends ApiplaneDoc {
  rKind: ClassifiableResource['kind'];
  displayName: string;
  environmentKey: string | null;
  etag: string;
  armTags?: Record<string, string>;
  /** An authored field classification must never clobber. */
  authored: string;
}

export class InMemoryClassificationStore implements ClassificationStore {
  readonly repo = new InMemoryApiplaneRepo<ResourceDoc>();
  batches: Array<Array<{ kind: string; id: string; environmentKey: string | null }>> = [];
  private n = 0;

  async seed(r: { kind: ClassifiableResource['kind']; id: string; displayName?: string; environmentKey?: string | null; armTags?: Record<string, string> }) {
    await this.repo.upsert({
      id: `${r.kind}:${r.id}`, tenantId: TENANT, docType: 'resource', rKind: r.kind, displayName: r.displayName ?? r.id,
      environmentKey: r.environmentKey ?? null, etag: `e${++this.n}`, armTags: r.armTags, authored: 'keep-me',
    });
  }

  async list(tenantId: string, kind?: ClassifiableResource['kind']): Promise<ClassifiableResource[]> {
    return (await this.repo.list(tenantId, 'resource'))
      .filter((d) => !kind || d.rKind === kind)
      .map((d) => ({ kind: d.rKind, id: d.id.slice(d.rKind.length + 1), displayName: d.displayName, environmentKey: d.environmentKey, etag: d.etag, armTags: d.armTags }));
  }

  async applyBatch(tenantId: string, changes: Array<{ kind: ClassifiableResource['kind']; id: string; environmentKey: string | null; expectedEtag?: string }>): Promise<void> {
    const docs = await Promise.all(changes.map((c) => this.repo.get(tenantId, `${c.kind}:${c.id}`)));
    changes.forEach((c, i) => { if (!docs[i] || docs[i]!.etag !== c.expectedEtag) throw new ClassificationConflictError(c.id); });
    for (let i = 0; i < changes.length; i++) {
      await this.repo.upsert({ ...docs[i]!, environmentKey: changes[i].environmentKey, etag: `e${++this.n}` });
    }
    this.batches.push(changes.map(({ kind, id, environmentKey }) => ({ kind, id, environmentKey })));
  }

  async authoredOf(kind: string, id: string): Promise<string | undefined> {
    return (await this.repo.get(TENANT, `${kind}:${id}`))?.authored;
  }
  async envOf(kind: string, id: string): Promise<string | null | undefined> {
    return (await this.repo.get(TENANT, `${kind}:${id}`))?.environmentKey;
  }
}

class RepoCatalogStore implements CatalogStore {
  readonly repo = new InMemoryApiplaneRepo<EnvironmentCatalogDoc>();
  async get(tenantId: string) { return this.repo.get(tenantId, ENVIRONMENT_CATALOG_ID); }
  async save(doc: EnvironmentCatalogDoc) { await this.repo.upsert(doc); }
}

export function makeDeps(opts: { publications?: AppliedPublication[]; withRegistry?: boolean } = {}) {
  const classification = new InMemoryClassificationStore();
  const audit: ApiplaneAuditRecord[] = [];
  const locks = new InMemoryLockPort();
  const deps: EnvironmentDeps = {
    catalog: new RepoCatalogStore(),
    locks,
    classification: opts.withRegistry === false ? undefined : classification,
    publications: { listApplied: async () => opts.publications ?? [] },
    writeAudit: async (r) => { audit.push(r); },
  };
  return { deps, classification, audit, locks };
}

export const ACTOR = { who: 'admin@contoso.com', oid: 'oid-1', capability: 'tenant-admin' as const };
