import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOL_KINDS, agentToolKind, newAgentTool, migrateLegacyTools,
  isAgentToolConfigured, describeAgentTool, toFoundryTool, toolsToFoundryTools,
  toolCanvasCategory, mcpToolOptions,
  type AgentTool,
} from '../agent-tool-catalog';

describe('agent-tool-catalog registry', () => {
  it('every kind has metadata with a category + icon', () => {
    for (const k of AGENT_TOOL_KINDS) {
      expect(k.label).toBeTruthy();
      expect(k.short).toBeTruthy();
      expect(k.icon).toBeTruthy();
      expect(['move', 'transform', 'control', 'external', 'iteration']).toContain(k.category);
      expect(agentToolKind(k.kind)).toBe(k);
    }
  });

  it('newAgentTool seeds defaults per kind', () => {
    const oa = newAgentTool('openapi');
    expect(oa.kind).toBe('openapi');
    expect(oa.authKind).toBe('anonymous');
    expect(oa.id).toMatch(/^openapi-/);
    const mcp = newAgentTool('mcp');
    expect(mcp.allowedTools).toEqual([]);
  });

  it('toolCanvasCategory maps item tools to move, mcp to external', () => {
    expect(toolCanvasCategory('warehouse')).toBe('move');
    expect(toolCanvasCategory('mcp')).toBe('external');
    expect(toolCanvasCategory('code-interpreter')).toBe('transform');
  });
});

describe('migrateLegacyTools', () => {
  it('converts a legacy comma-separated string to function tools', () => {
    const out = migrateLegacyTools('eventhouse-query, activator-trigger');
    expect(out).toHaveLength(2);
    expect(out.every((t) => t.kind === 'function')).toBe(true);
    expect(out[0].functionName).toBe('eventhouse-query');
    expect(out[1].functionName).toBe('activator-trigger');
    // ids are stable non-empty
    expect(out[0].id).toBeTruthy();
  });

  it('converts a string[] to function tools', () => {
    const out = migrateLegacyTools(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[1].functionName).toBe('b');
  });

  it('passes through a structured AgentTool[] and drops unknown kinds', () => {
    const arr: AgentTool[] = [
      { id: 'x1', kind: 'warehouse', itemId: 'w1', itemName: 'WH' },
      { id: 'x2', kind: 'bogus' as any },
    ];
    const out = migrateLegacyTools(arr);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('warehouse');
  });

  it('returns [] for empty / nullish input', () => {
    expect(migrateLegacyTools('')).toEqual([]);
    expect(migrateLegacyTools(undefined)).toEqual([]);
    expect(migrateLegacyTools(null)).toEqual([]);
  });
});

describe('isAgentToolConfigured + describeAgentTool', () => {
  it('item tools need an itemId', () => {
    expect(isAgentToolConfigured({ id: '1', kind: 'kql' })).toBe(false);
    expect(isAgentToolConfigured({ id: '1', kind: 'kql', itemId: 'k1', itemName: 'Logs' })).toBe(true);
    expect(describeAgentTool({ id: '1', kind: 'kql', itemId: 'k1', itemName: 'Logs' })).toBe('Logs');
  });
  it('code-interpreter + bing are always configured', () => {
    expect(isAgentToolConfigured({ id: '1', kind: 'code-interpreter' })).toBe(true);
    expect(isAgentToolConfigured({ id: '1', kind: 'bing-grounding' })).toBe(true);
  });
  it('mcp needs a serverId, openapi needs a specUrl', () => {
    expect(isAgentToolConfigured({ id: '1', kind: 'mcp' })).toBe(false);
    expect(isAgentToolConfigured({ id: '1', kind: 'mcp', serverId: 'ms-learn' })).toBe(true);
    expect(isAgentToolConfigured({ id: '1', kind: 'openapi', specUrl: 'https://x/o.json' })).toBe(true);
  });
});

describe('toFoundryTool wire mapping', () => {
  it('drops unconfigured tools', () => {
    expect(toFoundryTool({ id: '1', kind: 'warehouse' })).toBeNull();
  });
  it('maps code-interpreter', () => {
    expect(toFoundryTool({ id: '1', kind: 'code-interpreter' })).toEqual({ type: 'code_interpreter' });
  });
  it('maps a warehouse to a bound function tool', () => {
    const t = toFoundryTool({ id: '1', kind: 'warehouse', itemId: 'w1', itemName: 'FY' });
    expect(t?.type).toBe('function');
    expect((t as any).function.name).toBe('loom_warehouse_query');
    expect((t as any).loom_binding).toEqual({ kind: 'warehouse', itemId: 'w1', itemName: 'FY' });
  });
  it('maps search-index to file_search', () => {
    const t = toFoundryTool({ id: '1', kind: 'search-index', itemId: 's1', itemName: 'idx' });
    expect(t?.type).toBe('file_search');
    expect((t as any).file_search.loom_index_item).toBe('s1');
  });
  it('maps mcp with allowed_tools', () => {
    const t = toFoundryTool({ id: '1', kind: 'mcp', serverId: 'ms-learn', serverLabel: 'Learn', serverUrl: 'https://x/mcp', allowedTools: ['a'] });
    expect(t).toMatchObject({ type: 'mcp', server_label: 'Learn', server_url: 'https://x/mcp', allowed_tools: ['a'] });
  });
  it('maps openapi with auth secret_ref', () => {
    const t = toFoundryTool({ id: '1', kind: 'openapi', specUrl: 'https://x/o.json', authKind: 'bearer', authRef: 'sec' });
    expect((t as any).openapi.spec_url).toBe('https://x/o.json');
    expect((t as any).openapi.auth).toEqual({ type: 'bearer', secret_ref: 'sec' });
  });
  it('toolsToFoundryTools skips unconfigured entries', () => {
    const out = toolsToFoundryTools([
      { id: '1', kind: 'code-interpreter' },
      { id: '2', kind: 'warehouse' }, // unconfigured → dropped
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('mcpToolOptions', () => {
  it('exposes the built-in MCP servers with id + label', () => {
    const opts = mcpToolOptions();
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.id && o.label)).toBe(true);
    expect(opts.some((o) => o.id === 'ms-learn')).toBe(true);
  });
});
