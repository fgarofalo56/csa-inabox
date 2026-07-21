/**
 * WS-10.1 — LCU-Autopilot (BTB-2, Self-Driving Platform): the PURE policy engine.
 *
 * Given real LCU telemetry (per-compute LCU/hr + $/mo + live utilization/idle
 * state, from the chargeback model + Azure Monitor) and the gate/self-audit
 * signal, this module DECIDES which FinOps actions to recommend — with explicit
 * thresholds and hysteresis so the loop never flaps. It is deliberately free of
 * any Azure SDK / Cosmos import so it is unit-testable in isolation; the loop
 * (`lcu-autopilot-loop.ts`) reads the real signals, calls this decider, and
 * actuates the returned recommendations (pause idle compute / roll env-config).
 *
 * Recommendation kinds (spec §WS-10.1 — "pause idle compute, right-size, migrate"):
 *   - 'pause-idle'    → a running compute resource sat idle past the sustained
 *                       window → pause/stop it (real ARM pause/stop). REAL $/mo
 *                       saved (paused compute stops billing). Auto-actuatable.
 *   - 'right-size'    → the published LCU capacity ceiling is far above observed
 *                       peak → roll LOOM_CAPACITY_LCU down to peak + headroom via
 *                       the shared env-apply write path (an env-config revision
 *                       roll — the second actuator). Config alignment, not $ (the
 *                       ceiling is a reference, so impact is reported honestly as
 *                       trimmed headroom, never a fabricated dollar saving).
 *                       Auto-actuatable.
 *   - 'migrate'       → advisory only (propose, never auto): an expensive engine
 *                       with a cheaper Azure-native substrate available / a
 *                       blocked gate. Surfaced with evidence; a human decides.
 *
 * Hysteresis (anti-flap): a compute must be idle for at least `idleMinMinutes`
 * (sustained, from its measured `idleMinutes`) AND out of its post-actuation
 * `cooldownMs` window before pause-idle fires. `right-size` requires the peak to
 * be below the ceiling by at least `capacityHeadroomTrimPct` AND out of cooldown.
 *
 * No mocks, no fabricated numbers: every field the decider reasons over is a real
 * measurement supplied by the loop; an absent measurement (utilization unknown)
 * is treated as "not idle" (never pause on missing data) — fail-safe.
 */

// ── telemetry types (populated by the loop from real backends) ───────────────

/** The compute families the autopilot can reason about + actuate. */
export type ComputeKind =
  | 'warehouse'        // Synapse Dedicated SQL pool (pause/resume via ARM)
  | 'adx'              // Azure Data Explorer cluster (stop/start via ARM)
  | 'databricks-sql'   // Databricks SQL Warehouse (stop/start via REST)
  | 'spark'            // Synapse Livy warm pool (session reap / warm-to-0)
  | 'serving';         // AML managed online endpoint (scale-to-zero / idle)

/** How a recommendation is applied — the actuator descriptor the loop executes. */
export type AutopilotActuator =
  | { type: 'pause'; kind: ComputeKind; resourceId: string }
  | { type: 'env-roll'; values: Record<string, string> }
  | { type: 'advisory' };

/** One real compute resource with its live LCU + utilization telemetry. */
export interface ComputeTelemetry {
  kind: ComputeKind;
  /** Stable id for cooldown/dedupe (e.g. 'warehouse:loompool', 'adx:<cluster>'). */
  id: string;
  /** Human name for the UI. */
  name: string;
  /** Consumed/allocated LCU per hour for this resource (real, from chargeback). */
  lcuPerHour: number;
  /** Estimated monthly $ this resource is costing while running (real Cost Mgmt). */
  usdMonthly: number;
  /**
   * Live utilization %, 0..100, or null when no Azure Monitor metric exists for
   * the type (Databricks/AML) — null is treated as "activity unknown", never idle.
   */
  utilizationPct: number | null;
  /** Minutes the resource has been continuously idle (0 when active/unknown). */
  idleMinutes: number;
  /** Live lifecycle state ('Online'|'Running'|'Paused'|'Stopped'|'Unknown'). */
  state: string;
  /** True when the resource is in a state the autopilot can pause/stop. */
  pausable: boolean;
  /** The actuator that would pause this resource (absent → not directly pausable). */
  pauseActuator?: Extract<AutopilotActuator, { type: 'pause' }>;
}

