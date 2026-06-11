/**
 * CSA Loom — Insider Risk Management (IRM) for Lakehouse indicator engine.
 *
 * Computes insider-risk indicators (Fabric Build 2026 #35) over the data
 * sources Loom already collects — there is NO dependency on Microsoft Fabric,
 * Purview IRM, or a OneLake workspace. The Azure-native default works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset:
 *
 *   1. Cosmos `audit-log` container (always available) — Loom-native actor /
 *      action / target events. PRIMARY source; drives unusual-volume and
 *      off-hours indicators.
 *   2. Azure Monitor / Log Analytics (optional, honest-gated):
 *        • queryLoomAppEvents  — app-side read/access events (AppTraces).
 *        • queryActivityFeed   — lakehouse pipeline-load volume by submitter.
 *        • listActivityLog     — ARM control-plane privileged operations.
 *      A missing LOOM_LOG_ANALYTICS_WORKSPACE_ID degrades each Monitor signal
 *      to a `gates.la` MessageBar (never fatal) — the Cosmos-derived
 *      indicators still render.
 *
 * Indicator semantics mirror Microsoft Purview Insider Risk Management:
 *   • unusual-volume   ≈ cumulative exfiltration detection (a user's
 *                        exfiltration-class activity over the window exceeds
 *                        the peer/org norm — mean + zσ).
 *   • off-hours-access ≈ "activity above usual for that day" risk booster
 *                        (events outside business hours / on weekends).
 *   • privileged-access≈ unusual privileged control-plane activity.
 *
 * Per .claude/rules/loom-no-freeform-config.md indicators are a TYPED catalog
 * (IRM_INDICATORS, like KQL_LIBRARY); thresholds come from a STRUCTURED
 * tenant-settings doc (`irm:<tenantId>`), never a freeform query box.
 *
 * Auth/RBAC: the Monitor reads reuse the same UAMI as monitor-client
 * (Monitoring Reader + Log Analytics Reader). The Cosmos path needs no extra
 * role — it is the same container the audit-log surface already reads.
 */

import {
  auditLogContainer,
  tenantSettingsContainer,
} from './cosmos-client';
import {
  queryLoomAppEvents,
  queryActivityFeed,
  listActivityLog,
  MonitorNotConfiguredError,
} from './monitor-client';

// ----------------------------------------------------------------------------
// Typed indicator catalog (no freeform config — operator toggles these)
// ----------------------------------------------------------------------------

export type IrmIndicatorCategory =
  | 'Exfiltration'
  | 'Unusual activity'
  | 'Privileged access';

export type IrmSignalSource = 'cosmos' | 'loganalytics' | 'arm';
export type IrmSeverity = 'low' | 'medium' | 'high';

export interface IrmIndicatorDef {
  id: string;
  label: string;
  category: IrmIndicatorCategory;
  description: string;
  /** Which backing signal feeds this indicator. */
  source: IrmSignalSource;
  /** Purview IRM disables all indicators by default; operator opts in. */
  enabledByDefault: boolean;
}

export const IRM_INDICATORS: IrmIndicatorDef[] = [
  {
    id: 'unusual-volume',
    label: 'Unusual data volume (cumulative exfiltration)',
    category: 'Exfiltration',
    source: 'cosmos',
    enabledByDefault: true,
    description:
      'A user’s exfiltration-class activity (download, export, share, read, publish) over the window exceeds the peer norm (mean + zσ). Mirrors Purview IRM cumulative-exfiltration detection.',
  },
  {
    id: 'off-hours-access',
    label: 'Off-hours / weekend access',
    category: 'Unusual activity',
    source: 'cosmos',
    enabledByDefault: true,
    description:
      'Access to lakehouse items outside configured business hours or on weekends. Mirrors the Purview IRM "activity above the user’s usual activity for that day" risk booster.',
  },
  {
    id: 'high-pipeline-volume',
    label: 'High lakehouse-load volume',
    category: 'Exfiltration',
    source: 'loganalytics',
    enabledByDefault: false,
    description:
      'A submitter triggers an unusually high number of pipeline / ingest runs over the window (Azure Monitor ADFPipelineRun / Synapse pipeline runs).',
  },
  {
    id: 'privileged-access',
    label: 'Unusual privileged access',
    category: 'Privileged access',
    source: 'arm',
    enabledByDefault: false,
    description:
      'A caller performs an unusual number of privileged control-plane operations (write / delete / role assignment) on Loom resources (ARM Activity Log).',
  },
];

