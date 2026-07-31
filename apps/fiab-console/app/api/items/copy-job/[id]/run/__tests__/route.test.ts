/**
 * Second-order SQL-injection regression tests for
 * POST /api/items/copy-job/[id]/run.
 *
 * WHY THESE ARE ROUTE-LEVEL AND NOT BUILDER-LEVEL:
 *   The builders in lib/azure/copy-job-sql.ts have their own suite. What the
 *   review round 2 flagged is a claim about the ROUTE — "the request body no
 *   longer steers the pipeline, it is rebuilt from the AUTHORISED record" was
 *   offered as the safety property. It is not one: `PUT /api/items/copy-job/[id]`
 *   stores `state` verbatim, so `item.state` is 100% caller-authored and the trip
 *   through Cosmos is exactly what makes this second-order. These tests therefore
 *   feed a HOSTILE PERSISTED `item.state` — the shape an attacker actually has —
 *   and assert the route refuses to ship a pipeline at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/adf-client', () => ({
  runPipeline: vi.fn(async () => ({ runId: 'r1' })),
  upsertPipeline: vi.fn(async () => {}),
  upsertLinkedService: vi.fn(async () => {}),
  upsertDataset: vi.fn(async () => {}),
  // REQUIRED, not incidental. The route's SECOND-order defence resolves what a
  // linked service actually POINTS AT (assertUserLinkedServiceTarget), because
  // the name check alone is bypassed by creating an innocuously-named service
  // whose connection string targets the shared control DB. That resolver takes
  // `getLinkedService` and FAILS CLOSED when it throws.
  //
  // Omitting it here did not merely skip a check — vitest threw "No
  // getLinkedService export is defined on the mock", the route caught a PLAIN
  // Error (not CopyJobSqlError) and returned 502, and every downstream test
  // "passed" its `expect(upsertPipeline).not.toHaveBeenCalled()` assertion
  // VACUOUSLY: nothing shipped because the route died early, not because the
  // validation under test rejected anything. Default it to a benign target so
  // each test exercises the rule it names.
  getLinkedService: vi.fn(async (name: string) => ({
    name,
    properties: { typeProperties: { connectionString: 'Server=tcp:sql-contoso.database.windows.net,1433;Database=app' } },
  })),
}));
vi.mock('@/lib/azure/azure-sql-client', () => ({ executeQuery: vi.fn(async () => ({ rows: [] })) }));
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'oid-1' } })),
}));

const loadOwnedItem = vi.fn();
vi.mock('../../../../_lib/item-crud', async () => {
  const respond = await vi.importActual<any>('@/lib/api/respond');
  return {
    loadOwnedItem: (...a: any[]) => loadOwnedItem(...a),
    jerr: (error: string, status = 500) => respond.apiError(error, status),
  };
});

import { POST } from '../route';
import { runPipeline, upsertPipeline, upsertDataset, getLinkedService } from '@/lib/azure/adf-client';

const ctx = { params: Promise.resolve({ id: 'cj-1' }) } as any;
const req = {} as any;

/** A legitimate, fully-configured Full-mode spec. */
const goodSpec = () => ({
  source: { linkedService: 'ls-contoso-sql', type: 'AzureSqlSource', sourceTable: 'dbo.orders' },
  sink: { linkedService: 'ls-lake', type: 'AzureSqlSink', table: 'dbo.orders_copy' },
  mode: 'Full',
  writeMode: 'Append',
});

const persist = (state: any) => {
  loadOwnedItem.mockResolvedValue({ id: 'cj-1', workspaceId: 'ws-1', itemType: 'copy-job', state });
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER = 'sql-loom-control';
  // `clearAllMocks` resets CALLS but NOT implementations, so a
  // `mockRejectedValue` / `mockImplementation` set by one test would leak into
  // every test after it — the fail-closed case below would silently turn the
  // later hostile-state cases into 400s for the wrong reason. Re-establish the
  // benign default here so each test starts from the same known target.
  (getLinkedService as any).mockImplementation(async (name: string) => ({
    name,
    properties: { typeProperties: { connectionString: 'Server=tcp:sql-contoso.database.windows.net,1433;Database=app' } },
  }));
});

