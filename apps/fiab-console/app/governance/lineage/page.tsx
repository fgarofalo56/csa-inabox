'use client';

/**
 * /governance/lineage — REAL lineage canvas. Pulls /api/governance/lineage
 * (workspaces + items + edges from item.state references), lays out
 * nodes via a simple barycenter algorithm grouped by workspace, draws
 * SVG arrows between dependencies.
 *
 * No Purview required — works against the real Cosmos catalog. When
 * tenant-settings purview.bound = true, a future iteration merges in
 * Purview lineage edges.
 */

import { clientFetch } from '@/lib/client-fetch';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Spinner, Badge, Caption1, Subtitle2, Body1, Input, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Search24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  STATUS_LABEL, STATUS_COLOR, type PropagationStatus,
} from '@/lib/governance/label-propagation';

interface NodePropagation {
  status: PropagationStatus;
  currentLabel: string;
  expectedLabel: string;
  lastRunAt?: string;
}
interface Node {
  id: string; label: string; type: string; workspaceId: string;
  classifications?: string[]; sensitivity?: string;
  propagation?: NodePropagation;
}
interface Edge { from: string; to: string; via: string; }
interface WorkspaceNode { id: string; label: string; }

interface LayoutNode extends Node { x: number; y: number; }

/** SVG dot fill per propagation status — mirrors STATUS_COLOR Fluent tokens. */
const PROP_DOT: Record<PropagationStatus, string> = {
  'in-sync': '#0e700e',
  pending: '#bc4b09',
  overridden: '#0f6cbd',
  unlabeled: '#8a8886',
  'no-upstream': '#c8c6c4',
};

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
  pill: {
    fontSize: 12, color: tokens.colorNeutralForeground3,
    padding: '4px 10px', borderRadius: 999,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  canvas: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    minHeight: 480,
  },
  legend: {
    display: 'flex', gap: 16, alignItems: 'center',
    padding: 12,
    color: tokens.colorNeutralForeground3, fontSize: 12,
  },
  detail: {
    padding: 16, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  empty: {
    padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center',
  },
});

const ITEM_COLORS: Record<string, string> = {
  lakehouse: '#0078d4',
  warehouse: '#5c2d91',
  notebook: '#107c10',
  'data-pipeline': '#dca900',
  'adf-pipeline': '#dca900',
  'semantic-model': '#7719aa',
  report: '#0a4f7a',
  dashboard: '#3aaaaa',
  'kql-database': '#bd7800',
  eventhouse: '#bd7800',
  eventstream: '#005a9e',
  activator: '#d13438',
  'data-product': '#1aaa55',
  'mirrored-database': '#666',
};
function typeColor(type: string): string {
  return ITEM_COLORS[type] || '#888';
}

const CANVAS_PAD_X = 60;
const CANVAS_PAD_Y = 40;
const COL_WIDTH = 200;
const NODE_HEIGHT = 56;
const NODE_GAP = 16;

/**
 * Simple layered layout:
 *   - rank 0 = items with no incoming edges (sources)
 *   - rank r = max(rank(parents)) + 1
 *   - place nodes in columns by rank, stack within column.
 * Caps depth at items.length to defend against cycles.
 */
