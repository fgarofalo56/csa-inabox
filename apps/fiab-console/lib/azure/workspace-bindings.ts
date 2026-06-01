/**
 * workspace-bindings — best-effort post-create side-effects when a Loom
 * workspace is created with capacity + domain selected:
 *
 *   1. Capacity → Fabric assignToCapacity (queued if no bound Fabric
 *      group yet — captured as `queued` status; the first PBI-backed
 *      artifact create will do the actual assignment)
 *   2. Domain → Purview catalog register (workspace asset under the
 *      domain) + marketplace listing publish (Cosmos
 *      `marketplace-listings` container)
 *
 * Both run as best-effort — failures get captured into the workspace
 * doc's `capacityAssignment` / `domainRegistration` status fields so the
 * UI can surface them, but the workspace itself was already persisted
 * by the time these run.
 */

import type { Workspace } from '@/lib/types/workspace';
import { assignWorkspaceToCapacity, FabricError } from './fabric-client';
import { registerAtlasEntity, PurviewError, PurviewNotConfiguredError } from './purview-client';
import { marketplaceListingsContainer } from './cosmos-client';

export interface BindingResult {
  capacityAssignment?: Workspace['capacityAssignment'];
  domainRegistration?: Workspace['domainRegistration'];
}

/**
 * Run all side-effects after a workspace create. Never throws — every
 * error is captured into the returned status fields. Callers MUST
 * `replace()` the workspace document with the merged result so the UI
 * shows the right state.
 */
export async function applyWorkspaceBindings(ws: Workspace): Promise<BindingResult> {
  const out: BindingResult = {};

  // --- Capacity binding ---
  if (ws.capacity) {
    if (ws.fabricGroupId) {
      try {
        await assignWorkspaceToCapacity(ws.fabricGroupId, ws.capacity);
        out.capacityAssignment = {
          status: 'assigned',
          capacityId: ws.capacity,
          at: new Date().toISOString(),
        };
      } catch (e: any) {
        out.capacityAssignment = {
          status: 'failed',
          capacityId: ws.capacity,
          error: e instanceof FabricError
            ? `Fabric ${e.status}: ${e.message}`
            : (e?.message || String(e)),
          at: new Date().toISOString(),
        };
      }
    } else {
      // No bound Fabric/Power BI group yet — that's normal for a brand-new
      // Loom workspace. Queue the assignment for the first PBI-backed
      // artifact create. The lazy-bind logic in the PBI editors picks
      // this up.
      out.capacityAssignment = {
        status: 'queued',
        capacityId: ws.capacity,
        queuedReason:
          'No bound Fabric/Power BI group on this workspace yet. ' +
          'The first PBI-backed artifact (Report / Semantic Model / Dashboard) ' +
          "will create the Fabric group and assign it to the chosen capacity.",
        at: new Date().toISOString(),
      };
    }
  }

  // --- Domain → Purview register + marketplace publish ---
  if (ws.domain) {
    const purviewSucceeded = await tryRegisterInPurview(ws);
    const marketplaceListingId = await publishToMarketplace(ws, purviewSucceeded?.guid);

    if (purviewSucceeded?.guid) {
      out.domainRegistration = {
        status: 'registered',
        purviewAssetGuid: purviewSucceeded.guid,
        marketplaceListingId,
        at: new Date().toISOString(),
      };
    } else {
      out.domainRegistration = {
        status: 'failed',
        marketplaceListingId,
        error: purviewSucceeded?.error || 'Purview registration failed; marketplace listing still published.',
        at: new Date().toISOString(),
      };
    }
  }

  return out;
}

async function tryRegisterInPurview(ws: Workspace): Promise<{ guid?: string; error?: string }> {
  try {
    // CLASSIC Data Map: register the workspace as an Atlas entity. (Data
    // products are a unified-catalog-only concept and are not available on the
    // classic Data Map account — see purview-client.ts.) Atlas dedupes on the
    // qualifiedName, so re-creating a workspace with the same id is idempotent.
    const upsert = await registerAtlasEntity({
      typeName: 'fabric_workspace',
      qualifiedName: `https://app.fabric.microsoft.com/groups/${ws.id}`,
      displayName: ws.name,
      comment: ws.description || `Loom workspace ${ws.name}`,
      owner: ws.createdBy,
      attributes: {
        loomDomain: ws.domain || 'default',
        loomWorkspaceId: ws.id,
      },
    });
    return { guid: upsert.primaryGuid };
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      // Also covers PurviewUnifiedCatalogGateError (a subclass) — though
      // registerAtlasEntity is a classic Data Map call and won't gate.
      return {
        error:
          'Purview not configured (LOOM_PURVIEW_ACCOUNT env var unset). ' +
          'Workspace created; domain tag persisted; Purview registration skipped.',
      };
    }
    if (e instanceof PurviewError) {
      return { error: `Purview ${e.status || 502}: ${e.message}` };
    }
    return { error: e?.message || String(e) };
  }
}

async function publishToMarketplace(ws: Workspace, purviewGuid?: string): Promise<string | undefined> {
  try {
    const c = await marketplaceListingsContainer();
    const listing = {
      id: `ws-${ws.id}`,
      tenantId: ws.tenantId,
      workspaceId: ws.id,
      name: ws.name,
      description: ws.description,
      domain: ws.domain,
      owner: ws.createdBy,
      sensitivity: 'Internal',
      purviewAssetGuid: purviewGuid,
      publishedAt: new Date().toISOString(),
      status: 'published',
    };
    const { resource } = await c.items.upsert(listing);
    return (resource as any)?.id || listing.id;
  } catch {
    // Marketplace publish is non-critical — swallow + return undefined.
    return undefined;
  }
}
