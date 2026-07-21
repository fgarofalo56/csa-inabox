/**
 * WS-10.1 — LCU-Autopilot (BTB-2): the closed-loop ACTUATOR + signal reader.
 *
 * The server-side self-driving FinOps loop (mirrors WS-7 model-fabric-loop):
 *   1. READ real LCU telemetry — the unified chargeback model (per-engine LCU +
 *      $ + the capacity ceiling, real Cost Management + Azure Monitor) plus live
 *      per-compute idle state (Synapse DWUUsedPercent / ADX CPU over a sustained
 *      window, warehouse lifecycle state) and the gate/self-audit signal
 *      (`allGateStatuses`).
 *   2. DECIDE — hand the signals to the pure decider
 *      ({@link deriveAutopilotRecommendations}) which emits pause-idle /
 *      right-size / migrate recommendations with thresholds + hysteresis.
 *   3. ACTUATE — in `auto` mode apply each auto-applicable recommendation for
 *      real: pause idle compute (`pausePool` / `stopKustoCluster` — releases
 *      compute, data survives) or roll the capacity ceiling through the shared
 *      env-apply write path (`applyEnvChanges` → a real ACA revision). In
 *      `propose` mode it decides but actuates NOTHING. Every actuation is
 *      audited (SIEM + Cosmos audit-log).
 *   4. PERSIST — approval mode, per-target cooldown timestamps, and action
 *      history to the `autopilot` Cosmos container.
 *
 * No mocks: telemetry is real backend reads; actuation is a real ARM pause/stop
 * or env-apply; an unconfigured telemetry backend degrades to an honest gate
 * (nothing to actuate) rather than a fabricated loop (no-vaporware.md). Azure-
 * native + LCU only, Gov-safe (no-fabric-dependency.md).
 */
import { autopilotContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { applyEnvChanges } from '@/lib/admin/env-apply';
import { allGateStatuses } from '@/lib/gates/registry';
import { sloBreaching } from '@/lib/admin/model-fabric-loop';
import { fetchMetrics } from '@/lib/azure/monitor-client';
import { armBase } from '@/lib/azure/cloud-endpoints';
import {
  deriveAutopilotRecommendations,
  autoApplicableRecommendations,
  totalMonthlySaving,
  DEFAULT_AUTOPILOT_POLICY,
  type AutopilotSignals,
  type AutopilotRecommendation,
  type AutopilotPolicy,
  type ComputeTelemetry,
  type CapacitySignal,
  type DeriveContext,
} from '@/lib/admin/lcu-autopilot';

export type AutopilotMode = 'auto' | 'propose';

/** The default approval mode is propose-only (opt-out): the loop runs + surfaces
 *  recommendations day-one; an admin flips to `auto` to let it actuate. Seeded
 *  from LOOM_AUTOPILOT_MODE (bicep default 'propose') for a fresh tenant. */
export const DEFAULT_AUTOPILOT_MODE: AutopilotMode =
  (process.env.LOOM_AUTOPILOT_MODE || '').toLowerCase() === 'auto' ? 'auto' : 'propose';

export interface AutopilotHistoryEntry {
  at: string;
  target: string;
  kind: AutopilotRecommendation['kind'];
  mode: AutopilotMode;
  actuated: boolean;
  summary: string;
  usdSavedMonthly: number;
  error?: string;
}

/** Per-tenant persisted loop state (Cosmos `autopilot`, id == tenantId). */
export interface AutopilotStateDoc {
  id: string;
  tenantId: string;
  mode: AutopilotMode;
  /** target id → ISO of the last actuation (hysteresis cooldown source). */
  lastActuatedAt: Record<string, string>;
  history: AutopilotHistoryEntry[];
  updatedAt: string;
  updatedBy: string;
}

const HISTORY_CAP = 50;

// ── state store ──────────────────────────────────────────────────────────────

export async function loadAutopilotState(tenantId: string): Promise<AutopilotStateDoc> {
  const c = await autopilotContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<AutopilotStateDoc>();
    if (resource) {
      return {
        ...resource,
        mode: resource.mode === 'auto' ? 'auto' : 'propose',
        lastActuatedAt: resource.lastActuatedAt || {},
        history: Array.isArray(resource.history) ? resource.history : [],
      };
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return {
    id: tenantId,
    tenantId,
    mode: DEFAULT_AUTOPILOT_MODE,
    lastActuatedAt: {},
    history: [],
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
}

export async function saveAutopilotState(doc: AutopilotStateDoc): Promise<AutopilotStateDoc> {
  const c = await autopilotContainer();
  doc.history = (doc.history || []).slice(0, HISTORY_CAP);
  doc.updatedAt = new Date().toISOString();
  const { resource } = await c.items.upsert<AutopilotStateDoc>(doc);
  return (resource as AutopilotStateDoc) ?? doc;
}

/** Set the approval mode (auto vs propose-only) — audited. */
export async function setAutopilotMode(opts: {
  tenantId: string; tid?: string; who: string; actorOid: string; mode: AutopilotMode;
}): Promise<AutopilotStateDoc> {
  const state = await loadAutopilotState(opts.tenantId);
  const prev = state.mode;
  state.mode = opts.mode === 'auto' ? 'auto' : 'propose';
  state.updatedBy = opts.who;
  const saved = await saveAutopilotState(state);
  if (prev !== saved.mode) {
    emitAuditEvent({
      actorOid: opts.actorOid,
      actorUpn: opts.who,
      action: 'lcu-autopilot.mode',
      targetType: 'autopilot',
      targetId: `autopilot:${opts.tenantId}`,
      tenantId: opts.tid || opts.tenantId,
      detail: { from: prev, to: saved.mode },
    });
  }
  return saved;
}

// ── signal readers (real backends) ───────────────────────────────────────────

const IDLE_WINDOW = 'PT2H';
const IDLE_INTERVAL = 'PT15M';
const IDLE_INTERVAL_MIN = 15;

/** Last non-null value of an oldest-first Azure Monitor point series. */
function lastValue(points: { timeStamp: string; value: number | null }[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].value !== null) return points[i].value as number;
  }
  return null;
}

/** Count trailing consecutive intervals at/under `threshold` → sustained-idle minutes. */
function trailingIdleMinutes(
  points: { timeStamp: string; value: number | null }[],
  threshold: number,
): number {
  let n = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const v = points[i].value;
    if (v === null) break;           // gap → stop counting (unknown, fail-safe)
    if (v <= threshold) n++;
    else break;
  }
  return n * IDLE_INTERVAL_MIN;
}

/**
 * Probe one resource's utilization metric over the sustained window and return
 * { utilizationPct, idleMinutes }. Any error → { null, 0 } (activity unknown →
 * never treated as idle by the decider).
 */
async function probeIdle(
  resourceId: string,
  metric: string,
  idleThreshold: number,
): Promise<{ utilizationPct: number | null; idleMinutes: number }> {
  try {
    const results = await fetchMetrics({
      resourceId,
      metricNames: [metric],
      timespan: IDLE_WINDOW,
      interval: IDLE_INTERVAL,
      aggregation: 'Average',
    });
    const r = results[0];
    if (!r) return { utilizationPct: null, idleMinutes: 0 };
    const v = lastValue(r.points);
    if (v === null) return { utilizationPct: null, idleMinutes: 0 };
    return {
      utilizationPct: Math.round(v * 100) / 100,
      idleMinutes: trailingIdleMinutes(r.points, idleThreshold),
    };
  } catch {
    return { utilizationPct: null, idleMinutes: 0 };
  }
}

/** Estimate a resource's monthly $ from the chargeback per-resource-type rollup. */
function usdFor(perTypeCost: Record<string, number>, ...armTypeFragments: string[]): number {
  let total = 0;
  for (const [k, v] of Object.entries(perTypeCost)) {
    const kl = k.toLowerCase();
    if (armTypeFragments.some((f) => kl.includes(f))) total += v;
  }
  // Cost Management MonthToDate → project to a full month (÷ elapsed × 30) is
  // over-engineering here; the chargeback total is already the current period.
  return Math.round(total * 100) / 100;
}

