/**
 * Pure scheduling + payload logic for the report-subscriptions timer Function
 * (WS-C2). No Azure SDK imports here so it is fully unit-testable — the timer
 * function (functions/deliver.ts) wires these against Cosmos / the Logic App.
 *
 * Each ReportSubscription carries its OWN 6-field NCRONTAB `cron`
 * (sec min hour day-of-month month day-of-week). The Function fires on a coarse
 * REPORT_SUBSCRIPTIONS_CRON tick; `dueSubscriptions()` selects the subscriptions
 * whose own cron matches the current minute so each delivers close to its time.
 */

export interface ReportSubscriptionLite {
  id: string;
  reportId: string;
  workspaceId: string;
  format: 'PDF' | 'PPTX' | 'PNG';
  cron: string;
  recipients: string[];
  subject?: string;
  enabled: boolean;
  lastRunAt?: string;
}

/** Parse one NCRONTAB field into a predicate over its value range. Supports
 *  `*`, `N`, `A-B`, `A-B/S`, `*​/S`, and comma lists of those. */
export function fieldMatcher(field: string, min: number, max: number): (v: number) => boolean {
  const parts = field.split(',');
  const ranges: Array<{ lo: number; hi: number; step: number }> = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p === '*') { ranges.push({ lo: min, hi: max, step: 1 }); continue; }
    let step = 1;
    let body = p;
    const slash = p.indexOf('/');
    if (slash >= 0) { step = parseInt(p.slice(slash + 1), 10) || 1; body = p.slice(0, slash); }
    if (body === '*') { ranges.push({ lo: min, hi: max, step }); continue; }
    const dash = body.indexOf('-');
    if (dash >= 0) {
      const lo = parseInt(body.slice(0, dash), 10);
      const hi = parseInt(body.slice(dash + 1), 10);
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) ranges.push({ lo, hi, step });
      continue;
    }
    const n = parseInt(body, 10);
    if (!Number.isNaN(n)) ranges.push({ lo: n, hi: n, step: 1 });
  }
  return (v: number) => ranges.some((r) => v >= r.lo && v <= r.hi && (v - r.lo) % r.step === 0);
}

/** True when a 6-field NCRONTAB expression matches the given UTC Date at
 *  minute resolution (seconds field ignored for the coarse tick). */
export function cronMatches(cron: string, now: Date): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 6) return false;
  const [, minute, hour, dom, month, dow] = f;
  const min = f.length === 6 ? { minute, hour, dom, month, dow } : null;
  if (!min) return false;
  const okMinute = fieldMatcher(minute, 0, 59)(now.getUTCMinutes());
  const okHour = fieldMatcher(hour, 0, 23)(now.getUTCHours());
  const okDom = fieldMatcher(dom, 1, 31)(now.getUTCDate());
  const okMonth = fieldMatcher(month, 1, 12)(now.getUTCMonth() + 1);
  // NCRONTAB day-of-week: 0-6 (Sun=0). JS getUTCDay() is also 0-6 Sun=0.
  const okDow = fieldMatcher(dow, 0, 6)(now.getUTCDay());
  // Standard cron semantics: when BOTH dom and dow are restricted, either matching
  // fires; when one is `*`, both must match.
  const domRestricted = dom.trim() !== '*';
  const dowRestricted = dow.trim() !== '*';
  const dayOk = domRestricted && dowRestricted ? (okDom || okDow) : (okDom && okDow);
  return okMinute && okHour && dayOk && okMonth;
}

/** Already delivered within this same minute? (idempotency guard against a
 *  double-tick.) */
export function alreadyRanThisMinute(lastRunAt: string | undefined, now: Date): boolean {
  if (!lastRunAt) return false;
  const last = new Date(lastRunAt);
  if (Number.isNaN(last.getTime())) return false;
  return last.getUTCFullYear() === now.getUTCFullYear()
    && last.getUTCMonth() === now.getUTCMonth()
    && last.getUTCDate() === now.getUTCDate()
    && last.getUTCHours() === now.getUTCHours()
    && last.getUTCMinutes() === now.getUTCMinutes();
}

/** Select enabled subscriptions whose own cron is due at `now` and that have
 *  not already run this minute. */
export function dueSubscriptions<T extends ReportSubscriptionLite>(subs: T[], now: Date): T[] {
  return subs.filter((s) =>
    s.enabled
    && Array.isArray(s.recipients) && s.recipients.length > 0
    && typeof s.cron === 'string'
    && cronMatches(s.cron, now)
    && !alreadyRanThisMinute(s.lastRunAt, now),
  );
}
