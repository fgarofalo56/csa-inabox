import { badRequest } from '../http/errors.js';
import { assertSlug } from '../registry/registry.js';
import type { StampDoc } from '../registry/types.js';
import { notFound } from '../http/errors.js';
import type { Collection } from '../store/types.js';
import { SloSampleSchema, type SloReport, type SloSampleDoc, type SloState, type StampSlo } from './types.js';

/** Share of the error budget consumed at which a stamp becomes at-risk. */
export const BUDGET_AT_RISK = 0.8;
export const CAPACITY_AT_RISK_PERCENT = 85;
export const STALE_AFTER_MS = 15 * 60 * 1000;

const SEVERITY: Record<SloState, number> = { 'no-data': 0, ok: 1, 'at-risk': 2, breached: 3 };

export function evaluateStamp(
  stamp: StampDoc,
  sample: SloSampleDoc | undefined,
  target: number,
  now: Date,
): StampSlo {
  if (!sample || sample.totalRequests === 0) {
    return {
      stampId: stamp.id,
      stampStatus: stamp.status,
      state: 'no-data',
      stale: !sample || now.getTime() - Date.parse(sample.reportedAt) > STALE_AFTER_MS,
      availability: null,
      errorBudgetRemaining: null,
      p95LatencyMs: sample?.p95LatencyMs ?? null,
      capacityUsedPercent: sample?.capacityUsedPercent ?? null,
      reportedAt: sample?.reportedAt ?? null,
    };
  }
  const availability = sample.goodRequests / sample.totalRequests;
  const bad = sample.totalRequests - sample.goodRequests;
  // Rounded so float noise (1e6 * (1 - 0.999) = 1000.0000000000009) cannot shift a threshold.
  const allowedBad = Math.round(sample.totalRequests * (1 - target) * 1e6) / 1e6;
  const consumed = allowedBad === 0 ? (bad > 0 ? Infinity : 0) : bad / allowedBad;
  let state: SloState = 'ok';
  if (availability < target) state = 'breached';
  else if (consumed >= BUDGET_AT_RISK || sample.capacityUsedPercent >= CAPACITY_AT_RISK_PERCENT) state = 'at-risk';
  return {
    stampId: stamp.id,
    stampStatus: stamp.status,
    state,
    stale: now.getTime() - Date.parse(sample.reportedAt) > STALE_AFTER_MS,
    availability,
    errorBudgetRemaining: Math.max(0, 1 - consumed),
    p95LatencyMs: sample.p95LatencyMs,
    capacityUsedPercent: sample.capacityUsedPercent,
    reportedAt: sample.reportedAt,
  };
}

export class SloService {
  constructor(
    private readonly stamps: Collection<StampDoc>,
    private readonly samples: Collection<SloSampleDoc>,
    private readonly target: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async report(): Promise<SloReport> {
    const [stamps, samples] = await Promise.all([this.stamps.list(500), this.samples.list(500)]);
    const byStamp = new Map(samples.map((s) => [s.id, s]));
    const rows = stamps.map((s) => evaluateStamp(s, byStamp.get(s.id), this.target, this.now()));
    const byState: Record<SloState, number> = { ok: 0, 'at-risk': 0, breached: 0, 'no-data': 0 };
    let total = 0;
    let good = 0;
    let fleetState: SloState = 'no-data';
    for (const r of rows) {
      byState[r.state]++;
      if (SEVERITY[r.state] > SEVERITY[fleetState]) fleetState = r.state;
      const sample = byStamp.get(r.stampId);
      if (sample && sample.totalRequests > 0) {
        total += sample.totalRequests;
        good += sample.goodRequests;
      }
    }
    return {
      generatedAt: this.now().toISOString(),
      availabilityTarget: this.target,
      fleet: { state: fleetState, availability: total > 0 ? good / total : null, stamps: rows.length, byState },
      stamps: rows,
    };
  }

  async record(stampId: string, body: unknown, actor: string): Promise<SloSampleDoc> {
    assertSlug(stampId, 'stamp');
    const parsed = SloSampleSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw badRequest(`${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`);
    }
    if (!(await this.stamps.get(stampId))) throw notFound('stamp');
    return this.samples.upsert({
      ...parsed.data,
      id: stampId,
      reportedAt: this.now().toISOString(),
      reportedBy: actor,
    });
  }
}
