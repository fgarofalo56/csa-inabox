/**
 * GET /api/admin/gates/[id]/options — REAL ARM discovery for a gate's Fix-it
 * picker: enumerates the live Azure resources that can satisfy each required
 * setting (e.g. every Synapse workspace / Event Hubs namespace / AOAI account
 * in the deployment's subscription(s)) so the operator PICKS from what exists
 * instead of typing (no-vaporware.md — real list calls, never a canned list).
 *
 * Loader semantics (lib/gates/registry.ts GateOptionsLoader):
 *   - subscription-scope list: GET /subscriptions/{sub}/resources?$filter=
 *     resourceType eq '<armType>' (admin sub + DLZ sub when distinct);
 *   - valueFrom 'name'|'id' resolves from the list response;
 *   - valueFrom 'properties.<path>' does a bounded per-resource GET with the
 *     loader's api-version (first 15 resources);
 *   - special 'aoai-deployments' walks OpenAI/AIServices accounts and lists
 *     their model deployments.
 *
 * Response: { ok, options: { [envVar]: Array<{ value, label, resourceId }> } }.
 * A gate setting without a loader is simply absent — the dialog renders a
 * free-text input with the registry valueHint for those.
 */
import { NextResponse } from 'next/server';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { withSession } from '@/lib/api/route-toolkit';
import { apiNotFound, apiError } from '@/lib/api/respond';
import { getGate, type GateOptionsLoader } from '@/lib/gates/registry';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE, defaultPagingBudgetMs } from '@/lib/azure/paging-budget';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const credential = uamiArmCredential();

export interface GateOption {
  value: string;
  label: string;
  resourceId: string;
}

function subs(): string[] {
  const out = new Set<string>();
  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_SUBSCRIPTION_ID']) {
    const v = (process.env[k] || '').trim();
    if (v) out.add(v);
  }
  return Array.from(out);
}

