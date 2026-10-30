import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('@/lib/azure/arm-counted-fetch', () => ({ armCountedFetch: (...a: any[]) => fetchMock(...a) }));
vi.mock('@azure/identity', () => {
  class Cred { getToken = async () => ({ token: 't' }); }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { listApis, listMcpApis, listPolicyFragments, withApimGateway } from '@/lib/azure/apim-client';

const OTHER = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg2/providers/Microsoft.ApiManagement/service/other';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetchMock.mockReset();
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
  process.env.LOOM_APIM_NAME = 'default-apim';
});

describe('apim-client gateway override', () => {
  it('without an override the URL targets the env default service', async () => {
    fetchMock.mockResolvedValue(json({ value: [] }));
    await listApis();
    expect(fetchMock.mock.calls[0][0]).toContain('/service/default-apim/apis');
  });
  it('inside withApimGateway the URL targets the registered service and not the default', async () => {
    fetchMock.mockResolvedValue(json({ value: [] }));
    await withApimGateway(OTHER, () => listApis());
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/resourceGroups/rg2/providers/Microsoft.ApiManagement/service/other/apis');
    expect(url).not.toContain('default-apim');
  });
});

describe('listMcpApis / listPolicyFragments', () => {
  it('calls api-version 2025-09-01-preview and keeps only type mcp', async () => {
    fetchMock.mockResolvedValue(json({ value: [
      { name: 'm', properties: { type: 'mcp' } }, { name: 'h', properties: { type: 'http' } },
    ] }));
    const r = await listMcpApis(OTHER);
    expect(fetchMock.mock.calls[0][0]).toContain('api-version=2025-09-01-preview');
    expect(r).toMatchObject({ status: 'ok', complete: true });
    expect(r.status === 'ok' && r.items.map((i) => i.name)).toEqual(['m']);
  });
  it('a 400 rejection of the version is reported unavailable, never an empty ok list', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'api-version not supported' } }, 400));
    const r = await listMcpApis(OTHER);
    expect(r.status).toBe('unavailable');
  });
  it('a 500 throws (not claimed unavailable)', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'boom' } }, 500));
    await expect(listMcpApis(OTHER)).rejects.toMatchObject({ status: 500 });
  });
  it('follows nextLink and reports complete; a foreign nextLink is not followed and is incomplete', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ value: [{ name: 'a' }], nextLink: 'https://management.azure.com/next' }))
      .mockResolvedValueOnce(json({ value: [{ name: 'b' }] }));
    const ok = await listPolicyFragments(OTHER);
    expect(ok.items.map((i) => i.name)).toEqual(['a', 'b']);
    expect(ok.complete).toBe(true);
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ value: [{ name: 'a' }], nextLink: 'https://evil.example/steal' }));
    const bad = await listPolicyFragments(OTHER);
    expect(bad.complete).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
