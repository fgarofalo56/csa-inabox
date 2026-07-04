/**
 * Phase 2 — KQL Database provisioner.
 *
 * Real REST: ARM PUT /Microsoft.Kusto/clusters/{cluster}/databases/{name}
 * to create the database (calls kusto-client.createDatabase()), then
 * runs each `.create table` and `.alter policy` from the bundle via
 * kusto-client.executeMgmtCommand(), and ingests bundled sample rows
 * via .ingest inline.
 *
 * Idempotency: createDatabase is idempotent via ARM PUT; if the DB
 * already exists, ARM returns Succeeded.  `.create table` is also
 * idempotent in Kusto.
 *
 * Remediation gates:
 *   - LOOM_KUSTO_CLUSTER_URI missing → set it.
 *   - 401/403 on .create table → UAMI needs AllDatabasesAdmin on the cluster.
 */
import { createDatabase, executeMgmtCommand, executeQuery, ingestInline, KustoError } from '@/lib/azure/kusto-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
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
function normalizePolicyCommand(cmd: string): string {
  // Match `.alter-merge` immediately followed (allowing the table/tables/
  // database/materialized-view target) by a `policy caching` clause, and drop
  // the `-merge` suffix. Caching is set-valued, so .alter and .alter-merge
  // would mean the same thing — but only `.alter` parses.
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
 * "union operator": *"If specified, the output includes a column called
 * ColumnName whose value indicates which source table has contributed each
 * row."*). So we rewrite:
 *   union A, B                                  → union withsource=source_table A, B
 *   | project … source_table = $table, …        → | project … source_table, …
 * The `withsource=source_table` column now carries the origin-table name, and
 * the `project` keeps `source_table` (no longer assigned from the invalid
 * `$table`) so the function's OUTPUT SCHEMA is preserved exactly — it still
 * emits a `source_table` column holding the origin table name, just produced
 * the supported way.
 *   https://learn.microsoft.com/kusto/query/union-operator#parameters
 *
 * Guarded so it is a no-op for any body that does not contain the `$table`
 * placeholder, so well-formed bundle functions pass through untouched.
 */
function resolveFunctionPlaceholders(body: string): string {
  if (!/\$table\b/.test(body)) return body;
  let out = body;
  // 1. Hoist the source-table capture onto the union via `withsource=`. Only
  //    rewrite a `union` that does not already declare a withsource= column.
  out = out.replace(
    /\bunion\b(?![^\n]*\bwithsource=)/i,
    'union withsource=source_table',
  );
  // 2. Rewrite the invalid `source_table = $table` projection ASSIGNMENT into a
  //    bare `source_table` column reference (the column the withsource= clause
  //    now produces), preserving the output schema. Tolerate optional spacing.
  out = out.replace(/\bsource_table\s*=\s*\$table\b/gi, 'source_table');
  // 3. Final safety net: if any bare `$table` token still survives (a shape we
  //    did not anticipate), map it to the supported `withsource` column name so
  //    the body still resolves rather than failing SEM0100.
  out = out.replace(/\$table\b/g, 'source_table');
  return out;
}

/**
 * A throttled ingest/set-or-append is a transient, retryable condition — NOT a
 * hard failure. On a small/shared ADX cluster the Ingestion capacity policy can
 * be as low as 1 concurrent operation, so the 2nd/3rd/4th table seed in a tight
 * loop is aborted with HTTP 429 / `ControlCommandThrottledException`:
 *   "The control command was aborted due to throttling … Retrying after some
 *    backoff might succeed. … Origin: 'CapacityPolicy/Ingestion', Capacity: 1".
 * Microsoft Learn (Capacity policy → "Management commands throttling") states
 * the documented client remedy is exactly that: retry after backoff. We detect
 * the throttle by the 429 status or the throttling text. Non-throttle errors
 * (auth, schema) are NOT matched so the caller's precise gating still runs.
 *   https://learn.microsoft.com/kusto/management/capacity-policy#management-commands-throttling
 */
function isThrottled(e: any): boolean {
  if (e instanceof KustoError && e.status === 429) return true;
  const msg = (e?.message || String(e || '')).toString();
  return /throttl|TooManyRequests|ControlCommandThrottled|CapacityPolicy\/Ingestion/i.test(msg);
}

/**
 * Run an ingest-class command (`.ingest inline` / `.set-or-append`) with
 * exponential backoff + full jitter on throttling (HTTP 429). Serializes
 * retries so the bundle's table seeds all land even when the shared cluster's
 * ingestion capacity is 1. Re-throws non-throttle errors immediately (so 401/403
 * still surface to the caller's AllDatabasesAdmin gate) and re-throws the final
 * throttle error once the attempt budget is exhausted.
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
      // Exponential backoff, capped at 30s, with full jitter so serialized
      // single-capacity ingests are spread out instead of hammering the policy.
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
 * fallback seed path (see seedTableRows). Strings are double-quoted with
 * embedded quotes escaped; datetimes wrapped in datetime(...); bool/long/int/
 * real emitted verbatim; null/empty as the typed null literal so the row shape
 * still matches. Grounded in Microsoft Learn (datatable operator):
 *   https://learn.microsoft.com/kusto/query/datatable-operator
 */
function kqlLiteral(value: unknown, type: string): string {
  const t = (type || 'string').toLowerCase();
  if (value === null || value === undefined || value === '') {
    // Typed null keeps the datatable row arity correct.
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
  // string / dynamic / guid / timespan → quoted string literal.
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Seed a table's sample rows so they are ACTUALLY queryable when the install
 * returns — never a misleading "ingested" with zero rows landed.
 *
 * Why this exists: `.ingest inline` is *direct* ingestion (Microsoft Learn:
 * "intended for exploration and prototyping … don't use in production") with
 * NO automatic retry, and against a freshly-created table it can intermittently
 * produce zero data shards — the exact flake that left FederationAudit with a
 * schema but no rows on one workspace. We therefore:
 *   1. Try `.ingest inline`, then VERIFY with `<table> | count`.
 *   2. If the count is short (0 / fewer than expected), fall back to
 *      `.set-or-append <table> <| datatable(<schema>) [<rows>]`. This is a
 *      single transactional control command whose extent is committed and
 *      queryable the moment it returns (no eventual-consistency window), then
 *      verify the count again.
 * Returns true once the expected row count is present, false otherwise. Never
 * throws for data errors — 401/403 are re-thrown so the caller maps them to the
 * AllDatabasesAdmin remediation. Grounded in Microsoft Learn (ingest inline;
 * ingest from query .set-or-append; datatable operator).
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

  // Attempt 1: .ingest inline (with throttle backoff) + verify.
  try {
    await withIngestRetry(() => ingestInline(dbName, table, rows), `Inline ingest into ${table}`, steps);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
    steps.push(`Inline ingest into ${table} threw: ${e?.message || String(e)} — will try .set-or-append.`);
  }
  // Direct ingestion can lag a beat before the extent is visible; give it one
  // short settle before the count probe.
  await sleep(1_500);
  let present = await countRows();
  if (present >= expected) {
    steps.push(`Seeded ${expected} row(s) into ${table} (verified ${present}).`);
    return true;
  }

  // Attempt 2: transactional .set-or-append from a datatable() literal. The
  // extent is committed + queryable on return, so this is the reliable path
  // when inline ingest dropped the rows.
  const schema = columns.map((c) => `${c.name}:${(c.type || 'string').toLowerCase()}`).join(', ');
  const literals = rows
    .map((row) => columns.map((c, i) => kqlLiteral(row[i], c.type)).join(', '))
    .join(',\n  ');
  const setCmd = `.set-or-append ["${table}"] <|\n  datatable(${schema}) [\n  ${literals}\n]`;
  try {
    // .set-or-append is also an ingest-class command bound by the Ingestion
    // capacity policy, so it can throttle too — retry with the same backoff.
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

/**
 * Poll the data plane until a freshly-created Kusto database is queryable.
 *
 * ARM `createDatabase` is asynchronous — it commonly returns provisioningState
 * 'Creating'/'Accepted' and the database does NOT yet exist on the engine
 * nodes. Issuing `.create table` / `.ingest` against it in that window fails
 * with "Entity ID '<db>' of kind 'Database' was not found", which is the race
 * that left this app's KQL DB empty. We block on a cheap, idempotent data-plane
 * probe (`.show database <db> schema`) until it stops returning the not-found
 * error, then let the table/ingest commands run against a ready database.
 *
 * Returns true once the DB is queryable; false if it never became ready within
 * the budget (caller then surfaces an honest remediation gate instead of a
 * misleading 'created'). 401/403 are re-thrown so the caller can map them to
 * the precise AllDatabasesAdmin remediation. Grounded in Microsoft Learn:
 * Kusto database creation is an async ARM control-plane op and data-plane
 * availability lags the ARM PUT response.
 */
async function waitForDatabaseReady(
  dbName: string,
  steps: string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000; // up to 3 min for a cold create
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastErr = '';
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      // `.show database <db> schema` is a read-only no-op that only succeeds
      // once the database object is materialized on the engine nodes.
      await executeMgmtCommand(dbName, `.show database ["${dbName}"] schema`);
      steps.push(`KQL database '${dbName}' is ready (data-plane probe OK after ${attempt} attempt(s)).`);
      return true;
    } catch (e: any) {
      // Auth failures won't resolve by waiting — re-throw for precise gating.
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
      lastErr = (e?.message || String(e)).toString();
      await sleep(intervalMs);
    }
  }
  steps.push(
    `KQL database '${dbName}' did not become queryable within ${Math.round(timeoutMs / 1000)}s` +
      (lastErr ? ` (last probe error: ${lastErr.slice(0, 160)}).` : '.'),
  );
  return false;
}

export const kqlDatabaseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;
  if (!process.env.LOOM_KUSTO_CLUSTER_URI && !process.env.LOOM_KUSTO_CLUSTER_NAME) {
    return {
      status: 'remediation',
      gate: {
        reason: 'ADX cluster not configured.',
        remediation:
          'Set LOOM_KUSTO_CLUSTER_URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.<cloud-suffix>) and LOOM_KUSTO_CLUSTER_NAME on the Console.',
        link: 'https://learn.microsoft.com/azure/data-explorer/',
      },
      steps,
    };
  }

  // 1. Provision the database via ARM.  Database name = slug-friendly
  // version of the displayName.
  const dbName = input.displayName.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50) || 'loomdb';
  let provisioningState = '';
  try {
    const r = await createDatabase(dbName, { hotCacheDays: 7, softDeleteDays: 30 });
    provisioningState = String(r.provisioningState || '');
    steps.push(`ARM createDatabase '${dbName}' → ${r.provisioningState}.`);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Kusto ${e.status}: ARM not authorized.`,
          remediation:
            'Grant the Console UAMI Contributor on the Kusto cluster: az role assignment create --assignee <uami-objectid> --role Contributor --scope /subscriptions/.../Microsoft.Kusto/clusters/<cluster>',
          link: 'https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, 'Confirm LOOM_KUSTO_CLUSTER_URI points at a running ADX cluster and grant the Console UAMI Contributor on the cluster so it can create databases via ARM.', { link: 'https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions', steps });
  }

  // 1b. Wait for the async ARM create to materialize on the data plane before
  // issuing any control / data commands. ARM `createDatabase` is a long-running
  // op: when it returns a terminal 'Succeeded' the database is already
  // queryable, but when it returns 'Creating'/'Accepted'/'Running' the engine
  // is still materializing it and any `.create table`/`.ingest` would cascade
  // to "Entity ID '<db>' … was not found" (the race that left this DB empty
  // while still reporting 'created'). Probe only in the non-terminal case.
  const armTerminal = provisioningState.toLowerCase() === 'succeeded';
  if (!armTerminal) {
    try {
      const ready = await waitForDatabaseReady(dbName, steps);
      if (!ready) {
        return {
          status: 'remediation',
          error: `KQL database '${dbName}' was accepted by ARM but did not become queryable in time.`,
          gate: {
            reason: `KQL database '${dbName}' creation is still in progress (async ARM op).`,
            remediation:
              `The database was accepted by ARM but the engine had not finished materializing it when provisioning ran. ` +
              `Click Retry in a minute — createDatabase is idempotent, the readiness probe will pass once it is online, ` +
              `and the tables + sample rows will then seed.`,
            link: 'https://learn.microsoft.com/azure/data-explorer/create-cluster-and-database',
          },
          steps,
        };
      }
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to read database '${dbName}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      return resolveInfraResidual(e, `Grant the Console UAMI AllDatabasesAdmin on the ADX cluster so it can read database '${dbName}'.`, { link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers', steps });
    }
  }

  // 2. Apply bundle: .create table per table, .ingest inline sample rows.
  // Track whether every data-bearing step actually landed so we never report a
  // misleading 'created' for a functionally-empty database.
  let tableCreateFailures = 0;
  let ingestFailures = 0;
  let expectedSeedTables = 0;
  let functionFailures = 0;
  let policyFailures = 0;
  // Update-policy failures are tracked separately: an `.alter table … policy
  // update` is data-correctness wiring (e.g. fanning RawOrders → Orders), so
  // its failure is fatal even when tables+rows landed. Caching / retention /
  // streamingingestion / ingestionbatching failures are performance/operational
  // tuning — non-fatal once the data is present.
  let criticalPolicyFailures = 0;
  const tables: Array<{ name: string; columns: { name: string; type: string }[]; sample?: any[][] }> = Array.isArray(content?.tables) ? content.tables : [];
  for (const t of tables) {
    const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    const createCmd = `.create table ${t.name} (${cols})`;
    try {
      await executeMgmtCommand(dbName, createCmd);
      steps.push(`.create table ${t.name} OK.`);
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to .create table on database '${dbName}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      tableCreateFailures += 1;
      steps.push(`.create table ${t.name} failed: ${e?.message || String(e)}`);
    }
    if (Array.isArray(t.sample) && t.sample.length > 0) {
      expectedSeedTables += 1;
      try {
        // Verified, retrying seed: inline ingest → count → .set-or-append
        // fallback → count. Only counts as a failure if NO rows landed after
        // both paths (a data-bearing item that seeds zero rows is forbidden).
        const ok = await seedTableRows(dbName, t.name, t.columns, t.sample, steps);
        if (!ok) ingestFailures += 1;
      } catch (e: any) {
        // seedTableRows only throws for 401/403 — map to the precise gate.
        if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
          return {
            status: 'remediation',
            gate: {
              reason: `Kusto ${e.status}: not authorized to ingest into '${dbName}'.`,
              remediation:
                'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
              link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
            },
            steps,
          };
        }
        ingestFailures += 1;
        steps.push(`Seed into ${t.name} failed: ${e?.message || String(e)}`);
      }
    }
  }

  // 3. Functions.
  //
  // A function `body` carries one of two shapes:
  //   (a) a COMPLETE control command — `.create-or-alter function Name(args)
  //       { … }` (optionally preceded by `//` comment lines). This is the
  //       shape every content bundle uses, because functions with parameters
  //       (e.g. DomainCostRollup(LookbackDays:int=30)) can only be expressed
  //       as a full command. These must run VERBATIM. Re-wrapping them in
  //       `.create-or-alter function Name { <full command> }` produces a
  //       nested, malformed command (SYN0002 "Expected: }").
  //   (b) a bare function body expression — wrap it as
  //       `.create-or-alter function Name { <body> }`.
  //
  // We detect (a) by scanning past any leading `//` comment / blank lines for
  // a leading `.create`/`.create-or-alter function` token.
  //
  // CRITICAL (ADX SYN0100): a management/control command is identified by its
  // FIRST non-whitespace character being a dot (`.`) — grounded in Learn,
  // "Management commands overview": *"the first character of the text of a
  // request determines if the request is a management command or a query.
  // Management commands must start with the dot (.) character."* When shape
  // (a) bodies carry leading `//` comment lines (every bundle authors them
  // that way for readability), sending the body VERBATIM makes the literal
  // first char a `/`, and ADX rejects it with
  //   SYN0100: 'Admin commands must have a dot (.) character as their first
  //             non-whitespace character [line:position=0:0]'.
  // So for shape (a) we strip the leading blank / `//`-comment lines and send
  // from the `.create-or-alter function` line onward, guaranteeing the dot
  // leads. (Comments AFTER the first code line are inside the function and are
  // valid CSL, so we only trim the leading run.)
  const fns: Array<{ name: string; body: string }> = Array.isArray(content?.functions) ? content.functions : [];
  for (const fn of fns) {
    // Resolve any unsubstituted `$table` templating placeholder to the
    // supported `union withsource=` column BEFORE shape detection, so the body
    // we send is valid CSL (fixes SEM0100). No-op for well-formed bodies.
    const body = resolveFunctionPlaceholders(String(fn.body ?? ''));
    const lines = body.split(/\r?\n/);
    const firstCodeIdx = lines.findIndex((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//');
    });
    const firstCodeLine = firstCodeIdx >= 0 ? lines[firstCodeIdx].trim() : undefined;
    const isFullCommand = /^\.create(-or-alter)?\s+function\b/i.test(firstCodeLine ?? '');
    // For a full command, drop the leading blank/comment run so the dot is the
    // first non-whitespace character ADX sees (SYN0100 fix). For a bare body,
    // wrap it as a complete `.create-or-alter function` command.
    const dotLedBody = firstCodeIdx >= 0 ? lines.slice(firstCodeIdx).join('\n') : body;
    const cmd = isFullCommand ? dotLedBody : `.create-or-alter function ${fn.name} { ${body} }`;
    try {
      await executeMgmtCommand(dbName, cmd);
      steps.push(`.create-or-alter function ${fn.name} OK.`);
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to .create-or-alter function on database '${dbName}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      functionFailures += 1;
      steps.push(`.create-or-alter function ${fn.name} failed: ${e?.message || String(e)}`);
    }
  }

  // 4. Ingestion / table policies.
  //
  // The bundle's `policy` field carries one of two shapes:
  //   (a) a complete control script — one-or-more `.alter` / `.alter-merge`
  //       policy commands, possibly multi-line (retention, caching,
  //       streamingingestion, etc.). These must be executed VERBATIM, one
  //       command per line. Wrapping them in `.alter table … policy
  //       ingestionbatching @'<policy>'` would malform them.
  //   (b) a raw ingestion-batching policy JSON body (legacy shape) — wrap it
  //       in the documented `.alter table <t> policy ingestionbatching @'…'`.
  //
  // We detect (a) by the leading `.alter` token and run each statement as-is;
  // otherwise we fall back to (b).
  const policies: Array<{ table: string; policy: string }> = Array.isArray(content?.ingestionPolicies) ? content.ingestionPolicies : [];
  for (const p of policies) {
    const raw = String(p.policy ?? '');
    const isControlScript = /^\s*\.alter(-merge)?\b/i.test(raw);
    if (isControlScript) {
      // Split into individual control commands. Kusto control commands are
      // newline-delimited; a leading `.alter`/`.alter-merge` starts each one.
      const commands = raw
        .split(/\r?\n/)
        // Collapse internal runs of whitespace to single spaces. Policy
        // control commands (retention/caching/streamingingestion) are
        // keyword=value DDL with no whitespace-significant string literals,
        // and the Kusto parser rejects misaligned multi-space formatting
        // (e.g. `policy caching   hot        =  90d` → SYN0002). Normalizing
        // makes hand-aligned bundle text parse cleanly.
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .filter((l) => l.length > 0)
        // Rewrite the invalid `.alter-merge … policy caching …` form (SYN0002)
        // to the only accepted `.alter … policy caching …` form per Learn.
        .map((l) => normalizePolicyCommand(l));
      for (const cmd of commands) {
        // `.alter table … policy update …` fans raw rows into a curated table —
        // its failure breaks end-to-end correctness, so count it as critical.
        const isUpdatePolicy = /\bpolicy\s+update\b/i.test(cmd);
        try {
          await executeMgmtCommand(dbName, cmd);
          steps.push(`Policy command on ${p.table} OK: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`);
        } catch (e: any) {
          policyFailures += 1;
          if (isUpdatePolicy) criticalPolicyFailures += 1;
          steps.push(`Policy command on ${p.table} failed (${cmd.slice(0, 60)}…): ${e?.message || String(e)}`);
        }
      }
    } else {
      try {
        await executeMgmtCommand(dbName, `.alter table ${p.table} policy ingestionbatching @'${escapeSqlLiteral(raw)}'`);
        steps.push(`.alter ingestionbatching policy on ${p.table} OK.`);
      } catch (e: any) {
        policyFailures += 1;
        steps.push(`.alter ingestionbatching policy on ${p.table} failed: ${e?.message || String(e)}`);
      }
    }
  }

  // Honest status: never report 'created' for a functionally-empty database.
  // If the bundle declared tables but every .create table failed, or if every
  // sample-row ingest failed, the data-bearing artifact did not actually land
  // — surface that as 'failed' so the install outcome reflects reality
  // (per no-vaporware: a 'created' that is actually broken is forbidden).
  const declaredTables = tables.length;
  if (declaredTables > 0 && tableCreateFailures >= declaredTables) {
    return {
      status: 'failed',
      error: `All ${declaredTables} table-create command(s) failed on '${dbName}'; the database has no tables.`,
      resourceId: dbName,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: dbName },
      steps,
    };
  }
  if (expectedSeedTables > 0 && ingestFailures >= expectedSeedTables) {
    return {
      status: 'failed',
      error: `Schema created on '${dbName}' but all ${expectedSeedTables} sample-row ingests failed; no rows landed.`,
      resourceId: dbName,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: dbName },
      steps,
    };
  }
  // A failed UPDATE policy is data-correctness wiring (it fans RawOrders into
  // Orders), so per no-vaporware it remains fatal even when tables + rows
  // landed — a 'created' that silently drops the curated-table feed is
  // forbidden. (This is what previously hid the cascading SEM0260 update-policy
  // failure behind a green 'created'.)
  if (criticalPolicyFailures > 0) {
    return {
      status: 'failed',
      error:
        `KQL database '${dbName}' tables + rows landed, but ${criticalPolicyFailures} update-policy ` +
        `command(s) failed — see steps. The streaming update policy that feeds the curated table is ` +
        `not wired, so the database is not functionally complete.`,
      resourceId: dbName,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: dbName },
      steps,
    };
  }
  // Residual function / non-update-policy (caching, retention, streamingingestion,
  // ingestionbatching) failures do NOT abort a database whose tables + rows
  // already seeded: the schema and data are queryable, and caching/retention are
  // performance/operational tuning, while standalone detection functions are
  // analyst conveniences — not the data-correctness path. We report 'created'
  // and surface the residual failures honestly in `steps` (per no-vaporware:
  // the partial failure is disclosed, not hidden behind a false 'failed' that
  // would discard a working seeded database). The two known live failures
  // (`.alter-merge … policy caching` SYN0002 and the `$table` SEM0100 function)
  // are now emitted correctly above, so this branch should be empty in practice.
  if (functionFailures > 0 || policyFailures > 0) {
    steps.push(
      `KQL database '${dbName}' created with tables + rows seeded; ${functionFailures} function ` +
        `command(s) and ${policyFailures} non-critical policy command(s) did not apply — see above. ` +
        `These are conveniences/tuning, not the data path; re-run is idempotent and will retry them.`,
    );
  }

  return {
    status: 'created',
    resourceId: dbName,
    secondaryIds: {
      cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '',
      database: dbName,
    },
    steps,
  };
};
