/**
 * plan-backing-store — Azure-native writeback target for the Loom **Plan
 * (preview)** editor (audit-T64).
 *
 * Microsoft Fabric's Plan item auto-provisions a **Fabric SQL database** to hold
 * plan metadata and to receive planning-sheet writeback
 * (/fabric/iq/plan/planning-writeback/planning-how-to-persist-data). The Loom
 * Azure-native DEFAULT keeps planning cells in Cosmos (always works, no infra),
 * and OPTIONALLY mirrors them into an **Azure SQL Database** when one is
 * configured — so the plan's budget/forecast/scenario values land in a governed,
 * queryable relational store the same way Fabric persists them. NO Microsoft
 * Fabric dependency (.claude/rules/no-fabric-dependency.md): the SQL backend is
 * an honest, opt-in Azure resource, never a Fabric capacity.
 *
 * Config (per no-vaporware.md the gate names the exact env vars):
 *   LOOM_PLAN_BACKING_SQL_SERVER    — Azure SQL logical server (name or FQDN)
 *   LOOM_PLAN_BACKING_SQL_DATABASE  — database that holds the loom_plan_cells table
 * The Console UAMI authenticates via AAD token (no SQL password); grant it
 * db_datawriter/db_ddladmin on the database (bicep: plan-backing-sql.bicep).
 *
 * All writes are parameterized (executeParameterized) — no string interpolation
 * of cell values. The DDL is idempotent so provisionPlanTables is safe to call
 * repeatedly (it backs the "Provision backing store" button).
 */
import { executeQuery, executeParameterized } from './azure-sql-client';

export interface PlanBackingGate {
  missing: string;
  reason: string;
  remediation: string;
}

export interface PlanBackingConfig {
  server: string;
  database: string;
}

export type PlanBackingResolve =
  | { ok: true; config: PlanBackingConfig }
  | { ok: false; gate: PlanBackingGate };

const REMEDIATION =
  'Deploy platform/fiab/bicep/modules/shared/plan-backing-sql.bicep (or point at an existing Azure SQL DB) ' +
  'and set LOOM_PLAN_BACKING_SQL_SERVER + LOOM_PLAN_BACKING_SQL_DATABASE on the Console app. ' +
  'Grant the Console UAMI db_ddladmin + db_datawriter on that database. Until then, planning cells ' +
  'persist to Cosmos and the plan stays fully functional — SQL writeback is the opt-in governed store.';

/** Resolve the backing-SQL config or an honest gate naming the missing env. */
export function resolvePlanBacking(): PlanBackingResolve {
  const server = (process.env.LOOM_PLAN_BACKING_SQL_SERVER || '').trim();
  const database = (process.env.LOOM_PLAN_BACKING_SQL_DATABASE || '').trim();
  if (!server) {
    return { ok: false, gate: { missing: 'LOOM_PLAN_BACKING_SQL_SERVER', reason: 'No Azure SQL backing store configured for Plan writeback.', remediation: REMEDIATION } };
  }
  if (!database) {
    return { ok: false, gate: { missing: 'LOOM_PLAN_BACKING_SQL_DATABASE', reason: 'Azure SQL server is set but no database name for Plan writeback.', remediation: REMEDIATION } };
  }
  return { ok: true, config: { server, database } };
}

/** Idempotent DDL: the table that receives planning-cell writeback. */
const DDL = `
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'loom_plan_cells')
BEGIN
  CREATE TABLE dbo.loom_plan_cells (
    plan_id       NVARCHAR(128) NOT NULL,
    sheet_id      NVARCHAR(128) NOT NULL,
    line_item_id  NVARCHAR(128) NOT NULL,
    period_id     NVARCHAR(128) NOT NULL,
    scenario_id   NVARCHAR(128) NOT NULL,
    value         FLOAT NOT NULL,
    updated_at    DATETIME2 NOT NULL CONSTRAINT DF_loom_plan_cells_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_loom_plan_cells PRIMARY KEY (plan_id, sheet_id, line_item_id, period_id, scenario_id)
  );
END;`;

export interface ProvisionResult {
  ok: boolean;
  table: string;
  error?: string;
}

/** Create the writeback table if it does not exist. Returns a structured result. */
export async function provisionPlanTables(cfg: PlanBackingConfig): Promise<ProvisionResult> {
  try {
    await executeQuery(cfg.server, cfg.database, DDL);
    return { ok: true, table: 'dbo.loom_plan_cells' };
  } catch (e: any) {
    return { ok: false, table: 'dbo.loom_plan_cells', error: e?.message || String(e) };
  }
}

export interface WritebackCell {
  sheetId: string;
  lineItemId: string;
  periodId: string;
  scenarioId: string;
  value: number;
}

export interface WritebackResult {
  ok: boolean;
  written: number;
  error?: string;
}

/**
 * MERGE a batch of planning cells into loom_plan_cells (parameterized). Upserts
 * by the composite key so re-saving a scenario overwrites prior values.
 */
export async function writebackCells(
  cfg: PlanBackingConfig,
  planId: string,
  cells: WritebackCell[],
): Promise<WritebackResult> {
  if (cells.length === 0) return { ok: true, written: 0 };
  try {
    // Ensure the table exists (idempotent) so first-write doesn't 208-fail.
    await executeQuery(cfg.server, cfg.database, DDL);
    let written = 0;
    for (const c of cells) {
      const sqlText = `
MERGE dbo.loom_plan_cells AS t
USING (SELECT @p0 AS plan_id, @p1 AS sheet_id, @p2 AS line_item_id, @p3 AS period_id, @p4 AS scenario_id, @p5 AS value) AS s
ON (t.plan_id = s.plan_id AND t.sheet_id = s.sheet_id AND t.line_item_id = s.line_item_id AND t.period_id = s.period_id AND t.scenario_id = s.scenario_id)
WHEN MATCHED THEN UPDATE SET t.value = s.value, t.updated_at = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (plan_id, sheet_id, line_item_id, period_id, scenario_id, value)
  VALUES (s.plan_id, s.sheet_id, s.line_item_id, s.period_id, s.scenario_id, s.value);`;
      await executeParameterized(cfg.server, cfg.database, sqlText, [
        planId, c.sheetId, c.lineItemId, c.periodId, c.scenarioId, c.value,
      ]);
      written += 1;
    }
    return { ok: true, written };
  } catch (e: any) {
    return { ok: false, written: 0, error: e?.message || String(e) };
  }
}
