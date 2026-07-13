/**
 * attach-integration — the "attach → becomes part of Loom" auto-integration hook
 * (brownfield Phase 2, §2.4 of docs/fiab/research/brownfield-attach-design.md).
 *
 * Run right after a service is registered in the Landing-Zone Service Registry,
 * this orchestrates the four steps that make a borrowed customer resource a
 * first-class Loom citizen — each best-effort, non-blocking, and individually
 * recorded on the service doc so the LZ drawer can render an honest status per
 * step (no-vaporware.md):
 *
 *   1. RBAC       — grant the Console UAMI the navigator role at the resource
 *                   scope (`role-grant-client`); auto-grant or an honest
 *                   `grantScript` gate.
 *   2. Purview    — register the resource as a Data Map scan source (reusing the
 *                   `purview-source-map` + `registerDataSource` machinery).
 *   3. Telemetry  — PUT a diagnostic-settings profile routing the resource's logs
 *                   + metrics to the hub Log Analytics workspace.
 *   4. Chargeback — confirm the resource's subscription is in the cost sweep (the
 *                   registry sub is unioned into the sweep read-time), tag the doc.
 *
 * Nothing here throws: every failure folds into an IntegrationStepResult so the
 * attach route can persist the outcome and never fail the attach on a hook blip.
 * Cloud-invariant (`armBase()` + `uamiArmCredential()`), so it works in
 * Commercial / GCC / GCC-High / DoD.
 */
import { uamiArmCredential } from './arm-credential';
import { armBase, armScope } from './cloud-endpoints';
import { grantNavigatorRole } from './role-grant-client';
import { loomSubscriptionScope } from './loom-subscriptions';
import type { AttachedServiceKind } from './attached-service-kinds';
import type {
  AttachedServiceIntegration,
  IntegrationStepResult,
} from './attached-services-store';
import type { ConnectionType } from './connections-store';

/** Diagnostic-settings profile name — stable so bicep + console reference one. */
const DIAG_SETTING_NAME = 'loom-attached';
const DIAG_API = '2021-05-01-preview';

function now(): string {
  return new Date().toISOString();
}

/**
 * Map an AttachedServiceKind to the Loom ConnectionType the Purview source mapper
 * understands, but ONLY for the kinds whose scan source the mapper can
 * reconstruct from the resource NAME alone (no live endpoint / metastore probe).
 * ADX / Databricks need a discovered cluster URI / UC metastore id, so they are
 * registered from Catalog (honest skip here). Messaging / secret stores + admin
 * services aren't Data-Map-scannable → skipped honestly.
 */
function purviewConnType(kind: AttachedServiceKind): ConnectionType | null {
  switch (kind) {
    case 'storage-adls': return 'storage-adls';
    case 'azure-sql': return 'azure-sql';
    case 'synapse': return 'synapse-serverless';
    case 'cosmos': return 'cosmos';
    default: return null; // adx/databricks/eventhubs/purview/aml/… → skip honestly
  }
}

export interface AttachIntegrationInput {
  armResourceId: string;
  kind: AttachedServiceKind;
  displayName: string;
  subscriptionId: string;
  resourceGroup: string;
  location?: string;
  /** Console UAMI principal id (resolved by the caller when known). */
  principalId?: string | null;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Step 1 — RBAC
// ---------------------------------------------------------------------------
async function stepRbac(input: AttachIntegrationInput): Promise<IntegrationStepResult> {
  const r = await grantNavigatorRole(
    { armResourceId: input.armResourceId, kind: input.kind, principalId: input.principalId },
    input.fetchImpl || fetch,
  );
  const status =
    r.outcome === 'granted' || r.outcome === 'already-exists'
      ? 'granted'
      : r.outcome === 'pending-grants'
        ? 'pending-grants'
        : r.outcome === 'skipped'
          ? 'skipped'
          : 'error';
  return { status, detail: r.detail, grantScript: r.grantScript, checkedAt: now() };
}

// ---------------------------------------------------------------------------
// Step 2 — Purview scan-source registration
// ---------------------------------------------------------------------------
/** Purview source name for an attached service (letters/digits/-/_; ≤ 63 chars). */
function attachedSourceName(displayName: string, kind: string): string {
  const slug = (displayName || kind || 'service')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44) || 'service';
  return `loom-attach-${slug}`;
}

