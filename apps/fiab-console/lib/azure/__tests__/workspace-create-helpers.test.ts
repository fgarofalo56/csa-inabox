import { describe, it, expect, vi } from 'vitest';

// The junctioned pnpm store in CI/worktrees can't always resolve the Azure SDK's
// transitive deps at collect time, so we stub the Azure-laden modules these
// helpers' source files import. The helpers under test are pure string logic;
// the stubs just keep the module graph from loading @azure/identity / @azure/cosmos.
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class { getToken() { return Promise.resolve({ token: 'x' }); } },
  DefaultAzureCredential: class { getToken() { return Promise.resolve({ token: 'x' }); } },
  ManagedIdentityCredential: class { getToken() { return Promise.resolve({ token: 'x' }); } },
}));
vi.mock('../fabric-client', () => ({
  assignWorkspaceToCapacity: vi.fn(),
  FabricError: class extends Error {},
}));
vi.mock('../purview-client', () => ({
  registerAtlasEntity: vi.fn(),
  PurviewError: class extends Error {},
  PurviewNotConfiguredError: class extends Error {},
}));
vi.mock('../cosmos-client', () => ({
  marketplaceListingsContainer: vi.fn(),
}));

import { backingRgName } from '../workspace-bindings';
import { mailNicknameFor } from '../m365-groups';

describe('backingRgName', () => {
  it('uses the default prefix + first 8 hex of the workspace id', () => {
    const id = '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809';
    expect(backingRgName({ id })).toBe('rg-loom-ws-1a2b3c4d');
  });

  it('honors LOOM_WORKSPACE_RG_PREFIX when set', () => {
    const prev = process.env.LOOM_WORKSPACE_RG_PREFIX;
    process.env.LOOM_WORKSPACE_RG_PREFIX = 'rg-fin-ws-';
    try {
      expect(backingRgName({ id: 'abcdef01-2222-3333-4444-555566667777' })).toBe('rg-fin-ws-abcdef01');
    } finally {
      if (prev === undefined) delete process.env.LOOM_WORKSPACE_RG_PREFIX;
      else process.env.LOOM_WORKSPACE_RG_PREFIX = prev;
    }
  });
});

describe('mailNicknameFor', () => {
  it('slugifies a workspace name into a Graph-safe mailNickname', () => {
    expect(mailNicknameFor('Finance Analytics')).toBe('finance-analytics');
    expect(mailNicknameFor('  Mission Ops!! ')).toBe('mission-ops');
    expect(mailNicknameFor('A/B & C')).toBe('a-b-c');
  });

  it('falls back to a generated nickname for symbol-only input', () => {
    // '' uses the literal 'loom-workspace' fallback name (a valid slug);
    // a symbol-only name slugs to empty and gets the random loom-ws-* fallback.
    expect(mailNicknameFor('')).toBe('loom-workspace');
    expect(mailNicknameFor('!!!')).toMatch(/^loom-ws-[a-z0-9]+$/);
  });

  it('caps the nickname length', () => {
    const long = 'x'.repeat(120);
    expect(mailNicknameFor(long).length).toBeLessThanOrEqual(56);
  });
});
