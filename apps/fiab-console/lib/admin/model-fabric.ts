/**
 * WS-7 — Closed-Loop Model Fabric (BTB-6): the PURE decision service.
 *
 * The self-optimizing loop that fuses the four existing model-quality signals
 * into one automatic promote/demote decision over a serving-endpoint traffic
 * split (or the tier-router deployment mapping):
 *
 *   routing  — model-tier-router (WS-1.1)          → which deployment a turn rides
 *   eval     — agent evals (WS-1.4, LLM-judge)     → answer quality per model
 *   red-team — ai-red-team refusal / attack-success → safety per deployment
 *   serving  — model-serving latency / 5xx (WS-1.2) → operational health
 *   obs      — copilot-slo / agentops               → global latency-SLO guard
 *
 * This module owns ONLY the deterministic, side-effect-free decision math:
 * given the recent signals per candidate deployment + the current traffic
 * split + how long since the last actuation, decide whether to PROMOTE the
 * live-eval winner, DEMOTE a regression, or HOLD — with explicit thresholds
 * and hysteresis (cooldown + margin + min-sample) so it never flaps.
 *
 * No Azure SDK, no Cosmos, no React — fully unit-testable. The actuator
 * (lib/admin/model-fabric-loop.ts) reads the real signals, calls this decider,
 * and applies the result via the REAL WS-1.2 traffic-split / env-apply write
 * paths, auditing each action. Per no-vaporware.md the numbers here are always
 * derived from real eval/obs data — this module never invents a signal.
 *
 * Grounding: progressive-delivery / canary weight-shifting + SRE error-budget
 * practice (https://learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments).
 */

/** What the loop does to a candidate deployment's traffic share. */
export type FabricAction = 'promote' | 'demote' | 'hold';

/** Why the loop actuated nothing this run (hysteresis / data reasons). */
export type FabricHeldReason =
  | 'cooldown'
  | 'no-margin'
  | 'insufficient-data'
  | 'single-candidate'
  | 'no-signal';

/**
 * The recent, REAL signals for one candidate deployment behind a serving
 * endpoint (or one tier deployment). Every field is optional because a source
 * may have no data yet — the decider degrades honestly rather than inventing a
 * number (an all-`undefined` candidate can only ever HOLD).
 */
export interface ModelSignals {
  /** Traffic-split key — the serving deployment name (or tier deployment). */
  key: string;
  /** Registered / AOAI model this deployment serves (for the audit reason). */
  model?: string;
  /** Mean LLM-judge score 0..5 (WS-1.4 eval). Undefined = no eval run. */
  evalScore?: number;
  /** Eval pass-rate 0..1. */
  evalPassRate?: number;
  /** Number of scored eval rows behind {@link evalScore} (the sample size). */
  evalSamples?: number;
  /** True when this model's latest eval REGRESSED vs its own baseline (WS-1.4). */
  regressed?: boolean;
  /** Red-team refusal rate 0..100 (higher = safer). */
  refusalRate?: number;
  /** Red-team attack-success rate 0..100 (lower = safer). */
  attackSuccessRate?: number;
  /** Serving 5xx error ratio 0..1 (WS-1.2 Azure Monitor). */
  errorRate?: number;
  /** Serving p90 latency ms (tiebreak / context only). */
  latencyMsP90?: number;
  /** Current traffic percentage 0..100 for this deployment. */
  currentWeight: number;
}

/** Tunable thresholds + hysteresis knobs. Admin-overridable; safe defaults. */
export interface FabricPolicy {
  /** Require ≥ this many scored eval rows before an eval-driven promote. */
  minEvalSamples: number;
  /** Composite margin the winner must beat the current leader by to promote. */
  marginThreshold: number;
  /** Max total traffic points shifted in one run (bounds blast radius). */
  step: number;
  /** Floor a live deployment keeps even when demoted (0 = can drain fully). */
  minWeight: number;
  /** Hysteresis: min ms between actuations on the SAME endpoint (anti-flap). */
  cooldownMs: number;
  /** Refusal-rate below this ⇒ demote for safety (0..100). */
  regressionRefusalFloor: number;
  /** Attack-success above this ⇒ demote for safety (0..100). */
  attackSuccessCeil: number;
  /** Composite weights (renormalized over whichever components are present). */
  weights: { eval: number; safety: number; error: number };
}

