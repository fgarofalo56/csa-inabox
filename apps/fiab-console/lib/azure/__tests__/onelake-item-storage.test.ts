/**
 * Unit tests for onelake-item-storage — the pure item → ADLS-location resolver
 * behind the OneLake item-size report. No network; exercises the resolution
 * precedence + the convention fall-back candidates.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveItemAdlsLocation,
  conventionCandidates,
  safeAdlsSegment,
  type StorageItemLike,
} from '../onelake-item-storage';

function lakehouse(state?: Record<string, unknown>): StorageItemLike {
  return { id: 'lh-1', itemType: 'lakehouse', displayName: 'Sales Lake', workspaceId: 'ws-1', state };
}

describe('safeAdlsSegment', () => {
  it('strips traversal + collapses separators like the provisioner', () => {
    expect(safeAdlsSegment('Sales Lake')).toBe('Sales Lake');
    expect(safeAdlsSegment('../../etc/passwd')).toBe('etc/passwd');
    expect(safeAdlsSegment('a/./b//c')).toBe('a/b/c');
  });
});

describe('resolveItemAdlsLocation — backend classification', () => {
  it('marks warehouse as synapse (compute-billed, not ADLS)', () => {
    const r = resolveItemAdlsLocation({ id: 'w', itemType: 'warehouse', displayName: 'DW', workspaceId: 'ws-1' });
    expect(r.backend).toBe('synapse');
    expect(r.container).toBeUndefined();
  });
  it('marks kql-database / eventhouse as adx', () => {
    expect(resolveItemAdlsLocation({ id: 'k', itemType: 'kql-database', displayName: 'K', workspaceId: 'ws' }).backend).toBe('adx');
    expect(resolveItemAdlsLocation({ id: 'e', itemType: 'eventhouse', displayName: 'E', workspaceId: 'ws' }).backend).toBe('adx');
  });
  it('marks lakehouse + mirrored-database as adls', () => {
    expect(resolveItemAdlsLocation(lakehouse()).backend).toBe('adls');
    expect(resolveItemAdlsLocation({ id: 'm', itemType: 'mirrored-database', displayName: 'M', workspaceId: 'ws' }).backend).toBe('adls');
  });
});

describe('resolveItemAdlsLocation — precedence', () => {
  it('1. prefers stamped secondaryIds.container + rootPath', () => {
    const r = resolveItemAdlsLocation(
      lakehouse({ provisioning: { secondaryIds: { container: 'bronze', rootPath: 'lakehouses/sales' } } }),
    );
    expect(r).toMatchObject({ backend: 'adls', container: 'bronze', prefix: 'lakehouses/sales', source: 'provisioning' });
  });

  it('2. parses resourceId = "<container>/<root>" when secondaryIds absent', () => {
    const r = resolveItemAdlsLocation(lakehouse({ provisioning: { resourceId: 'landing/lakehouses/sales' } }));
    expect(r).toMatchObject({ backend: 'adls', container: 'landing', prefix: 'lakehouses/sales', source: 'provisioning' });
  });

  it('3. parses abfss adlsRoot', () => {
    const r = resolveItemAdlsLocation(
      lakehouse({ provisioning: { secondaryIds: { adlsRoot: 'abfss://bronze@acct.dfs.core.windows.net/mirrors/ws-1/m-1' } } }),
    );
    expect(r).toMatchObject({ backend: 'adls', container: 'bronze', prefix: 'mirrors/ws-1/m-1', source: 'provisioning' });
  });

  it('4. falls back to convention when no provisioning record', () => {
    const r = resolveItemAdlsLocation(lakehouse());
    expect(r).toMatchObject({ backend: 'adls', source: 'convention' });
    expect(r.container).toBeUndefined();
  });
});

describe('conventionCandidates', () => {
  it('lakehouse probes lakehouses/<safeName> across containers (landing first)', () => {
    const c = conventionCandidates(lakehouse());
    expect(c[0]).toEqual({ container: 'landing', prefix: 'lakehouses/Sales Lake' });
    expect(c[1]).toEqual({ container: 'bronze', prefix: 'lakehouses/Sales Lake' });
    expect(c.length).toBeGreaterThan(2);
  });
  it('mirror probes bronze/mirrors/<ws>/<id>', () => {
    const c = conventionCandidates({ id: 'm-1', itemType: 'mirrored-database', displayName: 'M', workspaceId: 'ws-9' });
    expect(c).toEqual([{ container: 'bronze', prefix: 'mirrors/ws-9/m-1' }]);
  });
  it('non-ADLS types yield no candidates', () => {
    expect(conventionCandidates({ id: 'w', itemType: 'warehouse', displayName: 'W', workspaceId: 'ws' })).toEqual([]);
  });
});
