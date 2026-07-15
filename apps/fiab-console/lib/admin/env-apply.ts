/**
 * Shared runtime-config apply engine — the ONE write path for deployment env
 * vars set from inside the console.
 *
 * Extracted from PUT /api/admin/env-config so the gate Fix-it flow
 * (POST /api/admin/gates/[id]/resolve) and the Copilot `loom_resolve_gate`
 * tool apply changes through EXACTLY the same machinery instead of growing a
 * second, drifting implementation:
 *   1. whitelist every key against EDITABLE_ENV (no-freeform-config),
 *   2. compute deltas vs the running env (secrets always apply — unreadable),
 *   3. apply as a REAL platform write — ACA ARM PATCH (new revision) on
 *      Commercial/GCC, AKS Run Command (kubectl set env) on GCC-High/IL5/DoD,
 *   4. persist desired state to the `env-config` Cosmos container (durable),
 *   5. audit-log every changed key (secret values redacted) + SIEM stream,
 *   6. return the IaC reconciliation artifacts (CLI + bicep snippet).
 *
 * No mocks — real ARM + real Cosmos + real audit trail (no-vaporware.md).
 * Callers are responsible for the capability gate (enforceCapability
 * 'admin.env-config' Admin) BEFORE calling applyEnvChanges.
 */
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
  isEditableEnvKey,
  getEditableEnv,
  maskValue,
  buildSyncArtifacts,
} from '@/lib/admin/env-config';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

export interface EnvConfigDoc {
  id: string;        // == tenantId
  tenantId: string;  // partition key
  /** Desired NON-SECRET env values set from the UI. */
  values: Record<string, string>;
  /** Secret-typed keys that have been set (no value stored — lives in ACA). */
  secretsSet: Record<string, { at: string; by: string }>;
  updatedAt: string;
  updatedBy: string;
}

export interface ApplyEnvResult {
  ok: boolean;
  status: number;
  changedCount: number;
  changed: string[];
  secretsChanged: string[];
  rejected: string[];
  revision?: string;
  platform: 'aca' | 'aks';
  updatedAt?: string;
  driftWarning?: string;
  sync?: { cliScript: string; bicepEnvSnippet: string };
  error?: string;
  message?: string;
  errorBody?: unknown;
}

export function consoleAppName(): string {
  return process.env.LOOM_CONSOLE_APP_NAME || 'loom-console';
}

/**
 * True when this boundary runs the Console on AKS (GCC-High / IL5 / DoD) rather
 * than Container Apps — the env-write path is then `updateAksDeploymentEnv`
 * (Run Command → kubectl set env) instead of the ACA ARM PATCH.
 */
export function isAksPlatform(): boolean {
  return (
    (process.env.LOOM_CONTAINER_PLATFORM || '').toLowerCase() === 'aks' ||
    !!process.env.LOOM_AKS_CLUSTER_NAME
  );
}

