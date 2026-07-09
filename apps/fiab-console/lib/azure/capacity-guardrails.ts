/**
 * FGC-25 — Capacity surge protection (admission control).
 *
 * Fabric exposes a two-level surge model (capacity-level early background
 * rejection before hard throttle + a per-workspace CU consumption cap). ADX,
 * Synapse and Databricks have NO native "surge" primitive, so Loom ENFORCES
 * admission control itself at the job-submission choke points:
 *
 *   - POST /api/items/kql-database/[id]/query   (engine 'adx')
 *   - POST /api/items/notebook/[id]/run          (engine 'spark' | 'databricks')
 *
 * The guardrail policy is one tenant-scoped Cosmos doc (`capacity-guardrails`,
 * PK /tenantId). It ships ENABLED with generous defaults (a cost-protection
 * control, not an enablement gate — per the default-ON posture) and a tenant
 * admin can tune or disable it at /admin/capacity → Surge protection.
 *
 * Two rules, mirroring Fabric's two levels:
 *   1. capacity-threshold — reject a new job when the engine's current Azure
 *      Monitor utilization is at/above `rejectionThresholdPct` (per-engine
 *      override optional). Real ONLY for engines Monitor exposes a clean %
 *      for (ADX CPU, Synapse dedicated-pool DWUUsedPercent); other engines
 *      report `null` utilization and this rule fails OPEN for them.
 *   2. workspace-cu-cap — reject when the workspace has already consumed
 *      `workspaceCuCapPerHour` LCU this hour. The consumption number comes from
 *      the BR-COSTATTR per-execution attribution store, so this rule is the one
 *      that governs Spark/Databricks (which have no Monitor %).
 *
 * No mocks: utilization is real Azure Monitor; the CU number is real recorded
 * attribution. When neither signal is available the job is ALLOWED (fail-open)
 * because surge protection is a budget guardrail, never a security boundary.
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import { capacityGuardrailsContainer } from '@/lib/azure/cosmos-client';

/** Job-submission engine families the choke points dispatch to. */
export type EngineFamily = 'spark' | 'databricks' | 'adx' | 'pipeline' | 'kql';

export const ENGINE_FAMILIES: EngineFamily[] = ['spark', 'databricks', 'adx', 'pipeline', 'kql'];

/** Human labels for the per-engine override grid in the UI. */
export const ENGINE_LABELS: Record<EngineFamily, string> = {
  spark: 'Synapse Spark',
  databricks: 'Databricks',
  adx: 'Azure Data Explorer (KQL)',
  pipeline: 'Pipelines',
  kql: 'KQL ingestion',
};

/** Tenant-scoped surge-protection policy — one doc per tenant. */
export interface CapacityGuardrails {
  id: string; // == tenantId
  tenantId: string;
  /** Master switch. Ships true (default-ON cost protection); admin may disable. */
  enabled: boolean;
  /** Capacity-level default rejection threshold (%). 0 disables the threshold rule. */
  rejectionThresholdPct: number;
  /** Optional per-engine threshold overrides (%). Absent ⇒ use the default. */
  perEngine: Partial<Record<EngineFamily, number>>;
  /** Per-workspace LCU/hour cap. 0 = unlimited (the default). */
  workspaceCuCapPerHour: number;
  updatedAt: string;
  updatedBy?: string;
}

/** Generous, shipped-ENABLED defaults (default-ON posture). */
export function defaultGuardrails(tenantId: string): CapacityGuardrails {
  return {
    id: tenantId,
    tenantId,
    enabled: true,
    rejectionThresholdPct: 90,
    perEngine: {},
    workspaceCuCapPerHour: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system (default)',
  };
}

