/**
 * Query-result alerts for warehouse-style items (Databricks SQL warehouse +
 * Synapse warehouse) — BFF route.
 *
 *   GET    /api/items/[type]/[id]/alerts
 *          → lists the live alert rules for this deployment's cloud boundary.
 *   POST   /api/items/[type]/[id]/alerts
 *          body { name, sql, column, op, threshold, cron?, timezone?,
 *                 frequency?, window?, severity?, warehouseId?, actionGroupId? }
 *          → creates a real alert and returns { ok, alertId, backend }.
 *   PATCH  /api/items/[type]/[id]/alerts?alertId=…   body { same fields }
 *   DELETE /api/items/[type]/[id]/alerts?alertId=…   (Gov: alertId = rule name)
 *
 * Backend dispatch (Azure-native, NO Microsoft Fabric — see
 * .claude/rules/no-fabric-dependency.md). Split purely on the sovereign
 * boundary via isGovCloud():
 *   - Commercial / GCC → Databricks SQL Alerts. Each alert owns a saved query
 *     (POST /api/2.0/sql/queries) and evaluates an op/column/threshold condition
 *     on a schedule (POST /api/2.0/sql/alerts). Real Databricks REST, AAD MI.
 *   - GCC-High / IL5 / DoD → Azure Monitor scheduled-query alert rule
 *     (Microsoft.Insights/scheduledQueryRules) — Databricks is not IL5-authorized,
 *     so the Azure-native parity is a real ARM alert rule whose KQL runs against
 *     the Loom Log Analytics workspace. Created via the Console UAMI's
 *     "Monitoring Contributor" grant on LOOM_ALERT_RG.
 *
 * Neither path touches a Fabric / Power BI host. The receipt carries the
 * server-assigned alert id from the live response, satisfying the acceptance
 * gate ("receipt shows the created alert id from the live response").
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import {
  databricksConfigGate,
  createDbxQuery,
  createDbxAlert,
  listDbxAlerts,
  updateDbxAlert,
  trashDbxAlert,
  type DbxAlertOp,
  type DbxAlertCondition,
  type DbxAlertSchedule,
} from '@/lib/azure/databricks-client';
import {
  upsertScheduledQueryRule,
  listScheduledQueryRules,
  deleteScheduledQueryRule,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';
import { monitorGate, type MonitorGateBodies } from '@/lib/azure/monitor-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DBX_OPS: DbxAlertOp[] = [
  'GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'EQUAL', 'NOT_EQUAL',
];

/** Map the unified Databricks-style op enum onto the Azure Monitor operator set. */
const MONITOR_OP: Record<string, string> = {
  GREATER_THAN: 'GreaterThan',
  GREATER_THAN_OR_EQUAL: 'GreaterThanOrEqual',
  LESS_THAN: 'LessThan',
  LESS_THAN_OR_EQUAL: 'LessThanOrEqual',
  EQUAL: 'Equal',
};

interface AlertBody {
  name?: string;
  sql?: string;
  column?: string;
  op?: string;
  threshold?: number;
  cron?: string;
  timezone?: string;
  frequency?: string;
  window?: string;
  severity?: number;
  warehouseId?: string;
  actionGroupId?: string;
}

/** Honest Azure infra-gate (never a Fabric gate) for Monitor errors → 503/403. */
const monitorGateBodies: MonitorGateBodies = {
  notConfigured: (missing) => ({ gated: true,
      error: `Azure Monitor not configured: set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_ALERT_RG'}.`,
      gate: {
        reason: 'The Azure-native warehouse alert creates a scheduled-query alert rule on Azure Monitor.',
        remediation: `Set ${missing?.join(' / ') || 'LOOM_LOG_ANALYTICS_RESOURCE_ID + LOOM_ALERT_RG'} on the Console. No Microsoft Fabric required.`,
      },
    }),
  unauthorized: (status) => ({ error: `Azure Monitor ${status}: not authorized to create alert rules.`,
      gate: {
        reason: 'The Console UAMI needs rights on the alert resource group.',
        remediation: 'Grant the Console UAMI "Monitoring Contributor" on LOOM_ALERT_RG so it can create scheduledQueryRules.',
      },
    }),
};