describe('copy-job run — the control linked service is reserved', () => {
  it('refuses a persisted spec whose SOURCE is the shared control DB', async () => {
    // `source.query` is a documented free-form feature shipped verbatim as
    // sqlReaderQuery, so a control-DB source runs caller-authored T-SQL against
    // every tenant's watermark checkpoints as the factory MI.
    persist({
      ...goodSpec(),
      source: {
        linkedService: 'loom-copy-control-sql',
        type: 'AzureSqlSource',
        sourceTable: 'dbo.copy_watermark',
        query: 'DROP TABLE dbo.copy_watermark',
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/reserved/i);
    // Nothing was shipped to ARM.
    expect(upsertDataset).not.toHaveBeenCalled();
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('refuses a persisted spec whose SINK is the shared control DB', async () => {
    // Overwrite → preCopyScript `TRUNCATE TABLE [dbo].[copy_watermark]`. The
    // identifier is valid, so identifier validation alone cannot stop this.
    persist({
      ...goodSpec(),
      sink: { linkedService: 'LOOM-COPY-CONTROL-SQL', type: 'AzureSqlSink', table: 'dbo.copy_watermark' },
      writeMode: 'Overwrite',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('still runs a legitimate Full-mode copy job unchanged', async () => {
    persist(goodSpec());
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(runPipeline).toHaveBeenCalledWith('loom-copy-cj-1');
    const pipeline = (upsertPipeline as any).mock.calls[0][1];
    const copy = pipeline.properties.activities[0];
    expect(copy.typeProperties.source.sqlReaderQuery).toBe('SELECT * FROM [dbo].[orders]');
  });
});

/**
 * The NAME reservation above is only the cheap first pass — it keys on the ADF
 * artifact name, so a caller who can create linked services just names theirs
 * something innocuous and points its connection string at the shared control
 * database. That is the actual second-order attack, and `route.ts` defends it
 * with `assertUserLinkedServiceTarget`, which resolves the DEFINITION.
 *
 * That resolver had NO direct coverage: every existing case here is stopped by
 * the name check first, so the target check was never the thing under test.
 */
describe('copy-job run — the control DB is refused by TARGET, not just by name', () => {
  it('refuses an innocuously-NAMED linked service whose connection string points at the control server', async () => {
    (getLinkedService as any).mockImplementation(async (name: string) => ({
      name,
      properties: {
        typeProperties: {
          // Passes the name check ('ls-my-own-data'), targets the control DB.
          connectionString: 'Server=tcp:sql-loom-control.database.windows.net,1433;Database=loomctl',
        },
      },
    }));
    persist({
      ...goodSpec(),
      source: { linkedService: 'ls-my-own-data', type: 'AzureSqlSource', sourceTable: 'dbo.copy_watermark' },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/control server/i);
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED with a 400 when the linked-service definition cannot be read', async () => {
    // Unreadable definition => cannot prove the target is safe => refuse. A 502
    // here would be wrong twice: it blames the upstream for a request we chose
    // to reject, and it reads as transient so a client would retry it.
    (getLinkedService as any).mockRejectedValue(new Error('ARM 403'));
    persist(goodSpec());
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/could not read the linked service/i);
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('does NOT consult the resolver when no control server is configured', async () => {
    // With no shared control DB there is nothing to protect, and the route must
    // not pay an ARM read (or fail closed) on every run.
    delete process.env.LOOM_COPYJOB_CONTROL_SQL_SERVER;
    persist(goodSpec());
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(getLinkedService).not.toHaveBeenCalled();
  });
});

describe('copy-job run — hostile PERSISTED state still cannot ship SQL', () => {
  it('rejects a quote-breakout control-table key (sourceName) with a 400, not a pipeline', async () => {
    persist({
      ...goodSpec(),
      mode: 'Incremental',
      watermarkCol: 'modified_at',
      sourceName: "x'; DROP TABLE dbo.copy_watermark; --",
    });
    const res = await POST(req, ctx);
    // The literal IS escapable, so this one is allowed through — but it must be
    // escaped, never emitted raw.
    expect(res.status).toBe(200);
    const pipeline = (upsertPipeline as any).mock.calls[0][1];
    const lookup = pipeline.properties.activities[0].typeProperties.scripts[0].text;
    expect(lookup).toContain("N'x''; DROP TABLE dbo.copy_watermark; --'");
    expect(lookup.replace(/N'(?:[^']|'')*'/g, '')).not.toContain(';');
  });

  it('rejects an unquotable watermark column with a 400 and ships nothing', async () => {
    persist({
      ...goodSpec(),
      mode: 'Incremental',
      watermarkCol: 'id]) AS x FROM sys.sql_logins --',
      sourceName: 'orders',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('rejects a merge-key breakout with a 400', async () => {
    persist({ ...goodSpec(), writeMode: 'Merge', mergeKeys: 'id, x] ON 1=1 --' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(upsertPipeline).not.toHaveBeenCalled();
  });

  it('rejects a bracket-breakout destination table before any dataset is created', async () => {
    persist({
      ...goodSpec(),
      sink: { linkedService: 'ls-lake', type: 'AzureSqlSink', table: 'orders] ; DROP TABLE dbo.customers --' },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });
});
