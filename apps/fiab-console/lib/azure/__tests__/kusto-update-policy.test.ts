/**
 * Contract tests for the ADX update-policy control commands.
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT Kusto control command
 * `setTableUpdatePolicy` shapes against /v1/rest/mgmt — the bracket-quoted
 * target table, the `@'...'` verbatim JSON literal, and single-quote escaping
 * of embedded quotes — plus that `showTableUpdatePolicy` parses the `Policy`
 * column back out (the receipt). Nothing is faked beyond stubbing global.fetch +
 * the AAD credential.
 *
 * Grounding:
 *   .alter table policy update — https://learn.microsoft.com/azure/data-explorer/kusto/management/alter-table-update-policy-command
 *   .show table policy update  — https://learn.microsoft.com/azure/data-explorer/kusto/management/show-table-update-policy-command
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ADX.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});
// Cosmos is imported at module load but unused by these two functions.
vi.mock('../cosmos-client', () => ({ itemsContainer: vi.fn(), workspacesContainer: vi.fn() }));

import { setTableUpdatePolicy, showTableUpdatePolicy } from '../kusto-client';

const realFetch = global.fetch;

/** A v1 /rest/mgmt response with one Table_0 row carrying a Policy column. */
function v1Response(policyJson: string, rows = 1) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      Tables: [{
        TableName: 'Table_0',
        Columns: [{ ColumnName: 'PolicyName', DataType: 'String' }, { ColumnName: 'Policy', DataType: 'String' }],
        Rows: rows ? [['UpdatePolicy', policyJson]] : [],
      }],
    }),
  } as unknown as Response;
}

describe('setTableUpdatePolicy', () => {
  let lastBody: any;
  beforeEach(() => {
    lastBody = null;
    global.fetch = vi.fn(async (_url: any, init: any) => { lastBody = JSON.parse(init.body); return v1Response('[]'); }) as any;
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('builds .alter table policy update with bracket-quoted target + @-verbatim JSON', async () => {
    await setTableUpdatePolicy('db1', 'events_silver', [{
      IsEnabled: true, Source: 'events_raw', Query: 'transform()',
      IsTransactional: true, PropagateIngestionProperties: false,
    }]);
    const csl: string = lastBody.csl;
    expect(csl).toContain('.alter table ["events_silver"] policy update @\'');
    const m = csl.match(/@'(.*)'$/s);
    expect(m).toBeTruthy();
    const parsed = JSON.parse(m![1]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].Source).toBe('events_raw');
    expect(parsed[0].Query).toBe('transform()');
    expect(parsed[0].IsTransactional).toBe(true);
    expect(parsed[0].IsEnabled).toBe(true);
  });

  it('escapes single quotes embedded in the policy query so they do not close the literal', async () => {
    await setTableUpdatePolicy('db1', 'tgt', [{
      IsEnabled: true, Source: 'src', Query: "src | where name == 'x'",
      IsTransactional: false, PropagateIngestionProperties: false,
    }]);
    expect((lastBody.csl as string)).toContain("\\'x\\'");
  });
});

describe('showTableUpdatePolicy', () => {
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('parses the Policy column JSON and returns the raw receipt string', async () => {
    const policyJson = JSON.stringify([{ IsEnabled: true, Source: 'src', Query: 'q()', IsTransactional: true, PropagateIngestionProperties: false }]);
    global.fetch = vi.fn(async () => v1Response(policyJson)) as any;
    const r = await showTableUpdatePolicy('db1', 'tgt');
    expect(r).not.toBeNull();
    expect(r!.raw).toBe(policyJson);
    expect(Array.isArray(r!.policy)).toBe(true);
    expect((r!.policy as any[])[0].Source).toBe('src');
  });

  it('returns null when the cluster reports no rows', async () => {
    global.fetch = vi.fn(async () => v1Response('', 0)) as any;
    const r = await showTableUpdatePolicy('db1', 'tgt');
    expect(r).toBeNull();
  });
});
