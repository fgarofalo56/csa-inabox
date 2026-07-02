/**
 * Plan approval callback receiver (audit-T13).
 *
 * The approval Logic App's Callback_approved / Callback_rejected actions POST
 * the approver's decision here (the callBackUri the /approval route handed it).
 * This endpoint is the unauthenticated waiter — the Logic App, not a browser, is
 * the caller — so it does NOT require a Loom session. It verifies the MANDATORY
 * shared secret (fail-closed: rejected when LOOM_APPROVAL_CALLBACK_SECRET is unset
 * or the presented ?key does not match), looks the plan up by id (no tenant
 * context available from the Logic App), stamps the decision onto the plan's
 * Cosmos state, and — when the plan is linked to a semantic model AND the decision
 * is "approved" — pushes the plan metrics into that model via the semantic-model
 * writeback.
 *
 * Body shape (per the ADF WebHook callBackUri contract the Logic App emits):
 *   { "StatusCode": "200", "Output": { "decision": "Approved", "approver": "...", "respondedAt": "..." } }
 *   { "StatusCode": "400", "Error":  { "ErrorCode": "ApprovalRejected", "Message": "..." } }
 *
 * Always returns HTTP 200 (a callback receiver must be permissive) with a small
 * JSON ack; the decision is reflected in the plan's status, queryable via
 * GET /api/items/plan/[id]/approval?action=status.
 *
 * Grounded in Microsoft Learn:
 *   ADF WebHook callBackUri contract:
 *     https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity#additional-notes
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  buildPlanStatusMeasuresTmsl, executeAasXmla, aasConfig, aasDefaultDatabase,
  type PlanMetricTask, type PlanApprovalStatus,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ack(extra: Record<string, unknown>) {
  // Callback receivers must be permissive — always 200 so the Logic App's HTTP
  // action succeeds; the decision is captured in the plan state regardless.
  return NextResponse.json({ ok: true, ...extra }, { status: 200 });
}

/**
 * Constant-time compare of the presented ?key against the configured secret.
 * Returns false when either side is missing/empty (fail closed) or the values
 * differ. Values are hashed to SHA-256 first so `timingSafeEqual` always sees
 * equal-length buffers and never leaks the secret length. Mirrors the
 * fail-closed pattern in lib/auth/internal-token.ts.
 */
function isMatchingCallbackSecret(expected: string, presented: string | null | undefined): boolean {
  if (!expected || !presented) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf-8').digest();
  const b = crypto.createHash('sha256').update(presented, 'utf-8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Load a plan item by id only (the Logic App has no tenant context). */
async function loadPlanById(id: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: id },
        { name: '@t', value: 'plan' },
      ],
    })
    .fetchAll();
  return resources[0] || null;
}

function normalizePlanTasks(raw: unknown): PlanMetricTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const status = String((t as any)?.status || 'todo');
    return {
      title: String((t as any)?.title || ''),
      owner: String((t as any)?.owner || ''),
      due: String((t as any)?.due || ''),
      status: (status === 'doing' || status === 'done') ? status : 'todo',
    } as PlanMetricTask;
  });
}

/**
 * On approval, write the plan's metrics into the linked semantic model via XMLA
 * (Azure-native, no Fabric). Best-effort + no-throw: a writeback failure is
 * recorded in the plan state but never fails the callback.
 */
