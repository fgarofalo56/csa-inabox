/**
 * cron.ts — PURE cron helpers for the CSA Loom unified job scheduler (rel-T81).
 *
 * The Loom scheduler stores each schedule as a standard 5-field cron string
 * (minute hour day-of-month month day-of-week). Users NEVER type a raw cron
 * string — the CronWizard builds it from structured dropdowns/pickers (per the
 * loom_no_freeform_config rule). These helpers are the shared, unit-testable
 * core used by BOTH the wizard (build + describe + preview) and the server-side
 * tick evaluator (isDue / nextFireTimes):
 *
 *   • buildCron(parts)         — assemble a cron string from wizard selections
 *   • describeCron(cron)       — human-readable summary ("Every day at 02:30")
 *   • nextFireTimes(cron, ...) — the next N fire timestamps (tz-aware via Intl)
 *   • isDue(cron, from, to, …) — did this cron fire in the (from, to] window
 *
 * No I/O, no Azure SDK, no React — importable from server routes and the client
 * wizard alike. Timezone is honored by formatting each candidate minute in the
 * schedule's IANA/Windows time-zone via Intl.DateTimeFormat and matching the
 * cron fields against the LOCAL wall-clock components.
 */

export type CronFrequency = 'minute' | 'hour' | 'day' | 'week' | 'month';

/** Structured wizard selection that assembles into a 5-field cron. */
export interface CronParts {
  frequency: CronFrequency;
  /** Every N units (minute/hour/week/month). Default 1. */
  interval?: number;
  /** Minute of the hour (0-59) — used by hour/day/week/month. */
  minute?: number;
  /** Hour of the day (0-23) — used by day/week/month. */
  hour?: number;
  /** Days of week (0=Sun … 6=Sat) — used by week. */
  daysOfWeek?: number[];
  /** Day of the month (1-31) — used by month. */
  dayOfMonth?: number;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * A curated time-zone list mirroring the Azure ML "Create schedule" dialog.
 * Windows ids are mapped to their IANA equivalent for Intl formatting.
 */
export const SCHEDULER_TIMEZONES: { id: string; label: string; iana: string }[] = [
  { id: 'UTC', label: 'UTC', iana: 'UTC' },
  { id: 'Eastern Standard Time', label: 'Eastern (US)', iana: 'America/New_York' },
  { id: 'Central Standard Time', label: 'Central (US)', iana: 'America/Chicago' },
  { id: 'Mountain Standard Time', label: 'Mountain (US)', iana: 'America/Denver' },
  { id: 'Pacific Standard Time', label: 'Pacific (US)', iana: 'America/Los_Angeles' },
  { id: 'GMT Standard Time', label: 'London', iana: 'Europe/London' },
  { id: 'Central European Standard Time', label: 'Central Europe', iana: 'Europe/Paris' },
  { id: 'India Standard Time', label: 'India', iana: 'Asia/Kolkata' },
  { id: 'Tokyo Standard Time', label: 'Tokyo', iana: 'Asia/Tokyo' },
  { id: 'AUS Eastern Standard Time', label: 'Sydney', iana: 'Australia/Sydney' },
];

/** Resolve a stored tz id (Windows or IANA) to an IANA zone Intl understands. */
export function ianaFor(tzId: string | undefined): string {
  if (!tzId) return 'UTC';
  const hit = SCHEDULER_TIMEZONES.find((t) => t.id === tzId || t.iana === tzId);
  return hit ? hit.iana : tzId; // assume caller passed a valid IANA zone otherwise
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Assemble a standard 5-field cron string from structured wizard parts. This
 * is the ONLY way the UI produces a cron string — there is no raw-cron input.
 */
export function buildCron(parts: CronParts): string {
  const interval = clampInt(parts.interval ?? 1, 1, 1000, 1);
  const minute = clampInt(parts.minute ?? 0, 0, 59, 0);
  const hour = clampInt(parts.hour ?? 0, 0, 23, 0);
  switch (parts.frequency) {
    case 'minute':
      return `*/${interval} * * * *`;
    case 'hour':
      // At :MM, every N hours.
      return `${minute} ${interval > 1 ? `*/${interval}` : '*'} * * *`;
    case 'day':
      return `${minute} ${hour} */${interval} * *`.replace('*/1', '*');
    case 'week': {
      const dows = (parts.daysOfWeek && parts.daysOfWeek.length
        ? [...new Set(parts.daysOfWeek)].sort((a, b) => a - b)
        : [1]) // default Monday
        .map((d) => clampInt(d, 0, 6, 1));
      return `${minute} ${hour} * * ${dows.join(',')}`;
    }
    case 'month': {
      const dom = clampInt(parts.dayOfMonth ?? 1, 1, 31, 1);
      return `${minute} ${hour} ${dom} ${interval > 1 ? `*/${interval}` : '*'} *`;
    }
    default:
      return `${minute} ${hour} * * *`;
  }
}

interface CronField {
  values: Set<number> | null; // null == wildcard (*)
  step?: number;
  base?: number;
}

function parseField(raw: string, lo: number, hi: number): CronField {
  raw = raw.trim();
  if (raw === '*') return { values: null };
  // step form: */N or A-B/N or A/N
  const stepMatch = raw.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
  if (stepMatch) {
    const step = Math.max(1, parseInt(stepMatch[2], 10));
    let start = lo;
    let end = hi;
    if (stepMatch[1] !== '*') {
      const range = stepMatch[1].split('-');
      start = clampInt(range[0], lo, hi, lo);
      end = range[1] !== undefined ? clampInt(range[1], lo, hi, hi) : hi;
    }
    const set = new Set<number>();
    for (let v = start; v <= end; v += step) set.add(v);
    return { values: set, step, base: start };
  }
  // comma list of values / ranges
  const set = new Set<number>();
  for (const part of raw.split(',')) {
    const range = part.split('-');
    if (range.length === 2) {
      const a = clampInt(range[0], lo, hi, lo);
      const b = clampInt(range[1], lo, hi, hi);
      for (let v = a; v <= b; v++) set.add(v);
    } else {
      const n = Math.floor(Number(part));
      if (Number.isFinite(n) && n >= lo && n <= hi) set.add(n);
    }
  }
  return { values: set.size ? set : null };
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
  raw: string;
}

/** Parse a 5-field cron. Returns null when the string is malformed. */
export function parseCron(cron: string): ParsedCron | null {
  const f = (cron || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12),
    dow: parseField(f[4], 0, 6),
    raw: cron.trim(),
  };
}

function match(field: CronField, v: number): boolean {
  return field.values === null || field.values.has(v);
}

/** Wall-clock components of a Date in a specific IANA time zone. */
function partsInZone(d: Date, iana: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: iana,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return {
    minute: parseInt(map.minute, 10),
    hour,
    dom: parseInt(map.day, 10),
    month: parseInt(map.month, 10),
    dow: wd < 0 ? 0 : wd,
  };
}

/**
 * Does `cron` fire at the given minute (evaluated in `iana` zone)? Standard cron
 * day semantics: when BOTH day-of-month and day-of-week are restricted, a match
 * on EITHER fires; otherwise both must match.
 */
function firesAt(parsed: ParsedCron, when: Date, iana: string): boolean {
  const p = partsInZone(when, iana);
  if (!match(parsed.minute, p.minute)) return false;
  if (!match(parsed.hour, p.hour)) return false;
  if (!match(parsed.month, p.month)) return false;
  const domRestricted = parsed.dom.values !== null;
  const dowRestricted = parsed.dow.values !== null;
  if (domRestricted && dowRestricted) {
    return match(parsed.dom, p.dom) || match(parsed.dow, p.dow);
  }
  return match(parsed.dom, p.dom) && match(parsed.dow, p.dow);
}

/**
 * The next `count` fire times at/after `from` (exclusive of `from`'s minute),
 * evaluated in the schedule's time zone. Iteration is capped so a sparse cron
 * (e.g. monthly) can't spin forever; whatever was found within the cap is
 * returned.
 */
export function nextFireTimes(
  cron: string,
  from: Date = new Date(),
  count = 5,
  tzId = 'UTC',
  capMinutes = 150000, // ~104 days — enough to preview minute…monthly
): Date[] {
  const parsed = parseCron(cron);
  if (!parsed) return [];
  const iana = ianaFor(tzId);
  const out: Date[] = [];
  // start at the next whole minute after `from`
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < capMinutes && out.length < count; i++) {
    const when = new Date(start.getTime() + i * 60000);
    if (firesAt(parsed, when, iana)) out.push(when);
  }
  return out;
}

