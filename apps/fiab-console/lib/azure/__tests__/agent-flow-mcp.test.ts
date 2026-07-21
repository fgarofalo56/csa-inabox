import { describe, it, expect, vi } from 'vitest';
import {
  pickMcpTool, buildMcpArgs, mcpResultToText, executeFlowMcpTools,
  type McpFlowDeps,
} from '../agent-flow-mcp';
import type { AgentTool } from '@/lib/copilot/agent-tool-catalog';

describe('agent-flow-mcp — pure helpers', () => {
  it('pickMcpTool prefers an allow-listed tool, else the first', () => {
    const avail = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(pickMcpTool(['b'], avail)?.name).toBe('b');
    expect(pickMcpTool([], avail)?.name).toBe('a');
    expect(pickMcpTool(['zzz'], avail)).toBeUndefined();
    expect(pickMcpTool(undefined, [])).toBeUndefined();
  });

  it('buildMcpArgs maps the question to a well-known string field', () => {
    expect(buildMcpArgs('hi', { properties: { query: { type: 'string' } } })).toEqual({ query: 'hi' });
    expect(buildMcpArgs('hi', { properties: { foo: { type: 'string' } } })).toEqual({ foo: 'hi' });
    expect(buildMcpArgs('hi', { properties: { n: { type: 'number' } } })).toEqual({});
    expect(buildMcpArgs('hi', undefined)).toEqual({});
  });

  it('mcpResultToText extracts text content', () => {
    expect(mcpResultToText({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] })).toBe('hello\nworld');
    expect(mcpResultToText('raw')).toBe('raw');
    expect(mcpResultToText({ foo: 1 })).toContain('foo');
  });
});

describe('agent-flow-mcp — executeFlowMcpTools (real dispatch, stubbed I/O)', () => {
  const mcpTool = (over: Partial<AgentTool> = {}): AgentTool => ({ id: 't', kind: 'mcp', serverId: 'srv', serverLabel: 'Srv', ...over });

  it('resolves → lists → calls the selected tool and grounds on the result', async () => {
    const deps: McpFlowDeps = {
      resolveServer: vi.fn(async () => ({ ok: true, endpoint: 'https://x/mcp', authMethod: 'header', label: 'Srv' } as const)),
      listTools: vi.fn(async () => [{ name: 'search', inputSchema: { properties: { query: { type: 'string' } } } }]),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'real result' }] })),
    };
    const res = await executeFlowMcpTools([mcpTool({ allowedTools: ['search'] })], 'find X', deps);
    expect(deps.callTool).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://x/mcp' }), 'search', { query: 'find X' });
    expect(res.anyExecuted).toBe(true);
    expect(res.traces[0]).toMatchObject({ executed: true, action: 'search' });
    expect(res.groundingBlocks[0]).toContain('real result');
  });

  it('honest-gates an unresolved server (no call)', async () => {
    const deps: McpFlowDeps = {
      resolveServer: vi.fn(async () => ({ ok: false, gate: 'not registered' } as const)),
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    const res = await executeFlowMcpTools([mcpTool()], 'q', deps);
    expect(res.anyExecuted).toBe(false);
    expect(res.traces[0]).toMatchObject({ executed: false, gate: 'not registered' });
    expect(deps.listTools).not.toHaveBeenCalled();
  });

  it('honest-gates a call failure without throwing', async () => {
    const deps: McpFlowDeps = {
      resolveServer: vi.fn(async () => ({ ok: true, endpoint: 'https://x/mcp', authMethod: 'header', label: 'Srv' } as const)),
      listTools: vi.fn(async () => [{ name: 'search' }]),
      callTool: vi.fn(async () => { throw new Error('boom'); }),
    };
    const res = await executeFlowMcpTools([mcpTool()], 'q', deps);
    expect(res.traces[0]).toMatchObject({ executed: false });
    expect(res.traces[0].gate).toContain('boom');
  });
});
