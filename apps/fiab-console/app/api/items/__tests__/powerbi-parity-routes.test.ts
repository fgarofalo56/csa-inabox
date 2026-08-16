/**
 * BFF gate tests for the Power BI family A-grade parity routes:
 *   - GET   /api/items/report/[id]/pages
 *   - GET   /api/items/semantic-model/[id]/refresh-schedule
 *   - PATCH /api/items/semantic-model/[id]/refresh-schedule
 *   - POST  /api/items/semantic-model/[id]/take-over
 *
 * Asserts auth gate (401), input validation (400) and the happy path delegates
 * to the real powerbi-client helper with the right args. The client module is
 * stubbed; these tests verify the route contract, not the network call (that
 * is covered by powerbi-client-parity.test.ts).
 *
 * GHSA-hf73-rp4q-66pf gave refresh-schedule and take-over the item-ownership
 * ladder, which reads Cosmos + the workspace ACL. Those are stubbed below to the
 * AUTHORIZED answer, so these cases stay about the ROUTE CONTRACT. Without the
 * stubs the guard reached real Cosmos, threw `CosmosNotConfiguredError`, and
 * every branch — including validation and the happy path — came back 500. That
 * is fail-CLOSED and correct behaviour (the backend is never reached, and a 500
 * asserts nothing the code did not establish, unlike a 404 would), but it is not
 * what these cases are measuring. The boundary itself is covered in
 * semantic-model/[id]/__tests__/ghsa-item-authz.test.ts, which stubs the same
 * layer to a DENIED answer and asserts the 404.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

// The guard runs for real; only what it reads is stubbed.
const cosmosQueryStub = () => ({
  items: { query: () => ({ fetchAll: async () => ({ resources: [{ workspaceId: 'ws-1' }] }) }) },
});
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => cosmosQueryStub(),
  workspacesContainer: async () => cosmosQueryStub(),
}));
vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: async () => ({
    workspace: { id: 'ws-1' }, role: 'Owner', via: 'owner', canWrite: true,
  }),
}));
// #2012: the semantic-model BI routes default to the Azure-native AAS backend and
// honest-gate (503) when LOOM_AAS_SERVER_NAME is unset. These specs pin the opt-in
// Power BI path, so select it explicitly via the runtime backend resolver (the
// AAS path is covered separately). Without this the routes 503 before validation.
vi.mock('@/lib/admin/platform-settings', async () => {
  const actual: any = await vi.importActual('@/lib/admin/platform-settings');
  return { ...actual, resolveBiBackendMode: async () => 'powerbi' };
});
vi.mock('@/lib/azure/powerbi-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/powerbi-client');
  return {
    ...actual,
    getReportPages: vi.fn(),
    getRefreshSchedule: vi.fn(),
    patchRefreshSchedule: vi.fn(),
    takeOverDataset: vi.fn(),
  };
});

import { GET as pagesGET } from '../report/[id]/pages/route';
import { GET as schedGET, PATCH as schedPATCH } from '../semantic-model/[id]/refresh-schedule/route';
import { POST as takeOverPOST } from '../semantic-model/[id]/take-over/route';
import { getSession } from '@/lib/auth/session';
import { getReportPages, getRefreshSchedule, patchRefreshSchedule, takeOverDataset } from '@/lib/azure/powerbi-client';

function getReq(url: string) {
  const u = new URL(url);
  return { nextUrl: u, url } as any;
}
function bodyReq(url: string, body: any) {
  const u = new URL(url);
  return { nextUrl: u, url, json: async () => body } as any;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * A session the AUTHORIZATION ladder can actually read. These specs used
 * `{ user: 'u' }`, which has no `claims` — fine while every route here was
 * session-only, but `authorizeWorkspace` reads `session.claims.oid`
 * (lib/auth/workspace-guard.ts:169), so once refresh-schedule and take-over
 * gained the item-ownership ladder (GHSA-hf73-rp4q-66pf) that shape threw a
 * TypeError and every branch came back 500. The fixture was stale, not the route.
 */
