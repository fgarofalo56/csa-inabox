/**
 * Per-workspace identity enforcement BFF — I6 (loom-next-level Section I).
 *
 * Backs the workspace Settings → Identity panel: the safe, incremental control
 * that flips a SINGLE workspace from shadow/observe to `enforce` (its own
 * `uami-ws-<id>` mints the data-plane token), independent of the global
 * `LOOM_WORKSPACE_IDENTITY_MODE`. The per-workspace flag is DATA on the workspace
 * doc, not an env var.
 *
 *   GET  /api/admin/workspaces/{id}/identity
 *        → { ok, data } where data =
 *          { mode, enforce, identity(provisioning status block), preflight (I7
 *            grant-check), divergenceRollup (I4, 14-day), review (I9 sign-off),
 *            readiness { canEnable, blockers } , panelEnabled(FLAG0) }
 *        Real ARM + data-plane + Cosmos probes (no mocks — no-vaporware.md).
 *
 *   POST /api/admin/workspaces/{id}/identity   body { enforce: true | false }
 *        → ENABLE runs the I7 preflight + the I4 14-day divergence rollup + the
 *          I9 review gate and REFUSES (409 `not_ready`) if any precondition is
 *          unmet, naming the exact missing grant / divergence / sign-off. DISABLE
 *          always succeeds (the I7 instant, fail-safe rollback). Persists the flag
 *          and writes the ATO-required `identity.enforce` audit row.
 *
 * SECURITY: TENANT-ADMIN ONLY (both verbs). The grant + divergence detail is
 * access-control-sensitive recon data (I9 F-3), so even a non-admin workspace
 * OWNER is refused 403 here. Azure-native — no Fabric dependency.
 *
 * Enforcement stays OPERATOR-GATED by design: with the I9 review not yet signed
 * off in an estate (LOOM_IDENTITY_ENFORCE_REVIEW_SIGNOFF unset), `canEnable` is
 * false and the POST enable path refuses — the panel's Enable button is disabled
 * with the inline reason. Nothing here flips a workspace on its own.
 */
import { NextRequest } from 'next/server';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';
import { workspacesContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  preflightWorkspaceEnforce,
  type WorkspaceEnforcePreflight,
} from '@/lib/azure/workspace-identity-preflight';
import {
  identityDivergenceRollup,
  type IdentityDivergenceRollup,
} from '@/lib/azure/workspace-identity-shadow';
import { workspaceIdentityMode } from '@/lib/azure/workspace-identity-client';
import {
  identityEnforceReview,
  type IdentityEnforceReview,
} from '@/lib/security/identity-enforce-review';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The FLAG0 kill-switch gating the Identity panel (default-ON). */
const PANEL_FLAG = 'i6-ws-identity-panel';

/** Strict tenant-admin gate: resolveAdminWorkspace admits a non-admin OWNER on
 * their own partition, but the identity recon + enforce toggle is tenant-admin
 * only (I9 F-3) — mirrors the DELETE precedent in the sibling admin route. */
const ADMIN_ONLY = 'Only a tenant admin can view or change per-workspace identity enforcement.';

/**
 * Combine the three readiness gates (I7 preflight, I4 14-day divergence, I9
 * review) into the ordered, de-duplicated list of blockers. Empty ⇔ ready to
 * enable. The preflight already surfaces its own all-time divergence/unreadable
 * reasons; the 14-day rollup is the independent windowed operational gate.
 */
function enforceBlockers(
  preflight: WorkspaceEnforcePreflight,
  rollup: IdentityDivergenceRollup,
  review: IdentityEnforceReview,
): string[] {
  const out: string[] = [];
  if (!preflight.ready) out.push(...preflight.reasons);
  if (rollup.unreadable) {
    out.push(
      `The ${rollup.windowDays}-day shadow-divergence rollup could not be read from Cosmos — readiness cannot be certified without it.`,
    );
  } else if (rollup.divergences > 0) {
    const byBackend = Object.entries(rollup.byBackend)
      .map(([b, n]) => `${b} (${n})`)
      .join(', ');
    out.push(
      `${rollup.divergences} shadow divergence(s) recorded in the last ${rollup.windowDays} days` +
        `${byBackend ? `: ${byBackend}` : ''}. The shared UAMI succeeded where the workspace UAMI would have been DENIED — resolve the underlying grants before enforcing.`,
    );
  }
  if (!review.signedOff && review.reason) out.push(review.reason);
  // De-dupe while preserving order (preflight + rollup can name the same gap).
  return [...new Set(out)];
}

