import { describe, it, expect } from 'vitest';
import { deriveConnectedMcp } from '../connected-mcp';
import type { Turn } from '../types';

function turn(tools: { name: string; serverName?: string; ok: boolean }[]): Turn {
  return {
    steps: [],
    turnDetail: {
      tools: tools.map((t) => ({ ...t, durationMs: 10 })),
    },
  };
}

describe('deriveConnectedMcp', () => {
  it('excludes native (no serverName) tools', () => {
    const out = deriveConnectedMcp([turn([{ name: 'query_cosmos', ok: true }])]);
    expect(out.servers).toEqual([]);
    expect(out.totalCalls).toBe(0);
  });

  it('folds per-server + per-tool call counts across turns', () => {
    const out = deriveConnectedMcp([
      turn([
        { name: 'search_docs', serverName: 'ms-learn', ok: true },
        { name: 'query', serverName: 'azure-mcp', ok: true },
      ]),
      turn([
        { name: 'search_docs', serverName: 'ms-learn', ok: false },
        { name: 'search_docs', serverName: 'ms-learn', ok: true },
      ]),
    ]);
    expect(out.totalCalls).toBe(4);
    // ms-learn has the most calls → sorted first.
    expect(out.servers[0].name).toBe('ms-learn');
    expect(out.servers[0].calls).toBe(3);
    expect(out.servers[0].failed).toBe(1);
    expect(out.servers[0].tools).toEqual([
      { name: 'search_docs', calls: 3, ok: 2, failed: 1 },
    ]);
    expect(out.servers[1].name).toBe('azure-mcp');
    expect(out.servers[1].calls).toBe(1);
  });

  it('is safe against a tool literally named __proto__', () => {
    const out = deriveConnectedMcp([turn([{ name: '__proto__', serverName: 'evil', ok: true }])]);
    expect(out.servers[0].tools[0].name).toBe('__proto__');
    expect(({} as Record<string, unknown>).calls).toBeUndefined();
  });

  it('handles turns with no detail', () => {
    expect(deriveConnectedMcp([{ steps: [] }]).servers).toEqual([]);
  });
});
