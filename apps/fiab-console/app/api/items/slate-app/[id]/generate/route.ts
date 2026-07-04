/**
 * POST /api/items/slate-app/[id]/generate
 *   body: { apiBaseUrl?, widgets?: [{id,title,kind,query}] } (else read from state)
 *   → { ok, files: [{name, content}] }
 * Generates a deployable Azure Static Web Apps bundle from the persisted widget
 * spec. Deterministic real output. Azure-native — no Fabric required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { generateSlateBundle, type SlateWidget } from '@/lib/editors/_palantir-codegen';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const ITEM_TYPE = 'slate-app';
function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the app first (no id yet)', 400, 'no_id');
  const app = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!app) return err('slate-app not found', 404, 'not_found');
  const body = await req.json().catch(() => ({} as any));
  const state = (app.state || {}) as Record<string, unknown>;
  const widgetsRaw = Array.isArray(body?.widgets) ? body.widgets
    : Array.isArray(state.widgets) ? (state.widgets as unknown[]) : [];
  const widgets: SlateWidget[] = widgetsRaw
    .map((w: any) => ({
      id: String(w?.id || w?.title || ''),
      title: String(w?.title || 'Widget'),
      kind: (w?.kind === 'chart' || w?.kind === 'metric') ? w.kind : 'table',
      query: String(w?.query || ''),
    }))
    .filter((w: SlateWidget) => w.query);
  if (widgets.length === 0) return err('add at least one widget with a query before generating', 400, 'no_widgets');
  const apiBaseUrl = String(body?.apiBaseUrl || state.apiBaseUrl || '/api');

  const files = generateSlateBundle({ displayName: app.displayName, apiBaseUrl, widgets });
  const nextState = { ...state, apiBaseUrl, widgets, lastGeneratedAt: new Date().toISOString() };
  await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: nextState });
  return NextResponse.json({ ok: true, files });
}
