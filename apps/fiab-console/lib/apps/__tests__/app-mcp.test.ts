/**
 * app-mcp — the MCP JSON-RPC dispatcher for a published Loom App (APP-W5 S5).
 * Pure apart from the injected ctx.invoke; no I/O.
 */
import { describe, it, expect } from 'vitest';
import { handleAppMcpMethod, appMcpToolName, buildInvokeTool } from '../app-mcp';

const ctx = {
  toolName: 'invoke_my_agent',
  appName: 'My Agent',
  invoke: async (input: string) => `echo:${input}`,
};

describe('appMcpToolName', () => {
  it('slugs to invoke_<name>', () => {
    expect(appMcpToolName('My Cool App!')).toBe('invoke_my_cool_app');
    expect(appMcpToolName('')).toBe('invoke_app');
  });
});

describe('handleAppMcpMethod', () => {
  it('initialize advertises protocol + serverInfo', async () => {
    const r: any = await handleAppMcpMethod({ id: 1, method: 'initialize' }, ctx);
    expect(r.result.protocolVersion).toBe('2024-11-05');
    expect(r.result.serverInfo.name).toBe('csa-loom-app');
  });
  it('tools/list returns the invoke tool with an input schema', async () => {
    const r: any = await handleAppMcpMethod({ id: 2, method: 'tools/list' }, ctx);
    expect(r.result.tools).toHaveLength(1);
    expect(r.result.tools[0].name).toBe('invoke_my_agent');
    expect(r.result.tools[0].inputSchema.required).toEqual(['input']);
  });
  it('tools/call proxies to invoke and returns text content', async () => {
    const r: any = await handleAppMcpMethod({ id: 3, method: 'tools/call', params: { name: 'invoke_my_agent', arguments: { input: 'hi' } } }, ctx);
    expect(r.result.content[0]).toEqual({ type: 'text', text: 'echo:hi' });
  });
  it('tools/call rejects an unknown tool + a missing input', async () => {
    const bad: any = await handleAppMcpMethod({ id: 4, method: 'tools/call', params: { name: 'nope', arguments: { input: 'x' } } }, ctx);
    expect(bad.error.code).toBe(-32601);
    const noInput: any = await handleAppMcpMethod({ id: 5, method: 'tools/call', params: { name: 'invoke_my_agent', arguments: {} } }, ctx);
    expect(noInput.error.code).toBe(-32602);
  });
  it('surfaces invoke failures as isError content, not a thrown', async () => {
    const failCtx = { ...ctx, invoke: async () => { throw new Error('app 401'); } };
    const r: any = await handleAppMcpMethod({ id: 6, method: 'tools/call', params: { name: 'invoke_my_agent', arguments: { input: 'x' } } }, failCtx);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('app 401');
  });
  it('notifications/initialized is a no-response notification', async () => {
    expect(await handleAppMcpMethod({ method: 'notifications/initialized' }, ctx)).toBeNull();
  });
  it('buildInvokeTool names + describes the tool', () => {
    expect(buildInvokeTool('invoke_x', 'X').description).toContain('X');
  });
});
