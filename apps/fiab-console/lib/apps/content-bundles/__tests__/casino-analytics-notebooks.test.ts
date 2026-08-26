/**
 * #4093 — the Casino Analytics notebooks must only reference data the bundle
 * actually creates.
 *
 * THE DEFECT THIS GUARDS
 * ──────────────────────
 * Both notebooks shipped the upstream Databricks source verbatim, so their
 * cells read `silver.slv_slot_events` and `silver.slv_fnb_transactions`. The
 * bundle creates neither: it provisions a `casino` star schema and seeds 24
 * rows into it. The notebooks therefore provisioned cleanly, rendered
 * authoritative-looking code, and failed the moment a cell was run — the
 * `no-vaporware.md` D-grade "renders but does nothing", and a demo landmine.
 *
 * These tests derive the set of tables and columns the bundle's OWN DDL creates
 * and assert every warehouse reference in the notebook cells resolves against
 * it. The expected set is DERIVED, never hardcoded, so it cannot drift away
 * from the DDL, and every check asserts a non-empty population first — a scan
 * that found nothing to check is a finding, not a pass.
 *
 * They also pin the small-sample behaviour. The seed is deliberately tiny (5
 * players / 5 machines / 24 rows total), so an analysis that needs hundreds of
 * rows would "run" and emit a hollow result — the same dead-data-path failure
 * in a different costume. `pd.qcut` raises on tied/small samples, and a KMeans
 * k sweep with a fixed literal upper bound throws when k > n-1.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { getBundle } from '../index';
import { knownPlaceholderNames } from '@/lib/apps/notebook-placeholders';
import type { AppBundle } from '../types';
import type { NotebookCell } from '@/lib/types/notebook-cell';

const BUNDLE_ID = 'app-casino-analytics';
const SCHEMA = 'casino';

let bundle: AppBundle;

beforeAll(async () => {
  bundle = (await getBundle(BUNDLE_ID)) as AppBundle;
  expect(bundle, `${BUNDLE_ID} loads`).toBeDefined();
});

// ── helpers ────────────────────────────────────────────────────────────────

function warehouseDdl(b: AppBundle): string {
  const wh = b.items.find((i) => i.itemType === 'warehouse');
  const ddl = (wh?.content as { ddl?: string })?.ddl;
  expect(ddl, 'the bundle ships warehouse DDL').toBeTruthy();
  return ddl as string;
}

/**
 * Parse `CREATE TABLE casino.<name> ( … )` blocks out of the bundle's own DDL
 * into table -> column-name set. Derived from the DDL rather than restated, so
 * the assertion can never drift from what is actually provisioned.
 */
function parseDdlTables(ddl: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const block = new RegExp(`CREATE TABLE\\s+${SCHEMA}\\.(\\w+)\\s*\\(\\n([\\s\\S]*?)\\n\\)`, 'g');
  for (const m of ddl.matchAll(block)) {
    const cols = new Set<string>();
    for (const line of m[2].split('\n')) {
      const col = /^\s{2,}([a-z_][a-z0-9_]*)\s+[A-Z]/.exec(line);
      if (col && !/^\s*CONSTRAINT\b/i.test(line)) cols.add(col[1]);
    }
    tables.set(m[1], cols);
  }
  return tables;
}

interface Notebook { name: string; code: string }

function notebooks(b: AppBundle): Notebook[] {
  return b.items
    .filter((i) => i.itemType === 'notebook')
    .map((i) => ({
      name: i.displayName,
      code: (((i.content as { cells?: NotebookCell[] }).cells) || [])
        .filter((c) => c.type === 'code')
        .map((c) => c.source)
        .join('\n'),
    }));
}

function allMatches(code: string, re: RegExp, group = 1): string[] {
  return [...code.matchAll(re)].map((m) => m[group]).filter(Boolean);
}

