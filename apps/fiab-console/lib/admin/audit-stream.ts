/**
 * audit-stream — continuous SIEM-exportable admin/audit activity stream
 * (Wave-1 BR-SIEM).
 *
 * Every admin-plane mutation choke point (role/permission changes, workspace
 * create/delete, tenant-settings + env-config writes, MCP-server deploy /
 * teardown / config, domain delete, platform update-apply) fires a structured
 * event through {@link emitAuditEvent}. That event is POSTed — fire-and-forget —
 * to the Azure Monitor **Logs Ingestion API** (DCR-based), landing in the
 * `LoomAudit_CL` custom table on the Loom Log Analytics workspace, where a SIEM
 * (Microsoft Sentinel via the docs/fiab/operations/siem-audit-stream.md rule
 * templates, or any workspace-connected SIEM) can alert on it continuously.
 *
 * ## Transport (grounded in Microsoft Learn — "Logs Ingestion API in Azure
 * Monitor")
 *
 *   POST {DCE-endpoint}/dataCollectionRules/{DCR-immutable-id}/streams/Custom-LoomAudit_CL?api-version=2023-01-01
 *   Authorization: Bearer <token for the Monitor ingestion audience>
 *   Content-Type: application/json
 *   body: JSON array of rows matching the Custom-LoomAudit_CL stream schema
 *
 * The bearer token uses the per-cloud Monitor ingestion audience
 * (`https://monitor.azure.com` Commercial / `https://monitor.azure.us` Gov) via
 * the shared ACA-first UAMI credential chain ({@link uamiArmCredential}). The
 * Console UAMI needs **Monitoring Metrics Publisher** on the DCR — wired by
 * `platform/fiab/bicep/modules/admin-plane/audit-stream.bicep`.
 *
 * ## Honest gate (no-vaporware.md)
 *
 * When `LOOM_AUDIT_DCR_ENDPOINT` / `LOOM_AUDIT_DCR_ID` are unset the emitter is
 * a **silent no-op** (one-time debug log naming the exact env to set). Admin
 * mutations are NEVER blocked, slowed, or failed by the audit stream — SIEM
 * forwarding is strictly additive telemetry on top of the existing Cosmos
 * `auditLogContainer` trail (which /admin/audit-logs already reads). This is a
 * deployment fact, not a policy gate.
 */

import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { monitorIngestionScope } from '@/lib/azure/cloud-endpoints';
import { emitLoomEvent } from '@/lib/events/webhook-emitter';
import { auditActionToEventType } from '@/lib/events/event-types';

/** The DCR stream name (matches the bicep streamDeclarations key + table). */
export const AUDIT_STREAM = 'Custom-LoomAudit_CL';
/** Logs Ingestion API version (stable). */
export const AUDIT_INGESTION_API_VERSION = '2023-01-01';

export type AuditOutcome = 'success' | 'failure' | 'denied';

/**
 * A single admin-plane audit event. Field set is fixed (maps 1:1 to the
 * LoomAudit_CL columns) so every emitter site produces a uniformly-shaped row.
 */
export interface AdminAuditEvent {
  /** Entra object id of the acting admin (session `claims.oid`). */
  actorOid: string;
  /** UPN / email of the acting admin (session `claims.upn`). */
  actorUpn: string;
  /** Dotted action verb, e.g. `feature-grant.upsert`, `workspace.delete`. */
  action: string;
  /** The mutated object class, e.g. `feature-grant`, `workspace`, `mcp-server`. */
  targetType: string;
  /** Stable id of the mutated object (grant id / workspace id / server id / …). */
  targetId: string;
  /** Result of the mutation. Defaults to `success`. */
  outcome?: AuditOutcome;
  /** Structured extra context (serialised to a JSON string in `Detail`). */
  detail?: Record<string, unknown> | string;
  /** Entra tenant id (session `claims.tid`) — scopes the event to the tenant. */
  tenantId: string;
  /** ISO-8601 event time. Defaults to now. */
  timestamp?: string;
}

/** The row shape POSTed to the ingestion API — 1:1 with the LoomAudit_CL columns. */
export interface LoomAuditRow {
  TimeGenerated: string;
  ActorOid: string;
  ActorUpn: string;
  Action: string;
  TargetType: string;
  TargetId: string;
  Outcome: string;
  Detail: string;
  TenantId: string;
}

let warnedDisabled = false;

/**
 * Resolve the DCR ingestion config, or `null` (the honest, un-provisioned gate)
 * with a one-time debug log. Exported for the unit test.
 */
