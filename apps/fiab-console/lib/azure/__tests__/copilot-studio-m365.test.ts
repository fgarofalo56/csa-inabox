/**
 * Unit tests for the "publish data agent to Microsoft 365 Copilot" helpers in
 * copilot-studio-client.ts.
 *
 * Pins the real Dataverse / Copilot Studio REST contract the BFF route depends on:
 *   - resolve env Dataverse host        GET  BAP .../environments
 *   - find/create Copilot Studio agent  GET/POST .../msdyn_copilots
 *   - add M365+Teams channel            POST .../msdyn_botchannels (type 'teams')
 *   - publish the agent                 POST .../msdyn_copilots(<id>)/Microsoft.Dynamics.CRM.msdyn_PublishCopilot
 *
 * Mocks @azure/identity + global fetch the same way apim-operations.test.ts does.
 * The Dataverse credential is read at module-load, so env vars are set BEFORE
 * the dynamic import.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
    ClientSecretCredential: Cred,
  };
});

const ENV_ID = 'env-guid-1';
const DV_HOST = 'org1234.crm.dynamics.com';

function jsonRes(body: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) } as any;
}

beforeEach(() => {
  process.env.LOOM_DATAVERSE_CLIENT_ID = 'app-1';
  process.env.LOOM_DATAVERSE_CLIENT_SECRET = 'secret-1';
  process.env.LOOM_DATAVERSE_TENANT_ID = 'tenant-1';
  delete process.env.LOOM_COPILOT_STUDIO_ENV;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('copilotStudioConfigGate', () => {
  it('reports configured when Dataverse creds present', async () => {
    const m = await import('../copilot-studio-client');
    expect(m.copilotStudioConfigGate().configured).toBe(true);
  });

  it('reports an honest gate (not configured) when Dataverse creds are missing', async () => {
    delete process.env.LOOM_DATAVERSE_CLIENT_ID;
    delete process.env.LOOM_DATAVERSE_CLIENT_SECRET;
    vi.resetModules();
    const m = await import('../copilot-studio-client');
    const gate = m.copilotStudioConfigGate();
    expect(gate.configured).toBe(false);
    expect(gate.missing).toMatch(/LOOM_DATAVERSE_CLIENT_ID/);
    expect(gate.message).toMatch(/Dataverse/i);
  });
});

describe('publishDataAgentToM365', () => {
  it('creates an agent, adds the M365/Teams channel, then publishes it (real Dataverse REST shape)', async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const method = (init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });

      // BAP environment list → provides the Dataverse host.
      if (url.includes('/Microsoft.BusinessAppPlatform/scopes/admin/environments')) {
        return jsonRes({ value: [{ name: ENV_ID, properties: { displayName: 'Dev', linkedEnvironmentMetadata: { instanceUrl: `https://${DV_HOST}/` } } }] });
      }
      // find agent by name → none exists yet.
      if (url.includes('/msdyn_copilots') && method === 'GET' && url.includes('$filter')) {
        return jsonRes({ value: [] });
      }
      // create agent
      if (url.includes('/msdyn_copilots') && method === 'POST') {
        return jsonRes({ msdyn_copilotid: 'agent-1', msdyn_name: 'My agent', msdyn_schemaname: 'cr1_myagent', statecode: 0 });
      }
      // list channels → none yet
      if (url.includes('/msdyn_botchannels') && method === 'GET') {
        return jsonRes({ value: [] });
      }
      // create channel
      if (url.includes('/msdyn_botchannels') && method === 'POST') {
        return jsonRes({ msdyn_botchannelid: 'chan-1', msdyn_type: 'teams', msdyn_enabled: true });
      }
      // publish bound action
      if (url.includes('msdyn_PublishCopilot')) {
        return jsonRes({}, 204);
      }
      return jsonRes({}, 200);
    }));

    const m = await import('../copilot-studio-client');
    const res = await m.publishDataAgentToM365({
      envId: ENV_ID,
      displayName: 'My agent',
      description: 'desc',
      instructions: 'route finance to the warehouse',
      starterPrompts: ['Top products?'],
    });

    expect(res.ok).toBe(true);
    expect(res.agentId).toBe('agent-1');
    expect(res.created).toBe(true);
    expect(res.channelId).toBe('chan-1');
    expect(res.adminReviewRequired).toBe(true);

    // The channel POST carries the M365 availability + Teams flag.
    const channelPost = calls.find((c) => c.url.includes('/msdyn_botchannels') && c.method === 'POST');
    expect(channelPost).toBeDefined();
    expect(channelPost!.body.msdyn_type).toBe('teams');
    const cfg = JSON.parse(channelPost!.body.msdyn_configuration);
    expect(cfg.microsoft365.enabled).toBe(true);
    expect(cfg.teams.enabled).toBe(true);

    // The publish bound action was invoked on the created agent.
    expect(calls.some((c) => c.url.includes('agent-1') && c.url.includes('msdyn_PublishCopilot'))).toBe(true);
  });

  it('reuses an existing agent on republish instead of creating a duplicate', async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.includes('/scopes/admin/environments')) {
        return jsonRes({ value: [{ name: ENV_ID, properties: { displayName: 'Dev', linkedEnvironmentMetadata: { instanceUrl: `https://${DV_HOST}/` } } }] });
      }
      // getAgent by id
      if (url.includes('/msdyn_copilots(agent-9)')) {
        return jsonRes({ msdyn_copilotid: 'agent-9', msdyn_name: 'Existing', statecode: 1 });
      }
      // existing teams channel
      if (url.includes('/msdyn_botchannels') && method === 'GET') {
        return jsonRes({ value: [{ msdyn_botchannelid: 'chan-9', msdyn_type: 'teams', msdyn_enabled: true }] });
      }
      if (url.includes('msdyn_PublishCopilot')) return jsonRes({}, 204);
      if (url.includes('/msdyn_copilots') && method === 'PATCH') {
        return jsonRes({ msdyn_copilotid: 'agent-9', msdyn_name: 'Existing', statecode: 1 });
      }
      return jsonRes({}, 200);
    }));

    const m = await import('../copilot-studio-client');
    const res = await m.publishDataAgentToM365({
      envId: ENV_ID,
      displayName: 'Existing',
      instructions: 'x',
      existingAgentId: 'agent-9',
    });

    expect(res.agentId).toBe('agent-9');
    expect(res.created).toBe(false);
    expect(res.channelId).toBe('chan-9');
    // No POST to /msdyn_copilots (no new agent created).
    expect(calls.some((c) => c.url.endsWith('/msdyn_copilots') && c.method === 'POST')).toBe(false);
    // No new channel POST (reused existing).
    expect(calls.some((c) => c.url.endsWith('/msdyn_botchannels') && c.method === 'POST')).toBe(false);
  });
});
