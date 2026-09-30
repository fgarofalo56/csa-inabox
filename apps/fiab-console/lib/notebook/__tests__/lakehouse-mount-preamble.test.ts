/**
 * Tests for the notebook auto-mount preamble builder (issue #655). Pure
 * function, no network — verifies the `loom_lakehouses` dict is emitted with
 * real abfss paths, that names/paths are safely escaped, and that an empty
 * input emits nothing (so no empty cell is injected).
 */
import { describe, it, expect } from 'vitest';
import { buildLakehouseMountPreamble, resolveAttachedLakehouses } from '../lakehouse-mount-preamble';

describe('buildLakehouseMountPreamble', () => {
  it('returns empty string when there are no sources', () => {
    expect(buildLakehouseMountPreamble([])).toBe('');
    expect(buildLakehouseMountPreamble([{ displayName: 'x', abfss: '' }])).toBe('');
    expect(buildLakehouseMountPreamble([{ displayName: '', abfss: 'abfss://a@b.dfs.core.windows.net/c' }])).toBe('');
  });

  it('emits a loom_lakehouses dict keyed by display name', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: 'sales', abfss: 'abfss://gold@acct.dfs.core.windows.net/lakehouses/sales' },
      { displayName: 'inventory', abfss: 'abfss://silver@acct.dfs.core.windows.net/lakehouses/inventory' },
    ]);
    expect(out).toContain('loom_lakehouses = {');
    expect(out).toContain("'sales': 'abfss://gold@acct.dfs.core.windows.net/lakehouses/sales',");
    expect(out).toContain("'inventory': 'abfss://silver@acct.dfs.core.windows.net/lakehouses/inventory',");
    expect(out).toContain("spark.conf.set('loom.lakehouses.mounted'");
  });

  it('escapes single quotes and backslashes in names and paths', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: "o'brien", abfss: "abfss://c@a.dfs.core.windows.net/has'quote" },
    ]);
    expect(out).toContain("'o\\'brien'");
    expect(out).toContain("has\\'quote");
  });

  it('drops only the falsy entries, keeps the valid ones', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: 'ok', abfss: 'abfss://c@a.dfs.core.windows.net/r' },
      { displayName: 'bad', abfss: '' },
    ]);
    expect(out).toContain("'ok':");
    expect(out).not.toContain("'bad':");
  });

  it('keeps a plain dict when nothing is withheld', () => {
    const out = buildLakehouseMountPreamble([
      { displayName: 'ok', abfss: 'abfss://c@a.dfs.core.windows.net/r' },
    ]);
    // BREAKS IF the withheld branch is taken with an empty withheld list: the
    // class wrapper would appear and the plain `loom_lakehouses = {` would not.
    expect(out).toContain('loom_lakehouses = {');
    expect(out).not.toContain('_LoomLakehouses');
  });

  it('says why a withheld lakehouse is missing: a KeyError carrying the reason, and a printed line', () => {
    const reason = 'Its storage root is also used by another lakehouse.';
    const out = buildLakehouseMountPreamble([
      { displayName: 'ok', abfss: 'abfss://c@a.dfs.core.windows.net/r' },
      { displayName: 'Sales', abfss: '', withheld: reason },
    ]);
    // BREAKS IF withheld entries are dropped like any other empty-path entry
    // (the pre-change filter): none of these lines would be emitted.
    expect(out).toContain('class _LoomLakehouses(dict):');
    expect(out).toContain(`        'Sales': '${reason}',`);
    expect(out).toContain("raise KeyError(str(key) + ': ' + self._withheld[key])");
    expect(out).toContain(`print('Lakehouse Sales was not mounted: ${reason}')`);
    // The mounted one is still a real entry. BREAKS IF the valid entries are
    // lost when a withheld one is present.
    expect(out).toContain("loom_lakehouses = _LoomLakehouses({");
    expect(out).toContain("    'ok': 'abfss://c@a.dfs.core.windows.net/r',");
    // BREAKS IF a withheld entry is written as a mount with an empty path.
    expect(out).not.toContain("'Sales': '',");
  });

  it('emits the explanation even when every attached lakehouse is withheld', () => {
    const out = buildLakehouseMountPreamble([{ displayName: 'Only', abfss: '', withheld: 'why' }]);
    // BREAKS IF the early return still checks only mounted entries: out is ''.
    expect(out).toContain("print('Lakehouse Only was not mounted: why')");
    expect(out).toContain('loom_lakehouses = _LoomLakehouses({');
  });
});

