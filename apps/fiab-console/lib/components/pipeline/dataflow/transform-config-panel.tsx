'use client';

/**
 * TransformConfigPanel — the per-transformation settings panel for the ADF /
 * Synapse SPARK-based MAPPING DATA FLOW designer.
 *
 * WHAT THIS IS (and is NOT)
 * -------------------------
 * This is the right-rail / bottom-dock editor that opens when a node is selected
 * on the mapping-data-flow canvas. Given the selected transform node it renders
 * the one-for-one Studio settings surface for that transform: a tab strip
 * (Settings / Projection / Optimize / Data preview, exactly the tabs the real
 * ADF Studio shows for that transform kind) plus the structured fields the
 * transform declares in `dataflow-transform-catalog.ts`. The designer (a sibling
 * file) owns the React Flow graph + the data-flow JSON round-trip; THIS file
 * owns the node's configuration form. The designer imports `<TransformConfigPanel/>`.
 *
 * It is NOT the Power Query / Dataflow Gen2 surface (`power-query-host.tsx`,
 * `m-script.ts`, `dataflow-diagram.tsx`) — that is a different product (M script,
 * WranglingDataFlow) and is deliberately left untouched.
 *
 * HOW IT STAYS HONEST (no-vaporware.md / loom-no-freeform-config)
 * --------------------------------------------------------------
 *   - Every field is a STRUCTURED Fluent control assembled from the catalog —
 *     never a freeform JSON textarea. The generic `ConfigField` renderer is the
 *     same model the connector-catalog / activity forms use, so the look + feel
 *     matches the rest of the pipeline editor.
 *   - Source / Sink dataset binding reuses the real, self-fetching
 *     `<DatasetPicker/>` (dataset-wizard) — select-existing OR create-new, on the
 *     real `/api/{adf|synapse}/datasets` REST.
 *   - Pipeline-expression (`@{…}`) fields reuse `<ExpressionField/>` so the
 *     portal's Add-dynamic-content builder is available exactly where ADF allows
 *     it. DATA-FLOW expression fields (the Spark column DSL — `upper(col)`,
 *     `iif(...)`) are a DIFFERENT language; they render as a clearly-badged
 *     monospace editor (no pipeline `@{…}` builder, which would be wrong here).
 *   - The Projection / schema grid edits column name + type with add/remove
 *     rows. "Import projection" needs a LIVE Spark debug cluster, so it renders
 *     an honest gate (no faked schema), same as Data preview.
 *   - Data preview requires a live interactive data-flow debug session. The
 *     management ARM REST cannot fabricate rows, so this is an honest Fluent
 *     MessageBar gate naming exactly what's required — never a faked preview.
 *
 * The config object this panel mutates is the per-transform settings bag the
 * designer assembles into the data-flow `properties.typeProperties`
 * ({sources,sinks,transformations,script}) and PUTs through the real BFF route
 * (`/api/adf/dataflows/{name}` → `upsertDataFlow`, or the Synapse equivalent).
 */

import { useMemo, useState } from 'react';
import {
  Tab, TabList, Field, Input, Dropdown, Option, Switch, Textarea,
  Caption1, Subtitle2, Badge, Button, Tooltip, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataUsageRegular, AddRegular, DeleteRegular, ArrowImportRegular,
  BeakerRegular, FlashRegular, ColumnRegular, TableRegular,
  TopSpeedRegular,
} from '@fluentui/react-icons';
import { ExpressionField } from '../expression-field';
import { DatasetSelectOrCreate, type DatasetProvider } from '../dataset-wizard';
import {
  transformByType,
  type TransformDef,
  type TransformField,
  type TransformCategory,
} from '@/lib/pipeline/dataflow-transform-catalog';
import {
  getTransformVisual, transformIcon, accentTint, accentGradient,
} from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';
import type { PipelineParameter, PipelineVariable } from '../types';

// ===========================================================================
// Public model — the designer owns the graph; it passes ONE selected transform
// node (plus the per-transform settings bag + its projection) into this panel.
// ===========================================================================

