/**
 * Jupyter Server contents proxy for the AML Compute-Instance notebook backend.
 * Keyed by the Cosmos notebook item `id` so the editor shares one surface across
 * backends. Reads/writes `.ipynb` files on the workspace file share through the
 * AML CI authenticated tunnel (listNotebookAccessToken → Jupyter /api/contents).
 *
 *   GET  /api/notebook/[id]/contents?path=Users/<u>/<nb>.ipynb[&content=0]
 *     → { ok, model: JupyterContentsModel }   (the parsed notebook model)
 *
 *   PUT  /api/notebook/[id]/contents
 *     body { path: string, content: <ipynb JSON>, type?: 'notebook'|'file' }
 *     → { ok, model }   (upserts the file, returns the saved model metadata)
 *
 * rel-T19 — per-user scoping. `[id]` is authoritative: it must resolve to a
 * `notebook` item the caller owns OR can reach via a shared-workspace ACL
 * (rel-T11), and the requested `path` is bound to that notebook's own file
 * scope. A stranger gets a 404 (GET) / 404 (PUT) instead of another user's file;
 * a path outside the notebook's scope is a 403. See `_lib/notebook-access.ts`.
 *
 * Azure-native, no Fabric/OneLake dependency. Honest 503 gate when the AML
 * workspace isn't configured (LOOM_AML_WORKSPACE / LOOM_SUBSCRIPTION_ID). 401
 * when unauthenticated. Real Jupyter Server REST — no mocks.
 *
 * Learn: https://learn.microsoft.com/rest/api/azureml/workspaces/list-notebook-access-token
 *        https://jupyter-server.readthedocs.io/en/latest/developers/rest-api.html
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  isJupyterCiConfigured,
  jupyterCiConfig,
  getNotebookToken,
  contentsGet,
  contentsPut,
  JupyterNotConfiguredError,
} from '@/lib/clients/jupyter-server-client';
import { loadAccessibleNotebook, scopeNotebookPath } from '../../_lib/notebook-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function notConfigured(): NextResponse {
  let missing: string[] = ['LOOM_AML_WORKSPACE', 'LOOM_SUBSCRIPTION_ID'];
  try { jupyterCiConfig(); } catch (e) {
    if (e instanceof JupyterNotConfiguredError) missing = e.missing;
  }
  return NextResponse.json(
    {
      ok: false,
      code: 'not_configured',
      error: `Azure ML Compute-Instance Jupyter backend not configured: set ${missing.join(' + ')}.`,
      missing,
    },
    { status: 503 },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isJupyterCiConfigured()) return notConfigured();

  const { id } = await ctx.params;
  const rawPath = req.nextUrl.searchParams.get('path')?.trim() || '';
  if (!rawPath) return NextResponse.json({ ok: false, error: 'path query param is required' }, { status: 400 });
  const wantContent = req.nextUrl.searchParams.get('content') !== '0';

  // rel-T19 — authorize against the notebook item (read role ok), then bind the
  // requested path to that notebook's scope so it can't reach a foreign file.
  const item = await loadAccessibleNotebook(id, session.claims.oid, { write: false });
  if (!item) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
  const scoped = scopeNotebookPath(item, session.claims.oid, rawPath);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });

  try {
    const token = await getNotebookToken();
    const model = await contentsGet(token, scoped.path, { content: wantContent });
    return NextResponse.json({ ok: true, model });
  } catch (e: any) {
    const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isJupyterCiConfigured()) return notConfigured();

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const rawPath: string = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!rawPath) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (body?.content === undefined || body?.content === null) {
    return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
  }
  const type: 'notebook' | 'file' = body?.type === 'file' ? 'file' : 'notebook';

  // rel-T19 — writing requires write-capable access to the notebook item, and
  // the target path must fall inside the notebook's own scope.
  const item = await loadAccessibleNotebook(id, session.claims.oid, { write: true });
  if (!item) return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
  const scoped = scopeNotebookPath(item, session.claims.oid, rawPath);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });

  try {
    const token = await getNotebookToken();
    const model = await contentsPut(token, scoped.path, body.content, type);
    return NextResponse.json({ ok: true, model });
  } catch (e: any) {
    const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