function layout(nodes: Node[], edges: Edge[]): { laid: LayoutNode[]; w: number; h: number; ranks: Map<string, number> } {
  const ranks = new Map<string, number>();
  for (const n of nodes) ranks.set(n.id, 0);
  const incoming = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to)!.push(e);
  }
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const n of nodes) {
      const ins = incoming.get(n.id) || [];
      let r = 0;
      for (const e of ins) {
        const pr = ranks.get(e.from);
        if (pr !== undefined && pr + 1 > r) r = pr + 1;
      }
      if (r !== ranks.get(n.id)) {
        ranks.set(n.id, r); changed = true;
      }
    }
    if (!changed) break;
  }
  // Bucket by rank
  const cols = new Map<number, Node[]>();
  for (const n of nodes) {
    const r = ranks.get(n.id) ?? 0;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r)!.push(n);
  }
  const laid: LayoutNode[] = [];
  let maxX = 0; let maxY = 0;
  for (const [r, list] of cols.entries()) {
    list.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.label.localeCompare(b.label));
    list.forEach((n, i) => {
      const x = CANVAS_PAD_X + r * COL_WIDTH;
      const y = CANVAS_PAD_Y + i * (NODE_HEIGHT + NODE_GAP);
      laid.push({ ...n, x, y });
      maxX = Math.max(maxX, x + COL_WIDTH);
      maxY = Math.max(maxY, y + NODE_HEIGHT);
    });
  }
  return { laid, w: maxX + CANVAS_PAD_X, h: maxY + CANVAS_PAD_Y, ranks };
}

