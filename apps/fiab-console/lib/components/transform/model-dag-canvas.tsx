/**
 * N4 part 3 — the transformation model DAG as SOFTWARE-DEFINED ASSETS.
 *
 * Renders the node/edge shape emitted by `lib/transform/transform-dag.ts` (the
 * exported, UI-free contract N5's asset plane consumes) on the shared
 * `canvas-node-kit`:
 *
 *   • Compact nodes (`CANVAS_NODE_WIDTH`, 2 rows: glyph chip + truncated name,
 *     type/summary caption, status dot) — never a heavy color band.
 *   • At most ONE on-node badge: the plan-impact chip when a plan has been
 *     previewed, otherwise the medallion layer. Everything else lives in the
 *     tooltip + the asset inspector.
 *   • Actions reveal on hover/selection only (the kit's floating action bar).
 *   • Shared `CanvasRightRail` (zoom in/out/slider/fit/auto-layout) and a
 *     `ResizableCanvasRegion` height + `SplitPane` width (G3).
 *
 * The canvas is a VIEW over the project: selecting a node opens the asset
 * inspector (key, group, owners, tags, materialization, cadence, upstream /
 * downstream counts, and the plan impact) — the same record N5 will catalog.
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, Handle, MiniMap, Panel, Position, ReactFlow,
  ReactFlowProvider, useReactFlow, useViewport,
  type Edge, type Node, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Body1, Caption1, Divider, Subtitle2, Tag, TagGroup, Text,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  DatabaseMultiple20Regular, Table20Regular,
} from '@fluentui/react-icons';
import {
  CANVAS_NODE_WIDTH, CanvasNode, CanvasRightRail, accentTint, portStyle,
  type CanvasVisual,
} from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import type { ImpactSeverity } from '@/lib/transform/plan-impact';
import {
  downstreamClosure, layoutTransformDag, type TransformDag, type TransformDagNode,
} from '@/lib/transform/transform-dag';

// Theme-aware medallion accents (the same `--loom-accent-*` CSS vars the dbt
// graph + lineage canvas use — no raw hex).
const LAYER_ACCENT: Record<string, string> = {
  bronze: 'var(--loom-accent-amber)',
  silver: 'var(--loom-accent-teal)',
  gold: 'var(--loom-accent-gold)',
  sources: 'var(--loom-accent-blue)',
};

/** Impact severity → the ONE on-node badge colour + label. */
const SEVERITY_BADGE: Record<ImpactSeverity, { label: string; color: 'danger' | 'warning' | 'success' | 'informative' }> = {
  breaking: { label: 'Breaking', color: 'danger' },
  'forward-only': { label: 'Forward-only', color: 'warning' },
  'non-breaking': { label: 'Additive', color: 'success' },
  metadata: { label: 'Metadata', color: 'informative' },
};

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  canvas: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    overflow: 'hidden',
  },
  inspector: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 },
  label: { color: tokens.colorNeutralForeground3, minWidth: '104px' },
  value: { minWidth: 0, overflowWrap: 'anywhere' },
  // Badge/tag rows always wrap + truncate — overlap at any width is a defect.
  tags: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  legend: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS,
    alignItems: 'center', minWidth: 0,
  },
});

interface DagNodeData {
  node: TransformDagNode;
  [k: string]: unknown;
}

function accentFor(node: TransformDagNode): string {
  if (node.kind === 'source') return LAYER_ACCENT.sources;
  return LAYER_ACCENT[node.layer || ''] || tokens.colorNeutralStroke2;
}

