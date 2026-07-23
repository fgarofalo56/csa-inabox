/**
 * N13 — GET/POST/DELETE /api/admin/copilot-quality/budgets
 *
 * The per-workspace / per-agent token-budget plane behind the "Budgets" tab of
 * the EXISTING /admin/copilot-quality page (no orphan admin tile, no new page).
 *
 *   GET    → the attribution dashboard: REAL accumulated spend per workspace /
 *            agent for the current period (Cosmos `loom-token-budgets` usage
 *            rows written by the aoai-chat-client hot path), joined with each
 *            scope's configured budget + live verdict.
 *   POST   → create/update a budget (AUDITED).
 *   DELETE → remove a budget (AUDITED); the usage ledger is retained.
 *
 * Enforcement itself lives in the hot path (lib/copilot/token-budget.ts, called
 * from lib/azure/aoai-chat-client.ts) — this route is the control surface, not a
 * second enforcement point. Tenant-admin only. No Fabric dependency.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiBadRequest, apiError, apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { budgetDashboard, deleteBudget, upsertBudget, type BudgetScope } from '@/lib/copilot/token-budget';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const dynamic = 'force-dynamic';

function scopeOf(v: unknown): BudgetScope {
  return v === 'agent' ? 'agent' : 'workspace';
}

export const GET = withTenantAdmin(async () => {
  try {
    const flagEnabled = await runtimeFlag('n13-token-budgets');
    const rows = flagEnabled ? await budgetDashboard() : [];
    const totals = rows.reduce(
      (acc, r) => ({
        tokens: acc.tokens + (r.usage?.totalTokens ?? 0),
        usd: Number((acc.usd + (r.usage?.usd ?? 0)).toFixed(4)),
        turns: acc.turns + (r.usage?.turns ?? 0),
        over: acc.over + (r.verdict?.over ? 1 : 0),
        warning: acc.warning + (r.verdict?.warning ? 1 : 0),
      }),
      { tokens: 0, usd: 0, turns: 0, over: 0, warning: 0 },
    );
    return apiOk({ flagEnabled, rows, totals });
  } catch (e) {
    return apiServerError(e, 'failed to load token budgets', 'token_budget_read_failed');
  }
});

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const actor = {
      oid: session.claims.oid,
      who: session.claims.upn || session.claims.email || session.claims.name || session.claims.oid,
      tenantId: tenantScopeId(session),
    };
    const doc = await upsertBudget(
      {
        scope: scopeOf(body.scope),
        scopeId: String(body.scopeId ?? ''),
        label: body.label ? String(body.label) : undefined,
        period: body.period === 'daily' ? 'daily' : 'monthly',
        limitTokens: Number(body.limitTokens),
        limitUsd: body.limitUsd == null ? null : Number(body.limitUsd),
        warnAt: body.warnAt == null ? undefined : Number(body.warnAt),
        enabled: body.enabled !== false,
      },
      actor,
    );
    return apiOk({ budget: doc, note: `Budget saved for ${doc.scope} "${doc.scopeId}".` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/required|must be/i.test(msg)) return apiError(msg, 400);
    return apiServerError(e, 'failed to save the token budget', 'token_budget_write_failed');
  }
});

export const DELETE = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const sp = new URL(req.url).searchParams;
    const scopeId = String(sp.get('scopeId') || '').trim();
    if (!scopeId) return apiBadRequest('scopeId required');
    await deleteBudget(scopeOf(sp.get('scope')), scopeId, {
      oid: session.claims.oid,
      who: session.claims.upn || session.claims.email || session.claims.name || session.claims.oid,
      tenantId: tenantScopeId(session),
    });
    return apiOk({ deleted: true, note: `Budget removed for "${scopeId}". The usage ledger is retained.` });
  } catch (e) {
    return apiServerError(e, 'failed to delete the token budget', 'token_budget_delete_failed');
  }
});
