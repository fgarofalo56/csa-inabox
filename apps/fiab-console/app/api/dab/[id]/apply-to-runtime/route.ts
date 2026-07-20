/**
 * POST /api/dab/[id]/apply-to-runtime
 *
 * Task #19 — make the SHARED Data API Builder preview runtime carry the demo
 * entities. The runtime (LOOM_DAB_PREVIEW_URL) boots from a single base64
 * `dab-config-b64` secret → /config/dab-config.json, so per-item Cosmos configs
 * never reach it and Orders REST / Sales GraphQL preview stays empty. This route
 * MERGES every DAB item's config into one, overwrites that secret via ARM
 * (container-apps-arm-client.updateContainerAppEnv), and rolls a new revision so
 * the init container re-materialises the config and DAB boots with all entities.
 *
 * ⚠ SHARED-RESOURCE MUTATION: this reconfigures the ONE shared preview runtime
 * (last apply wins across all DAB items — that is why we merge, not replace) and
 * the revision roll BRIEFLY RESTARTS the shared preview runtime (expected). It is
 * therefore restricted to a TENANT ADMIN.
 *
 * Merge + collision rule lives in ../_lib/dab-merge (pure, unit-tested): stable
 * order by itemId, first-name-wins, duplicates SKIPPED + surfaced (never a silent
 * drop).
 *
 * 200 → { ok, entitiesApplied[], collisions[], sourceItemIds[], dabApp, revisionState }
 * 403 → caller is not a tenant admin
 * 409 → no DAB entities authored on any item yet
 * 503 → honest gate: LOOM_DAB_PREVIEW_URL unset, or ACA/ARM target unset
 *       (LOOM_SUBSCRIPTION_ID / LOOM_ACA_RG), or the DAB app name can't be resolved
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { apiOk, apiError, apiUnauthorized, apiForbidden, apiServerError } from '@/lib/api/respond';
import { listOwnedItems } from '../../../items/_lib/item-crud';
import { dabRuntimeGate, dabRuntimeTarget } from '../../_lib/dab-runtime';
import { emitDabConfigJson, type DabConfig } from '../../_lib/dab-config-model';
import { mergeDabConfigs } from '../../_lib/dab-merge';
import { updateContainerAppEnv, AcaNotConfiguredError, AcaArmError } from '@/lib/azure/container-apps-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAB_ITEM_TYPE = 'data-api-builder';

/**
 * The DAB runtime's Container App resource name. Prefer an explicit override; else
 * derive from the preview URL — a Container Apps default ingress FQDN is
 * `<app-name>.<unique>.<region>.azurecontainerapps.io`, so the first label is the
 * app name.
 */
function resolveDabAppName(baseUrl: string): string | null {
  const override = (process.env.LOOM_DAB_APP_NAME || '').trim();
  if (override) return override;
  try {
    const host = new URL(baseUrl).host;
    const first = host.split('.')[0];
    return first || null;
  } catch {
    return null;
  }
}

export async function POST(_req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  // Shared-resource guard: only a tenant admin may roll the shared preview
  // runtime (it briefly restarts for EVERY DAB user).
  if (!isTenantAdminTier(session)) {
    return apiForbidden('Only a tenant admin can apply entities to the shared DAB preview runtime (it reconfigures + restarts a shared resource).');
  }

  // Honest gate 1 — no preview runtime configured.
  const rtGate = dabRuntimeGate();
  if (rtGate) {
    return apiError(`DAB preview runtime not provisioned: set ${rtGate.missing}.`, 503, { gate: { missing: rtGate.missing } });
  }
  const target = dabRuntimeTarget()!;
  const dabApp = resolveDabAppName(target.baseUrl);
  if (!dabApp) {
    return apiError('Could not resolve the DAB Container App name — set LOOM_DAB_APP_NAME on the Console.', 503, { gate: { missing: 'LOOM_DAB_APP_NAME' } });
  }

  try {
    // Merge every DAB item's authored config into one runtime config.
    const items = await listOwnedItems(DAB_ITEM_TYPE, session.claims.oid, { session });
    const inputs = items.map((it) => ({
      itemId: it.id,
      displayName: it.displayName,
      config: (it.state as Record<string, unknown> | undefined)?.dabConfig as DabConfig | undefined,
    }));
    const merged = mergeDabConfigs(inputs);

    if (merged.entitiesApplied.length === 0) {
      return apiError('No DAB entities authored on any Data API item yet — add entities (Edit → Entities) on a Data API item, then apply.', 409, { code: 'no_entities' });
    }

    const b64 = Buffer.from(emitDabConfigJson(merged.config), 'utf-8').toString('base64');

    // ARM: overwrite the shared dab-config-b64 secret + roll a revision. The init
    // container re-materialises /config/dab-config.json from it on the new revision.
    const res = await updateContainerAppEnv(dabApp, {}, { secrets: { DAB_CONFIG_B64: b64 } });

    return apiOk({
      entitiesApplied: merged.entitiesApplied,
      collisions: merged.collisions,
      sourceItemIds: merged.sourceItemIds,
      dabApp,
      revisionState: res.provisioningState,
    });
  } catch (e) {
    if (e instanceof AcaNotConfiguredError) {
      return apiError(
        `Container Apps ARM target not configured: set ${e.missing.join(' / ')} on the Console + grant its UAMI Contributor on the DAB app.`,
        503,
        { gate: { missing: e.missing } },
      );
    }
    if (e instanceof AcaArmError) {
      // Real ARM permission / not-found — an honest, actionable gate, not a leak.
      return apiError(
        `DAB runtime reconfigure failed (${e.status}). Confirm the Console UAMI holds "ContainerApps Contributor" on the DAB app "${dabApp}".`,
        e.status && e.status >= 400 ? e.status : 502,
        { code: 'aca_arm_error' },
      );
    }
    return apiServerError(e);
  }
}