function AssetFlowNode({ data, selected }: NodeProps) {
  const d = (data as unknown as DagNodeData).node;
  const accent = accentFor(d);
  const visual: CanvasVisual = {
    icon: d.kind === 'source' ? <DatabaseMultiple20Regular /> : <Table20Regular />,
    category: d.kind === 'source' ? 'move' : 'transform',
    accent,
  };
  const sev = d.impact ? SEVERITY_BADGE[d.impact.severity] : null;
  // Node compactness: exactly ONE on-node badge. When a plan is loaded the
  // impact chip takes that slot (it is the thing the operator is scanning for);
  // otherwise it shows the asset group. Everything else → tooltip + inspector.
  const badge = sev
    ? <Badge size="small" appearance="tint" color={sev.color}>{sev.label}</Badge>
    : (
      <Badge
        size="small"
        appearance="tint"
        style={{ backgroundColor: accentTint(accent, 16), color: accent, borderColor: accentTint(accent, 32) }}
      >
        {d.asset.group}
      </Badge>
    );
  const summary = d.kind === 'source'
    ? d.schema
    : [d.asset.materialization, d.asset.cadence].filter(Boolean).join(' · ');
  return (
    <CanvasNode
      width={CANVAS_NODE_WIDTH}
      title={d.name}
      visual={visual}
      selected={selected}
      typeLabel={d.kind === 'source' ? 'Source' : (d.layer || 'model')}
      description={summary || undefined}
      error={d.impact?.severity === 'breaking'}
      badges={badge}
      rootProps={{ 'data-asset-key': d.asset.key }}
    >
      {d.kind !== 'source' && (
        <Handle type="target" position={Position.Left} style={portStyle('in', accent)} />
      )}
      <Handle type="source" position={Position.Right} style={portStyle('out', accent)} />
    </CanvasNode>
  );
}

const nodeTypes: NodeTypes = { transformAsset: AssetFlowNode };

export interface ModelDagCanvasProps {
  dag: TransformDag;
  /** Persisted sizing keys (G3) — one per surface instance. */
  sizingKey?: string;
  /** Fired when a node is selected so the host can cross-link the impact grid. */
  onSelectAsset?: (node: TransformDagNode | null) => void;
}

