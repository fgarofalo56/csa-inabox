/**
 * FLAG0 — runtime-flags helper unit tests.
 *
 * Contract under test (ws-verification-dr.md FLAG0):
 *   • missing doc → default ON (loom_default_on_opt_out)
 *   • flipped doc → OFF honored
 *   • setRuntimeFlag invalidates the read cache (a flip is visible on the
 *     very next read, inside the 15 s TTL window) + writes the audit row
 *   • fail-open: an unreachable Cosmos never gates a surface
 *
 * Cosmos + the SIEM stream are mocked; the REAL query-result-cache runs so
 * the cache-invalidation-on-write behavior is what's actually asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({
  runtimeFlagsContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));

import { runtimeFlag, setRuntimeFlag, listRuntimeFlags } from '@/lib/admin/runtime-flags';
import { runtimeFlagsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

// ── in-memory fake Cosmos containers ───────────────────────────────────────

function makeFlagsContainer(initial: Record<string, any> = {}) {
  const docs = new Map<string, any>(Object.entries(initial));
  let reads = 0;
  return {
    reads: () => reads,
    docs,
    item: (id: string) => ({
      read: async () => {
        reads++;
        const resource = docs.get(id);
        if (!resource) {
          const err: any = new Error('NotFound');
          err.code = 404;
          throw err;
        }
        return { resource };
      },
    }),
    items: {
      upsert: async (doc: any) => {
        docs.set(doc.id, doc);
        return { resource: doc };
      },
      query: () => ({ fetchAll: async () => ({ resources: [...docs.values()] }) }),
    },
  };
}

function makeAuditContainer() {
  const rows: any[] = [];
  return {
    rows,
    items: {
      create: async (row: any) => {
        rows.push(row);
        return { resource: row };
      },
    },
  };
}

const ACTOR = { oid: 'oid-1', who: 'admin@contoso.com', tenantId: 'tid-1' };

beforeEach(() => {
  vi.mocked(emitAuditEvent).mockReset();
});

describe('FLAG0 runtime-flags helper', () => {
  it('missing doc → default ON', async () => {
    const flags = makeFlagsContainer();
    vi.mocked(runtimeFlagsContainer).mockResolvedValue(flags as any);
    await expect(runtimeFlag('t1-missing-flag')).resolves.toBe(true);
  });

  it('flipped doc → OFF honored (and an explicit ON doc stays ON)', async () => {
    const flags = makeFlagsContainer({
      't2-off-flag': { id: 't2-off-flag', enabled: false, updatedAt: 'x' },
      't2-on-flag': { id: 't2-on-flag', enabled: true, updatedAt: 'x' },
    });
    vi.mocked(runtimeFlagsContainer).mockResolvedValue(flags as any);
    await expect(runtimeFlag('t2-off-flag')).resolves.toBe(false);
    await expect(runtimeFlag('t2-on-flag')).resolves.toBe(true);
  });

  it('reads are cached — a second read inside the TTL does not hit Cosmos', async () => {
    const flags = makeFlagsContainer();
    vi.mocked(runtimeFlagsContainer).mockResolvedValue(flags as any);
    await runtimeFlag('t3-cached-flag');
    const after = flags.reads();
    await runtimeFlag('t3-cached-flag');
    expect(flags.reads()).toBe(after); // served from the in-process cache
  });

  it('setRuntimeFlag flips the doc, invalidates the cache, and audits', async () => {
    const flags = makeFlagsContainer();
    const audit = makeAuditContainer();
    vi.mocked(runtimeFlagsContainer).mockResolvedValue(flags as any);
    vi.mocked(auditLogContainer).mockResolvedValue(audit as any);

    // Prime the cache at the default (ON).
    await expect(runtimeFlag('t4-flip-flag')).resolves.toBe(true);

    await setRuntimeFlag('t4-flip-flag', false, ACTOR);

    // The flip is honored on the VERY NEXT read — the cached ON slot was
    // dropped by invalidateModel, not left to age out over the 15 s TTL.
    await expect(runtimeFlag('t4-flip-flag')).resolves.toBe(false);

    // Authoritative audit row: actor who/oid, action kind, prior/new, ts.
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      itemId: 'runtime-flag:t4-flip-flag',
      who: ACTOR.who,
      actorOid: ACTOR.oid,
      tenantId: ACTOR.tenantId,
      kind: 'runtime-flag.disable',
      detail: { prior: true, next: false },
    });
    expect(typeof audit.rows[0].at).toBe('string');
    // SIEM/webhook fan-out fired once.
    expect(vi.mocked(emitAuditEvent)).toHaveBeenCalledTimes(1);

    // Flip back ON → restored, audited as enable with prior:false.
    await setRuntimeFlag('t4-flip-flag', true, ACTOR);
    await expect(runtimeFlag('t4-flip-flag')).resolves.toBe(true);
    expect(audit.rows[1]).toMatchObject({
      kind: 'runtime-flag.enable',
      detail: { prior: false, next: true },
    });
  });

  it('fail-open: an unreachable Cosmos returns the default, never throws', async () => {
    vi.mocked(runtimeFlagsContainer).mockRejectedValue(new Error('cosmos down'));
    await expect(runtimeFlag('t5-unreachable-flag')).resolves.toBe(true);
    await expect(runtimeFlag('t5-unreachable-flag', { default: false })).resolves.toBe(false);
  });

  it('listRuntimeFlags returns exactly the typed registry joined with state', async () => {
    const flags = makeFlagsContainer({
      'not-registered': { id: 'not-registered', enabled: false },
    });
    vi.mocked(runtimeFlagsContainer).mockResolvedValue(flags as any);
    const list = await listRuntimeFlags();
    // Only REGISTERED flags are listed — stray docs never surface in /admin.
    expect(list.every((f) => f.id !== 'not-registered')).toBe(true);
    for (const f of list) {
      expect(typeof f.enabled).toBe('boolean');
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.ownerItem.length).toBeGreaterThan(0);
    }
  });

  it("U1 registers 'u1-report-designer-g3' — default ON with no doc (kill-switch contract)", async () => {
    const flags = makeFlagsContainer();
    vi.mocked(runtimeFlagsContainer).mockResolvedValue(flags as any);
    const list = await listRuntimeFlags();
    const u1 = list.find((f) => f.id === 'u1-report-designer-g3');
    expect(u1).toBeTruthy();
    expect(u1!.ownerItem).toBe('U1');
    // No Cosmos doc → the flagged G3 layout is ON by default (opt-out, FLAG0).
    expect(u1!.enabled).toBe(true);
  });
});
