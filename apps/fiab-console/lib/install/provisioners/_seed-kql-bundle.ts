/**
 * Shared KQL-bundle applier — turn a `KqlDatabaseContent` bundle into real ADX
 * tables, rows, functions and policies inside an EXISTING database.
 *
 * Lifted verbatim out of `kql-db.ts` (steps 2-4 of `kqlDatabaseProvisioner`,
 * plus the private helpers those steps depend on) so that the INSTALL path and
 * the OPEN-time auto-bind path (`lib/azure/auto-bind-seed.seedKqlDatabaseFromContent`)
 * apply a bundle the same way. Before #3549 only install applied it; auto-bind's
 * `create()` made the database and stopped, so a gated install left a real but
 * permanently EMPTY database that answered every query with "no results".
 *
 * Every quirk-fix below is load-bearing and was learned from a live failure —
 * which is precisely why this must not be re-implemented a second time:
 *   - `.alter-merge … policy caching` is not a real command (SYN0002).
 *   - a `$table` templating placeholder never resolves (SEM0100).
 *   - a control command must lead with `.` (SYN0100), so leading `//` comment
 *     lines have to be trimmed.
 *   - `.ingest inline` can silently land zero shards, so seeds are VERIFIED and
 *     fall back to a transactional `.set-or-append`.
 *   - `.ingest inline` APPENDS, so a seed must COUNT BEFORE IT INGESTS. Both
 *     the install path and the auto-bind path apply the bundle to the SAME
 *     database on one install, and an unconditional ingest duplicated every
 *     sample row while the `present >= expected` verify still reported success.
 *   - ingest-class commands throttle at Ingestion capacity 1 and must back off.
 *
 * The caller owns the DATABASE lifecycle (ARM create + readiness) and owns
 * turning `authGate` into its own remediation shape. This module only applies
 * content to a database that is already there.
 */
