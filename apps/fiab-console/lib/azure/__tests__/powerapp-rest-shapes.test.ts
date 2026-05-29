/**
 * Contract tests for the Power Apps client surface the bound editor calls.
 * Each test stubs `fetch` and asserts the exact URL/method so a wire-format
 * regression is caught.
 *
 * Grounded in Microsoft Learn:
 *   - List apps:  GET  .../Microsoft.PowerApps/scopes/admin/environments/{env}/apps?api-version=2016-11-01
 *   - Get app:    GET  .../apps/{appId}?api-version=2016-11-01  (appId = real Power Apps app id)
 *   - Publish:    POST .../environments/{env}/apps/{appId}/publishAppRevision?api-version=2016-11-01
 *   - Embed:      https://apps.powerapps.com/play/{appId}?source=iframe
 *                 (power-apps/maker/canvas-apps/embed-apps-dev)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred, ClientSecretCredential: Cred,
  };
});

beforeEach(() => {
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
  delete process.env.LOOM_POWERAPPS_PLAYER_BASE;
  delete process.env.LOOM_POWERAPPS_BASE;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; contentType?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('listPowerApps', () => {
  it('hits the admin environments/{env}/apps endpoint with api-version', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ name: 'app-1', properties: { displayName: 'A', appType: 'CanvasApp' } }] } }));
    const { listPowerApps } = await import('../powerplatform-client');
    const out = await listPowerApps('Env-X');
    expect(calls[0].url).toMatch(/Microsoft\.PowerApps\/scopes\/admin\/environments\/Env-X\/apps\?api-version=2016-11-01/);
    expect(out[0].name).toBe('app-1');
    expect(out[0].displayName).toBe('A');
  });
});

describe('getPowerApp', () => {
  it('GETs the named app (the REAL app id, not a Loom GUID) and maps detail', async () => {
    const calls = captureFetch(() => ({
      body: {
        name: 'app-2222',
        properties: {
          displayName: 'Orders', appType: 'CanvasApp', appVersion: 'v3',
          appOpenUri: 'https://apps.powerapps.com/play/app-2222',
          owner: { displayName: 'Frank' },
          connectionReferences: { shared_sharepointonline: { displayName: 'SharePoint', dataSources: ['Tasks'] } },
          sharedUsersCount: 4, sharedGroupsCount: 1,
        },
      },
    }));
    const { getPowerApp } = await import('../powerplatform-client');
    const app = await getPowerApp('Env-X', 'app-2222');
    expect(calls[0].url).toMatch(/\/apps\/app-2222\?api-version=2016-11-01/);
    expect(app.displayName).toBe('Orders');
    expect(app.appVersion).toBe('v3');
    expect(app.connectionReferences?.[0].id).toBe('shared_sharepointonline');
    expect(app.connectionReferences?.[0].dataSources).toEqual(['Tasks']);
    // Canvas → web-player embed URL is derived.
    expect(app.playerEmbedUri).toBe('https://apps.powerapps.com/play/app-2222?source=iframe');
  });

  it('builds a model-driven deep link from the env instance URL', async () => {
    captureFetch(() => ({ body: { name: 'md-1', properties: { displayName: 'CS', appType: 'ModelDrivenApp' } } }));
    const { getPowerApp } = await import('../powerplatform-client');
    const app = await getPowerApp('Env-X', 'md-1', { instanceUrl: 'https://org.crm.dynamics.com/' });
    expect(app.playerEmbedUri).toBe('https://org.crm.dynamics.com/main.aspx?appid=md-1');
  });
});

describe('publishPowerApp', () => {
  it('POSTs publishAppRevision on the named app', async () => {
    const calls = captureFetch(() => ({ body: {} }));
    const { publishPowerApp } = await import('../powerplatform-client');
    const res = await publishPowerApp('Env-X', 'app-2222');
    expect(calls[0].url).toMatch(/\/environments\/Env-X\/apps\/app-2222\/publishAppRevision\?api-version=2016-11-01/);
    expect(calls[0].init?.method).toBe('POST');
    expect(res.ok).toBe(true);
  });
});

describe('powerAppPlayerEmbedUri', () => {
  it('canvas → apps.powerapps.com web-player iframe URL', async () => {
    const { powerAppPlayerEmbedUri } = await import('../powerplatform-client');
    expect(powerAppPlayerEmbedUri({ name: 'app-9', appType: 'CanvasApp' }))
      .toBe('https://apps.powerapps.com/play/app-9?source=iframe');
  });

  it('honours LOOM_POWERAPPS_PLAYER_BASE for GCC/Gov', async () => {
    process.env.LOOM_POWERAPPS_PLAYER_BASE = 'https://apps.gov.powerapps.us';
    const { powerAppPlayerEmbedUri } = await import('../powerplatform-client');
    expect(powerAppPlayerEmbedUri({ name: 'app-9', appType: 'CanvasApp' }))
      .toBe('https://apps.gov.powerapps.us/play/app-9?source=iframe');
  });

  it('model-driven → main.aspx deep link when instanceUrl supplied', async () => {
    const { powerAppPlayerEmbedUri } = await import('../powerplatform-client');
    expect(powerAppPlayerEmbedUri({ name: 'md-2', appType: 'ModelDrivenApp' }, { instanceUrl: 'https://o.crm.dynamics.com' }))
      .toBe('https://o.crm.dynamics.com/main.aspx?appid=md-2');
  });
});

describe('content-type / error guard in the REST client', () => {
  it('surfaces a 404 HTML body as a PowerPlatformError, not a JSON parse crash', async () => {
    captureFetch(() => ({ status: 404, contentType: 'text/html', body: '<html>Not Found</html>' }));
    const { getPowerApp, PowerPlatformError } = await import('../powerplatform-client');
    await expect(getPowerApp('Env-X', 'missing')).rejects.toBeInstanceOf(PowerPlatformError);
  });

  it('attaches an actionable hint on 403', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const { listPowerApps } = await import('../powerplatform-client');
    await expect(listPowerApps('Env-X')).rejects.toMatchObject({ status: 403, hint: expect.stringContaining('Power Platform APIs') });
  });
});
