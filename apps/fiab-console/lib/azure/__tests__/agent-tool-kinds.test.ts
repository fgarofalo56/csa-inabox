import { describe, it, expect } from 'vitest';
import {
  AGENT_TOOL_KINDS,
  getToolKind,
  isToolKind,
  toolKindGate,
  browserToolConfigured,
  buildToolDefinition,
  BROWSER_TOOL_ENV,
} from '../agent-tool-kinds';

/** AIF-18 — the shared agent tool-KIND contract + browser-automation gate. */
describe('agent tool kinds', () => {
  it('includes the four base kinds incl. browser_automation', () => {
    expect(AGENT_TOOL_KINDS.map((k) => k.value)).toEqual([
      'code_interpreter', 'file_search', 'function', 'browser_automation',
    ]);
  });

  it('validates known kinds', () => {
    expect(isToolKind('function')).toBe(true);
    expect(isToolKind('browser_automation')).toBe(true);
    expect(isToolKind('nope')).toBe(false);
    expect(getToolKind('browser_automation')?.gateEnv).toBe(BROWSER_TOOL_ENV);
  });

  it('serializes function tool with the given name', () => {
    const def: any = buildToolDefinition('function', { functionName: 'lookup' });
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('lookup');
  });

  it('serializes browser_automation as a named function tool with a url schema', () => {
    const def: any = buildToolDefinition('browser_automation');
    expect(def.type).toBe('function');
    expect(def.function.name).toBe('browser_automation');
    expect(def.function.parameters.required).toContain('url');
  });

  it('serializes simple kinds as { type }', () => {
    expect(buildToolDefinition('code_interpreter')).toEqual({ type: 'code_interpreter' });
    expect(buildToolDefinition('file_search')).toEqual({ type: 'file_search' });
  });
});

describe('browser-automation gate', () => {
  it('gates when no runner env var is set (honest hint)', () => {
    const g = toolKindGate('browser_automation', {});
    expect(g.gated).toBe(true);
    expect(g.hint).toMatch(/browser-tool\.bicep/);
    expect(browserToolConfigured({})).toBe(false);
  });

  it('un-gates when LOOM_BROWSER_TOOL_JOB is set', () => {
    const env = { [BROWSER_TOOL_ENV]: '/subscriptions/x/providers/Microsoft.App/jobs/loom-browser-tool' } as any;
    expect(toolKindGate('browser_automation', env).gated).toBe(false);
    expect(browserToolConfigured(env)).toBe(true);
  });

  it('never gates a kind with no gateEnv', () => {
    expect(toolKindGate('function', {}).gated).toBe(false);
    expect(toolKindGate('code_interpreter', {}).gated).toBe(false);
  });
});