function LineageInner() {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [propMeta, setPropMeta] = useState<{ source: string; lastRunAt: string | null; pending: number } | null>(null);
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Focus: when arriving from an item (e.g. OneLake → "View lineage"), scope the
  // graph to JUST that object + everything connected to it, instead of the whole
  // tenant. `?focusId=<itemId>` (matches the lineage node id == Cosmos item id).
  const searchParams = useSearchParams();
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    const f = searchParams?.get('focusId') || null;
    setFocusId(f);
    if (f) setSelectedId(f);
  }, [searchParams]);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/governance/lineage');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setWorkspaces(j.workspaces || []);
      setNodes(j.nodes || []);
      setEdges(j.edges || []);
      setSource(j.source || 'cosmos');
      setPropMeta(j.propagation || null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Focus scope — the connected component (both directions, transitive) of the
  // focused node, so "View lineage" on an item shows that object + its upstream
  // and downstream lineage only. Null when no focus → whole tenant.
  const focusSet = useMemo(() => {
    if (!focusId || !nodes.some((n) => n.id === focusId)) return null;
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
    for (const e of edges) { link(e.from, e.to); link(e.to, e.from); }
    const seen = new Set<string>([focusId]);
    const queue = [focusId];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); queue.push(m); }
    }
    return seen;
  }, [focusId, nodes, edges]);

  const focusLabel = useMemo(() => (focusId ? nodes.find((n) => n.id === focusId)?.label : null), [focusId, nodes]);

  // Filter — focus scope first, then the text query (name / type / workspace).
  const filteredNodes = useMemo(() => {
    const base = focusSet ? nodes.filter((n) => focusSet.has(n.id)) : nodes;
    const f = q.toLowerCase().trim();
    if (!f) return base;
    return base.filter((n) =>
      n.label.toLowerCase().includes(f) ||
      n.type.toLowerCase().includes(f) ||
      n.workspaceId.includes(f)
    );
  }, [nodes, q, focusSet]);

  // When filtering, only keep edges where both endpoints are in the filtered set.
  const filteredEdges = useMemo(() => {
    const ids = new Set(filteredNodes.map((n) => n.id));
    return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  }, [edges, filteredNodes]);

  const { laid, w, h, ranks } = useMemo(() => layout(filteredNodes, filteredEdges), [filteredNodes, filteredEdges]);
  const byId = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid]);

  const selected = selectedId ? byId.get(selectedId) : null;
  const selectedUpstream = selectedId ? filteredEdges.filter((e) => e.to === selectedId) : [];
  const selectedDownstream = selectedId ? filteredEdges.filter((e) => e.from === selectedId) : [];

  const wsNameById = useMemo(() => new Map(workspaces.map((w) => [w.id, w.label])), [workspaces]);

  return (
    <GovernanceShell sectionTitle="Lineage">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        End-to-end relationships across your tenant's items, derived from typed references in each item's state.
        {source && (
          <Badge appearance="outline" color={source === 'purview' ? 'brand' : 'informative'} size="small" style={{ marginLeft: 8 }}>
            source: {source}
          </Badge>
        )}
      </Body1>

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Filter by name, type, or workspace…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 480 }}
        />
        {focusId && focusLabel && (
          <Badge appearance="tint" color="brand" size="large">
            Focused: {focusLabel}
            <Button size="small" appearance="transparent" onClick={() => { setFocusId(null); setSelectedId(null); }} style={{ minWidth: 'auto', marginLeft: 4 }}>Show all</Button>
          </Badge>
        )}
        <div className={s.spacer} />
        <Caption1 className={s.pill}>{filteredNodes.length} items</Caption1>
        <Caption1 className={s.pill}>{filteredEdges.length} edges</Caption1>
        {propMeta && (
          <Badge
            appearance="tint"
            color={propMeta.pending > 0 ? 'warning' : 'success'}
            size="large"
            title={
              propMeta.lastRunAt
                ? `Label propagation last ran ${new Date(propMeta.lastRunAt).toLocaleString()} (source: ${propMeta.source})`
                : 'Label-propagation timer Function has not written state yet — status shown is computed live'
            }
          >
            {propMeta.pending > 0 ? `${propMeta.pending} label propagation pending` : 'Labels in sync'}
          </Badge>
        )}
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load lineage</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner label="Building lineage graph…" />}

      {!loading && !error && filteredNodes.length === 0 && (
        <div className={s.empty}>
          {q
            ? <>No items match &ldquo;{q}&rdquo;.</>
            : <>No items found in your workspaces yet. Create a notebook, lakehouse, or pipeline and edges will start appearing here.</>}
        </div>
      )}

      {!loading && !error && filteredNodes.length > 0 && (
        <>
          <div className={s.canvas}>
            <svg width={w} height={h} role="img" aria-label="Lineage graph">
              <defs>
                <marker id="lineage-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#666" />
                </marker>
              </defs>
              {/* Edges */}
              {filteredEdges.map((e, i) => {
                const a = byId.get(e.from); const b = byId.get(e.to);
                if (!a || !b) return null;
                const sx = a.x + 180; const sy = a.y + NODE_HEIGHT / 2;
                const ex = b.x; const ey = b.y + NODE_HEIGHT / 2;
                const dx = Math.max(40, (ex - sx) / 2);
                const isHi = selectedId && (e.from === selectedId || e.to === selectedId);
                return (
                  <path
                    key={`${e.from}->${e.to}:${i}`}
                    d={`M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`}
                    stroke={isHi ? '#0078d4' : '#aaa'}
                    strokeWidth={isHi ? 2 : 1.25}
                    fill="none"
                    markerEnd="url(#lineage-arrow)"
                  >
                    <title>{e.via}: {a.label} → {b.label}</title>
                  </path>
                );
              })}
              {/* Nodes */}
              {laid.map((n) => {
                const sel = selectedId === n.id;
                return (
                  <g key={n.id}
                     transform={`translate(${n.x},${n.y})`}
                     style={{ cursor: 'pointer' }}
                     onClick={() => setSelectedId(n.id === selectedId ? null : n.id)}>
                    <rect
                      width={180} height={NODE_HEIGHT}
                      rx={6}
                      fill="#fff"
                      stroke={sel ? '#0078d4' : '#d0d0d0'}
                      strokeWidth={sel ? 2 : 1}
                    />
                    <rect width={5} height={NODE_HEIGHT} rx={6} fill={typeColor(n.type)} />
                    <text x={14} y={20} fontSize={12} fontWeight={600} fill="#111">
                      {n.label.length > 24 ? n.label.slice(0, 24) + '…' : n.label}
                    </text>
                    <text x={14} y={38} fontSize={10} fill="#666">{n.type}</text>
                    <text x={14} y={50} fontSize={10} fill="#999">
                      ws: {(wsNameById.get(n.workspaceId) || n.workspaceId).slice(0, 22)}
                    </text>
                    {/* F15 — propagation status dot (top-right corner of the node). */}
                    {n.propagation && (
                      <circle cx={168} cy={12} r={5} fill={PROP_DOT[n.propagation.status]} stroke="#fff" strokeWidth={1}>
                        <title>
                          {STATUS_LABEL[n.propagation.status]}
                          {n.propagation.expectedLabel ? ` — expected: ${n.propagation.expectedLabel}` : ''}
                          {n.propagation.currentLabel ? ` · current: ${n.propagation.currentLabel}` : ''}
                        </title>
                      </circle>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          <div className={s.legend}>
            <strong>Legend:</strong>
            {Object.entries(ITEM_COLORS).slice(0, 8).map(([type, color]) => (
              <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: 'inline-block' }} />
                {type}
              </span>
            ))}
            <span style={{ marginLeft: 'auto' }}>Click a node to focus its lineage</span>
          </div>

          <div className={s.legend} style={{ paddingTop: 0 }}>
            <strong>Label propagation:</strong>
            {(['in-sync', 'pending', 'overridden', 'unlabeled', 'no-upstream'] as PropagationStatus[]).map((st) => (
              <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, background: PROP_DOT[st], borderRadius: 999, display: 'inline-block' }} />
                {STATUS_LABEL[st]}
              </span>
            ))}
          </div>

          {selected && (
            <div className={s.detail}>
              <Subtitle2>{selected.label}</Subtitle2>
              <Caption1 style={{ display: 'block', marginBottom: 8 }}>
                {selected.type} · workspace {wsNameById.get(selected.workspaceId) || selected.workspaceId} · rank {ranks.get(selected.id) ?? 0}
              </Caption1>
              {selected.propagation && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <Badge appearance="filled" color={STATUS_COLOR[selected.propagation.status]} size="small">
                    {STATUS_LABEL[selected.propagation.status]}
                  </Badge>
                  <Caption1>
                    Current label: <strong>{selected.propagation.currentLabel || '—'}</strong>
                    {selected.propagation.expectedLabel && (
                      <> · Inherited (expected): <strong>{selected.propagation.expectedLabel}</strong></>
                    )}
                  </Caption1>
                  {selected.propagation.lastRunAt && (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      propagated {new Date(selected.propagation.lastRunAt).toLocaleString()}
                    </Caption1>
                  )}
                </div>
              )}
              <a
                href={`/items/${selected.type}/${selected.id}`}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
              >
                Open editor <Open16Regular />
              </a>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>
                    <strong>Upstream ({selectedUpstream.length})</strong> — items that feed this one
                  </Caption1>
                  {selectedUpstream.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>None</Caption1>}
                  {selectedUpstream.map((e, i) => {
                    const src = byId.get(e.from);
                    return (
                      <div key={i} style={{ fontSize: 12, padding: '2px 0' }}>
                        ← <a href={`/items/${src?.type}/${src?.id}`}>{src?.label || e.from}</a>
                        <span style={{ color: tokens.colorNeutralForeground3 }}> · {e.via}</span>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>
                    <strong>Downstream ({selectedDownstream.length})</strong> — items that depend on this one
                  </Caption1>
                  {selectedDownstream.length === 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>None</Caption1>}
                  {selectedDownstream.map((e, i) => {
                    const dst = byId.get(e.to);
                    return (
                      <div key={i} style={{ fontSize: 12, padding: '2px 0' }}>
                        → <a href={`/items/${dst?.type}/${dst?.id}`}>{dst?.label || e.to}</a>
                        <span style={{ color: tokens.colorNeutralForeground3 }}> · {e.via}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </GovernanceShell>
  );
}

export default function GovernanceLineagePage() {
  return (
    <Suspense fallback={<Spinner label="Loading lineage…" />}>
      <LineageInner />
    </Suspense>
  );
}
