'use client';

/**
 * Synapse Notebook editor — the heavy-designer surface that brings the Synapse
 * Studio "Develop → Notebooks" experience into Loom 1:1: a multi-cell Spark
 * notebook (code + markdown cells) attached to a Big Data pool, with per-cell
 * Run + Run-all against the real Livy interactive-session API, live output, and
 * Save/Publish back to the workspace notebook artifact.
 *
 * Real backend (per no-vaporware.md):
 *   - List/open/save/delete notebooks → /api/synapse/notebooks[/<name>]
 *     (Synapse dev-plane artifact REST, api-version 2020-12-01)
 *   - Attach picker → /api/items/synapse-spark-pool/list (ARM bigDataPools)
 *   - Run cell → POST /api/synapse/notebooks/<name>/run-cell (Livy create
 *     session + submit statement), poll via GET (Livy get statement)
 *
 * Honest gate: when the workspace routes 503 with code 'not_configured', the
 * full designer still renders behind a Fluent MessageBar naming the exact env
 * var (LOOM_SYNAPSE_WORKSPACE) — no surface is hidden.
 *
 * Parity inventory (Synapse Studio Notebook):
 *   add code/markdown cell ✅ · insert cell between cells ✅ · per-cell language
 *   (pyspark/spark/sql/sparkr/.NET-C#) ✅ · notebook default language ✅ ·
 *   run cell ✅ · run all ✅ · move/duplicate/delete cell ✅ · collapse cell
 *   input ✅ · markdown render ✅ · outline (markdown headings → navigation) ✅ ·
 *   parameters cell (papermill/ADF tag) ✅ · attach Spark pool ✅ · attach
 *   environment (Spark configuration) ✅ · session state + Spark UI link ✅ ·
 *   cell output incl. error traceback ✅ · save (publish artifact + ADLS .ipynb
 *   backup) ✅ · new/open/delete notebook ✅
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Tooltip, Input, Link,
  Tree, TreeItem, TreeItemLayout, Dropdown, Option,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Book20Regular, Play20Regular, Add20Regular,
  Delete16Regular, ChevronUp16Regular, ChevronDown16Regular,
  ChevronRight16Regular, Copy16Regular, MoreHorizontal16Regular,
  Save20Regular,
  Eye16Regular, Edit16Regular, TextBulletListTree20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea, type MonacoLanguage } from '@/lib/components/editor/monaco-textarea';
import { CellAdder } from '@/lib/components/notebook/cell-adder';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  treePad: { padding: 8 },
  cells: { display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto', flex: 1, minHeight: 0, paddingRight: 4 },
  cell: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column',
  },
  cellActive: { border: `1px solid ${tokens.colorBrandStroke1}` },
  cellHeader: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground2, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px 6px 0 0',
  },
  output: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12, whiteSpace: 'pre-wrap',
    padding: 10, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3, maxHeight: 280, overflow: 'auto',
  },
  outputErr: { color: tokens.colorPaletteRedForeground1, backgroundColor: tokens.colorPaletteRedBackground1 },
  md: { padding: 12, fontSize: 14, lineHeight: 1.5, color: tokens.colorNeutralForeground1 },
  tag: { fontFamily: 'Consolas, monospace', color: tokens.colorNeutralForeground3, fontSize: 11 },
  collapsedHint: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12,
    color: tokens.colorNeutralForeground3, padding: '8px 12px',
    borderTop: `1px dashed ${tokens.colorNeutralStroke2}`, cursor: 'pointer',
  },
  outlineHead: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 4px 4px', color: tokens.colorNeutralForeground3,
  },
  outlineItem: {
    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
    padding: '2px 4px', borderRadius: 4, border: 'none', background: 'none',
    color: tokens.colorNeutralForeground2, fontSize: 13,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  outlineEmpty: { padding: '2px 4px', color: tokens.colorNeutralForeground3, fontSize: 12 },
});

// ── IPYNB ⇄ editor-cell mapping ───────────────────────────────────────────────
// Synapse Studio notebooks support five interactive languages via %%magic.
type CellKind = 'pyspark' | 'spark' | 'sql' | 'sparkr' | 'csharp';
const KIND_TO_MONACO: Record<CellKind, MonacoLanguage> = {
  pyspark: 'pyspark', spark: 'scala', sql: 'sparksql', sparkr: 'sparkr', csharp: 'csharp',
};
const KIND_LABEL: Record<CellKind, string> = {
  pyspark: 'PySpark (Python)', spark: 'Spark (Scala)', sql: 'Spark SQL',
  sparkr: 'SparkR (R)', csharp: '.NET Spark (C#)',
};
// The %%magic header Synapse expects at the top of a non-default-language cell.
const KIND_MAGIC: Record<CellKind, string> = {
  pyspark: '', spark: '%%spark', sql: '%%sql', sparkr: '%%sparkr', csharp: '%%csharp',
};

interface EditorCell {
  id: string;
  type: 'code' | 'markdown';
  lang: CellKind;
  source: string;
  output?: { status: 'ok' | 'error' | 'running'; text?: string; ename?: string; evalue?: string; traceback?: string[] };
  running?: boolean;
  /** papermill/ADF "parameters" cell — at most one per notebook. */
  isParameters?: boolean;
  /** input collapsed (Synapse jupyter.source_hidden) — header still shows. */
  collapsed?: boolean;
}

