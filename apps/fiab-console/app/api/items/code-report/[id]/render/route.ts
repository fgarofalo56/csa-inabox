/**
 * POST /api/items/code-report/[id]/render — execute a Code report (N16).
 *
 * Loads the owner-scoped `code-report` item, parses its stored source, and
 * EXECUTES every query block on the REAL backend (no-vaporware):
 *   • `sql loom <name>` (a governed metric) → N15's runGovernedMetricQuery
 *     (the single one-metric-one-number execute path — NO second query path),
 *   • raw `sql <name>` → the report's bound engine (Synapse serverless / ADX),
 *     read-only-guarded.
 * Returns the AST + a per-query result map so the editor preview renders prose,
 * grids, and charts. A parse error is a 400; a single unconfigured backend
 * degrades to an honest per-query gate, never a page failure.
 *
 * Auth: withWorkspaceOwner('code-report', …) — the route-guard ratchet requires
 * an owner/tenant check, and this threads the exact loadOwnedItem gate (404, not
 * 403, on no-access). Audited: every render writes an `_auditLog` row AND fans
 * out through emitAuditEvent (SIEM/webhooks), the emit fired synchronously first.
 *
 * FLAG0 (`n16-code-report`, default-ON): OFF returns a guided 503 gate.
 * IL5 / MOAT: renders entirely in-boundary (Synapse serverless / ADX Gov-GA).
 * Azure-native default (no-fabric-dependency): no Fabric/Power BI on this path.
 */
import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { renderCodeReport, DEFAULT_CODE_REPORT_ENGINE } from '@/lib/code-report/render';
import { CodeReportParseError, CODE_REPORT_ENGINES, type CodeReportEngine } from '@/lib/code-report/parse';
import type { MetricActor } from '@/lib/metrics/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FLAG_ID = 'n16-code-report';
const ITEM_TYPE = 'code-report';

/** Coerce the item's stored engine binding to a valid engine (default synapse). */
function normalizeEngine(v: unknown): CodeReportEngine {
  return typeof v === 'string' && (CODE_REPORT_ENGINES as readonly string[]).includes(v)
    ? (v as CodeReportEngine)
    : DEFAULT_CODE_REPORT_ENGINE;
}

/** Render-level audit row + SIEM fan-out (best-effort, non-blocking; emit FIRST). */
async function auditRender(
  actor: MetricActor,
  itemId: string,
  detail: { total: number; metric: number; raw: number; ok: number; failed: number; engine: string },
): Promise<void> {
  // Synchronous fan-out first — it must run even though this is called
  // fire-and-forget (anything after the awaited Cosmos write could be skipped).
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: 'code-report.render',
    targetType: 'code-report',
    targetId: itemId,
    tenantId: actor.tenantId,
    detail,
  });
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        itemId: `code-report:${itemId}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        oid: actor.oid,
        at: new Date().toISOString(),
        kind: 'code-report.render',
        target: itemId,
        detail,
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
}

export const POST = withWorkspaceOwner(ITEM_TYPE, async (_req: NextRequest, { session, item }) => {
  if (!(await runtimeFlag(FLAG_ID, { default: true }))) {
    return apiError('Code reports are turned off (admin → runtime flags).', 503, { code: 'code_report_off' });
  }

  const state = (item.state || {}) as Record<string, unknown>;
  const source = typeof state.source === 'string' ? state.source : '';
  const engine = normalizeEngine(state.engine);

  // Clean first-open: a freshly created, empty report renders nothing — no error.
  if (source.trim() === '') {
    return apiOk({ nodes: [], results: {}, engine, empty: true, renderedAt: new Date().toISOString() });
  }

  const actor: MetricActor = {
    oid: session.claims.oid,
    who: session.claims.upn || session.claims.oid,
    tenantId: session.claims.tid || session.claims.oid,
  };

  try {
    const rendered = await renderCodeReport({ actor, source, engine });
    void auditRender(actor, item.id, { ...rendered.counts, engine });
    return apiOk({ ...rendered });
  } catch (e) {
    if (e instanceof CodeReportParseError) {
      return apiError(e.message, 400, { code: 'parse_error', line: e.line });
    }
    return apiServerError(e);
  }
});
