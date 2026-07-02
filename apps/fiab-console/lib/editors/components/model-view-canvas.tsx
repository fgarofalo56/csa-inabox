'use client';

/**
 * ModelViewCanvas + ModelViewPanel — the Loom-native parity of the Fabric /
 * Power BI "Model view": a draggable canvas of table cards joined by
 * relationship lines (with cardinality + cross-filter direction), plus a
 * measures panel with a DAX-like / T-SQL measure editor.
 *
 * NO Power BI / Fabric dependency. The model is materialized on the
 * Azure-native warehouse backends:
 *   • Warehouse / Synapse Dedicated SQL pool — relationships are Loom metadata
 *     persisted on the Cosmos item `state.model` (Synapse Dedicated has no
 *     enforced FOREIGN KEY); measures are real inline table-valued functions
 *     created with `CREATE OR ALTER FUNCTION … RETURNS TABLE`.
 *   • Databricks SQL Warehouse — relationships become real Unity Catalog
 *     informational FK constraints (`ALTER TABLE … ADD CONSTRAINT … FOREIGN
 *     KEY`), mirrored to Cosmos so cardinality/cross-filter survive; measures
 *     are Loom metadata usable as a query CTE.
 *
 * Power BI is strictly opt-in and is never read or required by this surface —
 * the Model view renders fully with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * The canvas uses the same @xyflow/react engine as the ADX schema diagram
 * (lib/components/adx/schema-diagram-canvas.tsx); only the node visuals,
 * the column-level connect handles, and the relationship edges differ.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Panel,
  Handle, Position, useReactFlow, useNodesState,
  MarkerType,
  type Node, type Edge, type NodeProps, type NodeTypes, type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Button, Caption1, Text, Tooltip, Spinner, Field, Input, Dropdown, Option, Switch, Checkbox,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  FullScreenMaximize20Regular, Organization20Regular,
  DocumentTable16Regular, Key16Regular, Add20Regular,
  MathFormula20Regular, Play16Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { accentTint, accentGradient, portStyle } from '@/lib/components/canvas/canvas-node-kit';
// Shared drag-to-resize host: supplies the definite outer height React Flow
// needs to frame fitView and persists the per-surface height to localStorage.
// Pointer + keyboard + ARIA live in the primitive; this surface only declares
// its bounds/storage key (mirrors pipeline-designer.tsx wiring).
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

/**
 * Table-card accent — theme-aware `--loom-accent-blue` (defined light + dark in
 * app/globals.css). The Model-view card deliberately is NOT forced into the
 * shared `CanvasNode` shape: a table card carries per-column connect handles
 * (key-to-key relationship drawing), which `CanvasNode` does not model. Instead
 * it reuses the kit's token-only tint/gradient helpers so the chrome (gradient
 * header, icon chip, accent rail, hover elevation) reads as the same product.
 */
const TABLE_ACCENT = 'var(--loom-accent-blue)';

// ---------------------------------------------------------------------------
// Public model — kept in sync with the model BFF routes
// (app/api/items/<engine>/[id]/model/route.ts).
// ---------------------------------------------------------------------------

export type Cardinality = 'one-to-many' | 'many-to-one' | 'one-to-one' | 'many-to-many';
export type CrossFilter = 'single' | 'both';
export type MeasureKind = 'tvf' | 'scalar' | 'cosmos';

export interface ModelColumn { name: string; type?: string; isPk?: boolean; }

export interface ModelTable {
  /** schema-qualified id, e.g. `dbo.Sales` (Synapse) or `catalog.schema.table` (DBX). */
  id: string;
  schema: string;
  name: string;
  columns: ModelColumn[];
  rowCount?: number;
}

export interface ModelRelationship {
  id: string;
  name?: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  crossFilter: CrossFilter;
  active: boolean;
  /**
   * Assume referential integrity — when true the engine may use an INNER join
   * across this relationship (every value on the many side exists on the one
   * side), which the warehouse/lakehouse query path can lower to a faster join.
   * Only meaningful for many-to-one / one-to-one; persisted onto
   * `StoredRelationship.assumeReferentialIntegrity` (back-compat optional).
   */
  assumeReferentialIntegrity?: boolean;
  /** 'uc' when the FK originated from Unity Catalog INFORMATION_SCHEMA. */
  source?: 'cosmos' | 'uc';
}

export interface ModelMeasure {
  id: string;
  name: string;
  schema?: string;
  expression: string;
  kind: MeasureKind;
  createdAt?: string;
}

const CARDINALITIES: Cardinality[] = ['one-to-many', 'many-to-one', 'one-to-one', 'many-to-many'];
const CROSS_FILTERS: CrossFilter[] = ['single', 'both'];

/** The `1` / `*` end markers Fabric/Power BI draw on a relationship line. */
function cardinalityEnds(c: Cardinality): { from: string; to: string } {
  switch (c) {
    case 'one-to-many': return { from: '1', to: '*' };
    case 'many-to-one': return { from: '*', to: '1' };
    case 'one-to-one': return { from: '1', to: '1' };
    case 'many-to-many': return { from: '*', to: '*' };
  }
}

// ---------------------------------------------------------------------------
// Custom node — a table card with per-column connect handles.
// ---------------------------------------------------------------------------

const NODE_W = 240;
const MAX_COLS = 8;

export interface TableCardNodeData {
  table: ModelTable;
  [key: string]: unknown;
}