/**
 * Assemble the real {@link AutopilotSignals}: the LCU capacity headline from the
 * chargeback model, per-compute idle telemetry for the pausable Azure-native
 * engines (Synapse warehouse + ADX cluster), and the blocked-gate count.
 * Every read is best-effort — a failed source degrades to an honest gate.
 */
export async function collectAutopilotSignals(policy: AutopilotPolicy = DEFAULT_AUTOPILOT_POLICY): Promise<AutopilotSignals> {
  const idleThreshold = policy.idleUtilPct;
  const compute: ComputeTelemetry[] = [];
  let capacity: CapacitySignal | null = null;
  let telemetryGate: AutopilotSignals['telemetryGate'];
  const perTypeCost: Record<string, number> = {};
  /** engine name → LCU/hr, from the chargeback model's per-engine window rollup. */
  const engineLcuPerHour: Record<string, number> = {};

  // ── LCU chargeback headline (capacity ceiling + $ per resource type) ─────────
  try {
    const { getChargebackModel } = await import('@/lib/azure/cost-management-client');
    const model = await getChargebackModel();
    const cu = model.normalizedCU;
    capacity = {
      totalLcu: cu.totalLcu,
      // The engine peak is the max provisioned LCU seen across engines; fall back
      // to totalLcu when the model doesn't expose a separate peak.
      peakLcu: Math.max(cu.totalLcu, ...cu.engines.map((e) => e.peakLcu || 0)),
      capacityLcu: cu.capacityLcu,
      capacitySource: cu.capacitySource,
      utilizationPct: cu.utilizationPct,
    };
    const hrs = cu.windowHours > 0 ? cu.windowHours : 1;
    for (const e of cu.engines) engineLcuPerHour[e.engine.toLowerCase()] = Math.round((e.lcu / hrs) * 100) / 100;
    for (const row of model.perResourceType || []) perTypeCost[row.key] = row.cost;
  } catch (e: any) {
    telemetryGate = {
      reason: e?.message || 'LCU chargeback telemetry unavailable',
      remediation:
        'Grant the Console UAMI "Cost Management Reader" on the Loom subscription(s) and set ' +
        'LOOM_SUBSCRIPTION_ID so the autopilot can read real per-resource LCU + $ (usage-chargeback).',
    };
  }

  const ARM = armBase();
  const sub = process.env.LOOM_SUBSCRIPTION_ID || '';

  // ── Synapse Dedicated SQL pool (warehouse) — DWUUsedPercent + pausePool ───────
  {
    const synSub = process.env.LOOM_SYNAPSE_SUB || sub;
    const synRg = process.env.LOOM_SYNAPSE_RG || process.env.LOOM_DLZ_RG || '';
    const synWs = process.env.LOOM_SYNAPSE_WORKSPACE || '';
    const synPool = process.env.LOOM_SYNAPSE_DEDICATED_POOL || '';
    if (synSub && synRg && synWs && synPool) {
      const resourceId = `${ARM}/subscriptions/${synSub}/resourceGroups/${synRg}/providers/Microsoft.Synapse/workspaces/${synWs}/sqlPools/${synPool}`;
      let state = 'Unknown';
      try {
        const { getPoolState } = await import('@/lib/azure/synapse-pool-arm');
        state = (await getPoolState()).state;
      } catch { /* state read best-effort */ }
      const online = state === 'Online';
      const idle = online ? await probeIdle(resourceId, 'DWUUsedPercent', idleThreshold) : { utilizationPct: null, idleMinutes: 0 };
      compute.push({
        kind: 'warehouse',
        id: `warehouse:${synPool}`,
        name: synPool,
        lcuPerHour: engineLcuPerHour['synapse'] ?? 0,
        usdMonthly: usdFor(perTypeCost, 'synapse'),
        utilizationPct: idle.utilizationPct,
        idleMinutes: idle.idleMinutes,
        state,
        pausable: online,
        pauseActuator: { type: 'pause', kind: 'warehouse', resourceId },
      });
    }
  }

  // ── Azure Data Explorer cluster (ADX) — CPU % + stopKustoCluster ─────────────
  {
    const kSub = process.env.LOOM_KUSTO_SUB || sub;
    const kRg = process.env.LOOM_KUSTO_RG || process.env.LOOM_DLZ_RG || '';
    const kName = process.env.LOOM_KUSTO_CLUSTER_NAME || '';
    if (kSub && kRg && kName) {
      const resourceId = `${ARM}/subscriptions/${kSub}/resourceGroups/${kRg}/providers/Microsoft.Kusto/clusters/${kName}`;
      let state = 'Unknown';
      try {
        const { getKustoClusterArm } = await import('@/lib/azure/kusto-arm-client');
        state = (await getKustoClusterArm()).state || 'Unknown';
      } catch { /* state read best-effort */ }
      const running = state === 'Running';
      const idle = running ? await probeIdle(resourceId, 'CPU', idleThreshold) : { utilizationPct: null, idleMinutes: 0 };
      compute.push({
        kind: 'adx',
        id: `adx:${kName}`,
        name: kName,
        lcuPerHour: engineLcuPerHour['adx'] ?? 0,
        usdMonthly: usdFor(perTypeCost, 'kusto', 'data explorer'),
        utilizationPct: idle.utilizationPct,
        idleMinutes: idle.idleMinutes,
        state,
        pausable: running,
        pauseActuator: { type: 'pause', kind: 'adx', resourceId },
      });
    }
  }

  // ── gate/self-audit signal ───────────────────────────────────────────────────
  let gatesBlocked = 0;
  try {
    gatesBlocked = allGateStatuses().filter((g) => g.status === 'blocked').length;
  } catch { /* registry eval is in-process; ignore */ }

  const totalLcuPerHour = Math.round(compute.reduce((s, c) => s + c.lcuPerHour, 0) * 100) / 100;
  const totalUsdMonthly = Math.round(compute.reduce((s, c) => s + c.usdMonthly, 0) * 100) / 100;

  return { compute, capacity, gatesBlocked, totalLcuPerHour, totalUsdMonthly, telemetryGate };
}