/** A single column in a transform's projection / schema. */
export interface ProjectionColumn {
  /** Column name. */
  name: string;
  /** Data-flow type (string | short | integer | long | float | double | decimal | boolean | date | timestamp | binary | …). */
  type: string;
}

/**
 * The selected mapping-data-flow transform node, as the designer hands it to
 * the panel. `config` is the flat settings bag keyed by the catalog field keys;
 * `schema` is the (optional) projection for Source/Sink/Select.
 */
export interface TransformNode {
  /** Stable canvas node id. */
  id: string;
  /** The data-flow-script transform token (catalog `type`): 'source','derive',… */
  type: string;
  /** The output-stream name shown on the node (DFS `~> name`). */
  name: string;
  /** Flat settings bag keyed by catalog field `key`. */
  config: Record<string, unknown>;
  /** Projection columns (Source/Sink/Select). */
  schema?: ProjectionColumn[];
}

export interface TransformConfigPanelProps {
  /** The selected transform node — null when nothing is selected. */
  node: TransformNode | null;
  /** Backend the dataset picker self-fetches against (adf default / synapse). */
  provider?: DatasetProvider;
  /** Emit a partial config patch (merged by the designer into node.config). */
  onConfigChange: (patch: Record<string, unknown>) => void;
  /** Emit the full next projection for the node. */
  onSchemaChange?: (schema: ProjectionColumn[]) => void;
  /** Pipeline parameters — offered in the `@{…}` expression picker. */
  parameters?: PipelineParameter[];
  /** Pipeline variables — offered in the `@{…}` expression picker. */
  variables?: PipelineVariable[];
  /** Item id of the host data-flow (enables Evaluate pre-fill in ExpressionField). */
  dataFlowId?: string;
  /** Workspace id (Synapse). */
  workspaceId?: string;
  /**
   * Whether a live Spark debug session is running. When false (the default),
   * Data preview + Import projection render an honest gate instead of rows.
   */
  debugSessionActive?: boolean;
  /** Optional callback to start a debug session (designer wires the debug bar). */
  onStartDebug?: () => void;
}

// ===========================================================================
// Icons + accents — the panel chrome reuses the SHARED canvas-node-kit so the
// properties panel carries the SAME per-type glyph + per-category accent the
// canvas node for this transform uses (`getTransformVisual` / `transformIcon`).
// No duplicate local icon map: one source of truth with the canvas.
// ===========================================================================

/** Map a transform category to a Fluent Badge colour for the header chip. */
function categoryColor(cat: TransformCategory): React.ComponentProps<typeof Badge>['color'] {
  switch (cat) {
    case 'Source & sink': return 'brand';
    case 'Schema modifier': return 'success';
    case 'Row modifier': return 'warning';
    case 'Multiple inputs/outputs': return 'important';
    case 'Formatters': return 'informative';
    default: return 'subtle';
  }
}

// ===========================================================================
// Tab model — which tabs the panel shows for a given transform. Mirrors the
// real ADF Studio: Source = Source settings / Projection / Optimize / Data
// preview; Sink = Sink settings / Mapping / Optimize / Data preview; Select =
// Select settings / Projection; every other transform = <Transform> settings /
// Data preview (Join/Lookup/Exists add Optimize for broadcast/partitioning).
// ===========================================================================

type TabId = 'settings' | 'projection' | 'optimize' | 'preview';

interface TabSpec {
  id: TabId;
  label: string;
}

const OPTIMIZE_TYPES = new Set(['source', 'sink', 'join', 'lookup', 'exists', 'aggregate', 'window', 'sort']);
const PROJECTION_TYPES = new Set(['source', 'sink', 'select']);