/**
 * Table-card chrome — token-only, theme-aware, hover-elevated, mirroring the
 * shared `CanvasNode` look (accent rail + gradient header + icon chip + hover
 * shadow4→shadow16) without forcing this card into the kit's node shape, which
 * does not model per-column connect handles. All motion is gated behind
 * `prefers-reduced-motion: reduce`.
 */
const nodeStyles = makeStyles({
  card: {
    position: 'relative',
    width: `${NODE_W}px`,
    borderRadius: tokens.borderRadiusXLarge,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    userSelect: 'none',
    overflow: 'hidden',
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-1px)',
    },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  cardSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    boxShadow: `0 0 0 2px ${TABLE_ACCENT}`,
  },
  // Accent rail down the left edge (anchors the table category colour).
  rail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '6px',
    background: TABLE_ACCENT,
    zIndex: 1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
    marginLeft: '6px',
    background: accentGradient(TABLE_ACCENT),
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  iconChip: {
    flexShrink: 0,
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: accentTint(TABLE_ACCENT, 14),
    color: TABLE_ACCENT,
  },
  cols: {
    display: 'flex',
    flexDirection: 'column',
    marginLeft: '6px',
  },
  colRow: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase100,
    minHeight: '18px',
  },
  // Primary-key rows get a faint accent wash so keys read first.
  colRowPk: {
    background: accentTint(TABLE_ACCENT, 6),
  },
  colName: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    overflow: 'hidden',
  },
  keyGlyph: {
    display: 'inline-flex',
    color: 'var(--loom-accent-amber)',
  },
  colType: {
    color: tokens.colorNeutralForeground4,
    flexShrink: 0,
  },
  more: {
    color: tokens.colorNeutralForeground4,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    marginLeft: '6px',
  },
  empty: {
    color: tokens.colorNeutralForeground4,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    marginLeft: '6px',
  },
});

