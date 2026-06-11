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
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import type { PlanSubscription, ServiceConfig } from '@/lib/components/deploy-planner/types';
import { configFor, coerceConfigValue } from '@/lib/components/deploy-planner/service-catalog';
import { pruneEdges } from '@/lib/components/deploy-planner/plan-validation';

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

interface DomainsDoc {
  items?: Array<{ id: string; name: string }>;
}

async function readDomains(tenantId: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(`domains:${tenantId}`, tenantId).read<DomainsDoc>();
    return resource?.items?.map((d) => ({ id: d.id, name: d.name })) || [];
  } catch { return []; }
}

async function loadOrSeed(tenantId: string, who: string): Promise<DeployPlanDoc> {
  const c = await tenantSettingsContainer();
  const docId = `deploy-plan:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<DeployPlanDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }

  // Seed: one subscription holding the tenant's existing domains (no services
  // pre-selected — the operator chooses what deploys where).
  const domains = await readDomains(tenantId);
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

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const [plan, domains] = await Promise.all([
      loadOrSeed(tenantId, s.claims.upn || tenantId),
      readDomains(tenantId),
    ]);
    return NextResponse.json({
      ok: true,
      plan: { subscriptions: plan.subscriptions },
      domains,
      updatedAt: plan.updatedAt,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

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

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const subscriptions = sanitize(body?.subscriptions);
  try {
    const c = await tenantSettingsContainer();
    const docId = `deploy-plan:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    doc.subscriptions = subscriptions;
    doc.updatedAt = new Date().toISOString();
    doc.updatedBy = s.claims.upn || tenantId;
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, plan: { subscriptions: doc.subscriptions }, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
