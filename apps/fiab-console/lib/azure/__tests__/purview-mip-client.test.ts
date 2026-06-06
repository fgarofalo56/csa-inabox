/**
 * Vitest specs for purview-mip-client.getLabelForAdlsPath. Stubs the Purview
 * Atlas lookup + Graph label list so we exercise the qualifiedName composition,
 * label extraction (attribute + classification shapes), GUID resolution via
 * Graph, and the non-throwing miss paths — without hitting real Purview.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Mock the two backends the client composes.
const getEntityByQualifiedName = vi.fn();
const listSensitivityLabels = vi.fn();

vi.mock('../purview-client', () => ({
  isPurviewConfigured: () => !!process.env.LOOM_PURVIEW_ACCOUNT,
  getEntityByQualifiedName: (...a: any[]) => getEntityByQualifiedName(...a),
}));
vi.mock('../mip-graph-client', () => ({
  listSensitivityLabels: (...a: any[]) => listSensitivityLabels(...a),
}));

import { getLabelForAdlsPath, adlsQualifiedName } from '../purview-mip-client';

describe('adlsQualifiedName', () => {
  it('builds the canonical DFS qualifiedName', () => {
    expect(adlsQualifiedName('acct', 'bronze', 'sales/2026/q2.parquet')).toBe(
      'https://acct.dfs.core.windows.net/bronze/sales/2026/q2.parquet',
    );
    // leading slashes on the path are trimmed
    expect(adlsQualifiedName('acct', 'bronze', '/a/b.txt')).toBe(
      'https://acct.dfs.core.windows.net/bronze/a/b.txt',
    );
  });
});

describe('getLabelForAdlsPath', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    getEntityByQualifiedName.mockReset();
    listSensitivityLabels.mockReset();
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-csa-loom-eastus2';
    process.env.LOOM_MSAL_TENANT_ID = 'tenant-123';
    delete process.env.LOOM_MIP_ENABLED;
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('returns null when Purview is not configured', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.docx');
    expect(r).toBeNull();
    expect(getEntityByQualifiedName).not.toHaveBeenCalled();
  });

  it('reads a label id + name straight off the entity attributes', async () => {
    getEntityByQualifiedName.mockResolvedValueOnce({
      entity: { attributes: { sensitivityLabelId: GUID, sensitivityLabel: 'Confidential' } },
    });
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.docx');
    expect(r).not.toBeNull();
    expect(r!.labelId).toBe(GUID);
    expect(r!.labelName).toBe('Confidential');
    expect(r!.siteId).toBe('tenant-123');
    // qualifiedName passed to the lookup is canonical
    expect(getEntityByQualifiedName).toHaveBeenCalledWith(
      'azure_datalake_gen2_path',
      'https://acct.dfs.core.windows.net/bronze/a.docx',
    );
  });

  it('extracts the GUID from a label classification typeName', async () => {
    getEntityByQualifiedName.mockResolvedValueOnce({
      entity: { classifications: [{ typeName: `MICROSOFT.GOVERNANCE.LABELS.${GUID}` }] },
    });
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.pdf');
    expect(r!.labelId).toBe(GUID);
  });

  it('resolves a name-only label to its GUID via Graph when MIP is enabled', async () => {
    process.env.LOOM_MIP_ENABLED = 'true';
    getEntityByQualifiedName.mockResolvedValueOnce({
      entity: { attributes: { sensitivityLabel: 'Confidential' } },
    });
    listSensitivityLabels.mockResolvedValueOnce([
      { id: GUID, displayName: 'Confidential', name: 'Confidential' },
      { id: 'other', displayName: 'Public' },
    ]);
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.docx');
    expect(r!.labelId).toBe(GUID);
    expect(listSensitivityLabels).toHaveBeenCalled();
  });

  it('returns null when no usable GUID can be resolved (name only, MIP disabled)', async () => {
    getEntityByQualifiedName.mockResolvedValueOnce({
      entity: { attributes: { sensitivityLabel: 'Confidential' } },
    });
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.docx');
    expect(r).toBeNull();
    expect(listSensitivityLabels).not.toHaveBeenCalled();
  });

  it('returns null when the asset is not in the catalog (both type lookups miss)', async () => {
    getEntityByQualifiedName.mockResolvedValue(null);
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.docx');
    expect(r).toBeNull();
    // tried both ADLS entity types
    expect(getEntityByQualifiedName).toHaveBeenCalledTimes(2);
  });

  it('never throws when the Purview lookup errors', async () => {
    getEntityByQualifiedName.mockRejectedValue(new Error('403 role missing'));
    const r = await getLabelForAdlsPath('acct', 'bronze', 'a.docx');
    expect(r).toBeNull();
  });
});