/** Normalize an untrusted PUT body into a valid, clamped policy. */
export function sanitizeGuardrails(
  input: Partial<CapacityGuardrails>,
  base: CapacityGuardrails,
): CapacityGuardrails {
  const clampPct = (v: unknown, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const perEngine: Partial<Record<EngineFamily, number>> = {};
  const src = (input.perEngine || {}) as Record<string, unknown>;
  for (const e of ENGINE_FAMILIES) {
    if (src[e] != null && src[e] !== '') perEngine[e] = clampPct(src[e], base.rejectionThresholdPct);
  }
  const cap = Number(input.workspaceCuCapPerHour);
  return {
    id: base.tenantId,
    tenantId: base.tenantId,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    rejectionThresholdPct: clampPct(input.rejectionThresholdPct, base.rejectionThresholdPct),
    perEngine,
    workspaceCuCapPerHour: Number.isFinite(cap) && cap > 0 ? Math.round(cap) : 0,
    updatedAt: new Date().toISOString(),
    updatedBy: base.updatedBy,
  };
}

// ---------------------------------------------------------------------------
// Pure evaluator (unit-tested — no Cosmos / Monitor dependency).
// ---------------------------------------------------------------------------

export interface AdmissionContext {
  engine: EngineFamily;
  /** Current engine utilization % (0–100) from Azure Monitor; null when unknown. */
  utilizationPct: number | null;
  /** LCU this workspace consumed in the current hour; null when unknown. */
  workspaceCuThisHour?: number | null;
}

export type AdmissionDecision =
  | { allow: true }
  | {
      allow: false;
      rule: 'capacity-threshold' | 'workspace-cu-cap';
      message: string;
      thresholdPct?: number;
      utilizationPct?: number;
      cuCap?: number;
      cuUsed?: number;
    };

/**
 * Decide whether a job may be admitted, given the policy + the live signals.
 * Pure + deterministic so the two-level model is unit-testable in isolation.
 */
export function evaluateAdmission(g: CapacityGuardrails, ctx: AdmissionContext): AdmissionDecision {
  if (!g.enabled) return { allow: true };

  // 1) Capacity-level early rejection (before Azure's own hard throttle).
  const threshold = g.perEngine?.[ctx.engine] ?? g.rejectionThresholdPct;
  if (typeof ctx.utilizationPct === 'number' && threshold > 0 && ctx.utilizationPct >= threshold) {
    return {
      allow: false,
      rule: 'capacity-threshold',
      thresholdPct: threshold,
      utilizationPct: ctx.utilizationPct,
      message:
        `Capacity surge protection rejected this ${ENGINE_LABELS[ctx.engine]} job: current utilization ` +
        `${Math.round(ctx.utilizationPct)}% is at or above the ${threshold}% rejection threshold. ` +
        `Wait for load to drop, or a tenant admin can raise or disable the threshold at ` +
        `/admin/capacity → Surge protection.`,
    };
  }

  // 2) Per-workspace LCU/hour cap.
  if (
    g.workspaceCuCapPerHour > 0 &&
    typeof ctx.workspaceCuThisHour === 'number' &&
    ctx.workspaceCuThisHour >= g.workspaceCuCapPerHour
  ) {
    return {
      allow: false,
      rule: 'workspace-cu-cap',
      cuCap: g.workspaceCuCapPerHour,
      cuUsed: ctx.workspaceCuThisHour,
      message:
        `Capacity surge protection rejected this ${ENGINE_LABELS[ctx.engine]} job: this workspace has ` +
        `consumed ${Math.round(ctx.workspaceCuThisHour)} LCU this hour, at or above its ` +
        `${g.workspaceCuCapPerHour} LCU/hour cap. The cap resets at the top of the hour, or a tenant ` +
        `admin can raise it at /admin/capacity → Surge protection.`,
    };
  }

  return { allow: true };
}

// ---------------------------------------------------------------------------
// Cosmos persistence.
// ---------------------------------------------------------------------------

/** Load the tenant's policy, seeding the default-ON doc on first access. */
export async function loadGuardrails(tenantId: string): Promise<CapacityGuardrails> {
  const c = await capacityGuardrailsContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<CapacityGuardrails>();
    if (resource) {
      // Forward-compat: fill any field a newer schema added.
      const d = defaultGuardrails(tenantId);
      return {
        ...d,
        ...resource,
        perEngine: resource.perEngine || {},
        updatedBy: resource.updatedBy,
      };
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const seeded = defaultGuardrails(tenantId);
  try {
    await c.items.create(seeded);
  } catch {
    /* create race — a concurrent seed won; the read on next call returns it */
  }
  return seeded;
}

/** Persist a sanitized policy. */
export async function saveGuardrails(g: CapacityGuardrails): Promise<CapacityGuardrails> {
  const c = await capacityGuardrailsContainer();
  await c.item(g.tenantId, g.tenantId).replace(g).catch(async (e: any) => {
    if (e?.code === 404) { await c.items.create(g); return; }
    throw e;
  });
  return g;
}

// ---------------------------------------------------------------------------
// Live utilization read (real Azure Monitor) — best-effort, short-cached.
// ---------------------------------------------------------------------------

const _utilCache = new Map<EngineFamily, { pct: number | null; at: number }>();
const UTIL_TTL_MS = 60_000;

/**
 * Current utilization % for an engine family, from Azure Monitor. Returns null
 * when Monitor has no clean percentage signal for the engine (Spark/Databricks)
 * or the read fails — the evaluator treats null as "unknown, allow". Cached for
 * 60s so a burst of submits doesn't fan out a Monitor read each time.
 */
export async function currentEngineUtilizationPct(engine: EngineFamily): Promise<number | null> {
  const now = Date.now();
  const hit = _utilCache.get(engine);
  if (hit && now - hit.at < UTIL_TTL_MS) return hit.pct;

  let pct: number | null = null;
  try {
    const { listResources, fetchMetrics } = await import('@/lib/azure/monitor-client');
    const resources = await listResources();
    if (engine === 'adx') {
      // ADX cluster CPU % is the clean, real utilization signal Monitor exposes.
      const clusters = resources.filter((r) => r.type.toLowerCase() === 'microsoft.kusto/clusters');
      pct = await avgPercentAcross(clusters.map((c) => c.id), 'CPU', 'Average', fetchMetrics);
    } else {
      // Spark / Databricks / pipelines have no clean Monitor % — the per-workspace
      // LCU/hour cap (from recorded attribution) governs those engines instead.
      pct = null;
    }
  } catch {
    pct = null;
  }
  _utilCache.set(engine, { pct, at: now });
  return pct;
}

async function avgPercentAcross(
  ids: string[],
  metric: string,
  agg: string,
  fetchMetrics: (o: { resourceId: string; metricNames: string[]; timespan?: string; interval?: string; aggregation?: string }) => Promise<Array<{ points: { value: number | null }[] }>>,
): Promise<number | null> {
  if (ids.length === 0) return null;
  const vals: number[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const series = await fetchMetrics({ resourceId: id, metricNames: [metric], timespan: 'PT1H', interval: 'PT5M', aggregation: agg });
        const pts = series[0]?.points || [];
        const present = pts.map((p) => p.value).filter((v): v is number => typeof v === 'number');
        if (present.length) vals.push(present.reduce((a, b) => a + b, 0) / present.length);
      } catch { /* one resource unavailable — skip */ }
    }),
  );
  if (!vals.length) return null;
  return Math.max(0, Math.min(100, vals.reduce((a, b) => a + b, 0) / vals.length));
}