function tabsFor(def: TransformDef): TabSpec[] {
  const tabs: TabSpec[] = [];
  // Settings tab label matches the Studio ("Source settings", "Sink settings", …).
  if (def.type === 'source') tabs.push({ id: 'settings', label: 'Source settings' });
  else if (def.type === 'sink') tabs.push({ id: 'settings', label: 'Sink settings' });
  else tabs.push({ id: 'settings', label: `${def.displayName} settings` });

  if (PROJECTION_TYPES.has(def.type)) {
    tabs.push({ id: 'projection', label: def.type === 'sink' ? 'Mapping' : 'Projection' });
  }
  if (OPTIMIZE_TYPES.has(def.type)) tabs.push({ id: 'optimize', label: 'Optimize' });
  // Every transform can be previewed against a debug session (honest-gated).
  tabs.push({ id: 'preview', label: 'Data preview' });
  return tabs;
}

/** Partition into the Optimize-tab fields vs. everything else (Settings tab). */
const OPTIMIZE_KEYS = new Set([
  'partitionType', 'isolationLevel', 'broadcast', 'saveOrder', 'defaultPartitioning',
]);

function isOptimizeField(f: TransformField): boolean {
  return OPTIMIZE_KEYS.has(f.key);
}

/** Data-flow types offered in the projection grid's type dropdown. */
const DF_TYPES: { value: string; label: string }[] = [
  { value: 'string', label: 'string' },
  { value: 'boolean', label: 'boolean' },
  { value: 'short', label: 'short' },
  { value: 'integer', label: 'integer' },
  { value: 'long', label: 'long' },
  { value: 'float', label: 'float' },
  { value: 'double', label: 'double' },
  { value: 'decimal', label: 'decimal' },
  { value: 'date', label: 'date' },
  { value: 'timestamp', label: 'timestamp' },
  { value: 'binary', label: 'binary' },
  { value: 'complex', label: 'complex (struct)' },
  { value: 'array', label: 'array' },
  { value: 'map', label: 'map' },
];

// ===========================================================================
// Styles — Loom design tokens only (web3-ui.md): no hard-coded px / hex.
// ===========================================================================

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column',
    width: '100%', height: '100%', minHeight: 0,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  headTitleRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  // Accent-driven glyph chip — the per-category gradient + accent comes from the
  // shared kit (set inline per node) so the panel header matches the canvas node.
  headIcon: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    fontSize: tokens.fontSizeBase500,
    boxShadow: tokens.shadow4,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  tabStrip: {
    paddingInline: tokens.spacingHorizontalL,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  body: {
    flex: 1, minHeight: 0, overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
  },
  // Elevated, rounded section card with hover lift — matches the palette tiles.
  sectionCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  // Icon-led section header (glyph chip + title + caption).
  sectionHead: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
  },
  sectionHeadIcon: {
    flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '28px', height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  sectionHeadText: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
  },
  dfFieldHeadRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  dfMono: {
    fontFamily: tokens.fontFamilyMonospace,
  },
  gridToolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS, flexWrap: 'wrap',
  },
  gridToolbarBtns: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  nameCellInput: { width: '100%' },
  rowActionCell: { width: tokens.spacingHorizontalXXXL, textAlign: 'right' },
  // Centered host for the shared EmptyState (no-transform-selected).
  emptyHost: {
    flex: 1, minHeight: 0, overflowY: 'auto',
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    padding: tokens.spacingHorizontalL,
  },
});

// ===========================================================================
// Generic ConfigField renderer — the same typed-control model used by the
// connector-catalog / activity forms, extended for the data-flow-expression
// marker. Renders: boolean → Switch, select → Dropdown, number/text →
// Input, multiline → Textarea; pipeline `@{…}` fields → ExpressionField;
// data-flow-expression fields → badged monospace editor; the source/sink
// dataset ref → DatasetPicker.
// ===========================================================================

function strOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fieldVisible(field: TransformField, read: (key: string) => unknown): boolean {
  if (!field.showIf) return true;
  const cur = read(field.showIf.key);
  const want = field.showIf.equals;
  if (typeof cur === 'boolean') return String(cur) === want;
  return (cur == null ? '' : String(cur)) === want;
}

