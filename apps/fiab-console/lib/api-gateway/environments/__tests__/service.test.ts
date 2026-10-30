import { describe, expect, it } from 'vitest';
import { mutateCatalog, reclassify, loadCatalog, MAX_BATCH } from '../service';
import type { AppliedPublication } from '../types';
import { ACTOR, makeDeps, TENANT } from './fixtures';

const PUB: AppliedPublication = { id: 'pub-1', displayName: 'Orders MCP', gatewayId: 'g1', resources: [{ kind: 'mcp', id: 'm1' }] };

async function world() {
  const w = makeDeps({ publications: [PUB] });
  await w.classification.seed({ kind: 'gateway', id: 'g1', displayName: 'Gateway One', environmentKey: 'development' });
  await w.classification.seed({ kind: 'mcp', id: 'm1', displayName: 'Orders', environmentKey: 'development' });
  return w;
}

describe('reclassify: the invariant', () => {
  it('refuses to move a gateway to Production while it fronts a Development resource through an APPLIED publication, and lists the publication', async () => {
    const { deps, classification, audit } = await world();
    const r = await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'production' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.blocking?.map((b) => b.publication.id)).toEqual(['pub-1']);
    expect(r.error).toContain('Orders MCP');
    // nothing was written or audited
    expect(await classification.envOf('gateway', 'g1')).toBe('development');
    expect(classification.batches).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('allows the same move when the resource moves with it in ONE batch (validated against the final state), with one audit event per resource', async () => {
    const { deps, classification, audit } = await world();
    const r = await reclassify(deps, TENANT, ACTOR, [
      { kind: 'gateway', id: 'g1', environmentKey: 'production' },
      { kind: 'mcp', id: 'm1', environmentKey: 'production' },
    ]);
    expect(r).toEqual({ ok: true, data: { changed: 2, auditWritten: 2, auditFailed: 0 } });
    expect(classification.batches).toHaveLength(1);
    expect(classification.batches[0]).toHaveLength(2);
    expect(await classification.envOf('gateway', 'g1')).toBe('production');
    expect(await classification.envOf('mcp', 'm1')).toBe('production');
    expect(audit.map((a) => [a.kind, a.target, a.capability])).toEqual([
      ['apiplane.environment.reclassify', 'gateway:g1', 'tenant-admin'],
      ['apiplane.environment.reclassify', 'mcp:m1', 'tenant-admin'],
    ]);
    expect(audit[0].detail).toEqual({ prior: { environmentKey: 'development' }, next: { environmentKey: 'production' } });
    // authored fields survive the write
    expect(await classification.authoredOf('gateway', 'g1')).toBe('keep-me');
  });

  it('a move that only produces a warning (Development -> Staging) is allowed', async () => {
    const { deps, classification } = await world();
    const r = await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'staging' }]);
    expect(r.ok).toBe(true);
    expect(await classification.envOf('gateway', 'g1')).toBe('staging');
  });

  it('the same pairing with NO applied publication (a draft) is not refused', async () => {
    const w = makeDeps({ publications: [] });
    await w.classification.seed({ kind: 'gateway', id: 'g1', environmentKey: 'development' });
    await w.classification.seed({ kind: 'mcp', id: 'm1', environmentKey: 'development' });
    const r = await reclassify(w.deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'production' }]);
    expect(r.ok).toBe(true);
  });

  it('turning on Require classification is refused when it would block an applied publication whose resource is unclassified', async () => {
    const w = makeDeps({ publications: [PUB] });
    await w.classification.seed({ kind: 'gateway', id: 'g1', environmentKey: 'development' });
    await w.classification.seed({ kind: 'mcp', id: 'm1', environmentKey: null });
    const r = await mutateCatalog(w.deps, TENANT, ACTOR, { op: 'settings', requireClassification: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blocking?.[0].publication.id).toBe('pub-1');
    expect((await loadCatalog(w.deps, TENANT)).settings.requireClassification).toBe(false);
    // and with nothing applied it goes through and is audited
    const ok = makeDeps({ publications: [] });
    const done = await mutateCatalog(ok.deps, TENANT, ACTOR, { op: 'settings', requireClassification: true });
    expect(done.ok).toBe(true);
    expect((await loadCatalog(ok.deps, TENANT)).settings.requireClassification).toBe(true);
    expect(ok.audit.map((a) => a.kind)).toEqual(['apiplane.environment.settings']);
  });

  it('editing an environment so it flips an applied pairing to blocked is refused (Test becomes production-class while its gateway fronts a Development resource)', async () => {
    const w = makeDeps({ publications: [PUB] });
    await w.classification.seed({ kind: 'gateway', id: 'g1', displayName: 'Gateway One', environmentKey: 'test' });
    await w.classification.seed({ kind: 'mcp', id: 'm1', displayName: 'Orders', environmentKey: 'development' });
    const unused = await mutateCatalog(w.deps, TENANT, ACTOR, { op: 'update', key: 'sandbox', input: { isProductionClass: true } });
    expect(unused.ok).toBe(true); // positive control: an edit that blocks nothing is accepted
    const bad = await mutateCatalog(w.deps, TENANT, ACTOR, { op: 'update', key: 'test', input: { isProductionClass: true } });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.blocking?.map((b) => b.publication.id)).toEqual(['pub-1']);
    expect((await loadCatalog(w.deps, TENANT)).environments.find((e) => e.key === 'test')?.isProductionClass).toBe(false);
  });

  it('deleting an environment that classified resources use is refused naming them; an unused custom one deletes', async () => {
    const { deps } = await world();
    const c = await mutateCatalog(deps, TENANT, ACTOR, { op: 'create', displayName: 'Perf' });
    expect(c.ok).toBe(true);
    const del = await mutateCatalog(deps, TENANT, ACTOR, { op: 'delete', key: 'development' });
    expect(del.ok).toBe(false);
    const delPerf = await mutateCatalog(deps, TENANT, ACTOR, { op: 'delete', key: 'perf' });
    expect(delPerf.ok).toBe(true);
  });
});