// ── actuator ──────────────────────────────────────────────────────────────────

export interface ActuationReceipt {
  ok: boolean;
  recommendationId: string;
  kind: AutopilotRecommendation['kind'];
  summary: string;
  backend: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  appliedAt: string;
  error?: string;
}

/**
 * Execute ONE recommendation for real. Shared by the auto loop and the manual
 * "Approve & apply" route (the self-executing FinOps rec on approval). `actor`
 * is 'auto' for the unattended loop or the admin UPN for a manual approval.
 */
export async function executeAutopilotRecommendation(
  rec: AutopilotRecommendation,
  opts: { tenantId: string; tid?: string; who: string; actorOid: string; actor: string },
): Promise<ActuationReceipt> {
  const appliedAt = new Date().toISOString();
  const base = { recommendationId: rec.id, kind: rec.kind, appliedAt };
  try {
    if (rec.actuator.type === 'advisory') {
      return { ...base, ok: false, summary: 'Advisory recommendation — no automatic action.', backend: 'none', error: 'advisory-only' };
    }

    if (rec.actuator.type === 'pause') {
      const act = rec.actuator;
      let backend = '';
      let before: Record<string, unknown> = {};
      let after: Record<string, unknown> = {};
      if (act.kind === 'warehouse') {
        const { getPoolState, pausePool } = await import('@/lib/azure/synapse-pool-arm');
        before = (await getPoolState().catch(() => ({}))) as Record<string, unknown>;
        await pausePool();
        backend = 'ARM POST Microsoft.Synapse/workspaces/sqlPools/pause';
        after = { state: 'Pausing' };
      } else if (act.kind === 'adx') {
        const { stopKustoCluster } = await import('@/lib/azure/kusto-arm-client');
        const res = await stopKustoCluster();
        backend = 'ARM POST Microsoft.Kusto/clusters/stop';
        after = { provisioningState: res.provisioningState };
      } else if (act.kind === 'databricks-sql') {
        const { stopWarehouse } = await import('@/lib/azure/databricks-client');
        await stopWarehouse(act.resourceId);
        backend = 'Databricks REST /sql/warehouses/{id}/stop';
        after = { state: 'STOPPING' };
      } else {
        return { ...base, ok: false, summary: `No pause actuator for ${act.kind}.`, backend: 'none', error: 'unsupported-kind' };
      }
      const receipt: ActuationReceipt = { ...base, ok: true, summary: rec.title, backend, before, after };
      await auditActuation(rec, opts, receipt);
      return receipt;
    }

    // env-roll — roll the capacity ceiling through the shared env-apply write path.
    const res = await applyEnvChanges({
      tenantId: opts.tenantId,
      tid: opts.tid,
      who: opts.who,
      actorOid: opts.actorOid,
      values: rec.actuator.values,
      action: 'lcu-autopilot.right-size',
      auditDetail: { recommendationId: rec.id, target: rec.target, values: rec.actuator.values },
    });
    if (!res.ok) {
      return { ...base, ok: false, summary: rec.title, backend: 'env-apply (ACA revision)', error: res.error, after: { revision: res.revision } };
    }
    const receipt: ActuationReceipt = {
      ...base, ok: true, summary: rec.title,
      backend: `env-apply → ${res.platform} revision`,
      after: { changed: res.changed, revision: res.revision },
    };
    await auditActuation(rec, opts, receipt);
    return receipt;
  } catch (e: any) {
    return { ...base, ok: false, summary: rec.title, backend: 'error', error: e?.message || String(e) };
  }
}

