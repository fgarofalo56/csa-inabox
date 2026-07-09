/**
 * Marketplace SLA freshness evaluation (W18) — pure logic, unit-tested.
 *
 * A data product's freshness SLA is derived from its declared update frequency
 * (state.updateFrequency, the Purview Unified Catalog cadence) or an explicit
 * state.sla.freshnessHours. The product is BREACHED when the time since its
 * last refresh (state.lastRefreshedAt, falling back to updatedAt) exceeds the
 * allowed window (with a grace multiplier so a slightly-late refresh doesn't
 * page). Deterministic — no Cosmos, no clock except the injectable `now`.
 */

/** Allowed-freshness window (hours) per declared update frequency. */
const FREQUENCY_HOURS: Record<string, number> = {
  'near-real-time': 1,
  hourly: 1,
  daily: 24,
  weekly: 24 * 7,
  monthly: 24 * 30,
  quarterly: 24 * 90,
  annually: 24 * 365,
};

/** Grace multiplier — a refresh up to 1.5× the window is still "within SLA". */
export const FRESHNESS_GRACE = 1.5;

export interface FreshnessResult {
  /** True when the last refresh is older than the allowed (graced) window. */
  breached: boolean;
  /** Hours since the last refresh. */
  ageHours: number | null;
  /** The base allowed window in hours (before grace), or null when no SLA. */
  windowHours: number | null;
  /** The frequency label used to derive the window. */
  frequency: string | null;
  /** ISO of the last refresh used for the calc. */
  lastRefreshedAt: string | null;
}

/** Resolve the freshness window (hours) for a product, or null when undeclared. */
export function freshnessWindowHours(state: Record<string, unknown> | undefined): {
  windowHours: number | null;
  frequency: string | null;
} {
  const s = state ?? {};
  const sla = (s.sla ?? {}) as Record<string, unknown>;
  const explicit = Number(sla.freshnessHours);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { windowHours: explicit, frequency: 'custom' };
  }
  const freq = String(s.updateFrequency ?? '').trim().toLowerCase();
  if (freq && FREQUENCY_HOURS[freq] != null) {
    return { windowHours: FREQUENCY_HOURS[freq], frequency: freq };
  }
  return { windowHours: null, frequency: freq || null };
}

/**
 * Evaluate freshness for a data-product item. `now` is injectable for tests.
 * Returns `breached: false` when no SLA is declared (nothing to breach).
 */
export function computeFreshness(
  item: { state?: Record<string, unknown>; updatedAt?: string },
  now: number = Date.now(),
): FreshnessResult {
  const { windowHours, frequency } = freshnessWindowHours(item.state);
  const lastRefreshedRaw =
    (item.state?.lastRefreshedAt as string | undefined) || item.updatedAt || null;
  const lastMs = lastRefreshedRaw ? Date.parse(lastRefreshedRaw) : NaN;
  const ageHours = Number.isFinite(lastMs) ? (now - lastMs) / 3_600_000 : null;

  if (windowHours == null || ageHours == null) {
    return { breached: false, ageHours, windowHours, frequency, lastRefreshedAt: lastRefreshedRaw };
  }
  const breached = ageHours > windowHours * FRESHNESS_GRACE;
  return { breached, ageHours, windowHours, frequency, lastRefreshedAt: lastRefreshedRaw };
}
