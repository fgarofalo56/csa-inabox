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
 * ── THE SECOND DEFECT, FOUND BY INDEPENDENT REVIEW ─────────────────────────
 * The first cut of this guard put the schema test behind `parts.length >= 2`,
 * so a ONE-PART ref carried no schema to test and got none. Review measured
 * four spellings (`syslogins`, `sysobjects`, `sysdatabases`, `sysusers`)
 * reaching `buildSqlSelect` through the real resolver with `gated=false`, one
 * `synapseExecute` call each, `db = master`. Re-measured here before the fix
 * with six MORE the first author never tried — `sysaltfiles`, `spt_values`,
 * `MSreplication_options`, `[syslogins]`, `[[sysobjects]]`, and a bare `sys` —
 * all ten reached the sink. Two of those ten do not begin with `sys`, which is
 * why the fix is keyed to the SHAPE ("the ref carries no schema, so the schema
 * is the server's choice and this code cannot judge it — refuse") and NOT to a
 * name prefix: a `startsWith('sys')` rule would have closed eight of ten and
 * read as if it closed the class. `describe('one-part refs …')` below pins the
 * whole measured population through the real sink.
 *
 * ── WHAT THIS SPEC DOES NOT COVER, SO NOBODY READS IT AS MORE THAN IT IS ────
 * The guard that landed is the NAME-SPACE half: an explicit, permitted schema
 * on every ref, and a 3-part ref confined to the binding's declared database.
 * The LIVE half — "is this ref one of the objects the binding's catalog
 * actually EXPOSES?", via `scanLakehouseTables()` / `listTables()` — is
 * DEFERRED (see the block comment in ontology-resolver.ts for why: it changes
 * the contract for `ontology-resolver.test.ts`, which is outside this change's
 * ownership). So a ref naming a REAL user table in the binding's own database
 * that the caller was never meant to read is still resolved, and no assertion
 * here should be read as saying otherwise. Nor is the database itself
 * authorized on the `lakehouse-table` sink: `ownDatabase` there is
 * `binding.source.database`, the same caller-supplied value the resolver hands
 * to `serverlessTarget()`, so the 3-part test is internal consistency, not
 * isolation. Only `warehouse-table` gets a real database restriction, because
 * `dedicatedTarget()` ignores the binding — asserted below.
 *
 * ── THE THIRD AND FOURTH DEFECTS, FOUND BY THE ROUND-4 REVIEW ──────────────
 * (a) THIS SPEC COULD NOT SEE THE EMPTY-PART BRANCH REGRESS. Narrowing the
 * refusal at `ontology-binding.ts` to the TRAILING position left the spec at
 * 42/42 RC=0 while `master..sysobjects` with `database:'master'` reached
 * `buildSqlSelect`. The single empty-part assertion, `('a..b','db')`, stayed
 * truthy only because `a` !== `db` — the DATABASE branch refused it and masked
 * the branch under test. That is a blind assertion, not a weak mutation.
 * (b) `sqlRefParts` SPLITS ON EVERY DOT, and its docblock justified that with
 * "SQL_REF_RE admits no quote or escape character". It admits BRACKETS, and in
 * T-SQL a dot inside a delimited identifier is part of the name. `sys.[a.b]`
 * with `database:'sys'` reached the sink because the guard read the schema as
 * `a` while T-SQL reads it as `sys`.
 * Both are pinned below, with the database on each ref chosen so the branch
 * under test is the only one that can refuse it.
 *
 * WHAT IS DELIBERATELY *NOT* MOCKED. `ontologySqlRefViolation` and the whole
 * `resolveBindingInstances` switch RUN FOR REAL. Only the backend is stubbed —
 * `synapseExecute`, so the test can assert it was NEVER CALLED, which is the
 * actual security property. A gate that still ran the query would be theatre.
 *
 * AND THE COUNTERFACTUALS ARE IN THE REPO, NOT IN A SCRATCH DIRECTORY. Nine
 * mutation arms — the two above, plus the pre-round-3 guard, the narrower
 * `startsWith('sys')` fix a reviewer proposed, the outermost-pair bracket strip,
 * the dropped per-part trim, a divergence verdict that is computed and
 * discarded, and the gate removed from the Dedicated sink only — live at
 * `lib/foundry/__tests__/mutation/`. Each declares the MECHANISM by which it
 * changes the guard's answer and the test names it must break, so a mutant that
 * dies for an unrelated reason is reported rather than counted:
 *
 *     cd apps/fiab-console
 *     node lib/foundry/__tests__/mutation/run-sql-ref-guard-arms.mjs
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
    expect(ontologySqlRefViolation('db.dbo.orders', 'DB')).toBeNull();
    // `orders` used to be on this list. It is not any more — see the one-part
    // block below. A bare table name is now a refusal, not a permission.
  });

  it('refuses more than three name parts', () => {
    expect(ontologySqlRefViolation('a.b.c.d', 'a')).toContain('three name parts');
  });

  it('refuses an empty part (a trailing or doubled dot)', () => {
    expect(ontologySqlRefViolation('dbo.', 'db')).toBeTruthy();
    // KEPT, AND NOW LABELLED WITH WHAT MASKS IT. Review found a GREEN mutation
    // here: narrow the refusal at ontology-binding.ts to `parts[parts.length-1]
    // === ''` (trailing-only) and this spec stayed 42/42 RC=0 while
    // `master..sysobjects` with `database:'master'` reached the sink
    // (`SELECT TOP 100 * FROM master..sysobjects`, targetDb `master`). This line
    // survives the mutation because `a` !== `db`, so it is the DATABASE branch
    // that refuses it, not the empty-part branch — a blind assertion, not a weak
    // mutation. The discriminating arms are in the `it` below.
    expect(ontologySqlRefViolation('a..b', 'db')).toBeTruthy();
  });

  it('refuses an empty part in EVERY position, from the empty-part branch itself', () => {
    // MECHANISM, so a green run here means something. Under the trailing-only
    // mutation each of these would fall through to a PERMIT:
    //   'master..sysobjects' → parts ['master','','sysobjects'] → length 3, last
    //     part non-empty → schema is '' (not in FORBIDDEN_SQL_SCHEMAS) → db test
    //     compares 'master' to ownDatabase 'master' and AGREES → null.
    //   '.sysobjects'        → parts ['','sysobjects'] → schema is '' → null.
    // So the database is chosen to MATCH precisely so the db branch cannot mask
    // the empty-part branch, and the message is asserted (not just truthiness) so
    // a future refusal arriving from some OTHER branch cannot pass for this one.
    //
    // In T-SQL `db..object` is not a typo: the omitted middle part means the
    // SERVER applies default-schema resolution — the exact "unjudgeable, so fail
    // closed" case this whole rule exists for.
    const EMPTY_PART = 'is not a usable SQL object reference';
    expect(ontologySqlRefViolation('master..sysobjects', 'master')).toContain(EMPTY_PART);
    expect(ontologySqlRefViolation('.sysobjects', 'db')).toContain(EMPTY_PART);
    expect(ontologySqlRefViolation('dbo.', 'db')).toContain(EMPTY_PART);
    // …and a leading dot on a 3-part ref whose database also agrees.
    expect(ontologySqlRefViolation('.dbo.orders', 'db')).toContain(EMPTY_PART);
  });

  it('refuses a ref whose brackets make this splitter and T-SQL disagree', () => {
    // Review measured the divergence: `sqlRefParts` splits on EVERY dot, but
    // `SQL_REF_RE` admits brackets and in T-SQL a dot inside a delimited
    // identifier is part of the name. `sys.[a.b]` with `database:'sys'` split to
    // db=`sys` / schema=`a` / table=`b`, cleared the schema test and reached
    // `buildSqlSelect`; T-SQL reads schema `sys`, object `a.b`. Review could not
    // turn it into a live read of a real `sys` object and said so — this closes
    // the SILENCE, on the same reasoning `[[sys]]` and `sys .t` were closed.
    expect(ontologySqlRefViolation('sys.[a.b]', 'sys')).toContain('dot inside a bracketed name part');
    expect(ontologySqlRefViolation('[a.b].[c]', 'a')).toContain('dot inside a bracketed name part');
    // An unterminated `[` leaves no parse to compare against at all.
    expect(ontologySqlRefViolation('[dbo.orders', 'db')).toContain('never closes');
    // STRICTLY ADDITIVE, asserted rather than claimed: a ref the earlier rules
    // already refuse keeps ITS OWN, more specific message. `[[sys]].[sql_logins]`
    // is `dot-inside` too (the `]]` escape swallows the closing bracket), so if
    // the divergence check had been placed first this would now read "dot inside
    // a bracketed name part" instead.
    expect(ontologySqlRefViolation('[[sys]].[sql_logins]', 'db')).toContain('SQL engine metadata');
    // …and an ordinary bracketed ref with no dot inside a part is still permitted.
    expect(ontologySqlRefViolation('[dbo].[orders]', 'db')).toBeNull();
    expect(ontologySqlRefViolation('[db].[dbo].[orders]', 'db')).toBeNull();
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

  it('refuses a BRACKET SPELLING the outermost-pair strip was silent on', () => {
    // Review measured this one: `sqlRefParts` stripped `^\[` and `\]$` only, so
    // `[[sys]]` normalised to `[sys]`, missed the schema set, and
    // `[[sys]].[sql_logins]` reached the sink ungated (`gated=false`, one
    // `synapseExecute` call). Whether T-SQL resolves that token as `sys` was
    // never established, so this is closing a SILENCE rather than a proven hole —
    // but `SQL_REF_RE` admits brackets anywhere, so any bracket count is
    // reachable and an outermost-pair rule can always be spelled around.
    expect(ontologySqlRefViolation('[[sys]].[sql_logins]', 'db')).toContain('SQL engine metadata');
    expect(ontologySqlRefViolation('[[[sys]]].[t]', 'db')).toContain('SQL engine metadata');
    expect(ontologySqlRefViolation('[mas[ter].[sys].[t]', 'db')).toBeTruthy();
    // …and an ordinary bracketed user table is still permitted, so the widened
    // strip did not simply refuse everything.
    expect(ontologySqlRefViolation('[dbo].[orders]', 'db')).toBeNull();
  });

  it('refuses EVERY one-part ref, on the shape and not on the name', () => {
    // The rule is "no schema in the string", so it does not matter what the
    // name is. Written as data, and deliberately including two names that do
    // NOT begin with `sys`: they are the counter-example to the narrower fix
    // (`startsWith('sys')`) that would have passed the four names review
    // happened to try.
    for (const ref of [
      'syslogins', 'sysobjects', 'sysdatabases', 'sysusers', 'sysaltfiles',
      'spt_values', 'MSreplication_options', '[syslogins]', '[[sysobjects]]',
      'sys', 'orders',
    ]) {
      expect(ontologySqlRefViolation(ref, 'db'), `${ref} is not refused`)
        .toContain('names no schema');
    }
    // …and the refusal says only what it established (R7): it does NOT claim
    // the object is engine metadata, because from a bare name it cannot know.
    expect(ontologySqlRefViolation('syslogins', 'db')).not.toContain('addresses the');
  });

  it('trims each name part, so a padded schema cannot slip past the schema test', () => {
    // `sys .t` split to `'sys '`, which is not `'sys'`. That string died one
    // call later on SQL_REF_RE (no space in its class), so this closes a
    // SILENCE rather than a proven hole — but the schema test should be true on
    // its own terms, not by another guard's alphabet.
    expect(ontologySqlRefViolation('sys .t', 'db')).toContain('SQL engine metadata');
    expect(ontologySqlRefViolation(' sys . t ', 'db')).toContain('SQL engine metadata');
  });

  it('an EXPLICIT schema is still what the guard judges, so dbo.* is permitted', () => {
    // The counterpart to the rule above: qualification is what makes the string
    // testable, so a qualified user ref must still pass or the fix would be a
    // blanket refusal wearing a shape argument.
    expect(ontologySqlRefViolation('dbo.sysobjects', 'db')).toBeNull();
    expect(ontologySqlRefViolation('[dbo].[orders]', 'db')).toBeNull();
  });
});