async function stepPurview(input: AttachIntegrationInput): Promise<IntegrationStepResult> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) {
    return {
      status: 'not-configured',
      detail:
        'Microsoft Purview is not wired (LOOM_PURVIEW_ACCOUNT unset), so no scan source was registered. ' +
        'Set LOOM_PURVIEW_ACCOUNT to auto-register attached services in the Data Map.',
      checkedAt: now(),
    };
  }
  const connType = purviewConnType(input.kind);
  if (!connType) {
    return {
      status: 'skipped',
      detail:
        `${input.kind} is not auto-registered as a Purview scan source here (Data-Explorer / Databricks ` +
        `need a discovered endpoint / metastore — register them from Catalog; messaging / admin services ` +
        `aren’t Data-Map-scannable).`,
      checkedAt: now(),
    };
  }
  try {
    const { purviewSourceForConnectable, isUnsupportedPurviewSource } = await import('./purview-source-map');
    const mapped = purviewSourceForConnectable({
      connType,
      host: input.displayName,
      resourceName: input.displayName,
      subscriptionId: input.subscriptionId,
      resourceGroup: input.resourceGroup,
      location: input.location,
    });
    if (isUnsupportedPurviewSource(mapped)) {
      return { status: 'skipped', detail: mapped.reason, checkedAt: now() };
    }
    const { registerDataSource } = await import('./purview-client');
    const sourceName = attachedSourceName(input.displayName, input.kind);
    await registerDataSource({ name: sourceName, kind: mapped.kind, properties: mapped.properties });
    return {
      status: 'registered',
      detail: `Registered as Purview scan source '${sourceName}' (${mapped.kind}).`,
      checkedAt: now(),
    };
  } catch (e: any) {
    return {
      status: 'error',
      detail: `Purview registration failed (non-fatal): ${e?.message || String(e)}`,
      checkedAt: now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Telemetry (diagnostic-settings → hub Log Analytics workspace)
// ---------------------------------------------------------------------------
async function stepTelemetry(input: AttachIntegrationInput): Promise<IntegrationStepResult> {
  const workspaceResourceId = (process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID || '').trim();
  if (!workspaceResourceId) {
    return {
      status: 'not-configured',
      detail:
        'No hub Log Analytics workspace is wired (LOOM_LOG_ANALYTICS_RESOURCE_ID unset), so diagnostic ' +
        'settings were not pushed. Set LOOM_LOG_ANALYTICS_RESOURCE_ID to route attached-service logs to the hub LAW.',
      checkedAt: now(),
    };
  }
  const scope = (input.armResourceId || '').trim();
  const url = `${armBase()}${scope}/providers/Microsoft.Insights/diagnosticSettings/${DIAG_SETTING_NAME}?api-version=${DIAG_API}`;
  const fetchImpl = input.fetchImpl || fetch;

  let token: string | undefined;
  try {
    token = (await uamiArmCredential().getToken(armScope()))?.token;
  } catch (e: any) {
    return { status: 'error', detail: `Could not acquire an ARM token: ${e?.message || String(e)}`, checkedAt: now() };
  }
  if (!token) return { status: 'error', detail: 'Could not acquire an ARM token for the Console UAMI.', checkedAt: now() };

  try {
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: {
          workspaceId: workspaceResourceId,
          logs: [{ categoryGroup: 'allLogs', enabled: true }],
          metrics: [{ category: 'AllMetrics', enabled: true }],
        },
      }),
    });
    if (res.ok) {
      return { status: 'wired', detail: 'Diagnostic settings route logs + metrics to the hub Log Analytics workspace.', checkedAt: now() };
    }
    const body: any = await res.json().catch(() => ({}));
    const code: string = body?.error?.code || body?.code || '';
    const message: string = body?.error?.message || body?.message || `HTTP ${res.status}`;
    if (res.status === 403 || /AuthorizationFailed/i.test(code)) {
      return {
        status: 'pending-grants',
        detail: 'The Console UAMI lacks Monitoring Contributor on the resource, so diagnostic settings could not be set.',
        grantScript:
          `az role assignment create --assignee-object-id ${input.principalId || '<console-uami-principal-id>'} ` +
          `--assignee-principal-type ServicePrincipal --role "Monitoring Contributor" --scope "${scope}"`,
        checkedAt: now(),
      };
    }
    // Some resource types reject allLogs/AllMetrics — an honest, non-fatal note.
    return { status: 'error', detail: `Diagnostic settings not applied: ${message}`, checkedAt: now() };
  } catch (e: any) {
    return { status: 'error', detail: `Diagnostic-settings request failed: ${e?.message || String(e)}`, checkedAt: now() };
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Chargeback inclusion
// ---------------------------------------------------------------------------
function stepChargeback(input: AttachIntegrationInput): IntegrationStepResult {
  const sub = (input.subscriptionId || '').trim();
  if (!sub) {
    return {
      status: 'skipped',
      detail: 'No subscription id on the attached resource — cannot attribute its spend.',
      checkedAt: now(),
    };
  }
  const inEnvScope = loomSubscriptionScope().includes(sub);
  return {
    status: 'included',
    detail: inEnvScope
      ? `Subscription ${sub} is already in the Loom cost sweep — its spend rolls into Chargeback.`
      : `Subscription ${sub} is now included in the cost sweep via the service registry (read-time union) — ` +
        `its spend rolls into Chargeback with no env change.`,
    checkedAt: now(),
  };
}

/**
 * Run all four auto-integration steps for one attached service. Steps run
 * sequentially (a small, bounded set); each is independent + best-effort. Returns
 * the `AttachedServiceIntegration` the caller persists via `applyIntegrationResults`.
 */
export async function runAttachIntegration(
  input: AttachIntegrationInput,
): Promise<AttachedServiceIntegration> {
  const rbac = await stepRbac(input);
  const purview = await stepPurview(input);
  const telemetry = await stepTelemetry(input);
  const chargeback = stepChargeback(input);
  return { rbac, purview, telemetry, chargeback };
}
