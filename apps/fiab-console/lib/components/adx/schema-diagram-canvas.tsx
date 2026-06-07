'use client';

/**
 * SchemaDiagramCanvas — the interactive @xyflow/react (React Flow) entity
 * diagram for a KQL Database (Azure Data Explorer). This is the Loom-native
 * parity of the Fabric Real-Time Intelligence "database schema diagram":
 * every table, materialized view, function, and external-table shortcut in the
 * live ADX database is drawn as a node, with dependency edges between them
 * (materialized-view → source table, function → referenced entity).
 *
 * Same canvas engine the pipeline / eventstream / lineage editors use
 * (lib/components/catalog/lineage-canvas.tsx, lib/components/pipeline/*); only
 * the node visuals + layout differ. The Loom Fluent-v9 theme is the only thing
 * that separates this from the schema views in the source UIs:
 *   • Fabric RTI Eventhouse — KQL database "Database" schema graph.
 *   • ADX web UI (dataexplorer.azure.com) — cluster schema tree.
 *
 * Purely presentational: it receives already-fetched nodes/edges from the KQL
 * Database editor (which calls /api/items/kql-database/[id]/schema-graph). No
 * fabricated data — an empty graph renders the honest empty-state. Inline node
 * actions (Query / Delete) are delegated up to the editor, which runs them
 * against the live ADX cluster via the existing /query route.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  Handle, Position, useReactFlow, useNodesState,
  MarkerType,
  type Node, type Edge, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Button, Caption1, Text, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  FullScreenMaximize20Regular, Organization20Regular,
  DocumentTable16Regular, Table16Regular, MathFormula16Regular, Link16Regular,
  Play16Regular, Delete16Regular,
} from '@fluentui/react-icons';

// ---------------------------------------------------------------------------
// Public model — kept in sync with the schema-graph BFF route
// (app/api/items/kql-database/[id]/schema-graph/route.ts).
// ---------------------------------------------------------------------------

export type SchemaNodeKind = 'table' | 'materialized-view' | 'function' | 'shortcut';

export interface SchemaGraphNode {
  id: string;
  kind: SchemaNodeKind;
  name: string;
  columns?: Array<{ name: string; type: string }>;
  parameters?: string;
  sourceTable?: string;
  target?: string;
  folder?: string;
}

export interface SchemaGraphEdge {
  from: string;
  to: string;
  type?: 'mv-source' | 'function-ref' | string;
}

// ---------------------------------------------------------------------------
// Kind → colour / icon / column ordering.
// ---------------------------------------------------------------------------

interface KindStyle { color: string; Icon: React.FC<{ fontSize?: number }>; label: string; col: number; }

const KIND_STYLES: Record<SchemaNodeKind, KindStyle> = {
  table: { color: 'var(--loom-accent-blue)', Icon: DocumentTable16Regular, label: 'Table', col: 0 },
  shortcut: { color: 'var(--loom-accent-emerald)', Icon: Link16Regular, label: 'Shortcut', col: 0 },
  'materialized-view': { color: 'var(--loom-accent-teal)', Icon: Table16Regular, label: 'Materialized view', col: 1 },
  function: { color: 'var(--loom-accent-violet)', Icon: MathFormula16Regular, label: 'Function', col: 2 },
};

function styleForKind(kind: SchemaNodeKind): KindStyle {
  return KIND_STYLES[kind] || KIND_STYLES.table;
}

// ---------------------------------------------------------------------------
// Custom node
// ---------------------------------------------------------------------------

const NODE_W = 240;

export interface SchemaEntityNodeData {
  node: SchemaGraphNode;
  onQuery: (name: string, kind: SchemaNodeKind) => void;
  onDelete: (name: string, kind: SchemaNodeKind) => void;
  [key: string]: unknown;
}

function SchemaEntityNodeImpl({ data, selected }: NodeProps) {
  const { node, onQuery, onDelete } = data as SchemaEntityNodeData;
  const style = styleForKind(node.kind);
  const Icon = style.Icon;
  const cols = node.columns || [];
  const shownCols = cols.slice(0, 5);

  return (
    <div
      id={`schema-node-${node.kind}-${node.name}`}
      data-schema-node-id={node.id}
      data-schema-node-kind={node.kind}
      aria-label={`${style.label} ${node.name}`}
      style={{
        position: 'relative',
        width: NODE_W,
        padding: '8px 10px',
        borderRadius: 8,
        background: tokens.colorNeutralBackground1,
        border: `1px solid ${selected ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2}`,
        borderLeft: `4px solid ${style.color}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}` : '0 1px 2px rgba(0,0,0,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 8, height: 8, background: style.color, border: 'none', left: -4 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: style.color, display: 'inline-flex' }}><Icon fontSize={16} /></span>
        <Text size={200} weight="semibold" truncate wrap={false} style={{ flex: 1 }}>{node.name}</Text>
        {/* Inline actions — className="nodrag" so the node stays draggable. */}
        <Tooltip content={node.kind === 'function' ? 'Query this function' : 'Query this entity'} relationship="label">
          <Button
            size="small" appearance="subtle" className="nodrag"
            icon={<Play16Regular />} aria-label={`Query ${node.name}`}
            data-action="query"
            onClick={(e) => { e.stopPropagation(); onQuery(node.name, node.kind); }}
            style={{ minWidth: 24, width: 24, height: 24, padding: 0 }}
          />
        </Tooltip>
        <Tooltip content={`Delete this ${style.label.toLowerCase()}`} relationship="label">
          <Button
            size="small" appearance="subtle" className="nodrag"
            icon={<Delete16Regular />} aria-label={`Delete ${node.name}`}
            data-action="delete"
            onClick={(e) => { e.stopPropagation(); onDelete(node.name, node.kind); }}
            style={{ minWidth: 24, width: 24, height: 24, padding: 0, color: tokens.colorPaletteRedForeground1 }}
          />
        </Tooltip>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{style.label}</Caption1>
        {node.kind === 'materialized-view' && node.sourceTable && (
          <Badge size="extra-small" appearance="tint" color="informative">on {node.sourceTable}</Badge>
        )}
        {node.kind === 'function' && node.parameters && (
          <Caption1 style={{ color: tokens.colorNeutralForeground4 }} title={node.parameters}>
            {node.parameters.length > 22 ? `${node.parameters.slice(0, 22)}…` : node.parameters}
          </Caption1>
        )}
        {node.kind === 'shortcut' && node.target && (
          <Badge size="extra-small" appearance="outline" color="subtle" title={node.target}>external</Badge>
        )}
      </div>

      {shownCols.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>
          {shownCols.map((c) => (
            <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
              <span style={{ color: tokens.colorNeutralForeground2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              <span style={{ color: tokens.colorNeutralForeground4, flexShrink: 0 }}>{c.type}</span>
            </div>
          ))}
          {cols.length > shownCols.length && (
            <Caption1 style={{ color: tokens.colorNeutralForeground4 }}>+{cols.length - shownCols.length} more</Caption1>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ width: 8, height: 8, background: style.color, border: 'none', right: -4 }} />
    </div>
  );
}

const nodeTypes: NodeTypes = { 'schema-entity': SchemaEntityNodeImpl };

// ---------------------------------------------------------------------------
// Deterministic columnar layout: tables/shortcuts (col 0), MVs (col 1),
// functions (col 2). No async ELK needed for a read-mostly schema graph.
// ---------------------------------------------------------------------------

const COL_GAP = 320;
const ROW_GAP = 150;

function columnarLayout(nodes: SchemaGraphNode[]): Map<string, { x: number; y: number }> {
  const byCol = new Map<number, SchemaGraphNode[]>();
  for (const n of nodes) {
    const col = styleForKind(n.kind).col;
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const maxRows = Math.max(...[...byCol.values()].map((c) => c.length), 1);
  for (const [col, list] of byCol) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    const colHeight = list.length * ROW_GAP;
    const top = (maxRows * ROW_GAP - colHeight) / 2;
    list.forEach((n, i) => pos.set(n.id, { x: col * COL_GAP, y: top + i * ROW_GAP }));
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    width: '100%',
    height: '560px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
  },
  toolbar: {
    display: 'flex', gap: '4px', alignItems: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px', padding: '4px',
  },
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: '8px', maxWidth: '360px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px', padding: '6px 8px',
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: '4px' },
  legendSwatch: { width: '10px', height: '10px', borderRadius: '2px', display: 'inline-block' },
  empty: {
    position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '6px', textAlign: 'center', padding: '24px',
  },
});