function ConfigFieldRenderer({
  field, def, value, provider, onChange, parameters, variables, dataFlowId, workspaceId,
}: {
  field: TransformField;
  def: TransformDef;
  value: unknown;
  provider: DatasetProvider;
  onChange: (next: unknown) => void;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  dataFlowId?: string;
  workspaceId?: string;
}) {
  const s = useStyles();
  const raw = value;
  const strVal = strOf(raw);

  // — Source/Sink dataset reference → self-fetching DatasetPicker (+ create-new) —
  if (def.needsDataset && field.key === 'dataset') {
    return (
      <DatasetSelectOrCreate
        label={field.label}
        value={typeof raw === 'string' ? raw : ''}
        required={field.required}
        hint={field.hint}
        provider={provider}
        onChange={(name) => onChange(name)}
      />
    );
  }

  // — boolean → Switch —
  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} hint={field.hint}>
        <Switch
          checked={raw === true || raw === 'true'}
          onChange={(_, d) => onChange(d.checked)}
        />
      </Field>
    );
  }

  // — select → Dropdown —
  if (field.kind === 'select') {
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Dropdown
          value={strVal}
          selectedOptions={strVal ? [strVal] : []}
          onOptionSelect={(_, d) => onChange(d.optionValue)}
        >
          {(field.options || []).map((o) => (
            <Option key={o.value} value={o.value}>{o.label}</Option>
          ))}
        </Dropdown>
      </Field>
    );
  }

  // — number → Input[type=number] —
  if (field.kind === 'number') {
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Input
          type="number"
          value={strVal}
          placeholder={field.placeholder}
          onChange={(_, d) => onChange(d.value === '' ? undefined : Number(d.value))}
        />
      </Field>
    );
  }

  // — DATA-FLOW expression (Spark column DSL) → badged monospace editor —
  // This is a DIFFERENT language from pipeline `@{…}`; we do NOT open the
  // pipeline dynamic-content builder here. The multiline catalog fields
  // (column = expr lists) get a Textarea; single-line conditions get an Input.
  if (field.dataFlowExpression) {
    const control = field.kind === 'multiline'
      ? (
        <Textarea
          className={s.dfMono}
          value={strVal}
          placeholder={field.placeholder}
          resize="vertical"
          rows={4}
          onChange={(_, d) => onChange(d.value)}
        />
      )
      : (
        <Input
          className={s.dfMono}
          value={strVal}
          placeholder={field.placeholder}
          onChange={(_, d) => onChange(d.value)}
        />
      );
    return (
      <Field
        label={(
          <span className={s.dfFieldHeadRow}>
            {field.label}
            <Tooltip
              relationship="description"
              content="Data flow (Spark) expression language — e.g. upper(col), iif(year > 1980, 'new', 'old'), sum(Sales). Different from pipeline @{…} expressions."
            >
              <Badge appearance="outline" color="brand" size="small" icon={<FlashRegular />}>
                DF expr
              </Badge>
            </Tooltip>
          </span>
        )}
        required={field.required}
        hint={field.hint}
      >
        {control}
      </Field>
    );
  }

  // — pipeline `@{…}` expression field (supportsDynamic) → ExpressionField —
  if (field.supportsDynamic) {
    return (
      <ExpressionField
        label={field.label}
        hint={field.hint}
        required={field.required}
        placeholder={field.placeholder}
        multiline={field.kind === 'multiline'}
        supportsDynamic
        value={strVal}
        parameters={parameters}
        variables={variables}
        pipelineId={dataFlowId}
        workspaceId={workspaceId}
        onChange={(v) => onChange(v)}
      />
    );
  }

  // — multiline (non-expression) → Textarea —
  if (field.kind === 'multiline') {
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Textarea
          value={strVal}
          placeholder={field.placeholder}
          resize="vertical"
          rows={3}
          onChange={(_, d) => onChange(d.value)}
        />
      </Field>
    );
  }

  // — text (default) → Input —
  return (
    <Field label={field.label} required={field.required} hint={field.hint}>
      <Input
        value={strVal}
        placeholder={field.placeholder}
        onChange={(_, d) => onChange(d.value)}
      />
    </Field>
  );
}

