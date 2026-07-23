/**
 * secret-expiry-monitor — PURE core (S1). Threshold math, inventory merge,
 * drift detection, and alert-band transition logic. Zero imports, zero I/O —
 * unit-tested in expiry-core.test.ts; every Azure/GitHub call lives in
 * azure-clients.ts (the thin-wrapper split mirrors ops-agent-evaluator).
 *
 * Why this exists: the Console MSAL app is a confidential client with a 2-year
 * secret (entra-app-registration.bicep `az ad app credential reset --years 2`).
 * On 2026-07-19 a drifted/expired secret broke ALL sign-in (AADSTS7000215)
 * with zero warning. This core turns "when does each standing credential die"
 * into data: days-to-expiry per credential + 60/30/7-day alert bands.
 */

export type Band = 'expired' | 'critical' | 'warn30' | 'warn60' | 'ok' | 'no-expiry';

/** Severity order for band-transition alerting (higher = worse). */
export const BAND_SEVERITY: Record<Band, number> = {
  'no-expiry': 0,
  ok: 0,
  warn60: 1,
  warn30: 2,
  critical: 3,
  expired: 4,
};

/** One password credential from Graph GET /applications(appId='…'). */
export interface GraphPasswordCredential {
  keyId: string;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
}

/** Key Vault secret attributes (GET {vault}/secrets/{name} → attributes). */
export interface KvSecretInfo {
  name: string;
  /** attributes.exp — Unix seconds; KV secrets often have NO expiry set. */
  exp?: number | null;
  /** attributes.updated — Unix seconds (used for drift detection). */
  updated?: number | null;
  enabled?: boolean;
  /** 404 from the vault — the tracked secret does not exist (yet). */
  notFound?: boolean;
  /** Non-404 read error (403 role missing, network) — surfaced honestly. */
  error?: string;
}

export interface TrackedCredential {
  /** Stable id — 'entra-app:<keyId>' or 'kv:<secretName>'. */
  id: string;
  source: 'entra-app' | 'key-vault';
  label: string;
  /** ISO expiry, null when the credential carries no expiry metadata. */
  expiresAt: string | null;
  /** Whole days until expiry (negative = already expired); null = no expiry. */
  daysToExpiry: number | null;
  band: Band;
  /** Honest context — "no expiry attribute set", "not found in vault", drift. */
  detail?: string;
  /** True when the KV copy of the MSAL secret predates the app's newest
   * credential — the exact 2026-07-19 drift failure mode. */
  drift?: boolean;
}

const DAY_MS = 86_400_000;

/** Whole days from `nowMs` to the ISO expiry (floor; negative = expired). */
export function daysToExpiry(nowMs: number, endIso: string | null | undefined): number | null {
  if (!endIso) return null;
  const end = Date.parse(endIso);
  if (Number.isNaN(end)) return null;
  return Math.floor((end - nowMs) / DAY_MS);
}

/** Band for a days-to-expiry value. warnDays is the OUTER threshold
 * (LOOM_SECRET_EXPIRY_WARN_DAYS, default 60); 30/7 are fixed inner bands. */
export function bandFor(days: number | null, warnDays = 60): Band {
  if (days === null) return 'no-expiry';
  if (days < 0) return 'expired';
  if (days <= 7) return 'critical';
  if (days <= 30) return 'warn30';
  if (days <= Math.max(warnDays, 30)) return 'warn60';
  return 'ok';
}

export interface InventoryInput {
  appId?: string;
  appDisplayName?: string;
  appCreds: GraphPasswordCredential[];
  kvSecrets: KvSecretInfo[];
  nowMs: number;
  warnDays?: number;
  /** KV secret name holding the MSAL secret copy (drift detection pair). */
  msalKvSecretName?: string;
}

/** Merge the Graph passwordCredentials + tracked KV secrets into one sorted
 * inventory (worst band first, then fewest days). Detects MSAL secret DRIFT:
 * the app's newest credential is newer than the KV copy → the running app may
 * hold a stale secret (the 2026-07-19 failure mode). */
export function mergeInventory(input: InventoryInput): TrackedCredential[] {
  const warnDays = input.warnDays ?? 60;
  const out: TrackedCredential[] = [];

  let newestCredStart = 0;
  for (const c of input.appCreds) {
    const start = c.startDateTime ? Date.parse(c.startDateTime) : NaN;
    if (!Number.isNaN(start) && start > newestCredStart) newestCredStart = start;
    const days = daysToExpiry(input.nowMs, c.endDateTime);
    out.push({
      id: `entra-app:${c.keyId}`,
      source: 'entra-app',
      label: `${input.appDisplayName || 'MSAL app'} — client secret ${c.displayName || c.keyId.slice(0, 8)}`,
      expiresAt: c.endDateTime || null,
      daysToExpiry: days,
      band: bandFor(days, warnDays),
      detail: days === null ? 'No endDateTime on the app credential.' : undefined,
    });
  }

  // 15-minute slack so a rotation that writes KV first/last does not flap.
  const DRIFT_SLACK_MS = 15 * 60_000;
  for (const s of input.kvSecrets) {
    if (s.notFound) {
      out.push({
        id: `kv:${s.name}`, source: 'key-vault', label: `Key Vault secret ${s.name}`,
        expiresAt: null, daysToExpiry: null, band: 'no-expiry',
        detail: 'Not found in the vault — the tracked secret has not been provisioned yet.',
      });
      continue;
    }
    if (s.error) {
      out.push({
        id: `kv:${s.name}`, source: 'key-vault', label: `Key Vault secret ${s.name}`,
        expiresAt: null, daysToExpiry: null, band: 'no-expiry',
        detail: `Vault read failed: ${s.error}`,
      });
      continue;
    }
    const expiresAt = typeof s.exp === 'number' ? new Date(s.exp * 1000).toISOString() : null;
    const days = daysToExpiry(input.nowMs, expiresAt);
    const drift =
      !!input.msalKvSecretName &&
      s.name === input.msalKvSecretName &&
      newestCredStart > 0 &&
      typeof s.updated === 'number' &&
      newestCredStart - s.updated * 1000 > DRIFT_SLACK_MS;
    out.push({
      id: `kv:${s.name}`,
      source: 'key-vault',
      label: `Key Vault secret ${s.name}`,
      expiresAt,
      daysToExpiry: days,
      band: drift ? 'critical' : bandFor(days, warnDays),
      drift: drift || undefined,
      detail: drift
        ? 'DRIFT: the app registration has a newer client secret than this vault copy — the running app may hold a stale secret (the 2026-07-19 outage mode). Re-run the rotation runbook.'
        : days === null
          ? (typeof s.updated === 'number'
              ? `No expiry attribute set (last updated ${new Date(s.updated * 1000).toISOString().slice(0, 10)}).`
              : 'No expiry attribute set.')
          : undefined,
    });
  }

  return out.sort((a, b) => {
    const sev = BAND_SEVERITY[b.band] - BAND_SEVERITY[a.band];
    if (sev !== 0) return sev;
    const ad = a.daysToExpiry ?? Number.MAX_SAFE_INTEGER;
    const bd = b.daysToExpiry ?? Number.MAX_SAFE_INTEGER;
    return ad - bd;
  });
}

