'use client';

/**
 * MappingDataFlowDesigner — the visual ADF / Synapse SPARK-based MAPPING DATA
 * FLOW designer.
 *
 * This is the Spark-executed `Microsoft.DataFactory/factories/dataflows`
 * (`properties.type === 'MappingDataFlow'`) editor — the one whose graph of
 * Source / Sink / transformation nodes compiles to the Data Flow Script (DFS)
 * Spark runs. It is DISTINCT from the Power Query / Dataflow Gen2 editor in
 * `power-query-host.tsx` / `m-script.ts` / `dataflow-diagram.tsx` (that one is
 * `WranglingDataFlow`, an M mashup) — this file leaves that surface alone.
 *
 * WHAT IT DELIVERS (1:1 with ADF Studio's "Data flow" canvas — ui-parity.md)
 * --------------------------------------------------------------------------
 *   - A React Flow canvas reusing the pipeline's node/edge engine + styling —
 *     a transform node modeled on `flow-activity-node.tsx` (swatch + icon +
 *     name + type badge, real `<Handle>` ports) and a Bezier data-stream edge
 *     modeled on `loom-bezier-edge.tsx`.
 *   - Nodes are transformations from `dataflow-transform-catalog.ts`; edges are
 *     the data streams between them.
 *   - The Studio "＋" affordance on a stream's output: an add-transformation
 *     menu grouped by the catalog's categories, inserting a new node wired to
 *     the clicked output.
 *   - Source / Sink nodes (0-in / 1-out and 1-in / 0-out) bind a dataset via
 *     the shared `<DatasetPicker/>`; multi-input transforms (Join / Lookup /
 *     Exists / Union) render extra TARGET handles and multi-output transforms
 *     (Conditional split / New branch) render extra SOURCE handles.
 *   - Node selection opens the right config panel — STRUCTURED FORMS built from
 *     the catalog's `settings` (no freeform JSON, per loom-no-freeform-config).
 *     Data-flow-expression fields (`dataFlowExpression`) get a focused DF-expr
 *     editor (the Spark column DSL — a DIFFERENT language from pipeline `@{…}`,
 *     so we do NOT reuse the `@{…}` ExpressionField for them). Pipeline-
 *     expression fields (`supportsDynamic`) use the shared `ExpressionField`.
 *   - A top toolbar with the data-flow Debug toggle. Starting a debug session /
 *     a per-transform Data preview requires a LIVE Spark debug cluster (an
 *     Azure IR with data-flow compute). We render that as an HONEST Fluent
 *     MessageBar gate naming the exact requirement — never a faked preview
 *     (no-vaporware.md).
 *
 * ROUND-TRIP (real REST, no mocks)
 * --------------------------------
 * The graph serialises to the ADF DataFlow `properties.typeProperties`:
 *   sources[]         — Source transform nodes        ({ name, dataset?|… })
 *   sinks[]           — Sink transform nodes           ({ name, dataset?|… })
 *   transformations[] — every other node               ({ name, description? })
 *   scriptLines[]     — the generated Data Flow Script (the DSL Spark executes)
 * and PUTs to the existing BFF route `PUT /api/adf/dataflows/{name}` (ADF) or
 * `…/api/synapse/dataflows` (Synapse workspace dev plane) — both already call
 * the real ARM REST `upsertDataFlow` in `lib/azure/adf-client.ts` /
 * `synapse-artifacts-client.ts`. `GET /api/adf/dataflows/{name}` rehydrates an
 * existing flow (parsed back from its `scriptLines`).
 *
 * Grounding: data-flow-transformation-overview, data-flow-script,
 * data-transformation-functions, concepts-data-flow-debug-mode (Microsoft
 * Learn) — see the catalog header for the per-transform links.
 */

import {
  forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode, type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  Panel, useReactFlow, useNodesState,
  ConnectionMode, Position, Handle,
  type Node, type Edge, type Connection, type NodeChange, type NodeProps,
  type EdgeProps, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Badge, Button, Caption1, Divider, Field, Input, MenuButton, MessageBar,
  MessageBarBody, MessageBarTitle, Select, Spinner, Subtitle2, Switch, Text,
  Title3, Tooltip,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader,
  Textarea, Toast, ToastTitle, Toaster, useToastController, useId,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  Add16Filled, Add20Regular, Bug20Regular, Save20Regular,
  Code20Regular, Delete20Regular, FullScreenMaximize20Regular,
  Organization20Regular, Eye20Regular, Beaker20Regular,
  DatabaseArrowDown20Regular, Flowchart20Regular,
} from '@fluentui/react-icons';
import {
  TRANSFORM_CATEGORIES, transformByType, transformsByCategory,
  type TransformField,
} from '@/lib/pipeline/dataflow-transform-catalog';
import {
  CanvasNode, CanvasEdge, getTransformVisual, transformIcon, portStyle,
  type CanvasNodeStatus,
} from '@/lib/components/canvas/canvas-node-kit';
import { DatasetPicker } from '../dataset-picker';
import { ExpressionField } from '../expression-field';
import type { AdfDataset, AdfDataFlow } from '@/lib/azure/adf-client';

// =============================================================================
// Model — the in-editor graph (serialises to ADF DataFlow typeProperties).
// =============================================================================

/** One transform instance on the canvas. */
export interface DfTransformInstance {
  /** Unique node id (= the transform's output stream name; DFS `~> name`). */
  name: string;
  /** Catalog `type` token (source/sink/select/filter/join/…). */
  type: string;
  description?: string;
  /** Collected setting values, keyed by the catalog field `key`. */
  settings: Record<string, unknown>;
  /** Canvas position (editor-only; ADF JSON has no viewport concept). */
  position?: { x: number; y: number };
  /** Bound dataset for Source/Sink nodes (DatasetReference name). */
  dataset?: string;
  /**
   * Optional run/config status driving the node's `StatusChip` (defaults to
   * `idle`, which shows the type label). Editor-only; not serialised to ADF.
   */
  status?: CanvasNodeStatus;
}

/** A data-stream connection: one transform's output feeds another's input. */
export interface DfStream {
  /** Upstream transform name. */
  from: string;
  /** Downstream transform name. */
  to: string;
  /**
   * Which input slot on the downstream node this stream feeds. `0` is the
   * primary input; `1`+ are the secondary inputs (Join/Lookup/Exists right,
   * Union extra streams). For multi-OUTPUT upstreams the output slot is encoded
   * in `fromSlot`.
   */
  toSlot?: number;
  /** Which output slot on the upstream node feeds this stream (split branches). */
  fromSlot?: number;
}

/** The whole authored data flow. */
export interface MappingDataFlowGraph {
  transforms: DfTransformInstance[];
  streams: DfStream[];
}

