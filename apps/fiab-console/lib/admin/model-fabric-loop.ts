/**
 * WS-7 — Closed-Loop Model Fabric (BTB-6): the ACTUATOR + signal reader.
 *
 * This is the server-side orchestration that closes the loop:
 *   1. READ real signals — model-serving endpoints + their Azure Monitor
 *      latency/5xx (WS-1.2), org-wide agent evals grouped by model (WS-1.4),
 *      ai-red-team refusal/attack-success per deployment, and the live
 *      Copilot latency SLO (WS-1.4 obs) as a global guard.
 *   2. DECIDE — hand the per-candidate signals to the pure decider
 *      ({@link decideModelFabric}) which promotes the live-eval winner and
 *      demotes a regression with cooldown + margin + min-sample hysteresis.
 *   3. ACTUATE — in `auto` mode apply the new traffic split through the REAL
 *      WS-1.2 traffic-split (`setServingTraffic`) AND, for the reasoning tier,
 *      promote the best eval model to `LOOM_AOAI_STRONG_DEPLOYMENT` through the
 *      shared env-apply write path (WS-1.1). In `propose` mode it computes the
 *      same decision but actuates NOTHING (the page shows the proposal + an
 *      Apply button). Every actuation is audited (Cosmos audit-log + SIEM).
 *   4. PERSIST — the approval mode, per-endpoint cooldown timestamps, and the
 *      recent decision history to the `model-fabric` Cosmos container.
 *
 * No mocks: signals are real backend reads; actuation is a real ARM
 * traffic-split / env-apply; an unconfigured source degrades to an honest gate
 * (no serving endpoint → nothing to actuate, reported honestly) rather than a
 * fabricated loop (no-vaporware.md). Azure-native only — AML online endpoints
 * + AOAI, Gov-safe (no-fabric-dependency.md).
 */
