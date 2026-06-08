/**
 * Vitest specs for label-protection (F19 / F20 / F21).
 *
 * Pure helpers are tested directly; the Graph-backed helper
 * (`checkLabelChangeRights`) is exercised by mocking
 * `getSensitivityLabelWithRights` from the mip-graph-client module. No real
 * Microsoft Graph / ARM calls are made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SensitivityLabel } from '../mip-graph-client';

// Mock the Graph rights lookup + the enforce path so no network is touched.
const getRightsMock = vi.fn();
vi.mock('../mip-graph-client', () => ({
  getSensitivityLabelWithRights: (...a: any[]) => getRightsMock(...a),
}));
const enforceMock = vi.fn();
vi.mock('../access-policy-client', () => ({
  enforceAccessGrant: (...a: any[]) => enforceMock(...a),
}));

import {
  isProtectedLabel,
  labelSensitivity,
  sensitivityToPermission,
  checkExportProtection,
  checkLabelChangeRights,
  resolveItemBackingScope,
  enforceLabelRbac,
} from '../label-protection';

function lbl(over: Partial<SensitivityLabel> & { raw?: any } = {}): SensitivityLabel {
  return { id: 'lbl-1', name: 'Confidential', sensitivity: 3, ...over };
}

describe('label-protection — pure helpers', () => {
  it('isProtectedLabel reads hasProtection from typed field and raw', () => {
    expect(isProtectedLabel(lbl({ hasProtection: true }))).toBe(true);
    expect(isProtectedLabel(lbl({ hasProtection: false }))).toBe(false);
    expect(isProtectedLabel(lbl({ raw: { hasProtection: true } }))).toBe(true);
    expect(isProtectedLabel(lbl({}))).toBe(false);
  });

  it('labelSensitivity falls back to raw then 0', () => {
    expect(labelSensitivity(lbl({ sensitivity: 4 }))).toBe(4);
    expect(labelSensitivity(lbl({ sensitivity: undefined, raw: { sensitivity: 2 } }))).toBe(2);
    expect(labelSensitivity(lbl({ sensitivity: undefined }))).toBe(0);
  });

  it('sensitivityToPermission maps >=3 to read, else write', () => {
    expect(sensitivityToPermission(0)).toBe('write');
    expect(sensitivityToPermission(1)).toBe('write');
    expect(sensitivityToPermission(2)).toBe('write');
    expect(sensitivityToPermission(3)).toBe('read');
    expect(sensitivityToPermission(4)).toBe('read');
    expect(sensitivityToPermission(5)).toBe('read');
    expect(sensitivityToPermission(undefined)).toBe('write');
  });
});

describe('checkExportProtection — F19', () => {
  it('never blocks an unprotected label', () => {
    expect(checkExportProtection(lbl({ hasProtection: false }), 'csv')).toEqual({ blocked: false });
  });

  it('blocks CSV/TXT for protected labels even with export rights', () => {
    const p = lbl({ hasProtection: true });
    const rights = { allowView: true, allowEdit: true, allowExport: true, allowCopy: true, allowPrint: true };
    expect(checkExportProtection(p, 'csv', rights).blocked).toBe(true);
    expect(checkExportProtection(p, '.txt', rights).blocked).toBe(true);
    expect(checkExportProtection(p, 'CSV', rights).reason).toMatch(/encryption protection/i);
  });

  it('allows protection-preserving formats for protected labels', () => {
    const p = lbl({ hasProtection: true });
    expect(checkExportProtection(p, 'xlsx').blocked).toBe(false);
    expect(checkExportProtection(p, 'pdf').blocked).toBe(false);
  });

  it('hard-blocks any format when the caller lacks the EXPORT right', () => {
    const p = lbl({ hasProtection: true });
    const noExport = { allowView: true, allowEdit: true, allowExport: false, allowCopy: false, allowPrint: false };
    const r = checkExportProtection(p, 'xlsx', noExport);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/do not permit export/i);
  });
});

describe('resolveItemBackingScope', () => {
  const base = { id: 'i1', workspaceId: 'w1', displayName: 'My DB', createdBy: 'x', createdAt: '', updatedAt: '' };
  it('lakehouse → adls-container (state.container, default bronze)', () => {
    expect(resolveItemBackingScope({ ...base, itemType: 'lakehouse', state: { container: 'silver' } }))
      .toEqual({ scopeType: 'adls-container', scopeRef: 'silver' });
    expect(resolveItemBackingScope({ ...base, itemType: 'lakehouse' }))
      .toEqual({ scopeType: 'adls-container', scopeRef: 'bronze' });
  });
  it('warehouse → warehouse (state.dedicatedPool, default loompool)', () => {
    const prev = process.env.LOOM_SYNAPSE_DEDICATED_POOL;
    delete process.env.LOOM_SYNAPSE_DEDICATED_POOL;
    expect(resolveItemBackingScope({ ...base, itemType: 'warehouse' }))
      .toEqual({ scopeType: 'warehouse', scopeRef: 'loompool' });
    if (prev !== undefined) process.env.LOOM_SYNAPSE_DEDICATED_POOL = prev;
  });
  it('kql-database / eventhouse → kql-database (state.adxDatabase, default displayName)', () => {
    expect(resolveItemBackingScope({ ...base, itemType: 'kql-database', state: { adxDatabase: 'telemetry' } }))
      .toEqual({ scopeType: 'kql-database', scopeRef: 'telemetry' });
    expect(resolveItemBackingScope({ ...base, itemType: 'eventhouse' }))
      .toEqual({ scopeType: 'kql-database', scopeRef: 'My DB' });
  });
  it('unknown type → pending (honest gate)', () => {
    const r = resolveItemBackingScope({ ...base, itemType: 'report' });
    expect('pending' in r).toBe(true);
  });
});

describe('checkLabelChangeRights — F20', () => {
  beforeEach(() => { getRightsMock.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('allows changing an unprotected label without a Graph call', async () => {
    const r = await checkLabelChangeRights('lbl-1', lbl({ hasProtection: false }), 'a@contoso.com');
    expect(r.allowed).toBe(true);
    expect(getRightsMock).not.toHaveBeenCalled();
  });

  it('blocks (with admin hint) when rights are unavailable (null = Gov cloud)', async () => {
    getRightsMock.mockResolvedValue(null);
    const r = await checkLabelChangeRights('lbl-1', lbl({ hasProtection: true }), 'a@contoso.com');
    expect(r.allowed).toBe(false);
    expect(r.hint).toMatch(/Purview/i);
  });

  it('blocks when the caller has neither EXPORT nor EDIT', async () => {
    getRightsMock.mockResolvedValue({ allowView: true, allowEdit: false, allowExport: false, allowCopy: false, allowPrint: false });
    const r = await checkLabelChangeRights('lbl-1', lbl({ hasProtection: true }), 'a@contoso.com');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/EXPORT or EDIT/i);
  });

  it('allows when the caller holds EXPORT (or EDIT)', async () => {
    getRightsMock.mockResolvedValue({ allowView: true, allowEdit: false, allowExport: true, allowCopy: false, allowPrint: false });
    expect((await checkLabelChangeRights('lbl-1', lbl({ hasProtection: true }), 'a@contoso.com')).allowed).toBe(true);
    getRightsMock.mockResolvedValue({ allowView: true, allowEdit: true, allowExport: false, allowCopy: false, allowPrint: false });
    expect((await checkLabelChangeRights('lbl-1', lbl({ hasProtection: true }), 'a@contoso.com')).allowed).toBe(true);
  });
});

describe('enforceLabelRbac — F21', () => {
  beforeEach(() => { enforceMock.mockReset(); });

  it('maps a Confidential (sensitivity 3) label to a read grant and returns the grant', async () => {
    enforceMock.mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Reader', roleAssignmentId: '/arm/id' });
    const res = await enforceLabelRbac({
      label: lbl({ sensitivity: 3 }),
      principalId: 'pid', principalType: 'User',
      scopeType: 'adls-container', scopeRef: 'bronze',
    });
    expect(enforceMock).toHaveBeenCalledWith(expect.objectContaining({ permission: 'read', scopeRef: 'bronze' }));
    expect(res.grant?.assignmentId).toBe('/arm/id');
    expect(res.grant?.permission).toBe('read');
  });

  it('maps a low-sensitivity label to a write grant', async () => {
    enforceMock.mockResolvedValue({ status: 'active', roleName: 'Storage Blob Data Contributor' });
    await enforceLabelRbac({
      label: lbl({ sensitivity: 1 }),
      principalId: 'pid', principalType: 'Group',
      scopeType: 'adls-container', scopeRef: 'bronze',
    });
    expect(enforceMock).toHaveBeenCalledWith(expect.objectContaining({ permission: 'write' }));
  });

  it('propagates a non-active result without a grant (honest error/pending)', async () => {
    enforceMock.mockResolvedValue({ status: 'error', detail: 'arm 403' });
    const res = await enforceLabelRbac({
      label: lbl({ sensitivity: 3 }),
      principalId: 'pid', principalType: 'User',
      scopeType: 'adls-container', scopeRef: 'bronze',
    });
    expect(res.status).toBe('error');
    expect(res.grant).toBeUndefined();
  });
});