/** The published LCU capacity ceiling vs observed consumption (from chargeback). */
export interface CapacitySignal {
  /** Consumed LCU across the window (the Loom CU number). */
  totalLcu: number;
  /** Peak consumed LCU observed in the window. */
  peakLcu: number;
  /** Provisioned/peak LCU ceiling (the 100%-utilization reference). */
  capacityLcu: number;
  /** 'env' (LOOM_CAPACITY_LCU explicitly set) | 'derived' (auto peak+headroom). */
  capacitySource: 'env' | 'derived';
  /** totalLcu / capacityLcu * 100 — the Loom CU utilization %. */
  utilizationPct: number;
}

/** Everything the decider reasons over — assembled by the loop from real reads. */
export interface AutopilotSignals {
  compute: ComputeTelemetry[];
  capacity: CapacitySignal | null;
  /** Count of gate-registry gates currently blocked (self-audit signal). */
  gatesBlocked: number;
  /** Total LCU/hr + monthly $ across all compute (headline telemetry). */
  totalLcuPerHour: number;
  totalUsdMonthly: number;
  /** Honest gate when the LCU telemetry backend (Cost Management) is unavailable. */
  telemetryGate?: { reason: string; remediation: string };
}

// ── policy (thresholds + hysteresis) ─────────────────────────────────────────

export interface AutopilotPolicy {
  /** At/below this utilization % a compute counts as idle (default 5%). */
  idleUtilPct: number;
  /** Sustained idle minutes required before pausing (hysteresis, default 30). */
  idleMinMinutes: number;
  /** Don't bother pausing a resource cheaper than this $/mo (default $1). */
  minMonthlyUsdToPause: number;
  /** Per-target cooldown after any actuation (anti-flap, default 6h). */
  cooldownMs: number;
  /**
   * Right-size the capacity ceiling only when peak is below it by at least this
   * fraction (default 0.35 → peak < 65% of ceiling), and the ceiling is
   * explicitly set via env (source 'env'). Trims to peak * (1 + headroomKeepPct).
   */
  capacityHeadroomTrimPct: number;
  /** Headroom kept above peak when right-sizing the ceiling (default 0.25). */
  headroomKeepPct: number;
}

export const DEFAULT_AUTOPILOT_POLICY: AutopilotPolicy = {
  idleUtilPct: 5,
  idleMinMinutes: 30,
  minMonthlyUsdToPause: 1,
  cooldownMs: 6 * 60 * 60 * 1000,
  capacityHeadroomTrimPct: 0.35,
  headroomKeepPct: 0.25,
};

// ── recommendation output ────────────────────────────────────────────────────

export type RecommendationKind = 'pause-idle' | 'right-size' | 'migrate';

export interface RecEvidence {
  label: string;
  value: string;
}

export interface AutopilotRecommendation {
  /** Deterministic id (kind + target) so the UI/loop can dedupe + approve one. */
  id: string;
  kind: RecommendationKind;
  /** Target resource id (or 'capacity' for the ceiling right-size). */
  target: string;
  /** Human title, e.g. "Pause idle warehouse loompool". */
  title: string;
  /** One-line rationale. */
  summary: string;
  /** REAL monthly $ saved when applied (0 for config-alignment right-sizes). */
  usdSavedMonthly: number;
  /** LCU/hr freed when applied. */
  lcuSavedPerHour: number;
  /** Confidence 0..1 (utilization certainty). */
  confidence: number;
  /** Grounding measurements (no hidden numbers — no-vaporware). */
  evidence: RecEvidence[];
  /** How the loop applies it. `advisory` never auto-actuates. */
  actuator: AutopilotActuator;
  /** True when the loop may apply this in `auto` mode without a human. */
  autoApplicable: boolean;
}