export function auditStreamConfig(): { endpoint: string; dcrId: string } | null {
  const endpoint = (process.env.LOOM_AUDIT_DCR_ENDPOINT || '').trim().replace(/\/+$/, '');
  const dcrId = (process.env.LOOM_AUDIT_DCR_ID || '').trim();
  if (!endpoint || !dcrId) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      // eslint-disable-next-line no-console
      console.debug(
        '[audit-stream] SIEM audit forwarding disabled — set LOOM_AUDIT_DCR_ENDPOINT ' +
          '(the DCE logs-ingestion endpoint) + LOOM_AUDIT_DCR_ID (the DCR immutable id) to ' +
          'stream admin mutations to the LoomAudit_CL table. Deploy them with ' +
          'platform/fiab/bicep/modules/admin-plane/audit-stream.bicep. The Cosmos audit trail ' +
          'is unaffected.',
      );
    }
    return null;
  }
  return { endpoint, dcrId };
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Map an {@link AdminAuditEvent} to a LoomAudit_CL row. Pure — unit-tested. */
export function buildAuditRow(ev: AdminAuditEvent): LoomAuditRow {
  return {
    TimeGenerated: ev.timestamp || new Date().toISOString(),
    ActorOid: ev.actorOid || '',
    ActorUpn: ev.actorUpn || '',
    Action: ev.action || '',
    TargetType: ev.targetType || '',
    TargetId: ev.targetId || '',
    Outcome: ev.outcome || 'success',
    Detail: safeStringify(ev.detail),
    TenantId: ev.tenantId || '',
  };
}

// Short-lived token cache — the ingestion token is reused across events until it
// is within 2 min of expiry. Keyed on nothing (single audience per process).
let tokenCache: { token: string; expiresOnTimestamp: number } | null = null;

async function ingestionToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresOnTimestamp - now > 120_000) return tokenCache.token;
  const cred = uamiArmCredential();
  const t = await cred.getToken(monitorIngestionScope());
  if (!t?.token) throw new Error('could not acquire an Azure Monitor ingestion token');
  tokenCache = { token: t.token, expiresOnTimestamp: t.expiresOnTimestamp };
  return t.token;
}

/**
 * POST a batch of events to the Logs Ingestion API. Resolves `{ sent: 0,
 * skipped }` when the stream is un-provisioned (honest gate); throws on a real
 * transport / auth error so {@link emitAuditEvent} can log it. Exported for the
 * unit test + any caller that wants to await delivery.
 */
export async function postAuditEvents(
  events: AdminAuditEvent[],
): Promise<{ sent: number; skipped?: 'not-configured' | 'empty' }> {
  if (!events.length) return { sent: 0, skipped: 'empty' };
  const cfg = auditStreamConfig();
  if (!cfg) return { sent: 0, skipped: 'not-configured' };

  const rows = events.map(buildAuditRow);
  const token = await ingestionToken();
  const url =
    `${cfg.endpoint}/dataCollectionRules/${cfg.dcrId}/streams/${AUDIT_STREAM}` +
    `?api-version=${AUDIT_INGESTION_API_VERSION}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rows),
    // Never let a slow SIEM endpoint stall a mutation response.
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Logs Ingestion API ${res.status}: ${body.slice(0, 300)}`);
  }
  return { sent: rows.length };
}

/**
 * Fire-and-forget emit of a single admin-audit event to the SIEM stream. NEVER
 * throws and NEVER blocks the caller — a mutation route calls this with a bare
 * `void emitAuditEvent({...})` after its Cosmos write. On any failure (auth,
 * network, un-provisioned) it logs and moves on; the authoritative record is the
 * Cosmos audit trail, and SIEM forwarding is best-effort telemetry.
 */
export function emitAuditEvent(ev: AdminAuditEvent): void {
  try {
    void postAuditEvents([ev]).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[audit-stream] failed to forward audit event to SIEM:', (e as Error)?.message || e);
    });
  } catch (e) {
    // Synchronous failure (config/serialisation) — still non-fatal.
    // eslint-disable-next-line no-console
    console.warn('[audit-stream] emit failed:', (e as Error)?.message || e);
  }
  // BR-WEBHOOK — fan the SAME admin-plane mutation out to any subscribed
  // outbound webhook. This reuses every choke point BR-SIEM already instruments
  // (workspace/permission/mcp-server/tenant-settings/env-config/domain/platform)
  // with zero new edits to those routes. Fire-and-forget; never blocks/throws.
  try {
    void emitLoomEvent({
      type: auditActionToEventType(ev.action),
      tenantId: ev.tenantId || ev.actorOid,
      subject: ev.targetId,
      actor: { oid: ev.actorOid, upn: ev.actorUpn },
      data: {
        action: ev.action,
        targetType: ev.targetType,
        targetId: ev.targetId,
        outcome: ev.outcome || 'success',
        detail: typeof ev.detail === 'string' ? ev.detail : ev.detail,
      },
    });
  } catch {
    /* webhook fan-out is best-effort */
  }
}
