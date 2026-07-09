/**
 * BFF route tests for the Loom App Runtime (DBX-1). Exercises the authorization
 * + kill-switch + env-allowlist gates on the build / deploy / lifecycle routes
 * with the Azure client + item-access + kill-switch fully mocked (no Azure I/O).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const session = { claims: { oid: 'oid-1', upn: 'u@t.com', email: 'u@t.com' }, exp: Date.now() / 1000 + 3600 };
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(() => session) }));

const item = { id: 'app-1', workspaceId: 'ws-1', itemType: 'loom-app-runtime', displayName: 'A', createdBy: 'oid-1', createdAt: '', updatedAt: '', state: {} };
const access = { item, role: 'Owner', via: 'owner', canWrite: true };
const mockAccess = vi.fn(async () => access);
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: (...a: any[]) => mockAccess(...a) }));

const runtimeState = vi.fn(async () => ({ enabled: true }));
vi.mock('@/lib/apps/runtime-flag', () => ({
  resolveAppsRuntimeState: (...a: any[]) => runtimeState(...a),
  appsRuntimeDisabledReason: () => 'disabled',
}));

vi.mock('@/lib/apps/runtime-store', () => ({
  LOOM_APP_RUNTIME_TYPE: 'loom-app-runtime',
  readAppRuntime: (it: any) => it.state?.appRuntime ?? {},
  saveAppRuntime: vi.fn(async (it: any, patch: any) => ({ ...it, state: { appRuntime: { ...(it.state?.appRuntime || {}), ...patch } } })),
  recordBuild: vi.fn(async (it: any) => it),
}));

const buildApp = vi.fn(async () => ({ runId: 'r1', image: 'acr/loom-app-app-1:b1', imageName: 'loom-app-app-1:b1', status: 'Queued', source: 'template' }));
const deployApp = vi.fn(async () => ({ name: 'app-abc', url: 'https://app-abc.region.azurecontainerapps.io', authConfigured: true, provisioningState: 'Succeeded' }));
vi.mock('@/lib/azure/loom-apps-client', () => ({
  buildApp: (...a: any[]) => buildApp(...a),
  getBuildStatus: vi.fn(),
  deployApp: (...a: any[]) => deployApp(...a),
  startApp: vi.fn(), stopApp: vi.fn(),
  LoomAppsNotConfiguredError: class extends Error {},
  LoomAppsError: class extends Error { status = 400; },
}));
vi.mock('@/lib/azure/loom-apps-runtime-templates', async (orig) => {
  const actual = await (orig as any)();
  return actual; // use the REAL isAllowedAppEnvName + getLoomAppTemplate
});

function req(body: unknown) {
  return new NextRequest('http://x/api/items/loom-app-runtime/app-1/build', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => { access.canWrite = true; runtimeState.mockResolvedValue({ enabled: true } as any); vi.clearAllMocks(); });

describe('build route', () => {
  it('blocks the build when the runtime kill switch is off', async () => {
    runtimeState.mockResolvedValue({ enabled: false, disabledBy: 'tenant' } as any);
    const { POST } = await import('../[id]/build/route');
    const res = await POST(req({ templateId: 'flask' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(res.status).toBe(403);
    const j = await res.json(); expect(j.code).toBe('runtime_disabled');
    expect(buildApp).not.toHaveBeenCalled();
  });
  it('403s a read-only caller', async () => {
    access.canWrite = false;
    const { POST } = await import('../[id]/build/route');
    const res = await POST(req({ templateId: 'flask' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(res.status).toBe(403);
  });
  it('builds on the happy path', async () => {
    const { POST } = await import('../[id]/build/route');
    const res = await POST(req({ templateId: 'flask' }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(res.status).toBe(200);
    const j = await res.json(); expect(j.ok).toBe(true); expect(j.build.runId).toBe('r1');
    expect(buildApp).toHaveBeenCalled();
  });
});

describe('deploy route', () => {
  function dreq(body: unknown) {
    return new NextRequest('http://x/api/items/loom-app-runtime/app-1/deploy', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    });
  }
  it('rejects a non-allowlisted env name (no-freeform-config)', async () => {
    const { POST } = await import('../[id]/deploy/route');
    const res = await POST(dreq({ image: 'acr/x:1', env: [{ name: 'DATABASE_URL', value: 'x' }] }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(res.status).toBe(400);
    expect(deployApp).not.toHaveBeenCalled();
  });
  it('requires an image', async () => {
    const { POST } = await import('../[id]/deploy/route');
    const res = await POST(dreq({}), { params: Promise.resolve({ id: 'app-1' }) });
    expect(res.status).toBe(400);
  });
  it('deploys with allowlisted env + returns the live URL', async () => {
    const { POST } = await import('../[id]/deploy/route');
    const res = await POST(dreq({ image: 'acr/x:1', env: [{ name: 'LOOM_ADX', value: 'c' }] }), { params: Promise.resolve({ id: 'app-1' }) });
    expect(res.status).toBe(200);
    const j = await res.json(); expect(j.deployed.url).toContain('azurecontainerapps.io');
    expect(deployApp).toHaveBeenCalled();
  });
});