/** Render a list of fields inside a card, honouring per-field showIf. */
function FieldList({
  fields, def, node, provider, onConfigChange, parameters, variables, dataFlowId, workspaceId,
  emptyText,
}: {
  fields: TransformField[];
  def: TransformDef;
  node: TransformNode;
  provider: DatasetProvider;
  onConfigChange: (patch: Record<string, unknown>) => void;
  parameters: PipelineParameter[];
  variables: PipelineVariable[];
  dataFlowId?: string;
  workspaceId?: string;
  emptyText?: string;
}) {
  const s = useStyles();
  const read = (key: string) => node.config[key];
  const visible = fields.filter((f) => fieldVisible(f, read));
  if (visible.length === 0) {
    return <Caption1>{emptyText || 'No settings for this transformation.'}</Caption1>;
  }
  return (
    <div className={s.sectionCard}>
      {visible.map((field) => (
        <ConfigFieldRenderer
          key={field.key}
          field={field}
          def={def}
          value={node.config[field.key]}
          provider={provider}
          parameters={parameters}
          variables={variables}
          dataFlowId={dataFlowId}
          workspaceId={workspaceId}
          onChange={(next) => onConfigChange({ [field.key]: next })}
        />
      ))}
    </div>
  );
}

// ===========================================================================
// Projection / schema grid — column name + type rows, add / remove, and an
// honest-gated "Import projection". Used by Source / Sink / Select.
// ===========================================================================

