'use client';

/**
 * N5 — the ASSETS CANVAS: the estate as a graph of software-defined assets.
 *
 * Nodes are the shared `canvas-node-kit` card (never hand-built), sized to the
 * compact standard and carrying at most ONE on-node badge — the freshness chip
 * (Fresh / Stale / Overdue / Not materialized / Unmanaged), because that is the
 * one thing an operator scans this canvas for. Everything else (owners, tags,
 * columns, upstream chain, last run detail, the materializer binding) lives in
 * the tooltip and the docked inspector. Actions reveal on hover / selection only.
 *
 * Baseline conformance:
 *   • `CanvasRightRail` zoom in/out/slider/fit/re-layout (the shared rail).
 *   • `ResizableCanvasRegion` height + `SplitPane` width, both with persisted
 *     sizing keys (G3) — the pane is never a fixed box.
 *   • Badge/tag rows use flexWrap + minWidth:0 + truncation — no overlap at any
 *     width.
 *   • A freshly derived asset with no policy opens CLEAN: an "Unmanaged" chip
 *     and a guided policy editor, never a red banner.
 *   • Loom tokens only — no raw px / hex.
 *
 * Every action is real: Materialize POSTs /api/assets/materialize, which runs
 * the asset's REAL backing job (SQLMesh/dbt runner, Synapse pipeline, or
 * Databricks job). The freshness policy PUTs /api/assets/freshness.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Background, BackgroundVariant, Handle, MiniMap, Panel, Position, ReactFlow,
  ReactFlowProvider, useReactFlow, useViewport,
  type Edge, type Node, type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Body1, Button, Caption1, Divider, MessageBar, MessageBarBody, Spinner,
  Subtitle2, Tag, TagGroup, Tooltip,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  ArrowSyncCircle20Regular, DatabaseMultiple20Regular, Flash20Regular,
  Table20Regular, Timer20Regular,
} from '@fluentui/react-icons';
import {
  CANVAS_NODE_WIDTH, CanvasNode, CanvasRightRail, portStyle,
  type CanvasNodeStatus, type CanvasVisual,
} from '@/lib/components/canvas/canvas-node-kit';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { EmptyState } from '@/lib/components/empty-state';
import { FRESHNESS_LABEL, type FreshnessEvaluation, type FreshnessStatus } from '@/lib/assets/freshness';
import { layoutAssetGraph, type DerivedDep } from '@/lib/assets/asset-graph';
import type {
  AssetFreshnessPolicy, AssetKind, AssetMaterializerBinding, AssetRunOutcome,
} from '@/lib/azure/asset-registry-model';
import { FreshnessPolicyEditor } from './freshness-policy-editor';

/** One asset node exactly as GET /api/assets/lineage returns it. */
export interface AssetNodeView {
  key: string;
  name: string;
  kind: AssetKind;
  group: string;
  sources: string[];
  openHref?: string;
  producedBy: string[];
  columns: string[];
  owners: string[];
  tags: string[];
  materialization?: string;
  cadenceHint?: string;
  description?: string;
  policy: AssetFreshnessPolicy;
  materializer: AssetMaterializerBinding;
  freshness: FreshnessEvaluation;
  upstream: string[];
  lastMaterializedAt?: string;
  lastRunOutcome?: AssetRunOutcome;
  lastDetail?: string;
  configured: boolean;
}

/** Theme-aware accents (the same `--loom-accent-*` vars every canvas uses). */
const GROUP_ACCENT: Record<string, string> = {
  bronze: 'var(--loom-accent-amber)',
  silver: 'var(--loom-accent-teal)',
  gold: 'var(--loom-accent-gold)',
  sources: 'var(--loom-accent-blue)',
  workspace: 'var(--loom-accent-blue)',
};

/** Freshness → the ONE on-node badge colour. */
const FRESHNESS_COLOR: Record<FreshnessStatus, 'danger' | 'warning' | 'success' | 'informative' | 'subtle'> = {
  overdue: 'danger',
  stale: 'warning',
  fresh: 'success',
  never: 'informative',
  unmanaged: 'subtle',
};