// ============================================================
// GET — list alerts for the active cloud boundary
// ============================================================
export async function GET(_req: NextRequest, _ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (isGovCloud()) {
    try {
      const rules = await listScheduledQueryRules();
      const alerts = rules.map((r) => ({
        id: r.name,
        resourceId: r.id,
        name: r.displayName || r.name,
        state: r.enabled ? 'OK' : 'DISABLED',
        op: r.operator,
        threshold: r.threshold,
        query: r.query,
        schedule: r.evaluationFrequency,
        window: r.windowSize,
        severity: r.severity,
      }));
      return NextResponse.json({ ok: true, backend: 'azure-monitor', alerts });
    } catch (e) {
      return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
    }
  }

  // Commercial / GCC → Databricks SQL alerts.
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gated: true,
      error: `Databricks SQL warehouse is not configured. Set ${gate.missing} (admin-plane bicep wires the Databricks workspace hostname).`,
      gate: { reason: 'Databricks SQL alerts run against the deployed Databricks SQL warehouse.', remediation: `Set ${gate.missing} on the Console. No Microsoft Fabric required.` },
    }, { status: 200 });
  }
  try {
    const { alerts } = await listDbxAlerts({ page_size: 100 });
    return NextResponse.json({
      ok: true,
      backend: 'databricks',
      alerts: alerts.map((a) => ({
        id: a.id,
        name: a.display_name,
        state: a.state,
        op: a.condition?.op,
        column: a.condition?.operand?.column?.name,
        threshold: a.condition?.threshold?.value?.double_value,
        schedule: a.schedule?.quartz_cron_schedule?.quartz_cron_expression,
        owner: a.owner_user_name,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// POST — create an alert (returns the live alert id in the receipt)
// ============================================================
export async function POST(req: NextRequest, _ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as AlertBody;
  const name = String(body.name || '').trim();
  const sql = String(body.sql || '').trim();
  const column = String(body.column || '').trim();
  const op = String(body.op || 'GREATER_THAN');
  const threshold = Number(body.threshold);
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  if (!sql) return NextResponse.json({ ok: false, error: 'query (sql) required' }, { status: 400 });
  if (!Number.isFinite(threshold)) return NextResponse.json({ ok: false, error: 'numeric threshold required' }, { status: 400 });

  // ── Government boundary → Azure Monitor scheduled-query alert rule ──
  if (isGovCloud()) {
    const operator = MONITOR_OP[op];
    if (!operator) {
      return NextResponse.json({ ok: false, error: `operator '${op}' is not supported by Azure Monitor scheduled query rules` }, { status: 400 });
    }
    try {
      const ruleId = await upsertScheduledQueryRule({
        name,
        query: sql,
        operator,
        threshold,
        severity: Number.isFinite(body.severity as number) ? Number(body.severity) : 3,
        evaluationFrequency: body.frequency || 'PT5M',
        windowSize: body.window || 'PT5M',
        actionGroupIds: body.actionGroupId ? [String(body.actionGroupId)] : undefined,
      });
      return NextResponse.json({ ok: true, backend: 'azure-monitor', alertId: ruleId, name });
    } catch (e) {
      return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
    }
  }

  // ── Commercial / GCC → Databricks SQL alert (saved query + alert) ──
  if (!column) return NextResponse.json({ ok: false, error: 'value column required for a Databricks alert condition' }, { status: 400 });
  if (!DBX_OPS.includes(op as DbxAlertOp)) {
    return NextResponse.json({ ok: false, error: `operator '${op}' is not a valid Databricks alert op` }, { status: 400 });
  }
  const warehouseId = String(body.warehouseId || '').trim();
  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId required (the SQL warehouse the alert query runs on)' }, { status: 400 });
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false, gated: true,
      error: `Databricks SQL warehouse is not configured. Set ${gate.missing}.`,
      gate: { reason: 'Databricks SQL alerts run against the deployed Databricks SQL warehouse.', remediation: `Set ${gate.missing} on the Console. No Microsoft Fabric required.` },
    }, { status: 200 });
  }

  const condition: DbxAlertCondition = {
    op: op as DbxAlertOp,
    operand: { column: { name: column } },
    threshold: { value: { double_value: threshold } },
  };
  const schedule: DbxAlertSchedule | undefined = body.cron
    ? { quartz_cron_schedule: { quartz_cron_expression: String(body.cron), timezone_id: String(body.timezone || 'UTC') } }
    : undefined;

  try {
    const query = await createDbxQuery(`${name} — alert query`, sql, warehouseId);
    if (!query?.id) throw new Error('Databricks did not return a query id');
    const alert = await createDbxAlert({ display_name: name, query_id: query.id, condition, schedule });
    return NextResponse.json({ ok: true, backend: 'databricks', alertId: alert.id, queryId: query.id, name });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// PATCH — update an existing alert
// ============================================================
export async function PATCH(req: NextRequest, _ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const alertId = req.nextUrl.searchParams.get('alertId');
  if (!alertId) return NextResponse.json({ ok: false, error: 'alertId required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as AlertBody;
  const op = String(body.op || 'GREATER_THAN');
  const threshold = Number(body.threshold);

  // ── Government boundary → idempotent PUT re-drives the rule ──
  if (isGovCloud()) {
    const name = String(body.name || alertId).trim();
    const sql = String(body.sql || '').trim();
    const operator = MONITOR_OP[op];
    if (!sql) return NextResponse.json({ ok: false, error: 'query (sql) required' }, { status: 400 });
    if (!operator) return NextResponse.json({ ok: false, error: `operator '${op}' is not supported by Azure Monitor` }, { status: 400 });
    if (!Number.isFinite(threshold)) return NextResponse.json({ ok: false, error: 'numeric threshold required' }, { status: 400 });
    try {
      const ruleId = await upsertScheduledQueryRule({
        name, query: sql, operator, threshold,
        severity: Number.isFinite(body.severity as number) ? Number(body.severity) : 3,
        evaluationFrequency: body.frequency || 'PT5M',
        windowSize: body.window || 'PT5M',
        actionGroupIds: body.actionGroupId ? [String(body.actionGroupId)] : undefined,
      });
      return NextResponse.json({ ok: true, backend: 'azure-monitor', alertId: ruleId, name });
    } catch (e) {
      return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
    }
  }

  // ── Commercial / GCC → PATCH the Databricks alert ──
  const gate = databricksConfigGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: `Set ${gate.missing}.` }, { status: 200 });
  const patch: { display_name?: string; condition?: DbxAlertCondition } = {};
  if (body.name) patch.display_name = String(body.name);
  if (body.column && DBX_OPS.includes(op as DbxAlertOp) && Number.isFinite(threshold)) {
    patch.condition = {
      op: op as DbxAlertOp,
      operand: { column: { name: String(body.column) } },
      threshold: { value: { double_value: threshold } },
    };
  }
  try {
    const alert = await updateDbxAlert(alertId, patch);
    return NextResponse.json({ ok: true, backend: 'databricks', alertId: alert.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
  }
}

// ============================================================
// DELETE — remove / trash an alert
// ============================================================
export async function DELETE(req: NextRequest, _ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const alertId = req.nextUrl.searchParams.get('alertId');
  if (!alertId) return NextResponse.json({ ok: false, error: 'alertId required' }, { status: 400 });

  if (isGovCloud()) {
    try {
      await deleteScheduledQueryRule(alertId); // alertId is the rule name on the Gov path
      return NextResponse.json({ ok: true, backend: 'azure-monitor', deleted: alertId });
    } catch (e) {
      return monitorGate(e, monitorGateBodies) || NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
    }
  }

  const gate = databricksConfigGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: `Set ${gate.missing}.` }, { status: 200 });
  try {
    await trashDbxAlert(alertId);
    return NextResponse.json({ ok: true, backend: 'databricks', deleted: alertId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error)?.message || String(e) }, { status: 502 });
  }
}