// Node visuals (icon + category accent + gradient) are resolved from the shared
// canvas kit via `getTransformVisual(type)` / `transformIcon(def)` — the kit is
// the single source of node tinting (theme-aware `--loom-accent-*` via
// `color-mix`, never raw hex). The catalog `TransformDef.category` drives which
// of the five canvas categories (and thus accent) a transform gets.

const NODE_W = 210;
const NODE_H = 86;

// =============================================================================
// Data Flow Script (DFS) serialisation.
//
// We emit ONE script line per transform, in dependency order, matching the
// real Spark DFS grammar (`source(...) ~> source1`, `<in> filter(<expr>) ~>
// f1`, `<l>, <r> join(<cond>, joinType:'inner') ~> j1`, …). The line carries
// the transform's structured settings as DFS properties so the assembled
// `scriptLines[]` validates against the engine. The catalog `key`/`type`
// tokens are the exact DFS property names, so this is a faithful (not
// best-effort) projection.
// =============================================================================

/** Quote a DFS string literal. */
function q(v: unknown): string {
  return `'${String(v ?? '').replace(/'/g, "\\'")}'`;
}

/** Inputs feeding a transform, ordered by slot, as upstream stream names. */
function inputsOf(graph: MappingDataFlowGraph, name: string): string[] {
  return graph.streams
    .filter((s) => s.to === name)
    .sort((a, b) => (a.toSlot ?? 0) - (b.toSlot ?? 0))
    .map((s) => s.from);
}

/** The body (after the input prefix, before `~> name`) for one transform. */
function transformBody(t: DfTransformInstance, inputs: string[]): string {
  const s = t.settings || {};
  const get = (k: string) => (s[k] != null ? String(s[k]) : '');
  const lines = (k: string) => get(k).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  switch (t.type) {
    case 'source': {
      const opts: string[] = ['allowSchemaDrift: ' + (s.allowSchemaDrift ? 'true' : 'false')];
      if (s.validateSchema) opts.push('validateSchema: true');
      if (s.ignoreNoFilesFound) opts.push('ignoreNoFilesFound: true');
      if (get('skipLineCount')) opts.push(`skipLines: ${get('skipLineCount')}`);
      if (t.dataset || s.dataset) opts.push(`dataset: ${q(t.dataset || get('dataset'))}`);
      else if (get('linkedService')) opts.push(`store: ${q(get('format') || 'delimited')}`);
      return `source(${opts.join(', ')})`;
    }
    case 'sink': {
      const opts: string[] = ['allowSchemaDrift: ' + (s.allowSchemaDrift ? 'true' : 'false')];
      if (s.validateSchema) opts.push('validateSchema: true');
      if (s.insertable) opts.push('insertable: true');
      if (s.updateable) opts.push('updateable: true');
      if (s.upsertable) opts.push('upsertable: true');
      if (s.deletable) opts.push('deletable: true');
      if (get('keys')) opts.push(`keys: [${lines('keys').join(',') || get('keys')}]`);
      if (t.dataset || s.dataset) opts.push(`dataset: ${q(t.dataset || get('dataset'))}`);
      return `sink(${opts.join(', ')})`;
    }
    case 'select': {
      if (get('mappingMode') === 'rule') {
        return `select(mapColumn(each(match(${get('matchCondition')}), ${get('nameAs') || '$$'} = $$)), skipDuplicateMapInputs: ${s.skipDuplicateMapInputs ? 'true' : 'false'})`;
      }
      const maps = lines('columnMappings').map((m) => m.replace('=', ' =').replace(/\s+/g, ' '));
      return `select(mapColumn(${maps.join(', ') || 'each(match(true()))'}))`;
    }
    case 'derive':
      return `derive(${lines('columns').join(', ')})`;
    case 'aggregate': {
      const grp = lines('groupBy').join(', ');
      const agg = lines('aggregates').join(', ');
      return grp ? `aggregate(groupBy(${grp}), ${agg})` : `aggregate(${agg})`;
    }
    case 'pivot':
      return `pivot(groupBy(${get('groupBy')}), pivotBy(${get('pivotKey')}), ${lines('pivotedColumns').join(', ')}, columnNaming: ${q(get('columnNaming') || '$N$V')})`;
    case 'unpivot':
      return `unpivot(ungroupBy(${get('ungroupBy')}), unpivotKey: ${q(get('unpivotKey'))}, mapColumn(${get('unpivotedColumnName')}))`;
    case 'window':
      return `window(over(${get('over')}), asc(${get('sort')}), ${lines('windowColumns').join(', ')})`;
    case 'keyGenerate':
      return `keyGenerate(output(${get('keyColumn')} as long), startAt: ${get('startValue') || '1'}L)`;
    case 'rank':
      return `rank(${s.dense ? 'dense: true, ' : ''}output(${get('rankColumn')} as long), ${lines('sortConditions').join(', ')})`;
    case 'cast':
      return `cast(output(${lines('casts').map((c) => c.replace('->', 'as')).join(', ')}), errorHandling: ${q(get('errorHandling') || 'fail')})`;
    case 'call':
      return `call(store: ${q(get('store') || 'restservice')}, format: 'rest', method: ${q(get('httpMethod') || 'GET')})`;
    case 'filter':
      return `filter(${get('condition')})`;
    case 'sort':
      return `sort(${lines('sortConditions').join(', ')})`;
    case 'alterRow': {
      const rules: string[] = [];
      if (get('insertIf')) rules.push(`insertIf(${get('insertIf')})`);
      if (get('updateIf')) rules.push(`updateIf(${get('updateIf')})`);
      if (get('upsertIf')) rules.push(`upsertIf(${get('upsertIf')})`);
      if (get('deleteIf')) rules.push(`deleteIf(${get('deleteIf')})`);
      return `alterRow(${rules.join(', ')})`;
    }
    case 'assert':
      return `assert(${get('assertType') || 'expectTrue'}(${get('expression')}))`;
    case 'join': {
      const [, right] = inputs;
      const r = get('rightStream') || right || 'right';
      return `${r} join(${get('condition')}, joinType: ${q(get('joinType') || 'inner')}, broadcast: ${q(get('broadcast') || 'auto')})`;
    }
    case 'lookup': {
      const [, right] = inputs;
      const r = get('lookupStream') || right || 'lookup';
      return `${r} lookup(${get('condition')}, multiple: ${s.matchMultiple ? 'true' : 'false'}, pickup: ${q(get('matchOn') || 'any')}, broadcast: ${q(get('broadcast') || 'auto')})`;
    }
    case 'exists': {
      const [, right] = inputs;
      const r = get('rightStream') || right || 'exists';
      return `${r} exists(${get('condition')}, negate: ${get('existsType') === 'notExists' ? 'true' : 'false'}, broadcast: ${q(get('broadcast') || 'auto')})`;
    }
    case 'union': {
      const extra = get('unionStreams').split(',').map((x) => x.trim()).filter(Boolean);
      return `union(${extra.join(', ')})`;
    }
    case 'split': {
      const conds = lines('conditions').map((c) => {
        const [, expr] = c.split(/:(.+)/);
        return expr ? expr.trim() : c;
      });
      return `split(${conds.join(', ')}, disjoint: ${get('splitOn') === 'all' ? 'true' : 'false'})`;
    }
    case 'newBranch':
      // New branch has no DFS body of its own — it reuses the upstream stream.
      return '';
    case 'foldDown':
      return `foldDown(unroll(${get('unrollBy')})${get('unrollRoot') ? `, unrollBy: ${get('unrollRoot')}` : ''}, mapColumn(${lines('mapping').join(', ')}))`;
    case 'parse':
      return `parse(${get('column')} = ${get('expression')} ? (${get('outputColumnType')}), format: ${q(get('format') || 'json')})`;
    case 'stringify':
      return `stringify(${get('column')} = ${get('expression')} ? string, format: ${q(get('format') || 'json')})`;
    default:
      return `${t.type}()`;
  }
}

