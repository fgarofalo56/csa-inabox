/**
 * Synapse Notebook (Loom item) — Cosmos-backed detail for bundle-installed
 * notebooks.
 *
 * GET /api/items/synapse-notebook/[id]?workspaceId=...
 *   → { ok, notebook: { name, properties: { cells:[…ipynb], bigDataPool } }, source:'cosmos' }
 *
 * The Synapse Notebook editor's primary open path is the live Synapse
 * dev-plane artifact REST (/api/synapse/notebooks/<name>). This route is the
 * honest Cosmos fallback that mirrors app/api/items/notebook/[id]/route.ts:
 * it surfaces the bundle's NotebookContent cells (stamped into state.cells, or
 * stranded in state.content.cells) so a bundle-installed synapse-notebook opens
 * FULLY POPULATED with every markdown + code cell — even before/without the
 * live Synapse workspace being configured.
 *
 * The cells are returned in the IPYNB shape the editor's ipynbToCells() already
 * parses (cell_type + source array), with per-cell %%sql / %%spark / %%sparkr
 * magic prepended so the editor recovers the cell language.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

/** Map a bundle cell language to the Synapse magic the editor's detectKind() reads. */
function magicFor(lang: string | undefined, defaultLang: string): string | null {
  const l = (lang || defaultLang || 'pyspark').toLowerCase();
  if (l === 'sparksql' || l === 'sql') return '%%sql';
  if (l === 'spark' || l === 'scala') return '%%spark';
  if (l === 'sparkr' || l === 'r') return '%%sparkr';
  return null; // pyspark/python is the notebook default — no magic.
}

/** Split a string into the IPYNB source-array form (newline-terminated lines). */
function toSourceArray(src: string): string[] {
  const lines = src.split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l));
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<any>();
    if (!resource || resource.itemType !== 'synapse-notebook') return err('notebook not found', 404);
    const state = (resource.state as any) || {};
    // Fallback: cells may be stamped directly (state.cells) or stranded in the
    // NotebookContent shape (state.content.cells) — surface either.
    const raw: any[] = (Array.isArray(state.cells) && state.cells.length > 0)
      ? state.cells
      : (state.content?.kind === 'notebook' && Array.isArray(state.content.cells) ? state.content.cells : []);
    const defaultLang = state.defaultLang || state.content?.defaultLang || 'pyspark';

    const ipynbCells = raw.map((c) => {
      const isMd = c?.type === 'markdown' || c?.kind === 'markdown';
      const src = typeof c?.source === 'string' ? c.source : Array.isArray(c?.source) ? c.source.join('') : '';
      if (isMd) {
        return { cell_type: 'markdown', metadata: {}, source: toSourceArray(src) };
      }
      const magic = magicFor(c?.lang || c?.language, defaultLang);
      const body = magic ? `${magic}\n${src}` : src;
      return { cell_type: 'code', metadata: { tags: [] }, source: toSourceArray(body), outputs: [], execution_count: null };
    });

    return NextResponse.json({
      ok: true,
      notebook: {
        name: resource.displayName,
        properties: {
          nbformat: 4,
          nbformat_minor: 2,
          cells: ipynbCells,
        },
      },
      source: 'cosmos',
    });
  } catch (e: any) {
    if (e?.code === 404) return err('notebook not found', 404);
    return err(e?.message || String(e), 500);
  }
}
