/**
 * EXP1 — workspace-export pure-serializer tests: bundle shape, secret
 * exclusion (values scrubbed, `…Ref` reference names kept), per-estate
 * provisioning exclusion, and the explicit manifest note.
 */
import { describe, it, expect } from 'vitest';
import {
  buildWorkspaceBundle,
  scrubSecrets,
  loomwsFilename,
  LOOMWS_VERSION,
  SECRETS_EXCLUDED_NOTE,
} from '../workspace-export';
import type { Workspace, WorkspaceItem, WorkspaceFolder } from '@/lib/types/workspace';

const ws: Workspace = {
  id: 'ws-1',
  tenantId: 'oid-owner',
  name: 'Analytics',
  description: 'Team workspace',
  capacity: 'F64',
  domain: 'finance',
  licenseMode: 'Org',
  contacts: ['a@contoso.com'],
  createdBy: 'a@contoso.com',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
};

const folders: WorkspaceFolder[] = [
  { id: 'f-root', workspaceId: 'ws-1', name: 'Bronze', parent: null, createdBy: 'a', createdAt: '2026-07-01T00:00:00Z' },
  { id: 'f-child', workspaceId: 'ws-1', name: 'Raw', parent: 'f-root', createdBy: 'a', createdAt: '2026-07-01T00:00:00Z' },
];

const items: WorkspaceItem[] = [
  {
    id: 'it-lake', workspaceId: 'ws-1', itemType: 'lakehouse', displayName: 'Lake',
    folderId: 'f-root',
    state: {
      tables: ['orders'],
      connectionString: 'Server=real;Password=hunter2', // secret VALUE — must be excluded
      keyVaultSecretRef: 'kv-lake-conn',                 // reference NAME — must survive
      provisioning: { resourceId: '/subscriptions/x/…' }, // per-estate — must be excluded
      nested: { apiKey: 'sk-123', safe: 'keep-me' },
    },
    createdBy: 'a', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'it-sql', workspaceId: 'ws-1', itemType: 'warehouse', displayName: 'Lake (SQL endpoint)',
    folderId: null,
    state: { sqlEndpointFor: 'it-lake', autoCreated: true },
    createdBy: 'a', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  },
];

describe('scrubSecrets', () => {
  it('excludes secret-named string values and records their paths', () => {
    const out: string[] = [];
    const scrubbed = scrubSecrets(
      { password: 'p', list: [{ accessToken: 't', ok: 1 }], plain: 'x' },
      'items/i/state',
      out,
    ) as Record<string, unknown>;
    expect(scrubbed).toEqual({ list: [{ ok: 1 }], plain: 'x' });
    expect(out).toEqual(['items/i/state.password', 'items/i/state.list.0.accessToken']);
  });

  it('keeps reference-name keys (secretRef / …Ref) verbatim', () => {
    const out: string[] = [];
    const scrubbed = scrubSecrets(
      { secretRef: 'kv-name', clientSecretRef: 'kv-2', clientSecret: 'VALUE' },
      'p',
      out,
    ) as Record<string, unknown>;
    expect(scrubbed).toEqual({ secretRef: 'kv-name', clientSecretRef: 'kv-2' });
    expect(out).toEqual(['p.clientSecret']);
  });
});

describe('buildWorkspaceBundle', () => {
  const bundle = buildWorkspaceBundle(ws, items, folders, [
    { upn: 'b@contoso.com', role: 'contributor', name: 'B' },
  ], { exportedBy: 'a@contoso.com', now: '2026-07-24T00:00:00Z' });

  it('carries the format marker, source, and non-secret workspace config', () => {
    expect(bundle.loomws).toBe(LOOMWS_VERSION);
    expect(bundle.source).toEqual({ workspaceId: 'ws-1', name: 'Analytics' });
    expect(bundle.workspace).toEqual({
      name: 'Analytics', description: 'Team workspace', capacity: 'F64',
      domain: 'finance', licenseMode: 'Org', contacts: ['a@contoso.com'],
    });
    expect(bundle.exportedAt).toBe('2026-07-24T00:00:00Z');
    expect(bundle.exportedBy).toBe('a@contoso.com');
  });

  it('excludes secret values + provisioning, keeps refs, and manifests every exclusion', () => {
    const lake = bundle.items.find((i) => i.id === 'it-lake')!;
    expect(lake.state.connectionString).toBeUndefined();
    expect(lake.state.provisioning).toBeUndefined();
    expect(lake.state.keyVaultSecretRef).toBe('kv-lake-conn');
    expect((lake.state.nested as Record<string, unknown>).apiKey).toBeUndefined();
    expect((lake.state.nested as Record<string, unknown>).safe).toBe('keep-me');
    expect(bundle.manifest.secretsExcluded).toBe(true);
    expect(bundle.manifest.secretsNote).toBe(SECRETS_EXCLUDED_NOTE);
    expect(bundle.manifest.scrubbedPaths).toEqual([
      'items/it-lake/state.connectionString',
      'items/it-lake/state.nested.apiKey',
    ]);
    expect(bundle.manifest.provisioningExcluded).toEqual(['it-lake']);
  });

  it('preserves relationships (folders + cross-item refs) and MIG1 schemaVersion default', () => {
    const lake = bundle.items.find((i) => i.id === 'it-lake')!;
    const sql = bundle.items.find((i) => i.id === 'it-sql')!;
    expect(lake.folderId).toBe('f-root');
    expect(sql.state.sqlEndpointFor).toBe('it-lake');
    expect(lake.schemaVersion).toBe(1);
    expect(bundle.folders).toEqual([
      { id: 'f-root', name: 'Bronze', parent: null },
      { id: 'f-child', name: 'Raw', parent: 'f-root' },
    ]);
    expect(bundle.manifest.itemCount).toBe(2);
    expect(bundle.manifest.folderCount).toBe(2);
  });

  it('exports role grants as an informational manifest', () => {
    expect(bundle.rolesManifest).toEqual([{ upn: 'b@contoso.com', role: 'contributor', name: 'B' }]);
    expect(bundle.manifest.roleCount).toBe(1);
  });
});

describe('loomwsFilename', () => {
  it('encodes the workspace name and appends .loomws', () => {
    expect(loomwsFilename('My Space')).toBe('My%20Space.loomws');
    expect(loomwsFilename('')).toBe('workspace.loomws');
  });
});
