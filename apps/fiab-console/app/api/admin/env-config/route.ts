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
import { envConfigContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  updateContainerAppEnv,
  readAcaConfig,
  AcaNotConfiguredError,
} from '@/lib/azure/container-apps-arm-client';
import {
  updateAksDeploymentEnv,
  readAksConfig,
  AksNotConfiguredError,
  AksError,
} from '@/lib/azure/aks-arm-client';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  EDITABLE_ENV,
  isEditableEnvKey,
  getEditableEnv,
  maskValue,
  buildSyncArtifacts,
  aliasSatisfiedKeys,
} from '@/lib/admin/env-config';
import { CTX } from '@/lib/admin/self-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CAP = 'admin.env-config';

interface EnvConfigDoc {
  id: string;        // == tenantId
  tenantId: string;  // partition key
  /** Desired NON-SECRET env values set from the UI. */
  values: Record<string, string>;
  /** Secret-typed keys that have been set (no value stored — lives in ACA). */
  secretsSet: Record<string, { at: string; by: string }>;
  updatedAt: string;
  updatedBy: string;
}



function appName(): string {
  return process.env.LOOM_CONSOLE_APP_NAME || 'loom-console';
}

/**
 * True when this boundary runs the Console on AKS (GCC-High / IL5 / DoD) rather
 * than Container Apps. On AKS the env-write path is `updateAksDeploymentEnv`
 * (Run Command → kubectl set env) instead of the ACA ARM PATCH. Mirrors the
 * container-apps-arm-client platform check so Save never hits a non-existent
 * container app on a sovereign boundary.
 */
function isAksPlatform(): boolean {
  return (
    (process.env.LOOM_CONTAINER_PLATFORM || '').toLowerCase() === 'aks' ||
    !!process.env.LOOM_AKS_CLUSTER_NAME
  );
}

