/**
 * Unit tests for the F12 git-integration-client pure functions.
 *
 * Covers the credential-chain-free surface: ADO Basic-auth encoding, the
 * deterministic item serializer + path builders, the workspace manifest, and the
 * GitHub cloud gate across all four sovereign boundaries. No network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  adoBasicAuth,
  serializeItem,
  serializeManifest,
  itemFilePath,
  workspaceManifestPath,
  normalizeFolder,
  githubCloudGate,
  githubAvailable,
  ADO_ZERO_OBJECT_ID,
  type WorkspaceManifest,
} from '../git-integration-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

const ITEM: WorkspaceItem = {
  id: 'item-123',
  workspaceId: 'ws-1',
  itemType: 'lakehouse',
  displayName: 'Sales LH',
  description: 'bronze/silver/gold',
  folderId: 'fold-7',
  state: { warehouseBackend: 'synapse' },
  createdBy: 'alice@contoso.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
};

const ENV_KEYS = ['LOOM_CLOUD', 'AZURE_CLOUD'] as const;
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function setCloud(loom?: string, azure?: string) {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  if (loom === undefined) delete process.env.LOOM_CLOUD; else process.env.LOOM_CLOUD = loom;
  if (azure === undefined) delete process.env.AZURE_CLOUD; else process.env.AZURE_CLOUD = azure;
}

describe('adoBasicAuth', () => {
  it('encodes an empty username + PAT as Basic base64', () => {
    expect(adoBasicAuth('mypat')).toBe('Basic ' + Buffer.from(':mypat').toString('base64'));
  });
  it('handles an empty PAT without throwing', () => {
    expect(adoBasicAuth('')).toBe('Basic ' + Buffer.from(':').toString('base64'));
  });
});

describe('serializeItem', () => {
  it('emits loomVersion + stable keys and round-trips', () => {
    const json = serializeItem(ITEM);
    const parsed = JSON.parse(json);
    expect(parsed.loomVersion).toBe('1');
    expect(parsed.id).toBe('item-123');
    expect(parsed.itemType).toBe('lakehouse');
    expect(parsed.state).toEqual({ warehouseBackend: 'synapse' });
    expect(parsed.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
  it('is deterministic (byte-identical for identical input)', () => {
    expect(serializeItem(ITEM)).toBe(serializeItem(ITEM));
  });
  it('does not leak unknown private fields', () => {
    const withExtra = { ...ITEM, _etag: 'xyz', _rid: 'abc' } as unknown as WorkspaceItem;
    const parsed = JSON.parse(serializeItem(withExtra));
    expect(parsed._etag).toBeUndefined();
    expect(parsed._rid).toBeUndefined();
  });
  it('null-coalesces optional fields', () => {
    const bare: WorkspaceItem = { ...ITEM, description: undefined, folderId: undefined, state: undefined };
    const parsed = JSON.parse(serializeItem(bare));
    expect(parsed.description).toBeNull();
    expect(parsed.folderId).toBeNull();
    expect(parsed.state).toEqual({});
  });
});

describe('normalizeFolder', () => {
  it('strips slashes and defaults when blank', () => {
    expect(normalizeFolder('')).toBe('loom-workspace');
    expect(normalizeFolder('/a/b/')).toBe('a/b');
    expect(normalizeFolder('  finance ')).toBe('finance');
  });
});

describe('itemFilePath / workspaceManifestPath', () => {
  it('builds folder/itemType/id.item.json (no leading slash)', () => {
    expect(itemFilePath('loom/finance', ITEM)).toBe('loom/finance/lakehouse/item-123.item.json');
  });
  it('defaults the folder when blank', () => {
    expect(itemFilePath('', ITEM)).toBe('loom-workspace/lakehouse/item-123.item.json');
  });
  it('sanitizes a hostile itemType', () => {
    const hostile = { ...ITEM, itemType: '../../etc' };
    expect(itemFilePath('f', hostile)).toBe('f/------etc/item-123.item.json');
  });
  it('manifest path ends in .loom/workspace.json', () => {
    expect(workspaceManifestPath('f')).toBe('f/.loom/workspace.json');
  });
});

describe('serializeManifest', () => {
  it('serializes the manifest shape', () => {
    const m: WorkspaceManifest = { loomVersion: '1', id: 'ws-1', name: 'WS', syncedAt: 'now', itemCount: 3 };
    const parsed = JSON.parse(serializeManifest(m));
    expect(parsed.id).toBe('ws-1');
    expect(parsed.itemCount).toBe(3);
  });
});

describe('githubCloudGate', () => {
  it('allows GitHub in Commercial', () => {
    setCloud('Commercial');
    expect(githubCloudGate()).toBeNull();
    expect(githubAvailable()).toBe(true);
  });
  it('allows GitHub in GCC', () => {
    setCloud('GCC');
    expect(githubCloudGate()).toBeNull();
  });
  it('blocks GitHub in GCC-High with an honest 503', () => {
    setCloud('GCC-High');
    const gate = githubCloudGate();
    expect(gate).not.toBeNull();
    expect(gate?.code).toBe('github_not_in_cloud');
    expect(gate?.status).toBe(503);
    expect(githubAvailable()).toBe(false);
  });
  it('blocks GitHub in IL5 (alias of GCC-High)', () => {
    setCloud('IL5');
    expect(githubCloudGate()?.code).toBe('github_not_in_cloud');
  });
  it('blocks GitHub in DoD', () => {
    setCloud('DoD');
    expect(githubCloudGate()?.code).toBe('github_not_in_cloud');
  });
  it('blocks GitHub via legacy AZURE_CLOUD=AzureUSGovernment', () => {
    setCloud(undefined, 'AzureUSGovernment');
    expect(githubAvailable()).toBe(false);
  });
});

describe('constants', () => {
  it('ADO zero object id is 40 zeros', () => {
    expect(ADO_ZERO_OBJECT_ID).toBe('0'.repeat(40));
  });
});