function ProjectionGrid({
  schema, debugSessionActive, onStartDebug, onSchemaChange, def,
}: {
  schema: ProjectionColumn[];
  debugSessionActive: boolean;
  onStartDebug?: () => void;
  onSchemaChange?: (schema: ProjectionColumn[]) => void;
  def: TransformDef;
}) {
  const s = useStyles();
  const cols = schema;

  const editable = !!onSchemaChange;

  const setCol = (idx: number, patch: Partial<ProjectionColumn>) => {
    if (!onSchemaChange) return;
    onSchemaChange(cols.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const addCol = () => {
    if (!onSchemaChange) return;
    onSchemaChange([...cols, { name: `column_${cols.length + 1}`, type: 'string' }]);
  };
  const removeCol = (idx: number) => {
    if (!onSchemaChange) return;
    onSchemaChange(cols.filter((_, i) => i !== idx));
  };

  return (
    <div className={s.sectionCard}>
      <div className={s.gridToolbar}>
        <div className={s.sectionHead}>
          <span className={s.sectionHeadIcon} aria-hidden>
            {def.type === 'sink' ? <TableRegular /> : <ColumnRegular />}
          </span>
          <div className={s.sectionHeadText}>
            <Subtitle2>{def.type === 'sink' ? 'Sink mapping schema' : 'Projection'}</Subtitle2>
            <Caption1 className={s.muted}>
              {def.type === 'source'
                ? 'The columns and types this source emits downstream.'
                : def.type === 'sink'
                  ? 'The incoming columns mapped onto the sink store.'
                  : 'The columns this transformation outputs (name + type).'}
            </Caption1>
          </div>
        </div>
        <div className={s.gridToolbarBtns}>
          <Tooltip
            relationship="description"
            content={debugSessionActive
              ? 'Detect the projection from a live debug-session sample.'
              : 'Import projection reads the store schema from a live Spark debug session.'}
          >
            <Button
              size="small"
              appearance="secondary"
              icon={<ArrowImportRegular />}
              disabled={!debugSessionActive || !editable}
              onClick={() => { /* designer wires the debug import-schema call */ }}
            >
              Import projection
            </Button>
          </Tooltip>
          {editable && (
            <Button size="small" appearance="primary" icon={<AddRegular />} onClick={addCol}>
              Add column
            </Button>
          )}
        </div>
      </div>

      {!debugSessionActive && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Import projection needs a live debug session</MessageBarTitle>
            Auto-detecting the schema from the store requires a running interactive
            data-flow debug cluster (an Azure Integration Runtime Spark debug session).
            Start Debug to enable Import projection, or define the columns manually below.
          </MessageBarBody>
          {onStartDebug && (
            <MessageBarActions>
              <Button size="small" icon={<BeakerRegular />} onClick={onStartDebug}>Start Debug</Button>
            </MessageBarActions>
          )}
        </MessageBar>
      )}

      <Table size="small" aria-label="Projection columns">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Column name</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            {editable && <TableHeaderCell aria-label="Row actions" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {cols.length === 0 && (
            <TableRow>
              <TableCell colSpan={editable ? 3 : 2}>
                <Caption1>
                  No columns defined yet. {editable ? 'Add columns, or Import projection from a debug session.' : ''}
                </Caption1>
              </TableCell>
            </TableRow>
          )}
          {cols.map((col, idx) => (
            <TableRow key={idx}>
              <TableCell>
                {editable ? (
                  <Input
                    className={s.nameCellInput}
                    appearance="filled-lighter"
                    value={col.name}
                    aria-label={`Column ${idx + 1} name`}
                    onChange={(_, d) => setCol(idx, { name: d.value })}
                  />
                ) : (
                  <code>{col.name}</code>
                )}
              </TableCell>
              <TableCell>
                {editable ? (
                  <Dropdown
                    value={col.type}
                    selectedOptions={[col.type]}
                    aria-label={`Column ${idx + 1} type`}
                    onOptionSelect={(_, d) => setCol(idx, { type: d.optionValue || 'string' })}
                  >
                    {DF_TYPES.map((t) => <Option key={t.value} value={t.value}>{t.label}</Option>)}
                  </Dropdown>
                ) : (
                  <Badge appearance="tint" color="informative" size="small">{col.type}</Badge>
                )}
              </TableCell>
              {editable && (
                <TableCell className={s.rowActionCell}>
                  <Tooltip relationship="label" content="Remove column">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DeleteRegular />}
                      aria-label={`Remove column ${col.name}`}
                      onClick={() => removeCol(idx)}
                    />
                  </Tooltip>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ===========================================================================
// Data preview — HONEST GATE. Real row previews require a live data-flow debug
// session; the management ARM REST cannot fabricate rows (no-vaporware.md), so
// we render a styled MessageBar naming exactly what's required — never faked
// rows. When a session is active the designer renders the live grid; this panel
// surfaces the start affordance.
// ===========================================================================

function DataPreviewGate({
  debugSessionActive, onStartDebug,
}: {
  debugSessionActive: boolean;
  onStartDebug?: () => void;
}) {
  if (debugSessionActive) {
    return (
      <MessageBar intent="success">
        <MessageBarBody>
          <MessageBarTitle>Debug session active</MessageBarTitle>
          A Spark debug cluster is running. Run Data preview from the debug bar to fetch
          real sampled rows for this transformation.
        </MessageBarBody>
      </MessageBar>
    );
  }
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Data preview requires a live Spark debug session</MessageBarTitle>
        Per-transform data preview runs your transformation graph on a real interactive
        data-flow debug cluster (an Azure Integration Runtime Spark session) and samples
        the rows. No debug session is running, so there is nothing to preview yet — Loom
        never shows faked rows. Start Debug to provision the cluster (set the debug compute
        size / TTL in the data-flow Debug settings), then return here.
      </MessageBarBody>
      {onStartDebug && (
        <MessageBarActions>
          <Button appearance="primary" icon={<BeakerRegular />} onClick={onStartDebug}>
            Start Debug
          </Button>
        </MessageBarActions>
      )}
    </MessageBar>
  );
}

// ===========================================================================
// TransformConfigPanel
// ===========================================================================

export function TransformConfigPanel({
  node,
  provider = 'adf',
  onConfigChange,
  onSchemaChange,
  parameters = [],
  variables = [],
  dataFlowId,
  workspaceId,
  debugSessionActive = false,
  onStartDebug,
}: TransformConfigPanelProps) {
  const s = useStyles();
  const def = useMemo(() => (node ? transformByType(node.type) : undefined), [node]);
  const tabs = useMemo(() => (def ? tabsFor(def) : []), [def]);
  const [tab, setTab] = useState<TabId>('settings');

  // Keep the selected tab valid as the selection changes (a Filter has no
  // Projection tab; falling back to Settings avoids a blank pane).
  const activeTab: TabId = tabs.some((t) => t.id === tab) ? tab : 'settings';

  if (!node || !def) {
    return (
      <div className={s.root}>
        <div className={s.emptyHost}>
          <EmptyState
            icon={<DataUsageRegular />}
            title="No transformation selected"
            body="Select a transformation on the canvas to edit its settings, projection, and optimization — or drag one in from the palette to build your mapping data flow."
          />
        </div>
      </div>
    );
  }

  // Same per-type glyph + per-category accent the canvas node uses for this
  // transform — one source of truth with the canvas (canvas-node-kit).
  const visual = getTransformVisual(def.type);
  const accent = visual.accent;
  // Settings-tab fields = catalog settings minus those that live on Optimize.
  const settingsFields = def.settings.filter((f) => !isOptimizeField(f));
  const optimizeFields = def.settings.filter(isOptimizeField);

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.headTitleRow}>
          <span
            className={s.headIcon}
            style={{
              background: accentGradient(accent),
              color: accent,
              border: `${tokens.strokeWidthThin} solid ${accentTint(accent, 24)}`,
            }}
            aria-hidden
          >
            {transformIcon(def)}
          </span>
          <Subtitle2>{def.displayName}</Subtitle2>
          <Badge appearance="tint" color={categoryColor(def.category)} size="small">
            {def.category}
          </Badge>
          {def.preview && <Badge appearance="outline" color="warning" size="small">Preview</Badge>}
          <Badge appearance="ghost" size="small">
            {node.name || node.config.outputStreamName as string || '(unnamed stream)'}
          </Badge>
        </div>
        <Caption1 className={s.muted}>{def.description}</Caption1>
      </div>

      <div className={s.tabStrip}>
        <TabList
          selectedValue={activeTab}
          onTabSelect={(_, d) => setTab(d.value as TabId)}
          size="small"
        >
          {tabs.map((t) => <Tab key={t.id} value={t.id}>{t.label}</Tab>)}
        </TabList>
      </div>

      <div className={s.body}>
        {activeTab === 'settings' && (
          <FieldList
            fields={settingsFields}
            def={def}
            node={node}
            provider={provider}
            onConfigChange={onConfigChange}
            parameters={parameters}
            variables={variables}
            dataFlowId={dataFlowId}
            workspaceId={workspaceId}
            emptyText={
              def.type === 'newBranch'
                ? 'New branch has no settings — it replicates the incoming stream down a second path. Wire its downstream transformations on the canvas.'
                : undefined
            }
          />
        )}

        {activeTab === 'projection' && (
          <ProjectionGrid
            schema={node.schema || []}
            def={def}
            debugSessionActive={debugSessionActive}
            onStartDebug={onStartDebug}
            onSchemaChange={onSchemaChange}
          />
        )}

        {activeTab === 'optimize' && (
          <>
            <div className={s.sectionHead}>
              <span className={s.sectionHeadIcon} aria-hidden><TopSpeedRegular /></span>
              <div className={s.sectionHeadText}>
                <Subtitle2>Optimize</Subtitle2>
                <Caption1 className={s.muted}>
                  Partitioning + broadcast settings for this transformation’s Spark stage.
                </Caption1>
              </div>
            </div>
            <FieldList
              fields={optimizeFields}
              def={def}
              node={node}
              provider={provider}
              onConfigChange={onConfigChange}
              parameters={parameters}
              variables={variables}
              dataFlowId={dataFlowId}
              workspaceId={workspaceId}
              emptyText="Use current partitioning. This transformation has no extra optimization options."
            />
            <Divider />
            <Caption1 className={s.muted}>
              Partitioning is applied per the run-level Optimize strategy unless overridden
              here. Leave on “Use current partitioning” unless you have a measured hot-spot.
            </Caption1>
          </>
        )}

        {activeTab === 'preview' && (
          <DataPreviewGate debugSessionActive={debugSessionActive} onStartDebug={onStartDebug} />
        )}
      </div>
    </div>
  );
}

export default TransformConfigPanel;