import { modelFabricContainer, auditLogContainer, agentMemoryContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import {
  listServingEndpoints,
  getServingMetrics,
  setServingTraffic,
  servingConfigGate,
  type ServingEndpointView,
} from '@/lib/azure/model-serving-client';
import { applyEnvChanges } from '@/lib/admin/env-apply';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { tierPolicyFromConfig, reasoningTierConfigured, type TierPolicy } from '@/lib/foundry/model-tier-router';
import { recentCopilotSloEvaluations } from '@/lib/perf/copilot-latency-tracker';
import { summarizeRedTeam, type RedTeamResultRow } from '@/lib/foundry/red-team';
import {
  decideModelFabric,
  compositeScore,
  DEFAULT_FABRIC_POLICY,
  type ModelSignals,
  type FabricDecision,
  type FabricPolicy,
} from '@/lib/admin/model-fabric';

export type FabricMode = 'auto' | 'propose';

/** One recorded decision in the history ledger (per endpoint or the tier). */
export interface FabricHistoryEntry {
  at: string;
  target: string;            // endpoint name or 'reasoning-tier'
  kind: 'serving' | 'tier';
  mode: FabricMode;
  actuated: boolean;         // true only when a real change was applied
  summary: string;           // human one-liner
  changed: boolean;
  heldReason?: string;
  decision?: FabricDecision; // the serving decision (absent for tier)
}

/** Per-tenant persisted loop state (Cosmos `model-fabric`, id == tenantId). */
export interface FabricStateDoc {
  id: string;
  tenantId: string;
  mode: FabricMode;
  /** endpoint name → ISO of the last actuation (hysteresis cooldown source). */
  lastActuatedAt: Record<string, string>;
  history: FabricHistoryEntry[];
  policy?: Partial<FabricPolicy>;
  updatedAt: string;
  updatedBy: string;
}

const HISTORY_CAP = 50;

/** The default approval mode is propose-only: the loop runs + shows proposals
 *  day-one, and an admin flips to `auto` to let it actuate live traffic. */
export const DEFAULT_FABRIC_MODE: FabricMode = 'propose';

// ── state store ──────────────────────────────────────────────────────────────

export async function loadFabricState(tenantId: string): Promise<FabricStateDoc> {
  const c = await modelFabricContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<FabricStateDoc>();
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
    mode: DEFAULT_FABRIC_MODE,
    lastActuatedAt: {},
    history: [],
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
}

export async function saveFabricState(doc: FabricStateDoc): Promise<FabricStateDoc> {
  const c = await modelFabricContainer();
  doc.history = (doc.history || []).slice(0, HISTORY_CAP);
  doc.updatedAt = new Date().toISOString();
  const { resource } = await c.items.upsert<FabricStateDoc>(doc);
  return (resource as FabricStateDoc) ?? doc;
}

/** Set the approval mode (auto vs propose-only) — audited. */
export async function setFabricMode(opts: {
  tenantId: string; tid?: string; who: string; actorOid: string; mode: FabricMode;
}): Promise<FabricStateDoc> {
  const state = await loadFabricState(opts.tenantId);
  const prev = state.mode;
  state.mode = opts.mode === 'auto' ? 'auto' : 'propose';
  state.updatedBy = opts.who;
  const saved = await saveFabricState(state);
  if (prev !== saved.mode) {
    emitAuditEvent({
      actorOid: opts.actorOid,
      actorUpn: opts.who,
      action: 'model-fabric.mode',
      targetType: 'model-fabric',
      targetId: `model-fabric:${opts.tenantId}`,
      tenantId: opts.tid || opts.tenantId,
      detail: { from: prev, to: saved.mode },
    });
  }
  return saved;
}

// ── signal readers (real backends) ───────────────────────────────────────────

/** Aggregated eval signal for one model (mean judge score + regression flag). */
export interface ModelEvalSignal {
  model: string;
  avgScore: number;      // 0..5 latest run
  passRate: number;      // 0..1 latest run
  samples: number;       // scored rows in the latest run
  regressed: boolean;    // latest avgScore < prior run's avgScore
  runs: number;
}

/**
 * Org-wide eval signal grouped by MODEL, read from the loom-agent-memory
 * container (docType 'eval'). Cross-partition, bounded. Real data — the same
 * runs the Agent Quality page (WS-1.4) renders, keyed by the deployment/model
 * they scored so the loop can attribute quality to a serving deployment.
 */
export async function evalSignalsByModel(): Promise<Map<string, ModelEvalSignal>> {
  const c = await agentMemoryContainer();
  const { resources } = await c.items
    .query<{ model?: string; avgScore: number; passRate: number; results?: any[]; createdAt: string }>({
      query:
        "SELECT c.model, c.avgScore, c.passRate, c.results, c.createdAt FROM c " +
        "WHERE c.docType = 'eval' AND IS_DEFINED(c.model) AND c.model != null " +
        'ORDER BY c.createdAt DESC OFFSET 0 LIMIT 500',
      parameters: [],
    })
    .fetchAll();
  // Group newest-first per model; [0] is the latest run, [1] the baseline.
  const byModel = new Map<string, typeof resources>();
  for (const r of resources) {
    const m = (r.model || '').trim();
    if (!m) continue;
    const arr = byModel.get(m) || [];
    arr.push(r);
    byModel.set(m, arr);
  }
  const out = new Map<string, ModelEvalSignal>();
  for (const [model, runs] of byModel) {
    const latest = runs[0];
    const baseline = runs[1];
    const samples = Array.isArray(latest.results) ? latest.results.filter((x: any) => (x?.score ?? 0) > 0).length : 0;
    out.set(model, {
      model,
      avgScore: latest.avgScore ?? 0,
      passRate: latest.passRate ?? 0,
      samples,
      regressed: !!baseline && (latest.avgScore ?? 0) < (baseline.avgScore ?? 0),
      runs: runs.length,
    });
  }
  return out;
}

/** Aggregated red-team signal for one deployment (refusal + attack-success). */
export interface DeploymentRedTeamSignal {
  deployment: string;
  refusalRate: number;
  attackSuccessRate: number;
  total: number;
}

/**
 * Org-wide red-team signal grouped by DEPLOYMENT, read from ai-red-team items'
 * persisted latest run (real refusal-classified scans). Same source as the
 * Agent Quality page's red-team card.
 */
export async function redTeamSignalsByDeployment(): Promise<Map<string, DeploymentRedTeamSignal>> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ state?: Record<string, any> }>({
      query:
        "SELECT c.state FROM c WHERE c.itemType = 'ai-red-team' " +
        'AND (NOT IS_DEFINED(c.state._recycled) OR c.state._recycled = null)',
      parameters: [],
    })
    .fetchAll();
  const out = new Map<string, DeploymentRedTeamSignal>();
  for (const it of resources) {
    const runs: any[] = Array.isArray(it.state?.runs) ? it.state!.runs : [];
    const latest = runs[0];
    if (!latest) continue;
    const deployment = (latest.deployment || '').trim();
    if (!deployment) continue;
    const rows: RedTeamResultRow[] = Array.isArray(latest.results) ? latest.results : [];
    const s = rows.length ? summarizeRedTeam(rows) : (latest.summary ?? { total: 0, refusalRate: 0, attackSuccessRate: 0 });
    // Keep the freshest run per deployment (items are unordered).
    const prev = out.get(deployment);
    if (!prev || (latest.finishedAt || '') > (prev as any)._finishedAt) {
      out.set(deployment, Object.assign(
        { deployment, refusalRate: s.refusalRate ?? 0, attackSuccessRate: s.attackSuccessRate ?? 0, total: s.total ?? 0 },
        { _finishedAt: latest.finishedAt || '' } as any,
      ));
    }
  }
  return out;
}

