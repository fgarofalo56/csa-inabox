/**
 * The ARM tag-merge primitive (#4255 W2).
 *
 * Asserts the three properties the backfill's safety rests on, at the wire:
 *
 *   1. The request is a MERGE carrying exactly ONE key — a `Replace`, or a
 *      body carrying the whole bag, would clobber tags written between our
 *      read and our write.
 *   2. It targets the type-agnostic tags extension resource, so the same code
 *      works for a Synapse pool, a Kusto cluster, an AAS server and a VMSS.
 *   3. A non-200 is an HONEST failure: the status and the body travel
 *      verbatim, and the message never claims the tag was or was not written
 *      (deploy-integrity R7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cred = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock('@/lib/azure/arm-credential', () => ({ uamiArmCredential: () => cred }));

const net = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@/lib/azure/fetch-with-timeout', () => ({ fetchWithTimeout: net.fetchWithTimeout }));

vi.mock('@/lib/azure/cloud-endpoints', () => ({
  // A non-Commercial host on purpose: the primitive must never carry a literal
  // `management.azure.com` (`cloud-parity.md`).
  armBase: () => 'https://management.usgovcloudapi.net',
  armScope: () => 'https://management.usgovcloudapi.net/.default',
}));

import {
  armMergeTag,
  BrainActionArmError,
  BRAIN_ACTIONS_TAGS_API,
  resetBrainActionTagCredential,
} from '../arm-tags';

const RESOURCE =
  '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg-loom' +
  '/providers/Microsoft.Kusto/clusters/adxloom';

function armResponse(status: number, body: unknown) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBrainActionTagCredential();
  cred.getToken.mockResolvedValue({ token: 'tok' });
});
afterEach(() => resetBrainActionTagCredential());

describe('the request shape', () => {
  it('PATCHes the tags extension resource with a single-key Merge', async () => {
    net.fetchWithTimeout.mockResolvedValue(
      armResponse(200, { properties: { tags: { env: 'dev', 'loom-estate-id': 'e1' } } }),
    );
    const after = await armMergeTag(RESOURCE, 'loom-estate-id', 'e1');

    const [url, init] = net.fetchWithTimeout.mock.calls[0]!;
    expect(url).toBe(
      `https://management.usgovcloudapi.net${RESOURCE}/providers/Microsoft.Resources/tags/default` +
        `?api-version=${BRAIN_ACTIONS_TAGS_API}`,
    );
    expect((init as RequestInit).method).toBe('PATCH');
    const body = JSON.parse((init as RequestInit).body as string) as {
      operation: string;
      properties: { tags: Record<string, string> };
    };
    // (1) MERGE, never Replace.
    expect(body.operation).toBe('Merge');
    // (1) EXACTLY ONE KEY — the whole non-clobbering argument.
    expect(Object.keys(body.properties.tags)).toEqual(['loom-estate-id']);
    expect(body.properties.tags['loom-estate-id']).toBe('e1');
    // The `after` is what ARM reported, not what we hoped happened.
    expect(after).toEqual({ env: 'dev', 'loom-estate-id': 'e1' });
  });

  it('carries the token from the sanctioned credential factory', async () => {
    net.fetchWithTimeout.mockResolvedValue(armResponse(200, { properties: { tags: {} } }));
    await armMergeTag(RESOURCE, 'k', 'v');
    const init = net.fetchWithTimeout.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('names NO cloud-specific host of its own (cloud parity)', async () => {
    net.fetchWithTimeout.mockResolvedValue(armResponse(200, { properties: { tags: {} } }));
    await armMergeTag(RESOURCE, 'k', 'v');
    expect(net.fetchWithTimeout.mock.calls[0]![0]).not.toContain('management.azure.com');
  });
});

describe('refusals and honest failures', () => {
  it('refuses a string that is not an ARM resource id, before any network call', async () => {
    await expect(armMergeTag('loom-risingwave', 'k', 'v')).rejects.toThrow(
      /is not an ARM resource id/,
    );
    expect(net.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('refuses an empty key or value rather than writing a meaningless tag', async () => {
    await expect(armMergeTag(RESOURCE, '', 'v')).rejects.toThrow(/empty tag key or value/);
    await expect(armMergeTag(RESOURCE, 'k', '  ')).rejects.toThrow(/empty tag key or value/);
    expect(net.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('fails closed when no ARM token can be acquired, and says nothing was tagged', async () => {
    cred.getToken.mockResolvedValue(null);
    await expect(armMergeTag(RESOURCE, 'k', 'v')).rejects.toThrow(/NOTHING was tagged/);
    expect(net.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('R7: a 403 carries the status and the raw body, and names the missing role', async () => {
    net.fetchWithTimeout.mockResolvedValue(
      armResponse(403, { error: { code: 'AuthorizationFailed', message: 'does not have write' } }),
    );
    let caught: unknown;
    try {
      await armMergeTag(RESOURCE, 'loom-estate-id', 'e1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BrainActionArmError);
    const err = caught as BrainActionArmError;
    expect(err.status).toBe(403);
    expect(err.message).toContain('status 403');
    expect(err.message).toContain('NOT confirmed written');
    expect(err.message).toContain('Tag Contributor');
    expect(err.message).toContain('AuthorizationFailed');
  });

  it('R7: an unparseable 200 is stated as UNCONFIRMED, not claimed either way', async () => {
    net.fetchWithTimeout.mockResolvedValue(armResponse(200, '<html>gateway</html>'));
    await expect(armMergeTag(RESOURCE, 'k', 'v')).rejects.toThrow(
      /UNCONFIRMED rather than claimed either way/,
    );
  });
});
