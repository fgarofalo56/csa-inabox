/**
 * workspace-identity-shadow — I3 (loom-next-level): the shadow-mode divergence
 * audit. When `LOOM_WORKSPACE_IDENTITY_MODE=shadow`, every workspace-scoped
 * data-plane call keeps running as the SHARED Console UAMI (unchanged), and the
 * credential factory ALSO asks — from REAL RBAC state, never a guess — whether
 * the workspace's own uami-ws-<id> WOULD have been authorized, recording the
 * observation into the existing `_auditLog` container as `kind:'identity.shadow'`
 * (the exact sibling of `pdp.shadow` — see lib/auth/pdp/enforce.ts).
 *
 * `divergence: true` = the shared UAMI succeeded but the workspace UAMI would
 * have been DENIED — the migration-blocking case the I4 report surfaces before
 * an operator flips I6 enforce.
 *
 * NEVER blocks, never throws (mirrors pdpCheck shadow): the whole observe→write
 * path is fired async from the factory and swallows every error.
 *
 * ── Retention + classification (rev-2 SRE F8 — REQUIRED) ────────────────────
 * An `identity.shadow` row is a MAP OF WHERE LEAST-PRIVILEGE ISN'T YET
 * SATISFIED — access-decision recon data. It is classified
 * **access-control sensitive: tenant-admin read only** (the audit-log admin
 * surfaces are tenant-admin-gated; the I4 report route must keep that gate).
 * Every row carries a 90-day TTL (`ttl: 90d`, aligned to the audit-retention
 * convention; the same TTL decision is applied to the sibling `pdp.shadow`
 * rows in this PR). The audit-log container is TTL-enabled (defaultTtl -1) so
 * ordinary audit rows — which carry no ttl field — remain permanent.
 *
 * ── Cost (rev-2 SRE F10) ────────────────────────────────────────────────────
 * At sampling 1.0, shadow writes ≈ (workspace-context calls/s × ~5 RU) on the
 * shared serverless account. The grant evaluation itself is CACHED (5 min per
 * workspace+backend — workspace-grants.evaluateWorkspaceGrant), so the ARM/
 * data-plane probe cost is O(workspaces×backends), not O(calls).
 * `LOOM_WS_IDENTITY_SHADOW_SAMPLE` (0..1, default 1.0) is the RU lever for hot
 * paths — set per estate with the headroom stated in the enabling PR.
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  getWorkspaceUami,
  workspaceUamiName,
  type WorkspaceUami,
} from '@/lib/azure/workspace-identity-client';
import { evaluateWorkspaceGrant } from '@/lib/azure/workspace-grants';

/** 90 days, in seconds — the F8 retention decision for shadow observation rows. */
export const IDENTITY_SHADOW_TTL_SECONDS = 90 * 24 * 3600;

/** Sampling rate from LOOM_WS_IDENTITY_SHADOW_SAMPLE (0..1, default 1.0 —
 * every observation recorded). Unparseable values fall back to 1.0. */
export function identityShadowSampleRate(): number {
  const raw = process.env.LOOM_WS_IDENTITY_SHADOW_SAMPLE;
  if (raw === undefined || raw.trim() === '') return 1.0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(1, Math.max(0, n));
}