/** Global latency-SLO guard: true when any measured Copilot SLO is breaching. */
export function sloBreaching(): boolean {
  try {
    const evals = recentCopilotSloEvaluations();
    return evals.some((e) => e.sampled > 0 && !e.met);
  } catch {
    return false;
  }
}

// ── signal assembly per endpoint ─────────────────────────────────────────────

/**
 * Build the per-deployment {@link ModelSignals} for one serving endpoint by
 * joining its deployments (model + current traffic weight) to the eval and
 * red-team signals keyed by model / deployment. Serving error-rate comes from
 * the endpoint's Azure Monitor 5xx-per-minute vs total (WS-1.2 metrics).
 */
export async function signalsForEndpoint(
  ep: ServingEndpointView,
  evalByModel: Map<string, ModelEvalSignal>,
  redTeamByDeployment: Map<string, DeploymentRedTeamSignal>,
): Promise<ModelSignals[]> {
  const traffic = ep.traffic || {};
  const deployments = ep.deployments && ep.deployments.length
    ? ep.deployments
    : Object.keys(traffic).map((name) => ({ name }));

  // Endpoint-level serving error ratio (5xx/min ÷ requests/min) — a shared
  // guard applied to every deployment on this endpoint (AML metrics are
  // endpoint-scoped, not per-deployment).
  let errorRate: number | undefined;
  try {
    const m = await getServingMetrics(ep.name);
    if (m.available && m.requestsPerMin != null && m.requestsPerMin > 0 && m.errorsPerMin != null) {
      errorRate = Math.min(1, m.errorsPerMin / m.requestsPerMin);
    }
  } catch { /* metrics are best-effort — absence just means no error signal */ }

  return deployments.map((d) => {
    const model = (d as any).model as string | undefined;
    const modelKey = normalizeModelKey(model);
    const ev = modelKey ? evalByModel.get(modelKey) : undefined;
    const rt = redTeamByDeployment.get(d.name) || (modelKey ? redTeamByDeployment.get(modelKey) : undefined);
    return {
      key: d.name,
      model,
      evalScore: ev?.avgScore,
      evalPassRate: ev?.passRate,
      evalSamples: ev?.samples,
      regressed: ev?.regressed,
      refusalRate: rt?.refusalRate,
      attackSuccessRate: rt?.attackSuccessRate,
      errorRate,
      currentWeight: traffic[d.name] ?? 0,
    } as ModelSignals;
  });
}

