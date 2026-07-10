import { describe, it, expect, afterEach } from 'vitest';
import {
  sanitizeSuggestInput,
  buildSuggestPrompt,
  clampSuggestions,
  isCanvasSuggestEnabled,
} from '../canvas-suggest';

describe('canvas-suggest / sanitizeSuggestInput', () => {
  it('returns null without itemType or palette', () => {
    expect(sanitizeSuggestInput({ nodes: [], paletteKeys: ['Copy'] })).toBeNull();
    expect(sanitizeSuggestInput({ itemType: 'data-pipeline', paletteKeys: [] })).toBeNull();
    expect(sanitizeSuggestInput({ itemType: 'data-pipeline' })).toBeNull();
  });

  it('bounds + coerces nodes and drops dangling edges', () => {
    const out = sanitizeSuggestInput({
      itemType: 'data-pipeline',
      paletteKeys: ['Copy', 'Copy', 'Lookup'],
      nodes: [
        { id: 'a', type: 'Copy', label: 'Ingest' },
        { id: '', type: 'x' }, // dropped (no id)
        { id: 'b' },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'ghost' }, // dropped (unknown target)
        { source: 'a' }, // dropped (no target)
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.paletteKeys).toEqual(['Copy', 'Lookup']); // de-duped
    expect(out!.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(out!.edges).toEqual([{ source: 'a', target: 'b' }]);
  });

  it('caps node/palette counts', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}` }));
    const palette = Array.from({ length: 200 }, (_, i) => `k${i}`);
    const out = sanitizeSuggestInput({ itemType: 'x', nodes, paletteKeys: palette });
    expect(out!.nodes.length).toBeLessThanOrEqual(60);
    expect(out!.paletteKeys.length).toBeLessThanOrEqual(100);
  });
});

describe('canvas-suggest / clampSuggestions', () => {
  const palette = ['Copy', 'Lookup', 'ExecuteDataFlow'];

  it('keeps only allowlisted keys, de-dupes, caps at 3', () => {
    const out = clampSuggestions(
      [
        { key: 'Copy', label: 'Copy data', reason: 'source next' },
        { key: 'Copy', label: 'dup' },
        { key: 'NotReal', label: 'evil' },
        { key: 'Lookup' },
        { key: 'ExecuteDataFlow' },
        { key: 'Copy' },
      ],
      palette,
    );
    expect(out.map((s) => s.key)).toEqual(['Copy', 'Lookup', 'ExecuteDataFlow']);
    expect(out[1].label).toBe('Lookup'); // falls back to key when no label
  });

  it('never lets __proto__ through the allowlist', () => {
    const out = clampSuggestions([{ key: '__proto__', label: 'x' }], palette);
    expect(out).toEqual([]);
    // eslint-disable-next-line no-proto
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('tolerates non-array / junk', () => {
    expect(clampSuggestions(null, palette)).toEqual([]);
    expect(clampSuggestions('nope', palette)).toEqual([]);
    expect(clampSuggestions([null, 3, {}], palette)).toEqual([]);
  });
});

describe('canvas-suggest / buildSuggestPrompt', () => {
  it('lists palette + nodes + edges and constrains keys', () => {
    const { system, user } = buildSuggestPrompt({
      itemType: 'data-pipeline',
      paletteKeys: ['Copy', 'Lookup'],
      nodes: [{ id: 'a', type: 'Copy', label: 'Ingest' }],
      edges: [],
    });
    expect(system).toMatch(/palette allowlist/i);
    expect(system).toContain('data-pipeline');
    expect(user).toContain('Copy, Lookup');
    expect(user).toContain('a [Copy]: Ingest');
    expect(user).toContain('(none)');
  });
});

describe('canvas-suggest / kill-switch', () => {
  afterEach(() => { delete process.env.LOOM_CANVAS_AI_SUGGEST; });
  it('defaults ON and honors opt-out values', () => {
    expect(isCanvasSuggestEnabled()).toBe(true);
    for (const v of ['0', 'false', 'off', 'no', 'FALSE']) {
      process.env.LOOM_CANVAS_AI_SUGGEST = v;
      expect(isCanvasSuggestEnabled()).toBe(false);
    }
    process.env.LOOM_CANVAS_AI_SUGGEST = 'true';
    expect(isCanvasSuggestEnabled()).toBe(true);
  });
});