/** Read the env-config desired-state doc for a tenant (null when absent). */
export async function loadEnvConfigDoc(tenantId: string): Promise<EnvConfigDoc | null> {
  const c = await envConfigContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<EnvConfigDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/**
 * Whether the active platform write path is configured — used to report an
 * honest gate BEFORE offering a Save that would fail (no-vaporware).
 */
export function envWriteAvailability(): { platform: 'aca' | 'aks'; writeConfigured: boolean; writeError?: string } {
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
  return { platform, writeConfigured, writeError };
}

/**
 * Apply a set of desired env values to the running deployment. The caller MUST
 * already have passed the 'admin.env-config' Admin capability gate.
 *
 * `action` names the audit action (e.g. 'env-config.update' from the settings
 * pane, 'gate.resolve' from a Fix-it wizard / Copilot) so the SIEM trail shows
 * WHERE the write originated.
 */
export async function applyEnvChanges(opts: {
  tenantId: string;
  /** Entra tenant id (tid claim) for the SIEM event scope; falls back to tenantId. */
  tid?: string;
  who: string;
  actorOid: string;
  values: Record<string, unknown>;
  action?: string;
  /** Extra structured detail merged into the SIEM audit event (e.g. gateId). */
  auditDetail?: Record<string, unknown>;
}): Promise<ApplyEnvResult> {
  const { tenantId, who, values } = opts;
  const action = opts.action || 'env-config.update';

  // Whitelist + delta computation. Plain keys are diffed against the running
  // env value; secret keys are applied whenever a non-empty value is supplied
  // (we can't read the current secret value to diff).
  const plainChanges: Record<string, string> = {};
  const secretChanges: Record<string, string> = {};
  const cloud = detectLoomCloud();
  const rejected: string[] = [];
  for (const [k, raw] of Object.entries(values)) {
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

  const onAks = isAksPlatform();
  const platform: 'aca' | 'aks' = onAks ? 'aks' : 'aca';
  const changedCount = Object.keys(plainChanges).length + Object.keys(secretChanges).length;
  if (changedCount === 0) {
    return { ok: true, status: 200, changedCount: 0, changed: [], secretsChanged: [], rejected, platform, message: 'No changes to apply.' };
  }

  // Apply against the active container platform (real write — never faked).
  let revision = 'Updating';
  try {
    if (onAks) {
      const res = await updateAksDeploymentEnv(plainChanges, { secrets: secretChanges });
      revision = res.provisioningState;
    } else {
      const res = await updateContainerAppEnv(consoleAppName(), plainChanges, { secrets: secretChanges });
      revision = res.provisioningState;
    }
  } catch (e: any) {
    if (e instanceof AcaNotConfiguredError) {
      return {
        ok: false, status: 503, changedCount: 0, changed: [], secretsChanged: [], rejected, platform,
        error: `Container Apps write path not configured: ${e.message}. Set LOOM_SUBSCRIPTION_ID + LOOM_ACA_RG (or LOOM_ADMIN_RG) on loom-console, then redeploy.`,
      };
    }
    if (e instanceof AksNotConfiguredError) {
      return {
        ok: false, status: 503, changedCount: 0, changed: [], secretsChanged: [], rejected, platform,
        error: `AKS write path not configured: ${e.message}. Set LOOM_SUBSCRIPTION_ID + LOOM_AKS_CLUSTER_NAME + LOOM_AKS_RG (or LOOM_ADMIN_RG) on loom-console, then redeploy.`,
      };
    }
    if (e instanceof AksError) {
      return { ok: false, status: e.status || 502, changedCount: 0, changed: [], secretsChanged: [], rejected, platform, error: e.message, errorBody: e.body };
    }
    return { ok: false, status: e?.status || 502, changedCount: 0, changed: [], secretsChanged: [], rejected, platform, error: e?.message || String(e), errorBody: e?.body };
  }

  // Persist desired state (durable). Secrets recorded as a set-flag only — the
  // value lives in the ACA secret, never in Cosmos.
  const now = new Date().toISOString();
  try {
    const c = await envConfigContainer();
    const existing = await loadEnvConfigDoc(tenantId);
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
        platform,
        action,
      }).catch(() => {});
    }
  } catch { /* audit failures are non-blocking */ }

  // SIEM audit stream (BR-SIEM) — runtime env-config writes reshape the running
  // deployment; secret values are NEVER included (names only).
  emitAuditEvent({
    actorOid: opts.actorOid,
    actorUpn: who,
    action,
    targetType: 'env-config',
    targetId: `env-config:${tenantId}`,
    tenantId: opts.tid || tenantId,
    detail: {
      changed: Object.keys(plainChanges),
      secretsChanged: Object.keys(secretChanges),
      platform,
      ...(opts.auditDetail || {}),
    },
  });

  const { cliScript, bicepEnvSnippet } = buildSyncArtifacts(plainChanges, Object.keys(secretChanges));

  return {
    ok: true,
    status: 200,
    changedCount,
    changed: Object.keys(plainChanges),
    secretsChanged: Object.keys(secretChanges),
    rejected,
    revision,
    platform,
    updatedAt: now,
    // Drift is now expected until the rollout lands AND IaC is updated.
    driftWarning: onAks
      ? 'A new pod rollout is in progress on the AKS Console Deployment (kubectl rolling update). This UI change is durable in the Loom store, but the next GitOps sync / `az deployment` of admin-plane/app-deployments.bicep will REVERT it unless you fold the change into the loom-console Deployment manifest env — use the snippet below.'
      : 'A new container-app revision is rolling out (~1–2 min). This UI change is durable in the Loom store, but the next `az deployment` of admin-plane/main.bicep will REVERT it unless you fold the change into the loom-console env array — use the bicep snippet below.',
    sync: { cliScript, bicepEnvSnippet },
  };
}
