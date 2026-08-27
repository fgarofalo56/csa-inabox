/**
 * `lib/azure/data-agent-autobind.ts` — the platform-performed source binding
 * for `data-agent` (#4092, `.claude/rules/auto-bind-by-default.md`).
 *
 * Everything here runs the REAL module. The two seams that would otherwise
 * require Azure — the workspace candidate lookup and the Cosmos write — are
 * injected, so the DECISION (which source, on what precedence, recorded how)
 * is exercised end to end rather than mocked away.
 *
 * The properties pinned, and why each is load-bearing:
 *
 *   PRECEDENCE   is a stated rule, not "whatever Cosmos returned first". Rule
 *                §2 requires the mapping be "recorded […] so it is inspectable,
 *                never guessed"; a binding that depends on result order is a
 *                guess with a record attached.
 *   TOTALITY     every input has an answer — type precedence, then createdAt,
 *                then id. The id tie-break is a total order, so there is no
 *                pair this function has to choose arbitrarily between.
 *   ID SHAPE     `<type>:<itemId>:auto` — the third segment is required by
 *                `data-agent-execute`'s `/^semantic-model:([^:]+):/`.
 *   RESTRAINT    it never edits an agent that already has sources, and it never
 *                runs twice. Re-attaching under a user who deliberately removed
 *                a source would be the platform arguing with the operator.
 *   HONESTY      a failed Cosmos write is reported as `persisted:false` with
 *                the binding still applied in memory — never a silent success
 *                and never a thrown create.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DA_AUTO_BIND_PROVIDER,
  DA_AUTO_BIND_TYPES,
  autoBindDataAgentSources,
  buildAutoBindRecord,
  buildAutoBoundSource,
  pickAutoBindCandidate,
  shouldAutoBindSources,
  type DaBindCandidate,
} from '../data-agent-autobind';
import { readAutoBindRecord } from '../auto-bind';

const WS = 'ws-casino-analytics';

function agent(state: Record<string, unknown>): any {
  return {
    id: 'agent-1', workspaceId: WS, itemType: 'data-agent',
    displayName: 'Casino Data Agent', state,
    createdBy: 'u@x', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };
}
const wh = (id: string, name: string, createdAt?: string): DaBindCandidate =>
  ({ id, itemType: 'warehouse', displayName: name, createdAt });

describe('pickAutoBindCandidate — the deterministic choice', () => {
  it('returns null when the workspace holds nothing compatible', () => {
    expect(pickAutoBindCandidate([])).toBeNull();
    // A workspace full of item types this module does not bind is still "nothing
    // compatible" — it must not fall back to binding an arbitrary item.
    expect(pickAutoBindCandidate([
      { id: 'n1', itemType: 'notebook', displayName: 'N' },
      { id: 'r1', itemType: 'report', displayName: 'R' },
    ])).toBeNull();
  });

  it('binds the single compatible item — the reported Casino case', () => {
    const chosen = pickAutoBindCandidate([wh('335e10ae', 'Casino Data Warehouse', '2026-07-01T00:00:00.000Z')]);
    expect(chosen?.id).toBe('335e10ae');
  });

  it('prefers a warehouse over every lower-precedence type, regardless of count', () => {
    const chosen = pickAutoBindCandidate([
      { id: 'k1', itemType: 'kql-database', displayName: 'K1', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'l1', itemType: 'lakehouse', displayName: 'L1', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'l2', itemType: 'lakehouse', displayName: 'L2', createdAt: '2020-01-02T00:00:00.000Z' },
      { id: 'sm', itemType: 'semantic-model', displayName: 'SM', createdAt: '2019-01-01T00:00:00.000Z' },
      // Newest by a wide margin, and still the winner: TYPE outranks age.
      wh('w1', 'W1', '2026-08-26T00:00:00.000Z'),
    ]);
    expect(chosen?.id).toBe('w1');
  });

  it('walks the whole precedence table in order', () => {
    // lakehouse wins when no warehouse exists; semantic-model when neither; etc.
    expect(pickAutoBindCandidate([
      { id: 'k', itemType: 'kql-database', displayName: 'K' },
      { id: 'l', itemType: 'lakehouse', displayName: 'L' },
      { id: 's', itemType: 'semantic-model', displayName: 'S' },
    ])?.id).toBe('l');
    expect(pickAutoBindCandidate([
      { id: 'k', itemType: 'kql-database', displayName: 'K' },
      { id: 's', itemType: 'semantic-model', displayName: 'S' },
    ])?.id).toBe('s');
    expect(pickAutoBindCandidate([
      { id: 'k', itemType: 'kql-database', displayName: 'K' },
    ])?.id).toBe('k');
  });

  it('within a type, takes the OLDEST — the workspace\'s established source', () => {
    const chosen = pickAutoBindCandidate([
      wh('new', 'Newest', '2026-08-01T00:00:00.000Z'),
      wh('old', 'Oldest', '2024-01-01T00:00:00.000Z'),
      wh('mid', 'Middle', '2025-05-05T00:00:00.000Z'),
    ]);
    expect(chosen?.id).toBe('old');
  });

  it('is INDEPENDENT of input order (the property a query-order bug would break)', () => {
    const rows = [
      wh('c', 'C', '2025-01-03T00:00:00.000Z'),
      wh('a', 'A', '2025-01-01T00:00:00.000Z'),
      wh('b', 'B', '2025-01-02T00:00:00.000Z'),
    ];
    const forward = pickAutoBindCandidate(rows)?.id;
    const reversed = pickAutoBindCandidate([...rows].reverse())?.id;
    const shuffled = pickAutoBindCandidate([rows[1], rows[2], rows[0]])?.id;
    expect(forward).toBe('a');
    expect(reversed).toBe('a');
    expect(shuffled).toBe('a');
  });

  it('breaks a createdAt tie lexicographically by id — a TOTAL order', () => {
    const same = '2025-01-01T00:00:00.000Z';
    expect(pickAutoBindCandidate([wh('zeta', 'Z', same), wh('alpha', 'A', same)])?.id).toBe('alpha');
    expect(pickAutoBindCandidate([wh('alpha', 'A', same), wh('zeta', 'Z', same)])?.id).toBe('alpha');
  });

  it('sorts an ABSENT createdAt LAST, so an undated row cannot displace a dated one', () => {
    // The naive `a.createdAt || ''` sorts undated FIRST and wins every
    // comparison against a real ISO timestamp.
    const chosen = pickAutoBindCandidate([
      wh('undated', 'Undated'),
      wh('dated', 'Dated', '2025-06-01T00:00:00.000Z'),
    ]);
    expect(chosen?.id).toBe('dated');
  });

  it('ignores rows with no usable id rather than binding to nothing', () => {
    expect(pickAutoBindCandidate([{ id: '', itemType: 'warehouse', displayName: 'Broken' }])).toBeNull();
  });
});

describe('buildAutoBoundSource — the shape the editor and executor read', () => {
  it('emits <type>:<itemId>:auto, keeping the third segment the executor needs', () => {
    const src = buildAutoBoundSource(wh('335e10ae', 'Casino Data Warehouse'))!;
    expect(src.id).toBe('warehouse:335e10ae:auto');
    expect(src.type).toBe('warehouse');
    expect(src.name).toBe('Casino Data Warehouse');
  });

  it('produces an id data-agent-execute can still parse for a semantic model', () => {
    const src = buildAutoBoundSource({ id: 'sm-9', itemType: 'semantic-model', displayName: 'Finance' })!;
    // The live regex, copied verbatim from lib/azure/data-agent-execute.ts.
    expect(/^semantic-model:([^:]+):/.exec(src.id)?.[1]).toBe('sm-9');
  });

  it('maps kql-database to the kql source type the picker uses', () => {
    expect(buildAutoBoundSource({ id: 'k1', itemType: 'kql-database', displayName: 'Logs' })!.type).toBe('kql');
  });

  it('is idempotent — the same candidate always yields a byte-identical source', () => {
    const c = wh('w1', 'W');
    expect(buildAutoBoundSource(c)).toEqual(buildAutoBoundSource(c));
  });

  it('falls back to the id when the item has no display name', () => {
    expect(buildAutoBoundSource(wh('w1', ''))!.name).toBe('w1');
  });

  it('refuses an item type outside the precedence table', () => {
    expect(buildAutoBoundSource({ id: 'n1', itemType: 'notebook', displayName: 'N' })).toBeNull();
  });
});

describe('buildAutoBindRecord — inspectable, per rule §2', () => {
  it('round-trips through readAutoBindRecord and names the exact backing item', () => {
    const rec = buildAutoBindRecord(wh('335e10ae', 'Casino Data Warehouse'), WS, new Date('2026-08-26T12:00:00.000Z'));
    const parsed = readAutoBindRecord({ autoBind: rec });
    expect(parsed).not.toBeNull();
    expect(parsed!.provider).toBe(DA_AUTO_BIND_PROVIDER);
    expect(parsed!.backingName).toBe('Casino Data Warehouse');
    // The mapping is inspectable rather than guessed: the item id, its type and
    // the workspace are all on the record.
    expect(parsed!.coords).toMatchObject({ workspaceId: WS, itemId: '335e10ae', itemType: 'warehouse', sourceType: 'warehouse' });
    expect(parsed!.boundAt).toBe('2026-08-26T12:00:00.000Z');
  });

  it('records via:"attached" — nothing was created, and the record must not claim it was', () => {
    expect(buildAutoBindRecord(wh('w1', 'W'), WS).via).toBe('attached');
    expect(buildAutoBindRecord(wh('w1', 'W'), WS).sanitized).toBe(false);
  });
});

describe('shouldAutoBindSources — when the platform may act', () => {
  it('acts on a fresh agent', () => {
    expect(shouldAutoBindSources({ sources: [], instructions: '' })).toBe(true);
    expect(shouldAutoBindSources({})).toBe(true);
    expect(shouldAutoBindSources(undefined)).toBe(true);
  });

  it('never touches an agent that already has sources', () => {
    expect(shouldAutoBindSources({ sources: [{ id: 'warehouse:x:1', type: 'warehouse', name: 'X' }] })).toBe(false);
  });

  it('treats a LEGACY comma-separated string of sources as a real binding', () => {
    // normalizeDaSources exists because this shape is in the live store; a
    // length check on it would read '' vs 'a,b' wrong in one direction or the
    // other, so it is handled explicitly.
    expect(shouldAutoBindSources({ sources: 'fin-warehouse, orders model' })).toBe(false);
    expect(shouldAutoBindSources({ sources: '   ' })).toBe(true);
  });

  it('refuses to overwrite a sources value of an unrecognised shape', () => {
    expect(shouldAutoBindSources({ sources: { weird: true } })).toBe(false);
  });

  it('runs ONCE — prior provenance retires it, so it never re-attaches under the user', () => {
    const rec = buildAutoBindRecord(wh('w1', 'W'), WS);
    // The user auto-bound, then deliberately removed the source. That is a
    // choice, not a dead end (the picker works), so the platform stands down.
    expect(shouldAutoBindSources({ sources: [], autoBind: rec })).toBe(false);
  });

  it('is not blocked by ANOTHER provider\'s auto-bind record', () => {
    // e.g. an item that also carries a pipeline binding — only this module's own
    // provenance means "I already ran".
    expect(shouldAutoBindSources({ sources: [], autoBind: { provider: 'adf-pipeline', backingName: 'p1' } })).toBe(true);
  });
});

describe('autoBindDataAgentSources — the end-to-end bind', () => {
  const candidates = [
    { id: 'lh-1', itemType: 'lakehouse', displayName: 'Bronze', createdAt: '2024-01-01T00:00:00.000Z' },
    wh('335e10ae', 'Casino Data Warehouse', '2025-01-01T00:00:00.000Z'),
  ];

  it('binds a fresh agent, patches state, and persists', async () => {
    const persist = vi.fn(async () => true);
    const it0 = agent({ sources: [], instructions: '' });
    const r = await autoBindDataAgentSources(it0, {
      listCandidates: async () => candidates,
      persist,
      now: () => new Date('2026-08-26T12:00:00.000Z'),
    });

    expect(r).not.toBeNull();
    expect(r!.source.id).toBe('warehouse:335e10ae:auto');
    expect(r!.source.name).toBe('Casino Data Warehouse');
    expect(r!.persisted).toBe(true);

    // In memory: the caller's item now carries the binding, so the GET that
    // triggered this serialises a BOUND agent.
    expect((it0.state as any).sources).toHaveLength(1);
    expect((it0.state as any).sources[0].id).toBe('warehouse:335e10ae:auto');
    // And it did not clobber the rest of state.
    expect((it0.state as any).instructions).toBe('');

    // Persisted exactly the two keys, scoped to the item's own partition.
    expect(persist).toHaveBeenCalledTimes(1);
    const [itemId, workspaceId, patch] = persist.mock.calls[0] as any[];
    expect(itemId).toBe('agent-1');
    expect(workspaceId).toBe(WS);
    expect(Object.keys(patch).sort()).toEqual(['autoBind', 'sources']);
  });

  it('scopes the candidate lookup to the agent\'s OWN workspace', async () => {
    const listCandidates = vi.fn(async () => candidates);
    await autoBindDataAgentSources(agent({ sources: [] }), { listCandidates, persist: async () => true });
    expect(listCandidates).toHaveBeenCalledWith(WS);
  });

  it('no-ops when the agent already has sources — never replaces a user binding', async () => {
    const listCandidates = vi.fn(async () => candidates);
    const persist = vi.fn(async () => true);
    const existing = [{ id: 'lakehouse:lh-9:171', type: 'lakehouse', name: 'Mine' }];
    const it0 = agent({ sources: existing });

    expect(await autoBindDataAgentSources(it0, { listCandidates, persist })).toBeNull();
    expect(listCandidates).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect((it0.state as any).sources).toBe(existing);
  });

  it('no-ops on an empty workspace — an honest "nothing to bind", not an invented one', async () => {
    const persist = vi.fn(async () => true);
    const it0 = agent({ sources: [] });
    expect(await autoBindDataAgentSources(it0, { listCandidates: async () => [], persist })).toBeNull();
    expect(persist).not.toHaveBeenCalled();
    expect((it0.state as any).sources).toEqual([]);
  });

  it('applies the binding in memory even when the Cosmos write FAILS, and says so', async () => {
    const it0 = agent({ sources: [] });
    const r = await autoBindDataAgentSources(it0, {
      listCandidates: async () => candidates,
      persist: async () => false,
    });
    expect(r!.persisted).toBe(false);
    // The editor still opens bound; the next open re-derives the same decision.
    expect((it0.state as any).sources).toHaveLength(1);
  });

  it('never throws when the candidate lookup blows up', async () => {
    const it0 = agent({ sources: [] });
    const r = await autoBindDataAgentSources(it0, {
      listCandidates: async () => { throw new Error('Cosmos 503'); },
      persist: async () => true,
    });
    expect(r).toBeNull();
    // Create/open must be unaffected.
    expect((it0.state as any).sources).toEqual([]);
  });

  it('never throws when the persist blows up', async () => {
    const r = await autoBindDataAgentSources(agent({ sources: [] }), {
      listCandidates: async () => candidates,
      persist: async () => { throw new Error('Cosmos 429'); },
    });
    expect(r).toBeNull();
  });

  it('refuses a non data-agent item', async () => {
    const persist = vi.fn(async () => true);
    const notAnAgent = { ...agent({ sources: [] }), itemType: 'notebook' };
    expect(await autoBindDataAgentSources(notAnAgent as any, { listCandidates: async () => candidates, persist })).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it('is idempotent across a second call — provenance stops the re-bind', async () => {
    const persist = vi.fn(async () => true);
    const it0 = agent({ sources: [], instructions: '' });
    const opts = { listCandidates: async () => candidates, persist };
    const first = await autoBindDataAgentSources(it0, opts);
    const second = await autoBindDataAgentSources(it0, opts);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(persist).toHaveBeenCalledTimes(1);
    expect((it0.state as any).sources).toHaveLength(1);
  });
});

describe('DA_AUTO_BIND_TYPES — the precedence table itself', () => {
  it('is the documented four, in the documented order', () => {
    expect(DA_AUTO_BIND_TYPES.map((t) => t.itemType)).toEqual([
      'warehouse', 'lakehouse', 'semantic-model', 'kql-database',
    ]);
  });

  it('maps each item type to the source type the picker and executor use', () => {
    // Drift here silently produces a source the editor renders as an unknown
    // type and the executor cannot route to.
    expect(Object.fromEntries(DA_AUTO_BIND_TYPES.map((t) => [t.itemType, t.sourceType]))).toEqual({
      'warehouse': 'warehouse',
      'lakehouse': 'lakehouse',
      'semantic-model': 'semantic-model',
      'kql-database': 'kql',
    });
  });
});
