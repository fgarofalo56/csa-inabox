/**
 * #4219 — the ontology resolver's TWO SQL SINKS refuse an engine-metadata or
 * cross-database ref, instead of being shape-checked only.
 *
 * THE DEFECT THESE PIN. `case 'lakehouse-table'` and `case 'warehouse-table'`
 * built `SELECT TOP 100 * FROM <binding.source.ref>` and executed it on the
 * Synapse Serverless / Dedicated endpoints with NO check on which object the ref
 * named. The only validation in the path was `SQL_REF_RE`
 * (`/^[A-Za-z0-9_.$#[\]]+$/`, ontology-binding.ts) — an INJECTION guard, which
 * `master.sys.sql_logins` satisfies character for character. The Console UAMI is
 * a Synapse SQL admin, so the engine served it. #3959 closed the identical hole
 * on the sibling `shortcut` sink (`isMintedEngineObject`) and these two kinds
 * were left on the other branch of that same `switch`.
 *
 * ── WHAT THIS SPEC DOES NOT COVER, SO NOBODY READS IT AS MORE THAN IT IS ────
 * The guard that landed is the NAME-SPACE half: engine-metadata schemas and
 * cross-database refs. The LIVE half — "is this ref one of the objects the
 * binding's catalog actually EXPOSES?", via `scanLakehouseTables()` /
 * `listTables()` — is DEFERRED (see the block comment in ontology-resolver.ts
 * for why: it changes the contract for `ontology-resolver.test.ts`, which is
 * outside this change's ownership). So a ref naming a REAL user table in the
 * binding's own database that the caller was never meant to read is still
 * resolved, and no assertion here should be read as saying otherwise.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `ontologySqlRefViolation` and the whole
 * `resolveBindingInstances` switch RUN FOR REAL. Only the backend is stubbed —
 * `synapseExecute`, so the test can assert it was NEVER CALLED, which is the
 * actual security property. A gate that still ran the query would be theatre.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const synapseExecute = vi.fn();
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: (...a: any[]) => synapseExecute(...a),
  serverlessTarget: (database = 'master') => ({ server: 'ws-ondemand.sql', database, cacheKey: `s:${database}` }),
  dedicatedTarget: () => ({ server: 'ws.sql', database: 'pool1', cacheKey: 'd' }),
}));

import { resolveBindingInstances } from '../ontology-resolver';
import { ontologySqlRefViolation } from '../ontology-binding';

const binding = (kind: string, ref: string, database?: string) => ({
  ontologyId: 'ont-1',
  objectType: 'Customer',
  source: { kind, ref, ...(database ? { database } : {}) },
  columnMap: {},
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws';
  process.env.LOOM_SYNAPSE_DEDICATED_POOL = 'pool1';
  synapseExecute.mockResolvedValue({ columns: ['id'], columnTypes: ['int'], rows: [[1]] });
});

describe('lakehouse-table — the sink #3959 did not reach', () => {
  it('REFUSES master.sys.sql_logins and never touches the query engine', async () => {
    // At head this produced `SELECT TOP 100 * FROM master.sys.sql_logins` and
    // ran it. The second assertion is the load-bearing one.
    const out = await resolveBindingInstances(binding('lakehouse-table', 'master.sys.sql_logins'), null);
    expect(out.gated).toBe(true);
    expect((out as any).code).toBe('ontology_sql_ref_namespace');
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('REFUSES a bare sys.* ref', async () => {
    const out = await resolveBindingInstances(binding('lakehouse-table', 'sys.sql_logins'), null);
    expect(out.gated).toBe(true);
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('REFUSES INFORMATION_SCHEMA regardless of casing', async () => {
    const out = await resolveBindingInstances(binding('lakehouse-table', 'INFORMATION_SCHEMA.TABLES'), null);
    expect(out.gated).toBe(true);
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('REFUSES a BRACKETED sys ref — brackets are stripped before the schema test', async () => {
    // `[master].[sys].[sql_logins]` is the same read wearing a hat, and
    // `SQL_REF_RE` admits brackets. A guard that only matched the bare spelling
    // would be the narrow-bypass class this repo keeps re-finding.
    const out = await resolveBindingInstances(binding('lakehouse-table', '[master].[sys].[sql_logins]'), null);
    expect(out.gated).toBe(true);
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('REFUSES a 3-part ref naming ANOTHER database', async () => {
    const out = await resolveBindingInstances(
      binding('lakehouse-table', 'otherdb.dbo.orders', 'lakehouse_db'), null,
    );
    expect(out.gated).toBe(true);
    expect((out as any).hint).toContain('otherdb');
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — an ordinary dbo.orders still resolves rows', async () => {
    // Without this every refusal above would equally be explained by the sink
    // being dead. It is also the assertion that keeps the deferred
    // enumeration half from being smuggled in as a silent narrowing.
    const out = await resolveBindingInstances(binding('lakehouse-table', 'dbo.orders'), null);
    expect(out.gated).toBe(false);
    expect(synapseExecute).toHaveBeenCalledTimes(1);
    expect(synapseExecute.mock.calls[0][1]).toBe('SELECT TOP 100 * FROM dbo.orders');
  });

  it('a 3-part ref naming its OWN database is allowed', async () => {
    const out = await resolveBindingInstances(
      binding('lakehouse-table', 'lakehouse_db.dbo.orders', 'lakehouse_db'), null,
    );
    expect(out.gated).toBe(false);
    expect(synapseExecute).toHaveBeenCalledTimes(1);
  });
});

describe('warehouse-table — the same sink on the Dedicated pool', () => {
  it('REFUSES master.sys.sql_logins and never touches the query engine', async () => {
    const out = await resolveBindingInstances(binding('warehouse-table', 'master.sys.sql_logins'), null);
    expect(out.gated).toBe(true);
    expect((out as any).code).toBe('ontology_sql_ref_namespace');
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('REFUSES a ref naming a database other than the bound pool', async () => {
    // `dedicatedTarget().database` is 'pool1' here, so 'master.*' is foreign.
    const out = await resolveBindingInstances(binding('warehouse-table', 'master.dbo.orders'), null);
    expect(out.gated).toBe(true);
    expect(synapseExecute).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — an ordinary dbo.orders still resolves rows', async () => {
    const out = await resolveBindingInstances(binding('warehouse-table', 'dbo.orders'), null);
    expect(out.gated).toBe(false);
    expect(synapseExecute).toHaveBeenCalledTimes(1);
  });
});

describe('the honest CONFIG gates still come first', () => {
  it('an unconfigured Serverless endpoint gates before the ref is judged', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const out = await resolveBindingInstances(binding('lakehouse-table', 'master.sys.sql_logins'), null);
    expect(out.gated).toBe(true);
    expect((out as any).code).toBe('serverless_not_configured');
  });
});

describe('ontologySqlRefViolation — the pure policy, exercised directly', () => {
  it('says nothing about refs it permits', () => {
    expect(ontologySqlRefViolation('dbo.orders', 'db')).toBeNull();
    expect(ontologySqlRefViolation('orders', 'db')).toBeNull();
    expect(ontologySqlRefViolation('db.dbo.orders', 'DB')).toBeNull();
  });

  it('refuses more than three name parts', () => {
    expect(ontologySqlRefViolation('a.b.c.d', 'a')).toContain('three name parts');
  });

  it('refuses an empty part (a trailing or doubled dot)', () => {
    expect(ontologySqlRefViolation('dbo.', 'db')).toBeTruthy();
    expect(ontologySqlRefViolation('a..b', 'db')).toBeTruthy();
  });

  it('refuses a 3-part ref when the binding declares NO database at all', () => {
    // Absent-is-not-a-match: the same positive-comparison discipline the tenant
    // boundary uses. A truthiness guard here would admit every cross-db ref on
    // a binding that simply omitted `database`.
    expect(ontologySqlRefViolation('master.dbo.orders', undefined)).toBeTruthy();
  });

  it('refuses ALL NINE fixed-role schemas, not the two the first cut listed', () => {
    // Review: `FORBIDDEN_SQL_SCHEMAS` held `db_owner` and `db_accessadmin` and
    // omitted the other seven — "a half-done enumeration reads as complete".
    // SQL Server creates a schema per fixed database role in every database, so
    // the set is closed and this asserts the whole of it. Written as data rather
    // than nine `it`s so a future edit that drops one goes red by name.
    for (const schema of [
      'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
      'db_backupoperator', 'db_datareader', 'db_datawriter',
      'db_denydatareader', 'db_denydatawriter',
    ]) {
      expect(ontologySqlRefViolation(`${schema}.t`, 'db'), `${schema} is not refused`)
        .toContain('SQL engine metadata');
      // …and case does not launder it, the same way `sys` cannot be cased past.
      expect(ontologySqlRefViolation(`${schema.toUpperCase()}.t`, 'db'), `${schema} upper-cased is not refused`)
        .toBeTruthy();
    }
    expect(ontologySqlRefViolation('sys.sql_logins', 'db')).toBeTruthy();
    expect(ontologySqlRefViolation('INFORMATION_SCHEMA.TABLES', 'db')).toBeTruthy();
  });

  it('CONTROL — the guard is SILENT on a one-part ref, which the docblock now says', () => {
    // NOT an endorsement: this pins the DISCLOSED gap so it cannot quietly
    // become a claim of coverage. The schema test sits behind `parts.length>=2`
    // because a one-part ref carries no schema to test; whether the engine
    // resolves `sysobjects` out of `sys` for an unqualified name was NOT
    // measured here (no Synapse endpoint was reached), so this asserts what the
    // CODE does, not what the server would do.
    expect(ontologySqlRefViolation('sysobjects', 'db')).toBeNull();
    expect(ontologySqlRefViolation('sysdatabases', 'db')).toBeNull();
  });
});