/** A registered model ref can be `name:version` or `azureml:name:version` — the
 *  eval `model` field is usually the bare deployment/model name, so key on the
 *  last non-version-ish segment for a best-effort join. */
function normalizeModelKey(model?: string): string | undefined {
  if (!model) return undefined;
  const parts = model.split(':').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  // Drop a trailing pure-numeric version segment.
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last) && parts.length > 1) return parts[parts.length - 2];
  return parts[parts.length - 1];
}

// ── the loop ─────────────────────────────────────────────────────────────────

export interface FabricLoopResult {
  ok: true;
  mode: FabricMode;
  ranAt: string;
  sloBreaching: boolean;
  /** Honest gate when no serving backend is configured (nothing to actuate). */
  servingGate?: ReturnType<typeof servingConfigGate>;
  endpoints: Array<{
    endpoint: string;
    signals: ModelSignals[];
    decision: FabricDecision;
    actuated: boolean;
    actuationError?: string;
  }>;
  tier: TierProposal;
  history: FabricHistoryEntry[];
}

export interface TierProposal {
  reasoningConfigured: boolean;
  currentStrong?: string;
  proposedStrong?: string;
  changed: boolean;
  actuated: boolean;
  reason: string;
  candidates: Array<{ model: string; avgScore: number; samples: number; composite: number | null }>;
  actuationError?: string;
}