async function auditActuation(
  rec: AutopilotRecommendation,
  opts: { tenantId: string; tid?: string; who: string; actorOid: string; actor: string },
  receipt: ActuationReceipt,
): Promise<void> {
  emitAuditEvent({
    actorOid: opts.actorOid,
    actorUpn: opts.who,
    action: `lcu-autopilot.${rec.kind}`,
    targetType: 'autopilot',
    targetId: rec.target,
    tenantId: opts.tid || opts.tenantId,
    detail: {
      recommendationId: rec.id,
      actor: opts.actor,
      usdSavedMonthly: rec.usdSavedMonthly,
      lcuSavedPerHour: rec.lcuSavedPerHour,
      backend: receipt.backend,
    },
  });
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `autopilot:${opts.tenantId}`,
      tenantId: opts.tenantId,
      who: opts.who,
      actorOid: opts.actorOid,
      at: receipt.appliedAt,
      kind: `lcu-autopilot.${rec.kind}`,
      target: rec.target,
      detail: { recommendationId: rec.id, actor: opts.actor, summary: rec.title, before: receipt.before, after: receipt.after },
    }).catch(() => undefined);
  } catch { /* audit failures are non-blocking */ }
}

// ── the loop ─────────────────────────────────────────────────────────────────

export interface AutopilotLoopResult {
  ok: true;
  mode: AutopilotMode;
  ranAt: string;
  sloBreaching: boolean;
  signals: AutopilotSignals;
  recommendations: AutopilotRecommendation[];
  /** Recommendations actually actuated this run (auto mode). */
  actuated: ActuationReceipt[];
  totalMonthlySaving: number;
  history: AutopilotHistoryEntry[];
}

export interface RunAutopilotOpts {
  tenantId: string;
  tid?: string;
  who: string;
  actorOid: string;
  /** Override the persisted mode for THIS run (e.g. an explicit "run in auto"). */
  mode?: AutopilotMode;
  policy?: AutopilotPolicy;
  /** When false, compute WITHOUT persisting cooldowns/history (read-only GET). */
  persist?: boolean;
  now?: () => number;
}

/**
 * Run one iteration: read signals, derive recommendations under the per-target
 * cooldown, actuate the auto-applicable ones in `auto` mode (never while the
 * global SLO is breaching), audit, and persist cooldown + history.
 */
