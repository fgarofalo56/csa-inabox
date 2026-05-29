/**
 * CSA Loom — Eventstream visual designer
 *
 * Renders the Eventstream pipeline as a left→right flow of node cards:
 *   [Source 1]  ┐
 *   [Source 2]  ┼─► [Transform 1] ──► [Transform 2] ──► [Sink]
 *
 * Operators click "Add source", "Add transform", "Add destination" in the
 * editor ribbon (or in the canvas itself) to grow the graph. Selecting a
 * node opens an inline form on the right that edits real config keys
 * (eventhub namespace, kusto table, filter expression, etc.) — no JSON
 * editing required for the common path. The Save action serializes back
 * to the same { source, transforms[], sink } shape that the BFF persists
 * to Cosmos, so the visual designer is wire-compatible with the existing
 * /api/items/eventstream/[id] route.
 *
 * Per no-vaporware.md: no mock arrays. The config is real Cosmos state.
 * The runtime (Event Hubs → Kusto ingestion executor) is gated by a
 * MessageBar in the parent editor; this component does NOT pretend to
 * publish.
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Button,
  Badge,
  Caption1,
  Input,
  Dropdown,
  Option,
  Textarea,
  Label,
  Field,
  tokens,
  makeStyles,
  shorthands,
} from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  ArrowRight20Regular,
} from '@fluentui/react-icons';

// ============================================================
// Types
// ============================================================

export type SourceKind = 'eventhub' | 'iothub' | 'sample' | 'cdc-mirror' | 'kafka';
export type TransformKind = 'filter' | 'aggregate' | 'group-by' | 'project' | 'union' | 'join';
export type SinkKind = 'kusto' | 'lakehouse' | 'eventhub' | 'reflex' | 'derivedStream';

export interface SourceNode {
  kind: SourceKind;
  name: string;
  namespace?: string;
  consumerGroup?: string;
  iotHub?: string;
  connectionString?: string;
  topic?: string;
}

export interface TransformNode {
  kind: TransformKind;
  name: string;
  expression?: string;
  columns?: string[];
  groupBy?: string[];
  window?: string;
}

export interface SinkNode {
  kind: SinkKind;
  name: string;
  database?: string;
  table?: string;
  lakehouseId?: string;
  workspaceId?: string;
  reflexId?: string;
}

export interface PipelineConfig {
  sources?: SourceNode[];
  source?: SourceNode; // legacy single-source
  transforms?: TransformNode[];
  sink?: SinkNode;
  sinks?: SinkNode[];
}

export type SelectedNode =
  | { type: 'source'; idx: number }
  | { type: 'transform'; idx: number }
  | { type: 'sink'; idx: number }
  | null;

// ============================================================
// Styles
// ============================================================

const useStyles = makeStyles({
  designer: {
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: tokens.spacingHorizontalL,
    minHeight: '480px',
  },
  canvas: {
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    overflowX: 'auto',
    minHeight: '440px',
  },
  flow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minHeight: '440px',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: '180px',
  },
  columnLabel: {
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    fontSize: tokens.fontSizeBase200,
    marginBottom: tokens.spacingVerticalXS,
  },
  node: {
    cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalM, tokens.spacingHorizontalM),
    minWidth: '160px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    transition: 'border-color 0.15s',
    ':hover': {
      ...shorthands.borderColor(tokens.colorBrandStroke1),
    },
  },
  nodeSelected: {
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    boxShadow: tokens.shadow4Brand,
  },
  nodeTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  nodeSubtitle: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  arrow: {
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    alignItems: 'center',
  },
  inspector: {
    backgroundColor: tokens.colorNeutralBackground1,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.padding(tokens.spacingVerticalL, tokens.spacingHorizontalL),
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minHeight: '440px',
  },
  inspectorEmpty: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  addButtons: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalM,
  },
});

// ============================================================
// Component
// ============================================================

export interface VisualDesignerProps {
  config: PipelineConfig;
  onChange: (next: PipelineConfig) => void;
}

function normalizeSources(c: PipelineConfig): SourceNode[] {
  if (Array.isArray(c.sources) && c.sources.length) return c.sources;
  if (c.source) return [c.source];
  return [];
}

function normalizeSinks(c: PipelineConfig): SinkNode[] {
  if (Array.isArray(c.sinks) && c.sinks.length) return c.sinks;
  if (c.sink) return [c.sink];
  return [];
}

export function VisualDesigner({ config, onChange }: VisualDesignerProps) {
  const s = useStyles();
  const [selected, setSelected] = useState<SelectedNode>(null);

  const sources = useMemo(() => normalizeSources(config), [config]);
  const sinks = useMemo(() => normalizeSinks(config), [config]);
  const transforms = config.transforms || [];

  const commit = useCallback(
    (next: Partial<PipelineConfig>) => {
      onChange({
        sources,
        transforms,
        sinks,
        // legacy projection
        source: sources[0],
        sink: sinks[0],
        ...next,
      });
    },
    [onChange, sources, transforms, sinks],
  );

  // ---- Add ----
  const addSource = useCallback(() => {
    const next: SourceNode = {
      kind: 'eventhub',
      name: `source-${sources.length + 1}`,
      namespace: '',
      consumerGroup: '$Default',
    };
    const updated = [...sources, next];
    commit({ sources: updated, source: updated[0] });
    setSelected({ type: 'source', idx: updated.length - 1 });
  }, [sources, commit]);

  const addTransform = useCallback(() => {
    const next: TransformNode = {
      kind: 'filter',
      name: `transform-${transforms.length + 1}`,
      expression: '',
    };
    const updated = [...transforms, next];
    commit({ transforms: updated });
    setSelected({ type: 'transform', idx: updated.length - 1 });
  }, [transforms, commit]);

  const addSink = useCallback(() => {
    const next: SinkNode = {
      kind: 'kusto',
      name: `sink-${sinks.length + 1}`,
      database: 'loomdb-default',
      table: '',
    };
    const updated = [...sinks, next];
    commit({ sinks: updated, sink: updated[0] });
    setSelected({ type: 'sink', idx: updated.length - 1 });
  }, [sinks, commit]);

  // ---- Update node ----
  const updateSource = useCallback(
    (idx: number, patch: Partial<SourceNode>) => {
      const updated = sources.map((n, i) => (i === idx ? { ...n, ...patch } : n));
      commit({ sources: updated, source: updated[0] });
    },
    [sources, commit],
  );
  const updateTransform = useCallback(
    (idx: number, patch: Partial<TransformNode>) => {
      const updated = transforms.map((n, i) => (i === idx ? { ...n, ...patch } : n));
      commit({ transforms: updated });
    },
    [transforms, commit],
  );
  const updateSink = useCallback(
    (idx: number, patch: Partial<SinkNode>) => {
      const updated = sinks.map((n, i) => (i === idx ? { ...n, ...patch } : n));
      commit({ sinks: updated, sink: updated[0] });
    },
    [sinks, commit],
  );

  // ---- Delete ----
  const deleteSelected = useCallback(() => {
    if (!selected) return;
    if (selected.type === 'source') {
      const updated = sources.filter((_, i) => i !== selected.idx);
      commit({ sources: updated, source: updated[0] });
    } else if (selected.type === 'transform') {
      const updated = transforms.filter((_, i) => i !== selected.idx);
      commit({ transforms: updated });
    } else if (selected.type === 'sink') {
      const updated = sinks.filter((_, i) => i !== selected.idx);
      commit({ sinks: updated, sink: updated[0] });
    }
    setSelected(null);
  }, [selected, sources, transforms, sinks, commit]);

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className={s.designer} role="region" aria-label="Eventstream visual designer">
      <div className={s.canvas} data-canvas="eventstream" aria-label="Pipeline canvas">
        <div className={s.addButtons} data-palette="eventstream" role="toolbar" aria-label="Node palette">
          <Button icon={<Add20Regular />} onClick={addSource} aria-label="Add source" data-palette-item="source">
            Add source
          </Button>
          <Button icon={<Add20Regular />} onClick={addTransform} aria-label="Add transform" data-palette-item="transform">
            Add transform
          </Button>
          <Button icon={<Add20Regular />} onClick={addSink} aria-label="Add destination" data-palette-item="destination">
            Add destination
          </Button>
        </div>

        <div className={s.flow} data-flow="true">
          <div className={s.column}>
            <Caption1 className={s.columnLabel}>Sources</Caption1>
            {sources.length === 0 && <Caption1 className={s.inspectorEmpty}>(none)</Caption1>}
            {sources.map((src, idx) => (
              <div
                key={`src-${idx}`}
                role="button"
                tabIndex={0}
                className={`${s.node} ${selected?.type === 'source' && selected.idx === idx ? s.nodeSelected : ''}`}
                onClick={() => setSelected({ type: 'source', idx })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelected({ type: 'source', idx });
                }}
                aria-label={`Source ${src.name}`}
                aria-pressed={selected?.type === 'source' && selected.idx === idx}
              >
                <span className={s.nodeTitle}>{src.name}</span>
                <Badge size="small" appearance="outline">
                  {src.kind}
                </Badge>
                {src.namespace && <Caption1 className={s.nodeSubtitle}>{src.namespace}</Caption1>}
              </div>
            ))}
          </div>

          {sources.length > 0 && (transforms.length > 0 || sinks.length > 0) && (
            <span className={s.arrow} aria-hidden="true">
              <ArrowRight20Regular />
            </span>
          )}

          <div className={s.column}>
            <Caption1 className={s.columnLabel}>Transforms</Caption1>
            {transforms.length === 0 && <Caption1 className={s.inspectorEmpty}>(none)</Caption1>}
            {transforms.map((tr, idx) => (
              <div
                key={`tr-${idx}`}
                role="button"
                tabIndex={0}
                className={`${s.node} ${selected?.type === 'transform' && selected.idx === idx ? s.nodeSelected : ''}`}
                onClick={() => setSelected({ type: 'transform', idx })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelected({ type: 'transform', idx });
                }}
                aria-label={`Transform ${tr.name}`}
                aria-pressed={selected?.type === 'transform' && selected.idx === idx}
              >
                <span className={s.nodeTitle}>{tr.name}</span>
                <Badge size="small" appearance="outline">
                  {tr.kind}
                </Badge>
                {tr.expression && (
                  <Caption1 className={s.nodeSubtitle}>
                    {tr.expression.length > 32 ? tr.expression.slice(0, 32) + '…' : tr.expression}
                  </Caption1>
                )}
              </div>
            ))}
          </div>

          {(transforms.length > 0 || sources.length > 0) && sinks.length > 0 && (
            <span className={s.arrow} aria-hidden="true">
              <ArrowRight20Regular />
            </span>
          )}

          <div className={s.column}>
            <Caption1 className={s.columnLabel}>Destinations</Caption1>
            {sinks.length === 0 && <Caption1 className={s.inspectorEmpty}>(none)</Caption1>}
            {sinks.map((sk, idx) => (
              <div
                key={`sk-${idx}`}
                role="button"
                tabIndex={0}
                className={`${s.node} ${selected?.type === 'sink' && selected.idx === idx ? s.nodeSelected : ''}`}
                onClick={() => setSelected({ type: 'sink', idx })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelected({ type: 'sink', idx });
                }}
                aria-label={`Destination ${sk.name}`}
                aria-pressed={selected?.type === 'sink' && selected.idx === idx}
              >
                <span className={s.nodeTitle}>{sk.name}</span>
                <Badge size="small" appearance="outline">
                  {sk.kind}
                </Badge>
                {sk.table && <Caption1 className={s.nodeSubtitle}>{sk.table}</Caption1>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <aside className={s.inspector} aria-label="Node properties">
        {!selected && (
          <Caption1 className={s.inspectorEmpty}>
            Select a node to edit its properties, or click Add source / Add transform / Add
            destination to grow the pipeline.
          </Caption1>
        )}

        {selected?.type === 'source' && sources[selected.idx] && (
          <SourceInspector
            value={sources[selected.idx]}
            onChange={(patch) => updateSource(selected.idx, patch)}
            onDelete={deleteSelected}
          />
        )}

        {selected?.type === 'transform' && transforms[selected.idx] && (
          <TransformInspector
            value={transforms[selected.idx]}
            onChange={(patch) => updateTransform(selected.idx, patch)}
            onDelete={deleteSelected}
          />
        )}

        {selected?.type === 'sink' && sinks[selected.idx] && (
          <SinkInspector
            value={sinks[selected.idx]}
            onChange={(patch) => updateSink(selected.idx, patch)}
            onDelete={deleteSelected}
          />
        )}
      </aside>
    </div>
  );
}

// ============================================================
// Inspector components
// ============================================================

function SourceInspector({
  value,
  onChange,
  onDelete,
}: {
  value: SourceNode;
  onChange: (p: Partial<SourceNode>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Label weight="semibold">Source</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Kind">
        <Dropdown
          value={value.kind}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) => onChange({ kind: (d.optionValue as SourceKind) || 'eventhub' })}
        >
          <Option value="eventhub">Event Hubs</Option>
          <Option value="iothub">IoT Hub</Option>
          <Option value="kafka">Kafka</Option>
          <Option value="cdc-mirror">CDC Mirror</Option>
          <Option value="sample">Sample data</Option>
        </Dropdown>
      </Field>
      {(value.kind === 'eventhub' || value.kind === 'kafka') && (
        <>
          <Field label="Namespace">
            <Input
              value={value.namespace || ''}
              placeholder="my-eventhub-ns"
              onChange={(_: unknown, d: any) => onChange({ namespace: d.value })}
            />
          </Field>
          <Field label="Consumer group">
            <Input
              value={value.consumerGroup || '$Default'}
              onChange={(_: unknown, d: any) => onChange({ consumerGroup: d.value })}
            />
          </Field>
        </>
      )}
      {value.kind === 'iothub' && (
        <Field label="IoT Hub name">
          <Input value={value.iotHub || ''} onChange={(_: unknown, d: any) => onChange({ iotHub: d.value })} />
        </Field>
      )}
      {value.kind === 'kafka' && (
        <Field label="Topic">
          <Input value={value.topic || ''} onChange={(_: unknown, d: any) => onChange({ topic: d.value })} />
        </Field>
      )}
      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 'auto' }}
      >
        Remove source
      </Button>
    </>
  );
}

function TransformInspector({
  value,
  onChange,
  onDelete,
}: {
  value: TransformNode;
  onChange: (p: Partial<TransformNode>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Label weight="semibold">Transform</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Kind">
        <Dropdown
          value={value.kind}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) =>
            onChange({ kind: (d.optionValue as TransformKind) || 'filter' })
          }
        >
          <Option value="filter">Filter</Option>
          <Option value="aggregate">Aggregate</Option>
          <Option value="group-by">Group by</Option>
          <Option value="project">Project</Option>
          <Option value="union">Union</Option>
          <Option value="join">Join</Option>
        </Dropdown>
      </Field>
      <Field
        label={
          value.kind === 'filter'
            ? 'Filter expression (KQL where clause)'
            : value.kind === 'aggregate'
              ? 'Aggregate (KQL summarize)'
              : 'Expression'
        }
        hint={
          value.kind === 'filter'
            ? 'e.g. event_type == "click"'
            : value.kind === 'aggregate'
              ? 'e.g. count() by tenant'
              : ''
        }
      >
        <Textarea
          value={value.expression || ''}
          onChange={(_: unknown, d: any) => onChange({ expression: d.value })}
          rows={3}
        />
      </Field>
      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 'auto' }}
      >
        Remove transform
      </Button>
    </>
  );
}

function SinkInspector({
  value,
  onChange,
  onDelete,
}: {
  value: SinkNode;
  onChange: (p: Partial<SinkNode>) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Label weight="semibold">Destination</Label>
      <Field label="Name">
        <Input value={value.name} onChange={(_: unknown, d: any) => onChange({ name: d.value })} />
      </Field>
      <Field label="Kind">
        <Dropdown
          value={value.kind}
          selectedOptions={[value.kind]}
          onOptionSelect={(_: unknown, d: any) => onChange({ kind: (d.optionValue as SinkKind) || 'kusto' })}
        >
          <Option value="kusto">KQL Database (Kusto)</Option>
          <Option value="lakehouse">Lakehouse</Option>
          <Option value="eventhub">Event Hubs</Option>
          <Option value="reflex">Reflex (Activator)</Option>
          <Option value="derivedStream">Derived Stream</Option>
        </Dropdown>
      </Field>
      {value.kind === 'kusto' && (
        <>
          <Field label="Database">
            <Input
              value={value.database || ''}
              onChange={(_: unknown, d: any) => onChange({ database: d.value })}
            />
          </Field>
          <Field label="Table">
            <Input
              value={value.table || ''}
              placeholder="raw_events"
              onChange={(_: unknown, d: any) => onChange({ table: d.value })}
            />
          </Field>
        </>
      )}
      {value.kind === 'lakehouse' && (
        <>
          <Field label="Workspace ID">
            <Input
              value={value.workspaceId || ''}
              onChange={(_: unknown, d: any) => onChange({ workspaceId: d.value })}
            />
          </Field>
          <Field label="Lakehouse ID">
            <Input
              value={value.lakehouseId || ''}
              onChange={(_: unknown, d: any) => onChange({ lakehouseId: d.value })}
            />
          </Field>
        </>
      )}
      {value.kind === 'reflex' && (
        <Field label="Reflex ID">
          <Input
            value={value.reflexId || ''}
            onChange={(_: unknown, d: any) => onChange({ reflexId: d.value })}
          />
        </Field>
      )}
      <Button
        icon={<Delete20Regular />}
        appearance="subtle"
        onClick={onDelete}
        style={{ marginTop: 'auto' }}
      >
        Remove destination
      </Button>
    </>
  );
}
