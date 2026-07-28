/**
 * N19a — POST/GET /api/items/notebook/[id]/deploy-app
 *
 * "Deploy as app": publish a notebook as a runnable Loom app for consumers who
 * should run it (and read its results) without opening the notebook editor.
 *
 * REUSES the existing org-app path end to end — it does NOT fork a second
 * publish mechanism:
 *   • the app is a real `loom-app` item created through `createOwnedItem`,
 *   • its definition is the same `LoomAppDefinition` the loom-app editor edits,
 *   • the publish precondition + version stamping come from the SHARED helpers
 *     in lib/editors/loom-app-model.ts (`publishBlocker` / `stampPublish` /
 *     `stampUnpublish`), which the loom-app publish route also calls,
 *   • the consumer surface is the existing /apps/view/<id> renderer.
 * Re-deploying an already-deployed notebook updates that same app in place
 * (version + 1), so there is exactly one app per notebook deployment.
 *
 * GET returns the notebook's current deployment (if any) so the editor can
 * render "Deployed · v3 · Open app" instead of guessing.
 *
 * Real Cosmos reads/writes only — no mocks, no Fabric / Power BI workspace on
 * any path (.claude/rules/no-vaporware.md, no-fabric-dependency.md).
 * FLAG0 (`n19a-reactive-notebook`, default-ON): OFF returns a guided 503.
 */
import type { NextRequest } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { createOwnedItem, loadOwnedItem, listOwnedItems, updateOwnedItem } from '../../../_lib/item-crud';
import {
  coerceDefinition, stampPublish, stampUnpublish, publishBlocker, appConsumerUrl,
  upsertContentEntry, EMPTY_LOOM_APP,
  type LoomAppDefinition,
} from '@/lib/editors/loom-app-model';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FLAG_ID = 'n19a-reactive-notebook';
const APP_TYPE = 'loom-app';
const NOTEBOOK_TYPE = 'notebook';

/** Marker on the app's state linking it back to the notebook it was deployed from. */
const SOURCE_KEY = 'deployedFromNotebookId';

interface DeployBody {
  /** Existing app to update; omitted on the first deploy. */
  appId?: string;
  /** App display name (defaults to "<notebook> app"). */
  displayName?: string;
  description?: string;
  /** Access list (user emails / UPNs / oids / group ids). Empty = whole workspace. */
  principals?: string[];
  /** Retract the deployment instead of publishing. */
  unpublish?: boolean;
}

/** The loom-app previously deployed from this notebook, if it still exists. */
async function findDeployedApp(
  notebookId: string,
  workspaceId: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  const apps = await listOwnedItems(APP_TYPE, tenantId, { workspaceId });
  const hit = apps.find((a) => {
    const st = (a.state || {}) as Record<string, unknown>;
    if (st[SOURCE_KEY] === notebookId) return true;
    const def = coerceDefinition(st);
    return def.content.some((c) => c.itemId === notebookId);
  });
  return hit || null;
}

function deploymentReceipt(app: WorkspaceItem) {
  const def = coerceDefinition(app.state);
  return {
    appId: app.id,
    displayName: app.displayName,
    published: !!def.published,
    version: def.version || 0,
    publishedAt: def.publishedAt || null,
    url: appConsumerUrl(app.id),
    audiences: def.audiences.map((a) => ({ name: a.name, principals: a.principals.length })),
  };
}

export const GET = withWorkspaceOwner(NOTEBOOK_TYPE, { allowReadRoles: true }, async (_req: NextRequest, { session, item }) => {
  try {
    const app = await findDeployedApp(item.id, item.workspaceId, session.claims.oid);
    return apiOk({ deployed: !!app, deployment: app ? deploymentReceipt(app) : null });
  } catch (e) {
    return apiServerError(e);
  }
});

export const POST = withWorkspaceOwner(NOTEBOOK_TYPE, async (req: NextRequest, { session, item }) => {
  if (!(await runtimeFlag(FLAG_ID, { default: true }))) {
    return apiError(
      'Deploy-as-app is turned off (Admin → Runtime flags → n19a-reactive-notebook). The notebook itself is unaffected.',
      503, { code: 'reactive_notebook_off' },
    );
  }
  const body = (await req.json().catch(() => ({}))) as DeployBody;
  const tenantId = session.claims.oid;

  try {
    const existing = body.appId
      ? await loadOwnedItem(body.appId, APP_TYPE, tenantId)
      : await findDeployedApp(item.id, item.workspaceId, tenantId);

    // ---- Retract -----------------------------------------------------------
    if (body.unpublish) {
      if (!existing) return apiError('This notebook is not deployed as an app.', 404);
      const next = stampUnpublish(coerceDefinition(existing.state));
      await updateOwnedItem(existing.id, APP_TYPE, tenantId, {
        state: { ...next, [SOURCE_KEY]: item.id },
      });
      return apiOk({ published: false, appId: existing.id, url: appConsumerUrl(existing.id) });
    }

    // ---- Build the definition (create-or-update, never duplicate) ----------
    const base: LoomAppDefinition = existing ? coerceDefinition(existing.state) : { ...EMPTY_LOOM_APP };
    let def = upsertContentEntry(base, {
      itemId: item.id,
      itemType: NOTEBOOK_TYPE,
      displayName: item.displayName,
    });
    if (body.description !== undefined) def = { ...def, description: String(body.description).slice(0, 2000) };

    const principals = (body.principals || []).map((p) => String(p).trim()).filter(Boolean);
    if (principals.length > 0) {
      // One managed audience per deployment; re-deploying replaces its list so
      // the UI's access field is authoritative.
      const others = def.audiences.filter((a) => a.name !== 'Notebook app viewers');
      def = {
        ...def,
        audiences: [...others, { id: `aud-notebook-${item.id}`, name: 'Notebook app viewers', principals }],
      };
    }

    const blocker = publishBlocker(def);
    if (blocker) return apiError(blocker, 400);

    const stamped = stampPublish(def);
    const state = { ...stamped.def, [SOURCE_KEY]: item.id } as Record<string, unknown>;

    let appId: string;
    let appName: string;
    if (existing) {
      const updated = await updateOwnedItem(existing.id, APP_TYPE, tenantId, { state });
      if (!updated) return apiError('the app this notebook was deployed to no longer exists', 404);
      appId = updated.id;
      appName = updated.displayName;
    } else {
      const created = await createOwnedItem(session, APP_TYPE, {
        workspaceId: item.workspaceId,
        displayName: (body.displayName || `${item.displayName} app`).slice(0, 200),
        description: body.description || `Runnable app deployed from the ${item.displayName} notebook.`,
        state,
      });
      if (!created.ok) return apiError(created.error, created.status);
      appId = created.item.id;
      appName = created.item.displayName;
    }

    const url = appConsumerUrl(appId);
    try {
      // eslint-disable-next-line no-console
      console.info(`[notebook/deploy-app.POST] receipt: notebook=${item.id} app=${appId} version=${stamped.version} url=${url}`);
    } catch { /* noop */ }
    return apiOk({
      published: true, appId, displayName: appName,
      version: stamped.version, publishedAt: stamped.publishedAt, url,
    });
  } catch (e) {
    return apiServerError(e);
  }
});