async function armGet(token: string, url: string, timeoutMs?: number): Promise<any> {
  const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
  if (!r.ok) throw new Error(`ARM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/**
 * `armGet` under the request budget: a deadline the budget itself handed down
 * becomes {@link PAGE_DEADLINE} instead of an exception, so a slow ARM degrades
 * the picker to the options already collected rather than failing the request.
 */
async function budgetedArmGet(
  token: string,
  url: string,
  budget: PagingBudget,
): Promise<any | typeof PAGE_DEADLINE> {
  return budget.runPage((timeoutMs) => armGet(token, url, timeoutMs));
}

function pluck(obj: any, path: string): string {
  let cur = obj;
  for (const part of path.split('.')) cur = cur?.[part];
  return typeof cur === 'string' ? cur : cur != null ? String(cur) : '';
}

/**
 * Enumerate `armType` across every configured subscription under the REQUEST's
 * shared budget.
 *
 * The 100-row cap breaks only the INNER page loop — the next subscription is
 * still queried. In a DLZ deployment (`LOOM_SUBSCRIPTION_ID` +
 * `LOOM_DLZ_SUBSCRIPTION_ID`) where the admin sub alone yields >= 100 matching
 * resources, breaking the outer loop would make every DLZ resource silently
 * disappear from the picker. Only a spent BUDGET stops the fan-out.
 */
async function listResources(token: string, armType: string, budget: PagingBudget): Promise<any[]> {
  const all: any[] = [];
  for (const sub of subs()) {
    if (budget.truncatedBy) break; // wall clock / page cap spent — stop the fan-out
    const filter = encodeURIComponent(`resourceType eq '${armType}'`);
    let url = `${armBase()}/subscriptions/${sub}/resources?$filter=${filter}&api-version=2021-04-01`;
    while (budget.claimPage()) {
      const page = await budgetedArmGet(token, url, budget);
      if (page === PAGE_DEADLINE) break;
      all.push(...(page.value || []));
      if (!page.nextLink) break;
      if (all.length >= 100) break; // bounded — a picker, not an inventory
      url = page.nextLink;
    }
  }
  return all;
}

async function loadOptions(
  token: string,
  loader: GateOptionsLoader,
  budget: PagingBudget,
): Promise<GateOption[]> {
  // Special: enumerate AOAI model deployments across OpenAI/AIServices accounts.
  if (loader.special === 'aoai-deployments') {
    const accounts = (await listResources(token, 'Microsoft.CognitiveServices/accounts', budget))
      .filter((a) => !loader.kindFilter || loader.kindFilter.includes(a.kind) || ['OpenAI', 'AIServices'].includes(a.kind))
      .slice(0, 10);
    const out: GateOption[] = [];
    for (const a of accounts) {
      // Was an UNBOUNDED armGet (30s default each, 10 accounts) inside a
      // maxDuration = 30 route — now on the shared request budget.
      if (budget.truncatedBy || !budget.claimPage()) break;
      try {
        const deps = await budgetedArmGet(token, `${armBase()}${a.id}/deployments?api-version=2023-05-01`, budget);
        if (deps === PAGE_DEADLINE) break;
        for (const d of deps.value || []) {
          out.push({
            value: d.name,
            label: `${d.name} (${d.properties?.model?.name || 'model'} @ ${a.name})`,
            resourceId: d.id,
          });
        }
      } catch { /* account without list permission — skip, never fake */ }
    }
    return out;
  }

  let resources = await listResources(token, loader.armType, budget);
  if (loader.kindFilter?.length) {
    resources = resources.filter((r) => loader.kindFilter!.includes(r.kind));
  }
  // The 15-cap bounds the per-resource GETs in the `properties.<path>` branch
  // below. When the value comes straight from the list response there is
  // nothing to bound, and slicing there would silently drop a DLZ
  // subscription's resources behind a crowded admin subscription.
  const needsPerResourceGet = loader.valueFrom !== 'name' && loader.valueFrom !== 'id';
  if (needsPerResourceGet) resources = resources.slice(0, 15);

  const out: GateOption[] = [];
  for (const r of resources) {
    let value: string;
    if (loader.valueFrom === 'name') value = r.name;
    else if (loader.valueFrom === 'id') value = r.id;
    else {
      // properties.<path> — the subscription list omits properties; fetch the
      // resource with the loader's api-version (real ARM GET, bounded above).
      if (budget.truncatedBy || !budget.claimPage()) break;
      try {
        const full = await budgetedArmGet(
          token,
          `${armBase()}${r.id}?api-version=${loader.armApiVersion || '2021-04-01'}`,
          budget,
        );
        if (full === PAGE_DEADLINE) break;
        value = pluck(full, loader.valueFrom);
      } catch {
        continue; // unreadable resource — skip rather than fabricate a value
      }
    }
    if (!value) continue;
    out.push({ value, label: `${r.name} (${r.location || 'unknown region'})`, resourceId: r.id });
  }
  return out;
}

export const GET = withSession<{ id: string }>(async (_req, { session, params }) => {
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;

  const { id } = params;
  const gate = getGate(id);
  if (!gate) return apiNotFound(`unknown gate id '${id}'`);

  if (!process.env.LOOM_SUBSCRIPTION_ID) {
    return apiError(
      'LOOM_SUBSCRIPTION_ID not set — ARM discovery needs the deployment subscription. Enter values manually or resolve the "Azure subscription + resource groups" gate first.',
      503,
      { code: 'not_configured', missing: 'LOOM_SUBSCRIPTION_ID' },
    );
  }

  let token: string;
  try {
    const t = await credential.getToken(armScope());
    token = t!.token;
  } catch (e: any) {
    return apiError(`ARM auth failed: ${e?.message || String(e)}`, 502);
  }

  // ONE budget for the WHOLE request, not per loader: `maxDuration` here is 30
  // and a fresh 15s budget per required setting was still unbounded in
  // aggregate (#2557 review). Capped at 20s so the route stays inside its own
  // ceiling, but a LOWER LOOM_ARM_PAGING_BUDGET_MS still wins.
  const budget = new PagingBudget(`gate-options ${id}`, {
    budgetMs: Math.min(20_000, defaultPagingBudgetMs()),
  });
  const options: Record<string, GateOption[]> = {};
  const errors: Record<string, string> = {};
  for (const s of gate.requiredSettings) {
    if (!s.loader) continue;
    try {
      options[s.envVar] = await loadOptions(token, s.loader, budget);
    } catch (e: any) {
      errors[s.envVar] = e?.message || String(e);
    }
  }
  budget.warnIfTruncated(Object.keys(options).length);

  return NextResponse.json({
    ok: true,
    gateId: id,
    options,
    errors,
    // Honest: the picker may be showing a partial list because ARM was slow,
    // NOT because those resources don't exist. The dialog keeps its free-text
    // fallback, so a missing row is still enterable by hand.
    truncated: budget.truncatedBy ?? undefined,
  });
});