import { executeMgmtCommand, executeQuery, ingestInline, KustoError } from '@/lib/azure/kusto-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalize a single ADX policy control command to a form the engine accepts.
 *
 * Live failure (SYN0002): some content bundles author the caching policy as
 * `.alter-merge table X policy caching hot = 7d`. There is NO `-merge` variant
 * of the caching policy command — per Microsoft Learn (".alter table policy
 * caching command") the ONLY accepted form is the whole-policy set:
 *   `.alter table <T> policy caching hot = <timespan>`
 *   `.alter table <T> policy caching hot = <timespan>, hot_window = datetime(..) .. datetime(..)`
 * The `.alter-merge` keyword exists for OTHER policies (e.g. retention,
 * sharding) but not caching, so `.alter-merge … policy caching …` is rejected
 * with SYN0002 recognition error. We rewrite the `-merge` token to the plain
 * `.alter` form ONLY for caching commands (caching has no merge semantics — it
 * is a single hot=<span>[+windows] value, so set and merge are equivalent),
 * leaving every other `.alter-merge` policy command untouched.
 *   https://learn.microsoft.com/kusto/management/alter-table-cache-policy-command
 *   https://learn.microsoft.com/kusto/management/alter-database-cache-policy-command
 */
export function normalizePolicyCommand(cmd: string): string {
  if (/^\.alter-merge\b/i.test(cmd) && /\bpolicy\s+caching\b/i.test(cmd)) {
    return cmd.replace(/^\.alter-merge\b/i, '.alter');
  }
  return cmd;
}

/**
 * Resolve unsubstituted KQL placeholders in a function body so it compiles.
 *
 * Live failure (SEM0100): a content bundle authored a detection function whose
 * `union` projection captures the contributing source table as
 * `source_table = $table`. `$table` is NOT a valid Kusto column reference in a
 * `union | project` — it was a templating placeholder that was never
 * substituted, so the engine fails to resolve it (SEM0100, unresolved name).
 *
 * The CORRECT, documented way to capture which source table contributed each
 * row in a `union` is the `withsource=<ColumnName>` parameter (Microsoft Learn,
 * "union operator"). So we rewrite:
 *   union A, B                                  → union withsource=source_table A, B
 *   | project … source_table = $table, …        → | project … source_table, …
 * preserving the function's OUTPUT SCHEMA exactly.
 *   https://learn.microsoft.com/kusto/query/union-operator#parameters
 *
 * Guarded so it is a no-op for any body that does not contain the `$table`
 * placeholder, so well-formed bundle functions pass through untouched.
 */
export function resolveFunctionPlaceholders(body: string): string {
  if (!/\$table\b/.test(body)) return body;
  let out = body;
  out = out.replace(/\bunion\b(?![^\n]*\bwithsource=)/i, 'union withsource=source_table');
  out = out.replace(/\bsource_table\s*=\s*\$table\b/gi, 'source_table');
  out = out.replace(/\$table\b/g, 'source_table');
  return out;
}

/**
 * A throttled ingest/set-or-append is a transient, retryable condition — NOT a
 * hard failure. On a small/shared ADX cluster the Ingestion capacity policy can
 * be as low as 1 concurrent operation, so the 2nd/3rd/4th table seed in a tight
 * loop is aborted with HTTP 429 / `ControlCommandThrottledException`. Microsoft
 * Learn (Capacity policy → "Management commands throttling") states the
 * documented client remedy is exactly that: retry after backoff.
 *   https://learn.microsoft.com/kusto/management/capacity-policy#management-commands-throttling
 */
function isThrottled(e: any): boolean {
  if (e instanceof KustoError && e.status === 429) return true;
  const msg = (e?.message || String(e || '')).toString();
  return /throttl|TooManyRequests|ControlCommandThrottled|CapacityPolicy\/Ingestion/i.test(msg);
}

/**
 * Run an ingest-class command (`.ingest inline` / `.set-or-append`) with
 * exponential backoff + full jitter on throttling (HTTP 429). Re-throws
 * non-throttle errors immediately (so 401/403 still surface to the caller's
 * AllDatabasesAdmin gate) and re-throws the final throttle error once the
 * attempt budget is exhausted.
 */
async function withIngestRetry<T>(
  op: () => Promise<T>,
  label: string,
  steps: string[],
  opts: { maxAttempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 4_000;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const r = await op();
      if (attempt > 1) steps.push(`${label} succeeded on attempt ${attempt}.`);
      return r;
    } catch (e: any) {
      lastErr = e;
      if (!isThrottled(e)) throw e; // auth / schema → surface immediately
      if (attempt === maxAttempts) break;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
      const wait = Math.round(backoff / 2 + Math.random() * (backoff / 2));
      steps.push(`${label} throttled (attempt ${attempt}/${maxAttempts}); backing off ${Math.round(wait / 1000)}s.`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * Render a single scalar as a Kusto `datatable()` literal cell for the given
 * column type. Used by the `.set-or-append <table> <| datatable(...) [...]`
 * fallback seed path. Grounded in Microsoft Learn (datatable operator):
 *   https://learn.microsoft.com/kusto/query/datatable-operator
 */
export function kqlLiteral(value: unknown, type: string): string {
  const t = (type || 'string').toLowerCase();
  if (value === null || value === undefined || value === '') {
    if (t === 'string') return '""';
    if (t === 'datetime') return 'datetime(null)';
    if (t === 'bool' || t === 'boolean') return 'bool(null)';
    if (t === 'real' || t === 'double' || t === 'decimal') return 'real(null)';
    if (t === 'long' || t === 'int') return 'long(null)';
    return '""';
  }
  if (t === 'datetime') return `datetime(${String(value).replace(/[)"\\]/g, '')})`;
  if (t === 'bool' || t === 'boolean') {
    const b = value === true || value === 'true' || value === 1 || value === '1';
    return b ? 'true' : 'false';
  }
  if (t === 'long' || t === 'int' || t === 'real' || t === 'double' || t === 'decimal') {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : (t === 'real' || t === 'double' || t === 'decimal' ? 'real(null)' : 'long(null)');
  }
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Seed a table's sample rows so they are ACTUALLY queryable when this returns —
 * never a misleading "ingested" with zero rows landed.
 *
 * `.ingest inline` is *direct* ingestion (Microsoft Learn: "intended for
 * exploration and prototyping … don't use in production") with NO automatic
 * retry, and against a freshly-created table it can intermittently produce zero
 * data shards. So we:
 *   0. COUNT FIRST and skip entirely when the rows are already there — ingest
 *      APPENDS, and since #3549 two callers apply the same bundle to the same
 *      database on one install, so an unconditional ingest duplicates the data.
 *   1. Try `.ingest inline`, then VERIFY with `<table> | count`.
 *   2. If the count is short, fall back to `.set-or-append <table> <|
 *      datatable(<schema>) [<rows>]` — a single transactional control command
 *      whose extent is committed and queryable the moment it returns — then
 *      verify the count again.
 * Returns true once the expected row count is present. Never throws for data
 * errors — 401/403 are re-thrown so the caller maps them to the
 * AllDatabasesAdmin remediation.
 */
async function seedTableRows(
  dbName: string,
  table: string,
  columns: { name: string; type: string }[],
  rows: any[][],
  steps: string[],
): Promise<boolean> {
  const expected = rows.length;
  const countRows = async (): Promise<number> => {
    try {
      const r = await executeQuery(dbName, `["${table}"] | count`);
      const n = Number(r.rows?.[0]?.[0]);
      return Number.isFinite(n) ? n : 0;
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
      return 0;
    }
  };

  try {
    // COUNT FIRST. `.ingest inline` APPENDS — it does not replace — so an
    // unconditional ingest DUPLICATES every row of a bundle that has already
    // been applied. Since #3549 there are TWO callers against the same
    // database on a single install (open/create-time `seedFromContent` and
    // Phase 2 `kqlDatabaseProvisioner`), so this is the normal path, not an
    // edge case.
    //
    // It was self-concealing: the verify below is `present >= expected`, so 2N
    // rows PASSES and logs "Seeded N row(s) (verified 2N)" — a status line that
    // asserts something untrue (deploy-integrity R7). The pre-count is what
    // makes this applier genuinely idempotent, which is the property both its
    // own header and `kql-db.ts`'s claim.
    //
    // `>= expected` rather than `=== expected` deliberately: a table the user
    // has since appended to must NOT be re-seeded either.
    const already = await countRows();
    if (already >= expected) {
      steps.push(`Sample rows for ${table} are already present (${already} row(s)); skipping ingest.`);
      return true;
    }
    await withIngestRetry(() => ingestInline(dbName, table, rows), `Inline ingest into ${table}`, steps);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
    steps.push(`Inline ingest into ${table} threw: ${e?.message || String(e)} — will try .set-or-append.`);
  }
  await sleep(1_500);
  let present = await countRows();
  if (present >= expected) {
    steps.push(`Seeded ${expected} row(s) into ${table} (verified ${present}).`);
    return true;
  }

  const schema = columns.map((c) => `${c.name}:${(c.type || 'string').toLowerCase()}`).join(', ');
  const literals = rows
    .map((row) => columns.map((c, i) => kqlLiteral(row[i], c.type)).join(', '))
    .join(',\n  ');
  const setCmd = `.set-or-append ["${table}"] <|\n  datatable(${schema}) [\n  ${literals}\n]`;
  try {
    await withIngestRetry(() => executeMgmtCommand(dbName, setCmd), `.set-or-append into ${table}`, steps);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
    steps.push(`.set-or-append into ${table} failed: ${e?.message || String(e)}`);
    return false;
  }
  present = await countRows();
  if (present >= expected) {
    steps.push(`Seeded ${expected} row(s) into ${table} via .set-or-append (verified ${present}).`);
    return true;
  }
  steps.push(`Seed into ${table} short: expected ${expected}, found ${present} after inline + .set-or-append.`);
  return false;
}

/** What the bundle apply actually achieved. The caller decides what is fatal. */
export interface KqlBundleApplyResult {
  /** Tables declared by the bundle. */
  declaredTables: number;
  /** `.create table` commands that failed. */
  tableCreateFailures: number;
  /** Tables that declared sample rows (the seed denominator). */
  expectedSeedTables: number;
  /** Tables whose rows did NOT land after inline + `.set-or-append`. */
  ingestFailures: number;
  /** `.create-or-alter function` commands that failed. */
  functionFailures: number;
  /** All policy commands that failed (tuning + correctness). */
  policyFailures: number;
  /**
   * `.alter … policy update` failures only. An update policy fans raw rows into
   * a curated table, so its failure breaks end-to-end correctness and stays
   * fatal even when tables + rows landed — unlike caching/retention tuning.
   */
  criticalPolicyFailures: number;
  /**
   * Set when a 401/403 aborted the apply. The caller maps it to its own
   * remediation shape; `phase` names which command class was refused.
   */
  authGate?: { status: number; message: string; phase: string };
}

/**
 * Apply a `KqlDatabaseContent` bundle to an EXISTING, queryable ADX database.
 *
 * Never throws for data/schema errors — every failure is counted and logged
 * into `steps`. A 401/403 short-circuits into `authGate` because no amount of
 * retrying fixes a missing role, and the caller needs to name it precisely.
 */
export async function applyKqlBundle(
  dbName: string,
  content: any,
  steps: string[],
): Promise<KqlBundleApplyResult> {
  const out: KqlBundleApplyResult = {
    declaredTables: 0,
    tableCreateFailures: 0,
    expectedSeedTables: 0,
    ingestFailures: 0,
    functionFailures: 0,
    policyFailures: 0,
    criticalPolicyFailures: 0,
  };

  const isAuth = (e: any) => e instanceof KustoError && (e.status === 401 || e.status === 403);

  // ── Tables + sample rows ────────────────────────────────────────────────
  const tables: Array<{ name: string; columns: { name: string; type: string }[]; sample?: any[][] }> =
    Array.isArray(content?.tables) ? content.tables : [];
  out.declaredTables = tables.length;
  for (const t of tables) {
    const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    try {
      await executeMgmtCommand(dbName, `.create table ${t.name} (${cols})`);
      steps.push(`.create table ${t.name} OK.`);
    } catch (e: any) {
      if (isAuth(e)) {
        out.authGate = { status: e.status, message: e?.message || String(e), phase: '.create table' };
        return out;
      }
      out.tableCreateFailures += 1;
      steps.push(`.create table ${t.name} failed: ${e?.message || String(e)}`);
    }
    if (Array.isArray(t.sample) && t.sample.length > 0) {
      out.expectedSeedTables += 1;
      try {
        const ok = await seedTableRows(dbName, t.name, t.columns, t.sample, steps);
        if (!ok) out.ingestFailures += 1;
      } catch (e: any) {
        if (isAuth(e)) {
          out.authGate = { status: e.status, message: e?.message || String(e), phase: 'ingest' };
          return out;
        }
        out.ingestFailures += 1;
        steps.push(`Seed into ${t.name} failed: ${e?.message || String(e)}`);
      }
    }
  }

  // ── Functions ───────────────────────────────────────────────────────────
  //
  // A function `body` carries one of two shapes:
  //   (a) a COMPLETE control command — `.create-or-alter function Name(args)
  //       { … }` (optionally preceded by `//` comment lines). This is the shape
  //       every content bundle uses, because functions with parameters can only
  //       be expressed as a full command. These must run VERBATIM; re-wrapping
  //       them produces a nested, malformed command (SYN0002 "Expected: }").
  //   (b) a bare function body expression — wrap it as
  //       `.create-or-alter function Name { <body> }`.
  //
  // CRITICAL (ADX SYN0100): a management command is identified by its FIRST
  // non-whitespace character being a dot. Bundles author shape (a) with leading
  // `//` comments for readability, so sending verbatim makes the first char `/`
  // and ADX rejects it. We trim the leading blank/comment run so the dot leads.
  const fns: Array<{ name: string; body: string }> = Array.isArray(content?.functions) ? content.functions : [];
  for (const fn of fns) {
    const body = resolveFunctionPlaceholders(String(fn.body ?? ''));
    const lines = body.split(/\r?\n/);
    const firstCodeIdx = lines.findIndex((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//');
    });
    const firstCodeLine = firstCodeIdx >= 0 ? lines[firstCodeIdx].trim() : undefined;
    const isFullCommand = /^\.create(-or-alter)?\s+function\b/i.test(firstCodeLine ?? '');
    const dotLedBody = firstCodeIdx >= 0 ? lines.slice(firstCodeIdx).join('\n') : body;
    const cmd = isFullCommand ? dotLedBody : `.create-or-alter function ${fn.name} { ${body} }`;
    try {
      await executeMgmtCommand(dbName, cmd);
      steps.push(`.create-or-alter function ${fn.name} OK.`);
    } catch (e: any) {
      if (isAuth(e)) {
        out.authGate = { status: e.status, message: e?.message || String(e), phase: '.create-or-alter function' };
        return out;
      }
      out.functionFailures += 1;
      steps.push(`.create-or-alter function ${fn.name} failed: ${e?.message || String(e)}`);
    }
  }

  // ── Ingestion / table policies ──────────────────────────────────────────
  //
  // The bundle's `policy` field carries one of two shapes:
  //   (a) a complete control script — one-or-more `.alter` / `.alter-merge`
  //       policy commands, possibly multi-line. Executed VERBATIM, one command
  //       per line. Wrapping them would malform them.
  //   (b) a raw ingestion-batching policy JSON body (legacy shape) — wrapped in
  //       the documented `.alter table <t> policy ingestionbatching @'…'`.
  const policies: Array<{ table: string; policy: string }> =
    Array.isArray(content?.ingestionPolicies) ? content.ingestionPolicies : [];
  for (const p of policies) {
    const raw = String(p.policy ?? '');
    const isControlScript = /^\s*\.alter(-merge)?\b/i.test(raw);
    if (isControlScript) {
      const commands = raw
        .split(/\r?\n/)
        // Collapse internal whitespace runs. Policy control commands are
        // keyword=value DDL with no whitespace-significant literals, and the
        // Kusto parser rejects hand-aligned multi-space formatting (SYN0002).
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .filter((l) => l.length > 0)
        .map((l) => normalizePolicyCommand(l));
      for (const cmd of commands) {
        const isUpdatePolicy = /\bpolicy\s+update\b/i.test(cmd);
        try {
          await executeMgmtCommand(dbName, cmd);
          steps.push(`Policy command on ${p.table} OK: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`);
        } catch (e: any) {
          out.policyFailures += 1;
          if (isUpdatePolicy) out.criticalPolicyFailures += 1;
          steps.push(`Policy command on ${p.table} failed (${cmd.slice(0, 60)}…): ${e?.message || String(e)}`);
        }
      }
    } else {
      try {
        await executeMgmtCommand(dbName, `.alter table ${p.table} policy ingestionbatching @'${escapeSqlLiteral(raw)}'`);
        steps.push(`.alter ingestionbatching policy on ${p.table} OK.`);
      } catch (e: any) {
        out.policyFailures += 1;
        steps.push(`.alter ingestionbatching policy on ${p.table} failed: ${e?.message || String(e)}`);
      }
    }
  }

  return out;
}
