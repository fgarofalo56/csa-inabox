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

import { useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Subtitle2, Body1, Input, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Search24Regular, Open16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';

interface Node {
  id: string; label: string; type: string; workspaceId: string;
  classifications?: string[]; sensitivity?: string;
}
interface Edge { from: string; to: string; via: string; }
interface WorkspaceNode { id: string; label: string; }

interface LayoutNode extends Node { x: number; y: number; }

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

export default function GovernanceLineagePage() {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceNode[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>('');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/governance/lineage');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setWorkspaces(j.workspaces || []);
      setNodes(j.nodes || []);
      setEdges(j.edges || []);
      setSource(j.source || 'cosmos');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // Filter — both node label/type and workspace name match the query
  const filteredNodes = useMemo(() => {
    const f = q.toLowerCase().trim();
    if (!f) return nodes;
    return nodes.filter((n) =>
      n.label.toLowerCase().includes(f) ||
      n.type.toLowerCase().includes(f) ||
      n.workspaceId.includes(f)
    );
  }, [nodes, q]);

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
        <div className={s.spacer} />
        <Caption1 className={s.pill}>{filteredNodes.length} items</Caption1>
        <Caption1 className={s.pill}>{filteredEdges.length} edges</Caption1>
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

          {selected && (
            <div className={s.detail}>
              <Subtitle2>{selected.label}</Subtitle2>
              <Caption1 style={{ display: 'block', marginBottom: 8 }}>
                {selected.type} · workspace {wsNameById.get(selected.workspaceId) || selected.workspaceId} · rank {ranks.get(selected.id) ?? 0}
              </Caption1>
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
