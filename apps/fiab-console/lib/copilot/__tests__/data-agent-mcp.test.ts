import { describe, it, expect, vi } from 'vitest';
import {
  agentMcpToolName,
  buildAskTool,
  coerceHistory,
  handleAgentMcpMethod,
  MCP_PROTOCOL_VERSION,
  RPC,
  type AgentMcpContext,
} from '../data-agent-mcp';

describe('agentMcpToolName', () => {
  it('slugifies a display name into ask_<slug>', () => {
    expect(agentMcpToolName('Sales Insights')).toBe('ask_sales_insights');
    expect(agentMcpToolName('Q3  Revenue!!')).toBe('ask_q3_revenue');
  });
  it('falls back to ask_agent when nothing usable remains', () => {
    expect(agentMcpToolName('')).toBe('ask_agent');
    expect(agentMcpToolName('***')).toBe('ask_agent');
  });
  it('is a valid MCP tool identifier (lowercase, [a-z0-9_])', () => {
    expect(agentMcpToolName('Über Café #1')).toMatch(/^ask_[a-z0-9_]*$/);
  });
});

describe('buildAskTool', () => {
  it('builds a tool descriptor with a required question input', () => {
    const t = buildAskTool('ask_sales', 'Sales');
    expect(t.name).toBe('ask_sales');
    expect((t.inputSchema as any).required).toEqual(['question']);
    expect((t.inputSchema as any).properties.question.type).toBe('string');
  });
  it('uses a provided description', () => {
    expect(buildAskTool('ask_x', 'X', 'custom').description).toBe('custom');
  });
});

describe('coerceHistory', () => {
  it('keeps only well-formed user/assistant turns, capped at 10', () => {
    const raw = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'system', content: 'nope' },
      { role: 'user', content: 42 },
      'bad',
    ];
    expect(coerceHistory(raw)).toEqual([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    expect(coerceHistory('x')).toEqual([]);
  });
});

describe('handleAgentMcpMethod', () => {
  const ctx = (ask: AgentMcpContext['ask']): AgentMcpContext => ({ toolName: 'ask_sales', agentName: 'Sales', ask });

  it('handles initialize with the protocol version + serverInfo', async () => {
    const r = await handleAgentMcpMethod({ id: 1, method: 'initialize' }, ctx(async () => ''));
    expect((r as any).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect((r as any).result.serverInfo.name).toBe('csa-loom-data-agent');
  });

  it('returns null for notifications/initialized', async () => {
    expect(await handleAgentMcpMethod({ method: 'notifications/initialized' }, ctx(async () => ''))).toBeNull();
  });

  it('lists exactly the one ask tool', async () => {
    const r = await handleAgentMcpMethod({ id: 2, method: 'tools/list' }, ctx(async () => ''));
    const tools = (r as any).result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('ask_sales');
  });

  it('calls the injected backend on tools/call and returns text content', async () => {
    const ask = vi.fn(async (q: string) => `answer to: ${q}`);
    const r = await handleAgentMcpMethod(
      { id: 3, method: 'tools/call', params: { name: 'ask_sales', arguments: { question: 'revenue?' } } },
      ctx(ask),
    );
    expect(ask).toHaveBeenCalledWith('revenue?', []);
    expect((r as any).result.content[0].text).toBe('answer to: revenue?');
    expect((r as any).result.isError).toBeUndefined();
  });

  it('rejects an unknown tool name with METHOD_NOT_FOUND', async () => {
    const r = await handleAgentMcpMethod(
      { id: 4, method: 'tools/call', params: { name: 'ask_other', arguments: { question: 'x' } } },
      ctx(async () => 'nope'),
    );
    expect((r as any).error.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it('requires a question argument', async () => {
    const r = await handleAgentMcpMethod(
      { id: 5, method: 'tools/call', params: { name: 'ask_sales', arguments: {} } },
      ctx(async () => 'x'),
    );
    expect((r as any).error.code).toBe(RPC.INVALID_PARAMS);
  });

  it('returns isError content when the backend throws (MCP convention)', async () => {
    const r = await handleAgentMcpMethod(
      { id: 6, method: 'tools/call', params: { name: 'ask_sales', arguments: { question: 'x' } } },
      ctx(async () => { throw new Error('no AOAI deployment'); }),
    );
    expect((r as any).result.isError).toBe(true);
    expect((r as any).result.content[0].text).toMatch(/no AOAI/);
  });

  it('unknown method → METHOD_NOT_FOUND', async () => {
    const r = await handleAgentMcpMethod({ id: 7, method: 'bogus' }, ctx(async () => ''));
    expect((r as any).error.code).toBe(RPC.METHOD_NOT_FOUND);
  });
});
