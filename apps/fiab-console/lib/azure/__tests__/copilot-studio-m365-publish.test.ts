/**
 * publishToM365Copilot — unit coverage for the data-agent → Microsoft 365
 * Copilot publish orchestration in copilot-studio-client.
 *
 * @azure/identity is mocked so no real AAD token is requested; global.fetch is
 * stubbed to record the Dataverse Web API calls the orchestration makes and to
 * assert the M365 Copilot channel is enabled idempotently. Per
 * .claude/rules/no-vaporware.md this brings the new publish path to A-grade
 * (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return {
    ChainedTokenCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ManagedIdentityCredential: FakeCred,
    ClientSecretCredential: FakeCred,
  };
});

const ENV_ID = 'env-guid-123';
const DV_HOST = 'orgtest.crm.dynamics.com';

interface Recorded { url: string; method: string; body?: any }

function makeFetch(recorded: Recorded[], opts: { existingAgent?: boolean; existingChannel?: boolean } = {}) {
  return vi.fn(async (url: string, init?: any) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    recorded.push({ url, method, body });
    const json = (obj: any, status = 200) => ({
      ok: status < 400, status, text: async () => JSON.stringify(obj),
    }) as any;

    // BAP environments listing
    if (url.includes('/scopes/admin/environments')) {
      return json({ value: [{ name: ENV_ID, location: 'unitedstates', properties: { displayName: 'Test env', linkedEnvironmentMetadata: { instanceUrl: `https://${DV_HOST}/` } } }] });
    }
    // find agent by name
    if (method === 'GET' && url.includes('/msdyn_copilots') && url.includes('filter=msdyn_name')) {
      return json({ value: opts.existingAgent ? [{ msdyn_copilotid: 'agent-1', msdyn_name: 'My Agent', statecode: 0 }] : [] });
    }
    // create agent
    if (method === 'POST' && url.endsWith('/msdyn_copilots')) {
      return json({ msdyn_copilotid: 'agent-1', msdyn_name: body?.msdyn_name, statecode: 0 });
    }
    // update agent
    if (method === 'PATCH' && url.includes('/msdyn_copilots(')) {
      return json({ msdyn_copilotid: 'agent-1', msdyn_name: body?.msdyn_name || 'My Agent', statecode: 0 });
    }
    // list knowledge
    if (method === 'GET' && url.includes('/msdyn_knowledgesources')) {
      return json({ value: [] });
    }
    // publish action
    if (method === 'POST' && url.includes('msdyn_PublishCopilot')) {
      return json({});
    }
    // list channels
    if (method === 'GET' && url.includes('/msdyn_botchannels')) {
      return json({ value: opts.existingChannel ? [{ msdyn_botchannelid: 'ch-1', msdyn_name: 'msteams-channel', msdyn_type: 'msteams', msdyn_enabled: false }] : [] });
    }
    // create / patch channel
    if (url.includes('/msdyn_botchannels')) {
      return json({ msdyn_botchannelid: 'ch-1', msdyn_name: 'msteams-channel', msdyn_type: 'msteams', msdyn_enabled: true, msdyn_configuration: body?.msdyn_configuration });
    }
    return json({}, 404);
  });
}

describe('publishToM365Copilot', () => {
  let recorded: Recorded[];
  const realFetch = global.fetch;

  beforeEach(() => { recorded = []; });
  afterEach(() => { vi.restoreAllMocks(); global.fetch = realFetch; vi.resetModules(); });

  it('resolvePublishEnvId prefers explicit id then env var', async () => {
    const mod = await import('../copilot-studio-client');
    expect(mod.resolvePublishEnvId('abc')).toBe('abc');
    const prev = process.env.LOOM_COPILOT_STUDIO_ENVIRONMENT_ID;
    process.env.LOOM_COPILOT_STUDIO_ENVIRONMENT_ID = 'from-env';
    expect(mod.resolvePublishEnvId()).toBe('from-env');
    process.env.LOOM_COPILOT_STUDIO_ENVIRONMENT_ID = '';
    expect(mod.resolvePublishEnvId()).toBeNull();
    if (prev !== undefined) process.env.LOOM_COPILOT_STUDIO_ENVIRONMENT_ID = prev;
  });

  it('creates the agent, publishes it, and enables the Teams + M365 Copilot channel', async () => {
    global.fetch = makeFetch(recorded) as any;
    const mod = await import('../copilot-studio-client');
    const res = await mod.publishToM365Copilot(ENV_ID, {
      name: 'My Agent', description: 'desc', instructions: 'inst', availableInM365Copilot: true,
    });
    expect(res.agentId).toBe('agent-1');
    expect(res.channelId).toBe('ch-1');
    expect(res.m365CopilotEnabled).toBe(true);

    // agent was created (no existing), published, and the channel created with M365 flag.
    expect(recorded.some((r) => r.method === 'POST' && r.url.endsWith('/msdyn_copilots'))).toBe(true);
    expect(recorded.some((r) => r.url.includes('msdyn_PublishCopilot'))).toBe(true);
    const channelPost = recorded.find((r) => r.method === 'POST' && r.url.includes('/msdyn_botchannels'));
    expect(channelPost).toBeTruthy();
    const cfg = JSON.parse(channelPost!.body.msdyn_configuration);
    expect(cfg.makeAvailableInMicrosoft365Copilot).toBe(true);
    expect(channelPost!.body.msdyn_type).toBe('msteams');
  });

  it('is idempotent — updates the existing agent + patches the existing channel', async () => {
    global.fetch = makeFetch(recorded, { existingAgent: true, existingChannel: true }) as any;
    const mod = await import('../copilot-studio-client');
    await mod.publishToM365Copilot(ENV_ID, { name: 'My Agent', instructions: 'inst', availableInM365Copilot: false });

    // existing agent → PATCH not POST; existing channel → PATCH not POST.
    expect(recorded.some((r) => r.method === 'POST' && r.url.endsWith('/msdyn_copilots'))).toBe(false);
    expect(recorded.some((r) => r.method === 'PATCH' && r.url.includes('/msdyn_copilots('))).toBe(true);
    const channelPatch = recorded.find((r) => r.method === 'PATCH' && r.url.includes('/msdyn_botchannels('));
    expect(channelPatch).toBeTruthy();
    const cfg = JSON.parse(channelPatch!.body.msdyn_configuration);
    expect(cfg.makeAvailableInMicrosoft365Copilot).toBe(false);
  });
});