// ----------------------------------------------------------------------------
// Structured thresholds (tenant-settings doc `irm:<tenantId>`)
// ----------------------------------------------------------------------------

export interface IrmThresholds {
  /** z-score cutoff for cumulative-volume peer-norm. */
  volumeZ: number;
  /** Floor of exfil-class events before a volume finding fires (noise guard). */
  minVolumeEvents: number;
  /** Min off-hours events before an off-hours finding fires. */
  minOffHoursEvents: number;
  /** Min privileged operations before a privileged finding fires. */
  privilegedMinEvents: number;
  /** Min pipeline runs by one submitter before a pipeline finding fires. */
  pipelineMinRuns: number;
  /** Local business-hours window (24h clock). */
  businessStart: number;
  businessEnd: number;
  /** Flag weekend access as off-hours. */
  flagWeekends: boolean;
  /** IANA timezone used to localize the access hour. */
  timezone: string;
  /** Per-indicator enable map (operator toggle); defaults from the catalog. */
  enabled: Record<string, boolean>;
}

export const DEFAULT_THRESHOLDS: IrmThresholds = {
  volumeZ: 2,
  minVolumeEvents: 20,
  minOffHoursEvents: 5,
  privilegedMinEvents: 5,
  pipelineMinRuns: 25,
  businessStart: 7,
  businessEnd: 19,
  flagWeekends: true,
  timezone: 'UTC',
  enabled: Object.fromEntries(IRM_INDICATORS.map((i) => [i.id, i.enabledByDefault])),
};

export function mergeThresholds(partial?: Partial<IrmThresholds> | null): IrmThresholds {
  if (!partial) return { ...DEFAULT_THRESHOLDS, enabled: { ...DEFAULT_THRESHOLDS.enabled } };
  return {
    ...DEFAULT_THRESHOLDS,
    ...partial,
    enabled: { ...DEFAULT_THRESHOLDS.enabled, ...(partial.enabled || {}) },
  };
}

// ----------------------------------------------------------------------------
// Normalized event + finding shapes
// ----------------------------------------------------------------------------

export interface NormalizedAuditEvent {
  actor: string;
  verb: string;
  at: string; // ISO 8601
  itemId?: string;
  itemType?: string;
  source: IrmSignalSource;
}

export interface IrmFinding {
  actor: string;
  indicatorId: string;
  indicator: string;
  category: IrmIndicatorCategory;
  severity: IrmSeverity;
  count: number;
  baseline: number;
  lastSeen: string;
  detail: string;
  source: IrmSignalSource;
}

export interface IrmTopActor {
  actor: string;
  riskScore: number;
  indicators: number;
  highestSeverity: IrmSeverity;
  exfilEvents: number;
  offHoursEvents: number;
  lastSeen: string;
}

export interface IrmReport {
  kpis: {
    usersAtRisk: number;
    unusualVolumeAlerts: number;
    offHoursEvents: number;
    privilegedAccessEvents: number;
    indicatorsActive: number;
    auditEventsAnalyzed: number;
  };
  findings: IrmFinding[];
  topActors: IrmTopActor[];
  thresholds: IrmThresholds;
  windowDays: number;
  gates: { la?: string };
}

// ----------------------------------------------------------------------------
// Pure analyzers (unit-tested without IO)
// ----------------------------------------------------------------------------

/** Exfiltration-class verbs (substring match, case-insensitive). */
const EXFIL_VERBS = ['share', 'download', 'export', 'read', 'publish', 'copy', 'embed', 'print'];

export function isExfilVerb(verb: string): boolean {
  const v = (verb || '').toLowerCase();
  return EXFIL_VERBS.some((k) => v.includes(k));
}

const SEVERITY_RANK: Record<IrmSeverity, number> = { low: 1, medium: 2, high: 3 };

function label(id: string): { indicator: string; category: IrmIndicatorCategory } {
  const def = IRM_INDICATORS.find((i) => i.id === id);
  return { indicator: def?.label ?? id, category: def?.category ?? 'Unusual activity' };
}

/**
 * Localize an ISO timestamp to { hour (0-23), weekday (0=Sun..6=Sat) } in the
 * given IANA timezone. Falls back to UTC for an invalid tz.
 */
export function localParts(iso: string, tz: string): { hour: number; weekday: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    const parts = fmt.formatToParts(d);
    const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const wdStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    return { hour: parseInt(hourStr, 10) % 24, weekday: WD[wdStr] ?? 0 };
  } catch {
    return { hour: d.getUTCHours(), weekday: d.getUTCDay() };
  }
}

