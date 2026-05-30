/**
 * Backend contract tests for the Fabric deployment-pipelines client helpers
 * used by the Deployment surface:
 *   - listDeploymentPipelines           → GET /v1/deploymentPipelines (+ paging)
 *   - listDeploymentPipelineStages      → GET .../{id}/stages (ordered)
 *   - listDeploymentPipelineStageItems  → GET .../{id}/stages/{sid}/items
 *   - deployStageContent                → POST .../{id}/deploy (all + selective)
 *   - listDeploymentPipelineOperations  → GET .../{id}/operations
 *
 * Stubs @azure/identity + global.fetch — no live tenant. Asserts URL + method
 * + payload against the REAL Fabric REST surface per no-vaporware.md.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  listDeploymentPipelines,
  listDeploymentPipelineStages,
  listDeploymentPipelineStageItems,
  deployStageContent,
  listDeploymentPipelineOperations,
  FabricError,
} from '../fabric-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    const headers = out?._headers || {};
    const bodyVal = out && typeof out === 'object' ? { ...out } : out;
    if (bodyVal && typeof bodyVal === 'object') { delete bodyVal._status; delete bodyVal._headers; }
    return new Response(bodyVal === undefined ? '' : JSON.stringify(bodyVal), { status, headers });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('listDeploymentPipelines', () => {
  it('GETs /v1/deploymentPipelines and unwraps value', async () => {
    let url = ''; let method = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return { value: [{ id: 'p1', displayName: 'Sales DP' }] }; });
    const out = await listDeploymentPipelines();
    expect(url).toContain('/v1/deploymentPipelines');
    expect(method).toBe('GET');
    expect(out).toHaveLength(1);
    expect(out[0].displayName).toBe('Sales DP');
  });

  it('follows continuationToken across pages', async () => {
    const urls: string[] = [];
    let call = 0;
    mockFetch((u) => {
      urls.push(u); call++;
      if (call === 1) return { value: [{ id: 'p1', displayName: 'A' }], continuationToken: 'TKN2' };
      return { value: [{ id: 'p2', displayName: 'B' }] };
    });
    const out = await listDeploymentPipelines();
    expect(out.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(urls[1]).toContain('continuationToken=TKN2');
  });
});

describe('listDeploymentPipelineStages', () => {
  it('GETs /{id}/stages and sorts by order', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return { value: [
        { id: 's3', order: 2, displayName: 'Production', isPublic: true },
        { id: 's1', order: 0, displayName: 'Development', workspaceId: 'w1', workspaceName: 'Dev WS' },
        { id: 's2', order: 1, displayName: 'Test', workspaceId: 'w2' },
      ] };
    });
    const out = await listDeploymentPipelineStages('a5ded933');
    expect(url).toContain('/v1/deploymentPipelines/a5ded933/stages');
    expect(out.map((s) => s.displayName)).toEqual(['Development', 'Test', 'Production']);
    expect(out[0].workspaceName).toBe('Dev WS');
  });
});

describe('listDeploymentPipelineStageItems', () => {
  it('GETs /{id}/stages/{stageId}/items', async () => {
    let url = '';
    mockFetch((u) => { url = u; return { value: [{ itemId: 'i1', itemDisplayName: 'Report A', itemType: 'Report' }] }; });
    const out = await listDeploymentPipelineStageItems('dp1', 'stage1');
    expect(url).toContain('/v1/deploymentPipelines/dp1/stages/stage1/items');
    expect(out[0].itemType).toBe('Report');
  });
});

describe('deployStageContent', () => {
  it('POSTs /{id}/deploy with source/target on deploy-all (no items key)', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}');
      return { _status: 202, _headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op-1' } };
    });
    const out: any = await deployStageContent('dp1', { sourceStageId: 'src', targetStageId: 'tgt', note: 'go' });
    expect(url).toContain('/v1/deploymentPipelines/dp1/deploy');
    expect(method).toBe('POST');
    expect(body.sourceStageId).toBe('src');
    expect(body.targetStageId).toBe('tgt');
    expect(body.note).toBe('go');
    expect('items' in body).toBe(false);
    expect(out._accepted).toBe(true);
    expect(out.location).toContain('/operations/op-1');
  });

  it('includes the items[] array on selective deploy', async () => {
    let body: any;
    mockFetch((_, init) => { body = JSON.parse((init?.body as string) || '{}'); return { _status: 202 }; });
    await deployStageContent('dp1', {
      sourceStageId: 'src', targetStageId: 'tgt',
      items: [{ sourceItemId: 'i1', itemType: 'Report' }, { sourceItemId: 'i2', itemType: 'SemanticModel' }],
    });
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({ sourceItemId: 'i1', itemType: 'Report' });
  });

  it('throws FabricError(400) when stage ids missing', async () => {
    mockFetch(() => ({}));
    await expect(deployStageContent('dp1', { sourceStageId: '', targetStageId: 'tgt' } as any)).rejects.toBeInstanceOf(FabricError);
    await expect(deployStageContent('dp1', { sourceStageId: 'src', targetStageId: '' } as any)).rejects.toBeInstanceOf(FabricError);
  });
});

describe('listDeploymentPipelineOperations', () => {
  it('GETs /{id}/operations and flattens note + performedBy', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return { value: [{
        id: 'op1', type: 'Deploy', status: 'Succeeded',
        sourceStageId: 's1', targetStageId: 's2',
        executionStartTime: '2026-05-30T00:00:00Z',
        note: { content: 'release 1', isTruncated: false },
        performedBy: { type: 'User', displayName: 'Frank G', userDetails: { userPrincipalName: 'f@t.com' } },
      }] };
    });
    const out = await listDeploymentPipelineOperations('dp1');
    expect(url).toContain('/v1/deploymentPipelines/dp1/operations');
    expect(out[0].status).toBe('Succeeded');
    expect(out[0].note).toBe('release 1');
    expect(out[0].performedBy).toBe('Frank G');
  });
});

describe('Fabric 401/403 → FabricError with auth hint', () => {
  it('surfaces a remediation hint the BFF can show as a gate', async () => {
    mockFetch(() => new Response(JSON.stringify({ errorCode: 'Unauthorized', message: 'no access' }), { status: 403 }));
    try {
      await listDeploymentPipelines();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FabricError);
      expect((e as FabricError).status).toBe(403);
      expect((e as FabricError).hint).toMatch(/Fabric admin/i);
    }
  });
});
