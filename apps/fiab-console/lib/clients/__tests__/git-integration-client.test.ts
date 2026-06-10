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
  githubApiBase,
  isGitHubEnterprise,
  githubWebBase,
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

describe('githubApiBase (GitHub Enterprise / ghe.com host)', () => {
  const savedHost = process.env.LOOM_GITHUB_HOST;
  afterEach(() => {
    if (savedHost === undefined) delete process.env.LOOM_GITHUB_HOST;
    else process.env.LOOM_GITHUB_HOST = savedHost;
  });

  it('defaults to public api.github.com when no host', () => {
    delete process.env.LOOM_GITHUB_HOST;
    expect(githubApiBase()).toBe('https://api.github.com');
    expect(githubApiBase('')).toBe('https://api.github.com');
    expect(githubApiBase('github.com')).toBe('https://api.github.com');
    expect(githubApiBase('api.github.com')).toBe('https://api.github.com');
  });

  it('maps a ghe.com data-residency tenant to api.<sub>.ghe.com', () => {
    expect(githubApiBase('octocorp.ghe.com')).toBe('https://api.octocorp.ghe.com');
    expect(githubApiBase('https://octocorp.ghe.com')).toBe('https://api.octocorp.ghe.com');
    expect(githubApiBase('OCTOCORP.GHE.COM')).toBe('https://api.OCTOCORP.GHE.COM');
  });

  it('is idempotent for an already-correct api host', () => {
    expect(githubApiBase('api.octocorp.ghe.com')).toBe('https://api.octocorp.ghe.com');
  });

  it('maps a self-hosted GitHub Enterprise Server host to /api/v3', () => {
    expect(githubApiBase('github.contoso.com')).toBe('https://github.contoso.com/api/v3');
  });

  it('strips path/query and trailing slashes', () => {
    expect(githubApiBase('https://octocorp.ghe.com/some/path?x=1')).toBe('https://api.octocorp.ghe.com');
  });

  it('falls back to LOOM_GITHUB_HOST when no per-call host', () => {
    process.env.LOOM_GITHUB_HOST = 'octocorp.ghe.com';
    expect(githubApiBase()).toBe('https://api.octocorp.ghe.com');
    // explicit per-call host overrides the env default
    expect(githubApiBase('other.ghe.com')).toBe('https://api.other.ghe.com');
  });

  it('isGitHubEnterprise reflects whether the host is non-public', () => {
    delete process.env.LOOM_GITHUB_HOST;
    expect(isGitHubEnterprise()).toBe(false);
    expect(isGitHubEnterprise('github.com')).toBe(false);
    expect(isGitHubEnterprise('octocorp.ghe.com')).toBe(true);
    expect(isGitHubEnterprise('github.contoso.com')).toBe(true);
  });

  it('githubWebBase builds the browser host', () => {
    delete process.env.LOOM_GITHUB_HOST;
    expect(githubWebBase()).toBe('https://github.com');
    expect(githubWebBase('octocorp.ghe.com')).toBe('https://octocorp.ghe.com');
    expect(githubWebBase('api.octocorp.ghe.com')).toBe('https://octocorp.ghe.com');
    expect(githubWebBase('github.contoso.com')).toBe('https://github.contoso.com');
  });
});

describe('constants', () => {
  it('ADO zero object id is 40 zeros', () => {
    expect(ADO_ZERO_OBJECT_ID).toBe('0'.repeat(40));
  });
});