function DagInner({ dag, onSelectAsset }: ModelDagCanvasProps) {
  const s = useStyles();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { zoomIn, zoomOut, fitView, setViewport, getViewport } = useReactFlow();
  const { zoom } = useViewport();

  const positions = useMemo(() => layoutTransformDag(dag), [dag]);

  const nodes: Node[] = useMemo(() => dag.nodes.map((n) => ({
    id: n.id,
    type: 'transformAsset',
    position: positions[n.id] || { x: 0, y: 0 },
    data: { node: n } as DagNodeData,
    selected: n.id === selectedId,
  })), [dag, positions, selectedId]);

  const edges: Edge[] = useMemo(() => dag.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: !!e.impacted,
    style: {
      stroke: e.impacted ? tokens.colorPaletteRedBorder2 : tokens.colorNeutralStroke2,
      strokeDasharray: e.kind === 'source' ? '4 3' : undefined,
    },
  })), [dag]);

  const selected = useMemo(
    () => dag.nodes.find((n) => n.id === selectedId) || null,
    [dag, selectedId],
  );
  const blastRadius = useMemo(
    () => (selected ? downstreamClosure(dag, selected.id) : []),
    [dag, selected],
  );

  const onNodeClick = useCallback((_e: unknown, node: Node) => {
    setSelectedId(node.id);
    onSelectAsset?.(dag.nodes.find((n) => n.id === node.id) || null);
  }, [dag, onSelectAsset]);

  const onAutoLayout = useCallback(() => {
    // The layered layout is deterministic, so "auto layout" re-centers it.
    fitView({ padding: 0.2, duration: 200 });
  }, [fitView]);

  const onZoomChange = useCallback((z: number) => {
    const v = getViewport();
    setViewport({ ...v, zoom: z }, { duration: 120 });
  }, [getViewport, setViewport]);

  return (
    <SplitPane
      direction="horizontal"
      primary="second"
      defaultSize={320}
      minSize={240}
      maxSize={520}
      storageKey="transform.model-dag"
      dividerLabel="Resize the asset inspector"
    >
      <div className={s.canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => { setSelectedId(null); onSelectAsset?.(null); }}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.25}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <MiniMap pannable zoomable />
          <Panel position="bottom-right">
            <CanvasRightRail
              zoom={zoom}
              onZoomChange={onZoomChange}
              onZoomIn={() => zoomIn({ duration: 120 })}
              onZoomOut={() => zoomOut({ duration: 120 })}
              onFit={() => fitView({ padding: 0.2, duration: 200 })}
              onAutoLayout={onAutoLayout}
            />
          </Panel>
        </ReactFlow>
      </div>

      <div className={s.inspector} aria-label="Asset details">
        {!selected ? (
          <>
            <Subtitle2>Asset details</Subtitle2>
            <Caption1 className={s.hint}>
              Select a node to see its software-defined-asset record — key, owners, tags,
              materialization, refresh cadence, and the blast radius a change would have.
            </Caption1>
            <Divider />
            <Caption1 className={s.hint}>Legend</Caption1>
            <div className={s.legend}>
              <Badge size="small" appearance="tint" color="danger">Breaking</Badge>
              <Badge size="small" appearance="tint" color="warning">Forward-only</Badge>
              <Badge size="small" appearance="tint" color="success">Additive</Badge>
              <Badge size="small" appearance="tint" color="informative">Metadata</Badge>
            </div>
          </>
        ) : (
          <>
            <Subtitle2>{selected.name}</Subtitle2>
            <div className={s.row}>
              <Caption1 className={s.label}>Asset key</Caption1>
              <Body1 className={s.value}><code>{selected.asset.key}</code></Body1>
            </div>
            <div className={s.row}>
              <Caption1 className={s.label}>Group</Caption1>
              <Body1 className={s.value}>{selected.asset.group}</Body1>
            </div>
            <div className={s.row}>
              <Caption1 className={s.label}>Engine</Caption1>
              <Body1 className={s.value}>{selected.backend === 'sqlmesh' ? 'SQLMesh' : 'dbt'}</Body1>
            </div>
            {selected.asset.materialization && (
              <div className={s.row}>
                <Caption1 className={s.label}>Materialization</Caption1>
                <Body1 className={s.value}>{selected.asset.materialization}</Body1>
              </div>
            )}
            {selected.asset.cadence && (
              <div className={s.row}>
                <Caption1 className={s.label}>Cadence</Caption1>
                <Body1 className={s.value}>{selected.asset.cadence}</Body1>
              </div>
            )}
            <div className={s.row}>
              <Caption1 className={s.label}>Owners</Caption1>
              <Body1 className={s.value}>{selected.asset.owners.length ? selected.asset.owners.join(', ') : 'Unassigned'}</Body1>
            </div>
            {selected.asset.tags.length > 0 && (
              <TagGroup className={s.tags} aria-label="Asset tags">
                {selected.asset.tags.map((t) => (
                  <Tag key={t} size="small" appearance="brand">{t}</Tag>
                ))}
              </TagGroup>
            )}
            {selected.asset.description && (
              <Caption1 className={s.value}>{selected.asset.description}</Caption1>
            )}
            <Divider />
            <div className={s.row}>
              <Caption1 className={s.label}>Upstream</Caption1>
              <Body1 className={s.value}>{selected.upstream}</Body1>
            </div>
            <div className={s.row}>
              <Caption1 className={s.label}>Direct downstream</Caption1>
              <Body1 className={s.value}>{selected.downstream}</Body1>
            </div>
            <div className={s.row}>
              <Caption1 className={s.label}>Blast radius</Caption1>
              <Body1 className={s.value}>
                {blastRadius.length === 0 ? 'No downstream models' : `${blastRadius.length} model${blastRadius.length === 1 ? '' : 's'}`}
              </Body1>
            </div>
            {blastRadius.length > 0 && (
              <Caption1 className={s.value}>{blastRadius.join(', ')}</Caption1>
            )}
            {selected.impact && (
              <>
                <Divider />
                <div className={s.row}>
                  <Caption1 className={s.label}>Plan impact</Caption1>
                  <Badge size="small" appearance="tint" color={SEVERITY_BADGE[selected.impact.severity].color}>
                    {SEVERITY_BADGE[selected.impact.severity].label}
                  </Badge>
                  <Text>{selected.impact.changeType}</Text>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </SplitPane>
  );
}

export function ModelDagCanvas({ dag, sizingKey = 'transform-model-dag', onSelectAsset }: ModelDagCanvasProps) {
  const s = useStyles();
  if (dag.nodes.length === 0) {
    return (
      <EmptyState
        icon={<Table20Regular />}
        title="No models yet"
        body="Add a source and a model on the Build tab and the DAG appears here — every node is a software-defined asset with an owner, tags, a materialization, and a refresh cadence. Plan the project and this canvas paints the blast radius of each change."
      />
    );
  }
  return (
    <div className={s.wrap}>
      <ResizableCanvasRegion
        storageKey={sizingKey}
        defaultPx={520}
        minPx={320}
        ariaLabel="Resize the model DAG canvas"
      >
        <ReactFlowProvider>
          <DagInner dag={dag} onSelectAsset={onSelectAsset} />
        </ReactFlowProvider>
      </ResizableCanvasRegion>
    </div>
  );
}
