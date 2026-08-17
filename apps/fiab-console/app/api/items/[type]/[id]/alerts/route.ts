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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v8r7-c2p5-mjf2 — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ALL FOUR VERBS took `_ctx` — the underscore is the original author's own
 * signal that the route params were deliberately unread — and `getSession()` was
 * the entire authorization on each. `alertId` came off the QUERY STRING on PATCH
 * and DELETE and went straight to `updateDbxAlert` / `trashDbxAlert` (Commercial
 * / GCC) or `deleteScheduledQueryRule` (Gov).
 *
 * So any authenticated session could LIST, CREATE, MODIFY and — the one that
 * matters most — DELETE alert rules by id, as the Console identity. Deleting a
 * monitoring rule is a durable, cross-tenant effect and the hardest of this
 * advisory's findings to notice after the fact: nothing fails, an alert simply
 * never fires again. It is also the only entry in this family that carries WRITE
 * and DELETE rather than disclosure alone.
 *
 * WHY NO CONTROL SAW IT — and why the allowlist entry is DELETED rather than
 * reworded. `check-route-guards.mjs` carried this path with
 *
 *     "analytics alerts over a shared Azure backend resolved by item type"
 *
 * Nothing here is resolved by item type. The backend split is
 * `isGovCloud()` — an ENVIRONMENT read — and the alert the request acts on is
 * named by `?alertId=`. The reason described a mechanism the file does not
 * contain, and it survived because it reads like the four sentences either side
 * of it in the same allowlist block. Rewording would have preserved exactly that
 * failure, so the entry is gone and the route now passes CHECK 2 on a real guard
 * signal.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 1 — OWN THE ROUTE ITEM, on every verb. `guardSynapseItemRequest` is the
 *   backend-agnostic Layer-1 guard the two siblings in this directory
 *   (`[id]/optimize`, `[id]/statistics`) adopted for GHSA-v2g8-gp3r-rg4r:
 *   session → the canonical `authorizeItemWorkspace` ladder (owner →
 *   tenant-admin → shared-ACL) resolved FROM THE ITEM → a fail-closed item load.
 *   404-not-403. The GET is read-scoped (`allowReadRoles`); POST, PATCH and
 *   DELETE are write-scoped, so a read-only Viewer of a shared workspace can see
 *   the alert list and cannot touch it.
 *
 * LAYER 3 — NOT PRESENT, and named rather than implied. `alertId` stays
 *   caller-named because no item→alert binding exists in this tree: neither
 *   `createDbxAlert` nor `upsertScheduledQueryRule` stamps the owning Loom item
 *   onto the resource it creates, and nothing persists the returned id to item
 *   state. Both backends ARE bounded to Loom's own estate by construction —
 *   `dbxFetch` targets `LOOM_DATABRICKS_HOSTNAME`, and every Monitor call is
 *   composed against `LOOM_ALERT_RG || LOOM_ADMIN_RG` inside
 *   `monitor-client.ts` (`:1391`, and it THROWS when neither is set) — so no
 *   other subscription or resource group is reachable; what survives is
 *   within-estate, cross-tenant.
 *
 *   RESIDUAL, RECORDED: after this change an authenticated caller who owns ANY
 *   item of the route's `[type]` can still list and delete any alert in this
 *   deployment. LAYER 1 IS A FLOOR HERE, NOT A BOUND — the same ledger entry
 *   `[id]/optimize` and `[id]/statistics` carry. Closing it needs the
 *   server-attested ownership marker `_lib/databricks-resource-binding.ts`
 *   already models for jobs and DLT pipelines (`settings.tags['loom_item_id']`),
 *   extended to SQL alerts and to Monitor rule tags, PLUS an adoption path for
 *   every alert created before that marker existed. That is a design change with
 *   a brownfield migration and is deliberately not improvised inside a
 *   security fix — the advisory's own remediation note warns against exactly
 *   that ("a scope-narrowing fix is only as strong as the write path into the
 *   scope").
 */
import { NextRequest, NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
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

/**
 * The 404 body for an item the caller cannot reach — naming BOTH causes and
 * asserting NEITHER.
 *
 * `authorizeItemWorkspace` denies both for "no such item" and for "exists, but
 * your workspace role is read-only", and this route cannot tell them apart
 * without a second read — which is the cross-tenant existence probe 404-not-403
 * exists to prevent. So the status stays 404 and the message states the
 * disjunction rather than picking a side (`deploy-integrity.md` R7).
 */
const ITEM_UNREACHABLE =
  'This item is not available to you. Either it does not exist, or your role in its ' +
  'workspace is read-only — creating, editing and deleting alert rules requires write ' +
  'access. Ask a workspace owner for a Contributor-or-higher role if you need them.';

/**
 * The unsaved-item honest gate, returned INSTEAD of Layer 1's 404 and before the
 * guard runs.
 *
 * REACHABLE FROM BOTH CALL SITES, checked rather than assumed. `WarehouseAlerts`
 * is mounted twice and its trigger is unconditional in both:
 *
 *   `databricks/sql-warehouse-editor.tsx:1943` — ribbon action `:920` is
 *     `onClick: () => setAlertsOpen(true)`; that editor has NO `isNew` guard
 *     anywhere in the file.
 *   `phase3/warehouse-editor.tsx:914`          — ribbon action `:454` is the
 *     same unconditional `setAlertsOpen(true)`, even though that editor DOES
 *     compute `isNew` (`:130`) and uses it to gate its Monitoring and Time-travel
 *     tabs (`:718`, `:723`). The Alerts dialog was simply never included.
 *
 * The dialog fetches the moment it opens (`useEffect(() => { if (open) void
 * refresh(); }`), and the panel paints a non-gated `!ok` as a RED "Could not load
 * alerts" banner — a red error state on a freshly created item, which
 * `ux-baseline.md` forbids, reached in two clicks from a create page. So the
 * route answers with its OWN gate shape (200 + `gated:true`, a warning
 * MessageBar) and a `code` the panel titles truthfully.
 *
 * EXACT-MATCH ONLY. Real ids are `crypto.randomUUID()`, so this downgrades
 * nothing; a prefix or substring test would let a real id skip ownership.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    gated: true,
    code: 'unsaved_item',
    error:
      'Save this item first — alert rules are created and managed in the name of the ' +
      'saved item, and an unsaved item has no owner to check them against yet.',
    gate: {
      reason: 'Alert rules are authorized against the saved item they belong to.',
      remediation:
        'Save this item, then reopen Alerts. No Microsoft Fabric required.',
    },
  }, { status: 200 });
}

/** Authorized to proceed, or the response to return verbatim. */
type Authorized = { ok: true; session: SessionPayload } | { ok: false; res: NextResponse };

/**
 * LAYER 1 for every verb. `read` is passed ONLY by the GET; the three mutating
 * verbs must stay write-scoped, which is why this takes the flag rather than
 * defaulting it.
 */
async function authorizeAlertsRequest(
  ctx: { params: Promise<{ type: string; id: string }> },
  opts: { read?: boolean } = {},
): Promise<Authorized> {
  const { type, id } = await ctx.params;
  if (id === UNSAVED_ITEM_ID) return { ok: false, res: unsavedItemGate() };

  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: type,
    notFound: ITEM_UNREACHABLE,
    ...(opts.read ? { allowReadRoles: true } : {}),
  });
  if (guard.res) return { ok: false, res: guard.res };
  return { ok: true, session: guard.ctx.session };
}

// ============================================================
// GET — list alerts for the active cloud boundary
// ============================================================
export async function GET(_req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  // READ-ONLY — shared read roles admitted.
  const auth = await authorizeAlertsRequest(ctx, { read: true });
  if (!auth.ok) return auth.res;

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
export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  // CREATES a real alert rule — write-scoped, no allowReadRoles.
  const auth = await authorizeAlertsRequest(ctx);
  if (!auth.ok) return auth.res;

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
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  // MODIFIES a real alert rule — write-scoped, no allowReadRoles.
  const auth = await authorizeAlertsRequest(ctx);
  if (!auth.ok) return auth.res;
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
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  // DELETES a real alert rule — the durable, hardest-to-notice effect in this
  // file. Write-scoped, no allowReadRoles.
  const auth = await authorizeAlertsRequest(ctx);
  if (!auth.ok) return auth.res;
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