/** Per-credential last-alerted band (persisted as a state blob between ticks). */
export type AlertState = Record<string, { band: Band; alertedAt: string }>;

/** Alert exactly on band ESCALATION (ok→warn60, warn60→warn30, …) so a daily
 * cron does not re-fire the same warning every day. De-escalation (rotation
 * fixed it) clears silently. */
export function shouldAlert(prev: Band | undefined, cur: Band): boolean {
  if (BAND_SEVERITY[cur] === 0) return false;
  return BAND_SEVERITY[cur] > BAND_SEVERITY[prev ?? 'ok'];
}

/** The items whose band escalated since the last tick. */
export function alertingItems(items: TrackedCredential[], state: AlertState): TrackedCredential[] {
  return items.filter((i) => shouldAlert(state[i.id]?.band, i.band));
}

/** Fold the current bands into the next persisted state (records every
 * non-ok band so de-escalation re-arms the alert). */
export function nextState(items: TrackedCredential[], nowIso: string): AlertState {
  const out: AlertState = {};
  for (const i of items) {
    if (BAND_SEVERITY[i.band] > 0) out[i.id] = { band: i.band, alertedAt: nowIso };
  }
  return out;
}

/** O1 unified alert convention — P-band severity for a credential band.
 * Mirrors lib/azure/alert-dispatch.ts routing (P1 page / P3 email):
 * expired|critical (<7d — the 2026-07-19 outage class) → P1; warn30 → P2;
 * warn60 and everything else → P3 (email band). */
export function severityForBand(band: Band): 'P1' | 'P2' | 'P3' {
  if (band === 'expired' || band === 'critical') return 'P1';
  if (band === 'warn30') return 'P2';
  return 'P3';
}

/** Human alert payload for the action group + the dedup GitHub issue. */
export function buildAlertMessage(items: TrackedCredential[], warnDays: number): { subject: string; body: string } {
  const worst = items[0];
  const subject = `CSA Loom secret expiry — ${items.length} credential${items.length === 1 ? '' : 's'} below threshold (worst: ${worst?.band}${worst?.daysToExpiry !== null && worst?.daysToExpiry !== undefined ? `, ${worst.daysToExpiry}d` : ''})`;
  const lines = items.map((i) =>
    `- [${i.band}] ${i.label}: ${i.daysToExpiry !== null ? `${i.daysToExpiry} days to expiry (${i.expiresAt})` : (i.detail || 'no expiry metadata')}${i.drift ? ' [DRIFT]' : ''}`,
  );
  const body =
    `Secret-expiry monitor (S1) — thresholds ${warnDays}/30/7 days.\n\n${lines.join('\n')}\n\n` +
    'Rotate BEFORE expiry: docs/fiab/runbooks/secret-rotation.md ' +
    '(long-term fix: the S2 federated-credential migration, docs/fiab/runbooks/msal-credential-strategy.md).';
  return { subject, body };
}

/** Stable dedup title for the GitHub issue (one issue per credential+band). */
export function issueTitle(item: TrackedCredential): string {
  return `secret-expiry: ${item.label} — ${item.band}`;
}

/** Honest config gate: name exactly what is missing for each capability. */
export function missingConfig(env: Record<string, string | undefined>): {
  fatal: string[];
  graph: string[];
  keyVault: string[];
  alerting: string[];
} {
  const graph = env.LOOM_MSAL_CLIENT_ID ? [] : ['LOOM_MSAL_CLIENT_ID'];
  const keyVault = env.LOOM_KEY_VAULT_URI ? [] : ['LOOM_KEY_VAULT_URI'];
  const alerting = env.LOOM_ALERT_ACTION_GROUP_ID ? [] : ['LOOM_ALERT_ACTION_GROUP_ID'];
  // Fatal only when there is NOTHING to inventory.
  const fatal = graph.length && keyVault.length ? [...graph, ...keyVault] : [];
  return { fatal, graph, keyVault, alerting };
}

/** Parse the tracked-KV-secret list env (comma-separated, trimmed, deduped). */
export function parseTrackedSecrets(raw: string | undefined): string[] {
  return [...new Set((raw || '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/** Parse LOOM_SECRET_EXPIRY_WARN_DAYS (default 60; guards NaN/negatives). */
export function parseWarnDays(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}
