/**
 * CTS-03 — lightweight per-turn phase timer for the Copilot orchestrator.
 *
 * Accumulates wall-clock ms per orchestration phase (classify → prompt-build →
 * llm → tools) so the admin deep-trace panel's Timeline tab can render a real
 * per-phase bar chart. Pure (no Azure/Next imports) so it is unit-testable and
 * adds ~zero overhead — a couple of Date.now() reads per turn.
 *
 * Two accumulation modes:
 *   - `lap(phase)` records the elapsed time since the last mark INTO `phase` and
 *     resets the mark — used for the SEQUENTIAL setup phases (classify then
 *     prompt-build), each measured as a boundary crossing.
 *   - `add(phase, ms)` adds an explicitly-measured duration — used for the
 *     INTERLEAVED loop phases (llm round-trips, tool executions) whose spans are
 *     already timed individually.
 */

export interface PhaseTiming {
  phase: string;
  ms: number;
}

export class PhaseTimer {
  private acc: Record<string, number> = {};
  private order: string[] = [];
  private markT: number;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.markT = now();
  }

  /** Record elapsed-since-last-mark into `phase`, then reset the mark. */
  lap(phase: string): void {
    const t = this.now();
    this.bump(phase, Math.max(0, t - this.markT));
    this.markT = t;
  }

  /** Add an already-measured duration to `phase` (does not move the mark). */
  add(phase: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.bump(phase, ms);
  }

  private bump(phase: string, ms: number): void {
    if (!(phase in this.acc)) this.order.push(phase);
    this.acc[phase] = (this.acc[phase] || 0) + ms;
  }

  /** Emit the accumulated timings in first-seen order, rounded to whole ms. */
  timings(): PhaseTiming[] {
    return this.order.map((phase) => ({ phase, ms: Math.round(this.acc[phase]) }));
  }

  /** Total ms across all recorded phases. */
  total(): number {
    return Object.values(this.acc).reduce((s, ms) => s + ms, 0);
  }
}