export async function runLcuAutopilotLoop(opts: RunAutopilotOpts): Promise<AutopilotLoopResult> {
  const now = opts.now || Date.now;
  const policy = opts.policy || DEFAULT_AUTOPILOT_POLICY;
  const state = await loadAutopilotState(opts.tenantId);
  const mode: AutopilotMode = opts.mode || state.mode;
  const ranAt = new Date(now()).toISOString();
  const breaching = sloBreaching();

  const signals = await collectAutopilotSignals(policy);
  const ctx: DeriveContext = { now: now(), lastActuatedAt: state.lastActuatedAt };
  const recommendations = deriveAutopilotRecommendations(signals, policy, ctx);

  const actuated: ActuationReceipt[] = [];
  const newHistory: AutopilotHistoryEntry[] = [];

  if (mode === 'auto' && !breaching) {
    for (const rec of autoApplicableRecommendations(recommendations)) {
      const receipt = await executeAutopilotRecommendation(rec, { ...opts, actor: 'auto' });
      actuated.push(receipt);
      if (receipt.ok) state.lastActuatedAt[rec.target] = ranAt;
      newHistory.unshift({
        at: ranAt, target: rec.target, kind: rec.kind, mode,
        actuated: receipt.ok, summary: receipt.ok ? rec.title : `${rec.title} — FAILED`,
        usdSavedMonthly: rec.usdSavedMonthly, error: receipt.error,
      });
    }
  }

  state.mode = mode;
  state.updatedBy = opts.who;
  const mergedHistory = [...newHistory, ...state.history];
  if (opts.persist !== false) {
    state.history = mergedHistory;
    await saveAutopilotState(state).catch(() => undefined);
  }

  return {
    ok: true,
    mode,
    ranAt,
    sloBreaching: breaching,
    signals,
    recommendations,
    actuated,
    totalMonthlySaving: totalMonthlySaving(recommendations),
    history: mergedHistory.slice(0, HISTORY_CAP),
  };
}

/**
 * Approve + execute exactly ONE recommendation by id (the manual "Approve &
 * apply" button). Recomputes signals so the approval acts on current state,
 * finds the rec, executes it for real, and records cooldown + history + audit.
 */
export async function applyAutopilotRecommendationById(opts: RunAutopilotOpts & { recommendationId: string }): Promise<{
  ok: boolean; receipt?: ActuationReceipt; error?: string; recommendation?: AutopilotRecommendation;
}> {
  const now = opts.now || Date.now;
  const policy = opts.policy || DEFAULT_AUTOPILOT_POLICY;
  const state = await loadAutopilotState(opts.tenantId);
  const ranAt = new Date(now()).toISOString();

  const signals = await collectAutopilotSignals(policy);
  const ctx: DeriveContext = { now: now(), lastActuatedAt: state.lastActuatedAt };
  const recs = deriveAutopilotRecommendations(signals, policy, ctx);
  const rec = recs.find((r) => r.id === opts.recommendationId);
  if (!rec) return { ok: false, error: 'recommendation no longer applies (state changed or cooled down)' };
  if (rec.actuator.type === 'advisory') {
    return { ok: false, error: 'advisory recommendation — review and act manually', recommendation: rec };
  }

  const receipt = await executeAutopilotRecommendation(rec, { ...opts, actor: opts.who });
  if (receipt.ok) state.lastActuatedAt[rec.target] = ranAt;
  state.history = [
    { at: ranAt, target: rec.target, kind: rec.kind, mode: state.mode, actuated: receipt.ok, summary: receipt.ok ? rec.title : `${rec.title} — FAILED`, usdSavedMonthly: rec.usdSavedMonthly, error: receipt.error },
    ...state.history,
  ];
  state.updatedBy = opts.who;
  await saveAutopilotState(state).catch(() => undefined);
  return { ok: receipt.ok, receipt, recommendation: rec, error: receipt.ok ? undefined : receipt.error };
}
