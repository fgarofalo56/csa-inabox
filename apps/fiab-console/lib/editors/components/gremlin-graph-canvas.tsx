'use client';

/**
 * gremlin-graph-canvas — a real, interactive graph explorer for the Cosmos DB
 * Gremlin (Apache TinkerPop) API. Parity target: the Azure portal "Data
 * Explorer → Graph" surface + the gremlin-server graph viewer:
 *
 *   - A **force-directed canvas** (Fruchterman-Reingold layout in vanilla TS)
 *     with **zoom (wheel / buttons) + pan (drag)**, theme-aware nodes/edges,
 *     hover-neighbour highlight, and a click-to-inspect detail panel for both
 *     vertices and edges.
 *   - A **Gremlin Monaco editor + Run** that POSTs the traversal to the real
 *     BFF (`/api/items/cosmos-db/[id]/gremlin`) and maps `g.V()/g.E()` GraphSON
 *     results to nodes + edges via `extractGraph`.
 *   - **Add vertex** (`g.addV`) + **Add edge** (`g.addE…to`) dialogs that
 *     execute the mutation against the live graph then re-query `g.V().limit(25)`
 *     so persistence is *confirmed by a real round-trip*, not a fake toast.
 *   - A **Results-as-JSON toggle** that swaps the canvas for the raw traversal
 *     response (the no-vaporware "receipt").
 *
 * 100% Azure-native (no Fabric). Honest infra-gate: when the Gremlin runtime
 * isn't wired, the BFF returns a precise MessageBar payload rendered inline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Caption1, Tooltip, Switch, Input, Label, Field, Spinner,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, shorthands, mergeClasses,
} from '@fluentui/react-components';
import {
  Play20Regular, AddCircle20Regular, BranchCompare20Regular,
  ZoomIn20Regular, ZoomOut20Regular, ArrowReset20Regular, Delete16Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { extractGraph, type GraphNode, type GraphEdge } from '@/lib/components/graph/force-directed-graph';

const DEFAULT_QUERY = 'g.V().limit(25)';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  editorRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  canvasWrap: {
    display: 'grid', gridTemplateColumns: '1fr 260px', gap: tokens.spacingHorizontalM, minHeight: 0,
  },
  svg: {
    width: '100%', height: '460px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    touchAction: 'none', cursor: 'grab',
  },
  svgDragging: { cursor: 'grabbing' },
  side: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    overflow: 'auto', maxHeight: '460px',
  },
  json: {
    margin: 0, fontSize: '11px', fontFamily: 'Consolas, monospace',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    maxHeight: '460px', overflow: 'auto',
  },
  propRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  empty: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', height: '460px',
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.border('1px', 'dashed', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    textAlign: 'center', ...shorthands.padding(tokens.spacingVerticalXXL, tokens.spacingHorizontalXXL),
  },
});

const WIDTH = 900;
const HEIGHT = 600;

interface NodePos extends GraphNode { x: number; y: number; vx: number; vy: number }

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function colorFor(group?: string | number): string {
  if (group == null) return '#0078d4';
  const palette = ['#0078d4', '#107c10', '#d83b01', '#5c2d91', '#008272', '#bf6900', '#a30075'];
  const idx = typeof group === 'number' ? group : Math.abs(hash(String(group))) % palette.length;
  return palette[idx % palette.length];
}

/** Fruchterman-Reingold force layout — bounded iterations, deterministic seed. */
function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): NodePos[] {
  if (nodes.length === 0) return [];
  const ns: NodePos[] = nodes.map((n) => {
    const seed = hash(n.id);
    return {
      ...n,
      x: WIDTH / 2 + (seed % 240) - 120,
      y: HEIGHT / 2 + ((seed >> 8) % 240) - 120,
      vx: 0, vy: 0,
    };
  });
  const byId = new Map(ns.map((n) => [n.id, n] as const));
  const k = Math.sqrt((WIDTH * HEIGHT) / Math.max(1, ns.length));
  const iterations = Math.max(40, Math.min(140, 1000 / Math.max(1, ns.length)));
  for (let it = 0; it < iterations; it++) {
    for (let a = 0; a < ns.length; a++) {
      for (let b = a + 1; b < ns.length; b++) {
        const dx = ns[a].x - ns[b].x;
        const dy = ns[a].y - ns[b].y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        ns[a].vx += fx; ns[a].vy += fy;
        ns[b].vx -= fx; ns[b].vy -= fy;
      }
    }
    for (const e of edges) {
      const s = byId.get(e.source); const t = byId.get(e.target);
      if (!s || !t) continue;
      const dx = s.x - t.x; const dy = s.y - t.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force; const fy = (dy / dist) * force;
      s.vx -= fx; s.vy -= fy; t.vx += fx; t.vy += fy;
    }
    const damping = 0.85; const maxStep = k;
    for (const n of ns) {
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > maxStep) { n.vx = (n.vx / speed) * maxStep; n.vy = (n.vy / speed) * maxStep; }
      n.x = Math.max(24, Math.min(WIDTH - 24, n.x + n.vx));
      n.y = Math.max(24, Math.min(HEIGHT - 24, n.y + n.vy));
      n.vx *= damping; n.vy *= damping;
    }
  }
  return ns;
}

