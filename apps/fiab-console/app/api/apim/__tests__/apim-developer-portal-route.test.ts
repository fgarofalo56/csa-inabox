/**
 * BFF contract tests for the APIM "Developer portal" admin route — the Wave-2
 * fix wiring the previously-missing Developer portal tab to real APIM REST
 * (Microsoft.ApiManagement/service/{name}/portalRevisions).
 *
 *   GET  /api/apim/developer-portal   → portal URLs + revision history
 *   POST /api/apim/developer-portal   → publish (PUT portalRevisions, async LRO)
 *
 * Verifies: auth gate (401), provisioning gate (503 with `missing`), graceful
 * handling of a never-published portal (empty revisions, not a hard error), and
 * happy-path delegation to the apim-client helpers (stubbed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/apim-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/apim-client');
  return {
    ...actual,
    getServiceInfo: vi.fn(),
    listPortalRevisions: vi.fn(),
    publishPortalRevision: vi.fn(),
  };
});

import { GET as portalGET, POST as portalPOST } from '../developer-portal/route';
import { getSession } from '@/lib/auth/session';
import {
  getServiceInfo, listPortalRevisions, publishPortalRevision, ApimError,
} from '@/lib/azure/apim-client';

function bodyReq(body: any, url = 'http://x/') {
  const u = new URL(url);
  return { nextUrl: u, url, json: async () => body } as any;
}

const ORIG = { name: process.env.LOOM_APIM_NAME, sub: process.env.LOOM_SUBSCRIPTION_ID };
function provisioned() {
  process.env.LOOM_APIM_NAME = 'apim-csa-loom-eastus2';
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
}
function notProvisioned() {
  delete process.env.LOOM_APIM_NAME;
  delete process.env.LOOM_SUBSCRIPTION_ID;
}

beforeEach(() => { vi.resetAllMocks(); provisioned(); });
afterEach(() => {
  if (ORIG.name) process.env.LOOM_APIM_NAME = ORIG.name; else delete process.env.LOOM_APIM_NAME;
  if (ORIG.sub) process.env.LOOM_SUBSCRIPTION_ID = ORIG.sub; else delete process.env.LOOM_SUBSCRIPTION_ID;
});

describe('GET /api/apim/developer-portal', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await portalGET();
    expect(res.status).toBe(401);
  });

  it('503 not_configured (naming the missing env var) when APIM is unset', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    notProvisioned();
    const res = await portalGET();
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_SUBSCRIPTION_ID');
    expect(getServiceInfo).not.toHaveBeenCalled();
  });

  it('404 when the service is not found at the configured scope', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getServiceInfo as any).mockResolvedValue(null);
    const res = await portalGET();
    expect(res.status).toBe(404);
  });

  it('returns portal URLs + revisions on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getServiceInfo as any).mockResolvedValue({
      name: 'apim1',
      developerPortalUrl: 'https://apim1.developer.azure-api.net',
      portalUrl: 'https://apim1.portal.azure-api.net',
      developerPortalStatus: 'Enabled',
      state: 'Succeeded',
    });
    (listPortalRevisions as any).mockResolvedValue([
      { id: 'r1', name: 'rev-1', isCurrent: true, status: 'completed' },
    ]);
    const res = await portalGET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.developerPortalUrl).toBe('https://apim1.developer.azure-api.net');
    expect(j.revisions).toHaveLength(1);
  });

  it('treats a never-published portal (revisions 404) as an empty list, not an error', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (getServiceInfo as any).mockResolvedValue({ name: 'apim1', developerPortalUrl: 'https://x' });
    (listPortalRevisions as any).mockRejectedValue(new ApimError(404, null, 'not found'));
    const res = await portalGET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.revisions).toEqual([]);
  });
});

describe('POST /api/apim/developer-portal', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await portalPOST(bodyReq({}));
    expect(res.status).toBe(401);
  });

  it('publishes (isCurrent defaults true) on the happy path', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (publishPortalRevision as any).mockResolvedValue({ id: 'rev-x', name: 'rev-x', status: 'publishing', isCurrent: true });
    const res = await portalPOST(bodyReq({ description: 'added orders API' }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.revision.name).toBe('rev-x');
    expect(publishPortalRevision).toHaveBeenCalledWith({ description: 'added orders API', isCurrent: true });
  });
});