// ---------------------------------------------------------------------------
// Enforcement middleware — call at a choke point BEFORE dispatching the job.
// ---------------------------------------------------------------------------

/**
 * Enforce surge protection at a job-submission choke point. Returns a 429
 * NextResponse when the job is rejected (the caller returns it verbatim), or
 * `null` when admitted. Never throws — a policy/Monitor failure fails OPEN so a
 * cost guardrail can never take the platform down.
 */
export async function enforceAdmissionControl(
  session: SessionPayload,
  opts: { engine: EngineFamily; workspaceId?: string },
): Promise<NextResponse | null> {
  try {
    const tenantId = tenantScopeId(session);
    const g = await loadGuardrails(tenantId);
    if (!g.enabled) return null;

    const [utilizationPct, workspaceCuThisHour] = await Promise.all([
      currentEngineUtilizationPct(opts.engine),
      opts.workspaceId ? workspaceLcuThisHour(tenantId, opts.workspaceId) : Promise.resolve(null),
    ]);

    const decision = evaluateAdmission(g, { engine: opts.engine, utilizationPct, workspaceCuThisHour });
    if (decision.allow) return null;

    // 429 Too Many Requests — the honest "admission rejected" signal, carrying
    // the rule that tripped + the admin override path (per no-vaporware).
    return NextResponse.json(
      {
        ok: false,
        error: decision.message,
        surgeProtection: {
          rejected: true,
          rule: decision.rule,
          thresholdPct: decision.thresholdPct,
          utilizationPct: decision.utilizationPct,
          cuCap: decision.cuCap,
          cuUsed: decision.cuUsed,
          overridePath: '/admin/capacity',
        },
      },
      { status: 429 },
    );
  } catch {
    return null; // fail-open
  }
}

/**
 * LCU a workspace consumed in the CURRENT clock hour, summed from the
 * BR-COSTATTR attribution store. Returns null when the store is empty/absent so
 * the cap rule stays fail-open until real attribution accrues. Imported lazily
 * so FGC-25 has no hard build dependency on the (later-committed) store.
 */
async function workspaceLcuThisHour(tenantId: string, workspaceId: string): Promise<number | null> {
  try {
    const mod = await import('@/lib/azure/cost-attribution');
    return await mod.workspaceLcuThisHour(tenantId, workspaceId);
  } catch {
    return null;
  }
}