/** Per-run context: cooldown clock + last-actuation timestamps per target. */
export interface DeriveContext {
  now: number;
  /** target id → ISO timestamp of the last actuation (hysteresis source). */
  lastActuatedAt: Record<string, string>;
}

// ── the decider (pure) ───────────────────────────────────────────────────────

function inCooldown(ctx: DeriveContext, target: string, cooldownMs: number): boolean {
  const last = ctx.lastActuatedAt[target];
  if (!last) return false;
  const since = ctx.now - Date.parse(last);
  return Number.isFinite(since) && since < cooldownMs;
}

/** Estimate the monthly $ a resource saves when paused (its running $/mo). */
export function monthlySavingForPause(t: ComputeTelemetry): number {
  return Math.max(0, Math.round(t.usdMonthly * 100) / 100);
}

/**
 * Derive the FinOps recommendations for one set of signals under `policy`.
 * Pure + deterministic: same inputs → same output. Sorted by $ impact desc.
 */
export function deriveAutopilotRecommendations(
  signals: AutopilotSignals,
  policy: AutopilotPolicy = DEFAULT_AUTOPILOT_POLICY,
  ctx: DeriveContext = { now: Date.now(), lastActuatedAt: {} },
): AutopilotRecommendation[] {
  const recs: AutopilotRecommendation[] = [];

  // ── Rule 1: pause idle compute ──────────────────────────────────────────────
  for (const t of signals.compute) {
    // Fail-safe: never act on unknown activity (utilization null) — only on a
    // real measured-idle reading.
    if (t.utilizationPct === null) continue;
    const isIdle = t.utilizationPct <= policy.idleUtilPct;
    const sustained = t.idleMinutes >= policy.idleMinMinutes;
    const worthIt = monthlySavingForPause(t) >= policy.minMonthlyUsdToPause;
    if (!(isIdle && sustained && worthIt && t.pausable && t.pauseActuator)) continue;
    if (inCooldown(ctx, t.id, policy.cooldownMs)) continue;

    const saved = monthlySavingForPause(t);
    recs.push({
      id: `pause-idle:${t.id}`,
      kind: 'pause-idle',
      target: t.id,
      title: `Pause idle ${labelForKind(t.kind)} ${t.name}`,
      summary:
        `${t.name} has been idle (${t.utilizationPct.toFixed(1)}% ≤ ${policy.idleUtilPct}%) for ` +
        `${t.idleMinutes} min while running — pausing stops its compute billing (data survives).`,
      usdSavedMonthly: saved,
      lcuSavedPerHour: Math.round(t.lcuPerHour * 100) / 100,
      confidence: 0.9,
      evidence: [
        { label: 'Utilization', value: `${t.utilizationPct.toFixed(1)}%` },
        { label: 'Idle for', value: `${t.idleMinutes} min` },
        { label: 'LCU/hr', value: t.lcuPerHour.toFixed(2) },
        { label: 'Est. $/mo running', value: `$${t.usdMonthly.toFixed(2)}` },
        { label: 'State', value: t.state },
      ],
      actuator: t.pauseActuator,
      autoApplicable: true,
    });
  }

  // ── Rule 2: right-size the LCU capacity ceiling (env-config revision roll) ────
  const cap = signals.capacity;
  if (cap && cap.capacitySource === 'env' && cap.capacityLcu > 0) {
    const peakFrac = cap.peakLcu / cap.capacityLcu; // 0..1
    if (peakFrac <= 1 - policy.capacityHeadroomTrimPct) {
      const target = Math.max(1, Math.ceil(cap.peakLcu * (1 + policy.headroomKeepPct)));
      if (target < cap.capacityLcu && !inCooldown(ctx, 'capacity', policy.cooldownMs)) {
        const trimmedLcu = cap.capacityLcu - target;
        recs.push({
          id: 'right-size:capacity',
          kind: 'right-size',
          target: 'capacity',
          title: 'Right-size the LCU capacity ceiling',
          summary:
            `Observed peak is ${cap.peakLcu.toFixed(1)} LCU against a ${cap.capacityLcu} LCU ceiling ` +
            `(${(peakFrac * 100).toFixed(0)}%). Roll LOOM_CAPACITY_LCU to ${target} (peak + ` +
            `${Math.round(policy.headroomKeepPct * 100)}% headroom) so the utilization baseline + ` +
            `surge alerts reflect real demand.`,
          // Honest: the ceiling is a reference for utilization/chargeback, not
          // provisioned spend — so NO fabricated $ saving. Impact = trimmed LCU.
          usdSavedMonthly: 0,
          lcuSavedPerHour: 0,
          confidence: 0.75,
          evidence: [
            { label: 'Peak LCU', value: cap.peakLcu.toFixed(1) },
            { label: 'Current ceiling', value: `${cap.capacityLcu} LCU` },
            { label: 'Proposed ceiling', value: `${target} LCU` },
            { label: 'Trimmed headroom', value: `${trimmedLcu} LCU` },
          ],
          actuator: { type: 'env-roll', values: { LOOM_CAPACITY_LCU: String(target) } },
          autoApplicable: true,
        });
      }
    }
  }

  // ── Rule 3: migrate (advisory — propose only, never auto) ─────────────────────
  for (const t of signals.compute) {
    if (t.utilizationPct === null) continue;
    // A persistently near-idle ADX cluster is a candidate to migrate its workload
    // onto a cheaper Azure-native substrate (Serverless/ADLS). Advisory only — a
    // migration is never something the loop performs unattended.
    const deeplyIdle = t.utilizationPct <= policy.idleUtilPct && t.idleMinutes >= policy.idleMinMinutes * 4;
    if (t.kind === 'adx' && deeplyIdle && t.usdMonthly >= policy.minMonthlyUsdToPause * 10) {
      recs.push({
        id: `migrate:${t.id}`,
        kind: 'migrate',
        target: t.id,
        title: `Consider migrating workload off ${t.name}`,
        summary:
          `${t.name} has been idle for ${t.idleMinutes} min yet costs ~$${t.usdMonthly.toFixed(0)}/mo. ` +
          `If usage stays this low, migrating its tables to Synapse Serverless over ADLS Delta removes ` +
          `the always-on cluster cost. Review before acting.`,
        usdSavedMonthly: 0,
        lcuSavedPerHour: 0,
        confidence: 0.4,
        evidence: [
          { label: 'Utilization', value: `${t.utilizationPct.toFixed(1)}%` },
          { label: 'Idle for', value: `${t.idleMinutes} min` },
          { label: 'Est. $/mo', value: `$${t.usdMonthly.toFixed(2)}` },
        ],
        actuator: { type: 'advisory' },
        autoApplicable: false,
      });
    }
  }

  return recs.sort((a, b) => b.usdSavedMonthly - a.usdSavedMonthly || a.id.localeCompare(b.id));
}

/** Recommendations the loop may apply unattended in `auto` mode. */
export function autoApplicableRecommendations(recs: AutopilotRecommendation[]): AutopilotRecommendation[] {
  return recs.filter((r) => r.autoApplicable && r.actuator.type !== 'advisory');
}

/** Total real monthly $ the current recommendation set would save if applied. */
export function totalMonthlySaving(recs: AutopilotRecommendation[]): number {
  return Math.round(recs.reduce((s, r) => s + r.usdSavedMonthly, 0) * 100) / 100;
}

export function labelForKind(kind: ComputeKind): string {
  switch (kind) {
    case 'warehouse': return 'warehouse';
    case 'adx': return 'ADX cluster';
    case 'databricks-sql': return 'SQL warehouse';
    case 'spark': return 'Spark pool';
    case 'serving': return 'serving endpoint';
    default: return String(kind);
  }
}