/** Column-shaped literals in every position that reads a column off a frame. */
function referencedColumns(code: string): string[] {
  const out: string[] = [];
  // df[[ "a", "b" ]] projections (including `… ] + other + [ "c" ]]` forms).
  for (const m of code.matchAll(/\[\[([\s\S]*?)\]\]/g)) {
    out.push(...allMatches(m[1], /"([a-z_][a-z0-9_]*)"/g));
  }
  // Named aggregations: out_name=("source_column", "aggfunc") — source only.
  out.push(...allMatches(code, /\w+=\(\s*"([a-z_][a-z0-9_]*)"\s*,/g));
  // Merge keys, dropna subsets, groupby keys, sort keys.
  out.push(...allMatches(code, /\bon="([a-z_][a-z0-9_]*)"/g));
  out.push(...allMatches(code, /\bsubset=\["([a-z_][a-z0-9_]*)"\]/g));
  out.push(...allMatches(code, /\.groupby\(\s*"([a-z_][a-z0-9_]*)"\s*\)/g));
  out.push(...allMatches(code, /\.sort_values\(\s*\[?\s*"([a-z_][a-z0-9_]*)"/g));
  // Column-selection lists assigned to a named variable, and the save_gold
  // column argument.
  for (const m of code.matchAll(/(?:measures|features|cols|value_cols)\s*=\s*\[([\s\S]*?)\]/g)) {
    out.push(...allMatches(m[1], /"([a-z_][a-z0-9_]*)"/g));
  }
  for (const m of code.matchAll(/save_gold\([^,]+,\s*"[^"]+",\s*\n?\s*\[([\s\S]*?)\]\)/g)) {
    out.push(...allMatches(m[1], /"([a-z_][a-z0-9_]*)"/g));
  }
  // frame["column"] reads.
  out.push(...allMatches(code, /\b\w+\["([a-z_][a-z0-9_]*)"\]/g));
  return out;
}

/** Names the notebook DEFINES itself, which are therefore not DDL columns. */
function derivedNames(code: string): Set<string> {
  const out = new Set<string>();
  // frame["name"] = …  assignments
  for (const n of allMatches(code, /\w+\["([a-z_][a-z0-9_]*)"\]\s*=[^=]/g)) out.add(n);
  // Named-aggregation OUTPUT names: out_name=("src", "agg")
  for (const n of allMatches(code, /\b([a-z_][a-z0-9_]*)=\(\s*"[a-z_]/g)) out.add(n);
  // Dict-literal keys (result/meta dicts, pd.DataFrame({...}) construction)
  for (const n of allMatches(code, /"([a-z_][a-z0-9_]*)"\s*:/g)) out.add(n);
  // The warehouse TABLE names passed to read_warehouse are not columns.
  for (const n of allMatches(code, /read_warehouse\(\s*"([a-z_][a-z0-9_]*)"\s*\)/g)) out.add(n);
  return out;
}

// ── the guard ──────────────────────────────────────────────────────────────

describe('casino notebooks reference only tables the bundle creates', () => {
  it('the DDL parse finds the full star schema (positive control for the guard)', () => {
    const tables = parseDdlTables(warehouseDdl(bundle));
    expect([...tables.keys()].sort()).toEqual(
      ['dim_date', 'dim_player', 'dim_table', 'fact_handle', 'fact_session'],
    );
    // If the column parse silently found nothing, every later assertion would
    // pass vacuously.
    for (const [name, cols] of tables) {
      expect(cols.size, `${name} columns parsed`).toBeGreaterThan(5);
    }
    expect(tables.get('fact_session')!.has('theoretical_win')).toBe(true);
    expect(tables.get('dim_player')!.has('last_visit_date')).toBe(true);
  });

  it('every read_warehouse() names a table the DDL provisions', () => {
    const created = new Set(parseDdlTables(warehouseDdl(bundle)).keys());
    let total = 0;
    for (const nb of notebooks(bundle)) {
      const read = allMatches(nb.code, /read_warehouse\(\s*"(\w+)"\s*\)/g);
      expect(read.length, `${nb.name} reads at least one warehouse table`).toBeGreaterThan(0);
      total += read.length;
      for (const table of read) {
        expect(
          created.has(table),
          `${nb.name}: reads ${SCHEMA}.${table}, which the bundle DDL never creates ` +
            `(created: ${[...created].sort().join(', ')})`,
        ).toBe(true);
      }
    }
    expect(total, 'warehouse reads found across the notebooks').toBeGreaterThan(4);
  });

  it('no cell reads a silver/bronze table — the exact #4093 regression', () => {
    for (const nb of notebooks(bundle)) {
      expect(nb.code, `${nb.name} must not read a silver/bronze source`).not.toMatch(
        /["'](?:silver|bronze)\./,
      );
      // slv_/brz_ are the dbt model prefixes the old cells named directly.
      expect(nb.code, `${nb.name} must not name a dbt silver/bronze model`).not.toMatch(
        /\b(?:slv|brz)_\w+/,
      );
      // spark.table() reaches the Spark metastore; the warehouse is a dedicated
      // SQL pool, so a warehouse read via spark.table() can never resolve.
      expect(nb.code, `${nb.name} must not spark.table() a casino warehouse table`).not.toMatch(
        new RegExp(`spark\\.table\\(\\s*["']${SCHEMA}\\.`),
      );
    }
  });

  it('every column read off a warehouse frame exists in the DDL', () => {
    const tables = parseDdlTables(warehouseDdl(bundle));
    const ddlColumns = new Set<string>();
    for (const cols of tables.values()) for (const c of cols) ddlColumns.add(c);

    for (const nb of notebooks(bundle)) {
      const derived = derivedNames(nb.code);
      const referenced = referencedColumns(nb.code);
      expect(referenced.length, `${nb.name} column references found`).toBeGreaterThan(30);
      const unknown = [...new Set(referenced)]
        .filter((c) => !ddlColumns.has(c) && !derived.has(c))
        .sort();
      expect(
        unknown,
        `${nb.name}: these names are neither a casino.* DDL column nor defined ` +
          `by the notebook itself, so they cannot resolve at run time`,
      ).toEqual([]);
    }
  });
});

describe('casino notebooks degrade gracefully at seed scale', () => {
  it('RFM scoring does not CALL pd.qcut (it raises on tied/small samples)', () => {
    for (const nb of notebooks(bundle)) {
      // The word appears in the comment explaining why it is not used; the
      // CALL is what would break at seed scale.
      expect(nb.code, `${nb.name} must not bin with qcut`).not.toMatch(/\bqcut\s*\(/);
    }
    // …and the replacement is actually present.
    const pva = notebooks(bundle).find((n) => n.name === 'Player Value Analysis')!;
    expect(pva.code).toMatch(/\.rank\(pct=True/);
  });

  it('the KMeans k sweep upper bound is DERIVED from the machine count', () => {
    const floor = notebooks(bundle).find((n) => n.name === 'Floor Optimization')!;
    // silhouette_score requires 2 <= k <= n-1; a fixed literal throws on a
    // small floor. The bound must reference n.
    expect(floor.code).toMatch(/k_max\s*=\s*min\([^)]*n\s*-\s*1\)/);
    expect(floor.code).toMatch(/range\(2,\s*k_max \+ 1\)/);
    expect(floor.code, 'no fixed k range').not.toMatch(/range\(2,\s*\d+\)/);
    // and the un-clusterable case is handled rather than thrown.
    expect(floor.code).toMatch(/if k_max < 2:/);
  });

  it('each model states its row count and whether metrics are hold-out', () => {
    for (const nb of notebooks(bundle)) {
      if (!/train_test_split/.test(nb.code)) continue;
      expect(nb.code, `${nb.name} prints the validation basis`).toContain('Validation basis');
      expect(nb.code, `${nb.name} labels a non-generalising fit`).toContain('IN-SAMPLE');
      expect(nb.code, `${nb.name} has a hold-out threshold`).toMatch(
        /MIN_(?:ROWS|MACHINES)_FOR_HOLDOUT\s*=\s*\d+/,
      );
    }
  });

  it('below the hold-out threshold it CROSS-VALIDATES instead of reporting a fit', () => {
    // An in-sample fit on 5 rows returns F1/R2 ≈ perfect and means nothing.
    // Leave-one-out is the honest validation at that scale and still yields a
    // real number, so the small-sample path is informative rather than hollow.
    for (const nb of notebooks(bundle)) {
      if (!/train_test_split/.test(nb.code)) continue;
      expect(nb.code, `${nb.name} has a LOOCV threshold`).toMatch(
        /MIN_(?:ROWS|MACHINES)_FOR_LOOCV\s*=\s*\d+/,
      );
      expect(nb.code, `${nb.name} branches into LOOCV on the threshold`).toMatch(
        /elif n >= MIN_(?:ROWS|MACHINES)_FOR_LOOCV/,
      );
      expect(nb.code).toContain('LeaveOneOut');
      expect(nb.code).toContain('cross_val_predict');
      // Scaling must sit INSIDE the estimator so it is re-fit per fold; a
      // scaler fitted on all rows leaks the held-out row into training and
      // inflates every cross-validated number.
      expect(
        nb.code,
        `${nb.name} scales inside the pipeline so CV folds do not leak`,
      ).toMatch(/make_pipeline\(\s*\n?\s*StandardScaler\(\)/);
    }
  });

  it('a zero-row read is raised as a finding, never analysed as a pass', () => {
    for (const nb of notebooks(bundle)) {
      expect(nb.code, `${nb.name} treats an empty warehouse read as an error`).toMatch(
        /if len\(pdf\) == 0:[\s\S]{0,120}raise RuntimeError/,
      );
      expect(nb.code, `${nb.name} verifies a gold write by reading it back`).toMatch(
        /if written == 0:[\s\S]{0,80}raise RuntimeError/,
      );
    }
  });
});

describe('casino notebooks are runnable on the Azure-native default engine', () => {
  it('read the dedicated SQL pool with the Synapse Spark connector', () => {
    for (const nb of notebooks(bundle)) {
      expect(nb.code, `${nb.name} uses spark.read.synapsesql`).toContain(
        'spark.read.synapsesql',
      );
      // Three-part name: <pool>.<schema>.<table>.
      expect(nb.code).toMatch(/"%s\.%s\.%s" % \(WAREHOUSE_DB, WAREHOUSE_SCHEMA, table\)/);
    }
  });

  it('resolve the pool without any user-performed binding step', () => {
    for (const nb of notebooks(bundle)) {
      // Install-time substitution is the default; parameter / spark.conf override.
      expect(nb.code, `${nb.name} carries the install-substituted pool token`).toContain(
        '{{SYNAPSE_DEDICATED_POOL}}',
      );
      expect(nb.code).toContain('loom_get_arg("warehouse_db")');
      expect(nb.code).toContain('spark.conf.get("spark.loom.warehouseDb"');
      // …and fails honestly rather than querying a literal-brace database name.
      expect(nb.code).toMatch(/if not WAREHOUSE_DB or "\{\{" in WAREHOUSE_DB:/);
    }
  });

  it('ship the backend-util shim so loom_get_arg is defined on any engine', () => {
    for (const item of bundle.items.filter((i) => i.itemType === 'notebook')) {
      const cells = (item.content as { cells: NotebookCell[] }).cells;
      const shim = cells.find((c) => c.type === 'code' && /def loom_get_arg/.test(c.source));
      expect(shim, `${item.displayName} ships the backend-util shim cell`).toBeDefined();
      // The shim must precede the setup cell that calls loom_get_arg.
      const shimAt = cells.indexOf(shim!);
      const callerAt = cells.findIndex(
        (c) => c.type === 'code' && /loom_get_arg\("warehouse_db"\)/.test(c.source),
      );
      expect(callerAt, 'a cell calls loom_get_arg("warehouse_db")').toBeGreaterThan(-1);
      expect(shimAt).toBeLessThan(callerAt);
    }
    // …and the setup cell still works if the shim cell is skipped.
    for (const nb of notebooks(bundle)) {
      expect(nb.code).toContain('if "loom_get_arg" not in globals():');
    }
  });

  it('never hard-depend on MLflow — Synapse Spark ships no tracking server', () => {
    for (const nb of notebooks(bundle)) {
      const lines = nb.code.split('\n');
      const imports = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /^\s*import mlflow\b/.test(l));
      expect(imports.length, `${nb.name} imports mlflow somewhere`).toBeGreaterThan(0);
      for (const { i } of imports) {
        const before = lines.slice(Math.max(0, i - 2), i).map((s) => s.trim());
        expect(
          before.includes('try:'),
          `${nb.name}: line ${i + 1} imports mlflow outside a try/except — a missing ` +
            `mlflow would break the whole run`,
        ).toBe(true);
      }
      expect(nb.code, `${nb.name} tolerates a missing mlflow`).toMatch(/except ImportError:/);
    }
  });
});

describe('every placeholder this bundle ships is one the substituter can resolve', () => {
  /**
   * Scoped to the casino bundle deliberately. Other bundles carry
   * placeholder-shaped strings that are NOT Loom deployment tokens — escaped
   * f-string braces (`{{2}}`) and customer-supplied secret names
   * (`{{DB2_ZOS_TRUSTSTORE_PASSWORD}}`) — and conscripting them into this
   * ratchet would fail unrelated PRs for a pre-existing condition.
   */
  it('the casino notebooks ship no token the substituter cannot fill in', () => {
    const known = new Set(knownPlaceholderNames());
    expect(known.size, 'the substituter knows at least one token').toBeGreaterThan(0);
    let seen = 0;
    for (const item of bundle.items) {
      for (const cell of ((item.content as { cells?: NotebookCell[] })?.cells) || []) {
        for (const m of cell.source.matchAll(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
          seen += 1;
          expect(
            known.has(m[1]),
            `${BUNDLE_ID} / "${item.displayName}" ships {{${m[1]}}}, which ` +
              `lib/apps/notebook-placeholders.ts cannot resolve — it would reach ` +
              `the runtime as a literal and fail there`,
          ).toBe(true);
        }
      }
    }
    // Both notebooks carry {{SYNAPSE_DEDICATED_POOL}}; a zero here would mean
    // the scan found nothing to check.
    expect(seen, 'placeholder tokens found in the casino notebooks').toBeGreaterThan(1);
  });
});