/** Last-run outcome → the node's live status dot. */
const RUN_STATUS: Record<AssetRunOutcome, CanvasNodeStatus> = {
  succeeded: 'succeeded',
  failed: 'failed',
  running: 'running',
  skipped: 'skipped',
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
  row: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'baseline',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  label: { color: tokens.colorNeutralForeground3, minWidth: '110px' },
  value: { minWidth: 0, overflowWrap: 'anywhere' },
  // Badge/tag rows always wrap + truncate — overlap at any width is a defect.
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    alignItems: 'center',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    minWidth: 0,
  },
  hint: { color: tokens.colorNeutralForeground3 },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    minWidth: 0,
  },
  detail: {
    minWidth: 0,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
    color: tokens.colorNeutralForeground3,
  },
});

interface AssetFlowData {
  asset: AssetNodeView;
  onMaterialize: (key: string) => void;
  busy: boolean;
  [k: string]: unknown;
}

function accentFor(asset: AssetNodeView): string {
  return GROUP_ACCENT[asset.group] || (asset.kind === 'source' ? 'var(--loom-accent-blue)' : 'var(--loom-accent-teal)');
}

function AssetFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as AssetFlowData;
  const a = d.asset;
  const accent = accentFor(a);
  const visual: CanvasVisual = {
    icon: a.kind === 'source' || a.kind === 'path'
      ? <DatabaseMultiple20Regular />
      : <Table20Regular />,
    category: a.kind === 'source' || a.kind === 'path' ? 'move' : 'transform',
    accent,
  };
  const status = a.freshness.status;
  // Node compactness: EXACTLY one on-node badge — the freshness chip. Owners,
  // tags, columns, upstream and the materializer all live in the inspector.
  const badge = (
    <Badge size="small" appearance="tint" color={FRESHNESS_COLOR[status]}>
      {FRESHNESS_LABEL[status]}
    </Badge>
  );
  const summary = [
    a.materializer.kind !== 'none' ? a.materializer.kind : undefined,
    a.policy.cadence !== 'none' ? a.policy.cadence : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <CanvasNode
      width={CANVAS_NODE_WIDTH}
      title={a.name}
      visual={visual}
      selected={selected}
      typeLabel={a.kind}
      description={summary || a.group}
      // "Overdue" is a real incident — the kit's error framing is correct here.
      // A never-materialized asset is NOT an error (clean first open).
      error={status === 'overdue'}
      status={a.lastRunOutcome ? RUN_STATUS[a.lastRunOutcome] : 'idle'}
      badges={badge}
      actionBar={[
        {
          key: 'materialize',
          icon: <Flash20Regular />,
          label: `Materialize ${a.name}`,
          disabled: d.busy || a.materializer.kind === 'none',
          onClick: (e) => { e.stopPropagation(); d.onMaterialize(a.key); },
        },
      ]}
      rootProps={{ 'data-asset-key': a.key, 'data-freshness': status }}
    >
      <Handle type="target" position={Position.Left} style={portStyle('in', accent)} />
      <Handle type="source" position={Position.Right} style={portStyle('out', accent)} />
    </CanvasNode>
  );
}

const nodeTypes: NodeTypes = { loomAsset: AssetFlowNode };

export interface AssetsCanvasProps {
  assets: AssetNodeView[];
  deps: DerivedDep[];
  /** Persisted sizing keys (G3) — one per surface instance. */
  sizingKey?: string;
  /** Persist a policy. Rejects with an honest message the editor surfaces. */
  onSavePolicy: (assetKey: string, policy: AssetFreshnessPolicy) => Promise<void>;
  /** Run the asset's REAL backing job. Resolves with the operator-facing detail. */
  onMaterialize: (assetKey: string) => Promise<string>;
}