export interface SchemaDiagramCanvasProps {
  nodes: SchemaGraphNode[];
  edges: SchemaGraphEdge[];
  onQueryNode: (name: string, kind: SchemaNodeKind) => void;
  onDeleteNode: (name: string, kind: SchemaNodeKind) => void;
}

function SchemaDiagramCanvasInner({ nodes: srcNodes, edges: srcEdges, onQueryNode, onDeleteNode }: SchemaDiagramCanvasProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  const positions = useMemo(() => columnarLayout(srcNodes), [srcNodes]);

  useEffect(() => {
    setRfNodes(srcNodes.map((n) => ({
      id: n.id,
      type: 'schema-entity',
      position: positions.get(n.id) || { x: 0, y: 0 },
      data: { node: n, onQuery: onQueryNode, onDelete: onDeleteNode } as SchemaEntityNodeData,
      selected: n.id === selectedId,
    })));
  }, [srcNodes, positions, selectedId, onQueryNode, onDeleteNode, setRfNodes]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(srcNodes.map((n) => n.id));
    return srcEdges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e, i) => {
        const active = selectedId === e.from || selectedId === e.to;
        const color = active ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1;
        return {
          id: `${e.from}->${e.to}:${i}`,
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          animated: active,
          style: { stroke: color, strokeWidth: active ? 1.75 : 1, opacity: active ? 1 : 0.6 },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        } as Edge;
      });
  }, [srcEdges, srcNodes, selectedId]);

  const fit = useCallback(() => rf.fitView({ padding: 0.2, duration: 250 }), [rf]);

  const presentKinds = useMemo(() => {
    const seen = new Set<SchemaNodeKind>();
    for (const n of srcNodes) seen.add(n.kind);
    return [...seen].map((k) => ({ kind: k, ...styleForKind(k) }));
  }, [srcNodes]);

  return (
    <div className={s.shell} data-testid="schema-diagram-canvas" aria-label="KQL database entity diagram">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => setSelectedId((cur) => (cur === n.id ? null : n.id))}
        onPaneClick={() => setSelectedId(null)}
        minZoom={0.2}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />

        <Panel position="top-right">
          <div className={s.toolbar}>
            <Tooltip content="Auto-layout (tables → views → functions)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} aria-label="Auto-layout" onClick={fit} />
            </Tooltip>
            <Tooltip content="Zoom to fit" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fit} />
            </Tooltip>
          </div>
        </Panel>

        {presentKinds.length > 0 && (
          <Panel position="bottom-left">
            <div className={s.legend} aria-label="Entity legend">
              {presentKinds.map((t) => (
                <span key={t.kind} className={s.legendItem}>
                  <span className={s.legendSwatch} style={{ background: t.color }} />
                  <Caption1>{t.label}</Caption1>
                </span>
              ))}
            </div>
          </Panel>
        )}

        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => styleForKind((n.data as SchemaEntityNodeData)?.node?.kind || 'table').color}
          style={{ backgroundColor: tokens.colorNeutralBackground1 }}
        />
      </ReactFlow>

      {srcNodes.length === 0 && (
        <div className={s.empty} role="status">
          <DocumentTable16Regular fontSize={28} />
          <Text weight="semibold">No entities yet</Text>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Create a table, materialized view, or function (Home → New) and it will appear here.
          </Caption1>
        </div>
      )}
    </div>
  );
}

/** Public component — wraps the inner canvas in a ReactFlowProvider. */
export function SchemaDiagramCanvas(props: SchemaDiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <SchemaDiagramCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
