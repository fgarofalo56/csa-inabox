/**
 * #3611 (review round 2) — the engine-object name-space guard AT THE SINK.
 *
 * `apps/fiab-console/app/api/items/lakehouse-shortcut/__tests__/vault-destruction-primitive.test.ts`
 * pins the ROUTE. It mocks `@/lib/azure/shortcut-engines`, so it cannot say
 * anything about the functions that actually build the SQL. This file pins those.
 *
 * WHY IT HAS TO EXIST SEPARATELY — counted with
 * `rg -n "\b(dropShortcutObject|testEngineObject)\(" apps/fiab-console`, then the
 * two non-helper sinks added by hand. `engineObject` reaches SQL from TEN caller
 * sites:
 *
 *   dropShortcutObject (4 callers)
 *     app/api/items/lakehouse-shortcut/route.ts
 *     app/api/items/[type]/[id]/shortcuts/[name]/route.ts:54
 *     app/api/items/[type]/[id]/shortcuts/[name]/route.ts:125
 *     app/api/lakehouse/shortcuts/route.ts:346
 *   testEngineObject (4 callers)
 *     app/api/lakehouse/shortcuts/test/route.ts:93, :113, :161
 *     lib/azure/shortcut-client.ts:204        ← the one an earlier revision of
 *                                               this docblock missed while
 *                                               asserting the list was complete
 *   the inline `SELECT TOP n * FROM ${obj}` in the lakehouse-shortcut
 *     POST action=query path
 *   lib/foundry/ontology-resolver.ts:190 — `buildSqlSelect(engineObject, …)`
 *
 * Coverage of those ten, stated as it actually is:
 *   - 8 go through `dropShortcutObject` / `testEngineObject`, which call
 *     `assertMintedEngineObject` INTERNALLY. That is what this file pins, and it
 *     is why a ninth caller of either helper is covered the day it is written.
 *   - 1 (the inline query) is covered by the ROUTE-level `isSafeEngineObject`.
 *   - 1 (`ontology-resolver.ts:190`) is NOT covered by either. It validates only
 *     against a shape regex (`SQL_REF_RE` in lib/foundry/ontology-binding.ts),
 *     which is the same identifier-shaped check this guard replaced — so
 *     `master.sys.sql_logins` passes it. Different item type, same primitive.
 *     Open, tracked as a follow-up; do not read this file as covering it.
 *
 * Each covered site builds `DROP VIEW` / `DROP TABLE` / `SELECT TOP 1 * FROM` /
 * `SELECT * FROM … LIMIT 1` and runs it as the Console UAMI, a Synapse SQL admin.
 *
 * Every case here drives the REAL `dropShortcutObject` / `testEngineObject`.
 * Only the Azure egress (`executeQuery`, `executeStatement`) is mocked, so the
 * assertion "no SQL was built" is about the production code path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/synapse-sql-client', () => ({
  serverlessTarget: vi.fn((db: string) => ({ db })),
  executeQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  listWarehouses: vi.fn(async () => [{ id: 'wh1', state: 'RUNNING' }]),
  executeStatement: vi.fn(async () => ({})),
  databricksConfigGate: vi.fn(() => null),
  writeUcVolumesFile: vi.fn(async () => {}),
  deleteUcVolumesFile: vi.fn(async () => {}),
}));

import {
  dropShortcutObject,
  testEngineObject,
  isMintedEngineObject,
  EngineObjectNamespaceError,
} from '../shortcut-engines';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import { executeStatement } from '@/lib/azure/databricks-client';

/**
 * Objects OUTSIDE the minted name-space. Every one is a well-formed 1–3 part
 * SQL identifier with NO separator to escape — which is exactly why an
 * identifier-shaped guard is green on all of them.
 */
const OUTSIDE_NAMESPACE = [
  'master.sys.sql_logins',
  'finance_db.dbo.payroll',
  'loom_lakehouse.dbo.someone_elses_view',
  'loom_lakehouse.shortcuts_evil.v',
  'dbo.audit',
  'unity.finance.payroll',
  'sys.databases',
];

/** Objects INSIDE it — the positive controls. A guard with an empty allow-set
 *  refuses everything and is useless; these are what prove it does not. */
