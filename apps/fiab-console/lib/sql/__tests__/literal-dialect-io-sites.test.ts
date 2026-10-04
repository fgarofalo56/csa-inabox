/**
 * Request-text tests for the switched literal sites that sit behind an outbound
 * call: the statement/query is only observable in the request body. Each test
 * drives the module's real exported function with @azure/identity faked and
 * global fetch stubbed, captures the request, and asserts the literal as the
 * engine receives it.
 *
 *   - adf-client listPipelineRunsFromLA / listActivityRunsFromLA  → KQL (Log Analytics)
 *   - network-discovery bindLoomServices                           → KQL (Resource Graph)
 *   - databricks-client createUcTableFromFile                      → Spark SQL (read_files path)
 *
 * The input carries a quote AND a trailing backslash. Under the backslash rule
 * it becomes `a\'b\\`; under quote doubling it becomes `a''b\`, which the
 * engine reads as an unterminated literal.
 *
 * WHAT BREAKS EACH ONE: reverting that site to escapeSqlLiteral (quote doubled,
 * backslash left single), or a helper that skips the backslash step.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-1234567890.7.azuredatabricks.net';
});

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { listPipelineRunsFromLA, listActivityRunsFromLA } from '@/lib/azure/adf-client';
import { bindLoomServices, type PrivateEndpointInfo } from '@/lib/azure/network-discovery';
import { createUcTableFromFile } from '@/lib/azure/databricks-client';

/** Input: a quote in the middle and a trailing backslash. */
const V = "a'b\\";
/** V under the backslash rule (Spark SQL and KQL regular literals): `a\'b\\`. */
const BACKSLASHED = "a\\'b\\\\";
/** V under quote doubling (the T-SQL rule): `a''b\`. */
const DOUBLED = "a''b\\";

describe('fixture arithmetic', () => {
  it('the two rules differ on V, so each assertion below can tell them apart', () => {
    expect(BACKSLASHED).not.toBe(DOUBLED);
    // Spelled out character by character, independent of any escaping helper.
    expect([...V]).toEqual(['a', "'", 'b', '\\']);
    expect([...BACKSLASHED]).toEqual(['a', '\\', "'", 'b', '\\', '\\']);
    expect([...DOUBLED]).toEqual(['a', "'", "'", 'b', '\\']);
  });
});

type Call = { url: string; body: string };

/** Stub fetch with a fresh JSON 200 per call; record url + body of every call. */
function stubFetch(body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('adf-client Log Analytics fallback (KQL)', () => {
  it('listPipelineRunsFromLA puts the pipeline name in a backslash-escaped KQL literal', async () => {
    const calls = stubFetch({ tables: [] });
    await listPipelineRunsFromLA('ws-guid', V);
    const q = calls.map((c) => (c.body ? JSON.parse(c.body).query : '')).find((s) => s.includes('ADFPipelineRun'));
    expect(q).toContain(`| where PipelineName == '${BACKSLASHED}'`);
    expect(q).not.toContain(`'${DOUBLED}'`);
  });

  it('listActivityRunsFromLA puts the run id in a backslash-escaped KQL literal', async () => {
    const calls = stubFetch({ tables: [] });
    await listActivityRunsFromLA('ws-guid', V);
    const q = calls.map((c) => (c.body ? JSON.parse(c.body).query : '')).find((s) => s.includes('ADFActivityRun'));
    expect(q).toContain(`| where PipelineRunId == '${BACKSLASHED}'`);
  });
});

describe('network-discovery bindLoomServices (Resource Graph KQL)', () => {
  it('each backing resource id is a backslash-escaped KQL literal in the `in~` list', async () => {
    const calls = stubFetch({ data: [], count: 0 });
    const id = `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/${V}`;
    const pe = {
      id: 'pe-1', name: 'pe-1', subscriptionId: 's', groupIds: ['blob'], dns: [],
      connectedResourceId: id, connectedResourceName: 'x',
    } as PrivateEndpointInfo;
    await bindLoomServices([pe]);
    const arg = calls.find((c) => c.url.includes('Microsoft.ResourceGraph/resources'));
    // Breaks if the request is never made (bindLoomServices swallows errors).
    expect(arg).toBeDefined();
    const q = JSON.parse(arg!.body).query as string;
    expect(q).toContain(`| where id in~ ('/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/${BACKSLASHED}')`);
  });
});

describe('databricks-client createUcTableFromFile (Spark SQL)', () => {
  it('the staged volume path is a backslash-escaped Spark SQL literal inside read_files()', async () => {
    const calls = stubFetch({
      statement_id: 'st-1',
      status: { state: 'SUCCEEDED' },
      manifest: { schema: { columns: [] } },
      result: { data_array: [] },
    });
    // The volume name is not identifier-checked (only catalog/schema/table are),
    // so a quote or backslash in it reaches the staged path.
    await createUcTableFromFile({
      catalog_name: 'cat', schema_name: 'sch', table_name: 'tbl',
      volume: `cat.sch.${V}`, file_name: 'f.csv', content: 'a\n1\n', format: 'csv', warehouse_id: 'wh',
    }).catch(() => undefined); // only the request text is under test here
    const stmts = calls
      .filter((c) => c.url.includes('/api/2.0/sql/statements') && c.body)
      .map((c) => JSON.parse(c.body).statement as string);
    const create = stmts.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toBeDefined();
    expect(create).toMatch(new RegExp(`read_files\\('/Volumes/cat/sch/${BACKSLASHED.replace(/\\/g, '\\\\')}/_loom_uploads/\\d+_f\\.csv', format => 'csv'`));
  });
});
