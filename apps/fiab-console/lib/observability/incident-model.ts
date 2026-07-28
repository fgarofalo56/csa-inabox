/**
 * N17 — incident + monitor doc shapes + MIG1 versioned-migration registration +
 * the PURE (Azure-free) incident state machine.
 *
 * N17's incident console OWNS the incident experience (triage, timeline,
 * resolution) over the vendor-neutral signals two producers emit:
 *   • N7d data-quality FINDINGS (dq-finding-model.ts) — CONSUMED, not re-derived.
 *   • N17's own per-table MONITORS (freshness / volume / schema-drift), whose
 *     verdicts (incident-monitor-model.ts) open incidents the same way.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` (no cosmos-client,
 * no store) so cosmos-client can import it at module scope to register the
 * migrator chains before any read materializes (the dq-finding-model precedent).
 *
 * CURRENT SCHEMA VERSION: 1 for both containers (every doc stamped at write). A
 * future breaking change bumps the version and registers its `fromVersion: N`
 * migrator per MIG1 (there is deliberately NO inert v1 migrator today).
 *
 * Per-cloud: identical on all clouds (pure metadata in in-boundary Cosmos, no
 * Fabric). IL5 / SOVEREIGN MOAT: monitors + incidents live in in-boundary Cosmos
 * and the state machine + evaluators are pure — the whole detect→open→resolve
 * loop runs DISCONNECTED in an air-gapped enclave; no SaaS incident service.
 */

import { registerMigrator, type DocMigrator } from '@/lib/azure/cosmos-migrations';
import type { MonitorKind, MonitorSeverity } from './incident-monitor-model';

export const MONITOR_CONTAINER = 'loom-monitors';
export const INCIDENT_CONTAINER = 'loom-incidents';
/** FLAG0 kill-switch id for the whole N17 incident-console surface + routes. */
export const N17_FLAG_ID = 'n17-incident-console';
export const MONITOR_SCHEMA_VERSION = 1;
export const INCIDENT_SCHEMA_VERSION = 1;

/** Rolling observation window kept on a monitor doc (bounds the doc < 2 MB). */
export const MAX_MONITOR_OBSERVATIONS = 60;
/** Rolling timeline window kept on an incident doc. */
export const MAX_INCIDENT_TIMELINE = 200;

// ── Monitor doc ──────────────────────────────────────────────────────────────

/** One persisted observation on a monitor's rolling history. */
export interface StoredObservation {
  at: string;
  value: number;
  columns?: string[];
}

/**
 * A per-table monitor config + its rolling observation history. PK is `tenantId`
 * so a tenant's monitors list single-partition; `id` is deterministic per
 * (tenant, kind, itemId, table) so re-registering the same monitor is idempotent.
 */
export interface MonitorDoc {
  id: string;
  tenantId: string;
  docType: 'monitor';
  schemaVersion: number;

  kind: MonitorKind;
  /** DEFAULT-ON (loom_default_on_opt_out): a monitor is enabled unless flipped off. */
  enabled: boolean;

  /** The Loom item (data-quality / lakehouse / warehouse) the monitor watches. */
  itemId: string;
  itemType: string;
  workspaceId?: string;
  /** Table / dataset the monitor grades. */
  table: string;

  /** Tunables (all optional — code defaults in incident-monitor-model). */
  freshnessSlaMinutes?: number;
  window?: number;
  zThreshold?: number;
  minSamplesForZ?: number;
  relThreshold?: number;
  absFloor?: number;

  /** Rolling observation history (newest-last, capped to MAX_MONITOR_OBSERVATIONS). */
  observations: StoredObservation[];
  lastRunAt?: string;
  lastValue?: number;
  /** The open incident this monitor currently owns (dedup key), when tripped. */
  openIncidentId?: string;

  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

// ── Incident doc ─────────────────────────────────────────────────────────────

/** Incident lifecycle — a strict, auditable state machine. */
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

/** How an incident was born — drives grouping + copy. */
export type IncidentSource = 'monitor' | 'dq-finding';

/** One timeline entry — EVERY state change appends one (all audited). */
export interface IncidentTimelineEntry {
  at: string;
  /** The transition/action that produced this entry. */
  type: 'opened' | 'acknowledged' | 'resolved' | 'reopened' | 'note' | 'updated';
  /** Actor UPN/oid (display). */
  by: string;
  actorOid?: string;
  /** Optional free-text note (ack reason, resolution summary). */
  note?: string;
}

/**
 * A single incident. PK `tenantId` (single-partition list). `id` is deterministic
 * per its dedup key so a still-firing monitor / recurring finding updates the
 * SAME open incident instead of spawning duplicates.
 */
export interface IncidentDoc {
  id: string;
  tenantId: string;
  docType: 'incident';
  schemaVersion: number;

