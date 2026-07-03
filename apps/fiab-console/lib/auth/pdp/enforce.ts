/**
 * PDP enforcement GATE — shadow / enforce / off (EH Phase-1 P0).
 *
 * `pdpCheck()` is the single call a BFF route adds at the top of a handler
 * (AFTER its own session check) to consult the Policy Decision Point. It is
 * **default-SHADOW and never-blocking** (rel-T20): with `LOOM_PDP_ENFORCE`
 * unset the gate evaluates the policy and writes ONE audit row, but ALWAYS
 * returns `null` — so a wired route's behavior is unchanged (nothing is ever
 * blocked) while the deployment gains full policy-decision observability. Only
 * an explicit `LOOM_PDP_ENFORCE=enforce` can block; `LOOM_PDP_ENFORCE=off`
 * restores the pre-shadow zero-cost bail.
 *
 * Three modes (read once per call from `LOOM_PDP_ENFORCE`, lower-cased):
 *
 *   off      → return null immediately. No authorize(), no Cosmos, no log.
 *              (Explicit opt-out only — no longer the default.)
 *   shadow   → authorize() + write ONE row to the existing `_auditLog`
 *              container (reusing `auditLogContainer()` — NOT a new container)
 *              capturing the decision (and, when the caller passes its legacy
 *              allow/deny, whether the PDP DIVERGES from today's behavior).
 *              ALWAYS returns null — shadow NEVER blocks. The whole
 *              authorize()+log is wrapped in try/catch and log-and-swallows on
 *              ANY error, so shadow can never break a request.
 *   enforce  → authorize(); on `deny` return a 403 NextResponse, else null.
 *              On an authorize() THROW in enforce, FAIL-CLOSED (return the 403)
 *              after logging the error — an unavailable PDP must not silently
 *              allow once an operator has explicitly turned enforcement on.
 *
 * Per no-vaporware.md: shadow does a REAL authorize() (real policy-bundle load
 * + pure evaluate()) and a REAL audit write to the live container — no mocks.
 */

import { NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import type { Action, Decision, Principal, ResourceRef } from './resource-ref';
import { authorize } from './authorize';
import { auditLogContainer } from '@/lib/azure/cosmos-client';

export type PdpEnforceMode = 'off' | 'shadow' | 'enforce';

/**
 * Current PDP gate mode from `LOOM_PDP_ENFORCE`.
 *
 * DEFAULT = 'shadow' (rel-T20): with the env var UNSET the PDP evaluates every
 * wired route and logs its decision to the audit log but NEVER blocks — so a
 * fresh deployment gets full policy-decision observability out of the box and
 * an operator can vet divergence before flipping enforcement on. Enforcement
 * stays strictly behind an explicit `LOOM_PDP_ENFORCE=enforce`. Set
 * `LOOM_PDP_ENFORCE=off` to fully disable (no evaluate, no Cosmos, no log) —
 * the only value that restores the pre-shadow zero-cost behavior.
 *
 * Exported for tests + callers that want to branch on the active mode.
 */
export function pdpEnforceMode(): PdpEnforceMode {
  const raw = (process.env.LOOM_PDP_ENFORCE || 'shadow').toLowerCase();
  // Unset / unrecognized → shadow (the safe, non-blocking default).
  return raw === 'off' || raw === 'enforce' ? raw : 'shadow';
}

/** Build the PDP Principal from the BFF session claims.
 *
 * The session cookie's `UserClaims` (lib/auth/msal.ts) carries `oid`, `upn`,
 * and optional `groups` — but NO tenant-id claim (the cookie is intentionally
 * minimal). `tenantId` therefore comes from the deployment's configured tenant
 * (LOOM_TENANT_ID / AZURE_TENANT_ID), matching how the OneLake-security route
 * resolves the tenant. */
function principalFromSession(session: SessionPayload): Principal {
  const c = session.claims;
  return {
    oid: c.oid,
    upn: c.upn || c.email || c.oid,
    groups: c.groups || [],
    tenantId: process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || 'common',
  };
}

/** Short human-readable summary of a ResourceRef for the audit row. */
function summarizeResource(resource: ResourceRef): string {
  const parts: string[] = [`${resource.level}:${resource.id}`];
  if (resource.itemType) parts.push(`type=${resource.itemType}`);
  if (resource.table) parts.push(`table=${resource.table}`);
  if (resource.column) parts.push(`column=${resource.column}`);
  let p = resource.parent;
  const chain: string[] = [];
  while (p) {
    chain.push(`${p.level}:${p.id}`);
    p = p.parent;
  }
  if (chain.length) parts.push(`under=${chain.join('/')}`);
  return parts.join(' ');
}

/**
 * Write ONE shadow-mode observation row to the existing audit-log container.
 * Reuses `auditLogContainer()` (partition key `/itemId`) so the row surfaces in
 * the Admin → Audit Logs reader (which queries `c.kind` / orders by `c.at`).
 * The PDP-specific fields the task captures live both at the top level and in
 * `details`. Never throws — the caller already runs this under try/catch, but
 * this stays self-contained too.
 */
async function writeShadowAudit(
  principal: Principal,
  resource: ResourceRef,
  action: Action,
  decision: Decision,
  legacyAllowed: boolean | undefined,
): Promise<void> {
  const c = await auditLogContainer();
  const at = new Date().toISOString();
  const routeSummary = summarizeResource(resource);
  const divergence =
    legacyAllowed !== undefined ? legacyAllowed !== (decision.effect === 'allow') : undefined;
  await c.items.create({
    id: `pdp-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    itemId: resource.id,
    tenantId: principal.tenantId,
    who: principal.oid,
    at,
    timestamp: at,
    kind: 'pdp.shadow',
    category: 'pdp-shadow',
    action,
    // The task-specified observation shape:
    ts: at,
    oid: principal.oid,
    route: routeSummary,
    effect: decision.effect,
    reason: decision.reason,
    source: decision.source,
    obligations: decision.obligations.length,
    divergence,
    details: {
      route: routeSummary,
      effect: decision.effect,
      reason: decision.reason,
      source: decision.source,
      obligations: decision.obligations.length,
      legacyAllowed,
      divergence,
    },
  });
}

/**
 * Consult the PDP for (`session`, `resource`, `action`) at the top of a BFF
 * handler. Returns:
 *   - `null`           → proceed (off; shadow always; enforce-allow)
 *   - `NextResponse`   → a 403 the handler should `return` immediately
 *                        (enforce-deny, or enforce fail-closed on PDP error)
 *
 * `opts.legacyAllowed` lets a shadow caller record whether the route's EXISTING
 * authorization would have allowed the request, so the audit row can flag PDP
 * divergence from today's behavior (used to vet enforcement before flipping it
 * on). It has NO effect on the return value.
 */
export async function pdpCheck(
  session: SessionPayload,
  resource: ResourceRef,
  action: Action,
  opts?: { legacyAllowed?: boolean },
): Promise<NextResponse | null> {
  const mode = pdpEnforceMode();

  // OFF — purely additive: bail before any PDP/Cosmos cost.
  if (mode === 'off') return null;

  const principal = principalFromSession(session);

  if (mode === 'shadow') {
    // SHADOW must NEVER block and NEVER throw. Real authorize() + real audit
    // write, but any failure is logged and swallowed.
    try {
      const decision = await authorize(principal, resource, action);
      await writeShadowAudit(principal, resource, action, decision, opts?.legacyAllowed);
    } catch (e) {
      console.error('[pdp:shadow] non-fatal authorize/audit error', e);
    }
    return null;
  }

  // ENFORCE — the only mode that can block.
  try {
    const decision = await authorize(principal, resource, action);
    if (decision.effect === 'deny') {
      return NextResponse.json(
        { ok: false, error: 'forbidden', reason: decision.reason },
        { status: 403 },
      );
    }
    return null;
  } catch (e) {
    // Fail-CLOSED: an operator turned enforcement ON; a broken PDP must not
    // silently allow. Log the underlying error and deny.
    console.error('[pdp:enforce] authorize error — failing closed', e);
    return NextResponse.json(
      { ok: false, error: 'forbidden', reason: 'authorization unavailable' },
      { status: 403 },
    );
  }
}
