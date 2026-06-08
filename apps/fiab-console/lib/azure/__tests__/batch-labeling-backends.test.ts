/**
 * Backend contract tests for the batch-labeling backend helpers (F18):
 *   - powerbi-client.setLabelsAsAdmin  (POST /admin/informationprotection/setLabels)
 *   - purview-client.addAssetClassification
 *       (POST /datamap/api/atlas/v2/entity/guid/{guid}/classifications)
 *
 * Assert URL + method + payload shaping against the REAL Power BI Admin REST and
 * the Atlas v2 classification surface. Stubs @azure/identity + global.fetch — no
 * live tenant required. Per no-vaporware, the tests exercise the actual code path
 * (no mocking of the function under test) and assert that error statuses are
 * surfaced verbatim (no fake success).
 *
 * Learn refs:
 *   Information Protection - Set Labels As Admin:
 *     https://learn.microsoft.com/rest/api/power-bi/admin/information-protection-set-labels-as-admin
 *   Atlas v2 add classifications:
 *     https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { setLabelsAsAdmin, PowerBiError } from '../powerbi-client';
import { addAssetClassification, PurviewError } from '../purview-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    return new Response(out === undefined ? '' : JSON.stringify(out), { status });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; });

describe('setLabelsAsAdmin (Power BI Admin bulk label)', () => {
  it('POSTs /admin/informationprotection/setLabels with artifacts + labelId', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '{}');
      return { reports: [{ id: 'r-1', status: 'Succeeded' }], datasets: [{ id: 'd-1', status: 'NotFound' }] };
    });
    const resp = await setLabelsAsAdmin(
      { reports: [{ id: 'r-1' }], datasets: [{ id: 'd-1' }] },
      '11111111-1111-1111-1111-111111111111',
    );
    expect(url).toContain('/admin/informationprotection/setLabels');
    expect(method).toBe('POST');
    expect(body.labelId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.assignmentMethod).toBe('Standard');
    expect(body.artifacts.reports[0].id).toBe('r-1');
    // Per-artifact status comes back verbatim — no synthesis.
    expect(resp.reports?.[0].status).toBe('Succeeded');
    expect(resp.datasets?.[0].status).toBe('NotFound');
  });

  it('throws on empty labelId (guard) without calling fetch', async () => {
    const spy = vi.fn();
    global.fetch = spy as any;
    await expect(setLabelsAsAdmin({ reports: [{ id: 'r-1' }] }, '')).rejects.toBeInstanceOf(PowerBiError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces a 403 (SP not a Fabric admin) as PowerBiError — no fake success', async () => {
    mockFetch(() => ({ _status: 403, error: { message: 'PowerBINotAuthorizedException' } }));
    await expect(
      setLabelsAsAdmin({ reports: [{ id: 'r-1' }] }, '11111111-1111-1111-1111-111111111111'),
    ).rejects.toBeInstanceOf(PowerBiError);
  });
});

describe('addAssetClassification (Purview Atlas)', () => {
  beforeEach(() => { process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test'; });
  afterEach(() => { delete process.env.LOOM_PURVIEW_ACCOUNT; });

  it('POSTs the classifications array to the entity guid endpoint', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET'; body = JSON.parse((init?.body as string) || '[]');
      return new Response(null, { status: 204 });
    });
    await addAssetClassification('guid-123', ['Confidential']);
    expect(url).toContain('/datamap/api/atlas/v2/entity/guid/guid-123/classifications');
    expect(method).toBe('POST');
    expect(body).toEqual([{ typeName: 'Confidential' }]);
  });

  it('treats 409 (already assigned) as idempotent success', async () => {
    mockFetch(() => ({ _status: 409, errorMessage: 'already assigned' }));
    await expect(addAssetClassification('guid-123', ['Confidential'])).resolves.toBeUndefined();
  });

  it('surfaces a 403 as PurviewError', async () => {
    mockFetch(() => ({ _status: 403, errorMessage: 'forbidden' }));
    await expect(addAssetClassification('guid-123', ['Confidential'])).rejects.toBeInstanceOf(PurviewError);
  });

  it('no-ops (no fetch) when no classification names are given', async () => {
    const spy = vi.fn();
    global.fetch = spy as any;
    await addAssetClassification('guid-123', []);
    expect(spy).not.toHaveBeenCalled();
  });
});
