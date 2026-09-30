/**
 * POST /api/items/notebook/[id]/run on the Databricks path: an attached
 * lakehouse the storage resolver declines to open (`root-shared`) must reach
 * the submitted code with its reason, rather than vanishing from
 * `loom_lakehouses` with nothing said.
 *
 * The reason text is lifted from the real `lakehouseStorageWithheldMessage`
 * (importOriginal), so the assertion cannot drift from the source.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'u1', upn: 'u1@x' } })),
  tenantScopeId: vi.fn(() => 't1'),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));
vi.mock('@/lib/azure/capacity-guardrails', () => ({ enforceAdmissionControl: vi.fn(async () => null) }));
vi.mock('@/lib/azure/cost-attribution', () => ({ recordCostAttribution: vi.fn(async () => undefined) }));

const NOTEBOOK = {
  id: 'nb1',
  itemType: 'notebook',
  displayName: 'nb',
  workspaceId: 'ws1',
  state: {
    code: 'print(1)',
    attachedSources: [
      { kind: 'lakehouse', id: 'lh-shared', displayName: 'Sales' },
      { kind: 'lakehouse', id: 'lh-ok', displayName: 'Ok' },
    ],
  },
};
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: NOTEBOOK }) }),
  })),
}));

const resolveMock = vi.fn();
vi.mock('@/lib/azure/lakehouse-abfss', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/azure/lakehouse-abfss')>();
  return { ...real, resolveLakehouseStorage: (...a: unknown[]) => resolveMock(...a) };
});

const runOneTimeNotebook = vi.fn();
vi.mock('@/lib/azure/databricks-client', () => ({
  runOneTimeNotebook: (...a: unknown[]) => runOneTimeNotebook(...a),
}));

import { POST } from '../[id]/run/route';
import { lakehouseStorageWithheldMessage } from '@/lib/azure/lakehouse-abfss';

function req() {
  return {
    nextUrl: new URL('http://x/api/items/notebook/nb1/run?workspaceId=ws1'),
    json: async () => ({ compute: 'databricks:c-1' }),
  } as any;
}
const ctx = { params: Promise.resolve({ id: 'nb1' }) } as any;

beforeEach(() => {
  vi.clearAllMocks();
  runOneTimeNotebook.mockResolvedValue({ run_id: 7, run_page_url: 'https://dbx/run/7' });
  resolveMock.mockImplementation(async (id: string) => (id === 'lh-shared'
    ? { ok: false, reason: 'root-shared' }
    : { ok: true, bound: { abfss: 'abfss://landing@acct.dfs.core.windows.net/lakehouses/Ok--lh-ok' } }));
});

describe('notebook run, Databricks path, withheld lakehouse', () => {
  it('puts the root-shared reason into the submitted code and still mounts the other lakehouse', async () => {
    const reason = lakehouseStorageWithheldMessage('root-shared');
    // Fixture check: the reason must exist, or the assertions below are vacuous.
    expect(reason).toBeTruthy();

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(runOneTimeNotebook).toHaveBeenCalledTimes(1);
    const code: string = runOneTimeNotebook.mock.calls[0][0].code;

    // BREAKS IF the route's resolve callback maps a not-ok result to null (the
    // previous behaviour): no `_withheld` entry and no printed reason.
    expect(code).toContain('Lakehouse Sales was not mounted: ');
    // The whole reason, as a Python single-quoted literal (the builder escapes
    // backslashes and quotes; the real message contains an apostrophe).
    const pyEscaped = String(reason).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    expect(code).toContain(`'Sales': '${pyEscaped}',`);
    expect(code).toContain(`was not mounted: ${pyEscaped}')`);
    expect(code).toContain('_LoomLakehouses');
    // BREAKS IF a withheld result drops its siblings: the good mount is gone.
    expect(code).toContain("'Ok': 'abfss://landing@acct.dfs.core.windows.net/lakehouses/Ok--lh-ok',");
    // The user's code still runs after the preamble.
    expect(code.trimEnd().endsWith('print(1)')).toBe(true);
  });

  it('says nothing extra for a reason with no user message (not-found)', async () => {
    resolveMock.mockImplementation(async (id: string) => (id === 'lh-shared'
      ? { ok: false, reason: 'not-found' }
      : { ok: true, bound: { abfss: 'abfss://landing@acct.dfs.core.windows.net/lakehouses/Ok--lh-ok' } }));
    // Fixture check: not-found has no user message, so it is skipped as before.
    expect(lakehouseStorageWithheldMessage('not-found')).toBeNull();

    await POST(req(), ctx);
    const code: string = runOneTimeNotebook.mock.calls[0][0].code;
    // BREAKS IF every not-ok reason is turned into a withheld entry.
    expect(code).not.toContain('was not mounted');
    expect(code).toContain('loom_lakehouses = {');
    expect(code).toContain("'Ok': 'abfss://landing@acct.dfs.core.windows.net/lakehouses/Ok--lh-ok',");
  });
});