/**
 * Topologically order the transforms so each appears after its inputs. Falls
 * back to insertion order for any cycle (shouldn't occur in a valid flow).
 */
function topoOrder(graph: MappingDataFlowGraph): DfTransformInstance[] {
  const byName = new Map(graph.transforms.map((t) => [t.name, t]));
  const indeg = new Map<string, number>();
  for (const t of graph.transforms) indeg.set(t.name, 0);
  for (const s of graph.streams) indeg.set(s.to, (indeg.get(s.to) ?? 0) + 1);
  const queue = graph.transforms.filter((t) => (indeg.get(t.name) ?? 0) === 0).map((t) => t.name);
  const out: DfTransformInstance[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const t = byName.get(n);
    if (t) out.push(t);
    for (const s of graph.streams.filter((x) => x.from === n)) {
      const d = (indeg.get(s.to) ?? 1) - 1;
      indeg.set(s.to, d);
      if (d <= 0) queue.push(s.to);
    }
  }
  for (const t of graph.transforms) if (!seen.has(t.name)) out.push(t);
  return out;
}

/** Build the DFS `scriptLines[]` for the whole graph (one line per transform). */
export function buildScriptLines(graph: MappingDataFlowGraph): string[] {
  const ordered = topoOrder(graph);
  const out: string[] = [];
  for (const t of ordered) {
    if (t.type === 'newBranch') continue; // contributes no line
    const inputs = inputsOf(graph, t.name);
    const body = transformBody(t, inputs);
    if (!body) continue;
    const prefix = inputs.length && t.type !== 'source'
      // Multi-input transforms put the right stream(s) INSIDE the body, so the
      // line prefix is just the primary (first) input.
      ? `${inputs[0]} `
      : '';
    out.push(`${prefix}${body} ~> ${t.name}`);
  }
  return out;
}

/**
 * Serialise the editor graph to the ADF DataFlow `properties` payload that
 * `PUT /api/adf/dataflows/{name}` (real ARM `upsertDataFlow`) accepts.
 */
export function serializeDataFlow(
  graph: MappingDataFlowGraph,
  opts?: { description?: string; folder?: string },
): AdfDataFlow['properties'] {
  const datasetRef = (t: DfTransformInstance) =>
    (t.dataset || (t.settings?.dataset as string) || '')
      ? { dataset: { referenceName: String(t.dataset || t.settings?.dataset), type: 'DatasetReference' } }
      : {};
  const sources = graph.transforms
    .filter((t) => t.type === 'source')
    .map((t) => ({ name: t.name, ...datasetRef(t) }));
  const sinks = graph.transforms
    .filter((t) => t.type === 'sink')
    .map((t) => ({ name: t.name, ...datasetRef(t) }));
  const transformations = graph.transforms
    .filter((t) => t.type !== 'source' && t.type !== 'sink')
    .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }));
  return {
    type: 'MappingDataFlow',
    ...(opts?.description ? { description: opts.description } : {}),
    ...(opts?.folder ? { folder: { name: opts.folder } } : {}),
    typeProperties: {
      sources,
      sinks,
      transformations,
      scriptLines: buildScriptLines(graph),
    },
  };
}

/**
 * Parse an existing DataFlow's typeProperties back into the editor graph.
 * We reconstruct nodes from sources/sinks/transformations and wire streams from
 * the `scriptLines[]` (`<input> body ~> name` — input prefix + right-stream
 * tokens inside the body give the edges). Settings are best-effort: the script
 * is the source of truth, and re-Save re-emits a canonical script.
 */