const INSIDE_NAMESPACE: Array<[string, 'synapse' | 'databricks']> = [
  ['loom_lakehouse.shortcuts.sc_abc12345', 'synapse'],
  ['loom_lakehouse.shortcuts.4f0278c7_MyShortcut', 'synapse'], // digit-headed leaf
  ['shortcuts.legacy_two_part', 'synapse'],                     // pre-qualification row
  // The install provisioner's mint (lib/install/provisioners/lakehouse.ts):
  // `lakehouse.<leaf>`, in a schema that path CREATEs itself. Refusing these
  // orphaned every content-installed shortcut view at the DROP sink and flipped
  // the shortcut to status='error' at the test sink.
  ['lakehouse.shortcut_nyc_taxi', 'synapse'],
  ['loom_lakehouse.lakehouse.shortcut_sales', 'synapse'],
  ['loom.sc_abc12345.mytable', 'databricks'],
];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LOOM_SERVERLESS_DB;
});

describe('#3611 — dropShortcutObject refuses outside the minted name-space', () => {
  for (const obj of OUTSIDE_NAMESPACE) {
    it(`throws and builds NO SQL for "${obj}" (synapse)`, async () => {
      await expect(dropShortcutObject({ engine: 'synapse', engineObject: obj }))
        .rejects.toBeInstanceOf(EngineObjectNamespaceError);

      expect(executeQuery).not.toHaveBeenCalled();
    });

    it(`throws and builds NO SQL for "${obj}" (databricks)`, async () => {
      await expect(dropShortcutObject({ engine: 'databricks', engineObject: obj }))
        .rejects.toBeInstanceOf(EngineObjectNamespaceError);

      expect(executeStatement).not.toHaveBeenCalled();
    });
  }

  it('DOES drop a minted Synapse object, in the minted database', async () => {
    await dropShortcutObject({ engine: 'synapse', engineObject: 'loom_lakehouse.shortcuts.sc_abc12345' });

    expect(executeQuery).toHaveBeenCalledTimes(1);
    const [target, sql] = (executeQuery as any).mock.calls[0];
    // The DATABASE the statement runs against comes from parts[0] — assert it
    // is the minted one, since "which database" was half the original defect.
    expect(target).toEqual({ db: 'loom_lakehouse' });
    expect(String(sql)).toContain('DROP VIEW shortcuts.sc_abc12345');
  });

  it('DOES drop a minted Databricks object', async () => {
    await dropShortcutObject({ engine: 'databricks', engineObject: 'loom.sc_abc12345.mytable' });

    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect(String((executeStatement as any).mock.calls[0][1]))
      .toContain('DROP TABLE IF EXISTS loom.sc_abc12345.mytable');
  });

  it('still no-ops (does NOT throw) when there is no engine object at all', async () => {
    // The pre-existing contract: a Files shortcut has no engine object and
    // deleting it must not error. Turning that into a throw would break every
    // Files-shortcut delete, so it gets its own control.
    await dropShortcutObject({ engine: 'none', engineObject: undefined });
    await dropShortcutObject({ engine: 'synapse', engineObject: undefined });
    await dropShortcutObject({});

    expect(executeQuery).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
  });
});

describe('#3611 — testEngineObject refuses outside the minted name-space', () => {
  for (const obj of OUTSIDE_NAMESPACE) {
    it(`throws and builds NO SELECT for "${obj}" (synapse)`, async () => {
      await expect(testEngineObject('synapse', obj))
        .rejects.toBeInstanceOf(EngineObjectNamespaceError);

      expect(executeQuery).not.toHaveBeenCalled();
    });

    it(`throws and builds NO SELECT for "${obj}" (databricks)`, async () => {
      await expect(testEngineObject('databricks', obj))
        .rejects.toBeInstanceOf(EngineObjectNamespaceError);

      expect(executeStatement).not.toHaveBeenCalled();
    });
  }

  it('DOES test a minted Synapse object', async () => {
    await testEngineObject('synapse', 'loom_lakehouse.shortcuts.sc_ok');

    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(String((executeQuery as any).mock.calls[0][1]))
      .toContain('SELECT TOP 1 * FROM loom_lakehouse.shortcuts.sc_ok');
  });

  it('DOES test a minted Databricks object', async () => {
    await testEngineObject('databricks', 'loom.sc_abc12345.mytable');

    expect(executeStatement).toHaveBeenCalledTimes(1);
    expect(String((executeStatement as any).mock.calls[0][1]))
      .toContain('SELECT * FROM loom.sc_abc12345.mytable LIMIT 1');
  });
});