describe('one-part refs through the REAL sink — the property that actually matters', () => {
  // A pure-function assertion proves the policy; this proves the policy is
  // WIRED. Only `synapseExecute` is stubbed, so a recorded call is proof the
  // string reached the query engine. Before the fix each of these produced
  // `SELECT TOP 100 * FROM <ref>` against `db = master` with `gated=false`.
  const ONE_PART = [
    'syslogins', 'sysobjects', 'sysdatabases', 'sysusers', 'sysaltfiles',
    'spt_values', 'MSreplication_options', '[syslogins]', '[[sysobjects]]', 'sys',
  ];

  for (const kind of ['lakehouse-table', 'warehouse-table']) {
    for (const ref of ONE_PART) {
      it(`${kind} REFUSES '${ref}' and never touches the query engine`, async () => {
        const out = await resolveBindingInstances(binding(kind, ref), null);
        expect(out.gated).toBe(true);
        expect((out as any).code).toBe('ontology_sql_ref_namespace');
        expect(synapseExecute).not.toHaveBeenCalled();
      });
    }
  }
});

describe('the shapes a PURE-FUNCTION assertion alone could not have caught', () => {
  // Every case here is one review reached `buildSqlSelect` with, or would have
  // reached it with, under a mutation the previous spec could not see. Only
  // `synapseExecute` is stubbed, so `not.toHaveBeenCalled()` is the property.
  //
  // WHY THE DATABASE IS SPELLED OUT ON EACH. On `lakehouse-table` the guard's
  // `ownDatabase` is `binding.source.database || 'master'`; on `warehouse-table`
  // it is `dedicatedTarget().database` ('pool1' here). Each ref below is written
  // so its FIRST part MATCHES that value — otherwise the cross-database branch
  // refuses it and masks the branch actually under test, which is precisely how
  // the `'a..b'` assertion above stayed green under the trailing-only mutation.
  const CASES: Array<[kind: string, ref: string, database: string | undefined, why: string]> = [
    ['lakehouse-table', 'master..sysobjects', 'master',
      'db..object — the omitted middle part hands schema resolution to the SERVER'],
    ['warehouse-table', 'pool1..sysobjects', undefined,
      'the same shape against the pool name the Dedicated sink actually connects to'],
    ['lakehouse-table', '.sysobjects', 'master',
      'a LEADING empty part, which a trailing-only refusal also lets through'],
    ['lakehouse-table', 'sys.[a.b]', 'sys',
      'guard reads schema `a`; T-SQL reads schema `sys`, object `a.b`'],
    ['warehouse-table', 'pool1.[a.b]', undefined,
      'the same divergence on the Dedicated sink'],
  ];

  for (const [kind, ref, database, why] of CASES) {
    it(`${kind} REFUSES '${ref}' — ${why}`, async () => {
      const out = await resolveBindingInstances(binding(kind, ref, database), null);
      expect(out.gated).toBe(true);
      expect((out as any).code).toBe('ontology_sql_ref_namespace');
      expect(synapseExecute).not.toHaveBeenCalled();
    });
  }

  it('POSITIVE CONTROL — the same sinks still resolve a bracketed user table', async () => {
    // Without this the five refusals above are equally explained by the sink
    // being dead, and by the divergence rule having become a blanket refusal of
    // every bracketed ref.
    const out = await resolveBindingInstances(binding('lakehouse-table', '[dbo].[orders]', 'master'), null);
    expect(out.gated).toBe(false);
    expect(synapseExecute).toHaveBeenCalledTimes(1);
    expect(synapseExecute.mock.calls[0][1]).toBe('SELECT TOP 100 * FROM [dbo].[orders]');
  });
});

