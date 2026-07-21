/**
 * POST /api/items/workshop-app/[id]/eject — "Open as code" (APP-W3 visual→code).
 *
 * Ejects the Workshop canvas into a REAL, linked loom-app-runtime item:
 * generateWorkshopCodeApp turns the persisted widgets/variables into a Node/
 * Express source tree (static canvas + /run-action proxy that authenticates to
 * this console with a scoped API token), seeded into the new item's
 * state.appRuntime.userFiles — the existing Build → Deploy path ships it to
 * Azure Container Apps unchanged. Back-links land on BOTH items (codeAppItemId
 * on the workshop app; sourceWorkshopAppId on the runtime item).
 *
 * Idempotent-ish: a second eject while codeAppItemId still resolves returns
 * 409 with the existing item (re-eject after deleting the code app, or use the
 * Copilot/Source tabs to iterate in code).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem, updateOwnedItem, createOwnedItem } from '../../../_lib/item-crud';
import { generateWorkshopCodeApp } from '@/lib/editors/_palantir-codegen';
import type { WorkshopWidget, WorkshopVariable, WorkshopPage } from '@/lib/editors/workshop/_workshop-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'workshop-app';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the workshop app first', 400, { code: 'no_id' });

  try {
    const app = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!app) return apiError('workshop app not found', 404, { code: 'not_found' });
    const state = (app.state || {}) as Record<string, unknown>;

    // A live back-link means the code twin already exists — surface it.
    const existingId = String(state.codeAppItemId || '');
    if (existingId) {
      const existing = await loadOwnedItem(existingId, 'loom-app-runtime', session.claims.oid);
      if (existing) {
        return apiError('This Workshop app already has a code twin.', 409, {
          code: 'conflict',
          itemId: existingId,
        });
      }
    }

    const widgets = (Array.isArray(state.widgets) ? state.widgets : []) as WorkshopWidget[];
    const variables = (Array.isArray(state.variables) ? state.variables : []) as WorkshopVariable[];
    const pages = (Array.isArray(state.pages) ? state.pages : []) as WorkshopPage[];
    if (widgets.length === 0) {
      return apiError('Add at least one widget to the canvas before ejecting to code.', 400, { code: 'empty_canvas' });
    }

    const userFiles = generateWorkshopCodeApp({
      displayName: app.displayName,
      workshopAppId: id,
      widgets,
      variables,
      pages,
    });

    // Pre-seed the console base URL binding (real value — rule #70); the API
    // token stays a user-supplied Key Vault secretRef (never a plain value).
    const publicBase = (process.env.LOOM_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || req.nextUrl.origin;

    const created = await createOwnedItem(session, 'loom-app-runtime', {
      workspaceId: app.workspaceId,
      displayName: `${app.displayName} (code)`,
      description: `Ejected from the Workshop app "${app.displayName}" — visual canvas as editable source.`,
      state: {
        appRuntime: {
          templateId: 'node-express',
          port: 3000,
          userFiles,
          env: [{ name: 'LOOM_CONSOLE_URL', value: publicBase }],
          sourceWorkshopAppId: id,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    if (!created.ok) return apiError(created.error, created.status);

    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, codeAppItemId: created.item.id },
    });

    return apiOk({
      itemId: created.item.id,
      files: Object.keys(userFiles),
      note:
        'Code twin created. Build + Deploy it from the item; then wire LOOM_API_TOKEN ' +
        '(a scoped API token from Profile → API tokens, stored as a Key Vault secretRef binding) ' +
        'so the deployed app can read live data through /run-action.',
    });
  } catch (e) {
    return apiServerError(e, 'failed to eject the workshop app to code');
  }
}