function TableCardNodeImpl({ data, selected }: NodeProps) {
  const styles = nodeStyles();
  const { table } = data as TableCardNodeData;
  const cols = table.columns || [];
  const shown = cols.slice(0, MAX_COLS);

  return (
    <div
      id={`model-table-${table.id}`}
      data-model-table-id={table.id}
      aria-label={`Table ${table.id}`}
      className={mergeClasses(styles.card, selected && styles.cardSelected)}
    >
      {/* Accent rail anchoring the table category colour. */}
      <span className={styles.rail} aria-hidden="true" />

      {/* Gradient header — icon chip + table name + schema badge. */}
      <div className={styles.header}>
        <span className={styles.iconChip} aria-hidden="true"><DocumentTable16Regular fontSize={16} /></span>
        <Text size={200} weight="semibold" truncate wrap={false} style={{ flex: 1 }}>{table.name}</Text>
        <Badge size="extra-small" appearance="tint" color="informative">{table.schema}</Badge>
      </div>

      {/* Whole-card target/source handles (used as a fallback when a precise
          column handle isn't grabbed). */}
      <Handle type="target" position={Position.Left} id="__table" style={{ ...portStyle('in', TABLE_ACCENT), left: -6, top: 16 }} />
      <Handle type="source" position={Position.Right} id="__table" style={{ ...portStyle('out', TABLE_ACCENT), right: -6, top: 16 }} />

      {/* Column rows — each carries a column-level source + target handle so a
          relationship can be drawn key-to-key. `nodrag` keeps clicks from
          dragging the whole card. */}
      <div className={styles.cols}>
        {shown.map((c) => (
          <div
            key={c.name}
            className={mergeClasses('nodrag', styles.colRow, c.isPk && styles.colRowPk)}
          >
            <Handle
              type="target" position={Position.Left} id={`col:${c.name}`}
              style={{ ...portStyle('in', TABLE_ACCENT), left: -6 }}
            />
            <span className={styles.colName}>
              {c.isPk && <span className={styles.keyGlyph}><Key16Regular fontSize={12} /></span>}
              <span style={{
                color: tokens.colorNeutralForeground1,
                fontWeight: c.isPk ? tokens.fontWeightSemibold : tokens.fontWeightRegular,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{c.name}</span>
            </span>
            <span className={styles.colType}>{c.type}</span>
            <Handle
              type="source" position={Position.Right} id={`col:${c.name}`}
              style={{ ...portStyle('out', TABLE_ACCENT), right: -6 }}
            />
          </div>
        ))}
        {cols.length > shown.length && (
          <Caption1 className={styles.more}>
            +{cols.length - shown.length} more
          </Caption1>
        )}
        {cols.length === 0 && (
          <Caption1 className={styles.empty}>(no columns)</Caption1>
        )}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { 'model-table': TableCardNodeImpl };

// ---------------------------------------------------------------------------
// Deterministic 3-column grid layout (no async ELK).
// ---------------------------------------------------------------------------

const GRID_COLS = 3;
const COL_GAP = 360;
const ROW_GAP = 220;

function gridLayout(tables: ModelTable[]): Map<string, { x: number; y: number }> {
  const sorted = [...tables].sort((a, b) => (a.schema + a.name).localeCompare(b.schema + b.name));
  const pos = new Map<string, { x: number; y: number }>();
  sorted.forEach((t, i) => {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    pos.set(t.id, { x: col * COL_GAP, y: row * ROW_GAP });
  });
  return pos;
}

// ---------------------------------------------------------------------------
// Create-relationship dialog
// ---------------------------------------------------------------------------

interface DraftRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

function colFromHandle(handle: string | null | undefined): string | null {
  if (!handle || !handle.startsWith('col:')) return null;
  return handle.slice(4);
}

// ---------------------------------------------------------------------------
// Autodetect relationships — a pure, client-side heuristic over the REAL loaded
// schema (props.tables). It proposes M:1 foreign-key relationships toward the
// table where the matched column is a primary key, using the same naming
// conventions a star-schema warehouse follows (`<Dim>Key` / `<Dim>Id` on the
// fact, or an exact shared key-name). Proposals feed a review dialog; accepted
// rows are created through the SAME `onCreateRelationship` route the manual
// dialog uses — no new BFF route, no mock proposals.
// ---------------------------------------------------------------------------

export interface RelProposal {
  fromTable: string;   // many side (the referencing / fact table)
  fromColumn: string;
  toTable: string;     // one side (the table whose PK is referenced)
  toColumn: string;
  cardinality: Cardinality;  // always 'many-to-one' for an inferred FK
  /** Human-readable rationale shown in the review list. */
  reason: string;
  /** Stable dedup / accept-map key. */
  key: string;
}

/** Strip length/precision (e.g. `varchar(50)` → `varchar`) and lowercase. */
function baseType(t?: string): string {
  if (!t) return '';
  return t.toLowerCase().replace(/\([^)]*\)/g, '').trim();
}

/** Coarse type family so e.g. `int` ↔ `bigint` and `varchar` ↔ `nvarchar` match. */
function typeFamily(t?: string): string {
  const b = baseType(t);
  if (!b) return '';
  if (/(int|long|numeric|decimal|number|money|bit|serial)/.test(b)) return 'num';
  if (/(char|text|string|clob)/.test(b)) return 'str';
  if (/(uuid|guid|uniqueidentifier)/.test(b)) return 'uid';
  if (/(date|time|timestamp)/.test(b)) return 'date';
  return b;
}

/** Lenient join-type compatibility — unknown types (missing on either end) pass. */
function typesCompatible(a?: string, b?: string): boolean {
  const fa = typeFamily(a);
  const fb = typeFamily(b);
  if (!fa || !fb) return true;            // schema didn't carry a type — allow
  if (fa === fb) return true;
  // uid columns are commonly typed as strings on one side
  return (fa === 'uid' && fb === 'str') || (fa === 'str' && fb === 'uid');
}

/** Primary-key columns for a table — flagged `isPk`, else a key-named fallback. */
function pkColumns(t: ModelTable): ModelColumn[] {
  const flagged = t.columns.filter((c) => c.isPk);
  if (flagged.length) return flagged;
  const nm = t.name.toLowerCase();
  const singular = nm.endsWith('s') ? nm.slice(0, -1) : nm;
  const cand = new Set(['id', `${nm}id`, `${nm}key`, `${singular}id`, `${singular}key`]);
  return t.columns.filter((c) => cand.has(c.name.toLowerCase()));
}

function relKey(ft: string, fc: string, tt: string, tc: string): string {
  return `${ft}::${fc}->${tt}::${tc}`.toLowerCase();
}

/**
 * Propose FK relationships from a set of tables, skipping any that already
 * exist (in either orientation). Pure — no I/O, unit-testable.
 */
export function detectRelationships(tables: ModelTable[], existing: ModelRelationship[]): RelProposal[] {
  const proposals: RelProposal[] = [];
  const seen = new Set<string>();

  // Existing relationships (both orientations) are off-limits.
  const taken = new Set<string>();
  for (const r of existing) {
    taken.add(relKey(r.fromTable, r.fromColumn, r.toTable, r.toColumn));
    taken.add(relKey(r.toTable, r.toColumn, r.fromTable, r.fromColumn));
  }

  const pkMap = new Map<string, ModelColumn[]>(tables.map((t) => [t.id, pkColumns(t)]));

  for (const a of tables) {
    const aPkNames = new Set((pkMap.get(a.id) || []).map((p) => p.name.toLowerCase()));
    for (const b of tables) {
      if (a.id === b.id) continue;
      const bPks = pkMap.get(b.id) || [];
      if (!bPks.length) continue;

      const bn = b.name.toLowerCase();
      const bSingular = bn.endsWith('s') ? bn.slice(0, -1) : bn;
      const refNames = new Set<string>();
      for (const n of [bn, bSingular]) {
        refNames.add(`${n}key`);
        refNames.add(`${n}id`);
        refNames.add(`${n}_id`);
        refNames.add(`${n}_key`);
      }

      for (const colA of a.columns) {
        const cl = colA.name.toLowerCase();
        let target: ModelColumn | undefined;
        let why = '';

        const exact = bPks.find((p) => p.name.toLowerCase() === cl);
        if (exact) {
          // Exact shared key-name. Skip when the column is also A's own PK —
          // two same-named PKs are ambiguous (no inferable direction).
          if (aPkNames.has(cl)) continue;
          target = exact;
          why = 'shared key name';
        } else if (refNames.has(cl)) {
          // `<Dim>Key` / `<Dim>Id` naming convention → B's primary key.
          target = bPks[0];
          why = 'naming convention';
        }
        if (!target) continue;
        if (!typesCompatible(colA.type, target.type)) continue;

        const k = relKey(a.id, colA.name, b.id, target.name);
        if (seen.has(k) || taken.has(k)) continue;
        seen.add(k);
        proposals.push({
          fromTable: a.id,
          fromColumn: colA.name,
          toTable: b.id,
          toColumn: target.name,
          cardinality: 'many-to-one',
          reason: `${a.name}.${colA.name} → ${b.name}.${target.name} · ${why}`,
          key: k,
        });
      }
    }
  }
  return proposals;
}


// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    width: '100%',
    // Fills the wrapping <ResizableCanvasRegion>, which now owns the definite
    // pixel height React Flow needs to frame fitView and makes it user-resizable
    // + persisted (was a fixed height:520px before the region took ownership).
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
  },
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingHorizontalXS,
  },
  empty: {
    position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: tokens.spacingVerticalS, textAlign: 'center', padding: tokens.spacingHorizontalXXL,
  },
  // Autodetect review dialog — empty gallery state (no proposals found).
  adEmpty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: tokens.spacingVerticalS, textAlign: 'center',
    paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
  adList: {
    maxHeight: '320px', overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  // Faint hint under the referential-integrity switch.
  riHint: { color: tokens.colorNeutralForeground3 },
});

