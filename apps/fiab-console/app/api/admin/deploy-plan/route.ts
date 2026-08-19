/**
 * Deploy-plan API — the persistence behind the Deployment planner.
 *
 * A "deploy plan" is a forward-looking map of WHAT Loom deploys WHERE:
 * subscriptions → domains → the Azure service set per domain. It is the visual
 * counterpart of platform/fiab/bicep/params/*.bicepparam — the planner turns
 * the plan into a bicepparam that `az deployment sub create` consumes.
 *
 * GET  /api/admin/deploy-plan  → { ok, plan, domains, updatedAt }
 *   - plan: the persisted DeployPlan (seeded from the tenant's domains on first
 *     open so the canvas is never empty when domains already exist)
 *   - domains: the real tenant domains (from the domains doc) so the planner can
 *     offer them without a second round-trip
 * PUT  /api/admin/deploy-plan  body: { subscriptions: PlanSubscription[] }
 *
 * Backed by the Cosmos tenant-settings container under id="deploy-plan:<tenantId>",
 * the same low-cardinality pattern the domains route uses. This route persists
 * configuration only; it does NOT execute a deployment (that runs via
 * `az deployment sub create` or the deploy-fiab GitHub workflow) — the UI
 * surfaces that honestly per .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { loadTenantDomains } from '@/lib/auth/load-domains';
import type { PlanSubscription, ServiceConfig } from '@/lib/components/deploy-planner/types';
import { configFor, coerceConfigValue } from '@/lib/components/deploy-planner/service-catalog';
import { pruneEdges } from '@/lib/components/deploy-planner/plan-validation';
import { apiServerError } from '@/lib/api/respond';
import { withTenantAdmin } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DeployPlanDoc {
  id: string;
  tenantId: string;
  kind: 'deploy-plan';
  subscriptions: PlanSubscription[];
  updatedAt: string;
  updatedBy: string;
}

/**
 * The tenant's business-domain list, used to seed a first deploy plan.
 *
 * #3753 — this used to inline `c.item(\`domains:${tenantId}\`, tenantId)` with
 * `tenantId = s.claims.oid`, which bypassed the domain-store chokepoint entirely
 * and therefore also bypassed `check-domain-store-tenant-scope.mjs`. Post-#3282
 * the authoritative document is keyed by `tenantScopeId()`, so this read
 * resolved a PRIVATE, auto-seeded copy and the plan seeded from the wrong list.
 * It now goes through `loadTenantDomains`, which is the guarded read path.
 *
 * `domainScope` is deliberately a SEPARATE parameter from the `deploy-plan:<id>`
 * document's own scope: re-keying that document would strand every existing
 * plan, which is the migration hazard #3282 called out.
 */
async function readDomains(domainScope: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const domains = await loadTenantDomains(domainScope);
    return domains.map((d) => ({ id: d.id, name: d.name || d.id }));
  } catch { return []; }
}

async function loadOrSeed(tenantId: string, domainScope: string, who: string): Promise<DeployPlanDoc> {
  const c = await tenantSettingsContainer();
  const docId = `deploy-plan:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<DeployPlanDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }

  // Seed: one subscription holding the tenant's existing domains (no services
  // pre-selected — the operator chooses what deploys where).
  const domains = await readDomains(domainScope);
  const seed: DeployPlanDoc = {
    id: docId, tenantId, kind: 'deploy-plan',
    subscriptions: [{
      id: 'sub-1',
      name: 'Primary subscription',
      boundary: 'Commercial',
      domains: domains.map((d) => ({ domainId: d.id, name: d.name, services: [] })),
    }],
    updatedAt: new Date().toISOString(),
    updatedBy: who,
  };
  await c.items.create(seed);
  return seed;
}

export const GET = withTenantAdmin(async (_req, { session: s }) => {
  const tenantId = s.claims.oid;
  const domainScope = tenantScopeId(s);
  try {
    const [plan, domains] = await Promise.all([
      loadOrSeed(tenantId, domainScope, s.claims.upn || tenantId),
      readDomains(domainScope),
    ]);
    return NextResponse.json({
      ok: true,
      plan: { subscriptions: plan.subscriptions },
      domains,
      updatedAt: plan.updatedAt,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
});

/**
 * Validate one service's stored config against the catalog schema: drop unknown
 * keys and coerce each value through the SAME gate the UI uses (so a value the
 * bicep module's @allowed / @minValue would reject never reaches Cosmos and so
 * never reaches the exported bicepparam).
 */
function sanitizeServiceConfigs(raw: unknown): Record<string, ServiceConfig> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, ServiceConfig> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const fields = configFor(key);
    if (!fields.length || !val || typeof val !== 'object') continue;
    const cfg: ServiceConfig = {};
    for (const field of fields) {
      const coerced = coerceConfigValue(field, (val as Record<string, unknown>)[field.key]);
      if (coerced !== undefined) cfg[field.key] = coerced;
    }
    if (Object.keys(cfg).length) out[key] = cfg;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitize(subs: unknown): PlanSubscription[] {
  if (!Array.isArray(subs)) return [];
  const clean: PlanSubscription[] = subs.slice(0, 50).map((raw: any, i): PlanSubscription => ({
    id: String(raw?.id || `sub-${i + 1}`).slice(0, 80),
    name: String(raw?.name || `Subscription ${i + 1}`).slice(0, 120),
    boundary: ['Commercial', 'GCC-High', 'GCC', 'IL5'].includes(raw?.boundary) ? raw.boundary : 'Commercial',
    region: raw?.region ? String(raw.region).slice(0, 40) : undefined,
    deploymentMode: ['single-sub', 'multi-sub'].includes(raw?.deploymentMode) ? raw.deploymentMode : undefined,
    domains: Array.isArray(raw?.domains) ? raw.domains.slice(0, 100).map((d: any) => ({
      domainId: String(d?.domainId || '').slice(0, 80),
      name: String(d?.name || d?.domainId || '').slice(0, 120),
      services: Array.isArray(d?.services) ? d.services.map((x: any) => String(x)).slice(0, 64) : [],
    })) : [],
    serviceConfigs: sanitizeServiceConfigs(raw?.serviceConfigs),
    edges: Array.isArray(raw?.edges)
      ? raw.edges.slice(0, 200).map((e: any) => ({ from: String(e?.from || ''), to: String(e?.to || '') }))
      : [],
  }));
  // Prune edges against the cleaned plan so persisted edges always point at
  // real service nodes (drops stale/duplicate/self edges).
  for (const sub of clean) {
    const pruned = pruneEdges(clean, sub.edges);
    sub.edges = pruned.length ? pruned : undefined;
  }
  return clean;
}

export const PUT = withTenantAdmin(async (req: NextRequest, { session: s }) => {
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const subscriptions = sanitize(body?.subscriptions);
  try {
    const c = await tenantSettingsContainer();
    const docId = `deploy-plan:${tenantId}`;
    const doc = await loadOrSeed(tenantId, tenantScopeId(s), s.claims.upn || tenantId);
    doc.subscriptions = subscriptions;
    doc.updatedAt = new Date().toISOString();
    doc.updatedBy = s.claims.upn || tenantId;
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, plan: { subscriptions: doc.subscriptions }, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return apiServerError(e);
  }
});