describe('reclassify: validation, locking, concurrency', () => {
  it('refuses a key not in the catalog, a duplicate, an empty batch, an unregistered resource, and a batch over the transaction limit', async () => {
    const { deps } = await world();
    expect(await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'nope' }])).toMatchObject({ ok: false, status: 400 });
    expect(await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'test' }, { kind: 'gateway', id: 'g1', environmentKey: 'qc' }])).toMatchObject({ ok: false, status: 400 });
    expect(await reclassify(deps, TENANT, ACTOR, [])).toMatchObject({ ok: false, status: 400 });
    expect(await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'ghost', environmentKey: 'test' }])).toMatchObject({ ok: false, status: 404 });
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ kind: 'endpoint' as const, id: `e${i}`, environmentKey: 'test' }));
    expect(await reclassify(deps, TENANT, ACTOR, many)).toMatchObject({ ok: false, status: 413 });
    const exactly = Array.from({ length: MAX_BATCH }, (_, i) => ({ kind: 'endpoint' as const, id: `e${i}`, environmentKey: 'test' }));
    // exactly MAX_BATCH passes the size gate (and then fails as unregistered, not as too large)
    expect(await reclassify(deps, TENANT, ACTOR, exactly)).toMatchObject({ ok: false, status: 404 });
  });

  it('a held lease on the gateway scope refuses the batch with 409 and writes nothing; after release it succeeds', async () => {
    const { deps, locks, classification } = await world();
    const release = await locks.acquire(TENANT, ['gateway:g1'], 60_000);
    expect(release).toBeDefined();
    const blocked = await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'staging' }]);
    expect(blocked).toMatchObject({ ok: false, status: 409 });
    expect(classification.batches).toHaveLength(0);
    await release!();
    expect((await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'staging' }])).ok).toBe(true);
    // the lock is released after the call: a second acquire succeeds
    expect(await locks.acquire(TENANT, ['gateway:g1'], 1000)).toBeDefined();
  });

  it('a stale etag (record changed after read) is a 409 and nothing is audited', async () => {
    const { deps, classification, audit } = await world();
    const realList = classification.list.bind(classification);
    classification.list = async (t, k) => (await realList(t, k)).map((r) => ({ ...r, etag: 'stale' }));
    const r = await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'staging' }]);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(audit).toHaveLength(0);
    expect(await classification.envOf('gateway', 'g1')).toBe('development');
  });

  it('with no registry registered, reclassify says so (503) instead of pretending', async () => {
    const { deps } = makeDeps({ withRegistry: false });
    expect(await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'test' }])).toMatchObject({ ok: false, status: 503 });
  });

  it('an audit failure is reported, not hidden', async () => {
    const { deps } = await world();
    deps.writeAudit = async () => { throw new Error('cosmos down'); };
    const r = await reclassify(deps, TENANT, ACTOR, [{ kind: 'gateway', id: 'g1', environmentKey: 'staging' }]);
    expect(r).toEqual({ ok: true, data: { changed: 1, auditWritten: 0, auditFailed: 1 } });
  });
});