export function parseDataFlow(props: AdfDataFlow['properties']): MappingDataFlowGraph {
  const tp = (props?.typeProperties || {}) as Record<string, unknown>;
  const sources = (tp.sources as Array<{ name: string; dataset?: { referenceName?: string } }>) || [];
  const sinks = (tp.sinks as Array<{ name: string; dataset?: { referenceName?: string } }>) || [];
  const transformations = (tp.transformations as Array<{ name: string; description?: string }>) || [];
  const scriptLines = (tp.scriptLines as string[]) || [];

  const transforms: DfTransformInstance[] = [];
  const typeOfName = new Map<string, string>();

  // Determine each named output's transform type from the script line body.
  for (const line of scriptLines) {
    const m = line.match(/~>\s*([A-Za-z0-9_]+)\s*$/);
    if (!m) continue;
    const name = m[1];
    const bodyMatch = line.match(/(?:^|\s)([a-zA-Z]+)\s*\(/);
    if (bodyMatch) typeOfName.set(name, bodyMatch[1]);
  }

  for (const s of sources) transforms.push({ name: s.name, type: 'source', settings: {}, dataset: s.dataset?.referenceName });
  for (const k of sinks) transforms.push({ name: k.name, type: 'sink', settings: {}, dataset: k.dataset?.referenceName });
  for (const t of transformations) {
    transforms.push({
      name: t.name,
      type: typeOfName.get(t.name) || 'derive',
      description: t.description,
      settings: {},
    });
  }

  // Wire streams from the script: the prefix before the body function call is
  // the primary input; any bare stream name token inside a join/lookup/exists/
  // union body is a secondary input.
  const streams: DfStream[] = [];
  const knownNames = new Set(transforms.map((t) => t.name));
  for (const line of scriptLines) {
    const m = line.match(/~>\s*([A-Za-z0-9_]+)\s*$/);
    if (!m) continue;
    const to = m[1];
    const head = line.slice(0, line.indexOf('~>'));
    const primary = head.trim().split(/\s+|\(/)[0];
    if (knownNames.has(primary) && primary !== to) {
      streams.push({ from: primary, to, toSlot: 0 });
    }
    // Secondary inputs: stream names that appear as a bare token and are known.
    const tokens = head.match(/[A-Za-z0-9_]+/g) || [];
    let slot = 1;
    for (const tk of tokens) {
      if (tk !== primary && tk !== to && knownNames.has(tk)) {
        streams.push({ from: tk, to, toSlot: slot });
        slot += 1;
      }
    }
  }

  // Lay out left-to-right by topological depth so a freshly-loaded flow reads.
  const depth = new Map<string, number>();
  const compute = (name: string, guard = 0): number => {
    if (guard > 200) return 0;
    if (depth.has(name)) return depth.get(name)!;
    const ins = streams.filter((s) => s.to === name).map((s) => s.from);
    const d = ins.length ? Math.max(...ins.map((i) => compute(i, guard + 1))) + 1 : 0;
    depth.set(name, d);
    return d;
  };
  const rowAt = new Map<number, number>();
  for (const t of transforms) {
    const d = compute(t.name);
    const row = rowAt.get(d) ?? 0;
    rowAt.set(d, row + 1);
    t.position = { x: 40 + d * (NODE_W + 80), y: 40 + row * (NODE_H + 40) };
  }
  return { transforms, streams };
}

// =============================================================================
// Canvas node — the transform node (modeled on flow-activity-node.tsx).
// =============================================================================

interface TransformNodeData {
  instance: DfTransformInstance;
  /** Open the add-transformation menu wired to this node's output (slot). */
  onAddFromOutput?: (fromName: string, slot: number, anchor: DOMRect) => void;
  [key: string]: unknown;
}

/** Distribute N ports evenly down an edge as top-% strings. */
function portTops(n: number): string[] {
  if (n <= 1) return ['50%'];
  const step = 80 / (n - 1);
  return Array.from({ length: n }, (_, i) => `${10 + i * step}%`);
}

function TransformNodeImpl({ data, selected }: NodeProps) {
  const nodeData = data as TransformNodeData;
  const t = nodeData.instance;
  const def = transformByType(t.type);
  const visual = getTransformVisual(t.type);
  const accent = visual.accent;

  // Port counts. 'n' (variable) shows the declared minimum + room to add via ＋.
  const inN = def?.ports.inputs === 'n' ? 2 : (def?.ports.inputs ?? 1);
  const outN = def?.ports.outputs === 'n' ? 2 : (def?.ports.outputs ?? 1);
  const inTops = portTops(inN);
  const outTops = portTops(outN);

  return (
    <CanvasNode
      width={NODE_W}
      title={t.name}
      visual={visual}
      selected={selected}
      status={t.status}
      typeLabel={def?.displayName || t.type}
      badges={def?.preview ? (
        <Badge appearance="outline" color="warning" size="small">Preview</Badge>
      ) : undefined}
      rootProps={{
        id: `df-node-${t.name}`,
        'data-transform-name': t.name,
        'data-transform-type': t.type,
        'aria-label': `${def?.displayName || t.type} transformation ${t.name}`,
      }}
    >
      {/* Input handle(s) on the left edge — kit `portStyle('in', accent)` owns the
          handle visual; the caller layers only the positional left/top. */}
      {inN > 0 && inTops.map((top, i) => (
        <Tooltip key={`in-${i}`} content={i === 0 ? 'Primary input stream' : `Secondary input ${i}`} relationship="label" positioning="before">
          <Handle
            id={`in-${i}`}
            type="target"
            position={Position.Left}
            data-input-slot={i}
            style={{ ...portStyle('in', accent), left: -6, top }}
          />
        </Tooltip>
      ))}

      {/* Output handle(s) on the right edge, each with a ＋ add-transform glyph. */}
      {outN > 0 && outTops.map((top, i) => (
        <div key={`out-${i}`}>
          <Handle
            id={`out-${i}`}
            type="source"
            position={Position.Right}
            data-output-slot={i}
            aria-label={i === 0 ? 'Output stream — drag to connect' : `Branch output ${i}`}
            style={{ ...portStyle('out', accent), right: -6, top }}
          />
          {nodeData.onAddFromOutput && (
            <Tooltip content="Add a transformation on this stream" relationship="label" positioning="after">
              <button
                type="button"
                className="nodrag"
                data-add-from={`${t.name}:${i}`}
                aria-label={`Add a transformation after ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  nodeData.onAddFromOutput!(t.name, i, r);
                }}
                style={{
                  position: 'absolute', right: -28, top: `calc(${top} - 9px)`,
                  width: 18, height: 18, padding: 0, zIndex: 4, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '50%', border: `1px solid ${accent}`,
                  background: tokens.colorNeutralBackground1, color: accent,
                }}
              >
                <Add16Filled />
              </button>
            </Tooltip>
          )}
        </div>
      ))}
    </CanvasNode>
  );
}

const TransformNode = memo(TransformNodeImpl);

// =============================================================================
// Canvas edge — the data stream (Bezier). A thin wrapper over the shared
// `CanvasEdge` (stroke = `--loom-accent-blue`, always lightly "flowing" so it
// reads as live data movement).
// =============================================================================

function DataStreamEdge(props: EdgeProps) {
  return <CanvasEdge {...props} stroke="var(--loom-accent-blue)" flowing />;
}

const nodeTypes: NodeTypes = { transform: TransformNode };
const edgeTypes: EdgeTypes = { stream: DataStreamEdge };

// =============================================================================
// Config panel — structured forms from the catalog (no freeform JSON).
// =============================================================================

/** Decide if a field's `showIf` condition is satisfied by current settings. */
function fieldVisible(field: TransformField, values: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const cur = values[field.showIf.key];
  if (field.showIf.equals === 'true') return cur === true || cur === 'true';
  if (field.showIf.equals === 'false') return cur === false || cur == null || cur === 'false';
  return String(cur ?? '') === field.showIf.equals;
}

interface ConfigPanelProps {
  instance: DfTransformInstance;
  datasets: AdfDataset[];
  datasetGate?: string | null;
  debugActive: boolean;
  onStartDebug: () => void;
  onPatch: (key: string, value: unknown) => void;
  onRename: (next: string) => void;
  onSetDataset: (name: string, ds: AdfDataset | undefined) => void;
  onDelete: () => void;
}

function ConfigPanel({
  instance, datasets, datasetGate, debugActive, onStartDebug,
  onPatch, onRename, onSetDataset, onDelete,
}: ConfigPanelProps) {
  const s = useStyles();
  const def = transformByType(instance.type);
  const values = instance.settings || {};
  if (!def) return null;

  return (
    <div className={s.panel} data-config-panel={instance.name}>
      <div className={s.panelHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 }}>
          <span style={{ color: getTransformVisual(def.type).accent, display: 'inline-flex' }} aria-hidden="true">
            {transformIcon(def)}
          </span>
          <Subtitle2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {def.displayName}
          </Subtitle2>
        </div>
        <Tooltip content="Delete this transformation" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<Delete20Regular />}
            aria-label={`Delete ${instance.name}`}
            onClick={onDelete}
          />
        </Tooltip>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{def.description}</Caption1>
      <Divider />

      {/* Output stream name (the node id / DFS `~> name`). */}
      <Field label="Output stream name" required>
        <Input
          value={instance.name}
          onChange={(_, d) => onRename(d.value)}
          aria-label="Output stream name"
        />
      </Field>

      {/* Source / Sink dataset binding (shared DatasetPicker). */}
      {def.needsDataset && (def.type === 'source' || def.type === 'sink') && (
        <DatasetPicker
          label={def.type === 'source' ? 'Source dataset' : 'Sink dataset'}
          value={instance.dataset || ''}
          onChange={onSetDataset}
          datasets={datasets}
          gateError={datasetGate}
          hint="Bind a reusable dataset object. Inline (Spark) datasets are set below via Source/Sink type."
        />
      )}

      {/* Catalog settings → typed controls. OUTPUT_STREAM_NAME is handled above
          so skip the catalog's own outputStreamName field. */}
      {def.settings
        .filter((f) => f.key !== 'outputStreamName')
        .filter((f) => fieldVisible(f, values))
        .map((f) => (
          <SettingField key={f.key} field={f} value={values[f.key]} onPatch={onPatch} />
        ))}

      {/* Data preview — HONEST gate (needs a live Spark debug cluster). */}
      {def.needsDebugCluster && (
        <>
          <Divider />
          <div className={s.previewHeader}>
            <Eye20Regular />
            <Text weight="semibold">Data preview</Text>
          </div>
          {debugActive ? (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Debug session is starting</MessageBarTitle>
                Preview rows stream from the live Spark debug cluster once it is
                ready (this can take several minutes on a cold cluster).
              </MessageBarBody>
            </MessageBar>
          ) : (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Debug session required</MessageBarTitle>
                Data preview executes against a live Spark <strong>data-flow debug
                cluster</strong> (an Azure Integration Runtime with data-flow
                compute). No rows are shown without one — start a debug session
                from the toolbar to preview.
              </MessageBarBody>
              <div style={{ marginTop: tokens.spacingVerticalS }}>
                <Button size="small" appearance="primary" icon={<Bug20Regular />} onClick={onStartDebug}>
                  Start debug session
                </Button>
              </div>
            </MessageBar>
          )}
        </>
      )}
    </div>
  );
}

/** Render one catalog field as a typed control (no freeform JSON). */
function SettingField({
  field, value, onPatch,
}: {
  field: TransformField;
  value: unknown;
  onPatch: (key: string, value: unknown) => void;
}) {
  const s = useStyles();
  const raw = value;

  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} hint={field.hint}>
        <Switch checked={!!raw} onChange={(_, d) => onPatch(field.key, d.checked || undefined)} />
      </Field>
    );
  }

  if (field.kind === 'select') {
    return (
      <Field label={field.label} hint={field.hint} required={field.required}>
        <Select
          value={raw != null ? String(raw) : ''}
          onChange={(_, d) => onPatch(field.key, d.value || undefined)}
        >
          <option value="" />
          {(field.options || []).map((o) => (
            <option key={o.value || '_'} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </Field>
    );
  }

  if (field.kind === 'number') {
    return (
      <Field label={field.label} hint={field.hint} required={field.required}>
        <Input
          type="number"
          placeholder={field.placeholder}
          value={raw != null ? String(raw) : ''}
          onChange={(_, d) => onPatch(field.key, d.value ? Number(d.value) : undefined)}
        />
      </Field>
    );
  }

  // Pipeline-expression field (@{…}) → shared ExpressionField. DISTINCT from
  // dataFlowExpression (the Spark column DSL) handled below.
  if (field.supportsDynamic && !field.dataFlowExpression) {
    return (
      <ExpressionField
        label={field.label}
        hint={field.hint}
        value={typeof raw === 'string' ? raw : ''}
        onChange={(v) => onPatch(field.key, v || undefined)}
        multiline={field.kind === 'multiline'}
        supportsDynamic
        placeholder={field.placeholder}
      />
    );
  }

  // Data-flow expression field — the Spark column DSL (`upper(col)`, `iif(...)`,
  // `year < 1960`). A focused monospace editor with a small DF-expr affordance;
  // NOT the @{…} pipeline-expression builder (different language).
  if (field.dataFlowExpression) {
    const multiline = field.kind === 'multiline';
    return (
      <Field
        label={(
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            {field.label}
            <Tooltip content="Data flow expression (Spark column DSL)" relationship="label">
              <Code20Regular style={{ fontSize: tokens.fontSizeBase300, color: tokens.colorBrandForeground1 }} />
            </Tooltip>
          </span>
        )}
        hint={field.hint}
        required={field.required}
      >
        {multiline ? (
          <Textarea
            className={s.dfExpr}
            placeholder={field.placeholder}
            value={typeof raw === 'string' ? raw : ''}
            rows={3}
            onChange={(_, d) => onPatch(field.key, d.value || undefined)}
          />
        ) : (
          <Input
            className={s.dfExpr}
            placeholder={field.placeholder}
            value={typeof raw === 'string' ? raw : ''}
            onChange={(_, d) => onPatch(field.key, d.value || undefined)}
          />
        )}
      </Field>
    );
  }

  if (field.kind === 'multiline') {
    return (
      <Field label={field.label} hint={field.hint} required={field.required}>
        <Textarea
          placeholder={field.placeholder}
          value={typeof raw === 'string' ? raw : ''}
          rows={3}
          onChange={(_, d) => onPatch(field.key, d.value || undefined)}
        />
      </Field>
    );
  }

  return (
    <Field label={field.label} hint={field.hint} required={field.required}>
      <Input
        placeholder={field.placeholder}
        value={typeof raw === 'string' ? raw : ''}
        onChange={(_, d) => onPatch(field.key, d.value || undefined)}
      />
    </Field>
  );
}

// =============================================================================
// Styles
// =============================================================================

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', flex: 1, minHeight: '520px',
    gap: tokens.spacingVerticalS, width: '100%',
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', padding: tokens.spacingVerticalXS,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  toolbarSpacer: { flex: 1 },
  // The body fills the ResizableCanvasRegion (which now owns the definite
  // height); `height:100%/minHeight:0` lets it shrink with the region instead
  // of forcing its old fixed `flex:1` height.
  body: { display: 'flex', height: '100%', gap: tokens.spacingHorizontalM, minHeight: 0, width: '100%' },
  canvasShell: {
    // `minHeight:0` (was 420) — the region supplies the definite height React
    // Flow needs, so the canvas stretches to the region and never overflows it
    // when dragged down to the region's min.
    position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  panel: {
    flexShrink: 0, width: '340px', overflow: 'auto',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  panelHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  panelEmpty: {
    flexShrink: 0, width: '340px',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    alignItems: 'center', justifyContent: 'center', textAlign: 'center',
    padding: tokens.spacingHorizontalXXL,
    background: tokens.colorNeutralBackground1,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
  },
  previewHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  dfExpr: { fontFamily: 'Consolas, monospace' },
  emptyCanvas: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', pointerEvents: 'none',
    color: tokens.colorNeutralForeground3, zIndex: 1,
    padding: tokens.spacingHorizontalXL, textAlign: 'center',
  },
  debugBanner: { marginBottom: tokens.spacingVerticalXS },
});

// =============================================================================
// Add-transformation menu (grouped by category) — Studio's "＋ on a stream".
// =============================================================================

interface AddMenuState {
  open: boolean;
  /** When adding from a stream's output: the upstream node + its output slot. */
  fromName?: string;
  fromSlot?: number;
  /** Screen anchor rect for the popover. */
  anchor?: DOMRect;
}

// =============================================================================
// Public component
// =============================================================================

export interface MappingDataFlowDesignerProps {
  /** Data flow resource name (the dataflow id). */
  name: string;
  /** Existing DataFlow properties to hydrate from (omit for a new flow). */
  initial?: AdfDataFlow['properties'];
  /** Datasets for the source/sink picker (real GET /api/adf/datasets). */
  datasets?: AdfDataset[];
  /** Honest gate message when the factory/datasets aren't configured. */
  datasetGate?: string | null;
  /**
   * Whether a live Spark data-flow debug cluster is currently available. When
   * false (the default), the debug toggle + per-transform Data preview render
   * the honest "start a debug session" gate — never faked rows.
   */
  debugClusterAvailable?: boolean;
  /** Fired to request a debug session start (toolbar / preview gate). */
  onStartDebugSession?: () => void | Promise<void>;
  /**
   * Persist the serialised DataFlow. Defaults to PUT /api/adf/dataflows/{name}
   * (real ARM REST). Pass a custom saver to target the Synapse dev plane
   * (POST/PUT /api/synapse/dataflows). Should resolve on success / reject on
   * failure.
   */
  onSave?: (props: AdfDataFlow['properties']) => Promise<void>;
  /** Notify the host of graph changes (e.g. to mark the editor dirty). */
  onChange?: (graph: MappingDataFlowGraph) => void;
  readOnly?: boolean;
}

/** Next free stream name for a transform type (source1, derive2, join1, …). */
function nextName(type: string, existing: Set<string>): string {
  const def = transformByType(type);
  const base = (def?.type || type).replace(/[^A-Za-z0-9]/g, '');
  let n = 1;
  while (existing.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

function DesignerInner({
  name, initial, datasets = [], datasetGate, debugClusterAvailable = false,
  onStartDebugSession, onSave, onChange, readOnly = false,
}: MappingDataFlowDesignerProps) {
  const s = useStyles();
  const rf = useReactFlow();
  const toasterId = useId('df-toaster');
  const { dispatchToast } = useToastController(toasterId);

  // The authored graph (the single source of truth this editor owns).
  const [graph, setGraph] = useState<MappingDataFlowGraph>(() =>
    initial ? parseDataFlow(initial) : { transforms: [], streams: [] });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [debugActive, setDebugActive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addMenu, setAddMenu] = useState<AddMenuState>({ open: false });

  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  for (const t of graph.transforms) {
    if (t.position && !positionsRef.current.has(t.name)) positionsRef.current.set(t.name, t.position);
  }

  // Bubble graph changes up.
  useEffect(() => { onChange?.(graph); }, [graph, onChange]);

  // --- React Flow node/edge derivation ---------------------------------------
  const openAddFromOutput = useCallback((fromName: string, slot: number, anchor: DOMRect) => {
    setAddMenu({ open: true, fromName, fromSlot: slot, anchor });
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

  const syncNodes = useCallback(() => {
    setNodes(graph.transforms.map((t, i) => {
      const pos = positionsRef.current.get(t.name) || t.position || { x: 40 + i * 60, y: 40 + i * 40 };
      positionsRef.current.set(t.name, pos);
      return {
        id: t.name,
        type: 'transform',
        position: pos,
        data: { instance: t, onAddFromOutput: readOnly ? undefined : openAddFromOutput } as TransformNodeData,
        selected: selectedName === t.name,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    }));
  }, [graph.transforms, selectedName, setNodes, openAddFromOutput, readOnly]);

  useEffect(() => { syncNodes(); }, [syncNodes]);

  // The `stream` edge type (DataStreamEdge → CanvasEdge) owns its arrow marker
  // and colours it to match the `--loom-accent-blue` stroke (token-only, no raw
  // hex), so the edge object carries no `markerEnd`.
  const edges = useMemo<Edge[]>(() => graph.streams.map((st) => ({
    id: `${st.from}:${st.fromSlot ?? 0}->${st.to}:${st.toSlot ?? 0}`,
    source: st.from,
    target: st.to,
    sourceHandle: `out-${st.fromSlot ?? 0}`,
    targetHandle: `in-${st.toSlot ?? 0}`,
    type: 'stream',
  })), [graph.streams]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    onNodesChange(changes);
    for (const c of changes) {
      if (c.type === 'position' && c.position) positionsRef.current.set(c.id, c.position);
    }
  }, [onNodesChange]);

  // --- graph mutations --------------------------------------------------------
  const addTransform = useCallback((type: string, opts?: { fromName?: string; fromSlot?: number }) => {
    if (readOnly) return;
    setGraph((g) => {
      const names = new Set(g.transforms.map((t) => t.name));
      const newName = nextName(type, names);
      const def = transformByType(type);
      // Place to the right of the source node (or center-ish for a bare source).
      const fromPos = opts?.fromName ? positionsRef.current.get(opts.fromName) : undefined;
      const pos = fromPos
        ? { x: fromPos.x + NODE_W + 80, y: fromPos.y + (opts?.fromSlot ?? 0) * (NODE_H + 30) }
        : { x: 60, y: 60 + g.transforms.length * 30 };
      const inst: DfTransformInstance = {
        name: newName,
        type,
        settings: { outputStreamName: newName },
        position: pos,
      };
      // Multi-input transforms pre-fill the right-stream setting from the source.
      if (opts?.fromName && def) {
        if (def.type === 'join' || def.type === 'exists') inst.settings.rightStream = '';
        if (def.type === 'lookup') inst.settings.lookupStream = '';
      }
      positionsRef.current.set(newName, pos);
      const streams = opts?.fromName
        ? [...g.streams, { from: opts.fromName, to: newName, toSlot: 0, fromSlot: opts.fromSlot ?? 0 }]
        : g.streams;
      return { transforms: [...g.transforms, inst], streams };
    });
    setSelectedName((cur) => cur); // keep selection; the new node is wired but not auto-selected
  }, [readOnly]);

  const handleAddFromMenu = useCallback((type: string) => {
    addTransform(type, { fromName: addMenu.fromName, fromSlot: addMenu.fromSlot });
    setAddMenu({ open: false });
  }, [addTransform, addMenu.fromName, addMenu.fromSlot]);

  const patchSetting = useCallback((nodeName: string, key: string, value: unknown) => {
    setGraph((g) => ({
      ...g,
      transforms: g.transforms.map((t) =>
        t.name === nodeName ? { ...t, settings: { ...t.settings, [key]: value } } : t),
    }));
  }, []);

  const renameTransform = useCallback((oldName: string, next: string) => {
    const clean = next.replace(/[^A-Za-z0-9_]/g, '');
    if (!clean) return;
    setGraph((g) => {
      if (g.transforms.some((t) => t.name === clean && t.name !== oldName)) return g; // name clash
      const transforms = g.transforms.map((t) =>
        t.name === oldName
          ? { ...t, name: clean, settings: { ...t.settings, outputStreamName: clean } }
          : t);
      const streams = g.streams.map((st) => ({
        ...st,
        from: st.from === oldName ? clean : st.from,
        to: st.to === oldName ? clean : st.to,
      }));
      const pos = positionsRef.current.get(oldName);
      if (pos) { positionsRef.current.set(clean, pos); positionsRef.current.delete(oldName); }
      return { transforms, streams };
    });
    setSelectedName((cur) => (cur === oldName ? clean : cur));
  }, []);

  const setDataset = useCallback((nodeName: string, dsName: string, _ds: AdfDataset | undefined) => {
    setGraph((g) => ({
      ...g,
      transforms: g.transforms.map((t) => (t.name === nodeName ? { ...t, dataset: dsName || undefined } : t)),
    }));
  }, []);

  const deleteTransform = useCallback((nodeName: string) => {
    setGraph((g) => ({
      transforms: g.transforms.filter((t) => t.name !== nodeName),
      streams: g.streams.filter((st) => st.from !== nodeName && st.to !== nodeName),
    }));
    positionsRef.current.delete(nodeName);
    setSelectedName((cur) => (cur === nodeName ? null : cur));
  }, []);

  const handleConnect = useCallback((conn: Connection) => {
    if (readOnly) return;
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const toSlot = Number((conn.targetHandle || 'in-0').replace('in-', '')) || 0;
    const fromSlot = Number((conn.sourceHandle || 'out-0').replace('out-', '')) || 0;
    setGraph((g) => {
      // De-dupe an identical stream.
      if (g.streams.some((st) => st.from === conn.source && st.to === conn.target && (st.toSlot ?? 0) === toSlot)) return g;
      return { ...g, streams: [...g.streams, { from: conn.source!, to: conn.target!, toSlot, fromSlot }] };
    });
  }, [readOnly]);

  // --- debug + save -----------------------------------------------------------
  const startDebug = useCallback(async () => {
    // HONEST gate: only flips active when a real debug cluster is available.
    if (!debugClusterAvailable) {
      dispatchToast(
        <Toast><ToastTitle>No data-flow debug cluster</ToastTitle></Toast>,
        { intent: 'warning' },
      );
      // Still notify the host so it can provision / surface the requirement.
      await onStartDebugSession?.();
      return;
    }
    setDebugActive(true);
    await onStartDebugSession?.();
  }, [debugClusterAvailable, onStartDebugSession, dispatchToast]);

  const doSave = useCallback(async () => {
    if (readOnly) return;
    setSaving(true);
    const props = serializeDataFlow(graph);
    try {
      if (onSave) {
        await onSave(props);
      } else {
        const r = await fetch(`/api/adf/dataflows/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ properties: props }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body?.ok === false) throw new Error(body?.error || `Save failed (${r.status})`);
      }
      dispatchToast(
        <Toast><ToastTitle>Data flow saved</ToastTitle></Toast>,
        { intent: 'success' },
      );
    } catch (e: unknown) {
      dispatchToast(
        <Toast><ToastTitle>Save failed: {e instanceof Error ? e.message : String(e)}</ToastTitle></Toast>,
        { intent: 'error' },
      );
    } finally {
      setSaving(false);
    }
  }, [graph, name, onSave, readOnly, dispatchToast]);

  const fitToScreen = useCallback(() => rf.fitView({ padding: 0.2, duration: 200 }), [rf]);

  const selected = graph.transforms.find((t) => t.name === selectedName);

  // The add-menu trigger anchors to a hidden 0×0 element placed at the ＋ click
  // point so the Fluent Menu popover opens beside the stream's output ＋.
  const anchorStyle: React.CSSProperties = addMenu.anchor
    ? { position: 'fixed', left: addMenu.anchor.left, top: addMenu.anchor.top, width: 0, height: 0 }
    : { display: 'none' };

  return (
    <div className={s.root} data-component="mapping-dataflow-designer">
      <Toaster toasterId={toasterId} />

      {/* Top toolbar — Add transform · Debug toggle (honest gate) · Save. */}
      <div className={s.toolbar} role="toolbar" aria-label="Data flow toolbar">
        <Menu positioning="below-start">
          <MenuTrigger disableButtonEnhancement>
            <MenuButton size="small" appearance="primary" icon={<Add20Regular />} disabled={readOnly}>
              Add transformation
            </MenuButton>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {TRANSFORM_CATEGORIES.map((cat) => (
                <MenuGroup key={cat}>
                  <MenuGroupHeader>{cat}</MenuGroupHeader>
                  {transformsByCategory(cat).map((def) => (
                    <MenuItem
                      key={def.type}
                      icon={<span style={{ color: getTransformVisual(def.type).accent, display: 'inline-flex' }}>{transformIcon(def)}</span>}
                      onClick={() => addTransform(def.type)}
                    >
                      {def.displayName}
                    </MenuItem>
                  ))}
                </MenuGroup>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>

        <Divider vertical style={{ height: 24 }} />

        <Tooltip
          content={debugClusterAvailable
            ? (debugActive ? 'Stop the data-flow debug session' : 'Start a data-flow debug session')
            : 'A live Spark data-flow debug cluster (Azure IR with data-flow compute) is required'}
          relationship="label"
        >
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <Bug20Regular style={{ color: debugActive ? 'var(--loom-accent-emerald)' : tokens.colorNeutralForeground3 }} />
            <Switch
              label="Data flow debug"
              checked={debugActive}
              disabled={readOnly}
              onChange={(_, d) => {
                if (d.checked) void startDebug();
                else setDebugActive(false);
              }}
            />
          </div>
        </Tooltip>

        <Tooltip content="Auto-layout & fit to screen" relationship="label">
          <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} onClick={fitToScreen} aria-label="Fit to screen" />
        </Tooltip>

        <div className={s.toolbarSpacer} />

        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {graph.transforms.length} transformation{graph.transforms.length === 1 ? '' : 's'} ·{' '}
          {graph.streams.length} stream{graph.streams.length === 1 ? '' : 's'}
        </Caption1>

        <Button
          size="small"
          appearance="primary"
          icon={saving ? <Spinner size="tiny" /> : <Save20Regular />}
          disabled={saving || readOnly}
          onClick={doSave}
        >
          Save
        </Button>
      </div>

      {/* Debug-not-available banner (honest gate, always visible while toggling). */}
      {debugActive && !debugClusterAvailable && (
        <MessageBar intent="warning" className={s.debugBanner}>
          <MessageBarBody>
            <MessageBarTitle>No data-flow debug cluster</MessageBarTitle>
            A debug session needs an Azure Integration Runtime with data-flow
            (Spark) compute, or a Synapse Spark pool. Configure one
            (<code>LOOM_ADF_NAME</code> Azure IR data-flow properties, or a
            Synapse Spark pool) and the toggle will start a real session.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* The canvas + inspector live in a drag-resizable, height-bounded region
          (240px floor … 80vh ceiling) whose height persists per-surface. The
          region supplies the definite px height React Flow needs for fitView. */}
      <ResizableCanvasRegion
        storageKey="mapping-dataflow"
        defaultPx={520}
        minPx={360}
        ariaLabel="Resize mapping data flow canvas height"
      >
        <div className={s.body}>
          {/* Canvas */}
          <div
            className={s.canvasShell}
            data-canvas="mapping-dataflow"
            aria-label="Mapping data flow design canvas"
          >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={handleNodesChange}
            onConnect={handleConnect}
            onNodeClick={(_, n) => setSelectedName(n.id)}
            onPaneClick={() => { setSelectedName(null); setAddMenu({ open: false }); }}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{ type: 'stream' }}
            snapToGrid
            snapGrid={[16, 16]}
            minZoom={0.25}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={tokens.colorNeutralStroke2} />
            <Panel position="top-left">
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalXXS }}>
                <Tooltip content="Fit to screen" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Organization20Regular />} onClick={fitToScreen} aria-label="Fit to screen" />
                </Tooltip>
              </div>
            </Panel>
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => (n.selected ? tokens.colorBrandBackground : tokens.colorNeutralForeground3)}
              style={{ backgroundColor: tokens.colorNeutralBackground1 }}
            />
          </ReactFlow>

          {graph.transforms.length === 0 && (
            <div className={s.emptyCanvas}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, alignItems: 'center', pointerEvents: 'auto' }}>
                <Flowchart20Regular style={{ fontSize: tokens.fontSizeHero800, color: tokens.colorNeutralForeground3 }} />
                <Text>Start your data flow with a Source.</Text>
                <Button appearance="primary" icon={<DatabaseArrowDown20Regular />} disabled={readOnly} onClick={() => addTransform('source')}>
                  Add a source
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Right config panel (or empty hint). */}
        {selected ? (
          <ConfigPanel
            instance={selected}
            datasets={datasets}
            datasetGate={datasetGate}
            debugActive={debugActive && debugClusterAvailable}
            onStartDebug={() => void startDebug()}
            onPatch={(k, v) => patchSetting(selected.name, k, v)}
            onRename={(nx) => renameTransform(selected.name, nx)}
            onSetDataset={(dn, ds) => setDataset(selected.name, dn, ds)}
            onDelete={() => deleteTransform(selected.name)}
          />
        ) : (
          <div className={s.panelEmpty} data-config-panel="empty">
            <Beaker20Regular style={{ fontSize: tokens.fontSizeHero700 }} />
            <Title3 style={{ fontSize: tokens.fontSizeBase400 }}>No transformation selected</Title3>
            <Caption1>
              Select a node to configure it, or use <strong>Add transformation</strong>
              {' '}/ the <strong>＋</strong> on a stream to grow the graph.
            </Caption1>
          </div>
        )}
        </div>
      </ResizableCanvasRegion>

      {/* Hidden anchor + Menu for the per-stream "＋ add transformation". */}
      <div style={anchorStyle}>
        <Menu
          open={addMenu.open}
          onOpenChange={(_, d) => setAddMenu((m) => ({ ...m, open: d.open }))}
          positioning="after-top"
        >
          <MenuTrigger disableButtonEnhancement>
            <span aria-hidden="true" style={{ width: 0, height: 0 }} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {TRANSFORM_CATEGORIES
                // The ＋-on-a-stream menu excludes Source (sources have no input).
                .map((cat) => {
                  const defs = transformsByCategory(cat).filter((d) => d.type !== 'source');
                  if (!defs.length) return null;
                  return (
                    <MenuGroup key={cat}>
                      <MenuGroupHeader>{cat}</MenuGroupHeader>
                      {defs.map((def) => (
                        <MenuItem
                          key={def.type}
                          icon={<span style={{ color: getTransformVisual(def.type).accent, display: 'inline-flex' }}>{transformIcon(def)}</span>}
                          onClick={() => handleAddFromMenu(def.type)}
                        >
                          {def.displayName}
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  );
                })}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
    </div>
  );
}

/**
 * MappingDataFlowDesigner — wraps the inner designer in a ReactFlowProvider so
 * `useReactFlow()` works (matching the pipeline canvas pattern).
 */
export const MappingDataFlowDesigner = forwardRef<unknown, MappingDataFlowDesignerProps>(
  function MappingDataFlowDesigner(props, _ref) {
    return (
      <ReactFlowProvider>
        <DesignerInner {...props} />
      </ReactFlowProvider>
    );
  },
);

export default MappingDataFlowDesigner;
