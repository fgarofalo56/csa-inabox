/**
 * /api/admin/finops/budgets — C4 FinOps hub REAL budget CRUD against the Azure
 * Consumption Budgets provider (Microsoft.Consumption/budgets, 2023-05-01).
 *
 *   GET    → { ok, budgets: CostBudget[] }  (real, from the cached cost summary)
 *   POST   → create a budget (ARM PUT)      — AUDITED (kind:'finops.budget')
 *   PUT    → update a budget (ARM PUT)       — AUDITED
 *   DELETE → delete a budget (ARM DELETE)    — AUDITED
 *
 * Tenant-admin gated. Budget WRITE needs the Console UAMI to have Cost
 * Management Contributor (or Budgets write) at the target scope — the
 * svc-budgets-write honest gate names it (bicep-granted). Real backend only
 * (no-vaporware). Azure-native (no Fabric).
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { getLoomCostSummaryCached, MonitorNotConfiguredError } from '@/lib/azure/cost-client';
import { upsertBudget, deleteBudget, validateBudgetInput, BudgetWriteError, type BudgetInput } from '@/lib/azure/budgets-client';
import { auditFinopsMutation } from '@/lib/admin/finops-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export const GET = withTenantAdmin(async () => {
  try {
    const summary = (await getLoomCostSummaryCached({ timeframe: 'MonthToDate' })).value;
    return apiOk({ budgets: summary.budgets, currency: summary.currency, subscriptions: summary.subscriptions });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return apiOk({ budgets: [], gate: { missing: e.missing, message: e.message } });
    }
    return apiServerError(e, 'Failed to list budgets', 'finops_budgets_list_failed');
  }
});

function friendlyWriteError(e: unknown): Response | null {
  if (e instanceof BudgetWriteError) {
    if (e.status === 401 || e.status === 403) {
      return apiError(
        'The Console UAMI cannot write budgets. Grant it "Cost Management Contributor" at the target scope (svc-budgets-write — bicep-granted by cost-management-reader-rbac.bicep).',
        403,
        { code: 'budgets_write_forbidden' },
      );
    }
    return apiError(e.message, e.status >= 400 && e.status < 600 ? e.status : 400, { code: 'budget_write_failed' });
  }
  return null;
}

async function write(req: NextRequest, action: 'create' | 'update', session: any): Promise<Response> {
  let body: Partial<BudgetInput>;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const err = validateBudgetInput(body);
  if (err) return apiError(err, 400);
  const input = body as BudgetInput;
  const who = session.claims.upn || session.claims.email || session.claims.oid;
  const scope = input.resourceGroup ? `${input.subscription}/${input.resourceGroup}` : input.subscription;
  try {
    const result = await upsertBudget(input);
    await auditFinopsMutation(
      { oid: session.claims.oid, who, tenantId: tenantScopeId(session) },
      { kind: 'finops.budget', action, target: input.name, scope, next: { amount: input.amount, timeGrain: input.timeGrain } },
    );
    return apiOk({ budget: result, name: input.name });
  } catch (e) {
    const friendly = friendlyWriteError(e);
    if (friendly) return friendly;
    return apiServerError(e, 'Failed to write the budget', 'finops_budget_write_failed');
  }
}

export const POST = withTenantAdmin((req, { session }) => write(req, 'create', session));
export const PUT = withTenantAdmin((req, { session }) => write(req, 'update', session));

export const DELETE = withTenantAdmin(async (req: NextRequest, { session }) => {
  const q = req.nextUrl.searchParams;
  const name = (q.get('name') || '').trim();
  const subscription = (q.get('subscription') || '').trim();
  const resourceGroup = (q.get('resourceGroup') || '').trim() || undefined;
  if (!name || !subscription) return apiError('name and subscription are required', 400);
  const who = session.claims.upn || session.claims.email || session.claims.oid;
  const scope = resourceGroup ? `${subscription}/${resourceGroup}` : subscription;
  try {
    await deleteBudget(subscription, name, resourceGroup);
    await auditFinopsMutation(
      { oid: session.claims.oid, who, tenantId: tenantScopeId(session) },
      { kind: 'finops.budget', action: 'delete', target: name, scope, prior: { name } },
    );
    return apiOk({ deleted: name });
  } catch (e) {
    const friendly = friendlyWriteError(e);
    if (friendly) return friendly;
    return apiServerError(e, 'Failed to delete the budget', 'finops_budget_delete_failed');
  }
});
