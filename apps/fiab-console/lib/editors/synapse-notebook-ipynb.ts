/**
 * IPYNB ⇄ editor-cell mapping for the Synapse notebook editor.
 *
 * Moved verbatim out of synapse-notebook-editor.tsx (which is ratchet-frozen by
 * scripts/ci/check-file-size.mjs) so the editor stays under its ceiling. Pure —
 * no React — like its sibling ./synapse-notebook-cell-adapter, which owns the
 * EditorCell / CellKind types and the KIND_* maps these helpers read.
 */
import {
  type EditorCell, type CellKind,
  KIND_MAGIC, metaToComments, commentsToMeta,
} from './synapse-notebook-cell-adapter';

export function uid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Client-side mirror of the server's parseConfigureMagic detection — only the
// "is this a %%configure cell?" check. The server does the authoritative parse
// (and validates the JSON body) when the cell is sent to /execute.
export function isConfigureCell(source: string): boolean {
  const first = source.split('\n').find((l) => l.trim() !== '')?.trim().toLowerCase() || '';
  return first.split(/\s+/)[0].startsWith('%%configure');
}

// Synapse magic %%sql / %%spark etc. carry per-cell language in IPYNB source.
function detectKind(metaTags: unknown, source: string): CellKind {
  const head = source.split('\n')[0]?.trim().toLowerCase() || '';
  if (head.startsWith('%%sql')) return 'sql';
  if (head.startsWith('%%spark')) return 'spark';
  if (head.startsWith('%%sparkr') || head.startsWith('%%r')) return 'sparkr';
  if (head.startsWith('%%csharp')) return 'csharp';
  return 'pyspark';
}

function tagsOf(meta: any): string[] {
  return Array.isArray(meta?.tags) ? meta.tags.map((t: unknown) => String(t)) : [];
}

// Synapse persists per-cell language as a leading %%magic in the IPYNB source.
// We strip it for clean editing and re-stamp it on save so language round-trips.
function stripMagic(source: string, kind: CellKind): string {
  if (kind === 'pyspark') return source;
  const lines = source.split('\n');
  const head = lines[0]?.trim().toLowerCase() || '';
  if (head.startsWith('%%')) return lines.slice(1).join('\n');
  return source;
}
function withMagic(source: string, kind: CellKind): string {
  if (kind === 'pyspark') return source;
  const magic = KIND_MAGIC[kind];
  const head = source.split('\n')[0]?.trim().toLowerCase() || '';
  if (head.startsWith(magic.toLowerCase())) return source;
  return `${magic}\n${source}`;
}

export function ipynbToCells(props: any): EditorCell[] {
  const raw: any[] = Array.isArray(props?.cells) ? props.cells : [];
  const out: EditorCell[] = raw.map((c) => {
    const src = Array.isArray(c?.source) ? c.source.join('') : (typeof c?.source === 'string' ? c.source : '');
    const isMd = c?.cell_type === 'markdown';
    const outputs: any[] = Array.isArray(c?.outputs) ? c.outputs : [];
    const textOut = outputs
      .map((o) => {
        if (o?.text) return Array.isArray(o.text) ? o.text.join('') : String(o.text);
        const d = o?.data?.['text/plain'];
        return Array.isArray(d) ? d.join('') : (d ? String(d) : '');
      })
      .filter(Boolean).join('\n');
    const tags = tagsOf(c?.metadata);
    const lang: CellKind = isMd ? 'pyspark' : detectKind(c?.metadata?.tags, src);
    return {
      id: uid(),
      type: isMd ? 'markdown' : 'code',
      lang,
      source: isMd ? src : stripMagic(src, lang),
      output: textOut ? { status: 'ok', text: textOut } : undefined,
      isParameters: !isMd && tags.includes('parameters'),
      collapsed: !!(c?.metadata?.jupyter?.source_hidden),
      outputCollapsed: !!(c?.metadata?.jupyter?.outputs_hidden),
      comments: metaToComments(c?.metadata),
    };
  });
  return out.length ? out : [{ id: uid(), type: 'code', lang: 'pyspark', source: '' }];
}

export function cellsToIpynb(cells: EditorCell[], pool: string | null, env?: string | null): any {
  return {
    nbformat: 4,
    nbformat_minor: 2,
    bigDataPool: pool ? { referenceName: pool, type: 'BigDataPoolReference' } : undefined,
    metadata: {
      language_info: { name: 'python' },
      kernelspec: { name: 'synapse_pyspark', display_name: 'Synapse PySpark' },
      // Synapse stores the attached Spark configuration ("environment") here.
      ...(env ? { a365ComputeOptions: { id: env, name: env } } : {}),
    },
    cells: cells.map((c) => ({
      cell_type: c.type === 'markdown' ? 'markdown' : 'code',
      metadata: {
        ...(c.type === 'code' ? { tags: c.isParameters ? ['parameters'] : [] } : {}),
        ...((c.collapsed || c.outputCollapsed) ? { jupyter: { ...(c.collapsed ? { source_hidden: true } : {}), ...(c.outputCollapsed ? { outputs_hidden: true } : {}) } } : {}),
        ...(commentsToMeta(c.comments) ? { loomComments: commentsToMeta(c.comments) } : {}),
      },
      source: (c.type === 'code' ? withMagic(c.source, c.lang) : c.source)
        .split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)),
      ...(c.type === 'code' ? { outputs: [], execution_count: null } : {}),
    })),
  };
}
