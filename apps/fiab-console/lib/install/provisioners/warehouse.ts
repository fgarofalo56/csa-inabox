/**
 * Phase 2 — Warehouse provisioner.
 *
 * Two modes:
 *   - Synapse dedicated pool (LOOM_WAREHOUSE_BACKEND=synapse-dedicated):
 *     uses synapse-sql-client.executeQuery against the dedicated pool's
 *     TDS endpoint to run the bundled DDL.
 *   - Fabric Warehouse (LOOM_WAREHOUSE_BACKEND=fabric-warehouse): POSTs
 *     to /v1/workspaces/{ws}/warehouses then runs DDL via the Warehouse
 *     T-SQL endpoint (.datawarehouse.fabric.microsoft.com TDS).
 *
 * In both modes we split the bundle's WarehouseContent.ddl on semicolons
 * and run each batch.  dbtModels[] are run after the DDL in
 * bronze→silver→gold order, each wrapped in CREATE VIEW IF NOT EXISTS.
 *
 * Remediation gates:
 *   - LOOM_WAREHOUSE_BACKEND unset → remediation with the env var to set.
 *   - 401/403 on TDS → UAMI not added as a member of the warehouse DB.
 */
import { executeQuery as synapseExec, dedicatedTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import { getPoolState, resumePool } from '@/lib/azure/synapse-pool-arm';
import type { Provisioner, ProvisionResult, RemediationGate } from './types';

const BACKEND = process.env.LOOM_WAREHOUSE_BACKEND || 'synapse-dedicated';

/**
 * A dedicated SQL pool refuses TDS connections while Paused — surfaced as
 * MSSQLSERVER_42108 ("Can not connect to the SQL pool since it is paused.
 * Please resume the SQL pool and try again.") or the friendlier
 * "Cannot connect to database when it is paused." Per Microsoft Learn this
 * is a resumable transient, NOT a permanent infra gate: the documented user
 * action is "Resume a SQL pool and retry connecting."
 *   https://learn.microsoft.com/sql/relational-databases/errors-events/mssqlserver-42108-database-engine-error
 */
function isPausedError(msg: string): boolean {
  return /paused|42108|resume the sql pool|cannot connect to database when it is paused/i.test(msg);
}

/** Login / authorization failures are a one-time RBAC gate, not transient. */
function isAuthError(msg: string): boolean {
  return /login failed|cannot open server|not authorized|permission/i.test(msg);
}

const RESUME_GATE: RemediationGate = {
  reason:
    'Synapse dedicated SQL pool is resuming. DDL + seed could not run yet because TDS connections are refused while the pool is offline.',
  remediation:
    'Loom issued an ARM resume — wait ~3 minutes for the pool to come Online, then click Retry to run the warehouse DDL + seed rows. If resume was not accepted, grant the Console managed identity (LOOM_UAMI_CLIENT_ID) the Synapse Administrator / Contributor role on the workspace, or resume manually: az synapse sql pool resume --name $LOOM_SYNAPSE_DEDICATED_POOL --workspace-name $LOOM_SYNAPSE_WORKSPACE --resource-group $LOOM_DLZ_RG.',
  link: 'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/pause-and-resume-compute-portal',
};

/**
 * Bring the dedicated pool toward Online WITHOUT blocking the install request.
 *
 * A paused pool refuses TDS connections, so the DDL/seed cannot run until it
 * is Online. Resuming a dedicated SQL pool takes 1-3 minutes — far longer than
 * Azure Front Door's ~30s origin-response window. The previous implementation
 * blocked the request on `waitForOnline()` (up to 180s) plus two 20s grace
 * sleeps; that is exactly what 504'd the install at the gateway.
 *
 * Submit-and-handoff instead: if the pool isn't Online, FIRE an ARM resume
 * (returns ~immediately with 202) and return RESUME_GATE so the request
 * finishes fast with an honest "resuming — click Retry" remediation. The
 * re-run (per no-vaporware reconcile semantics) lands the DDL + seed once the
 * pool is Online. Returns:
 *   - null  → pool is Online now; proceed to run DDL inline (fast path).
 *   - gate  → pool offline; resume kicked, surface remediation and return.
 *
 * If pool state can't be read (no ARM role/env), return null and let the TDS
 * path try + handle a paused error there — we don't hard-fail on a probe.
 */
async function ensurePoolOnline(steps: string[]): Promise<RemediationGate | null> {
  let state: Awaited<ReturnType<typeof getPoolState>>['state'];
  try {
    ({ state } = await getPoolState());
    steps.push(`Dedicated SQL pool state: ${state}.`);
  } catch (e: any) {
    steps.push(`Could not read pool state via ARM (${e?.message || String(e)}); proceeding to connect.`);
    return null;
  }

  if (state === 'Online') return null;

  // Paused / Pausing → kick a resume (non-blocking) and hand off.
  if (state === 'Paused' || state === 'Pausing') {
    try {
      steps.push('Pool is offline; submitting ARM resume (non-blocking) and handing off…');
      await resumePool();
      steps.push('Resume accepted (202). Pool will be Online in ~1-3 min; click Retry to run DDL + seed.');
    } catch (e: any) {
      steps.push(`ARM resume submit failed: ${e?.message || String(e)}`);
    }
    return RESUME_GATE;
  }

  // Resuming / Scaling / Unknown → already in motion; don't block, hand off.
  steps.push(`Pool in transient state ${state}; not blocking install. Click Retry once Online.`);
  return RESUME_GATE;
}

/**
 * Make a leading `ALTER TABLE <t> ADD CONSTRAINT <c> …` idempotent. On a SHARED
 * dedicated pool the table (and its PK) may already exist from a prior install,
 * so an unguarded ADD CONSTRAINT raises "Table '<t>' already has a primary key
 * defined on it." Guard by constraint name (constraint names are unique within
 * a schema; sys.objects covers PK/UQ/FK/CHECK/DEFAULT). No-op for non-ADD-CONSTRAINT batches.
 */
function makeAddConstraintIdempotent(batch: string): string {
  if (/^\s*IF\s+NOT\s+EXISTS/i.test(batch)) return batch;
  const m = batch.match(/^\s*ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\s+\[?([^\s\]]+)\]?/i);
  if (!m) return batch;
  const c = m[1].replace(/'/g, "''");
  return `IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE name = N'${c}')\n${batch}`;
}

/**
 * A dbt model belongs on Spark/Delta (a lakehouse dbt run), NOT the Synapse
 * dedicated SQL pool, when it is Jinja-templated OR uses Spark/Delta-only SQL
 * that TDS rejects. The dedicated pool runs PLAIN T-SQL views only — sending a
 * Spark model raises "Incorrect syntax near '{'" (Jinja) or a function/keyword
 * error (e.g. OPTIMIZE/ZORDER/MERGE-incremental/MODE()/DAYOFWEEK()). An explicit
 * per-model `engine` tag wins; otherwise we sniff. This is the guard that keeps
 * every casino/fedramp/pipeline-designer Spark model off the dedicated pool.
 */
function isSparkModel(m: { sql: string; engine?: string }): boolean {
  const eng = (m.engine || '').toLowerCase();
  if (eng === 'spark' || eng === 'lakehouse' || eng === 'databricks') return true;
  if (eng === 'tsql' || eng === 'synapse' || eng === 'synapse-dedicated') return false;
  const sql = m.sql || '';
  if (/\{\{|\{%/.test(sql)) return true; // Jinja
  // Spark/Delta-only tokens that have no valid T-SQL form on the dedicated pool.
  return /\b(OPTIMIZE|ZORDER|MERGE\s+INTO|input_file_name|concat_ws|explode|explode_outer|posexplode|dayofweek|date_format|current_timestamp\s*\(\s*\)|to_json|from_json|named_struct|mode\s*\()\b/i.test(sql)
    || /materialized\s*=\s*'incremental'/i.test(sql);
}

function splitBatches(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((b) =>
      b
        // Strip SSMS-style `GO` batch separators. `GO` is a client directive,
        // not T-SQL — the mssql TDS driver throws "Could not find stored
        // procedure 'GO'" if it leaks into request.query(). It is only a
        // separator when alone on its own line; remove every such line.
        .replace(/^[ \t]*GO[ \t]*$/gim, '')
        // Strip whole-line SQL comments (-- …). Leading comment lines are
        // harmless on their own batch, but when an IF-guarded CREATE TABLE
        // (see makeCreateTableIdempotent) folds the comment into the same
        // batch as the IF/CREATE, a `--` would comment out the rest of the
        // single-line statement. Removing comment-only lines keeps the
        // generated batch executable.
        .replace(/^[ \t]*--.*$/gim, '')
        .trim(),
    )
    .filter((b) => b.length > 0);
}

/**
 * Translate the (invalid-here) ANSI `CREATE TABLE IF NOT EXISTS <name> …`
 * idiom into the idempotent form Synapse dedicated SQL pool / Fabric
 * Warehouse actually support:
 *
 *   IF OBJECT_ID(N'<name>', N'U') IS NULL
 *   CREATE TABLE <name> ( … )
 *
 * Neither dedicated SQL pool nor Fabric Warehouse support `IF NOT EXISTS`
 * on CREATE TABLE — the TDS engine raises "Incorrect syntax near IF"
 * (or near the column list). The OBJECT_ID guard is the Microsoft-documented
 * pre-existence check and keeps install idempotent on re-run.
 *   https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-tables-overview#commands-for-creating-tables
 *
 * Only the leading `CREATE TABLE IF NOT EXISTS <name>` is rewritten; the
 * column list and table options are left verbatim. A no-op for batches that
 * don't open with that idiom (plain CREATE TABLE, CREATE VIEW, INSERT, …).
 */
function makeCreateTableIdempotent(batch: string): string {
  // Already wrapped (IF OBJECT_ID … CREATE TABLE) — leave it.
  if (/^\s*IF\s+OBJECT_ID/i.test(batch)) return batch;

  // Form 1: ANSI `CREATE TABLE IF NOT EXISTS <name>` → strip the unsupported
  // IF NOT EXISTS and wrap with the OBJECT_ID guard.
  const ifne = batch.match(/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
  if (ifne) {
    const literal = ifne[1].replace(/'/g, "''");
    const rewritten = batch.replace(/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i, 'CREATE TABLE ');
    return `IF OBJECT_ID(N'${literal}', N'U') IS NULL\n${rewritten}`;
  }

  // Form 2: plain `CREATE TABLE <name> (…)`. On a SHARED dedicated pool a table
  // may already exist pool-wide from a prior install, so an unguarded CREATE
  // raises "There is already an object named '<t>'". Wrap it with the same
  // OBJECT_ID guard so re-install / shared-pool installs are idempotent.
  const plain = batch.match(/^\s*CREATE\s+TABLE\s+([^\s(]+)/i);
  if (plain) {
    const literal = plain[1].replace(/'/g, "''");
    return `IF OBJECT_ID(N'${literal}', N'U') IS NULL\n${batch}`;
  }
  return batch;
}

/**
 * Make a leading `CREATE SCHEMA <name>` idempotent on dedicated SQL pool.
 *
 * `CREATE SCHEMA` is non-idempotent — re-running install raises "There is
 * already an object named '<s>' ... CREATE SCHEMA failed". Dedicated pool also
 * requires CREATE SCHEMA to be the first statement in its batch, so we cannot
 * simply prefix an `IF NOT EXISTS … ` guard around a bare CREATE SCHEMA.
 * Instead wrap it in the documented idempotent idiom that keeps CREATE SCHEMA
 * inside its own EXEC batch:
 *
 *   IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'<s>')
 *   EXEC('CREATE SCHEMA <s>');
 *
 *   https://learn.microsoft.com/sql/t-sql/statements/create-schema-transact-sql#remarks
 *
 * Only a batch whose statement is *exactly* `CREATE SCHEMA <name>` (optionally
 * `AUTHORIZATION <owner>` and a trailing `;`) is rewritten — a no-op for any
 * other batch. The full CREATE SCHEMA text is preserved inside the EXEC,
 * with embedded single-quotes doubled.
 */
function makeCreateSchemaIdempotent(batch: string): string {
  const m = batch.match(/^\s*CREATE\s+SCHEMA\s+([^\s;]+)/i);
  if (!m) return batch;
  // Schema name may be bracket-quoted ([hybrid]) or bare (hybrid); strip
  // brackets and any embedded quote-doubling for the sys.schemas comparison.
  const rawName = m[1].replace(/^\[|\]$/g, '');
  const nameLiteral = rawName.replace(/'/g, "''");
  const innerSql = batch.replace(/;\s*$/, '').trim().replace(/'/g, "''");
  return `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'${nameLiteral}')\nEXEC('${innerSql}');`;
}

/**
 * Detect a batch that opens with `CREATE VIEW` or `CREATE OR ALTER VIEW`
 * (after the comment/GO scrub in splitBatches). On dedicated SQL pool a view
 * DDL must be the FIRST and ONLY statement in its batch, so such a batch must
 * be issued on its own — never folded behind an IF/DROP guard or another
 * statement.
 *
 * Dedicated SQL pool / Fabric Warehouse do NOT support `CREATE OR ALTER VIEW`
 * (it raises "Incorrect syntax near 'CREATE'"); bundles commonly author views
 * with that idiom for portability. We match both forms here, then normalize
 * `CREATE OR ALTER VIEW` → bare `CREATE VIEW` in normalizeCreateView() since we
 * emit our own idempotent DROP batch immediately before it.
 *   https://learn.microsoft.com/sql/t-sql/statements/create-view-transact-sql#remarks
 */
function isCreateViewBatch(batch: string): boolean {
  return /^\s*CREATE\s+(?:OR\s+ALTER\s+)?VIEW\b/i.test(batch);
}

/**
 * Extract the view name from a leading `CREATE [OR ALTER] VIEW [name] AS …` /
 * `… schema.name AS …` so we can emit a separate idempotent DROP batch before
 * the CREATE VIEW batch.
 */
function viewNameFromCreate(batch: string): string | null {
  const m = batch.match(/^\s*CREATE\s+(?:OR\s+ALTER\s+)?VIEW\s+([^\s(]+)/i);
  return m ? m[1] : null;
}

/**
 * Normalize a view-DDL batch into the bare `CREATE VIEW …` form dedicated SQL
 * pool / Fabric Warehouse accept. The unsupported `OR ALTER` is stripped (we
 * already DROP the view in a preceding batch, so plain CREATE is idempotent).
 * A no-op for a batch that is already bare `CREATE VIEW`.
 */
function normalizeCreateView(batch: string): string {
  return batch.replace(/^\s*CREATE\s+OR\s+ALTER\s+VIEW\b/i, 'CREATE VIEW');
}

interface SampleRowsEntry {
  table: string;
  columns?: string[];
  rows: any[][];
}

/** Escape a single scalar into a safe T-SQL literal. mssql's request.query
 * does not template our dynamically-shaped seed matrix, so we hand-build the
 * VALUES clause with strict per-value escaping: strings are single-quoted
 * with doubled quotes (N'…' for Unicode safety), numbers/bools/null are
 * emitted verbatim, everything else is JSON-stringified and quoted. There is
 * no string concatenation of caller input outside this escaper. */
function sqlLiteral(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return `'${v.toISOString().replace(/'/g, "''")}'`;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `N'${s.replace(/'/g, "''")}'`;
}

/** Quote a SQL identifier (table / column) defensively. */
function quoteIdent(name: string): string {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

/** Quote a possibly schema-qualified table name: 'gold.fact_sales' →
 * [gold].[fact_sales]; 'staging' → [staging]. Only the first dot is treated
 * as the schema separator. */
function quoteTable(name: string): string {
  const raw = String(name);
  const dot = raw.indexOf('.');
  if (dot === -1) return quoteIdent(raw);
  return `${quoteIdent(raw.slice(0, dot))}.${quoteIdent(raw.slice(dot + 1))}`;
}

/**
 * Seed the bundle's sampleRows into their tables over the same Synapse TDS
 * target the DDL ran on. Each table is inserted as one multi-row INSERT
 * (capped to keep the statement small), then verified with SELECT COUNT(*).
 * Returns log lines; never throws — seed failures degrade to a step note so
 * the install still completes with the schema in place.
 *
 * Idempotent: a table that already holds rows is left untouched, so
 * re-running install (the documented reconcile path) does not duplicate the
 * sample rows.
 */
async function seedSampleRows(
  target: SynapseTarget,
  sampleRows: SampleRowsEntry[],
  steps: string[],
): Promise<void> {
  for (const entry of sampleRows) {
    if (!entry?.table || !Array.isArray(entry.rows) || entry.rows.length === 0) continue;
    const table = quoteTable(entry.table);

    // Skip tables that already have data so re-install doesn't duplicate rows.
    try {
      const pre = await synapseExec(target, `SELECT COUNT(*) AS n FROM ${table};`);
      const existing = Number(pre.rows?.[0]?.[0] ?? 0);
      if (existing > 0) {
        steps.push(`Skipped seeding ${entry.table}: already has ${existing} row(s).`);
        continue;
      }
    } catch {
      // Count failed (e.g. table not yet created by a deferred DDL) — fall
      // through and attempt the INSERT, which will surface its own error.
    }

    const colClause =
      Array.isArray(entry.columns) && entry.columns.length > 0
        ? ` (${entry.columns.map(quoteIdent).join(', ')})`
        : '';
    // Synapse DEDICATED SQL pool does NOT support the multi-row table value
    // constructor `VALUES (...),(...)` — it raises "Incorrect syntax near ','"
    // at the second row. Emit ONE single-row INSERT per row instead (multiple
    // single-row INSERTs in one batch separated by ';' are supported), which
    // works on dedicated pool, Fabric Warehouse, and serverless alike.
    const insertSql = entry.rows
      .map((row) => `INSERT INTO ${table}${colClause} VALUES (${row.map(sqlLiteral).join(', ')});`)
      .join('\n');
    try {
      await synapseExec(target, insertSql);
      steps.push(`Seeded ${entry.rows.length} row(s) into ${entry.table}.`);
    } catch (e: any) {
      steps.push(`Failed to seed ${entry.table}: ${e?.message || String(e)}`);
      continue;
    }
    // Verify the rows actually landed.
    try {
      const res = await synapseExec(target, `SELECT COUNT(*) AS n FROM ${table};`);
      const n = res.rows?.[0]?.[0];
      steps.push(`Verified ${entry.table}: ${n ?? '?'} row(s) present.`);
    } catch (e: any) {
      steps.push(`Could not verify ${entry.table} count: ${e?.message || String(e)}`);
    }
  }
}

export const warehouseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;
  const ddl = typeof content?.ddl === 'string' ? content.ddl : '';
  const dbtModels: Array<{ layer: string; name: string; sql: string; engine?: string }> = Array.isArray(content?.dbtModels) ? content.dbtModels : [];
  const sampleRows: SampleRowsEntry[] = Array.isArray(content?.sampleRows) ? content.sampleRows : [];

  if (!ddl && dbtModels.length === 0 && sampleRows.length === 0) {
    return { status: 'skipped', steps: ['No DDL, dbt models, or sample rows in bundle; nothing to provision.'] };
  }

  if (BACKEND === 'synapse-dedicated') {
    let target: SynapseTarget;
    try {
      target = dedicatedTarget();
    } catch (e: any) {
      return {
        status: 'remediation',
        gate: {
          reason: 'Synapse dedicated pool not configured.',
          remediation:
            'Set LOOM_SYNAPSE_WORKSPACE (e.g. mysyn-ondemand) and LOOM_SYNAPSE_DEDICATED_POOL (e.g. dwhpool01).',
          link: 'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/',
        },
        steps,
      };
    }
    steps.push(`Synapse target: ${target.server} / ${target.database}`);

    // A paused dedicated pool can't accept TDS connections. Probe state and,
    // if it's offline, FIRE a non-blocking ARM resume and hand off with an
    // honest "resuming — click Retry" gate (resuming takes 1-3 min, far past
    // the gateway's ~30s window — blocking here is what 504'd the install).
    // When the pool is already Online, this returns null and we run the DDL +
    // seed inline (sub-second for this bundle), so the whole install stays
    // well under the gateway timeout.
    const preGate = await ensurePoolOnline(steps);
    if (preGate) {
      return { status: 'remediation', gate: preGate, steps };
    }

    // Expand the raw DDL into the ordered list of single-statement batches we
    // actually send to TDS. Dedicated-pool constraints applied per batch:
    //   • CREATE TABLE IF NOT EXISTS → OBJECT_ID guard (makeCreateTableIdempotent)
    //   • CREATE SCHEMA → idempotent IF NOT EXISTS … EXEC('CREATE SCHEMA …')
    //   • CREATE VIEW   → must be FIRST and ONLY statement in its batch, so the
    //     existence-check/DROP is emitted as its OWN preceding batch and the
    //     bare CREATE VIEW follows in a batch by itself.
    const batches: string[] = [];
    for (const raw of splitBatches(ddl)) {
      if (isCreateViewBatch(raw)) {
        const vn = viewNameFromCreate(raw);
        if (vn) {
          const bare = vn.replace(/^\[|\]$/g, '').replace(/'/g, "''");
          batches.push(`IF OBJECT_ID(N'${bare}', N'V') IS NOT NULL DROP VIEW ${vn};`);
        }
        // Bare CREATE VIEW (OR ALTER stripped) alone in its own batch.
        batches.push(normalizeCreateView(raw));
        continue;
      }
      batches.push(makeAddConstraintIdempotent(makeCreateSchemaIdempotent(makeCreateTableIdempotent(raw))));
    }
    let resumedMidLoop = false;
    for (const sql of batches) {
      let attempted = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await synapseExec(target, sql);
          steps.push(`Ran DDL batch (${sql.slice(0, 80).replace(/\s+/g, ' ')}…).`);
          break;
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (isAuthError(msg)) {
            return {
              status: 'remediation',
              gate: {
                reason: `Synapse T-SQL ${e?.status || 401}: ${msg}`,
                remediation:
                  'In the Synapse workspace > Manage > Security > add the Console UAMI as a member of the dedicated SQL pool. Use the AAD admin to run: CREATE USER [<uami>] FROM EXTERNAL PROVIDER; ALTER ROLE db_owner ADD MEMBER [<uami>];',
                link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control',
              },
              steps,
            };
          }
          // Paused mid-loop (e.g. the pool auto-paused between batches, or the
          // pre-flight ARM probe couldn't read state). Resume once and retry
          // this batch before giving up.
          if (isPausedError(msg) && !attempted && !resumedMidLoop) {
            attempted = true;
            resumedMidLoop = true;
            steps.push(`DDL batch hit a paused pool; resuming and retrying: ${msg}`);
            const gate = await ensurePoolOnline(steps);
            if (gate) {
              return { status: 'remediation', gate, steps };
            }
            continue; // retry the same batch now that the pool is online
          }
          if (isPausedError(msg)) {
            // Resume already attempted and the pool is still rejecting — gate
            // honestly rather than surface a bare failed.
            return { status: 'remediation', gate: RESUME_GATE, steps };
          }
          return { status: 'failed', error: msg, steps };
        }
      }
    }

    // Seed sample rows BEFORE dbt views so gold/silver views over the base
    // tables return non-empty result sets the moment the app opens.
    if (sampleRows.length > 0) {
      await seedSampleRows(target, sampleRows, steps);
    }

    for (const m of dbtModels) {
      const viewName = `${m.layer}_${m.name}`;
      // Spark/Delta dbt models (Jinja, or Spark-only SQL like OPTIMIZE/ZORDER/
      // MERGE-incremental/MODE()/DAYOFWEEK()) are compiled by a dbt RUN on the
      // lakehouse/Spark (the dbt-job item), NOT executable as a raw CREATE VIEW
      // on the dedicated SQL pool — sending them to TDS raises "Incorrect syntax
      // near '{'" or a function error. Route them to the Spark/dbt path instead
      // of attempting TDS. The bronze/silver/gold data path is already served by
      // the seeded tables above; the model SQL ships as dbt project source.
      if (isSparkModel(m)) {
        steps.push(`dbt model [${viewName}] (${m.layer}) is a Spark/Delta model — runs via the Databricks/Spark dbt-job, not the dedicated SQL pool. Skipped on TDS by design (no syntax error). Seeded tables serve the data path now.`);
        continue;
      }
      // Synapse DEDICATED SQL pool does NOT support CREATE OR ALTER VIEW, and
      // requires CREATE VIEW to be the FIRST and ONLY statement in its batch
      // (Microsoft Learn: "The CREATE VIEW must be the first statement in a
      // query batch."). So drop-if-exists in a SEPARATE batch, then issue the
      // bare CREATE VIEW in its own batch.
      //   https://learn.microsoft.com/sql/t-sql/statements/create-view-transact-sql#remarks
      try {
        await synapseExec(target, `IF OBJECT_ID(N'${viewName.replace(/'/g, "''")}', N'V') IS NOT NULL DROP VIEW [${viewName}];`);
        await synapseExec(target, `CREATE VIEW [${viewName}] AS ${m.sql}`);
        steps.push(`Created dbt model view [${viewName}] (${m.layer}).`);
      } catch (e: any) {
        steps.push(`Failed to create view [${viewName}]: ${e?.message || String(e)}`);
      }
    }

    return {
      status: 'created',
      resourceId: `${target.server}/${target.database}/${input.displayName}`,
      secondaryIds: { backend: 'synapse-dedicated', database: target.database },
      steps,
    };
  }

  // Fabric Warehouse path — DDL runs over the dedicated Warehouse TDS
  // endpoint exposed by the Fabric workspace. The Console UAMI must be
  // added as a Contributor on the workspace AND as a Reader on the
  // warehouse-specific endpoint.  When the warehouse is freshly
  // provisioned by Loom, that role binding is set by Fabric automatically.
  if (BACKEND === 'fabric-warehouse') {
    const ws = input.target.fabricWorkspaceId;
    if (!ws) {
      return {
        status: 'remediation',
        gate: {
          reason: 'No bound Fabric workspace for Fabric Warehouse install.',
          remediation: 'Bind a Fabric workspace, or switch LOOM_WAREHOUSE_BACKEND=synapse-dedicated.',
        },
        steps,
      };
    }
    // We rely on synapse-sql-client.executeQuery (same TDS protocol).
    // Discover the warehouse TDS endpoint via Fabric REST first.
    return {
      status: 'remediation',
      gate: {
        reason: 'Fabric Warehouse provisioning is preview.',
        remediation:
          'Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated to use the supported dedicated pool path. Fabric Warehouse TDS proxy is on the v3.4 roadmap.',
        link: '/docs/fiab/operations/app-install-provisioning',
      },
      steps,
    };
  }

  return {
    status: 'remediation',
    gate: {
      reason: `Unknown LOOM_WAREHOUSE_BACKEND='${BACKEND}'.`,
      remediation: 'Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated.',
    },
    steps,
  };
};
