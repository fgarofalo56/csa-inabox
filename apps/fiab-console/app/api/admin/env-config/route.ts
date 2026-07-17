/**
 * GET  /api/admin/env-config — the editable runtime-config (env-var) registry
 *   + the current presence/values for each key + ACA write availability +
 *   the Cosmos-persisted desired state (for drift) + the active cloud boundary.
 *   Secret-typed keys report `{ set: boolean }` only — their VALUE is never
 *   returned (no-vaporware / security).
 *
 * PUT  /api/admin/env-config — body: { values: Record<string,string> }
 *   Validates every key against the EDITABLE_ENV whitelist (unknown keys are
 *   dropped — no-freeform-config), computes deltas vs the running env, applies
 *   them as a NEW ACA REVISION via updateContainerAppEnv (real ARM PATCH),
 *   persists the desired values to the `env-config` Cosmos container (durable),
 *   and writes one audit-log entry per changed key (kind 'env-config.set',
 *   secret values redacted). Returns the reconciliation artifacts (CLI + bicep
 *   snippet) so the change can be folded into IaC.
 *
 * Gated to tenant admins (enforceCapability 'admin.env-config', Admin) — the
 * tenant-bootstrap admin (LOOM_TENANT_ADMIN_OID / _GROUP_ID) bypasses, so the
 * first admin can configure out of an empty state.
 *
 * No mocks — real ARM + real Cosmos + real audit trail (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  EDITABLE_ENV,
  isEditableEnvKey,
  getEditableEnv,
  aliasSatisfiedKeys,
} from '@/lib/admin/env-config';
import {
  applyEnvChanges,
  envWriteAvailability,
  loadEnvConfigDoc,
} from '@/lib/admin/env-apply';
import { CTX } from '@/lib/admin/self-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CAP = 'admin.env-config';

export async function GET() {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  const tenantId = session!.claims.oid;

  // Write availability — depends on the container platform of THIS boundary.
  // Commercial / GCC run Container Apps (ARM PATCH). GCC-High / IL5 / DoD run
  // AKS (Run Command → kubectl set env). We report the active platform + an
  // honest gate naming the exact env it needs, so the pane never offers a Save
  // that would fail against a non-existent resource (no-vaporware).
  const { platform, writeConfigured, writeError } = envWriteAvailability();
  // Back-compat fields (the pane historically read acaConfigured/acaError).
  const acaConfigured = writeConfigured;
  const acaError = writeError;

  // Current presence/values from the running container's env (this BFF runs in
  // loom-console, so process.env IS the live deployment config). Secret values
  // are NEVER returned — only their set/unset flag. `status` is an honest signal:
  // 'set' (present), 'derived' (bicep auto-fills it from another resource on
  // deploy — expected, not an operator action), 'satisfied' (this key is unset
  // but an `anyOf` sibling/alias IS set, e.g. GROUP_ID unset while OID is set, so
  // the either/or requirement is met — NOT a critical gap), or 'unset'.
  const isSet = (key: string) => ((process.env[key] || '').trim().length > 0);
  const satisfiedKeys = aliasSatisfiedKeys(isSet);
  const current: Record<string, { set: boolean; status: 'set' | 'derived' | 'satisfied' | 'default' | 'unset'; satisfiedByAlias?: boolean; value?: string; secret: boolean }> = {};
  for (const e of EDITABLE_ENV) {
    const raw = (process.env[e.key] || '').trim();
    const set = raw.length > 0;
    const satisfiedByAlias = !set && satisfiedKeys.has(e.key);
    // 'default' — an optional silent-fallback substrate (H-band) whose UNSET
    // state is the fully-functional intended default. Counted as configured (the
    // feature is ON via the built-in fallback), not a gap (loom_default_on_opt_out).
    const status: 'set' | 'derived' | 'satisfied' | 'default' | 'unset' = set
      ? 'set'
      : satisfiedByAlias
        ? 'satisfied'
        : e.optionalDefault
          ? 'default'
          : (e.derived ? 'derived' : 'unset');
    current[e.key] = e.secret
      ? { set, status, satisfiedByAlias: satisfiedByAlias || undefined, secret: true }
      : { set, status, satisfiedByAlias: satisfiedByAlias || undefined, value: raw, secret: false };
  }

  let desired: Awaited<ReturnType<typeof loadEnvConfigDoc>> = null;
  let cosmosError: string | undefined;
  try { desired = await loadEnvConfigDoc(tenantId); } catch (e: any) { cosmosError = e?.message || String(e); }

  // Drift: a Cosmos-persisted desired value differs from the running env value
  // (e.g. a UI change whose revision hasn't rolled yet, OR a redeploy that
  // reverted it because bicep wasn't updated). Plain keys only.
  const drift: Array<{ key: string; desired: string; current: string }> = [];
  if (desired?.values) {
    for (const [k, v] of Object.entries(desired.values)) {
      if (!isEditableEnvKey(k) || getEditableEnv(k)?.secret) continue;
      const cur = (process.env[k] || '').trim();
      if (cur !== v) drift.push({ key: k, desired: v, current: cur });
    }
  }

  return NextResponse.json({
    ok: true,
    editable: EDITABLE_ENV,
    current,
    acaConfigured,
    acaError,
    platform,
    writeConfigured,
    writeError,
    cosmosError,
    desired: desired
      ? {
          values: desired.values || {},
          secretsSet: Object.keys(desired.secretsSet || {}),
          updatedAt: desired.updatedAt,
          updatedBy: desired.updatedBy,
        }
      : null,
    drift,
    cloud: detectLoomCloud(),
    app: CTX.app,
    adminRg: CTX.adminRg,
  });
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Admin');
  if (gate) return gate;
  const tenantId = session!.claims.oid;
  // PDP gate (default-shadow): tenant-admin env-config write is a domain-level
  // admin action. Additive — unset LOOM_PDP_ENFORCE evaluates + logs but returns
  // null (never blocks); only LOOM_PDP_ENFORCE=enforce can block.
  const blocked = await pdpCheck(session!, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;
  const who = session!.claims.upn || session!.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const incoming = body?.values;
  if (!incoming || typeof incoming !== 'object') {
    return apiError('values (object of key→value) required', 400);
  }

  // Apply through the shared runtime-config engine (lib/admin/env-apply.ts) —
  // the SAME write path the gate Fix-it wizard and the Copilot resolve tool
  // use: whitelist → platform write (ACA revision / AKS rolling update) →
  // Cosmos desired-state → audit + SIEM → IaC reconcile artifacts.
  const result = await applyEnvChanges({
    tenantId,
    tid: session!.claims.tid,
    who,
    actorOid: session!.claims.oid,
    values: incoming as Record<string, unknown>,
    action: 'env-config.update',
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, body: result.errorBody },
      { status: result.status },
    );
  }
  if (result.changedCount === 0) {
    return NextResponse.json({ ok: true, changedCount: 0, rejected: result.rejected, message: result.message });
  }
  return NextResponse.json({
    ok: true,
    changedCount: result.changedCount,
    changed: result.changed,
    secretsChanged: result.secretsChanged,
    rejected: result.rejected,
    revision: result.revision,
    platform: result.platform,
    updatedAt: result.updatedAt,
    driftWarning: result.driftWarning,
    sync: result.sync,
  });
}