export const DEFAULT_FABRIC_POLICY: FabricPolicy = {
  minEvalSamples: 4,
  marginThreshold: 0.05,
  step: 20,
  minWeight: 0,
  cooldownMs: 6 * 60 * 60 * 1000, // 6h
  regressionRefusalFloor: 80,
  attackSuccessCeil: 10,
  weights: { eval: 0.6, safety: 0.3, error: 0.1 },
};

/** The per-candidate outcome the audit trail + page render. */
export interface FabricCandidateDecision {
  key: string;
  model?: string;
  action: FabricAction;
  fromWeight: number;
  toWeight: number;
  /** Composite 0..1 (null when the candidate has no rankable signal). */
  composite: number | null;
  reason: string;
}

/** The full decision for one endpoint — what the actuator applies. */
export interface FabricDecision {
  endpoint: string;
  candidates: FabricCandidateDecision[];
  /** Proposed traffic split (integers summing to 100). */
  newTraffic: Record<string, number>;
  /** The split observed before the decision. */
  currentTraffic: Record<string, number>;
  /** True when newTraffic differs from currentTraffic (something to actuate). */
  changed: boolean;
  /** True when the loop deliberately actuated nothing this run. */
  held: boolean;
  heldReason?: FabricHeldReason;
}

export interface DecideInput {
  endpoint: string;
  signals: ModelSignals[];
  policy?: FabricPolicy;
  /** ms since the last actuation on THIS endpoint (undefined = never). */
  msSinceLastActuation?: number;
}

// ── composite scoring ────────────────────────────────────────────────────────

/**
 * Blend a candidate's signals into a single 0..1 quality score, renormalizing
 * over whichever components are actually present. Returns null when the
 * candidate has NEITHER an eval score NOR a safety signal — it cannot be ranked
 * and can only ever HOLD (honest: no invented baseline).
 */
export function compositeScore(sig: ModelSignals, policy: FabricPolicy = DEFAULT_FABRIC_POLICY): number | null {
  const parts: Array<{ w: number; v: number }> = [];
  if (typeof sig.evalScore === 'number' && Number.isFinite(sig.evalScore)) {
    parts.push({ w: policy.weights.eval, v: clamp01(sig.evalScore / 5) });
  }
  const safety = safetyScore(sig);
  if (safety != null) parts.push({ w: policy.weights.safety, v: safety });
  if (parts.length === 0) return null;
  // Error is a PENALTY only (never a standalone quality signal), applied after
  // the positive components are renormalized.
  const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
  let score = parts.reduce((a, p) => a + p.w * p.v, 0) / wsum;
  if (typeof sig.errorRate === 'number' && Number.isFinite(sig.errorRate)) {
    score -= policy.weights.error * clamp01(sig.errorRate);
  }
  return clamp01(score);
}