// #4759 — the notebook run route resolves attached lakehouses through
// resolveAttachedLakehouses. A resolve can now reach storage, so they must run
// concurrently, and the output must still be in attachment order.
describe('resolveAttachedLakehouses', () => {
  const lh = (id: string, displayName?: string) => ({ kind: 'lakehouse', id, displayName });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** A resolver whose answers the test releases by hand, recording call order. */
  function manualResolver() {
    const started: string[] = [];
    const release = new Map<string, (v: { abfss: string } | null) => void>();
    const resolve = (id: string) => {
      started.push(id);
      return new Promise<{ abfss: string } | null>((res) => release.set(id, res));
    };
    return { started, release, resolve };
  }

  it('starts every resolve before any of them answers', async () => {
    const { started, release, resolve } = manualResolver();
    const pending = resolveAttachedLakehouses([lh('a', 'A'), lh('b', 'B'), lh('c', 'C')], resolve);
    // Nothing has been released yet. BREAKS IF resolved one after another:
    // `b` cannot start until `a` answers, so `started` would be ['a'].
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) release.get(id)!(null);
    await pending;
  });

  it('returns attachment order, not completion order', async () => {
    const { release, resolve } = manualResolver();
    const pending = resolveAttachedLakehouses([lh('a', 'A'), lh('b', 'B'), lh('c', 'C')], resolve);
    await tick();
    // Answer in REVERSE order. BREAKS IF results are collected as they
    // complete: that yields [C, A]; attachment order is [A, C] (b is null).
    release.get('c')!({ abfss: 'abfss://c' });
    await tick();
    release.get('b')!(null);
    release.get('a')!({ abfss: 'abfss://a' });
    expect(await pending).toEqual([
      { displayName: 'A', abfss: 'abfss://a' },
      { displayName: 'C', abfss: 'abfss://c' },
    ]);
  });

  it('skips a source that throws without dropping its siblings, and ignores non-lakehouse sources', async () => {
    const calls: string[] = [];
    const out = await resolveAttachedLakehouses(
      [lh('ok1'), { kind: 'warehouse', id: 'wh' }, lh('boom', 'Boom'), { kind: 'lakehouse' }, lh('ok2', 'Two')],
      async (id) => {
        calls.push(id);
        if (id === 'boom') throw new Error('storage unreachable');
        return { abfss: `abfss://${id}` };
      },
    );
    // BREAKS IF a throw rejects the whole batch (no per-source catch): the
    // call rejects instead of returning these two. `ok1` has no displayName,
    // so its id is the key.
    expect(out).toEqual([
      { displayName: 'ok1', abfss: 'abfss://ok1' },
      { displayName: 'Two', abfss: 'abfss://ok2' },
    ]);
    // BREAKS IF the kind/id filter is dropped: `wh` and `undefined` would be resolved too.
    expect([...calls].sort()).toEqual(['boom', 'ok1', 'ok2']);
  });

  it('passes a withheld reason through with no path, in attachment order', async () => {
    const out = await resolveAttachedLakehouses(
      [lh('a', 'A'), lh('b', 'B')],
      async (id) => (id === 'a' ? { withheld: 'root in use' } : { abfss: 'abfss://b' }),
    );
    // BREAKS IF `{ withheld }` is read as a path (abfss undefined) or skipped
    // like null: the first element would differ or be missing.
    expect(out).toEqual([
      { displayName: 'A', abfss: '', withheld: 'root in use' },
      { displayName: 'B', abfss: 'abfss://b' },
    ]);
  });

  it('returns nothing for no attached sources', async () => {
    let called = 0;
    const resolve = async () => { called += 1; return { abfss: 'abfss://x' }; };
    expect(await resolveAttachedLakehouses(undefined, resolve)).toEqual([]);
    expect(await resolveAttachedLakehouses([], resolve)).toEqual([]);
    expect(called).toBe(0);
  });
});