export interface ModelViewCanvasProps {
  tables: ModelTable[];
  relationships: ModelRelationship[];
  onCreateRelationship: (rel: Omit<ModelRelationship, 'id'>) => Promise<void>;
  onDeleteRelationship: (rel: ModelRelationship) => Promise<void>;
  readOnly?: boolean;
  emptyMessage?: string;
}

function ModelViewCanvasInner({
  tables, relationships, onCreateRelationship, onDeleteRelationship, readOnly, emptyMessage,
}: ModelViewCanvasProps) {
  const st = useStyles();
  const rf = useReactFlow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);

  // Create-relationship dialog state.
  const [dlgOpen, setDlgOpen] = useState(false);
  const [draft, setDraft] = useState<DraftRelationship | null>(null);
  const [cardinality, setCardinality] = useState<Cardinality>('many-to-one');
  const [crossFilter, setCrossFilter] = useState<CrossFilter>('single');
  const [active, setActive] = useState(true);
  // Assume-referential-integrity is only valid when the "one" side is on the
  // to-end (many-to-one / one-to-one); the switch is disabled otherwise.
  const [assumeRI, setAssumeRI] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const riValid = cardinality === 'many-to-one' || cardinality === 'one-to-one';

  // Autodetect-relationships review dialog state.
  const [adOpen, setAdOpen] = useState(false);
  const [proposals, setProposals] = useState<RelProposal[]>([]);
  const [adAccepted, setAdAccepted] = useState<Record<string, boolean>>({});
  const [adBusy, setAdBusy] = useState(false);
  const [adErr, setAdErr] = useState<string | null>(null);

  const positions = useMemo(() => gridLayout(tables), [tables]);

  useEffect(() => {
    setRfNodes(tables.map((t) => ({
      id: t.id,
      type: 'model-table',
      position: positions.get(t.id) || { x: 0, y: 0 },
      data: { table: t } as TableCardNodeData,
      selected: t.id === selectedId,
    })));
  }, [tables, positions, selectedId, setRfNodes]);

  const rfEdges: Edge[] = useMemo(() => {
    const ids = new Set(tables.map((t) => t.id));
    return relationships
      .filter((r) => ids.has(r.fromTable) && ids.has(r.toTable))
      .map((r) => {
        const ends = cardinalityEnds(r.cardinality);
        const highlight = selectedId === r.fromTable || selectedId === r.toTable;
        const color = highlight ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke1;
        return {
          id: r.id,
          source: r.fromTable,
          target: r.toTable,
          sourceHandle: `col:${r.fromColumn}`,
          targetHandle: `col:${r.toColumn}`,
          type: 'smoothstep',
          // FLAG: the `⇄` is a cardinality/cross-filter notation marker rendered
          // inside the edge LABEL text (the Power BI Model-view "both directions"
          // glyph), not a UI icon — Fluent icons can't be embedded in a React
          // Flow string edge label. Acceptable per the kit rules as a textual
          // cardinality marker alongside the `1`/`*` ends.
          label: `${ends.from} — ${ends.to}${r.crossFilter === 'both' ? ' ⇄' : ''}`,
          labelStyle: { fontSize: tokens.fontSizeBase100, fill: tokens.colorNeutralForeground2 },
          animated: false,
          style: {
            stroke: color,
            strokeWidth: r.active ? 1.75 : 1,
            opacity: r.active ? 1 : 0.5,
            strokeDasharray: r.active ? undefined : '4 2',
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          data: { rel: r },
        } as Edge;
      });
  }, [relationships, tables, selectedId]);

  const fit = useCallback(() => rf.fitView({ padding: 0.2, duration: 250 }), [rf]);

  const onConnect = useCallback((conn: Connection) => {
    if (readOnly) return;
    if (!conn.source || !conn.target) return;
    const fromColumn = colFromHandle(conn.sourceHandle);
    const toColumn = colFromHandle(conn.targetHandle);
    if (!fromColumn || !toColumn) {
      setErr('Drag from a column key on one table to a column key on another to create a relationship.');
      setDraft({ fromTable: conn.source, fromColumn: fromColumn || '', toTable: conn.target, toColumn: toColumn || '' });
      setCardinality('many-to-one');
      setCrossFilter('single');
      setActive(true);
      setAssumeRI(false);
      setDlgOpen(true);
      return;
    }
    setErr(null);
    setDraft({ fromTable: conn.source, fromColumn, toTable: conn.target, toColumn });
    setCardinality('many-to-one');
    setCrossFilter('single');
    setActive(true);
    setAssumeRI(false);
    setDlgOpen(true);
  }, [readOnly]);

  const confirmCreate = useCallback(async () => {
    if (!draft || !draft.fromColumn || !draft.toColumn) { setErr('Pick a column on both ends.'); return; }
    setBusy(true); setErr(null);
    try {
      const fromShort = draft.fromTable.split('.').pop();
      const toShort = draft.toTable.split('.').pop();
      await onCreateRelationship({
        name: `FK_${fromShort}_${toShort}_${draft.fromColumn}`.replace(/[^A-Za-z0-9_]/g, '_'),
        fromTable: draft.fromTable,
        fromColumn: draft.fromColumn,
        toTable: draft.toTable,
        toColumn: draft.toColumn,
        cardinality,
        crossFilter,
        active,
        // RI only applies on the many-to-one / one-to-one shapes; otherwise off.
        assumeReferentialIntegrity: riValid ? assumeRI : false,
      });
      setDlgOpen(false);
      setDraft(null);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, cardinality, crossFilter, active, riValid, assumeRI, onCreateRelationship]);

  // --- Autodetect relationships ------------------------------------------
  // Open the review dialog seeded with proposals from the REAL loaded schema.
  const openAutodetect = useCallback(() => {
    const found = detectRelationships(tables, relationships);
    setProposals(found);
    setAdAccepted(Object.fromEntries(found.map((p) => [p.key, true])));
    setAdErr(null);
    setAdOpen(true);
  }, [tables, relationships]);

  // Create every accepted proposal through the same onCreateRelationship route
  // the manual dialog uses. Errors are surfaced; partial success is honest.
  const applyAutodetect = useCallback(async () => {
    const toCreate = proposals.filter((p) => adAccepted[p.key] !== false);
    if (!toCreate.length) { setAdOpen(false); return; }
    setAdBusy(true); setAdErr(null);
    let created = 0;
    const failures: string[] = [];
    for (const p of toCreate) {
      try {
        const fromShort = p.fromTable.split('.').pop();
        const toShort = p.toTable.split('.').pop();
        await onCreateRelationship({
          name: `FK_${fromShort}_${toShort}_${p.fromColumn}`.replace(/[^A-Za-z0-9_]/g, '_'),
          fromTable: p.fromTable,
          fromColumn: p.fromColumn,
          toTable: p.toTable,
          toColumn: p.toColumn,
          cardinality: p.cardinality,
          crossFilter: 'single',
          active: true,
          assumeReferentialIntegrity: false,
        });
        created += 1;
      } catch (e: any) {
        failures.push(`${p.reason}: ${e?.message || String(e)}`);
      }
    }
    setAdBusy(false);
    if (failures.length) {
      setAdErr(`Created ${created} of ${toCreate.length}. ${failures.length} failed — ${failures.join('; ')}`);
    } else {
      setAdOpen(false);
    }
  }, [proposals, adAccepted, onCreateRelationship]);

  const acceptedCount = useMemo(
    () => proposals.filter((p) => adAccepted[p.key] !== false).length,
    [proposals, adAccepted],
  );

  const onEdgeClick = useCallback(async (_: React.MouseEvent, edge: Edge) => {
    if (readOnly) return;
    const rel = (edge.data as { rel?: ModelRelationship } | undefined)?.rel;
    if (!rel) return;
    if (!window.confirm(`Delete relationship ${rel.name || rel.id}?\n${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}`)) return;
    await onDeleteRelationship(rel);
  }, [readOnly, onDeleteRelationship]);

  const draftCols = (tableId: string): ModelColumn[] =>
    tables.find((t) => t.id === tableId)?.columns || [];

  return (
    // User-resizable outer height (drag the bottom grip or use the keyboard),
    // persisted per-surface. Bounds: minPx 320 (the inherent floor for the
    // table-card grid) up to ~80vh, default 520 — matching the shell's prior
    // fixed height so first paint is visually unchanged.
    <ResizableCanvasRegion
      storageKey="semantic-model-view"
      defaultPx={520}
      minPx={320}
      ariaLabel="Resize model diagram canvas height"
    >
    <div className={st.shell} data-testid="model-view-canvas" aria-label="Model view relationship canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        onNodeClick={(_, n) => setSelectedId((cur) => (cur === n.id ? null : n.id))}
        onPaneClick={() => setSelectedId(null)}
        minZoom={0.2}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={!readOnly}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
        <Panel position="top-left">
          <div className={st.toolbar}>
            <Tooltip
              content={
                readOnly
                  ? 'Resume the compute to autodetect relationships'
                  : tables.length < 2
                    ? 'Load at least two tables to autodetect relationships'
                    : 'Scan the loaded schema and propose foreign-key relationships'
              }
              relationship="label"
            >
              <Button
                size="small"
                appearance="subtle"
                icon={<Sparkle20Regular />}
                onClick={openAutodetect}
                disabled={readOnly || tables.length < 2}
              >
                Autodetect relationships
              </Button>
            </Tooltip>
          </div>
        </Panel>
        <Panel position="top-right">
          <div className={st.toolbar}>
            <Tooltip content="Auto-layout" relationship="label">
              <Button size="small" appearance="subtle" icon={<Organization20Regular />} aria-label="Auto-layout" onClick={fit} />
            </Tooltip>
            <Tooltip content="Zoom to fit" relationship="label">
              <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Zoom to fit" onClick={fit} />
            </Tooltip>
          </div>
        </Panel>
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ backgroundColor: tokens.colorNeutralBackground1 }} />
      </ReactFlow>

      {tables.length === 0 && (
        <div className={st.empty} role="status">
          <DocumentTable16Regular fontSize={28} />
          <Text weight="semibold">No tables to model</Text>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {emptyMessage || 'Create tables in the warehouse, then drag between column keys to define relationships.'}
          </Caption1>
        </div>
      )}

      {/* Create-relationship dialog */}
      <Dialog open={dlgOpen} onOpenChange={(_, d) => setDlgOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Create relationship</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {err && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not create</MessageBarTitle>{err}</MessageBarBody></MessageBar>
                )}
                {draft && (
                  <>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                      <Field label="From table" style={{ flex: 1 }}>
                        <Input value={draft.fromTable} readOnly aria-label="From table" />
                      </Field>
                      <Field label="From column" style={{ flex: 1 }}>
                        <Dropdown
                          value={draft.fromColumn}
                          selectedOptions={draft.fromColumn ? [draft.fromColumn] : []}
                          onOptionSelect={(_, d) => d.optionValue && setDraft({ ...draft, fromColumn: d.optionValue })}
                        >
                          {draftCols(draft.fromTable).map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                      <Field label="To table" style={{ flex: 1 }}>
                        <Input value={draft.toTable} readOnly aria-label="To table" />
                      </Field>
                      <Field label="To column" style={{ flex: 1 }}>
                        <Dropdown
                          value={draft.toColumn}
                          selectedOptions={draft.toColumn ? [draft.toColumn] : []}
                          onOptionSelect={(_, d) => d.optionValue && setDraft({ ...draft, toColumn: d.optionValue })}
                        >
                          {draftCols(draft.toTable).map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                      <Field label="Cardinality" style={{ flex: 1 }}>
                        <Dropdown
                          value={cardinality}
                          selectedOptions={[cardinality]}
                          onOptionSelect={(_, d) => d.optionValue && setCardinality(d.optionValue as Cardinality)}
                        >
                          {CARDINALITIES.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Cross-filter" style={{ flex: 1 }}>
                        <Dropdown
                          value={crossFilter}
                          selectedOptions={[crossFilter]}
                          onOptionSelect={(_, d) => d.optionValue && setCrossFilter(d.optionValue as CrossFilter)}
                        >
                          {CROSS_FILTERS.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    <Switch checked={active} label="Active relationship" onChange={(_, d) => setActive(!!d.checked)} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
                      <Switch
                        checked={riValid && assumeRI}
                        disabled={!riValid}
                        label="Assume referential integrity"
                        onChange={(_, d) => setAssumeRI(!!d.checked)}
                      />
                      <Caption1 className={st.riHint}>
                        {riValid
                          ? 'Every value on the many side exists on the one side — lets the query path use a faster INNER join.'
                          : 'Available only for many-to-one or one-to-one relationships.'}
                      </Caption1>
                    </div>
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDlgOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={confirmCreate} disabled={busy || !draft?.fromColumn || !draft?.toColumn}>
                {busy ? 'Creating…' : 'Create relationship'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Autodetect-relationships review dialog — proposals from the REAL schema */}
      <Dialog open={adOpen} onOpenChange={(_, d) => { if (!adBusy) setAdOpen(d.open); }}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>Autodetect relationships</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {adErr && (
                  <MessageBar intent="error">
                    <MessageBarBody><MessageBarTitle>Some relationships could not be created</MessageBarTitle>{adErr}</MessageBarBody>
                  </MessageBar>
                )}
                {proposals.length === 0 ? (
                  <div className={st.adEmpty}>
                    <Sparkle20Regular fontSize={28} />
                    <Text weight="semibold">No new relationships detected</Text>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Loom looks for <code>&lt;Table&gt;Key</code> / <code>&lt;Table&gt;Id</code> columns or shared
                      key names with compatible types. Add key columns, or draw one by dragging between column keys.
                    </Caption1>
                  </div>
                ) : (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        Proposed from the loaded schema. Each accepted row is created as a many-to-one relationship
                        through the same backend as a manual relationship; existing relationships are skipped.
                      </MessageBarBody>
                    </MessageBar>
                    <div className={st.adList}>
                      <Table aria-label="Detected relationship proposals" size="small">
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell style={{ width: '44px' }}>
                              <Checkbox
                                aria-label="Select all proposals"
                                checked={acceptedCount === proposals.length ? true : acceptedCount === 0 ? false : 'mixed'}
                                onChange={(_, d) => setAdAccepted(Object.fromEntries(proposals.map((p) => [p.key, !!d.checked])))}
                              />
                            </TableHeaderCell>
                            <TableHeaderCell>From (many)</TableHeaderCell>
                            <TableHeaderCell>To (one)</TableHeaderCell>
                            <TableHeaderCell>Match</TableHeaderCell>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {proposals.map((p) => {
                            const checked = adAccepted[p.key] !== false;
                            return (
                              <TableRow key={p.key}>
                                <TableCell>
                                  <Checkbox
                                    aria-label={`Accept ${p.reason}`}
                                    checked={checked}
                                    onChange={() => setAdAccepted((prev) => ({ ...prev, [p.key]: !(prev[p.key] !== false) }))}
                                  />
                                </TableCell>
                                <TableCell>
                                  <code style={{ fontSize: tokens.fontSizeBase100 }}>{p.fromTable.split('.').pop()}.{p.fromColumn}</code>
                                </TableCell>
                                <TableCell>
                                  <code style={{ fontSize: tokens.fontSizeBase100 }}>{p.toTable.split('.').pop()}.{p.toColumn}</code>
                                </TableCell>
                                <TableCell><Caption1>{p.reason.split('·').pop()?.trim()}</Caption1></TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAdOpen(false)} disabled={adBusy}>
                {proposals.length === 0 ? 'Close' : 'Cancel'}
              </Button>
              {proposals.length > 0 && (
                <Button appearance="primary" onClick={applyAutodetect} disabled={adBusy || acceptedCount === 0}>
                  {adBusy ? 'Creating…' : `Create ${acceptedCount} relationship${acceptedCount === 1 ? '' : 's'}`}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
    </ResizableCanvasRegion>
  );
}

/** Public canvas component — wraps the inner canvas in a ReactFlowProvider. */
export function ModelViewCanvas(props: ModelViewCanvasProps) {
  return (
    <ReactFlowProvider>
      <ModelViewCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// ===========================================================================
// ModelViewPanel — data-fetching wrapper used by the editors. Owns the model
// fetch, relationship create/delete, and the measures panel + editor.
// ===========================================================================

export type ModelEngine = 'warehouse' | 'synapse-dedicated-sql-pool' | 'databricks-sql-warehouse';

interface ModelResponse {
  ok: boolean;
  tables?: ModelTable[];
  relationships?: ModelRelationship[];
  measures?: ModelMeasure[];
  error?: string;
  message?: string;
  state?: string;
  /** Honest gate text surfaced when the backing compute is offline. */
  notice?: string;
  /** Route's own compute probe — false when the backing compute is offline. */
  computeReady?: boolean;
}

export interface ModelViewPanelProps {
  engine: ModelEngine;
  id: string;
  /** Extra query params appended to GET/POST/DELETE (Databricks needs warehouseId/catalog/schema). */
  query?: Record<string, string | undefined>;
  /** Compute is online — relationships/measures can be written. */
  ready: boolean;
  notReadyMessage?: string;
  /** TVF for Synapse/Warehouse (real CREATE FUNCTION); cosmos for Databricks. */
  measureKind: 'tvf' | 'cosmos';
  /** Push a measure's usage SQL into the host editor's query tab. */
  onUseInQuery?: (sql: string) => void;
}

function buildUrl(engine: ModelEngine, id: string, query?: Record<string, string | undefined>, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v) params.set(k, v);
  for (const [k, v] of Object.entries(extra || {})) if (v) params.set(k, v);
  const qs = params.toString();
  return `/api/items/${engine}/${encodeURIComponent(id)}/model${qs ? `?${qs}` : ''}`;
}

const panelStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  measuresHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export function ModelViewPanel({ engine, id, query, ready, notReadyMessage, measureKind, onUseInQuery }: ModelViewPanelProps) {
  const ps = panelStyles();
  const [data, setData] = useState<{ tables: ModelTable[]; relationships: ModelRelationship[]; measures: ModelMeasure[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  // Edit-ability follows the route's own compute probe (computeReady) once a
  // GET has returned; before that it falls back to the parent's hint.
  const [liveReady, setLiveReady] = useState(ready);

  // New-measure dialog.
  const [mOpen, setMOpen] = useState(false);
  const [mName, setMName] = useState('');
  const [mSchema, setMSchema] = useState('dbo');
  const [mExpr, setMExpr] = useState(
    measureKind === 'tvf'
      ? 'SELECT SUM(Amount) AS TotalSales FROM dbo.Sales'
      : 'SELECT sum(amount) AS total_sales FROM sales',
  );
  const [mBusy, setMBusy] = useState(false);
  const [mErr, setMErr] = useState<string | null>(null);

  const queryKey = JSON.stringify(query || {});

  const load = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setLoadErr(null); setGate(null);
    try {
      const r = await fetch(buildUrl(engine, id, query));
      const j = (await r.json()) as ModelResponse;
      if (!j.ok) {
        if (r.status === 409) setGate(j.message || j.error || `Compute is ${j.state || 'offline'}.`);
        else setLoadErr(j.error || j.message || `HTTP ${r.status}`);
        setData({ tables: [], relationships: [], measures: [] });
        return;
      }
      setData({ tables: j.tables ?? [], relationships: j.relationships ?? [], measures: j.measures ?? [] });
      setLiveReady(j.computeReady !== false);
      if (j.notice) setGate(j.notice);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, id, queryKey]);

  useEffect(() => { void load(); }, [load]);

  const createRel = useCallback(async (rel: Omit<ModelRelationship, 'id'>) => {
    const r = await fetch(buildUrl(engine, id, query), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relationship: rel }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    await load();
  }, [engine, id, query, load]);

  const deleteRel = useCallback(async (rel: ModelRelationship) => {
    const r = await fetch(buildUrl(engine, id, query, { relId: rel.id }), { method: 'DELETE' });
    const j = await r.json().catch(() => ({ ok: r.ok }));
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    await load();
  }, [engine, id, query, load]);

  const saveMeasure = useCallback(async () => {
    if (!mName.trim()) { setMErr('Measure name is required.'); return; }
    if (!mExpr.trim()) { setMErr('Measure expression is required.'); return; }
    setMBusy(true); setMErr(null);
    try {
      const r = await fetch(buildUrl(engine, id, query, { kind: 'measure' }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          measure: {
            name: mName.trim(),
            schema: measureKind === 'tvf' ? (mSchema.trim() || 'dbo') : undefined,
            expression: mExpr,
            kind: measureKind,
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
      setMOpen(false);
      await load();
    } catch (e: any) {
      setMErr(e?.message || String(e));
    } finally {
      setMBusy(false);
    }
  }, [engine, id, query, mName, mSchema, mExpr, measureKind, load]);

  const usageSql = useCallback((m: ModelMeasure): string => {
    if (m.kind === 'tvf' || m.kind === 'scalar') {
      const sch = (m.schema || 'dbo').replace(/[[\]]/g, '');
      const nm = m.name.replace(/[[\]]/g, '');
      return `SELECT * FROM [${sch}].[${nm}]();`;
    }
    // Cosmos-stored measure — usable as a CTE.
    return `WITH ${m.name} AS (\n${m.expression}\n)\nSELECT * FROM ${m.name};`;
  }, []);

  const tables = data?.tables ?? [];
  const relationships = data?.relationships ?? [];
  const measures = data?.measures ?? [];

  return (
    <div className={ps.wrap}>
      {loading && <Spinner size="tiny" label="Loading model…" labelPosition="after" />}
      {loadErr && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Model load failed</MessageBarTitle>{loadErr}</MessageBarBody></MessageBar>
      )}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Compute offline</MessageBarTitle>
            {gate} The Model view still renders; resume the compute to load live tables and create relationships.
          </MessageBarBody>
        </MessageBar>
      )}
      {!ready && !gate && notReadyMessage && (
        <MessageBar intent="info"><MessageBarBody>{notReadyMessage}</MessageBarBody></MessageBar>
      )}

      <ModelViewCanvas
        tables={tables}
        relationships={relationships}
        onCreateRelationship={createRel}
        onDeleteRelationship={deleteRel}
        readOnly={!liveReady}
        emptyMessage={liveReady ? undefined : (notReadyMessage || 'Resume the compute to load tables.')}
      />

      {/* Measures panel */}
      <div className={ps.measuresHead}>
        <MathFormula20Regular />
        <Text weight="semibold">Measures ({measures.length})</Text>
        <Button
          size="small" appearance="primary" icon={<Add20Regular />}
          onClick={() => { setMErr(null); setMName(''); setMOpen(true); }}
          disabled={!liveReady}
          title={!liveReady ? 'Resume the compute to add a measure' : undefined}
        >
          New measure
        </Button>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 240, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
        <Table aria-label="Measures" size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Definition</TableHeaderCell>
              <TableHeaderCell>Use</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {measures.length === 0 && (
              <TableRow><TableCell colSpan={4}><Caption1>No measures yet. Click “New measure”.</Caption1></TableCell></TableRow>
            )}
            {measures.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.schema ? `${m.schema}.${m.name}` : m.name}</TableCell>
                <TableCell><Badge appearance="outline" color={m.kind === 'cosmos' ? 'informative' : 'brand'}>{m.kind}</Badge></TableCell>
                <TableCell style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <code style={{ fontSize: tokens.fontSizeBase100 }}>{m.expression.slice(0, 160)}</code>
                </TableCell>
                <TableCell>
                  <Tooltip content="Load this measure into the Query tab" relationship="label">
                    <Button
                      size="small" appearance="subtle" icon={<Play16Regular />}
                      aria-label={`Use ${m.name} in query`}
                      onClick={() => onUseInQuery?.(usageSql(m))}
                      disabled={!onUseInQuery}
                    >
                      Use in query
                    </Button>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* New-measure dialog */}
      <Dialog open={mOpen} onOpenChange={(_, d) => setMOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>New measure</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                {mErr && (
                  <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not save measure</MessageBarTitle>{mErr}</MessageBarBody></MessageBar>
                )}
                <MessageBar intent="info">
                  <MessageBarBody>
                    {measureKind === 'tvf'
                      ? 'A warehouse measure is materialized as a real inline table-valued function (CREATE OR ALTER FUNCTION … RETURNS TABLE). It runs against the live compute and is queryable as a function.'
                      : 'A Databricks measure is stored as Loom tabular metadata and is usable as a query CTE (no Power BI / Fabric dependency).'}
                  </MessageBarBody>
                </MessageBar>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
                  {measureKind === 'tvf' && (
                    <Field label="Schema" style={{ width: 160 }}>
                      <Input value={mSchema} onChange={(_, d) => setMSchema(d.value)} placeholder="dbo" />
                    </Field>
                  )}
                  <Field label="Measure name" required style={{ flex: 1 }}>
                    <Input value={mName} onChange={(_, d) => setMName(d.value)} placeholder="fn_TotalSales" />
                  </Field>
                </div>
                <Field label="Definition (the SELECT the measure returns)" required>
                  <MonacoTextarea
                    value={mExpr}
                    onChange={setMExpr}
                    language={measureKind === 'tvf' ? 'tsql' : 'sql'}
                    height={180}
                    minHeight={140}
                    ariaLabel="Measure definition editor"
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setMOpen(false)} disabled={mBusy}>Cancel</Button>
              <Button appearance="primary" onClick={saveMeasure} disabled={mBusy || !mName.trim() || !mExpr.trim()}>
                {mBusy ? 'Saving…' : 'Save measure'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
