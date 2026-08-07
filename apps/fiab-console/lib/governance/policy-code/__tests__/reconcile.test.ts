import { describe, it, expect } from 'vitest';
import { diffOps } from '../reconcile';
import { compileTrino, buildTrinoRulesDocument, rulesVersion } from '../compilers/trino';
import { trinoEnforcementStatus } from '../trino-engine-rules';
import { normalizePolicyCodeSet } from '../dsl';
import type { CompiledOp } from '../compilers/types';

function op(key: string, undo?: string): CompiledOp {
  return { key, kind: 'grant', statement: `APPLY ${key}`, undo, target: 't', principals: ['p'], from: 's' };
}

describe('reconcile diffOps (pure) — drift self-heal', () => {
  const a = op('k:a', 'UNDO a');
  const b = op('k:b', 'UNDO b');
  const c = op('k:c', 'UNDO c');

  it('applies desired ops that are missing from live (out-of-band drift heals)', () => {
    // Desired a,b; live has only a → b drifted away and must be re-applied.
    const d = diffOps([a, b], new Set(['k:a']), [a, b]);
    expect(d.toApply.map((o) => o.key)).toEqual(['k:b']);
    expect(d.inSync.map((o) => o.key)).toEqual(['k:a']);
    expect(d.toRevoke).toHaveLength(0);
  });

  it('revokes prior-applied ops no longer in the desired set (policy removal)', () => {
    // Prior applied a,b,c; desired now only a → b and c must be revoked.
    const d = diffOps([a], new Set(['k:a', 'k:b', 'k:c']), [a, b, c]);
    expect(d.toApply).toHaveLength(0);
    expect(d.toRevoke.map((o) => o.key).sort()).toEqual(['k:b', 'k:c']);
  });

  it('a fully-converged set has no delta', () => {
    const d = diffOps([a, b], new Set(['k:a', 'k:b']), [a, b]);
    expect(d.toApply).toHaveLength(0);
    expect(d.toRevoke).toHaveLength(0);
    expect(d.inSync).toHaveLength(2);
  });

  it('only revokes ops that carry an inverse (undo)', () => {
    const noUndo = op('k:x'); // no undo
    const d = diffOps([], new Set(['k:x']), [noUndo]);
    expect(d.toRevoke).toHaveLength(0);
  });

  it('a brand-new set applies everything (nothing live yet)', () => {
    const d = diffOps([a, b, c], new Set(), []);
    expect(d.toApply.map((o) => o.key)).toEqual(['k:a', 'k:b', 'k:c']);
    expect(d.toRevoke).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LU-7 — the enforcement receipt must be able to reach "enforcing".
//
// The publish path and the engine-fetch path build the rules document with
// DIFFERENT catalog inputs (reconcile has no engine to ask; the engine always
// reports at least `system`). When the version hash covered the catalog
// section, the two were deterministically unequal FOREVER: the status was
// permanently `stale`, reconcile could never report applied, and the detail
// blamed an unreachable Console while the engine was fetching successfully on
// its refresh interval — a cause the code never established (R7).
// ─────────────────────────────────────────────────────────────────────────────
describe('LU-7 trinoEnforcementStatus — the receipt can read enforcing', () => {
  const art = compileTrino(
    normalizePolicyCodeSet({
      apiVersion: 'loom.governance/v1',
      name: 'receipt',
      statements: [{
        id: 's1',
        principals: [{ kind: 'user', id: 'u1', name: 'alice@contoso.com' }],
        resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
        actions: ['read'],
        condition: { rowFilter: '[Region] = USERPRINCIPALNAME()' },
      }],
    }),
    { trinoGroupProvider: false },
  );

  /** What reconcile publishes — no engine catalog list available. */
  const publishedVersion = rulesVersion(buildTrinoRulesDocument(art, {}));
  /** What the engine receives — the entrypoint always sends its catalog list. */
  const servedVersion = rulesVersion(buildTrinoRulesDocument(art, {
    catalogs: [
      { name: 'system', allow: 'read-only' },
      { name: 'jmx', allow: 'read-only' },
      { name: 'memory', allow: 'all' },
      { name: 'iceberg', allow: 'read-only' },
    ],
  }));

  const doc = (lastFetch?: { at: string; version: string; catalogs: string[]; by: string }) => ({
    id: 'trino-engine-rules:t', tenantId: 't', kind: 'trino-engine-rules' as const,
    rules: buildTrinoRulesDocument(art, {}), rego: '', groupFile: '',
    version: publishedVersion, policySetName: 'receipt',
    publishedAt: '2026-08-07T00:00:00Z', publishedBy: 'test',
    ...(lastFetch ? { lastFetch } : {}),
  });

  it('the engine fetch produces the SAME version the publisher stored', () => {
    expect(servedVersion).toBe(publishedVersion);
  });

  it('reads ENFORCING after a real engine fetch (the state that was unreachable)', () => {
    const s = trinoEnforcementStatus(doc({
      at: '2026-08-07T00:01:00Z', version: servedVersion,
      catalogs: ['system', 'jmx', 'memory', 'iceberg'], by: 'loom-trino (internal token)',
    }));
    expect(s.state).toBe('enforcing');
    expect(s.enforcingVersion).toBe(s.publishedVersion);
    expect(s.detail).toMatch(/enforcing rules version/);
    // And it must NOT assert a cause the code never established.
    expect(s.detail).not.toMatch(/cannot reach/);
  });

  it('still reports never-fetched honestly when the engine has not pulled', () => {
    const s = trinoEnforcementStatus(doc());
    expect(s.state).toBe('never-fetched');
    expect(s.detail).toMatch(/NEVER fetched/);
  });

  it('reports stale — and only stale — when the engine holds an OLDER policy', () => {
    const s = trinoEnforcementStatus(doc({
      at: '2026-08-07T00:01:00Z', version: 'deadbeef', catalogs: ['system'], by: 'loom-trino',
    }));
    expect(s.state).toBe('stale');
    expect(s.enforcingVersion).toBe('deadbeef');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LU-7 — the PUBLISH side and the SERVE side must compile the SAME document.
//
// Fixing the version hash was not enough on its own: the two sides also have to
// receive the same compile options. `reconcilePolicyCode` built
// `{ ucVariant, tenantId }` and dropped `trinoDefaultCatalog`, while the
// engine-rules route passed `LOOM_TRINO_ICEBERG_CATALOG`. A 2-part
// `schema.table` resource resolves against that catalog, so under a non-default
// lake name the publisher compiled `iceberg.sales.orders` and the engine was
// served `lake.sales.orders`:
//
//   * the versions could never converge  -> permanent `stale`, never `applied`,
//     and the hedged detail resolves to the false "cannot reach the Console";
//   * WORSE, the engine governed `lake.sales.orders` while the document an
//     admin inspects claimed `iceberg.sales.orders` — the control and its
//     receipt describing different tables.
//
// No bicep module sets the knob today, so the default deployment was unaffected
// — which is precisely why it would have sat there undetected. These pin the
// option set, not just the hash.
// ─────────────────────────────────────────────────────────────────────────────
describe('LU-7 compile options — publish and serve must not diverge', () => {
  /** A deliberately 2-PART resource: it resolves against the lake catalog. */
  const twoPartSet = normalizePolicyCodeSet({
    apiVersion: 'loom.governance/v1',
    name: 'two-part',
    statements: [{
      id: 's1',
      principals: [{ kind: 'user', id: 'u1', name: 'alice@contoso.com' }],
      resources: [{ backend: 'trino', object: 'sales.orders' }],
      actions: ['read'],
    }],
  });

  const versionFor = (opts: { trinoDefaultCatalog?: string; trinoSessionUser?: string }, catalogs?: any[]) =>
    rulesVersion(buildTrinoRulesDocument(compileTrino(twoPartSet, opts), catalogs ? { ...opts, catalogs } : opts));

  it('publish and serve agree under a NON-DEFAULT lake catalog with a 2-part resource', () => {
    const lake = 'lake';
    // Publish side: reconcile, no engine catalog list available.
    const publishVersion = versionFor({ trinoDefaultCatalog: lake });
    // Serve side: the route, WITH the engine's reported catalog list.
    const serveVersion = versionFor({ trinoDefaultCatalog: lake }, [
      { name: 'system', allow: 'read-only' },
      { name: 'memory', allow: 'all' },
      { name: lake, allow: 'read-only' },
    ]);
    expect(serveVersion).toBe(publishVersion);
  });

  it('DIVERGES when the lake catalog is dropped on one side (the bug, pinned)', () => {
    // This is the failure the fix prevents: same policy, different catalog
    // option => different document => a receipt that can never converge.
    const withLake = versionFor({ trinoDefaultCatalog: 'lake' });
    const withoutLake = versionFor({});
    expect(withLake).not.toBe(withoutLake);
  });

  it('resolves the 2-part resource against the DEPLOYMENT lake, not the code default', () => {
    const doc = buildTrinoRulesDocument(compileTrino(twoPartSet, { trinoDefaultCatalog: 'lake' }), {});
    const rule = doc.tables.find((r) => r.user === '^alice@contoso\\.com$')!;
    expect(rule.catalog).toBe('^lake$');
    // The document an admin inspects must name the table the engine governs.
    expect(rule.catalog).not.toBe('^iceberg$');
  });

  it('the session user reaches the impersonation rule from the same option set', () => {
    const doc = buildTrinoRulesDocument(
      compileTrino(twoPartSet, { trinoDefaultCatalog: 'lake' }),
      { trinoSessionUser: 'svc-loom', trinoDefaultCatalog: 'lake' },
    );
    expect(doc.impersonation[0].original_user).toBe('^svc-loom$');
  });
});