  status: IncidentStatus;
  severity: MonitorSeverity;
  source: IncidentSource;

  /** Grouping key (monitorId or dq-finding checkKey) — the dedup anchor. */
  dedupKey: string;

  /** What the incident is about. */
  itemId: string;
  itemType: string;
  workspaceId?: string;
  table?: string;
  monitorId?: string;
  monitorKind?: MonitorKind;

  title: string;
  detail: string;
  metric?: {
    name: string;
    value: number;
    baselineMean?: number;
    baselineStddev?: number;
    zScore?: number | null;
    threshold?: number;
  };
  /** schema-drift incidents carry the exact column delta. */
  schemaChange?: { added: string[]; removed: string[] };

  /** N7d finding ids folded into this incident (CONSUMED, not re-derived). */
  findingIds?: string[];

  timeline: IncidentTimelineEntry[];
  /** Runbook deep-link (ux-baseline "Runbook →" convention). */
  runbookUrl?: string;

  openedAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  /** Number of times the underlying signal re-fired while open (recurrence). */
  occurrences: number;
}

// ── Pure state machine ───────────────────────────────────────────────────────

/** The transitions the incident console offers. */
export type IncidentAction = 'acknowledge' | 'resolve' | 'reopen' | 'note';

export type TransitionResult =
  | { ok: true; nextStatus: IncidentStatus; timelineType: IncidentTimelineEntry['type'] }
  | { ok: false; error: string };

/**
 * Legal incident transitions (open → acknowledged → resolved, with reopen).
 * PURE + total: every (status, action) pair returns either the next status or a
 * precise error, so the store never has to encode transition legality inline.
 *
 *   open         --acknowledge--> acknowledged
 *   open         --resolve-------> resolved
 *   acknowledged --resolve-------> resolved
 *   resolved     --reopen--------> open
 *   *            --note----------> (unchanged status; appends a note entry)
 */
export function transitionIncident(status: IncidentStatus, action: IncidentAction): TransitionResult {
  if (action === 'note') {
    return { ok: true, nextStatus: status, timelineType: 'note' };
  }
  switch (status) {
    case 'open':
      if (action === 'acknowledge') return { ok: true, nextStatus: 'acknowledged', timelineType: 'acknowledged' };
      if (action === 'resolve') return { ok: true, nextStatus: 'resolved', timelineType: 'resolved' };
      return { ok: false, error: `cannot ${action} an incident that is open` };
    case 'acknowledged':
      if (action === 'resolve') return { ok: true, nextStatus: 'resolved', timelineType: 'resolved' };
      if (action === 'acknowledge') return { ok: false, error: 'incident is already acknowledged' };
      return { ok: false, error: `cannot ${action} an acknowledged incident` };
    case 'resolved':
      if (action === 'reopen') return { ok: true, nextStatus: 'open', timelineType: 'reopened' };
      return { ok: false, error: `cannot ${action} a resolved incident (reopen it first)` };
    default:
      return { ok: false, error: `unknown incident status "${status}"` };
  }
}

/** Deterministic, URL-safe id fragment. */
function slug(s: string): string {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

/** Deterministic monitor id — idempotent per (tenant, kind, item, table). */
export function monitorId(kind: MonitorKind, itemId: string, table: string): string {
  return `monitor:${kind}:${slug(itemId)}:${slug(table)}`.slice(0, 250);
}

/** Deterministic incident id — one open incident per dedup key + item. */
export function incidentId(source: IncidentSource, itemId: string, dedupKey: string): string {
  return `incident:${source}:${slug(itemId)}:${slug(dedupKey)}`.slice(0, 250);
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for both containers' migrator chains. v1 is current —
 * the chains are empty. The FIRST breaking change adds e.g.:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(INCIDENT_CONTAINER, 1, v1toV2);
 *
 * Keeping the `registerMigrator` reference live reserves the wiring without
 * claiming the v1 slot with an inert migrator (the MIG1 convention).
 */
export function registerIncidentMigrators(): void {
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerIncidentMigrators();
