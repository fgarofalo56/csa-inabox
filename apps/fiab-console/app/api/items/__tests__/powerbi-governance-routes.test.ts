/**
 * BFF gate tests for the Power BI governance parity routes:
 *   - GET/POST/PUT/DELETE /api/powerbi/access        (workspace GroupUsers ACL)
 *   - GET/PUT             /api/powerbi/endorsement    (Promote/Certify)
 *   - GET/POST            /api/powerbi/datasources    (gateway bind / datasources)
 *
 * Asserts the auth gate (401), input validation (400), and that the happy path
 * delegates to the real powerbi-client helper with the right args. The client
 * module is stubbed; these verify the route contract (network shapes are covered
 * by powerbi-client-governance.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/powerbi-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/powerbi-client');
  return {
    ...actual,
    powerbiConfigGate: vi.fn(() => null),
    listGroupUsers: vi.fn(),
    addGroupUser: vi.fn(),
    updateGroupUser: vi.fn(),
    deleteGroupUser: vi.fn(),
    getItemEndorsement: vi.fn(),
    setItemEndorsement: vi.fn(),
    getDatasetDatasources: vi.fn(),
    getBoundGatewayDatasources: vi.fn(),
    discoverGateways: vi.fn(),
    bindToGateway: vi.fn(),
  };
});

import {
  GET as accessGET, POST as accessPOST, PUT as accessPUT, DELETE as accessDELETE,
} from '../../powerbi/access/route';
import { GET as endGET, PUT as endPUT } from '../../powerbi/endorsement/route';
import { GET as dsGET, POST as dsPOST } from '../../powerbi/datasources/route';
import { getSession } from '@/lib/auth/session';
import {
  powerbiConfigGate,
  listGroupUsers, addGroupUser, updateGroupUser, deleteGroupUser,
  getItemEndorsement, setItemEndorsement,
  getDatasetDatasources, getBoundGatewayDatasources, discoverGateways, bindToGateway,
} from '@/lib/azure/powerbi-client';

function getReq(url: string) { return { nextUrl: new URL(url), url } as any; }
function bodyReq(url: string, body: any) { return { nextUrl: new URL(url), url, json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  // config gate returns null (configured) by default after reset
  (powerbiConfigGate as any).mockReturnValue(null);
});

describe('access (GroupUsers)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await accessGET(getReq('http://x/?workspaceId=w'));
    expect(res.status).toBe(401);
  });
  it('400 without workspaceId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await accessGET(getReq('http://x/'));
    expect(res.status).toBe(400);
  });
  it('lists users on the happy path', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (listGroupUsers as any).mockResolvedValue([{ identifier: 'a@x', groupUserAccessRight: 'Admin' }]);
    const res = await accessGET(getReq('http://x/?workspaceId=w'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.users[0].groupUserAccessRight).toBe('Admin');
    expect(listGroupUsers).toHaveBeenCalledWith('w');
  });
  it('400 on add with an invalid role', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await accessPOST(bodyReq('http://x/', { workspaceId: 'w', identifier: 'a@x', role: 'Owner' }));
    expect(res.status).toBe(400);
    expect(addGroupUser).not.toHaveBeenCalled();
  });
  it('delegates a valid add to addGroupUser and returns the refreshed list', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (addGroupUser as any).mockResolvedValue({ ok: true });
    (listGroupUsers as any).mockResolvedValue([{ identifier: 'a@x', groupUserAccessRight: 'Member' }]);
    const res = await accessPOST(bodyReq('http://x/', { workspaceId: 'w', identifier: 'a@x', role: 'Member', principalType: 'User' }));
    expect(res.status).toBe(200);
    expect(addGroupUser).toHaveBeenCalledWith('w', expect.objectContaining({ identifier: 'a@x', groupUserAccessRight: 'Member', principalType: 'User' }));
  });
  it('delegates a valid update to updateGroupUser', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (updateGroupUser as any).mockResolvedValue({ ok: true });
    (listGroupUsers as any).mockResolvedValue([]);
    const res = await accessPUT(bodyReq('http://x/', { workspaceId: 'w', identifier: 'a@x', role: 'Viewer' }));
    expect(res.status).toBe(200);
    expect(updateGroupUser).toHaveBeenCalledWith('w', expect.objectContaining({ groupUserAccessRight: 'Viewer' }));
  });
  it('delegates delete to deleteGroupUser', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (deleteGroupUser as any).mockResolvedValue({ ok: true });
    (listGroupUsers as any).mockResolvedValue([]);
    const res = await accessDELETE(getReq('http://x/?workspaceId=w&identifier=a%40x'));
    expect(res.status).toBe(200);
    expect(deleteGroupUser).toHaveBeenCalledWith('w', 'a@x');
  });
});

describe('endorsement', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await endGET(getReq('http://x/?workspaceId=w&itemId=i'));
    expect(res.status).toBe(401);
  });
  it('reads endorsement', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (getItemEndorsement as any).mockResolvedValue({ endorsementStatus: 'Promoted' });
    const res = await endGET(getReq('http://x/?workspaceId=w&itemId=i'));
    const j = await res.json();
    expect(j.endorsement.endorsementStatus).toBe('Promoted');
    expect(getItemEndorsement).toHaveBeenCalledWith('w', 'i');
  });
  it('400 on an invalid itemType', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await endPUT(bodyReq('http://x/', { workspaceId: 'w', itemId: 'i', itemType: 'dashboards', endorsement: 'Promoted' }));
    expect(res.status).toBe(400);
  });
  it('400 when certifying without certifiedBy', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await endPUT(bodyReq('http://x/', { workspaceId: 'w', itemId: 'i', itemType: 'datasets', endorsement: 'Certified' }));
    expect(res.status).toBe(400);
    expect(setItemEndorsement).not.toHaveBeenCalled();
  });
  it('delegates a valid certify to setItemEndorsement', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (setItemEndorsement as any).mockResolvedValue({ ok: true });
    (getItemEndorsement as any).mockResolvedValue({ endorsementStatus: 'Certified', certifiedBy: 'r@x' });
    const res = await endPUT(bodyReq('http://x/', { workspaceId: 'w', itemId: 'i', itemType: 'datasets', endorsement: 'Certified', certifiedBy: 'r@x' }));
    expect(res.status).toBe(200);
    expect(setItemEndorsement).toHaveBeenCalledWith('w', 'datasets', 'i', 'Certified', 'r@x');
  });
});

describe('datasources', () => {
  it('400 without datasetId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await dsGET(getReq('http://x/?workspaceId=w'));
    expect(res.status).toBe(400);
  });
  it('aggregates datasources + gateways on GET', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (getDatasetDatasources as any).mockResolvedValue([{ datasourceType: 'Sql' }]);
    (getBoundGatewayDatasources as any).mockResolvedValue([]);
    (discoverGateways as any).mockResolvedValue([{ id: 'gw' }]);
    const res = await dsGET(getReq('http://x/?workspaceId=w&datasetId=d'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.datasources[0].datasourceType).toBe('Sql');
    expect(j.gateways[0].id).toBe('gw');
  });
  it('400 on bind without gatewayObjectId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await dsPOST(bodyReq('http://x/', { workspaceId: 'w', datasetId: 'd', action: 'bind' }));
    expect(res.status).toBe(400);
    expect(bindToGateway).not.toHaveBeenCalled();
  });
  it('delegates a valid bind', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (bindToGateway as any).mockResolvedValue({ ok: true });
    (getBoundGatewayDatasources as any).mockResolvedValue([{ gatewayId: 'gw' }]);
    const res = await dsPOST(bodyReq('http://x/', { workspaceId: 'w', datasetId: 'd', action: 'bind', gatewayObjectId: 'gw' }));
    expect(res.status).toBe(200);
    expect(bindToGateway).toHaveBeenCalledWith('w', 'd', 'gw', undefined);
  });
});