describe('#3611 — isMintedEngineObject, the one definition of the policy', () => {
  it('refuses every object outside the name-space', () => {
    // POSITIVE CONTROL FIRST: a predicate that returned false for everything
    // would pass the refusals below while proving nothing, so assert the
    // allow-set is non-empty before asserting the deny-set.
    expect(INSIDE_NAMESPACE.length).toBeGreaterThan(0);
    for (const [obj, engine] of INSIDE_NAMESPACE) {
      expect(isMintedEngineObject(obj, engine), `${obj} should be INSIDE`).toBe(true);
    }
    for (const obj of OUTSIDE_NAMESPACE) {
      expect(isMintedEngineObject(obj, 'synapse'), `${obj} should be OUTSIDE`).toBe(false);
      expect(isMintedEngineObject(obj, 'databricks'), `${obj} should be OUTSIDE`).toBe(false);
      expect(isMintedEngineObject(obj), `${obj} should be OUTSIDE (engine unknown)`).toBe(false);
    }
  });

  it('refuses separator payloads, quoted identifiers and arity abuse', () => {
    for (const bad of [
      'loom_lakehouse.shortcuts.x; DROP DATABASE loom--',
      'loom_lakehouse.shortcuts.[x]; TRUNCATE TABLE dbo.audit',
      'loom_lakehouse.shortcuts.x UNION ALL SELECT name FROM sys.databases--',
      'loom_lakehouse.shortcuts',            // 2-part, wrong schema position
      'loom_lakehouse.shortcuts.a.b',        // 4 parts
      'loom_lakehouse..shortcuts',           // empty part
      'shortcuts',                           // 1 part
      '',
      'loom_lakehouse.shortcuts.x$y',        // `$` was in the old body class
    ]) {
      expect(isMintedEngineObject(bad, 'synapse'), `${bad} must be refused`).toBe(false);
    }
  });

  it('refuses non-strings and over-long names', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(isMintedEngineObject(bad as unknown, 'synapse')).toBe(false);
    }
    expect(isMintedEngineObject(`loom_lakehouse.shortcuts.${'x'.repeat(300)}`, 'synapse')).toBe(false);
  });

  it('is CASE-SENSITIVE on the name-space parts', () => {
    // The mint lower-cases the UC catalog and emits the schema literal verbatim,
    // so a case-folded comparison would widen the allow-set past what is minted.
    expect(isMintedEngineObject('loom_lakehouse.SHORTCUTS.x', 'synapse')).toBe(false);
    expect(isMintedEngineObject('LOOM.sc_a.t', 'databricks')).toBe(false);
  });

  it('follows LOOM_SERVERLESS_DB rather than a hard-coded literal', () => {
    process.env.LOOM_SERVERLESS_DB = 'custom_lh';
    try {
      expect(isMintedEngineObject('custom_lh.shortcuts.sc_x', 'synapse')).toBe(true);
      // ...and the DEFAULT name is no longer minted once overridden.
      expect(isMintedEngineObject('loom_lakehouse.shortcuts.sc_x', 'synapse')).toBe(false);
    } finally {
      delete process.env.LOOM_SERVERLESS_DB;
    }
  });

  it('does not let one engine borrow the other name-space', () => {
    expect(isMintedEngineObject('loom.dbo.payroll', 'synapse')).toBe(false);
    expect(isMintedEngineObject('loom_lakehouse.shortcuts.x', 'databricks')).toBe(false);
    // With the engine UNKNOWN either minted space is accepted — strictly wider
    // than passing the engine, which is why the callers all pass it.
    expect(isMintedEngineObject('loom.dbo.payroll')).toBe(true);
    expect(isMintedEngineObject('loom_lakehouse.shortcuts.x')).toBe(true);
  });
});

/**
 * The allow-set is an ENUMERATION of mints (`SYNAPSE_MINTED_SCHEMAS`), and the
 * failure mode of an enumeration is a MISSING entry — which does not fail safe.
 * It refuses an object Loom itself created, orphaning it at the DROP sink and
 * flipping the shortcut to `error` at the test sink. `lakehouse.<leaf>` was that
 * miss. These pin the second entry AND pin that adding it widened nothing else.
 */