async function loadDoc(tenantId: string): Promise<EnvConfigDoc | null> {
  const c = await envConfigContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<EnvConfigDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

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
  const platform: 'aca' | 'aks' = isAksPlatform() ? 'aks' : 'aca';
  let writeConfigured = true;
  let writeError: string | undefined;
  if (platform === 'aks') {
    try { readAksConfig(); } catch (e: any) {
      writeConfigured = false;
      writeError = e instanceof AksNotConfiguredError
        ? `AKS write path not configured. Missing: ${e.missing.join(', ')}. Set them on loom-console (container-platform.bicep wires the AKS path), then redeploy.`
        : (e?.message || String(e));
    }
  } else {
    try { readAcaConfig(); } catch (e: any) {
      writeConfigured = false;
      writeError = e instanceof AcaNotConfiguredError
        ? `Container Apps write path not configured. Missing: ${e.missing.join(', ')}. Set them in admin-plane/main.bicep apps[] env, then redeploy.`
        : (e?.message || String(e));
    }
  }
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
  const current: Record<string, { set: boolean; status: 'set' | 'derived' | 'satisfied' | 'unset'; satisfiedByAlias?: boolean; value?: string; secret: boolean }> = {};
  for (const e of EDITABLE_ENV) {
    const raw = (process.env[e.key] || '').trim();
    const set = raw.length > 0;
    const satisfiedByAlias = !set && satisfiedKeys.has(e.key);
    const status: 'set' | 'derived' | 'satisfied' | 'unset' = set
      ? 'set'
      : satisfiedByAlias
        ? 'satisfied'
        : (e.derived ? 'derived' : 'unset');
    current[e.key] = e.secret
      ? { set, status, satisfiedByAlias: satisfiedByAlias || undefined, secret: true }
      : { set, status, satisfiedByAlias: satisfiedByAlias || undefined, value: raw, secret: false };
  }

  let desired: EnvConfigDoc | null = null;
  let cosmosError: string | undefined;
  try { desired = await loadDoc(tenantId); } catch (e: any) { cosmosError = e?.message || String(e); }

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
  // PDP gate (default-off no-op): tenant-admin env-config write is a domain-level
  // admin action. Additive — with LOOM_PDP_ENFORCE unset this returns null.
  const blocked = await pdpCheck(session!, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;
  const who = session!.claims.upn || session!.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const incoming = body?.values;
  if (!incoming || typeof incoming !== 'object') {
    return apiError('values (object of key→value) required', 400);
  }

  // Whitelist + delta computation. Plain keys are diffed against the running
  // env value; secret keys are applied whenever a non-empty value is supplied
  // (we can't read the current secret value to diff).
  const plainChanges: Record<string, string> = {};
  const secretChanges: Record<string, string> = {};
  const cloud = detectLoomCloud();
  const rejected: string[] = [];
  for (const [k, raw] of Object.entries(incoming as Record<string, unknown>)) {
    if (!isEditableEnvKey(k)) continue;                 // no-freeform-config: drop unknown keys
    const spec = getEditableEnv(k)!;
    const v = typeof raw === 'string' ? raw : '';
    if (!v.trim()) continue;                            // empty = no-op (use the CLI to unset)
    if (spec.il5Restricted && (cloud === 'GCC-High' || cloud === 'DoD')) {
      rejected.push(`${k} (restricted in ${cloud})`);
      continue;
    }
    if (spec.secret) {
      secretChanges[k] = v;
    } else if ((process.env[k] || '').trim() !== v.trim()) {
      plainChanges[k] = v.trim();
    }
  }

  const changedCount = Object.keys(plainChanges).length + Object.keys(secretChanges).length;
  if (changedCount === 0) {
    return NextResponse.json({ ok: true, changedCount: 0, rejected, message: 'No changes to apply.' });
  }

  // Apply the change against the active container platform. Commercial / GCC
  // run Container Apps (ARM PATCH → new revision). GCC-High / IL5 / DoD run the
  // Console on AKS, where there is NO container app to PATCH — apply via AKS Run
  // Command (kubectl set env → rolling update) instead. Branching here is what
  // keeps Save honest on sovereign boundaries rather than 404-ing against a
  // non-existent Microsoft.App/containerApps/loom-console.
  const onAks = isAksPlatform();
  let revision = 'Updating';
  try {
    if (onAks) {
      const res = await updateAksDeploymentEnv(plainChanges, { secrets: secretChanges });
      revision = res.provisioningState;
    } else {
      const res = await updateContainerAppEnv(appName(), plainChanges, { secrets: secretChanges });
      revision = res.provisioningState;
    }
  } catch (e: any) {
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        error: `Container Apps write path not configured: ${e.message}. Set LOOM_SUBSCRIPTION_ID + LOOM_ACA_RG (or LOOM_ADMIN_RG) on loom-console, then redeploy.`,
      }, { status: 503 });
    }
    if (e instanceof AksNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        error: `AKS write path not configured: ${e.message}. Set LOOM_SUBSCRIPTION_ID + LOOM_AKS_CLUSTER_NAME + LOOM_AKS_RG (or LOOM_ADMIN_RG) on loom-console, then redeploy.`,
      }, { status: 503 });
    }
    if (e instanceof AksError) {
      return NextResponse.json({ ok: false, error: e.message, body: e.body }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status: e?.status || 502 });
  }

  // Persist desired state (durable). Secrets recorded as a set-flag only — the
  // value lives in the ACA secret, never in Cosmos.
  const now = new Date().toISOString();
  try {
    const c = await envConfigContainer();
    const existing = await loadDoc(tenantId);
    const doc: EnvConfigDoc = existing ?? {
      id: tenantId, tenantId, values: {}, secretsSet: {}, updatedAt: now, updatedBy: who,
    };
    doc.values = { ...(doc.values || {}), ...plainChanges };
    doc.secretsSet = { ...(doc.secretsSet || {}) };
    for (const k of Object.keys(secretChanges)) doc.secretsSet[k] = { at: now, by: who };
    doc.updatedAt = now;
    doc.updatedBy = who;
    await c.items.upsert(doc);
  } catch { /* persistence failure is non-fatal — the ARM revision already rolled */ }

  // Audit — one entry per changed key (secret values redacted).
  try {
    const audit = await auditLogContainer();
    const mkId = () => `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entries = [
      ...Object.entries(plainChanges).map(([key, v]) => ({ key, to: maskValue(key, v) })),
      ...Object.keys(secretChanges).map((key) => ({ key, to: '***' })),
    ];
    for (const e of entries) {
      await audit.items.create({
        id: mkId(), itemId: `env-config:${tenantId}`, tenantId, who, at: now,
        kind: 'env-config.set', key: e.key, to: e.to,
        platform: onAks ? 'aks' : 'aca',
      }).catch(() => {});
    }
  } catch { /* audit failures are non-blocking */ }

  const { cliScript, bicepEnvSnippet } = buildSyncArtifacts(plainChanges, Object.keys(secretChanges));

  return NextResponse.json({
    ok: true,
    changedCount,
    changed: Object.keys(plainChanges),
    secretsChanged: Object.keys(secretChanges),
    rejected,
    revision,
    platform: onAks ? 'aks' : 'aca',
    updatedAt: now,
    // Drift is now expected until the rollout lands AND IaC is updated.
    driftWarning: onAks
      ? 'A new pod rollout is in progress on the AKS Console Deployment (kubectl rolling update). This UI change is durable in the Loom store, but the next GitOps sync / `az deployment` of admin-plane/app-deployments.bicep will REVERT it unless you fold the change into the loom-console Deployment manifest env — use the snippet below.'
      : 'A new container-app revision is rolling out (~1–2 min). This UI change is durable in the Loom store, but the next `az deployment` of admin-plane/main.bicep will REVERT it unless you fold the change into the loom-console env array — use the bicep snippet below.',
    sync: { cliScript, bicepEnvSnippet },
  });
}