describe('the cross-database half binds only the DEDICATED sink — stated, not implied', () => {
  it('lakehouse-table: declaring the other database makes the 3-part ref agree', async () => {
    // NOT a hole this spec is hiding: `ownDatabase` on this sink IS
    // `binding.source.database`, and it is the same value handed to
    // `serverlessTarget()`. So the 3-part test enforces consistency between
    // `ref` and `database`, never isolation. Pinned so the PR body cannot
    // describe it as isolation.
    const out = await resolveBindingInstances(
      binding('lakehouse-table', 'otherdb.dbo.orders', 'otherdb'), null,
    );
    expect(out.gated).toBe(false);
    expect(synapseExecute).toHaveBeenCalledTimes(1);
    expect(synapseExecute.mock.calls[0][0].database).toBe('otherdb');
  });

  it('warehouse-table: declaring it changes nothing, the pool wins', async () => {
    // `dedicatedTarget()` ignores the binding and reads
    // LOOM_SYNAPSE_DEDICATED_POOL ('pool1' here), so this IS a real
    // restriction — the asymmetry the lakehouse case above lacks.
    const out = await resolveBindingInstances(
      binding('warehouse-table', 'otherdb.dbo.orders', 'otherdb'), null,
    );
    expect(out.gated).toBe(true);
    expect((out as any).hint).toContain('pool1');
    expect(synapseExecute).not.toHaveBeenCalled();
  });
});
