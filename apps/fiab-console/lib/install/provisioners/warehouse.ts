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
import { getPoolState, resumePool, waitForOnline } from '@/lib/azure/synapse-pool-arm';
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
    'Synapse dedicated SQL pool is paused and Loom could not resume it automatically.',
  remediation:
    'Resume the dedicated SQL pool, or grant the Console managed identity (LOOM_UAMI_CLIENT_ID) the Synapse Administrator / Contributor role on the workspace so it can call the ARM resume API. Manual resume: az synapse sql pool resume --name $LOOM_SYNAPSE_DEDICATED_POOL --workspace-name $LOOM_SYNAPSE_WORKSPACE --resource-group $LOOM_DLZ_RG. After ~3 minutes online, click Retry.',
  link: 'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/pause-and-resume-compute-portal',
};

/**
 * Ensure the dedicated pool is Online before issuing DDL. If it is Paused (or
 * mid-pause), issue an ARM resume and poll to Online. Returns null on success,
 * or a RemediationGate when the pool can't be brought online (e.g. the Console
 * MI lacks the ARM role to resume). ARM/network failures here degrade to a
 * step note and let the DDL loop attempt the connection — the in-loop paused
 * handler is the second line of defence.
 */
async function ensurePoolOnline(steps: string[]): Promise<RemediationGate | null> {
  let state: Awaited<ReturnType<typeof getPoolState>>['state'];
  try {
    ({ state } = await getPoolState());
    steps.push(`Dedicated SQL pool state: ${state}.`);
  } catch (e: any) {
    // Can't read state (no ARM role / env) — let the TDS path try and handle
    // a paused error there. Don't hard-fail the whole provision on a probe.
    steps.push(`Could not read pool state via ARM (${e?.message || String(e)}); proceeding to connect.`);
    return null;
  }

  if (state === 'Online') return null;

  if (state === 'Paused' || state === 'Pausing' || state === 'Resuming') {
    try {
      if (state !== 'Resuming') {
        steps.push('Pool is paused; issuing ARM resume…');
        await resumePool();
      } else {
        steps.push('Pool is already resuming; waiting for Online…');
      }
      const finalState = await waitForOnline();
      steps.push(`Pool state after wait: ${finalState}.`);
      if (finalState !== 'Online') {
        // resume() was accepted but pool didn't reach Online within the wait
        // window — surface the resume gate so the user can Retry shortly.
        return RESUME_GATE;
      }
      // Microsoft Learn: the pool can report Online while still finishing the
      // online workflow, so the first TDS reconnect can still fail. Add the
      // documented grace delay before letting the DDL loop connect.
      // https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-manage-compute-rest-api#check-database-state
      await new Promise((r) => setTimeout(r, 20_000));
      return null;
    } catch (e: any) {
      steps.push(`ARM resume failed: ${e?.message || String(e)}`);
      return RESUME_GATE;
    }
  }

  // Scaling / Unknown — give it a chance to settle, then proceed.
  steps.push(`Pool in transient state ${state}; waiting for Online…`);
  try {
    const finalState = await waitForOnline();
    steps.push(`Pool state after wait: ${finalState}.`);
    if (finalState === 'Online') return null;
    if (finalState === 'Paused') {
      await resumePool();
      const afterResume = await waitForOnline();
      steps.push(`Pool state after resume: ${afterResume}.`);
      if (afterResume !== 'Online') return RESUME_GATE;
      // Grace delay before the DDL loop reconnects (see note above).
      await new Promise((r) => setTimeout(r, 20_000));
      return null;
    }
    return RESUME_GATE;
  } catch (e: any) {
    steps.push(`Wait/resume failed: ${e?.message || String(e)}`);
    return RESUME_GATE;
  }
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
        .trim(),
    )
    .filter((b) => b.length > 0);
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
 */
async function seedSampleRows(
  target: SynapseTarget,
  sampleRows: SampleRowsEntry[],
  steps: string[],
): Promise<void> {
  for (const entry of sampleRows) {
    if (!entry?.table || !Array.isArray(entry.rows) || entry.rows.length === 0) continue;
    const table = quoteTable(entry.table);
    const colClause =
      Array.isArray(entry.columns) && entry.columns.length > 0
        ? ` (${entry.columns.map(quoteIdent).join(', ')})`
        : '';
    const valuesClause = entry.rows
      .map((row) => `(${row.map(sqlLiteral).join(', ')})`)
      .join(',\n  ');
    const insertSql = `INSERT INTO ${table}${colClause} VALUES\n  ${valuesClause};`;
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
  const dbtModels: Array<{ layer: string; name: string; sql: string }> = Array.isArray(content?.dbtModels) ? content.dbtModels : [];
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

    // A paused dedicated pool can't accept TDS connections. Auto-resume it
    // (and wait for Online) BEFORE issuing any DDL so the data-bearing seed
    // actually lands. If it can't be brought online, gate honestly.
    const preGate = await ensurePoolOnline(steps);
    if (preGate) {
      return { status: 'remediation', gate: preGate, steps };
    }

    const batches = splitBatches(ddl);
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
      const sql = `CREATE OR ALTER VIEW [${viewName}] AS ${m.sql}`;
      try {
        await synapseExec(target, sql);
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