async function writebackToSemanticModel(
  linkedSemanticModelId: string,
  tasks: PlanMetricTask[],
  approvalStatus: PlanApprovalStatus,
): Promise<{ ok: boolean; backend: string; detail?: string }> {
  if (!aasConfig().available) {
    return { ok: false, backend: 'loom-native', detail: 'LOOM_AAS_XMLA_ENDPOINT not set; plan metrics will be emitted at provision time.' };
  }
  const database = aasDefaultDatabase();
  if (!database) {
    return { ok: false, backend: 'loom-native', detail: 'LOOM_AAS_DATABASE not set; cannot target a live model.' };
  }
  const { tasksTmsl, metricsTmsl } = buildPlanStatusMeasuresTmsl(database, tasks, approvalStatus);
  const t = await executeAasXmla(tasksTmsl, database);
  if (!t.ok) return { ok: false, backend: 'aas-xmla', detail: `Writing _PlanTasks failed: ${t.error}` };
  const m = await executeAasXmla(metricsTmsl, database);
  if (!m.ok) return { ok: false, backend: 'aas-xmla', detail: `Writing _PlanMetrics failed: ${m.error}` };
  return { ok: true, backend: 'aas-xmla', detail: `Plan metrics written to model ${database} (linked ${linkedSemanticModelId}).` };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Shared-secret guard — FAIL CLOSED. This endpoint is unauthenticated by
  // design (the Logic App, not a browser, is the caller) so the shared secret is
  // the ONLY thing standing between an anonymous caller and approving/rejecting
  // any tenant's plan (which also triggers an AAS XMLA writeback). Therefore:
  //   • LOOM_APPROVAL_CALLBACK_SECRET UNSET  → reject (503, disabled) — never open.
  //   • presented ?key does not match         → reject (403).
  // The match is a constant-time comparison. Mirrors lib/auth/internal-token.ts.
  const secret = (process.env.LOOM_APPROVAL_CALLBACK_SECRET || '').trim();
  if (!secret) {
    return NextResponse.json({
      ok: false,
      error: 'approval callback disabled',
      code: 'callback_secret_unset',
      reason:
        'LOOM_APPROVAL_CALLBACK_SECRET is not configured, so the plan approval callback ' +
        'receiver is disabled (fail-closed): without a shared secret anyone could approve/reject ' +
        'plans and trigger the semantic-model writeback.',
      remediation:
        'Set LOOM_APPROVAL_CALLBACK_SECRET on the Console app; the approval Logic App must present ' +
        'it as the ?key query param on the callBackUri it POSTs to.',
    }, { status: 503 });
  }
  if (!isMatchingCallbackSecret(secret, req.nextUrl.searchParams.get('key'))) {
    return NextResponse.json({ ok: false, error: 'invalid callback key' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({} as any));
  const statusCode = Number(body?.StatusCode ?? body?.statusCode ?? 200);
  const output = (body?.Output || body?.output || {}) as Record<string, unknown>;
  const errorObj = (body?.Error || body?.error || {}) as Record<string, unknown>;
  const approved = statusCode < 400;
  const approvalStatus: PlanApprovalStatus = approved ? 'approved' : 'rejected';

  const plan = await loadPlanById(id);
  if (!plan) return ack({ note: 'plan not found; decision discarded' });

  const now = new Date().toISOString();
  const st = (plan.state || {}) as Record<string, unknown>;
  const nextState: Record<string, unknown> = {
    ...st,
    approvalStatus,
    approvedBy: approved ? (output.approver || output.decision || null) : (errorObj.Message || errorObj.message || null),
    approvedAt: now,
    approvalDecidedAt: now,
    approvalReason: approved ? null : (errorObj.Message || errorObj.message || 'Rejected'),
  };

  // Writeback to the linked semantic model on approval (best-effort).
  let writeback: { ok: boolean; backend: string; detail?: string } | undefined;
  const linkedSemanticModelId = typeof st.linkedSemanticModelId === 'string' ? st.linkedSemanticModelId : '';
  if (approved && linkedSemanticModelId) {
    try {
      writeback = await writebackToSemanticModel(linkedSemanticModelId, normalizePlanTasks(st.tasks), approvalStatus);
      nextState.lastWriteback = { ...writeback, at: now };
    } catch (e: unknown) {
      nextState.lastWriteback = { ok: false, backend: 'aas-xmla', detail: e instanceof Error ? e.message : String(e), at: now };
    }
  }

  const items = await itemsContainer();
  await items.item(plan.id, plan.workspaceId).replace<WorkspaceItem>({ ...plan, state: nextState, updatedAt: now });

  return ack({ approvalStatus, writeback });
}
