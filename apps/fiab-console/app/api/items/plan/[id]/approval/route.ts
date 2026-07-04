/**
 * Plan approval-workflow handoff (audit-T13).
 *
 * Routes a Loom plan through the SAME Azure-native approval Logic App that backs
 * the data-pipeline Approval activity — an Office 365 "Send approval email"
 * Consumption Logic App (NO Microsoft Fabric / Power Automate dependency; see
 * .claude/rules/no-fabric-dependency.md). The plan is the "waiter": the Console
 * itself exposes the callBackUri (the sibling /approval-callback route), so the
 * Logic App POSTs the approver's decision back to Loom, which then stamps the
 * plan item's Cosmos state and (optionally) writes plan metrics into a linked
 * semantic model.
 *
 *   GET  ?action=status  → current { approvalStatus, approvedBy, approvedAt } from Cosmos
 *   GET                  → resolve the approval Logic App trigger URL (or honest gate)
 *   POST { approverEmail, linkedSemanticModelId? }
 *                        → send the approval email; persist approvalStatus:'pending'
 *
 * Honest gate (no-vaporware.md): when the approval Logic App env is missing,
 * returns 503 with the exact bicep module + env vars to set — never a dead
 * button, never a fake "sent".
 *
 * Grounded in Microsoft Learn:
 *   ADF WebHook callBackUri contract:
 *     https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity#additional-notes
 *   ARM listCallbackUrl:
 *     https://learn.microsoft.com/rest/api/logic/workflow-triggers/list-callback-url
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { resolveApprovalConfig, postApprovalTrigger } from '@/lib/azure/plan-approval-client';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'plan';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

/** Absolute base URL of the Console (for the callBackUri the Logic App POSTs to). */
function consoleBaseUrl(req: NextRequest): string {
  const env = (process.env.LOOM_CONSOLE_BASE_URL || process.env.NEXT_PUBLIC_LOOM_CONSOLE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  // Derive from the incoming request (works behind the Container Apps ingress).
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;

  // Status sub-action: return the current approval state from Cosmos.
  if (req.nextUrl.searchParams.get('action') === 'status') {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) return err('plan not found', 404);
    const st = (item.state || {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      approvalStatus: st.approvalStatus || 'none',
      approvedBy: st.approvedBy || null,
      approvedAt: st.approvedAt || null,
      approvalReason: st.approvalReason || null,
      linkedSemanticModelId: st.linkedSemanticModelId || null,
    });
  }

  // Default: resolve the approval Logic App trigger URL (honest-gated).
  const resolved = await resolveApprovalConfig();
  if (!resolved.ok) {
    return err(
      `Approval Logic App is not configured${resolved.gate.missing ? ` (missing ${resolved.gate.missing})` : ''}.`,
      resolved.status,
      { gate: resolved.gate },
    );
  }
  return NextResponse.json({ ok: true, ...resolved.config });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the plan before requesting approval (no id yet)', 400);

  const body = await req.json().catch(() => ({} as any));
  const approverEmail = String(body?.approverEmail || '').trim();
  if (!approverEmail) return err('approverEmail is required', 400);
  const linkedSemanticModelId = body?.linkedSemanticModelId ? String(body.linkedSemanticModelId).trim() : undefined;

  // Load the plan so we have its display name (the email subject) + verify ownership.
  const plan = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!plan) return err('plan not found', 404);

  // Resolve + trigger the approval Logic App (honest-gated).
  const resolved = await resolveApprovalConfig();
  if (!resolved.ok) {
    return err(
      `Approval Logic App is not configured${resolved.gate.missing ? ` (missing ${resolved.gate.missing})` : ''}.`,
      resolved.status,
      { gate: resolved.gate },
    );
  }

  const callBackUri =
    `${consoleBaseUrl(req)}/api/items/plan/${encodeURIComponent(id)}/approval-callback`;

  const trigger = await postApprovalTrigger(resolved.config.triggerUrl, {
    pipelineName: plan.displayName || 'Plan',
    runId: id,
    approverEmail,
    callBackUri,
  });
  if (!trigger.ok) {
    return err(trigger.error || `Approval Logic App trigger failed (${trigger.status}).`, 502);
  }

  // Persist pending state so the editor reflects "awaiting response" and the
  // callback can later resolve it (and find the linked semantic model).
  const nextState: Record<string, unknown> = {
    ...(plan.state || {}),
    approvalStatus: 'pending',
    approvalRequestedAt: new Date().toISOString(),
    approvalRequestedBy: s.claims.upn || s.claims.email || s.claims.oid,
    approverEmail,
    approvedBy: null,
    approvedAt: null,
    approvalReason: null,
  };
  if (linkedSemanticModelId !== undefined) nextState.linkedSemanticModelId = linkedSemanticModelId;
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: nextState });

  return NextResponse.json({
    ok: true,
    status: 'pending',
    message: 'Approval email sent. The approver\'s decision is posted back to Loom and updates this plan\'s status.',
    workflowName: resolved.config.workflowName,
  });
}