function buildReadiness(
  preflight: WorkspaceEnforcePreflight,
  rollup: IdentityDivergenceRollup,
  review: IdentityEnforceReview,
) {
  const blockers = enforceBlockers(preflight, rollup, review);
  const canEnable =
    preflight.ready &&
    !rollup.unreadable &&
    rollup.divergences === 0 &&
    review.signedOff &&
    blockers.length === 0;
  return { canEnable, blockers };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const resolved = await resolveAdminWorkspace(id);
  if (resolved.resp) return resolved.resp;
  const { session, ws } = resolved;
  if (!isTenantAdmin(session)) return apiError(ADMIN_ONLY, 403, { code: 'admin_only' });

  try {
    const [preflight, divergenceRollup, panelEnabled] = await Promise.all([
      preflightWorkspaceEnforce({ id: ws.id, storageAccountId: ws.storageAccountId }),
      identityDivergenceRollup(ws.id, 14),
      runtimeFlag(PANEL_FLAG),
    ]);
    const review = identityEnforceReview();
    return apiOk({
      data: {
        workspaceId: ws.id,
        // Effective GLOBAL mode (off | shadow | enforce) — the panel shows this
        // alongside the per-workspace flag; we never change the global default.
        mode: workspaceIdentityMode(),
        enforce: ws.workspaceIdentity?.enforce === true,
        enforceAt: ws.workspaceIdentity?.enforceAt,
        enforceBy: ws.workspaceIdentity?.enforceBy,
        // The I1 provisioning status block (UAMI name/clientId + per-backend grants).
        identity: ws.workspaceIdentity ?? null,
        preflight,
        divergenceRollup,
        review,
        readiness: buildReadiness(preflight, divergenceRollup, review),
        panelEnabled,
      },
    });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const resolved = await resolveAdminWorkspace(id);
  if (resolved.resp) return resolved.resp;
  const { session, ws } = resolved;
  if (!isTenantAdmin(session)) return apiError(ADMIN_ONLY, 403, { code: 'admin_only' });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body', 400, { code: 'bad_json' });
  }
  if (typeof body?.enforce !== 'boolean') {
    return apiError('body.enforce must be true or false', 400, { code: 'bad_request' });
  }
  const enable: boolean = body.enforce === true;
  const prior = ws.workspaceIdentity?.enforce === true;

  try {
    // ── ENABLE: hard preconditions (I7 preflight + I4 14-day divergence + I9) ──
    // A security-posture change: refuse unless the workspace is genuinely ready,
    // naming the exact missing grant / divergence / unsigned review. This is the
    // server-side twin of the disabled Enable button — a direct API call cannot
    // bypass the gate.
    if (enable) {
      const [preflight, divergenceRollup] = await Promise.all([
        preflightWorkspaceEnforce({ id: ws.id, storageAccountId: ws.storageAccountId }),
        identityDivergenceRollup(ws.id, 14),
      ]);
      const review = identityEnforceReview();
      const blockers = enforceBlockers(preflight, divergenceRollup, review);
      if (blockers.length > 0) {
        return apiError(
          `Cannot enable per-workspace identity enforcement yet: ${blockers[0]}`,
          409,
          { code: 'not_ready', blockers, preflight, divergenceRollup, review },
        );
      }
    }

    // ── Persist the per-workspace flag on the workspace doc ──
    const now = new Date().toISOString();
    const who = session.claims.upn || session.claims.email || session.claims.oid;
    const next: Workspace = {
      ...ws,
      workspaceIdentity: {
        ...(ws.workspaceIdentity ?? { status: 'skipped' as const }),
        enforce: enable,
        enforceAt: now,
        enforceBy: who,
      },
      updatedAt: now,
    };
    const c = await workspacesContainer();
    const { resource } = await c.item(ws.id, ws.tenantId).replace<Workspace>(next);

    // ── AUDIT (ATO, REQUIRED): every toggle writes an authoritative _auditLog
    //    row + a SIEM emit. Best-effort — a toggle is never blocked by an audit
    //    hiccup (matching every other admin-plane mutation). ──
    const action = enable ? 'enable' : 'disable';
    try {
      const audit = await auditLogContainer();
      await audit.items
        .create({
          id: `identity-enforce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: ws.id,
          tenantId: session.claims.tid || session.claims.oid,
          kind: 'identity.enforce',
          who,
          oid: session.claims.oid,
          action,
          workspaceId: ws.id,
          prior,
          next: enable,
          at: now,
          ts: now,
        })
        .catch(() => undefined);
    } catch {
      /* audit failures are non-blocking */
    }
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: who,
      action: 'identity.enforce.set',
      targetType: 'workspace',
      targetId: ws.id,
      tenantId: session.claims.tid || session.claims.oid,
      detail: { action, prior, next: enable, name: ws.name },
    });

    return apiOk({
      data: {
        workspaceId: ws.id,
        enforce: enable,
        enforceAt: now,
        enforceBy: who,
        workspace: resource,
      },
    });
  } catch (e) {
    return apiServerError(e);
  }
}