/** Did `cron` fire in the half-open window (after, upto], in the tz? */
export function firedInWindow(cron: string, after: Date, upto: Date, tzId = 'UTC'): boolean {
  const parsed = parseCron(cron);
  if (!parsed) return false;
  const iana = ianaFor(tzId);
  const startMin = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  const endMin = Math.floor(upto.getTime() / 60000) * 60000;
  for (let t = startMin; t <= endMin; t += 60000) {
    if (firesAt(parsed, new Date(t), iana)) return true;
  }
  return false;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function listOfDom(field: CronField): string {
  if (field.values === null) return 'every day';
  const days = [...field.values].sort((a, b) => a - b);
  return `day ${days.join(', ')}`;
}

/** Human-readable summary of a cron string (best-effort, wizard-shaped forms). */
export function describeCron(cron: string, tzId = 'UTC'): string {
  const parsed = parseCron(cron);
  if (!parsed) return 'Custom schedule';
  const tzLabel = SCHEDULER_TIMEZONES.find((t) => t.id === tzId || t.iana === tzId)?.label || tzId;
  const { minute, hour, dom, month, dow } = parsed;

  // Every N minutes
  if (minute.step && hour.values === null && dom.values === null && dow.values === null) {
    return minute.step === 1 ? 'Every minute' : `Every ${minute.step} minutes`;
  }
  const atMin = minute.values && minute.values.size === 1 ? [...minute.values][0] : null;
  const atHour = hour.values && hour.values.size === 1 ? [...hour.values][0] : null;

  // Hourly (minute pinned, hour wildcard or stepped)
  if (atMin !== null && (hour.values === null || hour.step) && dom.values === null && dow.values === null) {
    const every = hour.step && hour.step > 1 ? `every ${hour.step} hours` : 'every hour';
    return `At :${pad(atMin)} ${every}`;
  }

  const time = atHour !== null && atMin !== null ? `${pad(atHour)}:${pad(atMin)}` : null;

  // Weekly
  if (dow.values !== null && dow.values.size > 0 && dom.values === null) {
    const days = [...dow.values].sort((a, b) => a - b).map((d) => WEEKDAY_LONG[d]).join(', ');
    return `Every ${days}${time ? ` at ${time}` : ''} (${tzLabel})`;
  }

  // Monthly
  if (dom.values !== null && (month.values === null || month.step)) {
    const every = month.step && month.step > 1 ? ` every ${month.step} months` : '';
    return `On ${listOfDom(dom)}${every}${time ? ` at ${time}` : ''} (${tzLabel})`;
  }

  // Daily
  if (time) return `Every day at ${time} (${tzLabel})`;

  return `Cron: ${parsed.raw}`;
}