/** Safety sub-score 0..1 from red-team signals (null when neither present). */
function safetyScore(sig: ModelSignals): number | null {
  if (typeof sig.refusalRate === 'number' && Number.isFinite(sig.refusalRate)) {
    return clamp01(sig.refusalRate / 100);
  }
  if (typeof sig.attackSuccessRate === 'number' && Number.isFinite(sig.attackSuccessRate)) {
    return clamp01(1 - sig.attackSuccessRate / 100);
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** A candidate is UNSAFE when red-team refusal fell below the floor or attack
 *  success rose above the ceiling — an automatic demote regardless of eval. */
function isUnsafe(sig: ModelSignals, policy: FabricPolicy): boolean {
  if (typeof sig.refusalRate === 'number' && sig.refusalRate < policy.regressionRefusalFloor) return true;
  if (typeof sig.attackSuccessRate === 'number' && sig.attackSuccessRate > policy.attackSuccessCeil) return true;
  return false;
}

// ── the decision ─────────────────────────────────────────────────────────────

/**
 * Decide the promote/demote/hold action per candidate + the resulting traffic
 * split. Deterministic and pure. The invariants (unit-tested):
 *   • PROMOTE — the highest-composite candidate whose composite beats the
 *     current traffic leader's by ≥ marginThreshold gains up to `step` points,
 *     drawn from the demoted / worst candidate(s). Requires ≥ minEvalSamples
 *     when the promotion is eval-driven.
 *   • DEMOTE — a candidate that REGRESSED, went UNSAFE, or scores well below the
 *     winner loses up to `step` points (floored at minWeight).
 *   • HOLD (hysteresis) — within the cooldown window, with < 2 candidates, when
 *     no candidate has a rankable signal, or when the winner's margin is too
 *     small / sample too small, nothing is actuated (changed=false).
 * The returned newTraffic always sums to 100 (points are only moved, never
 * created), so the actuator can hand it straight to the WS-1.2 traffic-split.
 */
export function decideModelFabric(input: DecideInput): FabricDecision {
  const policy = input.policy ?? DEFAULT_FABRIC_POLICY;
  const endpoint = input.endpoint;
  const signals = input.signals || [];
  const currentTraffic = trafficOf(signals);

  const holdAll = (reason: FabricHeldReason): FabricDecision => ({
    endpoint,
    candidates: signals.map((s) => ({
      key: s.key,
      model: s.model,
      action: 'hold' as const,
      fromWeight: s.currentWeight,
      toWeight: s.currentWeight,
      composite: compositeScore(s, policy),
      reason: heldCandidateReason(reason),
    })),
    newTraffic: { ...currentTraffic },
    currentTraffic,
    changed: false,
    held: true,
    heldReason: reason,
  });

  if (signals.length < 2) return holdAll('single-candidate');

  // Hysteresis: never actuate twice inside the cooldown window.
  if (typeof input.msSinceLastActuation === 'number' && input.msSinceLastActuation < policy.cooldownMs) {
    return holdAll('cooldown');
  }

  // Rank by composite. Candidates with no rankable signal are held-eligible only.
  const scored = signals.map((s) => ({ sig: s, composite: compositeScore(s, policy) }));
  const rankable = scored.filter((c) => c.composite != null) as Array<{ sig: ModelSignals; composite: number }>;
  if (rankable.length === 0) return holdAll('no-signal');

  // A promote winner must be ELIGIBLE — not itself regressed or unsafe (never
  // promote a model that just regressed). The leader is the current
  // traffic-max regardless of eligibility.
  const eligible = rankable.filter((c) => !c.sig.regressed && !isUnsafe(c.sig, policy));
  if (eligible.length === 0) return holdAll('no-signal');
  const winner = eligible.reduce((a, b) => (b.composite > a.composite ? b : a));
  const leader = signals.reduce((a, b) => (b.currentWeight > a.currentWeight ? b : a));
  const leaderComposite = compositeScore(leader, policy);

  // DEMOTES: regressed OR unsafe OR composite well below the winner.
  const demoteCut = winner.composite - policy.marginThreshold * 2;
  const demotes = new Set<string>();
  const reasons = new Map<string, string>();
  for (const s of signals) {
    const c = compositeScore(s, policy);
    if (s.key === winner.sig.key) continue;
    if (s.regressed) { demotes.add(s.key); reasons.set(s.key, 'eval regressed vs baseline'); continue; }
    if (isUnsafe(s, policy)) { demotes.add(s.key); reasons.set(s.key, `red-team below safety floor (refusal ${fmt(s.refusalRate)}%, attack ${fmt(s.attackSuccessRate)}%)`); continue; }
    if (c != null && c < demoteCut && s.currentWeight > policy.minWeight) {
      demotes.add(s.key);
      reasons.set(s.key, `composite ${c.toFixed(2)} trails winner ${winner.composite.toFixed(2)}`);
    }
  }

  // Is a PROMOTE warranted? Winner must beat the current leader by the margin,
  // have room to grow, and (when eval-driven) enough samples.
  const marginOk =
    leaderComposite == null ||
    winner.sig.key === leader.key
      ? demotes.size > 0 // already leads → only promote to absorb freed demote points
      : winner.composite - (leaderComposite ?? 0) >= policy.marginThreshold;
  const evalDriven = typeof winner.sig.evalScore === 'number';
  const sampleOk = !evalDriven || (winner.sig.evalSamples ?? 0) >= policy.minEvalSamples;

  if (!sampleOk) return holdAll('insufficient-data');
  if (!marginOk && demotes.size === 0) return holdAll('no-margin');

  // ── Move points: drain the demoted (worst composite first) up to `step`
  // total, hand the freed points to the winner. If nothing is demotable but a
  // promote is warranted, draw `step` from the worst-composite other candidate.
  const next: Record<string, number> = { ...currentTraffic };
  let freed = 0;
  const demoteOrder = [...demotes]
    .map((k) => ({ k, c: compositeScore(byKey(signals, k)!, policy) ?? 0 }))
    .sort((a, b) => a.c - b.c);
  for (const { k } of demoteOrder) {
    if (freed >= policy.step) break;
    const removable = Math.min(policy.step - freed, next[k] - policy.minWeight);
    if (removable <= 0) continue;
    next[k] -= removable;
    freed += removable;
  }
  if (freed === 0 && marginOk && next[winner.sig.key] < 100) {
    // No explicit demote, but the winner earned a shift — take from the
    // worst-composite non-winner that has points to give.
    const donor = rankable
      .filter((c) => c.sig.key !== winner.sig.key && next[c.sig.key] > policy.minWeight)
      .sort((a, b) => a.composite - b.composite)[0];
    if (donor) {
      const take = Math.min(policy.step, next[donor.sig.key] - policy.minWeight);
      if (take > 0) {
        next[donor.sig.key] -= take;
        freed += take;
        demotes.add(donor.sig.key);
        reasons.set(donor.sig.key, `yielded ${take} pts to winner (composite ${donor.composite.toFixed(2)})`);
      }
    }
  }
  if (freed > 0) next[winner.sig.key] = Math.min(100, next[winner.sig.key] + freed);

  const normalized = normalizeTraffic(next);
  const changed = !sameTraffic(normalized, currentTraffic);
  if (!changed) return holdAll('no-margin');

  const candidates: FabricCandidateDecision[] = signals.map((s) => {
    const composite = compositeScore(s, policy);
    let action: FabricAction = 'hold';
    let reason = 'held — within tolerance';
    if (s.key === winner.sig.key && normalized[s.key] > currentTraffic[s.key]) {
      action = 'promote';
      reason = evalDriven
        ? `live-eval winner (score ${fmt(s.evalScore)}/5${s.evalPassRate != null ? `, ${Math.round(s.evalPassRate * 100)}% pass` : ''}) — traffic ${currentTraffic[s.key]}%→${normalized[s.key]}%`
        : `highest composite ${composite?.toFixed(2)} — traffic ${currentTraffic[s.key]}%→${normalized[s.key]}%`;
    } else if (demotes.has(s.key) && normalized[s.key] < currentTraffic[s.key]) {
      action = 'demote';
      reason = `${reasons.get(s.key) || 'demoted'} — traffic ${currentTraffic[s.key]}%→${normalized[s.key]}%`;
    }
    return { key: s.key, model: s.model, action, fromWeight: currentTraffic[s.key], toWeight: normalized[s.key], composite, reason };
  });

  return { endpoint, candidates, newTraffic: normalized, currentTraffic, changed: true, held: false };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function heldCandidateReason(reason: FabricHeldReason): string {
  switch (reason) {
    case 'cooldown': return 'held — endpoint in post-actuation cooldown';
    case 'single-candidate': return 'held — needs ≥2 deployments to shift traffic';
    case 'insufficient-data': return 'held — not enough eval samples yet';
    case 'no-margin': return 'held — no candidate beats the leader by the margin';
    case 'no-signal': return 'held — no eval / red-team signal yet';
    default: return 'held';
  }
}

function trafficOf(signals: ModelSignals[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const s of signals) t[s.key] = Math.max(0, Math.round(s.currentWeight));
  return t;
}

function byKey(signals: ModelSignals[], key: string): ModelSignals | undefined {
  return signals.find((s) => s.key === key);
}

function fmt(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '—';
}

/**
 * Normalize an integer traffic map to sum EXACTLY 100 (largest-remainder), so a
 * split handed to the WS-1.2 traffic-split validator always totals 100.
 */
export function normalizeTraffic(traffic: Record<string, number>): Record<string, number> {
  const keys = Object.keys(traffic);
  if (keys.length === 0) return {};
  const raw = keys.map((k) => Math.max(0, traffic[k]));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    // Degenerate — everything drained; give it all to the first key.
    const out: Record<string, number> = {};
    keys.forEach((k, i) => (out[k] = i === 0 ? 100 : 0));
    return out;
  }
  const scaled = raw.map((v) => (v / sum) * 100);
  const floored = scaled.map((v) => Math.floor(v));
  let remainder = 100 - floored.reduce((a, b) => a + b, 0);
  // Hand the remaining points to the largest fractional parts.
  const order = scaled
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const out: Record<string, number> = {};
  keys.forEach((k, i) => (out[k] = floored[i]));
  for (let j = 0; j < order.length && remainder > 0; j++) { out[keys[order[j].i]] += 1; remainder--; }
  return out;
}

function sameTraffic(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}
