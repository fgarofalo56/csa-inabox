import { describe, it, expect, vi } from 'vitest';

// The module under test imports the workspaces client (which transitively pulls
// @azure/cosmos). The functions we test are pure, so stub the client to keep the
// module graph from loading the Azure SDK at collect time in worktree installs.
vi.mock('@/lib/clients/workspaces-client', () => ({
  loadWorkspaceAdmin: vi.fn(),
}));

import { isPbiWorkspaceId, pickPbiWorkspaceId } from '@/lib/azure/powerbi-workspace-mapping';

const GUID = '11111111-2222-3333-4444-555555555555';
const GUID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const GUID3 = '99999999-8888-7777-6666-555555555555';

describe('isPbiWorkspaceId', () => {
  it('accepts a canonical GUID (trimmed, case-insensitive)', () => {
    expect(isPbiWorkspaceId(GUID)).toBe(true);
    expect(isPbiWorkspaceId(`  ${GUID.toUpperCase()}  `)).toBe(true);
  });
  it('rejects non-GUID strings and non-strings', () => {
    expect(isPbiWorkspaceId('not-a-guid')).toBe(false);
    expect(isPbiWorkspaceId('')).toBe(false);
    expect(isPbiWorkspaceId(GUID.slice(0, -1))).toBe(false);
    expect(isPbiWorkspaceId(undefined)).toBe(false);
    expect(isPbiWorkspaceId(null)).toBe(false);
    expect(isPbiWorkspaceId(12345 as unknown)).toBe(false);
  });
});

describe('pickPbiWorkspaceId — mapping-aware target precedence (WS-PBIMAP)', () => {
  it('per-item binding (explicit) wins over mapping and env default', () => {
    expect(pickPbiWorkspaceId({ explicit: GUID, mapped: GUID2, envDefault: GUID3 })).toBe(GUID);
  });

  it('falls to the Loom→PBI mapping when there is no per-item binding', () => {
    expect(pickPbiWorkspaceId({ explicit: undefined, mapped: GUID2, envDefault: GUID3 })).toBe(GUID2);
    expect(pickPbiWorkspaceId({ explicit: '', mapped: GUID2, envDefault: GUID3 })).toBe(GUID2);
    expect(pickPbiWorkspaceId({ explicit: '   ', mapped: GUID2, envDefault: GUID3 })).toBe(GUID2);
  });

  it('falls to the platform env default only when neither binding nor mapping is set', () => {
    expect(pickPbiWorkspaceId({ mapped: undefined, envDefault: GUID3 })).toBe(GUID3);
    expect(pickPbiWorkspaceId({ explicit: null, mapped: null, envDefault: GUID3 })).toBe(GUID3);
  });

  it('returns undefined when nothing is bound (caller shows an honest gate, never a hard fail)', () => {
    expect(pickPbiWorkspaceId({})).toBeUndefined();
    expect(pickPbiWorkspaceId({ explicit: '', mapped: '  ', envDefault: undefined })).toBeUndefined();
  });

  it('trims the winning value', () => {
    expect(pickPbiWorkspaceId({ mapped: `  ${GUID2}  ` })).toBe(GUID2);
  });
});