/**
 * Cumulative-exfiltration peer-norm: per-actor total of exfil-class events;
 * flag actors whose total exceeds mean + (volumeZ * σ) and clears the floor.
 */
export function analyzeVolume(events: NormalizedAuditEvent[], t: IrmThresholds): IrmFinding[] {
  const per = new Map<string, { count: number; last: string }>();
  for (const e of events) {
    if (!isExfilVerb(e.verb)) continue;
    const cur = per.get(e.actor) ?? { count: 0, last: '' };
    cur.count++;
    if (e.at > cur.last) cur.last = e.at;
    per.set(e.actor, cur);
  }
  const counts = [...per.values()].map((v) => v.count);
  const n = counts.length;
  const mean = n ? counts.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? counts.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const stddev = Math.sqrt(variance);
  const threshold = mean + t.volumeZ * stddev;
  const { indicator, category } = label('unusual-volume');
  const out: IrmFinding[] = [];
  for (const [actor, v] of per) {
    if (v.count < t.minVolumeEvents) continue;
    if (v.count <= threshold) continue;
    const z = stddev > 0 ? (v.count - mean) / stddev : 0;
    const severity: IrmSeverity = z >= 3 ? 'high' : z >= 2 ? 'medium' : 'low';
    out.push({
      actor,
      indicatorId: 'unusual-volume',
      indicator,
      category,
      severity,
      count: v.count,
      baseline: Math.round(mean),
      lastSeen: v.last,
      detail: `${v.count} exfiltration-class actions vs peer mean ${mean.toFixed(1)} (z=${z.toFixed(1)})`,
      source: 'cosmos',
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Off-hours / weekend access per actor. */
export function analyzeOffHours(events: NormalizedAuditEvent[], t: IrmThresholds): IrmFinding[] {
  const per = new Map<string, { count: number; last: string }>();
  for (const e of events) {
    const p = localParts(e.at, t.timezone);
    if (!p) continue;
    const weekend = p.weekday === 0 || p.weekday === 6;
    const offHour = p.hour < t.businessStart || p.hour >= t.businessEnd;
    if (!offHour && !(t.flagWeekends && weekend)) continue;
    const cur = per.get(e.actor) ?? { count: 0, last: '' };
    cur.count++;
    if (e.at > cur.last) cur.last = e.at;
    per.set(e.actor, cur);
  }
  const { indicator, category } = label('off-hours-access');
  const out: IrmFinding[] = [];
  for (const [actor, v] of per) {
    if (v.count < t.minOffHoursEvents) continue;
    const severity: IrmSeverity = v.count >= 50 ? 'high' : v.count >= 10 ? 'medium' : 'low';
    out.push({
      actor,
      indicatorId: 'off-hours-access',
      indicator,
      category,
      severity,
      count: v.count,
      baseline: 0,
      lastSeen: v.last,
      detail: `${v.count} actions outside ${t.businessStart}:00–${t.businessEnd}:00 ${t.timezone}${t.flagWeekends ? ' (incl. weekends)' : ''}`,
      source: 'cosmos',
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** High pipeline-load volume by submitter (Azure Monitor run history). */
export function analyzePipelineVolume(
  feed: Array<{ submitter?: string; timeGenerated: string }>,
  t: IrmThresholds,
): IrmFinding[] {
  const per = new Map<string, { count: number; last: string }>();
  for (const r of feed) {
    const actor = (r.submitter || '').trim();
    // Skip non-user / scheduled triggers — IRM is about human actors.
    if (!actor || /^(manual|scheduled|tumbling|trigger)/i.test(actor)) continue;
    const cur = per.get(actor) ?? { count: 0, last: '' };
    cur.count++;
    if (r.timeGenerated > cur.last) cur.last = r.timeGenerated;
    per.set(actor, cur);
  }
  const { indicator, category } = label('high-pipeline-volume');
  const out: IrmFinding[] = [];
  for (const [actor, v] of per) {
    if (v.count < t.pipelineMinRuns) continue;
    const severity: IrmSeverity = v.count >= t.pipelineMinRuns * 3 ? 'high' : v.count >= t.pipelineMinRuns * 2 ? 'medium' : 'low';
    out.push({
      actor,
      indicatorId: 'high-pipeline-volume',
      indicator,
      category,
      severity,
      count: v.count,
      baseline: t.pipelineMinRuns,
      lastSeen: v.last,
      detail: `${v.count} pipeline / ingest runs over the window`,
      source: 'loganalytics',
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Unusual privileged control-plane access per caller (ARM Activity Log). */
export function analyzePrivileged(
  armEvents: Array<{ caller?: string; operationName?: string; eventTimestamp: string }>,
  t: IrmThresholds,
): IrmFinding[] {
  const per = new Map<string, { count: number; last: string }>();
  for (const e of armEvents) {
    const op = (e.operationName || '').toLowerCase();
    const privileged = op.includes('write') || op.includes('delete') || op.includes('action') || op.includes('role');
    if (!privileged) continue;
    const actor = (e.caller || '').trim();
    if (!actor) continue;
    const cur = per.get(actor) ?? { count: 0, last: '' };
    cur.count++;
    if (e.eventTimestamp > cur.last) cur.last = e.eventTimestamp;
    per.set(actor, cur);
  }
  const { indicator, category } = label('privileged-access');
  const out: IrmFinding[] = [];
  for (const [actor, v] of per) {
    if (v.count < t.privilegedMinEvents) continue;
    const severity: IrmSeverity = v.count >= t.privilegedMinEvents * 4 ? 'high' : v.count >= t.privilegedMinEvents * 2 ? 'medium' : 'low';
    out.push({
      actor,
      indicatorId: 'privileged-access',
      indicator,
      category,
      severity,
      count: v.count,
      baseline: t.privilegedMinEvents,
      lastSeen: v.last,
      detail: `${v.count} privileged control-plane operations (write / delete / role)`,
      source: 'arm',
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Roll findings up into a per-actor risk leaderboard. */
export function rollupTopActors(
  findings: IrmFinding[],
  events: NormalizedAuditEvent[],
  t: IrmThresholds,
): IrmTopActor[] {
  const SEV_WEIGHT: Record<IrmSeverity, number> = { low: 10, medium: 30, high: 70 };
  const per = new Map<string, IrmTopActor>();
  for (const f of findings) {
    const cur = per.get(f.actor) ?? {
      actor: f.actor, riskScore: 0, indicators: 0,
      highestSeverity: 'low' as IrmSeverity, exfilEvents: 0, offHoursEvents: 0, lastSeen: '',
    };
    cur.indicators++;
    cur.riskScore += SEV_WEIGHT[f.severity];
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.highestSeverity]) cur.highestSeverity = f.severity;
    if (f.lastSeen > cur.lastSeen) cur.lastSeen = f.lastSeen;
    per.set(f.actor, cur);
  }
  // Fold in raw counts for context columns.
  for (const e of events) {
    const cur = per.get(e.actor);
    if (!cur) continue;
    if (isExfilVerb(e.verb)) cur.exfilEvents++;
    const p = localParts(e.at, t.timezone);
    if (p) {
      const weekend = p.weekday === 0 || p.weekday === 6;
      if (p.hour < t.businessStart || p.hour >= t.businessEnd || (t.flagWeekends && weekend)) cur.offHoursEvents++;
    }
  }
  return [...per.values()].sort((a, b) => b.riskScore - a.riskScore);
}

// ----------------------------------------------------------------------------
// Normalization of raw audit rows (handles both written shapes)
// ----------------------------------------------------------------------------

/**
 * Normalize a Cosmos audit-log row. Two writer shapes exist in the wild:
 *   • { who, at, kind, itemId, ... }              (admin/governance writers)
 *   • { upn, at, action, itemId, itemType, ... }  (activity-feed writer)
 */
export function normalizeAuditRow(r: any): NormalizedAuditEvent | null {
  const actor = (r?.who ?? r?.upn ?? r?.user ?? '').toString().trim();
  const verb = (r?.kind ?? r?.action ?? '').toString().trim();
  const at = (r?.at ?? '').toString();
  if (!actor || !at) return null;
  return {
    actor,
    verb,
    at,
    itemId: r?.itemId ? String(r.itemId) : undefined,
    itemType: r?.itemType ? String(r.itemType) : undefined,
    source: 'cosmos',
  };
}

// ----------------------------------------------------------------------------
// Orchestrator (IO) — reads Cosmos + Monitor, runs the analyzers
// ----------------------------------------------------------------------------

export async function readIrmThresholds(tenantId: string): Promise<IrmThresholds> {
  try {
    const ts = await tenantSettingsContainer();
    const { resource } = await ts.item(`irm:${tenantId}`, tenantId).read<any>();
    return mergeThresholds(resource?.thresholds ?? resource ?? null);
  } catch {
    return mergeThresholds(null);
  }
}

export async function writeIrmThresholds(tenantId: string, patch: Partial<IrmThresholds>): Promise<IrmThresholds> {
  const merged = mergeThresholds({ ...(await readIrmThresholds(tenantId)), ...patch });
  const ts = await tenantSettingsContainer();
  await ts.items.upsert({ id: `irm:${tenantId}`, tenantId, thresholds: merged, updatedAt: new Date().toISOString() });
  return merged;
}

export async function computeIrmIndicators(opts: {
  tenantId: string;
  days?: number;
  thresholds?: Partial<IrmThresholds>;
}): Promise<IrmReport> {
  const tenantId = opts.tenantId;
  const windowDays = Math.min(90, Math.max(1, opts.days ?? 30));
  const thresholds = opts.thresholds
    ? mergeThresholds(opts.thresholds)
    : await readIrmThresholds(tenantId);
  const gates: { la?: string } = {};

  // ── 1. Cosmos audit log (primary; tenant-scoped over the window) ───────────
  const since = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const c = await auditLogContainer();
  const { resources: rawRows } = await c.items.query({
    query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.at >= @since ORDER BY c.at DESC',
    parameters: [{ name: '@t', value: tenantId }, { name: '@since', value: since }],
  }).fetchAll();

  const events: NormalizedAuditEvent[] = [];
  for (const r of rawRows as any[]) {
    const n = normalizeAuditRow(r);
    if (n) events.push(n);
  }

  // ── 2. Monitor signals (optional; honest-gate, never fatal) ────────────────
  const startTime = since;
  const endTime = new Date().toISOString();
  const [appEv, feed, armLog] = await Promise.allSettled([
    queryLoomAppEvents({ startTime, endTime, limit: 1000 }),
    queryActivityFeed({ days: windowDays, limit: 500 }),
    listActivityLog({ days: Math.min(90, windowDays) }),
  ]);

  if (appEv.status === 'fulfilled') {
    for (const e of appEv.value) {
      if (!e.who || !e.at) continue;
      events.push({ actor: e.who, verb: e.kind, at: e.at, itemId: e.itemId || undefined, source: 'loganalytics' });
    }
  } else if (appEv.reason instanceof MonitorNotConfiguredError) {
    gates.la = 'Azure Monitor signals unavailable: set LOOM_LOG_ANALYTICS_WORKSPACE_ID in admin-plane/main.bicep apps[] env to fold app-access, pipeline-volume, and privileged-access indicators into the analysis.';
  }

  let pipelineFindings: IrmFinding[] = [];
  if (feed.status === 'fulfilled' && thresholds.enabled['high-pipeline-volume']) {
    pipelineFindings = analyzePipelineVolume(feed.value, thresholds);
  }

  let privilegedFindings: IrmFinding[] = [];
  let privilegedAccessEvents = 0;
  if (armLog.status === 'fulfilled') {
    if (thresholds.enabled['privileged-access']) {
      privilegedFindings = analyzePrivileged(armLog.value, thresholds);
    }
    privilegedAccessEvents = armLog.value.filter((e) => {
      const op = (e.operationName || '').toLowerCase();
      return op.includes('write') || op.includes('delete') || op.includes('action') || op.includes('role');
    }).length;
  }

  // ── 3. Run the Cosmos-backed analyzers (respect operator toggles) ──────────
  const volumeFindings = thresholds.enabled['unusual-volume'] ? analyzeVolume(events, thresholds) : [];
  const offHoursFindings = thresholds.enabled['off-hours-access'] ? analyzeOffHours(events, thresholds) : [];

  const findings: IrmFinding[] = [
    ...volumeFindings,
    ...offHoursFindings,
    ...pipelineFindings,
    ...privilegedFindings,
  ];

  const topActors = rollupTopActors(findings, events, thresholds);
  const usersAtRisk = new Set(findings.map((f) => f.actor)).size;
  const offHoursEvents = offHoursFindings.reduce((a, f) => a + f.count, 0);

  return {
    kpis: {
      usersAtRisk,
      unusualVolumeAlerts: volumeFindings.length,
      offHoursEvents,
      privilegedAccessEvents,
      indicatorsActive: Object.values(thresholds.enabled).filter(Boolean).length,
      auditEventsAnalyzed: events.length,
    },
    findings: findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count),
    topActors,
    thresholds,
    windowDays,
    gates,
  };
}