describe('#3611 — the provisioner mint `lakehouse.<leaf>` is inside the name-space', () => {
  // Leaves as the provisioner actually builds them:
  //   `shortcut_${safeRelPath(name)}`.replace(/[^A-Za-z0-9_]/g, '_')
  const PROVISIONER_LEAVES = ['shortcut_sales', 'shortcut_nyc_taxi', 'shortcut_Contoso_Retail', 'shortcut_orders_2024'];

  for (const leaf of PROVISIONER_LEAVES) {
    it(`accepts 2-part "lakehouse.${leaf}" and DROPs it in the serverless DB`, async () => {
      expect(isMintedEngineObject(`lakehouse.${leaf}`, 'synapse')).toBe(true);

      await dropShortcutObject({ engine: 'synapse', engineObject: `lakehouse.${leaf}` });
      expect(executeQuery).toHaveBeenCalledTimes(1);
      const [target, sql] = (executeQuery as any).mock.calls[0];
      // A 2-part name substitutes the serverless DB — assert WHICH database,
      // because "which database" was half the original defect.
      expect(target).toEqual({ db: 'loom_lakehouse' });
      expect(String(sql)).toContain(`DROP VIEW lakehouse.${leaf}`);
    });
  }

  it('accepts the 3-part qualification of the same schema', () => {
    expect(isMintedEngineObject('loom_lakehouse.lakehouse.shortcut_sales', 'synapse')).toBe(true);
  });

  it('admitting `lakehouse` opened NO other schema in the same database', () => {
    // The whole risk of widening a literal allow-set is that it widens past the
    // literal. Every one of these lives in the SAME database the mint uses.
    for (const schema of ['dbo', 'sys', 'information_schema', 'guest', 'shortcuts_evil', 'lakehouse_evil', 'Lakehouse']) {
      expect(isMintedEngineObject(`loom_lakehouse.${schema}.v`, 'synapse'), `3-part ${schema}`).toBe(false);
      expect(isMintedEngineObject(`${schema}.v`, 'synapse'), `2-part ${schema}`).toBe(false);
    }
    // ...and it did not widen the arity or the character class either.
    expect(isMintedEngineObject('lakehouse.v; DROP DATABASE loom--', 'synapse')).toBe(false);
    expect(isMintedEngineObject('lakehouse.a.b.c', 'synapse')).toBe(false);
    expect(isMintedEngineObject('other_db.lakehouse.v', 'synapse')).toBe(false);
  });
});

/**
 * NEW-4 — `LOOM_SERVERLESS_DB` is operator-supplied and nothing else validates
 * it. The guard requires every part to match `/^[A-Za-z0-9_]+$/` and this value
 * becomes `parts[0]` of every 3-part mint, so an unsanitized non-identifier
 * value made the mint produce names the guard refused — refusing 100% of the
 * deployment's own objects while looking configured.
 */
describe('#3611 — a non-identifier LOOM_SERVERLESS_DB cannot desync mint and guard', () => {
  for (const raw of ['loom-lakehouse', 'Loom.Lakehouse', 'loom lakehouse', 'loom$lakehouse']) {
    it(`sanitizes ${JSON.stringify(raw)} so the minted object is still accepted`, async () => {
      process.env.LOOM_SERVERLESS_DB = raw;
      try {
        const sanitized = raw.replace(/[^a-z0-9_]+/gi, '_');
        // The guard follows the SANITIZED database name...
        expect(isMintedEngineObject(`${sanitized}.shortcuts.sc_x`, 'synapse')).toBe(true);
        // ...and the raw value is not silently also accepted.
        expect(isMintedEngineObject(`${raw}.shortcuts.sc_x`, 'synapse')).toBe(false);

        // The SINK agrees with the guard — this is the property that matters:
        // the DROP runs against the same database name the guard admitted.
        await dropShortcutObject({ engine: 'synapse', engineObject: `${sanitized}.shortcuts.sc_x` });
        expect((executeQuery as any).mock.calls[0][0]).toEqual({ db: sanitized });
      } finally {
        delete process.env.LOOM_SERVERLESS_DB;
      }
    });
  }

  it('never yields an EMPTY database name, which would refuse everything', () => {
    // An empty `parts[0]` is unmatchable, so it would refuse 100% of this
    // deployment's own objects. Two distinct paths have to be checked, because
    // only ONE of them reaches the `|| 'loom_lakehouse'` fallback:
    //   - all-whitespace trims to '' and DOES hit the fallback;
    //   - all-separator does NOT — `[^a-z0-9_]+` collapses the run to '_',
    //     which is itself a legal identifier. (Written the other way round
    //     first, and this assertion is what caught it.)
    const cases: Array<[string, string]> = [
      ['---', '_'],
      ['...', '_'],
      ['   ', 'loom_lakehouse'], // trims to empty → fallback
      ['   spaced   ', 'spaced'], // trim happens BEFORE the replace
      ['_', '_'],
    ];
    for (const [raw, expected] of cases) {
      process.env.LOOM_SERVERLESS_DB = raw;
      try {
        expect(expected).toMatch(/^[A-Za-z0-9_]+$/);
        expect(isMintedEngineObject(`${expected}.shortcuts.sc_x`, 'synapse'), `${JSON.stringify(raw)} → ${expected}`).toBe(true);
      } finally {
        delete process.env.LOOM_SERVERLESS_DB;
      }
    }
  });
});
