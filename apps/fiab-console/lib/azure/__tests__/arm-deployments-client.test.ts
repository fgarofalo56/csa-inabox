/**
 * Backend contract tests for the ARM deployments client (Infra deployments
 * tab):
 *   - readDeploymentsConfig    → env gate (DeploymentsNotConfiguredError)
 *   - listArmDeployments       → GET .../Microsoft.Resources/deployments per RG,
 *                                shaped + ISO-duration parsed + newest-first sort
 *   - listArmDeploymentOperations → GET .../deployments/{name}/operations
 *
 * Stubs @azure/identity + global.fetch — no live tenant. Asserts the REAL ARM
 * REST surface per no-vaporware.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  readDeploymentsConfig,
  listArmDeployments,
  listArmDeploymentOperations,
  DeploymentsNotConfiguredError,
} from '../arm-deployments-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(out === undefined ? '' : JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }) as any;
}

beforeEach(() => {
  delete process.env.LOOM_SUBSCRIPTION_ID;
  for (const k of ['LOOM_ADMIN_RG', 'LOOM_ACA_RG', 'LOOM_DLZ_RG', 'LOOM_AI_SEARCH_RG', 'LOOM_KUSTO_RG', 'LOOM_APIM_RG', 'LOOM_FOUNDRY_RG', 'LOOM_AOAI_RG']) delete process.env[k];
});
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('readDeploymentsConfig (honest gate)', () => {
  it('throws DeploymentsNotConfiguredError naming LOOM_SUBSCRIPTION_ID', () => {
    expect(() => readDeploymentsConfig()).toThrowError(DeploymentsNotConfiguredError);
    try { readDeploymentsConfig(); } catch (e) {
      expect((e as DeploymentsNotConfiguredError).missing).toContain('LOOM_SUBSCRIPTION_ID');
    }
  });

  it('throws naming a Loom RG when sub set but no RGs', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    try { readDeploymentsConfig(); throw new Error('expected throw'); } catch (e) {
      expect(e).toBeInstanceOf(DeploymentsNotConfiguredError);
      expect((e as DeploymentsNotConfiguredError).missing[0]).toMatch(/LOOM_ADMIN_RG/);
    }
  });

  it('returns sub + deduped RGs when configured', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    process.env.LOOM_ACA_RG = 'rg-admin'; // dup → deduped
    process.env.LOOM_DLZ_RG = 'rg-dlz';
    const cfg = readDeploymentsConfig();
    expect(cfg.subscriptionId).toBe('sub-1');
    expect(cfg.resourceGroups.sort()).toEqual(['rg-admin', 'rg-dlz']);
  });
});

describe('listArmDeployments', () => {
  beforeEach(() => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
  });

  it('GETs Microsoft.Resources/deployments at RG scope and shapes the result', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return { value: [{
        id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Resources/deployments/loom-main',
        name: 'loom-main',
        properties: {
          provisioningState: 'Succeeded',
          timestamp: '2026-05-30T10:00:00Z',
          duration: 'PT3M12.5S',
          mode: 'Incremental',
          outputResources: [{ id: '/r1' }, { id: '/r2' }],
        },
      }] };
    });
    const out = await listArmDeployments();
    expect(url).toContain('/resourceGroups/rg-admin/providers/Microsoft.Resources/deployments');
    expect(url).toContain('Microsoft.Resources/deployments?api-version=');
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('loom-main');
    expect(out[0].provisioningState).toBe('Succeeded');
    expect(out[0].mode).toBe('Incremental');
    expect(out[0].resourceCount).toBe(2);
    // PT3M12.5S → 192.5s
    expect(Math.round(out[0].durationSec!)).toBe(193);
  });

  it('captures the error message on a Failed deployment', async () => {
    mockFetch(() => ({ value: [{
      id: '/subscriptions/sub-1/resourceGroups/rg-admin/providers/Microsoft.Resources/deployments/bad',
      name: 'bad',
      properties: { provisioningState: 'Failed', error: { code: 'BadRequest', message: 'invalid sku' } },
    }] }));
    const out = await listArmDeployments();
    expect(out[0].provisioningState).toBe('Failed');
    expect(out[0].error).toBe('invalid sku');
  });

  it('sorts newest-first across RGs', async () => {
    process.env.LOOM_DLZ_RG = 'rg-dlz';
    mockFetch((u) => {
      if (u.includes('rg-admin')) return { value: [{ id: '/a', name: 'older', properties: { timestamp: '2026-05-01T00:00:00Z' } }] };
      return { value: [{ id: '/b', name: 'newer', properties: { timestamp: '2026-05-29T00:00:00Z' } }] };
    });
    const out = await listArmDeployments();
    expect(out.map((d) => d.name)).toEqual(['newer', 'older']);
  });
});

describe('listArmDeploymentOperations', () => {
  beforeEach(() => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
  });

  it('GETs the deployment operations endpoint and shapes target resources', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return { value: [{ properties: {
        provisioningState: 'Succeeded', timestamp: '2026-05-30T10:01:00Z', statusCode: 'OK',
        duration: 'PT5S', targetResource: { resourceType: 'Microsoft.App/containerApps', resourceName: 'console' },
      } }] };
    });
    const out = await listArmDeploymentOperations('rg-admin', 'loom-main');
    expect(url).toContain('/deployments/loom-main/operations');
    expect(out[0].resourceType).toBe('Microsoft.App/containerApps');
    expect(out[0].resourceName).toBe('console');
    expect(out[0].durationSec).toBe(5);
  });
});
