/**
 * Honest-error coverage for the Copilot Studio client (audit H1/H2/H3).
 *
 * @azure/identity is mocked so no real AAD token is requested; global.fetch is
 * stubbed to return the Dataverse / BAP error shapes a live tenant would
 * produce. These tests pin the no-vaporware contract:
 *   H1 — a genuine missing-entity / missing-column error SURFACES honestly
 *        (naming the entity/column) and is NOT masked as the benign
 *        "enable Copilot Studio" 503; only the true core entities map to 503.
 *   H2 — publishToChannel honest-gates channels needing Azure Bot Service /
 *        OAuth registration (501) instead of reporting a fake success.
 *   H3 — getAnalytics returns available:false instead of fabricating zeros
 *        when the analytics backend 404s / 204s / returns an empty 200.
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
const AGENT_ID = 'agent-1';

function envListing() {
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({
      value: [{ name: ENV_ID, location: 'unitedstates', properties: { displayName: 'Test env', linkedEnvironmentMetadata: { instanceUrl: `https://${DV_HOST}/` } } }],
    }),
  } as any;
}

function dvError(message: string, status: number) {
  return {
    ok: false, status,
    text: async () => JSON.stringify({ error: { code: '0x80060888', message } }),
  } as any;
}

describe('Copilot Studio honest error classification (H1)', () => {
  const realFetch = global.fetch;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); global.fetch = realFetch; });

  it('maps a missing msdyn_copilots entity to the friendly enablement 503', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      return dvError("Resource not found for the segment 'msdyn_copilots'.", 404);
    }) as any;
    const mod = await import('../copilot-studio-client');
    await expect(mod.listAgents(ENV_ID)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('Copilot Studio is not enabled'),
    });
  });

  it('SURFACES a missing msdyn_botchannels entity as an honest schema error (NOT a 503 enablement gate)', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      return dvError("Resource not found for the segment 'msdyn_botchannels'.", 404);
    }) as any;
    const mod = await import('../copilot-studio-client');
    let err: any;
    try { await mod.listChannels(ENV_ID, AGENT_ID); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).not.toBe(503);
    expect(err.message).toContain('msdyn_botchannels');
    expect(err.message).not.toContain('Copilot Studio is not enabled');
  });

  it('SURFACES a missing msdyn_bot_actions entity as an honest schema error', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      return dvError("Resource not found for the segment 'msdyn_bot_actions'.", 404);
    }) as any;
    const mod = await import('../copilot-studio-client');
    let err: any;
    try { await mod.listActions(ENV_ID, AGENT_ID); } catch (e) { err = e; }
    expect(err.status).not.toBe(503);
    expect(err.message).toContain('msdyn_bot_actions');
  });

  it('SURFACES an invented scalar column (msdyn_instructions) as an honest column error on write', async () => {
    global.fetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      if ((init?.method || 'GET') === 'POST') {
        return dvError("An undeclared property 'msdyn_instructions' which is not defined in the type was found.", 400);
      }
      return dvError('unexpected', 500);
    }) as any;
    const mod = await import('../copilot-studio-client');
    let err: any;
    try { await mod.createAgent(ENV_ID, { name: 'A', instructions: 'x' }); } catch (e) { err = e; }
    expect(err.message).toContain('msdyn_instructions');
    expect(err.message).not.toContain('Copilot Studio is not enabled');
  });
});

describe('publishToChannel honest gating (H2)', () => {
  const realFetch = global.fetch;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); global.fetch = realFetch; });

  it.each(['teams', 'direct-line', 'web', 'slack', 'facebook'])(
    'gates the %s channel with a 501 instead of a fake Dataverse-insert success',
    async (channelType) => {
      const fetchSpy = vi.fn(async (url: string) => {
        if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
        // Any Dataverse insert here would be the vaporware path — assert it's not reached.
        return { ok: true, status: 200, text: async () => JSON.stringify({ msdyn_botchannelid: 'ch-1' }) } as any;
      });
      global.fetch = fetchSpy as any;
      const mod = await import('../copilot-studio-client');
      let err: any;
      try { await mod.publishToChannel(ENV_ID, AGENT_ID, channelType); } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(err.status).toBe(501);
      // No POST to msdyn_botchannels should have happened.
      const posted = fetchSpy.mock.calls.some(([u, init]: any) =>
        String(u).includes('/msdyn_botchannels') && (init?.method || 'GET') === 'POST');
      expect(posted).toBe(false);
    },
  );
});

describe('getAnalytics does not fabricate zeros (H3)', () => {
  const realFetch = global.fetch;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); global.fetch = realFetch; });

  it('returns available:false (no zeros) when the analytics backend 404s', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      return dvError('not found', 404);
    }) as any;
    const mod = await import('../copilot-studio-client');
    const a = await mod.getAnalytics(ENV_ID, AGENT_ID, 30);
    expect(a.available).toBe(false);
    expect(a.gateReason).toBeTruthy();
    expect(a.sessions).toBeUndefined();
    expect(a.resolvedSessions).toBeUndefined();
  });

  it('returns available:false on an empty 200 (pipeline exists, no data)', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      return { ok: true, status: 200, text: async () => JSON.stringify({}) } as any;
    }) as any;
    const mod = await import('../copilot-studio-client');
    const a = await mod.getAnalytics(ENV_ID, AGENT_ID, 30);
    expect(a.available).toBe(false);
    expect(a.sessions).toBeUndefined();
  });

  it('returns available:true with measured values when the backend returns real data', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/scopes/admin/environments') && !url.includes('/copilots/')) return envListing();
      return { ok: true, status: 200, text: async () => JSON.stringify({ sessions: 42, resolvedSessions: 30, escalatedSessions: 5, satisfactionScore: 4.2 }) } as any;
    }) as any;
    const mod = await import('../copilot-studio-client');
    const a = await mod.getAnalytics(ENV_ID, AGENT_ID, 30);
    expect(a.available).toBe(true);
    expect(a.sessions).toBe(42);
    expect(a.resolutionRate).toBeCloseTo(30 / 42);
  });
});