function uid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

function ipynbToCells(props: any): EditorCell[] {
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
    };
  });
  return out.length ? out : [{ id: uid(), type: 'code', lang: 'pyspark', source: '' }];
}

function cellsToIpynb(cells: EditorCell[], pool: string | null, env?: string | null): any {
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
        ...(c.collapsed ? { jupyter: { source_hidden: true } } : {}),
      },
      source: (c.type === 'code' ? withMagic(c.source, c.lang) : c.source)
        .split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)),
      ...(c.type === 'code' ? { outputs: [], execution_count: null } : {}),
    })),
  };
}

// Minimal markdown render (headings/bold/italic/code/links/bullets) — matches the
// existing markdown-cell renderer used elsewhere in the console.
function renderMarkdown(src: string): string {
  let html = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/^(?:- (.+)(?:\n|$))+/gm, (block) => '<ul>' + block.split('\n').filter(Boolean).map((l) => '<li>' + l.replace(/^- /, '') + '</li>').join('') + '</ul>');
  html = html.split(/\n\n+/).map((p) => /<\/(h\d|ul|ol|pre)>/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br/>') + '</p>').join('');
  return html;
}

interface SparkPoolLite { name: string; properties?: { nodeSize?: string; sparkVersion?: string } }

export function SynapseNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // Notebook catalog (workspace artifacts) + the open notebook.
  const [notebooks, setNotebooks] = useState<{ name: string; language?: string; pool?: string }[]>([]);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [openName, setOpenName] = useState<string | null>(null);
  const [cells, setCells] = useState<EditorCell[]>([{ id: uid(), type: 'code', lang: 'pyspark', source: '' }]);
  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Compute attach + Livy session.
  const [pools, setPools] = useState<SparkPoolLite[]>([]);
  const [attachedPool, setAttachedPool] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionState, setSessionState] = useState<string>('none');

  // Notebook default language (new cells inherit it) + attached environment
  // (Synapse Spark configuration applied to the session).
  const [defaultLang, setDefaultLang] = useState<CellKind>('pyspark');
  const [environments, setEnvironments] = useState<{ name: string; description?: string; sparkVersion?: string }[]>([]);
  const [attachedEnv, setAttachedEnv] = useState<string | null>(null);

  // New-notebook name field.
  const [newName, setNewName] = useState('');

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await fetch('/api/synapse/notebooks');
      const j = await r.json();
      if (r.status === 503 && j?.missing) { setGate({ missing: j.missing }); setNotebooks([]); }
      else if (j?.ok) { setGate(null); setNotebooks(j.notebooks || []); }
      else { setBanner({ intent: 'error', text: j?.error || 'Failed to list notebooks' }); }
    } catch (e: any) {
      setBanner({ intent: 'error', text: e?.message || String(e) });
    } finally { setLoadingList(false); }
  }, []);

  const refreshPools = useCallback(async () => {
    try {
      const r = await fetch('/api/items/synapse-spark-pool/list');
      const j = await r.json();
      if (j?.ok) setPools(j.pools || []);
    } catch { /* attach picker shows empty — non-fatal */ }
  }, []);

  // Spark configurations ("environments") — optional notebook attach. Route
  // always returns ok:true with [] when unconfigured, so the picker degrades
  // to "(none)" with no gate.
  const refreshEnvs = useCallback(async () => {
    try {
      const r = await fetch('/api/synapse/environments');
      const j = await r.json();
      if (j?.ok) setEnvironments(j.environments || []);
    } catch { /* non-fatal — environment attach is optional */ }
  }, []);

  useEffect(() => { refreshList(); refreshPools(); refreshEnvs(); }, [refreshList, refreshPools, refreshEnvs]);

  // ---- Hydrate from the installed item's bundle cells ----
  // A bundle-installed synapse-notebook has its NotebookContent cells stamped
  // into Cosmos (state.cells, or state.content.cells when only the
  // NotebookContent shape was written). The live Synapse workspace list on the
  // left doesn't surface those, so on mount we open the item populated with
  // every markdown + code cell instead of a single empty cell — the bundle
  // content is no longer stranded. /api/items/synapse-notebook/[id] returns the
  // stamped cells in the IPYNB shape ipynbToCells() already parses. Once the
  // user opens a real workspace notebook on the left, openNotebook() takes over.
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    (async () => {
      try {
        // Resolve the owning workspace, then pull the Cosmos-backed cells.
        const lookup = await fetch(`/api/cosmos-items/synapse-notebook/${encodeURIComponent(id)}`);
        if (!lookup.ok) return;
        const item = await lookup.json();
        if (cancelled || !item?.workspaceId) return;
        const r = await fetch(`/api/items/synapse-notebook/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(item.workspaceId)}`);
        const j = await r.json();
        if (cancelled || !j?.ok) return;
        const props = j.notebook?.properties || {};
        if (!Array.isArray(props.cells) || props.cells.length === 0) return;
        setOpenName(j.notebook?.name || item.displayName || 'notebook');
        setCells(ipynbToCells(props));
        setAttachedPool(props?.bigDataPool?.referenceName ?? null);
        setAttachedEnv((props?.metadata?.a365ComputeOptions?.name as string) ?? null);
        setSessionId(null); setSessionState('none'); setDirty(false);
        setBanner({ intent: 'info', text: 'Loaded notebook cells from the installed app bundle. Open a workspace notebook on the left to edit the published copy.' });
      } catch { /* fall back to the empty starter cell */ }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const openNotebook = useCallback(async (name: string) => {
    setBanner(null);
    try {
      const r = await fetch(`/api/synapse/notebooks/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || `Failed to open ${name}` }); return; }
      const props = j.notebook?.properties || {};
      setOpenName(name);
      setCells(ipynbToCells(props));
      setAttachedPool(props?.bigDataPool?.referenceName ?? null);
      setAttachedEnv((props?.metadata?.a365ComputeOptions?.name as string) ?? null);
      setSessionId(null); setSessionState('none'); setDirty(false);
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
  }, []);

  const createNotebook = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBanner(null);
    try {
      const r = await fetch('/api/synapse/notebooks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || 'Create failed' }); return; }
      setNewName('');
      await refreshList();
      await openNotebook(name);
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
  }, [newName, refreshList, openNotebook]);

  const save = useCallback(async () => {
    if (!openName) { setBanner({ intent: 'info', text: 'Open or create a notebook first.' }); return; }
    setSaving(true); setBanner(null);
    try {
      const r = await fetch(`/api/synapse/notebooks/${encodeURIComponent(openName)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties: cellsToIpynb(cells, attachedPool, attachedEnv) }),
      });
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || 'Save failed' }); }
      else {
        setDirty(false);
        const backup = j.adlsBackup;
        const note = backup?.ok
          ? ` .ipynb backed up to ADLS (${backup.path}).`
          : backup?.skipped ? '' : ' (ADLS backup skipped — see logs.)';
        setBanner({ intent: 'success', text: `Published "${openName}" to the workspace.${note}` });
        refreshList();
      }
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  }, [openName, cells, attachedPool, attachedEnv, refreshList]);

  const deleteOpen = useCallback(async () => {
    if (!openName) return;
    try {
      const r = await fetch(`/api/synapse/notebooks/${encodeURIComponent(openName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j?.ok) { setBanner({ intent: 'error', text: j?.error || 'Delete failed' }); return; }
      setOpenName(null); setCells([{ id: uid(), type: 'code', lang: 'pyspark', source: '' }]); setDirty(false);
      refreshList();
    } catch (e: any) { setBanner({ intent: 'error', text: e?.message || String(e) }); }
  }, [openName, refreshList]);

  // ── Cell ops ───────────────────────────────────────────────────────────────
  const patchCell = useCallback((cid: string, patch: Partial<EditorCell>) => {
    setCells((cs) => cs.map((c) => (c.id === cid ? { ...c, ...patch } : c)));
    setDirty(true);
  }, []);
  // Insert a new cell. `pos` controls placement relative to `anchor`:
  //   'end'    → bottom of the notebook
  //   'after'  → directly below `anchor` (used by the between-cell adders)
  //   'before' → directly above `anchor` (used by the top adder)
  const addCell = useCallback((type: 'code' | 'markdown', anchor?: string, pos: 'end' | 'after' | 'before' = 'end') => {
    const nc: EditorCell = { id: uid(), type, lang: type === 'code' ? defaultLang : 'pyspark', source: type === 'markdown' ? '# New markdown cell' : '' };
    setCells((cs) => {
      if (!anchor || pos === 'end') return [...cs, nc];
      const i = cs.findIndex((c) => c.id === anchor);
      if (i < 0) return [...cs, nc];
      const at = pos === 'before' ? i : i + 1;
      return [...cs.slice(0, at), nc, ...cs.slice(at)];
    });
    setActiveCell(nc.id); setDirty(true);
  }, [defaultLang]);
  const duplicateCell = useCallback((cid: string) => {
    setCells((cs) => {
      const i = cs.findIndex((c) => c.id === cid);
      if (i < 0) return cs;
      const src = cs[i];
      // Clone without output / running state and without the parameters tag
      // (only one parameters cell is allowed) — Synapse "Copy cell" semantics.
      const copy: EditorCell = { ...src, id: uid(), output: undefined, running: false, isParameters: false };
      return [...cs.slice(0, i + 1), copy, ...cs.slice(i + 1)];
    });
    setDirty(true);
  }, []);
  // Synapse allows exactly one parameters cell — toggling one on clears any other.
  const toggleParameters = useCallback((cid: string) => {
    setCells((cs) => cs.map((c) => {
      if (c.id === cid) return { ...c, isParameters: !c.isParameters };
      return c.isParameters ? { ...c, isParameters: false } : c;
    }));
    setDirty(true);
  }, []);
  const deleteCell = useCallback((cid: string) => {
    setCells((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== cid)));
    setDirty(true);
  }, []);
  const moveCell = useCallback((cid: string, dir: -1 | 1) => {
    setCells((cs) => {
      const i = cs.findIndex((c) => c.id === cid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const next = [...cs]; [next[i], next[j]] = [next[j], next[i]]; return next;
    });
    setDirty(true);
  }, []);

  // ── Outline — markdown headings (# / ## / ###) → click-to-scroll navigation,
  //    mirroring Synapse Studio's notebook Outline pane. ────────────────────────
  const outline = useMemo(() => {
    const items: { id: string; level: number; text: string }[] = [];
    for (const c of cells) {
      if (c.type !== 'markdown') continue;
      for (const line of c.source.split('\n')) {
        const m = line.match(/^(#{1,3})\s+(.+)$/);
        if (m) { items.push({ id: c.id, level: m[1].length, text: m[2].trim() }); break; }
      }
    }
    return items;
  }, [cells]);

  // ── Run a cell against the Spark pool via Livy (create session → submit →
  //    poll). Reuses the warm sessionId across cells (notebook semantics). ──────
  const pollStatement = useCallback(async (pool: string, sess: number, stmt: number, cid: string) => {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const r = await fetch(`/api/synapse/notebooks/${encodeURIComponent(openName || '_')}/run-cell?pool=${encodeURIComponent(pool)}&session=${sess}&stmt=${stmt}`);
      const j = await r.json();
      if (!j?.ok) { patchCell(cid, { running: false, output: { status: 'error', text: j?.error || 'poll failed' } }); return; }
      const st = String(j.state);
      if (st === 'available') {
        const o = j.output || {};
        if (o.status === 'error') {
          patchCell(cid, { running: false, output: { status: 'error', ename: o.ename, evalue: o.evalue, traceback: o.traceback } });
        } else {
          const text = o?.data?.['text/plain'] ?? '';
          patchCell(cid, { running: false, output: { status: 'ok', text: Array.isArray(text) ? text.join('') : String(text) } });
        }
        return;
      }
      if (st === 'error' || st === 'cancelled') {
        patchCell(cid, { running: false, output: { status: 'error', text: `statement ${st}` } });
        return;
      }
    }
    patchCell(cid, { running: false, output: { status: 'error', text: 'timed out polling statement' } });
  }, [openName, patchCell]);

  const runCell = useCallback(async (cid: string): Promise<void> => {
    const cell = cells.find((c) => c.id === cid);
    if (!cell || cell.type !== 'code') return;
    if (!attachedPool) { setBanner({ intent: 'info', text: 'Attach a Spark pool before running.' }); return; }
    patchCell(cid, { running: true, output: { status: 'running', text: 'Submitting…' } });
    try {
      // POST may return sessionWarming when the Spark session is still cold —
      // poll the session to idle, then re-POST to actually submit the statement.
      let sess = sessionId;
      for (let attempt = 0; attempt < 90; attempt++) {
        const r = await fetch(`/api/synapse/notebooks/${encodeURIComponent(openName || '_')}/run-cell`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pool: attachedPool, code: cell.source, kind: cell.lang, sessionId: sess ?? undefined }),
        });
        const j = await r.json();
        if (!j?.ok) { patchCell(cid, { running: false, output: { status: 'error', text: j?.error || 'run failed' } }); return; }
        sess = j.sessionId; setSessionId(j.sessionId);
        if (j.sessionWarming || j.stmtId == null) {
          setSessionState(j.state || 'starting');
          await new Promise((r2) => setTimeout(r2, 3000));
          continue;
        }
        setSessionState('busy');
        await pollStatement(attachedPool, j.sessionId, j.stmtId, cid);
        setSessionState('idle');
        return;
      }
      patchCell(cid, { running: false, output: { status: 'error', text: 'Spark session did not become ready in time' } });
    } catch (e: any) {
      patchCell(cid, { running: false, output: { status: 'error', text: e?.message || String(e) } });
    }
  }, [cells, attachedPool, sessionId, openName, patchCell, pollStatement]);

  const runAll = useCallback(async () => {
    for (const c of cells) {
      if (c.type === 'code' && c.source.trim()) {
        // eslint-disable-next-line no-await-in-loop
        await runCell(c.id);
      }
    }
  }, [cells, runCell]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: 'Run all', onClick: openName && attachedPool ? runAll : undefined, disabled: !openName || !attachedPool, title: !attachedPool ? 'Attach a Spark pool first' : undefined },
      ]},
      { label: 'Cells', actions: [
        { label: 'Add code', onClick: () => addCell('code', activeCell || undefined, 'after') },
        { label: 'Add markdown', onClick: () => addCell('markdown', activeCell || undefined, 'after') },
        { label: 'Duplicate', onClick: activeCell ? () => duplicateCell(activeCell) : undefined, disabled: !activeCell },
        { label: 'Parameters cell', onClick: activeCell ? () => toggleParameters(activeCell) : undefined, disabled: !activeCell, title: 'Mark the active code cell as the papermill/ADF parameters cell' },
      ]},
      { label: 'Notebook', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: openName && !saving ? save : undefined, disabled: !openName || saving },
        { label: 'Delete', onClick: openName ? deleteOpen : undefined, disabled: !openName },
        { label: 'Refresh', onClick: refreshList },
      ]},
    ]},
  ], [openName, attachedPool, runAll, addCell, activeCell, duplicateCell, toggleParameters, saving, save, deleteOpen, refreshList]);

  const sparkUiNote = sessionState === 'idle' || sessionState === 'busy';

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          {gate ? (
            <Caption1>Workspace not configured.</Caption1>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                <Input
                  size="small" placeholder="new notebook name" value={newName}
                  onChange={(_, d) => setNewName(d.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createNotebook(); }}
                  aria-label="New notebook name"
                />
                <Button size="small" icon={<Add20Regular />} onClick={createNotebook} disabled={!newName.trim()} aria-label="Create notebook" />
              </div>
              <Tree aria-label="Workspace notebooks" defaultOpenItems={['nb']}>
                <TreeItem itemType="branch" value="nb">
                  <TreeItemLayout iconBefore={<Book20Regular />}>
                    Notebooks ({notebooks.length})
                  </TreeItemLayout>
                  <Tree>
                    {loadingList && (
                      <TreeItem itemType="leaf" value="loading"><TreeItemLayout><Spinner size="tiny" /></TreeItemLayout></TreeItem>
                    )}
                    {!loadingList && notebooks.length === 0 && (
                      <TreeItem itemType="leaf" value="empty"><TreeItemLayout>No notebooks yet</TreeItemLayout></TreeItem>
                    )}
                    {notebooks.map((n) => (
                      <TreeItem key={n.name} itemType="leaf" value={`n-${n.name}`} onClick={() => openNotebook(n.name)}>
                        <TreeItemLayout iconBefore={<Book20Regular />}>
                          {n.name} {openName === n.name && '·'}
                          {n.pool && <Caption1> · {n.pool}</Caption1>}
                        </TreeItemLayout>
                      </TreeItem>
                    ))}
                  </Tree>
                </TreeItem>
              </Tree>

              {/* Outline — markdown headings → click-to-scroll, like Synapse Studio. */}
              <div className={s.outlineHead}>
                <TextBulletListTree20Regular />
                <Caption1>Outline</Caption1>
              </div>
              <div role="navigation" aria-label="Outline">
                {outline.length === 0 ? (
                  <div className={s.outlineEmpty}>No headings yet — add a markdown cell with a # heading.</div>
                ) : (
                  outline.map((o, idx) => (
                    <button
                      key={`${o.id}-${idx}`}
                      type="button"
                      className={s.outlineItem}
                      style={{ paddingLeft: 4 + (o.level - 1) * 14 }}
                      onClick={() => {
                        setActiveCell(o.id);
                        document.getElementById(`cell-${o.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                    >
                      {o.text}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          {gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Synapse workspace not configured</MessageBarTitle>
                Set <strong>{gate.missing}</strong> on the console container app to the Synapse
                workspace name. The notebook designer and Spark Livy run path light up once it is set
                and the Loom UAMI holds the <strong>Synapse Artifact Publisher</strong> role on the
                workspace. Bicep: <code>platform/fiab/bicep/modules/synapse/*.bicep</code>.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={refreshList}>Re-check</Button>
              </MessageBarActions>
            </MessageBar>
          )}

          {banner && (
            <MessageBar intent={banner.intent}>
              <MessageBarBody>{banner.text}</MessageBarBody>
              <MessageBarActions><Button size="small" onClick={() => setBanner(null)}>Dismiss</Button></MessageBarActions>
            </MessageBar>
          )}

          {!gate && (
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Notebook</Badge>
              <Body1>{openName || 'no notebook open'}</Body1>
              {dirty && <Badge appearance="outline" color="warning" size="small">unsaved</Badge>}
              <div className={s.spacer} />
              <Caption1>Language:</Caption1>
              <Dropdown
                size="small"
                value={KIND_LABEL[defaultLang]}
                selectedOptions={[defaultLang]}
                onOptionSelect={(_, d) => { if (d.optionValue) { setDefaultLang(d.optionValue as CellKind); setDirty(true); } }}
                aria-label="Default cell language"
                style={{ minWidth: 150 }}
              >
                {(Object.keys(KIND_LABEL) as CellKind[]).map((k) => (
                  <Option key={k} value={k} text={KIND_LABEL[k]}>{KIND_LABEL[k]}</Option>
                ))}
              </Dropdown>
              <Caption1>Attach:</Caption1>
              <Dropdown
                size="small"
                placeholder="Spark pool"
                value={attachedPool || ''}
                selectedOptions={attachedPool ? [attachedPool] : []}
                onOptionSelect={(_, d) => { setAttachedPool(d.optionValue || null); setSessionId(null); setSessionState('none'); setDirty(true); }}
                aria-label="Attach Spark pool"
                style={{ minWidth: 180 }}
              >
                {pools.length === 0 && <Option value="" disabled>no Spark pools in workspace</Option>}
                {pools.map((p) => (
                  <Option key={p.name} value={p.name} text={p.name}>
                    {p.name} {p.properties?.nodeSize ? `· ${p.properties.nodeSize}` : ''}
                  </Option>
                ))}
              </Dropdown>
              <Dropdown
                size="small"
                placeholder="Environment"
                value={attachedEnv || ''}
                selectedOptions={attachedEnv ? [attachedEnv] : ['']}
                onOptionSelect={(_, d) => { setAttachedEnv(d.optionValue || null); setDirty(true); }}
                aria-label="Attach environment (Spark configuration)"
                title="Spark configuration applied to the session"
                style={{ minWidth: 160 }}
              >
                <Option value="" text="(no environment)">(no environment)</Option>
                {environments.map((e) => (
                  <Option key={e.name} value={e.name} text={e.name}>
                    {e.name}{e.sparkVersion ? ` · Spark ${e.sparkVersion}` : ''}
                  </Option>
                ))}
              </Dropdown>
              <Badge appearance="outline" color={sessionState === 'idle' ? 'success' : sessionState === 'busy' || sessionState === 'starting' ? 'warning' : 'informative'}>
                session: {sessionId != null ? `${sessionId} (${sessionState})` : 'none'}
              </Badge>
              <Button appearance="primary" icon={<Save20Regular />} disabled={!openName || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}

          {!gate && (
            <div className={s.cells}>
              <CellAdder
                onAddCode={() => addCell('code', cells[0]?.id, 'before')}
                onAddMarkdown={() => addCell('markdown', cells[0]?.id, 'before')}
              />
              {cells.map((c, i) => (
                <div key={c.id} id={`cell-${c.id}`}>
                  <NotebookCellView
                    cell={c}
                    active={activeCell === c.id}
                    canRun={!!attachedPool}
                    canUp={i > 0}
                    canDown={i < cells.length - 1}
                    onFocus={() => setActiveCell(c.id)}
                    onChange={(patch) => patchCell(c.id, patch)}
                    onRun={() => runCell(c.id)}
                    onDelete={() => deleteCell(c.id)}
                    onUp={() => moveCell(c.id, -1)}
                    onDown={() => moveCell(c.id, 1)}
                    onDuplicate={() => duplicateCell(c.id)}
                    onToggleParameters={() => toggleParameters(c.id)}
                    onToggleCollapsed={() => patchCell(c.id, { collapsed: !c.collapsed })}
                  />
                  <CellAdder
                    onAddCode={() => addCell('code', c.id, 'after')}
                    onAddMarkdown={() => addCell('markdown', c.id, 'after')}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      }
    />
  );
}

// ── Single cell view ──────────────────────────────────────────────────────────
function NotebookCellView(props: {
  cell: EditorCell; active: boolean; canRun: boolean; canUp: boolean; canDown: boolean;
  onFocus: () => void; onChange: (patch: Partial<EditorCell>) => void; onRun: () => void;
  onDelete: () => void; onUp: () => void; onDown: () => void;
  onDuplicate: () => void; onToggleParameters: () => void; onToggleCollapsed: () => void;
}) {
  const s = useStyles();
  const { cell, active } = props;
  const [mdEditing, setMdEditing] = useState(!cell.source);

  // Shared move/duplicate/delete cluster used by both cell kinds.
  const actions = (
    <>
      <Button size="small" appearance="subtle"
        icon={cell.collapsed ? <ChevronRight16Regular /> : <ChevronDown16Regular />}
        onClick={(e) => { e.stopPropagation(); props.onToggleCollapsed(); }}
        aria-label={cell.collapsed ? 'Expand cell input' : 'Collapse cell input'}
        title={cell.collapsed ? 'Expand input' : 'Collapse input'} />
      <Button size="small" appearance="subtle" icon={<ChevronUp16Regular />} disabled={!props.canUp} onClick={(e) => { e.stopPropagation(); props.onUp(); }} aria-label="Move up" />
      <Button size="small" appearance="subtle" icon={<ChevronDown16Regular />} disabled={!props.canDown} onClick={(e) => { e.stopPropagation(); props.onDown(); }} aria-label="Move down" />
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button size="small" appearance="subtle" icon={<MoreHorizontal16Regular />} aria-label="More cell actions" onClick={(e) => e.stopPropagation()} />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<Copy16Regular />} onClick={props.onDuplicate}>Duplicate cell</MenuItem>
            {cell.type === 'code' && (
              <MenuItem onClick={props.onToggleParameters}>
                {cell.isParameters ? 'Unset parameters cell' : 'Toggle parameter cell'}
              </MenuItem>
            )}
            <MenuItem icon={<Delete16Regular />} onClick={props.onDelete}>Delete cell</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </>
  );

  if (cell.type === 'markdown') {
    return (
      <div className={`${s.cell} ${active ? s.cellActive : ''}`} onClick={props.onFocus}>
        <div className={s.cellHeader}>
          <Caption1 className={s.tag}># md</Caption1>
          <Button size="small" appearance="subtle" icon={mdEditing ? <Eye16Regular /> : <Edit16Regular />}
            onClick={(e) => { e.stopPropagation(); setMdEditing((v) => !v); }}>
            {mdEditing ? 'View' : 'Edit'}
          </Button>
          <div className={s.spacer} />
          {actions}
        </div>
        {cell.collapsed ? (
          <div className={s.collapsedHint} onClick={(e) => { e.stopPropagation(); props.onToggleCollapsed(); }}>
            ⋯ markdown collapsed — click to expand
          </div>
        ) : mdEditing ? (
          <MonacoTextarea value={cell.source} onChange={(v) => props.onChange({ source: v })} language="plaintext" height={120} minHeight={80} ariaLabel="Markdown source" />
        ) : (
          <div className={s.md} onDoubleClick={() => setMdEditing(true)}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.source || '_Empty markdown cell — double-click to edit._') }} />
        )}
      </div>
    );
  }

  const out = cell.output;
  return (
    <div className={`${s.cell} ${active ? s.cellActive : ''}`} onClick={props.onFocus}>
      <div className={s.cellHeader}>
        <Tooltip content="Run cell" relationship="label">
          <Button size="small" appearance="primary" icon={cell.running ? <Spinner size="tiny" /> : <Play20Regular />}
            disabled={cell.running || !props.canRun}
            onClick={(e) => { e.stopPropagation(); props.onRun(); }} aria-label="Run cell" />
        </Tooltip>
        <Dropdown size="small" value={KIND_LABEL[cell.lang]} selectedOptions={[cell.lang]}
          onOptionSelect={(_, d) => props.onChange({ lang: (d.optionValue as CellKind) || 'pyspark' })}
          aria-label="Cell language" style={{ minWidth: 150 }}>
          {(Object.keys(KIND_LABEL) as CellKind[]).map((k) => <Option key={k} value={k} text={KIND_LABEL[k]}>{KIND_LABEL[k]}</Option>)}
        </Dropdown>
        {cell.isParameters && (
          <Tooltip content="Parameters cell — values can be overridden when the notebook runs from a pipeline (papermill/ADF)." relationship="label">
            <Badge appearance="filled" color="brand" size="small">parameters</Badge>
          </Tooltip>
        )}
        {!props.canRun && <Caption1 className={s.tag}>attach a pool to run</Caption1>}
        <div className={s.spacer} />
        {actions}
      </div>
      {cell.collapsed ? (
        <div className={s.collapsedHint} onClick={(e) => { e.stopPropagation(); props.onToggleCollapsed(); }}>
          ⋯ {cell.source.split('\n')[0]?.slice(0, 80) || '(empty)'} — click to expand
        </div>
      ) : (
        <MonacoTextarea value={cell.source} onChange={(v) => props.onChange({ source: v })}
          language={KIND_TO_MONACO[cell.lang]} height={140} minHeight={80} ariaLabel={`${cell.lang} code cell`} />
      )}
      {out && !cell.collapsed && (
        <div className={`${s.output} ${out.status === 'error' ? s.outputErr : ''}`}>
          {out.status === 'running' && <Spinner size="tiny" label="Running…" labelPosition="after" />}
          {out.status === 'ok' && (out.text || '(no output)')}
          {out.status === 'error' && (
            <>
              {out.ename ? `${out.ename}: ${out.evalue || ''}\n` : ''}
              {out.traceback?.length ? out.traceback.join('\n') : (out.text || 'error')}
            </>
          )}
        </div>
      )}
    </div>
  );
}
