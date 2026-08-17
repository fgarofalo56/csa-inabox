/**
 * BFF gate + contract tests for the SQL-editor-parity cancel routes:
 *   - POST /api/items/databricks-sql-warehouse/[id]/cancel
 *   - POST /api/items/synapse-dedicated-sql-pool/[id]/cancel
 *   - POST /api/items/synapse-serverless-sql-pool/[id]/cancel
 *   - POST /api/items/warehouse/[id]/cancel
 *
 * Asserts the auth gate (401), input validation (400), the Databricks
 * config-gate (503), and that the happy path delegates to the real
 * cancel helpers (databricks-client.cancelStatement / cancelByClientId,
 * synapse-sql-client.cancelActiveQuery) with the right args. Also unit-tests
 * the run-selection helper getRunSql. The clients are stubbed; their own REST
 * contracts are covered elsewhere.
 *
 * UPDATED for GHSA-v2g8-gp3r-rg4r, eighth pass. `databricks-sql-warehouse/[id]/
 * cancel` took NO `ctx`, so `[id]` was never read, and `getSession()` was its
 * entire authorization while `statementId` came off the body — it could ABORT A
 * RUNNING QUERY belonging to any tenant. It now runs `withSession` +
 * `guardSynapseItemRequest` (write-scoped), i.e. it takes an AUTHORIZED ITEM
 * rather than an id, so this file supplies it a route `ctx` and stubs the
 * workspace ladder + Cosmos to ADMIT.
 *
 * THE CTX WAS ADDED TO MATCH THE ROUTE, NOT TO KEEP THIS FILE GREEN. Stated
 * because the inverse is the failure mode here: a test edited to keep passing
 * against a WEAKENED route is worse than a red test. The route was not loosened
 * — the guard is unconditional and the config gate now sits BELOW it — and the
 * DENIED paths (no session, unowned item, id naming no item, the `id === 'new'`
 * gate, the read/write split) are asserted in
 * `databricks-sql-warehouse/__tests__/ghsa-v2g8-warehouse-reads.test.ts`, which
 * is where the authorization assertions and their mutation receipts live. This
 * file stays the CONTRACT test: which helper is called, with which args.
 *
 * THE OTHER THREE cancel routes are UNCHANGED and still called without a ctx,
 * deliberately: they are not in this pass's set, and quietly passing them a ctx
 * would read as coverage they do not have.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  cancelStatement: vi.fn(),
  cancelByClientId: vi.fn(),
  databricksConfigGate: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({ cancelActiveQuery: vi.fn() }));

// GHSA-v2g8-gp3r-rg4r — the dbx cancel route's Layer 1 reaches the workspace
// ladder and Cosmos. Both are stubbed to ADMIT so this file keeps testing the
// contract; the DENIED paths live in the family's own authorization suite.
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p: any) => p.name === '@id')?.value;
          return {
            resources: id === 'sw-1'
              ? [{ id: 'sw-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', state: {} }]
              : [],
          };
        },
      }),
    },
  }),
}));

import { POST as dbxCancel } from '../databricks-sql-warehouse/[id]/cancel/route';
import { POST as dedicatedCancel } from '../synapse-dedicated-sql-pool/[id]/cancel/route';
import { POST as serverlessCancel } from '../synapse-serverless-sql-pool/[id]/cancel/route';
import { POST as warehouseCancel } from '../warehouse/[id]/cancel/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { cancelStatement, cancelByClientId, databricksConfigGate } from '@/lib/azure/databricks-client';
import { cancelActiveQuery } from '@/lib/azure/synapse-sql-client';
// Relative import (not the @ alias) so this resolves to the pure, Fluent-free
// run-selection helper regardless of which checkout the test runner is rooted at.
import { getRunSql } from '../../../../lib/components/editor/sql-run-selection';

function bodyReq(body: any) {
  return { url: 'http://x/', nextUrl: new URL('http://x/'), json: async () => body } as any;
}

/** The route ctx for the OWNED warehouse item the Cosmos stub above resolves.
 *  The dbx cancel route reads `[id]` from here — that is the fix. */