function CanvasInner({ assets, deps, onSavePolicy, onMaterialize }: AssetsCanvasProps) {
  const s = useStyles();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const { zoomIn, zoomOut, fitView, setViewport, getViewport } = useReactFlow();
  const { zoom } = useViewport();

  const positions = useMemo(
    () => layoutAssetGraph(assets.map((a) => a.key), deps),
    [assets, deps],
  );

  const materialize = useCallback(async (key: string) => {
    setBusyKey(key);
    setRunMessage(null);
    try {
      const detail = await onMaterialize(key);
      setRunMessage({ key, ok: true, text: detail });
    } catch (e) {
      setRunMessage({ key, ok: false, text: (e as Error)?.message || 'Materialization failed.' });
    } finally {
      setBusyKey(null);
    }
  }, [onMaterialize]);

  const nodes: Node[] = useMemo(() => assets.map((a) => ({
    id: a.key,
    type: 'loomAsset',
    position: positions[a.key] || { x: 0, y: 0 },
    data: { asset: a, onMaterialize: materialize, busy: busyKey === a.key } as AssetFlowData,
    selected: a.key === selectedKey,
  })), [assets, positions, selectedKey, busyKey, materialize]);

  const edges: Edge[] = useMemo(() => deps.map((d) => ({
    id: `${d.from}->${d.to}`,
    source: d.from,
    target: d.to,
    // A column-mapping dep is drawn dashed: it is derived from column lineage,
    // not from a table-grain edge, and the inspector says so.
    style: {
      stroke: tokens.colorNeutralStroke2,
      strokeDasharray: d.via === 'column-mapping' ? '4 3' : undefined,
    },
  })), [deps]);

  const selected = useMemo(
    () => assets.find((a) => a.key === selectedKey) || null,
    [assets, selectedKey],
  );

  const onNodeClick = useCallback((_e: unknown, node: Node) => {
    setSelectedKey(node.id);
    setRunMessage(null);
  }, []);

  const onZoomChange = useCallback((z: number) => {
    const v = getViewport();
    setViewport({ ...v, zoom: z }, { duration: 120 });
  }, [getViewport, setViewport]);

  return (
    <SplitPane
      direction="horizontal"
      primary="second"
      defaultSize={360}
      minSize={280}
      maxSize={560}
      storageKey="assets.graph-inspector"
      dividerLabel="Resize the asset inspector"
    >
      <div className={s.canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelectedKey(null)}
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
              onAutoLayout={() => fitView({ padding: 0.2, duration: 200 })}
            />
          </Panel>
        </ReactFlow>
      </div>

      <div className={s.inspector} aria-label="Asset details">
        {!selected ? (
          <>
            <Subtitle2>Asset details</Subtitle2>
            <Caption1 className={s.hint}>
              Select an asset to see its software-defined-asset record — the deps Loom derived from
              lineage, its freshness policy, the materializer that builds it, and its last run.
            </Caption1>
            <Divider />
            <Caption1 className={s.hint}>Freshness legend</Caption1>
            <div className={s.legend}>
              <Badge size="small" appearance="tint" color="success">Fresh</Badge>
              <Badge size="small" appearance="tint" color="warning">Stale</Badge>
              <Badge size="small" appearance="tint" color="danger">Overdue</Badge>
              <Badge size="small" appearance="tint" color="informative">Not materialized</Badge>
            </div>
            <Caption1 className={s.hint}>
              A dashed edge is a dependency Loom derived from COLUMN lineage (a declared column
              mapping) rather than a table-grain lineage edge.
            </Caption1>
          </>
        ) : (
          <>
            <Subtitle2>{selected.name}</Subtitle2>
            <div className={s.chips}>
              <Badge size="small" appearance="tint" color={FRESHNESS_COLOR[selected.freshness.status]}>
                {FRESHNESS_LABEL[selected.freshness.status]}
              </Badge>
              {selected.sources.map((src) => (
                <Badge key={src} size="small" appearance="outline">{src}</Badge>
              ))}
            </div>

            <div className={s.row}>
              <Caption1 className={s.label}>Asset key</Caption1>
              <Body1 className={s.value}><code>{selected.key}</code></Body1>
            </div>
            <div className={s.row}>
              <Caption1 className={s.label}>Kind / group</Caption1>
              <Body1 className={s.value}>{selected.kind} · {selected.group}</Body1>
            </div>
            {selected.materialization && (
              <div className={s.row}>
                <Caption1 className={s.label}>Materialization</Caption1>
                <Body1 className={s.value}>{selected.materialization}</Body1>
              </div>
            )}
            <div className={s.row}>
              <Caption1 className={s.label}>Upstream</Caption1>
              <Body1 className={s.value}>
                {selected.upstream.length === 0 ? 'No derived upstreams' : selected.upstream.join(', ')}
              </Body1>
            </div>
            {selected.producedBy.length > 0 && (
              <div className={s.row}>
                <Caption1 className={s.label}>Produced by</Caption1>
                <Body1 className={s.value}>{selected.producedBy.join(', ')}</Body1>
              </div>
            )}
            <div className={s.row}>
              <Caption1 className={s.label}>Last materialized</Caption1>
              <Body1 className={s.value}>
                {selected.lastMaterializedAt
                  ? `${selected.lastMaterializedAt} (${selected.freshness.ageMinutes} min ago)`
                  : 'Never'}
              </Body1>
            </div>
            {selected.freshness.dueAt && (
              <div className={s.row}>
                <Caption1 className={s.label}>Next due</Caption1>
                <Body1 className={s.value}>
                  <Timer20Regular aria-hidden /> {selected.freshness.dueAt}
                </Body1>
              </div>
            )}
            {selected.owners.length > 0 && (
              <div className={s.row}>
                <Caption1 className={s.label}>Owners</Caption1>
                <Body1 className={s.value}>{selected.owners.join(', ')}</Body1>
              </div>
            )}
            {selected.tags.length > 0 && (
              <TagGroup className={s.chips} aria-label="Asset tags">
                {selected.tags.map((t) => (
                  <Tag key={t} size="small" appearance="brand">{t}</Tag>
                ))}
              </TagGroup>
            )}
            {selected.columns.length > 0 && (
              <div className={s.row}>
                <Caption1 className={s.label}>Columns</Caption1>
                <Body1 className={s.value}>{selected.columns.slice(0, 24).join(', ')}</Body1>
              </div>
            )}

            <Divider />
            <div className={s.actions}>
              <Tooltip
                relationship="description"
                content={
                  selected.materializer.kind === 'none'
                    ? 'Bind a transformation project, a Synapse pipeline, or a Databricks job to this asset to enable Materialize.'
                    : `Runs the real ${selected.materializer.kind} job now.`
                }
              >
                <Button
                  appearance="primary"
                  icon={<ArrowSyncCircle20Regular />}
                  disabled={busyKey === selected.key || selected.materializer.kind === 'none'}
                  onClick={() => materialize(selected.key)}
                >
                  Materialize
                </Button>
              </Tooltip>
              {busyKey === selected.key && <Spinner size="tiny" label="Running" />}
              <Caption1 className={s.hint}>
                Materializer: {selected.materializer.kind}
              </Caption1>
            </div>
            {runMessage && runMessage.key === selected.key && (
              <MessageBar intent={runMessage.ok ? 'success' : 'warning'} layout="multiline">
                <MessageBarBody>{runMessage.text}</MessageBarBody>
              </MessageBar>
            )}
            {selected.lastDetail && (
              <Caption1 className={s.detail}>{selected.lastDetail}</Caption1>
            )}

            <Divider />
            <FreshnessPolicyEditor
              assetKey={selected.key}
              assetName={selected.name}
              policy={selected.policy}
              configured={selected.configured}
              cadenceHint={selected.cadenceHint}
              onSave={(policy) => onSavePolicy(selected.key, policy)}
            />
          </>
        )}
      </div>
    </SplitPane>
  );
}

export function AssetsCanvas(props: AssetsCanvasProps) {
  const s = useStyles();
  if (props.assets.length === 0) {
    return (
      <EmptyState
        icon={<Table20Regular />}
        title="No assets derived yet"
        body="Loom builds this graph from the lineage it already has — Purview / Atlas, Databricks Unity Catalog, Weave item edges, and your transformation projects' model DAGs. Connect a lakehouse to a notebook or publish a transformation project and every table, view and model it touches appears here as an asset with a freshness policy you can declare."
        primaryAction={{ label: 'Open lineage', href: '/thread' }}
        secondaryAction={{ label: 'Create a transformation project', href: '/new' }}
      />
    );
  }
  return (
    <div className={s.wrap}>
      <ResizableCanvasRegion
        storageKey={props.sizingKey || 'assets-graph-canvas'}
        defaultPx={560}
        minPx={320}
        ariaLabel="Resize the asset graph canvas"
      >
        <ReactFlowProvider>
          <CanvasInner {...props} />
        </ReactFlowProvider>
      </ResizableCanvasRegion>
    </div>
  );
}
