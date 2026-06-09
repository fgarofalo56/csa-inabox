/**
 * NCRONTAB helpers — the 6-field schedule format Azure Functions timer
 * triggers use (`{second} {minute} {hour} {day} {month} {day-of-week}`).
 *
 * Used by the report-subscription BFF to validate operator-supplied schedules
 * and to present friendly preset labels. The fiab-report-subscriptions timer
 * Function mirrors the matching logic in apps/fiab-report-subscriptions/src/
 * cron-match.ts so the UI's "next run" preview agrees with what the Function
 * actually fires.
 *
 * Grounded in Microsoft Learn — Timer trigger NCRONTAB expressions:
 *   https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer
 *
 * No external dependency; pure string logic so it is trivially unit-testable.
 */

/** Friendly schedule presets surfaced as a dropdown (no freeform cron required). */
export interface SchedulePreset {
  /** Stable id used as the Dropdown option value. */
  id: string;
  /** Human label shown in the UI. */
  label: string;
  /** The 6-field NCRONTAB the preset compiles to. */
  cron: string;
}

/**
 * Curated presets covering the Power BI "Subscribe to report" cadence options
 * (daily / weekly / weekday / monthly / hourly) plus an explicit "Custom"
 * sentinel the UI swaps for a validated free-text field.
 */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: 'daily-8am', label: 'Every day at 8:00 AM (UTC)', cron: '0 0 8 * * *' },
  { id: 'weekdays-8am', label: 'Weekdays at 8:00 AM (UTC)', cron: '0 0 8 * * 1-5' },
  { id: 'weekly-mon-8am', label: 'Every Monday at 8:00 AM (UTC)', cron: '0 0 8 * * 1' },
  { id: 'monthly-1st-8am', label: 'First of the month at 8:00 AM (UTC)', cron: '0 0 8 1 * *' },
  { id: 'hourly', label: 'Every hour (top of the hour)', cron: '0 0 * * * *' },
  { id: 'every-15m', label: 'Every 15 minutes', cron: '0 */15 * * * *' },
];

/** Map a preset id to its cron, or undefined for unknown/custom. */
export function cronForPreset(id: string): string | undefined {
  return SCHEDULE_PRESETS.find((p) => p.id === id)?.cron;
}

/** Find the preset whose cron equals the given expression (for round-tripping). */
export function presetForCron(cron: string): SchedulePreset | undefined {
  const norm = cron.trim().replace(/\s+/g, ' ');
  return SCHEDULE_PRESETS.find((p) => p.cron === norm);
}

const FIELD_RE = /^[0-9*/,\-]+$/;
const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // second
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

/**
 * Validate a 6-field NCRONTAB expression. Returns null when valid, or a
 * human-readable error string. Accepts wildcards, step values, ranges, and
 * comma lists; numeric tokens are bounds-checked per field. This is a
 * structural validator (the real authority is the Functions runtime), strict
 * enough to reject the common typos (5-field crontab, out-of-range values).
 */
export function validateNcrontab(expr: string): string | null {
  if (typeof expr !== 'string' || !expr.trim()) return 'Schedule is required.';
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 6) {
    return `NCRONTAB needs 6 fields (sec min hour day month day-of-week); got ${fields.length}. Example: "0 0 8 * * 1-5".`;
  }
  const names = ['second', 'minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
  for (let i = 0; i < 6; i++) {
    const f = fields[i];
    if (!FIELD_RE.test(f)) return `Invalid characters in ${names[i]} field "${f}".`;
    const [lo, hi] = FIELD_BOUNDS[i];
    // Validate each comma-separated term's numeric components are in range.
    for (const term of f.split(',')) {
      const stepSplit = term.split('/');
      if (stepSplit.length > 2) return `Invalid step in ${names[i]} field "${term}".`;
      const base = stepSplit[0];
      if (stepSplit[1] !== undefined && !/^[0-9]+$/.test(stepSplit[1])) {
        return `Invalid step value in ${names[i]} field "${term}".`;
      }
      if (base === '*' || base === '') continue;
      for (const n of base.split('-')) {
        if (n === '') continue;
        if (!/^[0-9]+$/.test(n)) return `Invalid number in ${names[i]} field "${term}".`;
        const v = Number(n);
        if (v < lo || v > hi) return `${names[i]} value ${v} out of range (${lo}-${hi}).`;
      }
    }
  }
  return null;
}
