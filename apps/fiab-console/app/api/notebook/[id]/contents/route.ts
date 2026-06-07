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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isJupyterCiConfigured()) return notConfigured();

  const path = req.nextUrl.searchParams.get('path')?.trim() || '';
  if (!path) return NextResponse.json({ ok: false, error: 'path query param is required' }, { status: 400 });
  const wantContent = req.nextUrl.searchParams.get('content') !== '0';

  try {
    const token = await getNotebookToken();
    const model = await contentsGet(token, path, { content: wantContent });
    return NextResponse.json({ ok: true, model });
  } catch (e: any) {
    const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isJupyterCiConfigured()) return notConfigured();

  const body = await req.json().catch(() => ({}));
  const path: string = typeof body?.path === 'string' ? body.path.trim() : '';
  if (!path) return NextResponse.json({ ok: false, error: 'path is required' }, { status: 400 });
  if (body?.content === undefined || body?.content === null) {
    return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
  }
  const type: 'notebook' | 'file' = body?.type === 'file' ? 'file' : 'notebook';

  try {
    const token = await getNotebookToken();
    const model = await contentsPut(token, path, body.content, type);
    return NextResponse.json({ ok: true, model });
  } catch (e: any) {
    const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
