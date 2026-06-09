/**
 * Unit tests for the Copilot & Agents config plumbing:
 *   - resolveAoaiTarget precedence: tenant cfg > env > Foundry-hub discovery
 *   - the honest gate when an account is selected but no chat deployment is
 *   - looksLikeEmbedding model classification used by both pickers
 *
 * Mocks foundry-client.listConnections so discovery is deterministic, and the
 * azure SDK credential acquisition (not needed — we don't actually call AOAI).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// listConnections() is the discovery fallback inside resolveAoaiTarget.
const listConnections = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/foundry-client', () => ({ listConnections: () => listConnections() }));

// The orchestrator pulls in many service clients at import time; stub the ones
// with side-effectful module init that aren't relevant to resolveAoaiTarget.
vi.mock('@/lib/azure/cosmos-client', () => ({ copilotSessionsContainer: vi.fn() }));

import { looksLikeEmbedding } from '@/lib/types/copilot-config';

describe('looksLikeEmbedding', () => {
  it('classifies embedding deployments', () => {
    expect(looksLikeEmbedding('text-embedding-3-large')).toBe(true);
    expect(looksLikeEmbedding('text-embedding-ada-002')).toBe(true);
    expect(looksLikeEmbedding(undefined, 'my-embed-deploy')).toBe(true);
  });
  it('classifies chat models as non-embedding', () => {
    expect(looksLikeEmbedding('gpt-4o')).toBe(false);
    expect(looksLikeEmbedding('gpt-4.1', 'reasoner')).toBe(false);
  });
});

describe('resolveAoaiTarget precedence', () => {
  beforeEach(() => {
    vi.resetModules();
    listConnections.mockReset().mockResolvedValue([]);
    delete process.env.LOOM_AOAI_ENDPOINT;
    delete process.env.LOOM_AOAI_DEPLOYMENT;
  });

  it('uses tenant config (aoaiEndpoint + copilotChatDeployment) over env/discovery', async () => {
    process.env.LOOM_AOAI_ENDPOINT = 'https://env.openai.azure.com';
    process.env.LOOM_AOAI_DEPLOYMENT = 'env-deploy';
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');
    const t = await resolveAoaiTarget({
      aoaiEndpoint: 'https://tenant.openai.azure.com/',
      copilotChatDeployment: 'tenant-gpt-4o',
    });
    expect(t.endpoint).toBe('https://tenant.openai.azure.com');
    expect(t.deployment).toBe('tenant-gpt-4o');
    expect(listConnections).not.toHaveBeenCalled();
  });

  it('honest gate when an account/endpoint is set but no chat deployment chosen', async () => {
    const { resolveAoaiTarget, NoAoaiDeploymentError } = await import('@/lib/azure/copilot-orchestrator');
    await expect(
      resolveAoaiTarget({ aoaiEndpoint: 'https://acct.openai.azure.com' }),
    ).rejects.toBeInstanceOf(NoAoaiDeploymentError);
  });

  it('falls back to env vars when no tenant config supplied', async () => {
    process.env.LOOM_AOAI_ENDPOINT = 'https://env.openai.azure.com/';
    process.env.LOOM_AOAI_DEPLOYMENT = 'env-deploy';
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');
    const t = await resolveAoaiTarget(null);
    expect(t.endpoint).toBe('https://env.openai.azure.com');
    expect(t.deployment).toBe('env-deploy');
  });

  it('discovers via Foundry hub when neither config nor env is set', async () => {
    listConnections.mockResolvedValue([
      { category: 'AzureOpenAI', target: 'https://hub.openai.azure.com/', metadata: {} },
    ]);
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');
    const t = await resolveAoaiTarget(null);
    expect(t.endpoint).toBe('https://hub.openai.azure.com');
    expect(t.deployment).toBe('gpt-4o'); // default when connection has no explicit deployment
    expect(listConnections).toHaveBeenCalled();
  });
});

/**
 * Cross-cloud endpoint hardening: the AOAI bearer is minted with cogScope()
 * (cognitiveservices.azure.us in Gov). Pointing LOOM_AOAI_ENDPOINT at the wrong
 * sovereign host would 401 at the data plane with an opaque error — so
 * resolveAoaiTarget() now rejects an endpoint whose host suffix contradicts the
 * active LOOM_CLOUD, with a precise NoAoaiDeploymentError instead.
 */
describe('resolveAoaiTarget — cross-cloud endpoint validation', () => {
  beforeEach(() => {
    vi.resetModules();
    listConnections.mockReset().mockResolvedValue([]);
    delete process.env.LOOM_AOAI_ENDPOINT;
    delete process.env.LOOM_AOAI_DEPLOYMENT;
    delete process.env.LOOM_CLOUD;
    delete process.env.AZURE_CLOUD;
  });

  it('rejects a Commercial (.com) endpoint in a GCC-High (Gov) deployment', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    const { resolveAoaiTarget, NoAoaiDeploymentError } = await import('@/lib/azure/copilot-orchestrator');
    await expect(
      resolveAoaiTarget({
        aoaiEndpoint: 'https://acct.openai.azure.com',
        copilotChatDeployment: 'gpt-4o',
      }),
    ).rejects.toBeInstanceOf(NoAoaiDeploymentError);
  });

  it('rejects a Gov (.us) endpoint in a Commercial deployment', async () => {
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_AOAI_ENDPOINT = 'https://acct.openai.azure.us';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o';
    const { resolveAoaiTarget, NoAoaiDeploymentError } = await import('@/lib/azure/copilot-orchestrator');
    await expect(resolveAoaiTarget(null)).rejects.toBeInstanceOf(NoAoaiDeploymentError);
  });

  it('accepts a Gov (.us) endpoint in a GCC-High deployment', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_AOAI_ENDPOINT = 'https://acct.openai.azure.us';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o';
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');
    const t = await resolveAoaiTarget(null);
    expect(t.endpoint).toBe('https://acct.openai.azure.us');
    expect(t.deployment).toBe('gpt-4o');
  });

  it('accepts a Commercial (.com) endpoint in a Commercial deployment', async () => {
    process.env.LOOM_CLOUD = 'Commercial';
    process.env.LOOM_AOAI_ENDPOINT = 'https://acct.openai.azure.com';
    process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o';
    const { resolveAoaiTarget } = await import('@/lib/azure/copilot-orchestrator');
    const t = await resolveAoaiTarget(null);
    expect(t.endpoint).toBe('https://acct.openai.azure.com');
  });
});