const SESSION = { user: 'u', claims: { oid: 'oid-1', tid: 'tid-1' } } as any;

beforeEach(() => { vi.resetAllMocks(); });

describe('GET report pages', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await pagesGET(getReq('http://x/?workspaceId=w'), ctx('r'));
    expect(res.status).toBe(401);
  });
  it('400 without workspaceId', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await pagesGET(getReq('http://x/'), ctx('r'));
    expect(res.status).toBe(400);
  });
  it('returns pages from the client on the happy path', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (getReportPages as any).mockResolvedValue([{ name: 'p1', displayName: 'One' }]);
    const res = await pagesGET(getReq('http://x/?workspaceId=w'), ctx('r-1'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.pages[0].name).toBe('p1');
    expect(getReportPages).toHaveBeenCalledWith('w', 'r-1');
  });
});

describe('GET refresh-schedule', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await schedGET(getReq('http://x/?workspaceId=w'), ctx('d'));
    expect(res.status).toBe(401);
  });
  it('returns the live schedule', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (getRefreshSchedule as any).mockResolvedValue({ enabled: true, days: ['Monday'] });
    const res = await schedGET(getReq('http://x/?workspaceId=w'), ctx('d-1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.schedule.enabled).toBe(true);
    expect(getRefreshSchedule).toHaveBeenCalledWith('w', 'd-1');
  });
});

describe('PATCH refresh-schedule', () => {
  beforeEach(() => (getSession as any).mockReturnValue(SESSION));

  it('400 on an invalid day', async () => {
    const res = await schedPATCH(bodyReq('http://x/?workspaceId=w', { enabled: true, days: ['Funday'], times: ['07:00'] }), ctx('d'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/invalid day/i);
  });

  it('400 on a non-half-hour time', async () => {
    const res = await schedPATCH(bodyReq('http://x/?workspaceId=w', { enabled: true, days: ['Monday'], times: ['07:15'] }), ctx('d'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/30-minute/i);
  });

  it('400 when enabling without day+time', async () => {
    const res = await schedPATCH(bodyReq('http://x/?workspaceId=w', { enabled: true, days: [], times: [] }), ctx('d'));
    expect(res.status).toBe(400);
    expect(patchRefreshSchedule).not.toHaveBeenCalled();
  });

  it('delegates a valid schedule to the client and returns the refreshed schedule', async () => {
    (patchRefreshSchedule as any).mockResolvedValue({ ok: true });
    (getRefreshSchedule as any).mockResolvedValue({ enabled: true, days: ['Monday'], times: ['07:00'] });
    const res = await schedPATCH(
      bodyReq('http://x/?workspaceId=w', { enabled: true, days: ['Monday'], times: ['07:00'], localTimeZoneId: 'UTC', notifyOption: 'MailOnFailure' }),
      ctx('d-9'),
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(patchRefreshSchedule).toHaveBeenCalledWith('w', 'd-9', expect.objectContaining({
      enabled: true, days: ['Monday'], times: ['07:00'], localTimeZoneId: 'UTC', notifyOption: 'MailOnFailure',
    }));
    expect(j.schedule.enabled).toBe(true);
  });
});

describe('POST take-over', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await takeOverPOST(getReq('http://x/?workspaceId=w'), ctx('d'));
    expect(res.status).toBe(401);
  });
  it('400 without workspaceId', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await takeOverPOST(getReq('http://x/'), ctx('d'));
    expect(res.status).toBe(400);
  });
  it('delegates to takeOverDataset on the happy path', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (takeOverDataset as any).mockResolvedValue({ ok: true });
    const res = await takeOverPOST(getReq('http://x/?workspaceId=w'), ctx('d-3'));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(takeOverDataset).toHaveBeenCalledWith('w', 'd-3');
  });
});