export interface IdentityShadowObservation {
  workspaceId: string;
  /** I2 grant-matrix backend key ('adls-lake' | 'synapse-sql' | …). */
  backend: string;
  /** Scope the grant evaluation resolved (ARM id / symbolic data-plane scope). */
  scope?: string;
  /** The data-plane action shape observed (free-form; defaults to 'data-plane-call'). */
  action?: string;
  /** The shared-UAMI call path outcome — true unless the caller knows better
   * (the factory records at credential-resolution time; the shared call is
   * about to run and today always may). */
  sharedAllowed?: boolean;
  /** REAL evaluation result: true = grant present; false = would be DENIED
   * (divergence when sharedAllowed); null = not applicable / unresolvable. */
  wsWouldAllow: boolean | null;
  wsIdentity?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Write ONE `identity.shadow` observation row to the existing audit-log
 * container (NOT a new container — the pdp.shadow precedent). Sampled via
 * {@link identityShadowSampleRate}; NEVER throws.
 */
export async function recordIdentityShadow(obs: IdentityShadowObservation): Promise<void> {
  try {
    const sample = identityShadowSampleRate();
    if (sample <= 0 || (sample < 1 && Math.random() >= sample)) return;
    const c = await auditLogContainer();
    const at = new Date().toISOString();
    const sharedAllowed = obs.sharedAllowed !== false;
    const divergence = obs.wsWouldAllow === null ? undefined : sharedAllowed && obs.wsWouldAllow === false;
    await c.items.create({
      id: `identity-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Partition key (/itemId) = workspaceId so per-workspace report reads are
      // single-partition, mirroring pdp.shadow's resource-id convention.
      itemId: obs.workspaceId,
      tenantId: process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || 'common',
      who: 'console-shared-uami',
      at,
      timestamp: at,
      ts: at,
      kind: 'identity.shadow',
      category: 'identity-shadow',
      workspaceId: obs.workspaceId,
      backend: obs.backend,
      scope: obs.scope || '',
      action: obs.action || 'data-plane-call',
      wsIdentity: obs.wsIdentity || workspaceUamiName(obs.workspaceId),
      sharedAllowed,
      wsWouldAllow: obs.wsWouldAllow,
      divergence,
      reason: obs.reason || '',
      // F8: access-control-sensitive recon data — self-evicts after 90 days.
      ttl: IDENTITY_SHADOW_TTL_SECONDS,
      details: {
        backend: obs.backend,
        scope: obs.scope,
        wsWouldAllow: obs.wsWouldAllow,
        divergence,
        reason: obs.reason,
        ...obs.details,
      },
    });
  } catch (e) {
    // Shadow must never break a request — log-and-swallow (pdp.shadow parity).
    console.error('[identity:shadow] non-fatal observe/audit error', e);
  }
}

// ── Factory hook — observe a workspace-scoped credential resolution ─────────

// Per-process UAMI lookup cache (workspaceId → uami|null) so the shadow path
// costs at most one ARM GET per workspace per TTL, not per call.
const UAMI_CACHE_TTL_MS = 5 * 60_000;
const uamiCache = new Map<string, { at: number; uami: WorkspaceUami | null }>();

/** Test-only: clear the shadow module's caches. */
export function __clearIdentityShadowCache(): void {
  uamiCache.clear();
}

async function cachedWorkspaceUami(workspaceId: string): Promise<WorkspaceUami | null> {
  const hit = uamiCache.get(workspaceId);
  if (hit && Date.now() - hit.at < UAMI_CACHE_TTL_MS) return hit.uami;
  let uami: WorkspaceUami | null = null;
  try {
    uami = await getWorkspaceUami(workspaceId);
  } catch {
    uami = null; // unconfigured / unreachable — recorded as unresolvable below
  }
  uamiCache.set(workspaceId, { at: Date.now(), uami });
  return uami;
}

/**
 * The I3 hook the credential factory fires (async, non-blocking) when a
 * workspace-scoped credential resolves in shadow mode: resolve the workspace
 * UAMI (cached), evaluate the I2 grant for the backend against LIVE state
 * (cached — workspace-grants.evaluateWorkspaceGrant), and record the
 * observation. NEVER throws.
 */
export async function observeWorkspaceContext(ctx: { workspaceId: string; backend: string }): Promise<void> {
  try {
    if (identityShadowSampleRate() <= 0) return; // cheap bail before any probe
    const uami = await cachedWorkspaceUami(ctx.workspaceId);
    if (!uami) {
      await recordIdentityShadow({
        workspaceId: ctx.workspaceId,
        backend: ctx.backend,
        wsWouldAllow: false,
        reason: `uami-ws-${ctx.workspaceId} does not exist (not provisioned) — the workspace UAMI would have been denied`,
      });
      return;
    }
    const evaluation = await evaluateWorkspaceGrant(
      { id: ctx.workspaceId },
      { principalId: uami.principalId, clientId: uami.clientId, name: uami.name },
      ctx.backend,
    );
    await recordIdentityShadow({
      workspaceId: ctx.workspaceId,
      backend: ctx.backend,
      scope: undefined,
      wsWouldAllow: evaluation.wouldAllow,
      wsIdentity: uami.name,
      reason: evaluation.reason,
      details: { source: evaluation.source, checkedAt: evaluation.checkedAt },
    });
  } catch (e) {
    console.error('[identity:shadow] non-fatal hook error', e);
  }
}