/** Escape a Gremlin string literal (single-quoted). */
function gq(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Pretty Cosmos Gremlin property values: `{ name: [{ value: 'x' }] }` → `x`. */
function flattenProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && 'value' in (v[0] as any)) {
      out[k] = (v as any[]).map((e) => e?.value).filter((x) => x !== undefined).join(', ');
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface GremlinGraphCanvasProps {
  /** Loom item id — drives the BFF route segment. */
  itemId: string;
}

interface PropPair { key: string; value: string }

export function GremlinGraphCanvas({ itemId }: GremlinGraphCanvasProps) {
  const s = useStyles();
  const [query, setQuery] = useState<string>(DEFAULT_QUERY);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [showJson, setShowJson] = useState(false);

  // Zoom / pan transform applied to the SVG content group.
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });

  // Selection — a vertex id or an edge index.
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Add-vertex / add-edge dialog state.
  const [addVertexOpen, setAddVertexOpen] = useState(false);
  const [addEdgeOpen, setAddEdgeOpen] = useState(false);
  const [vLabel, setVLabel] = useState('person');
  const [vPk, setVPk] = useState('default');
  const [vProps, setVProps] = useState<PropPair[]>([{ key: 'name', value: '' }]);
  const [eFrom, setEFrom] = useState('');
  const [eTo, setETo] = useState('');
  const [eLabel, setELabel] = useState('knows');
  const [mutating, setMutating] = useState(false);
  const [mutError, setMutError] = useState<string | null>(null);

  const run = useCallback(async (gremlin: string): Promise<any> => {
    setLoading(true);
    try {
      const r = await fetch(`/api/items/cosmos-db/${encodeURIComponent(itemId)}/gremlin`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: gremlin }),
      });
      const json = await r.json();
      setResult(json);
      return json;
    } catch (e: any) {
      const json = { ok: false, error: e?.message || String(e) };
      setResult(json);
      return json;
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  const runCurrent = useCallback(() => { setSelNode(null); setSelEdge(null); run(query); }, [query, run]);

  const graph = useMemo(() => {
    if (!result || !result.ok) return { nodes: [], edges: [] };
    return extractGraph(result);
  }, [result]);

  const layout = useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph]);
  const byId = useMemo(() => new Map(layout.map((n) => [n.id, n])), [layout]);

  const neighborIds = useMemo(() => {
    const focus = selNode || hoverId;
    if (!focus) return new Set<string>();
    const set = new Set<string>([focus]);
    for (const e of graph.edges) {
      if (e.source === focus) set.add(e.target);
      if (e.target === focus) set.add(e.source);
    }
    return set;
  }, [selNode, hoverId, graph.edges]);

  const selectedNode = selNode ? layout.find((n) => n.id === selNode) : null;
  const selectedEdge = selEdge != null ? graph.edges[selEdge] : null;

  // ----- Zoom / pan handlers -----
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    setView((v) => {
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const scale = Math.max(0.2, Math.min(4, v.scale * factor));
      return { ...v, scale };
    });
  }, []);
  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { active: true, x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current.x = e.clientX; drag.current.y = e.clientY;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  }, []);
  const onPointerUp = useCallback(() => { drag.current.active = false; }, []);
  const resetView = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), []);
  const zoomBy = useCallback((f: number) =>
    setView((v) => ({ ...v, scale: Math.max(0.2, Math.min(4, v.scale * f)) })), []);

  // ----- Add vertex / edge -----
  const submitVertex = useCallback(async () => {
    setMutating(true); setMutError(null);
    const label = vLabel.trim() || 'vertex';
    let g = `g.addV('${gq(label)}').property('pk','${gq(vPk.trim() || 'default')}')`;
    for (const p of vProps) {
      if (p.key.trim()) g += `.property('${gq(p.key.trim())}','${gq(p.value)}')`;
    }
    const res = await run(g);
    setMutating(false);
    if (!res?.ok) { setMutError(res?.error || 'addV failed'); return; }
    setAddVertexOpen(false);
    // Confirm persistence with a real re-query.
    setSelNode(null); setSelEdge(null);
    await run(DEFAULT_QUERY);
    setQuery(DEFAULT_QUERY);
  }, [vLabel, vPk, vProps, run]);

  const submitEdge = useCallback(async () => {
    setMutating(true); setMutError(null);
    const from = eFrom.trim(); const to = eTo.trim(); const label = eLabel.trim() || 'edge';
    if (!from || !to) { setMutError('Both source and target vertex ids are required.'); setMutating(false); return; }
    const g = `g.V('${gq(from)}').addE('${gq(label)}').to(g.V('${gq(to)}'))`;
    const res = await run(g);
    setMutating(false);
    if (!res?.ok) { setMutError(res?.error || 'addE failed'); return; }
    setAddEdgeOpen(false);
    setSelNode(null); setSelEdge(null);
    await run(DEFAULT_QUERY);
    setQuery(DEFAULT_QUERY);
  }, [eFrom, eTo, eLabel, run]);

  // Run an initial g.V().limit(25) so the canvas isn't blank on open.
  useEffect(() => { run(DEFAULT_QUERY); }, [run]);

  const gate = result && !result.ok ? result : null;

  return (
    <div className={s.root}>
      <div className={s.editorRow}>
        <Label htmlFor="gremlin-editor">Gremlin traversal</Label>
        <MonacoTextarea
          value={query}
          onChange={setQuery}
          language="javascript"
          height={140}
          minHeight={100}
          ariaLabel="Gremlin traversal editor"
        />
      </div>

      <div className={s.toolbar}>
        <Button appearance="primary" icon={loading ? <Spinner size="tiny" /> : <Play20Regular />} disabled={loading} onClick={runCurrent}>
          {loading ? 'Running…' : 'Run'}
        </Button>
        <Button appearance="secondary" disabled={loading} onClick={() => { setQuery(DEFAULT_QUERY); run(DEFAULT_QUERY); }}>
          g.V().limit(25)
        </Button>
        <Button appearance="secondary" icon={<AddCircle20Regular />} disabled={loading} onClick={() => { setMutError(null); setAddVertexOpen(true); }}>
          Add vertex
        </Button>
        <Button appearance="secondary" icon={<BranchCompare20Regular />} disabled={loading} onClick={() => { setMutError(null); setAddEdgeOpen(true); }}>
          Add edge
        </Button>
        <span className={s.spacer} />
        <Tooltip content="Zoom in" relationship="label">
          <Button appearance="subtle" icon={<ZoomIn20Regular />} aria-label="Zoom in" onClick={() => zoomBy(1.2)} />
        </Tooltip>
        <Tooltip content="Zoom out" relationship="label">
          <Button appearance="subtle" icon={<ZoomOut20Regular />} aria-label="Zoom out" onClick={() => zoomBy(0.8)} />
        </Tooltip>
        <Tooltip content="Reset view" relationship="label">
          <Button appearance="subtle" icon={<ArrowReset20Regular />} aria-label="Reset view" onClick={resetView} />
        </Tooltip>
        <Switch
          label="Results as JSON"
          checked={showJson}
          onChange={(_, d) => setShowJson(!!d.checked)}
        />
      </div>

      {gate && (
        <MessageBar intent={gate.gate === 'not_gremlin_account' || gate.deferred ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>
              {gate.gate === 'not_gremlin_account'
                ? 'Gremlin API not enabled on this account'
                : gate.deferred ? 'Cosmos Gremlin runtime not configured' : 'Traversal failed'}
            </MessageBarTitle>
            {gate.error}
          </MessageBarBody>
        </MessageBar>
      )}

      {showJson ? (
        <pre className={s.json} aria-label="Raw traversal response">
          {result ? JSON.stringify(result, null, 2) : '// Run a traversal to see the response.'}
        </pre>
      ) : graph.nodes.length === 0 && !gate ? (
        <div className={s.empty}>
          <Caption1>
            No vertices or edges to render. Run <code>g.V().limit(25)</code> or add a vertex to populate the graph.
          </Caption1>
        </div>
      ) : graph.nodes.length === 0 ? null : (
        <div className={s.canvasWrap}>
          <svg
            className={mergeClasses(s.svg, drag.current.active && s.svgDragging)}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`Gremlin graph: ${graph.nodes.length} vertices, ${graph.edges.length} edges`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <defs>
              <marker id="gremlin-arrow" markerWidth="10" markerHeight="10" refX="22" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill={tokens.colorNeutralForeground3} />
              </marker>
            </defs>
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
              {graph.edges.map((e, i) => {
                const a = byId.get(e.source); const b = byId.get(e.target);
                if (!a || !b) return null;
                const dim = neighborIds.size > 0 && !(neighborIds.has(e.source) && neighborIds.has(e.target));
                const active = selEdge === i;
                const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
                return (
                  <g key={`e-${i}`} onClick={() => { setSelEdge(i); setSelNode(null); }} style={{ cursor: 'pointer' }}>
                    <line
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={active ? tokens.colorBrandStroke1 : dim ? tokens.colorNeutralStroke3 : tokens.colorNeutralForeground3}
                      strokeOpacity={dim ? 0.25 : 0.75}
                      strokeWidth={active ? 2.4 : 1.4}
                      markerEnd="url(#gremlin-arrow)"
                    />
                    {e.label && !dim && (
                      <text x={mx} y={my - 3} textAnchor="middle" fontSize="9" fill={tokens.colorNeutralForeground3}>
                        {e.label}
                      </text>
                    )}
                  </g>
                );
              })}
              {layout.map((n) => {
                const dim = neighborIds.size > 0 && !neighborIds.has(n.id);
                const active = selNode === n.id;
                return (
                  <g
                    key={`n-${n.id}`}
                    onMouseEnter={() => setHoverId(n.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onClick={() => { setSelNode(n.id); setSelEdge(null); }}
                    style={{ cursor: 'pointer', opacity: dim ? 0.3 : 1 }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Vertex ${n.label || n.id}`}
                  >
                    <circle cx={n.x} cy={n.y} r={active ? 13 : 9} fill={colorFor(n.group ?? n.label)} stroke="#fff" strokeWidth={1.5} />
                    <text x={n.x} y={n.y - 15} textAnchor="middle" fontSize="11" fill={tokens.colorNeutralForeground1}>
                      {String(n.label || n.id).slice(0, 24)}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          <div className={s.side} aria-live="polite">
            {!selectedNode && !selectedEdge && (
              <Caption1>
                Click a vertex or edge to inspect it. Scroll to zoom, drag to pan.
                {' '}{graph.nodes.length} vertices · {graph.edges.length} edges.
              </Caption1>
            )}
            {selectedNode && (
              <>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{selectedNode.label || selectedNode.id}</div>
                <Caption1>id: {selectedNode.id}</Caption1>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Button size="small" appearance="secondary" icon={<BranchCompare20Regular />}
                    onClick={() => { setEFrom(selectedNode.id); setMutError(null); setAddEdgeOpen(true); }}>
                    Add edge from here
                  </Button>
                </div>
                <pre style={{ marginTop: 8, fontSize: 11, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {JSON.stringify(flattenProps(selectedNode.properties), null, 2)}
                </pre>
              </>
            )}
            {selectedEdge && (
              <>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Edge: {selectedEdge.label || '(unlabeled)'}</div>
                <Caption1>from: {selectedEdge.source}</Caption1>
                <Caption1>to: {selectedEdge.target}</Caption1>
              </>
            )}
          </div>
        </div>
      )}

      {/* Add-vertex dialog */}
      <Dialog open={addVertexOpen} onOpenChange={(_, d) => setAddVertexOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add vertex (g.addV)</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Vertex label" required>
                  <Input value={vLabel} onChange={(_, d) => setVLabel(d.value)} placeholder="person" />
                </Field>
                <Field label="Partition key value (/pk)" hint="Cosmos Gremlin graphs are partitioned; new vertices need a /pk value.">
                  <Input value={vPk} onChange={(_, d) => setVPk(d.value)} placeholder="default" />
                </Field>
                <Label>Properties</Label>
                {vProps.map((p, i) => (
                  <div key={i} className={s.propRow}>
                    <Field label={i === 0 ? 'Key' : undefined} style={{ flex: 1 }}>
                      <Input value={p.key} onChange={(_, d) => setVProps((arr) => arr.map((x, j) => j === i ? { ...x, key: d.value } : x))} placeholder="name" />
                    </Field>
                    <Field label={i === 0 ? 'Value' : undefined} style={{ flex: 1 }}>
                      <Input value={p.value} onChange={(_, d) => setVProps((arr) => arr.map((x, j) => j === i ? { ...x, value: d.value } : x))} placeholder="Ada" />
                    </Field>
                    <Button appearance="subtle" icon={<Delete16Regular />} aria-label="Remove property"
                      onClick={() => setVProps((arr) => arr.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button appearance="secondary" size="small" icon={<AddCircle20Regular />}
                  onClick={() => setVProps((arr) => [...arr, { key: '', value: '' }])}>
                  Add property
                </Button>
                {mutError && (
                  <MessageBar intent="error"><MessageBarBody>{mutError}</MessageBarBody></MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" disabled={mutating}>Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" disabled={mutating} icon={mutating ? <Spinner size="tiny" /> : <AddCircle20Regular />} onClick={submitVertex}>
                {mutating ? 'Adding…' : 'Add vertex'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Add-edge dialog */}
      <Dialog open={addEdgeOpen} onOpenChange={(_, d) => setAddEdgeOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add edge (g.addE)</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="From vertex id" required>
                  <Input value={eFrom} onChange={(_, d) => setEFrom(d.value)} placeholder="source vertex id" />
                </Field>
                <Field label="Edge label" required>
                  <Input value={eLabel} onChange={(_, d) => setELabel(d.value)} placeholder="knows" />
                </Field>
                <Field label="To vertex id" required>
                  <Input value={eTo} onChange={(_, d) => setETo(d.value)} placeholder="target vertex id" />
                </Field>
                {mutError && (
                  <MessageBar intent="error"><MessageBarBody>{mutError}</MessageBarBody></MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" disabled={mutating}>Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" disabled={mutating} icon={mutating ? <Spinner size="tiny" /> : <BranchCompare20Regular />} onClick={submitEdge}>
                {mutating ? 'Adding…' : 'Add edge'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

export default GremlinGraphCanvas;
