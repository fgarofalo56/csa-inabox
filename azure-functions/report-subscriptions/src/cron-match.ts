/**
 * cron-match — pure NCRONTAB window-matching for the report-subscriptions timer
 * Function. No external dependency so it is trivially unit-testable.
 *
 * The Function fires on its OWN fixed cadence (REPORT_SUBSCRIPTIONS_CRON, e.g.
 * every 15 minutes). On each tick it must decide which per-subscription
 * schedules became due since the previous tick. `isDueWithin` answers that by
 * walking the window minute-by-minute and testing each minute against the
 * subscription's 6-field NCRONTAB.
 *
 * Field order (NCRONTAB): {second} {minute} {hour} {day} {month} {day-of-week}.
 * We match at minute granularity (the second field is ignored for delivery —
 * subscriptions fire at most once per matching minute), which is the right
 * grain for scheduled report delivery.
 *
 * Grounded in Microsoft Learn — Timer trigger NCRONTAB expressions:
 *   https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
 */

/** Expand one NCRONTAB field into the concrete set of matching integers. */
export function expandField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const term of field.split(',')) {
    const [rangePart, stepPart] = term.split('/');
    const step = stepPart ? Math.max(1, parseInt(stepPart, 10)) : 1;
    let start = lo;
    let end = hi;
    if (rangePart && rangePart !== '*') {
      const bounds = rangePart.split('-');
      start = parseInt(bounds[0], 10);
      end = bounds[1] !== undefined ? parseInt(bounds[1], 10) : start;
      // A bare "n/step" (no range) means "from n to hi step".
      if (bounds[1] === undefined && stepPart) end = hi;
    }
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    for (let v = start; v <= end; v += step) {
      if (v >= lo && v <= hi) out.add(v);
    }
  }
  return out;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parse a 6-field NCRONTAB into per-field integer sets (seconds ignored). */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 6) return null;
  const [, min, hour, dom, month, dow] = fields;
  return {
    minute: expandField(min, 0, 59),
    hour: expandField(hour, 0, 23),
    dom: expandField(dom, 1, 31),
    month: expandField(month, 1, 12),
    dow: expandField(dow, 0, 6),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** True when the given UTC instant matches the parsed cron at minute grain. */
export function matchesMinuteUtc(p: ParsedCron, d: Date): boolean {
  if (!p.minute.has(d.getUTCMinutes())) return false;
  if (!p.hour.has(d.getUTCHours())) return false;
  if (!p.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = p.dom.has(d.getUTCDate());
  const dowOk = p.dow.has(d.getUTCDay());
  // Vixie-cron semantics: when BOTH day-of-month and day-of-week are
  // restricted, the match is their OR. When only one is restricted, that one
  // must match. When neither is restricted, both are wildcards (match).
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  if (p.domRestricted) return domOk;
  if (p.dowRestricted) return dowOk;
  return true;
}

/**
 * True when the subscription's cron would fire at least once in the half-open
 * window (startMs, endMs] — i.e. since the previous timer tick up to and
 * including now. Iterates minute-by-minute; the window is the Function's own
 * cadence (minutes to an hour), so the loop is bounded and cheap. A safety cap
 * prevents a pathological window from looping unbounded.
 */
export function isDueWithin(expr: string, startMs: number, endMs: number): boolean {
  const p = parseCron(expr);
  if (!p) return false;
  if (endMs <= startMs) return false;
  const MINUTE = 60_000;
  const MAX_ITER = 60 * 25; // cap at ~25h of minutes — far beyond any sane tick
  // Start at the first whole minute strictly after startMs.
  let t = Math.floor(startMs / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < MAX_ITER && t <= endMs; i++, t += MINUTE) {
    if (matchesMinuteUtc(p, new Date(t))) return true;
  }
  return false;
}
