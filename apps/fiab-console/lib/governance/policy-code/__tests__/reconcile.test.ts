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
