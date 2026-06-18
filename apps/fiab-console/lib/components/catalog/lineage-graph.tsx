'use client';

/**
 * LineageGraph — force-directed (radial) lineage visualization. Renders
 * the lineage subgraph returned by /api/catalog/lineage using pure SVG.
 *
 * We intentionally avoid heavy dependencies (D3, vis-network) — the
 * console already ships Monaco + Fluent UI + MSAL and bundle budget
 * is tight. A simple radial layout from a focus node is sufficient
 * for the lineage we render today; future iterations may swap in d3-force
 * if rich interactivity is needed.
 */
import { useEffect, useState } from 'react';
import { Spinner, Caption1, MessageBar, MessageBarBody, makeStyles, tokens } from '@fluentui/react-components';
import { BranchFork16Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

interface Node { id: string; label: string; type?: string; source: string; }
interface Edge { from: string; to: string; type?: string; }

interface Props {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  host?: string;
  workspaceId?: string;
}

const useStyles = makeStyles({
  wrap: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, padding: 12, position: 'relative' },
});

export function LineageGraph({ source, id, host, workspaceId }: Props) {
  const s = useStyles();
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setHint(null);
    const params = new URLSearchParams({ source, id });
    if (host) params.set('host', host);
    if (workspaceId) params.set('workspaceId', workspaceId);
    fetch(`/api/catalog/lineage?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) { setError(j.error); setHint(j.hint); return; }
        setData({ nodes: j.nodes, edges: j.edges });
      })
      .catch((e) => { if (alive) setError(e?.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, id, host, workspaceId]);

  if (loading) return <Spinner label="Resolving lineage…" />;
  if (error) return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <strong>Lineage unavailable:</strong> {error}
        {hint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}
      </MessageBarBody>
    </MessageBar>
  );
  if (!data || data.nodes.length === 0) return (
    <EmptyState
      icon={<BranchFork16Regular />}
      title="No lineage edges"
      body="No upstream or downstream lineage was recorded for this asset. Run a Purview scan, trigger a Databricks job, or publish a pipeline to build lineage."
    />
  );

  // Radial layout around the focus node (or the first node).
  const focusIdx = Math.max(0, data.nodes.findIndex((n) => n.id === id));
  const others = data.nodes.filter((_, i) => i !== focusIdx);
  const cx = 280, cy = 200, r = 140;
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(data.nodes[focusIdx].id, { x: cx, y: cy });
  others.forEach((n, i) => {
    const angle = (i / Math.max(1, others.length)) * 2 * Math.PI;
    positions.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  });

  return (
    <div className={s.wrap}>
      <svg width="560" height="400" role="img" aria-label="Lineage graph">
        {data.edges.map((e, i) => {
          const a = positions.get(e.from); const b = positions.get(e.to);
          if (!a || !b) return null;
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={tokens.colorNeutralStroke1} strokeWidth="1.5" markerEnd="url(#arr)"
            />
          );
        })}
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={tokens.colorNeutralStroke1} />
          </marker>
        </defs>
        {data.nodes.map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const isFocus = n.id === id;
          return (
            <g key={n.id} transform={`translate(${p.x}, ${p.y})`}>
              <circle r={isFocus ? 12 : 8} fill={isFocus ? tokens.colorBrandBackground : tokens.colorNeutralBackground3} stroke={tokens.colorBrandStroke1} strokeWidth="1.5" />
              <text x="14" y="4" fontSize="11" fill={tokens.colorNeutralForeground1}>
                {n.label.slice(0, 32)}
              </text>
              <title>{`${n.source} · ${n.type || '?'} · ${n.id}`}</title>
            </g>
          );
        })}
      </svg>
      <Caption1>{data.nodes.length} nodes · {data.edges.length} edges</Caption1>
    </div>
  );
}