const swCtx = { params: Promise.resolve({ id: 'sw-1' }) } as any;

beforeEach(() => {
  vi.resetAllMocks();
  (databricksConfigGate as any).mockReturnValue(null); // configured by default
  (authorizeItemWorkspace as any).mockResolvedValue(null); // ladder ADMITS
});

describe('POST databricks-sql-warehouse/[id]/cancel', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await dbxCancel(bodyReq({ statementId: 's1' }), swCtx);
    expect(res.status).toBe(401);
  });

  // The gate now sits BELOW Layer 1 (GHSA-v2g8-gp3r-rg4r), so it is only
  // reachable by a caller who OWNS the item — which is the point of moving it.
  // It still fires for that caller, which is what this asserts.
  it('503 when Databricks is not configured', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await dbxCancel(bodyReq({ statementId: 's1' }), swCtx);
    expect(res.status).toBe(503);
  });

  it('400 when neither statementId nor clientQueryId is supplied', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await dbxCancel(bodyReq({}), swCtx);
    expect(res.status).toBe(400);
  });

  it('cancels by statementId', async () => {
    (getSession as any).mockReturnValue({ user: 'u', claims: { upn: 'a@b' } });
    (cancelStatement as any).mockResolvedValue(undefined);
    const res = await dbxCancel(bodyReq({ statementId: 'stmt-42' }), swCtx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.canceled).toBe(true);
    expect(cancelStatement).toHaveBeenCalledWith('stmt-42');
  });

  it('cancels by clientQueryId via the pending-statement registry', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (cancelByClientId as any).mockResolvedValue({ canceled: true, statementId: 'stmt-7' });
    const res = await dbxCancel(bodyReq({ clientQueryId: 'cq-1' }), swCtx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.statementId).toBe('stmt-7');
    expect(cancelByClientId).toHaveBeenCalledWith('cq-1');
  });
});

describe.each([
  ['dedicated', dedicatedCancel],
  ['serverless', serverlessCancel],
  ['warehouse', warehouseCancel],
] as const)('POST %s/[id]/cancel (TDS ATTENTION)', (_name, handler) => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await handler(bodyReq({ queryId: 'q1' }));
    expect(res.status).toBe(401);
  });

  it('400 without queryId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    const res = await handler(bodyReq({}));
    expect(res.status).toBe(400);
  });

  it('delegates to cancelActiveQuery with the queryId', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (cancelActiveQuery as any).mockReturnValue(true);
    const res = await handler(bodyReq({ queryId: 'q-99' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.canceled).toBe(true);
    expect(cancelActiveQuery).toHaveBeenCalledWith('q-99');
  });

  it('reports canceled:false when the request is not in-flight on this replica', async () => {
    (getSession as any).mockReturnValue({ user: 'u' });
    (cancelActiveQuery as any).mockReturnValue(false);
    const res = await handler(bodyReq({ queryId: 'gone' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.canceled).toBe(false);
  });
});

describe('getRunSql — run-selection', () => {
  function fakeEditor(selectionText: string | null, full: string) {
    return {
      current: {
        getSelection: () => (selectionText === null ? null : { isEmpty: () => selectionText.length === 0 }),
        getModel: () => ({ getValueInRange: () => selectionText ?? '' }),
      },
    } as any;
  }

  it('returns only the highlighted selection when one exists', () => {
    expect(getRunSql(fakeEditor('SELECT 2', 'SELECT 1; SELECT 2;'), 'SELECT 1; SELECT 2;')).toBe('SELECT 2');
  });

  it('falls back to the full text when there is no selection', () => {
    expect(getRunSql(fakeEditor(null, 'SELECT 1;'), 'SELECT 1;')).toBe('SELECT 1;');
  });

  it('falls back to the full text when the selection is empty', () => {
    expect(getRunSql(fakeEditor('', 'SELECT 1;'), 'SELECT 1;')).toBe('SELECT 1;');
  });

  it('is safe when no editor is mounted yet', () => {
    expect(getRunSql({ current: null }, 'SELECT 1;')).toBe('SELECT 1;');
  });
});
