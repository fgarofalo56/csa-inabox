import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the orchestrator so resolveCompletionTarget can be tested in isolation
// without touching Azure / env-driven discovery.
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn().mockResolvedValue({
    endpoint: 'https://aoai.openai.azure.com',
    deployment: 'chat',
    apiVersion: '2024-10-21',
  }),
  NoAoaiDeploymentError: class NoAoaiDeploymentError extends Error {},
}));

describe('resolveCompletionTarget', () => {
  beforeEach(() => {
    delete process.env.LOOM_AOAI_COMPLETION_DEPLOYMENT;
    vi.resetModules();
  });

  it('falls back to the chat deployment when LOOM_AOAI_COMPLETION_DEPLOYMENT is unset', async () => {
    const { resolveCompletionTarget } = await import('../inline-complete');
    const t = await resolveCompletionTarget();
    expect(t.deployment).toBe('chat');
    expect(t.endpoint).toBe('https://aoai.openai.azure.com');
    expect(t.apiVersion).toBe('2024-10-21');
  });

  it('overrides only the deployment NAME when LOOM_AOAI_COMPLETION_DEPLOYMENT is set', async () => {
    process.env.LOOM_AOAI_COMPLETION_DEPLOYMENT = 'gpt-4o-mini';
    const { resolveCompletionTarget } = await import('../inline-complete');
    const t = await resolveCompletionTarget();
    expect(t.deployment).toBe('gpt-4o-mini');
    // Endpoint + apiVersion are inherited from the chat target (same account).
    expect(t.endpoint).toBe('https://aoai.openai.azure.com');
    expect(t.apiVersion).toBe('2024-10-21');
  });

  it('trims whitespace-only LOOM_AOAI_COMPLETION_DEPLOYMENT to the fallback', async () => {
    process.env.LOOM_AOAI_COMPLETION_DEPLOYMENT = '   ';
    const { resolveCompletionTarget } = await import('../inline-complete');
    const t = await resolveCompletionTarget();
    expect(t.deployment).toBe('chat');
  });
});