export interface RunLoopOpts {
  tenantId: string;
  tid?: string;
  who: string;
  actorOid: string;
  /** Override the persisted mode for THIS run (e.g. an explicit "Apply now"). */
  mode?: FabricMode;
  /** Copilot config for the tier-router read (tenant Model-tiers config). */
  tierCfg?: Parameters<typeof tierPolicyFromConfig>[0];
  policy?: FabricPolicy;
  /** When false, compute the decision WITHOUT persisting cooldowns/history
   *  (a read-only "what would the loop do now" for the page GET). */
  persist?: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Run one iteration of the closed loop across every multi-deployment serving
 * endpoint + the reasoning tier. Reads real signals, decides, actuates in
 * `auto` mode (or proposes in `propose` mode), audits, and persists cooldown +
 * history. Never throws for a per-endpoint failure — it records the error and
 * continues (a jammed endpoint must not stall the whole loop).
 */
export async function runModelFabricLoop(opts: RunLoopOpts): Promise<FabricLoopResult> {
  const now = opts.now || Date.now;
  const state = await loadFabricState(opts.tenantId);
  const mode: FabricMode = opts.mode || state.mode;
  const policy = opts.policy || DEFAULT_FABRIC_POLICY;
  const ranAt = new Date(now()).toISOString();
  const breaching = sloBreaching();

  // Serving backend gate — no endpoint to actuate when unconfigured (honest).
  const gate = servingConfigGate();

  const [evalByModel, redTeamByDeployment] = await Promise.all([
    evalSignalsByModel().catch(() => new Map<string, ModelEvalSignal>()),
    redTeamSignalsByDeployment().catch(() => new Map<string, DeploymentRedTeamSignal>()),
  ]);

  let endpoints: ServingEndpointView[] = [];
  if (!gate) {
    endpoints = await listServingEndpoints().catch(() => []);
  }

  const results: FabricLoopResult['endpoints'] = [];
  const newHistory: FabricHistoryEntry[] = [];

  for (const ep of endpoints) {
    const signals = await signalsForEndpoint(ep, evalByModel, redTeamByDeployment).catch(() => [] as ModelSignals[]);
    if (signals.length < 2) continue; // single-deployment endpoints can't be split

    const last = state.lastActuatedAt[ep.name];
    const msSince = last ? now() - Date.parse(last) : undefined;
    const decision = decideModelFabric({ endpoint: ep.name, signals, policy, msSinceLastActuation: msSince });

    let actuated = false;
    let actuationError: string | undefined;
    // Actuate ONLY in auto mode, only when the decider produced a change, and
    // never while the global latency SLO is breaching (don't reshape traffic
    // under a live latency incident).
    if (mode === 'auto' && decision.changed && !breaching) {
      try {
        await setServingTraffic(ep.name, decision.newTraffic);
        actuated = true;
        state.lastActuatedAt[ep.name] = ranAt;
        for (const c of decision.candidates) {
          if (c.action === 'hold') continue;
          emitAuditEvent({
            actorOid: opts.actorOid,
            actorUpn: opts.who,
            action: `model-fabric.${c.action}`,
            targetType: 'model-serving-endpoint',
            targetId: ep.name,
            tenantId: opts.tid || opts.tenantId,
            detail: { deployment: c.key, model: c.model, fromWeight: c.fromWeight, toWeight: c.toWeight, composite: c.composite, reason: c.reason },
          });
          await writeAuditRow(opts, { kind: `model-fabric.${c.action}`, target: ep.name, detail: c });
        }
      } catch (e: any) {
        actuationError = e?.message || String(e);
      }
    }

    results.push({ endpoint: ep.name, signals, decision, actuated, actuationError });
    newHistory.unshift({
      at: ranAt,
      target: ep.name,
      kind: 'serving',
      mode,
      actuated,
      changed: decision.changed,
      heldReason: decision.heldReason,
      summary: summarizeDecision(decision, actuated, mode, breaching),
      decision,
    });
  }

  // Reasoning-tier promotion (WS-1.1) — a second, env-apply actuator.
  const tier = await runTierPromotion({ ...opts, mode, policy, evalByModel, breaching, ranAt, state });
  if (tier.changed) {
    newHistory.unshift({
      at: ranAt,
      target: 'reasoning-tier',
      kind: 'tier',
      mode,
      actuated: tier.actuated,
      changed: true,
      summary: tier.reason,
    });
  }

  // Persist cooldowns + history.
  state.mode = mode;
  state.updatedBy = opts.who;
  const mergedHistory = [...newHistory, ...state.history];
  if (opts.persist !== false) {
    state.history = mergedHistory;
    await saveFabricState(state).catch(() => undefined);
  }

  return {
    ok: true,
    mode,
    ranAt,
    sloBreaching: breaching,
    servingGate: gate || undefined,
    endpoints: results,
    tier,
    history: mergedHistory.slice(0, HISTORY_CAP),
  };
}

/** Promote the best-eval reasoning model to LOOM_AOAI_STRONG_DEPLOYMENT. */
async function runTierPromotion(args: {
  tenantId: string; tid?: string; who: string; actorOid: string;
  mode: FabricMode; policy: FabricPolicy; evalByModel: Map<string, ModelEvalSignal>;
  breaching: boolean; ranAt: string; state: FabricStateDoc; tierCfg?: RunLoopOpts['tierCfg'];
}): Promise<TierProposal> {
  const policy = args.policy;
  const tierPolicy: TierPolicy = tierPolicyFromConfig(args.tierCfg ?? null);
  const currentStrong = tierPolicy.tiers.strong;
  const reasoningConfigured = reasoningTierConfigured(args.tierCfg ?? null);

  // Rank eval models by composite (eval-only here; safety folds in when present).
  const candidates = [...args.evalByModel.values()]
    .filter((e) => e.samples >= policy.minEvalSamples)
    .map((e) => ({
      model: e.model,
      avgScore: e.avgScore,
      samples: e.samples,
      composite: compositeScore({ key: e.model, evalScore: e.avgScore, currentWeight: 0 }, policy),
    }))
    .sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));

  const base: TierProposal = {
    reasoningConfigured,
    currentStrong,
    changed: false,
    actuated: false,
    reason: 'held — no eval-winning model beats the current reasoning tier',
    candidates,
  };
  if (candidates.length === 0) {
    base.reason = 'held — no model has enough eval samples to promote the reasoning tier';
    return base;
  }
  const winner = candidates[0];
  const currentComposite = currentStrong
    ? compositeScore({ key: currentStrong, evalScore: args.evalByModel.get(currentStrong)?.avgScore, currentWeight: 0 }, policy)
    : null;

  // Cooldown on the tier target too (anti-flap).
  const last = args.state.lastActuatedAt['reasoning-tier'];
  const msSince = last ? Date.parse(args.ranAt) - Date.parse(last) : undefined;
  const inCooldown = typeof msSince === 'number' && msSince < policy.cooldownMs;

  const beatsCurrent =
    winner.model !== currentStrong &&
    (currentComposite == null || (winner.composite ?? 0) - currentComposite >= policy.marginThreshold);

  if (!beatsCurrent) return base;
  if (inCooldown) { base.reason = 'held — reasoning tier in post-actuation cooldown'; return base; }

  base.proposedStrong = winner.model;
  base.changed = true;
  base.reason = `promote reasoning tier → ${winner.model} (eval ${winner.avgScore.toFixed(2)}/5 over ${winner.samples} samples, composite ${(winner.composite ?? 0).toFixed(2)})${currentStrong ? ` — was ${currentStrong}` : ''}`;

  if (args.mode === 'auto' && !args.breaching) {
    try {
      const res = await applyEnvChanges({
        tenantId: args.tenantId,
        tid: args.tid,
        who: args.who,
        actorOid: args.actorOid,
        values: { LOOM_AOAI_STRONG_DEPLOYMENT: winner.model },
        action: 'model-fabric.promote',
        auditDetail: { target: 'reasoning-tier', model: winner.model, was: currentStrong, composite: winner.composite },
      });
      if (res.ok) {
        base.actuated = true;
        args.state.lastActuatedAt['reasoning-tier'] = args.ranAt;
        await writeAuditRow(args, { kind: 'model-fabric.promote', target: 'reasoning-tier', detail: { model: winner.model, was: currentStrong } });
      } else {
        base.actuationError = res.error;
      }
    } catch (e: any) {
      base.actuationError = e?.message || String(e);
    }
  }
  return base;
}

// ── audit helper ─────────────────────────────────────────────────────────────

async function writeAuditRow(
  opts: { tenantId: string; who: string; actorOid: string },
  entry: { kind: string; target: string; detail: unknown },
): Promise<void> {
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `model-fabric:${opts.tenantId}`,
      tenantId: opts.tenantId,
      who: opts.who,
      actorOid: opts.actorOid,
      at: new Date().toISOString(),
      kind: entry.kind,
      target: entry.target,
      detail: entry.detail,
    }).catch(() => undefined);
  } catch { /* audit failures are non-blocking */ }
}

function summarizeDecision(decision: FabricDecision, actuated: boolean, mode: FabricMode, breaching: boolean): string {
  if (decision.held) return `hold (${decision.heldReason})`;
  const promoted = decision.candidates.filter((c) => c.action === 'promote').map((c) => c.key);
  const demoted = decision.candidates.filter((c) => c.action === 'demote').map((c) => c.key);
  const verb = actuated ? 'applied' : mode === 'auto' ? (breaching ? 'skipped (SLO breaching)' : 'no change') : 'proposed';
  return `${verb}: promote ${promoted.join(', ') || '—'} / demote ${demoted.join(', ') || '—'}`;
}
