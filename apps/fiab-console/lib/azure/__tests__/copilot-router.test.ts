/**
 * copilot-router unit tests — the pure routing + attribution helpers that make
 * the single Copilot window pick the right agent and badge who answered.
 *
 * The router imports the two heavy orchestrators (which pull the full Azure
 * client fleet at module load); we stub those + @azure/identity + the AOAI
 * fetch so the test stays hermetic. The persona registry (copilot-personas) is
 * REAL so buildAgentIdentity is verified against the actual persona names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The router constructs a managed-identity credential at module load.
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class { async getToken() { return { token: 'tok' }; } },
  DefaultAzureCredential: class { async getToken() { return { token: 'tok' }; } },
  ManagedIdentityCredential: class { async getToken() { return { token: 'tok' }; } },
}));

// Heavy orchestrators — stubbed; routeCopilot only needs them to be callable
// async generators on the chosen branch. The classifier path uses resolveAoaiTarget.
const orchestrateMock = vi.fn(async function* (..._a: unknown[]) { yield { kind: 'final', content: 'build-answer' }; });
const orchestrateHelpMock = vi.fn(async function* (..._a: unknown[]) { yield { kind: 'final', content: 'docs-answer' }; });
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  orchestrate: (...a: unknown[]) => orchestrateMock(...a),
  resolveAoaiTarget: vi.fn(async () => ({ endpoint: 'https://aoai.example', deployment: 'gpt', apiVersion: '2024-10-21' })),
}));
vi.mock('@/lib/azure/help-copilot-orchestrator', () => ({
  orchestrateHelp: (...a: unknown[]) => orchestrateHelpMock(...a),
}));
vi.mock('@/lib/azure/cloud-endpoints', () => ({ cogScope: () => 'https://cognitiveservices.azure.com/.default' }));

const fetchWithTimeoutMock = vi.fn();
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => fetchWithTimeoutMock(...a),
  LLM_FETCH_TIMEOUT_MS: 30_000,
}));

import {
  decideAutoRoute,
  parseRouteDecision,
  buildAgentIdentity,
  classifyIntent,
  routeCopilot,
} from '../copilot-router';

beforeEach(() => {
  orchestrateMock.mockClear();
  orchestrateHelpMock.mockClear();
  fetchWithTimeoutMock.mockReset();
});

describe('decideAutoRoute', () => {
  it('auto-routes only the global default launcher (no persona, no editor ctx)', () => {
    expect(decideAutoRoute({})).toBe(true);
    expect(decideAutoRoute({ persona: 'cross-item', contextSlug: 'default' })).toBe(true);
  });
  it('skips classification when an editor pane / explicit persona is bound', () => {
    expect(decideAutoRoute({ contextSlug: 'warehouse' })).toBe(false);
    expect(decideAutoRoute({ persona: 'activator' })).toBe(false);
    expect(decideAutoRoute({ personaContext: { activatorId: 'x' } })).toBe(false);
  });
});

describe('parseRouteDecision', () => {
  it('parses a docs decision', () => {
    expect(parseRouteDecision('{"agent":"docs","reason":"how-to"}')).toEqual({ agent: 'docs', reason: 'how-to' });
  });
  it('parses a build decision', () => {
    expect(parseRouteDecision('{"agent":"build","reason":"run a query"}')).toEqual({ agent: 'build', reason: 'run a query' });
  });
  it('defaults to build on unknown agent or bad JSON', () => {
    expect(parseRouteDecision('{"agent":"frobnicate"}').agent).toBe('build');
    expect(parseRouteDecision('not json').agent).toBe('build');
    expect(parseRouteDecision(undefined).agent).toBe('build');
  });
});

describe('buildAgentIdentity', () => {
  it('labels the global default agent "Build & data"', () => {
    expect(buildAgentIdentity({ contextSlug: 'default' })).toEqual({ agentId: 'pane:default', agentName: 'Build & data' });
  });
  it('uses the explicit persona name when one is bound', () => {
    expect(buildAgentIdentity({ persona: 'activator' })).toEqual({ agentId: 'persona:activator', agentName: 'Activator Copilot' });
  });
  it('uses the per-pane persona title for an editor pane', () => {
    expect(buildAgentIdentity({ contextSlug: 'warehouse' })).toEqual({ agentId: 'pane:warehouse', agentName: 'Warehouse Copilot' });
  });
});

describe('classifyIntent', () => {
  it('returns the model decision from a forced tool_choice call', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'route', arguments: '{"agent":"docs","reason":"explain"}' } }] } }] }),
    });
    expect(await classifyIntent('what is a lakehouse?', null)).toEqual({ agent: 'docs', reason: 'explain' });
  });
  it('degrades to the build agent when the router call fails', async () => {
    fetchWithTimeoutMock.mockRejectedValue(new Error('network'));
    const d = await classifyIntent('do something', null);
    expect(d.agent).toBe('build');
  });
  it('degrades to build on a non-ok response', async () => {
    fetchWithTimeoutMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect((await classifyIntent('x', null)).agent).toBe('build');
  });
  it('uses the tenant admin routerDeployment when one is selected', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'route', arguments: '{"agent":"docs","reason":"explain"}' } }] } }] }),
    });
    await classifyIntent('what is a lakehouse?', { routerDeployment: 'gpt-4o-mini' });
    const url = String(fetchWithTimeoutMock.mock.calls[0][0]);
    expect(url).toContain('/openai/deployments/gpt-4o-mini/');
  });
});

describe('routeCopilot', () => {
  it('forceAgent=docs delegates to the docs orchestrator + emits one agent step', async () => {
    const steps: unknown[] = [];
    for await (const s of routeCopilot({ prompt: 'help', sessionId: 's', userOid: 'u', forceAgent: 'docs', autoRoute: false } as never)) steps.push(s);
    expect(orchestrateHelpMock).toHaveBeenCalledTimes(1);
    expect(orchestrateMock).not.toHaveBeenCalled();
    const agent = steps.find((s) => (s as { kind?: string }).kind === 'agent') as { agentName: string };
    expect(agent.agentName).toBe('Help & docs');
  });

  it('an editor pane (autoRoute false) goes straight to the build orchestrator', async () => {
    const steps: unknown[] = [];
    for await (const s of routeCopilot({ prompt: 'optimize', sessionId: 's', userOid: 'u', contextSlug: 'warehouse', autoRoute: false } as never)) steps.push(s);
    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    expect(orchestrateHelpMock).not.toHaveBeenCalled();
    const agent = steps.find((s) => (s as { kind?: string }).kind === 'agent') as { agentName: string };
    expect(agent.agentName).toBe('Warehouse Copilot');
  });

  it('the global launcher classifies, then delegates to the chosen agent', async () => {
    fetchWithTimeoutMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: 'route', arguments: '{"agent":"docs","reason":"how-to"}' } }] } }] }),
    });
    const steps: unknown[] = [];
    for await (const s of routeCopilot({ prompt: 'what is CSA Loom?', sessionId: 's', userOid: 'u' } as never)) steps.push(s);
    expect(orchestrateHelpMock).toHaveBeenCalledTimes(1);
    const agent = steps.find((s) => (s as { kind?: string }).kind === 'agent') as { agentName: string };
    expect(agent.agentName).toBe('Help & docs');
  });
});
