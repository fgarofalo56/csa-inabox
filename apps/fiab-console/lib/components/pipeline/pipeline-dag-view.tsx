'use client';

/**
 * PipelineDagView — DAG renderer for ADF / Synapse / Fabric
 * pipeline activity arrays. All three share the same JSON shape:
 *   { properties: { activities: [{ name, type, dependsOn: [{ activity, dependencyConditions: [] }] }] } }
 *
 * Layout: simple topological ranking — sources at column 0, dependents
 * one column right of their deepest upstream. Activities at the same
 * rank stack vertically. SVG overlay draws success/failure/completion/
 * skip dependency arrows.
 *
 * v3.27 Phase 1: read-only canvas.
 * v3.28 Phase 2: optional click-to-add activity palette. When the parent
 *   passes `onActivityAdd`, a horizontal row of activity-type buttons
 *   renders above the DAG. Each click templates a fresh activity of that
 *   type (with auto-incremented name) and hands it to the parent for
 *   insertion into its JSON state. Drag-to-reorder + properties pane are
 *   queued for Phase 3.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Caption1, MessageBar, MessageBarBody, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    display: 'block',
    width: '100%',
    minHeight: 240,
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    padding: 16,
  },
  legend: {
    display: 'flex',
    gap: 12,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  grid: {
    position: 'relative',
    display: 'flex',
    gap: 32,
    alignItems: 'flex-start',
    zIndex: 1,
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minWidth: 180,
  },
  activity: {
    padding: '8px 10px',
    borderRadius: 6,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
    fontSize: 12,
    minHeight: 56,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  activityName: {
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    fontSize: 13,
  },
  edgeOverlay: {
    position: 'absolute',
    top: 0, left: 0,
    pointerEvents: 'none',
    zIndex: 0,
    overflow: 'visible',
  },
  palette: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 12,
    paddingBottom: 8,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  paletteLabel: {
    alignSelf: 'center',
    marginRight: 4,
    color: tokens.colorNeutralForeground3,
  },
});

export interface PipelineActivityRef { activity: string; dependencyConditions?: string[]; }
export interface PipelineActivity {
  name: string;
  type?: string;
  dependsOn?: PipelineActivityRef[];
  description?: string;
  typeProperties?: Record<string, unknown>;
  // Phase-2 templates may carry compound shapes (ForEach/IfCondition children).
  // Use index signature so callers can attach future fields without us
  // having to keep the type in sync with every Azure activity flavor.
  [key: string]: unknown;
}

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  Copy: { bg: '#0078d4', fg: '#fff' },
  ExecuteDataFlow: { bg: '#7719aa', fg: '#fff' },
  DatabricksNotebook: { bg: '#ff3621', fg: '#fff' },
  SynapseNotebook: { bg: '#0a4f7a', fg: '#fff' },
  Notebook: { bg: '#0078d4', fg: '#fff' },
  SqlServerStoredProcedure: { bg: '#3aaaaa', fg: '#fff' },
  AzureFunctionActivity: { bg: '#0062ad', fg: '#fff' },
  WebActivity: { bg: '#107c10', fg: '#fff' },
  Lookup: { bg: '#5c2d91', fg: '#fff' },
  ForEach: { bg: '#dca900', fg: '#000' },
  IfCondition: { bg: '#bd7800', fg: '#fff' },
  Switch: { bg: '#bd7800', fg: '#fff' },
  Until: { bg: '#bd7800', fg: '#fff' },
  Wait: { bg: '#666', fg: '#fff' },
  SetVariable: { bg: '#444', fg: '#fff' },
  AppendVariable: { bg: '#444', fg: '#fff' },
  ExecutePipeline: { bg: '#005a9e', fg: '#fff' },
};

function typeColor(type?: string): { bg: string; fg: string } {
  if (!type) return { bg: tokens.colorNeutralBackground1, fg: tokens.colorNeutralForeground1 };
  return TYPE_COLORS[type] || { bg: tokens.colorBrandBackground2, fg: tokens.colorNeutralForeground1 };
}

const COND_COLORS: Record<string, string> = {
  Succeeded: '#107c10',
  Failed: '#d13438',
  Completed: '#0078d4',
  Skipped: '#888',
};
function condColor(c?: string): string {
  if (!c) return '#888';
  return COND_COLORS[c] || '#888';
}

/**
 * Topological ranking: source nodes go in column 0, each downstream node
 * goes 1 + max(rank of dependencies). Detects cycles defensively (caps
 * iterations at activities.length).
 */
function computeRanks(activities: PipelineActivity[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const a of activities) ranks.set(a.name, 0);
  const max = activities.length;
  for (let pass = 0; pass < max; pass++) {
    let changed = false;
    for (const a of activities) {
      const ds = a.dependsOn || [];
      let r = 0;
      for (const dep of ds) {
        const dr = ranks.get(dep.activity);
        if (dr !== undefined && dr + 1 > r) r = dr + 1;
      }
      if (r !== ranks.get(a.name)) {
        ranks.set(a.name, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ranks;
}

// ============================================================
// Phase-2 palette
// ============================================================
// Each entry maps a palette button -> (label, activity-type key, name-prefix,
// factory that produces a fresh template). The label is what users see;
// the type key is what gets stamped into the JSON; the prefix is what the
// auto-incrementer scans for to suggest the next free <n>.
interface PaletteEntry {
  label: string;
  type: string;
  namePrefix: string;
  build: (name: string) => PipelineActivity;
}

const PALETTE: PaletteEntry[] = [
  {
    label: 'Copy', type: 'Copy', namePrefix: 'Copy',
    build: (name) => ({ name, type: 'Copy', typeProperties: { source: {}, sink: {} }, dependsOn: [] }),
  },
  {
    label: 'Notebook', type: 'Notebook', namePrefix: 'Notebook',
    build: (name) => ({ name, type: 'Notebook', typeProperties: { notebookId: '' }, dependsOn: [] }),
  },
  {
    label: 'Dataflow', type: 'ExecuteDataFlow', namePrefix: 'Dataflow',
    build: (name) => ({ name, type: 'ExecuteDataFlow', typeProperties: {}, dependsOn: [] }),
  },
  {
    label: 'Lookup', type: 'Lookup', namePrefix: 'Lookup',
    build: (name) => ({ name, type: 'Lookup', typeProperties: {}, dependsOn: [] }),
  },
  {
    label: 'ForEach', type: 'ForEach', namePrefix: 'ForEach',
    build: (name) => ({
      name, type: 'ForEach',
      typeProperties: {
        items: { value: "@variables('items')", type: 'Expression' },
        activities: [],
      },
      dependsOn: [],
    }),
  },
  {
    label: 'IfCondition', type: 'IfCondition', namePrefix: 'If',
    build: (name) => ({
      name, type: 'IfCondition',
      typeProperties: {
        expression: { value: '@equals(1,1)', type: 'Expression' },
        ifTrueActivities: [],
        ifFalseActivities: [],
      },
      dependsOn: [],
    }),
  },
  {
    label: 'Wait', type: 'Wait', namePrefix: 'Wait',
    build: (name) => ({ name, type: 'Wait', typeProperties: { waitTimeInSeconds: 5 }, dependsOn: [] }),
  },
  {
    label: 'ExecutePipeline', type: 'ExecutePipeline', namePrefix: 'ExecPipeline',
    build: (name) => ({
      name, type: 'ExecutePipeline',
      typeProperties: { pipeline: { referenceName: '', type: 'PipelineReference' } },
      dependsOn: [],
    }),
  },
];

/**
 * Scan existing activities for names matching `<prefix><n>` and return the
 * next free <n>. Example: with prefix 'Copy' and activities ['Copy1','Copy2'],
 * returns 3. Activities whose name doesn't match the pattern are ignored.
 */
function nextNameSuffix(activities: PipelineActivity[], prefix: string): number {
  // Palette prefixes are simple ASCII identifiers (Copy, Notebook, If, etc.)
  // so we don't need regex-escape; just substring + integer parse.
  let max = 0;
  for (const a of activities) {
    const name = a.name || '';
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

export interface PipelineDagViewProps {
  activities: PipelineActivity[];
  emptyHint?: string;
  /**
   * Phase-2 hook: when provided, a click-to-add palette renders above the
   * canvas. The handler receives a freshly-templated activity (with an
   * auto-incremented name) and is expected to append it to its own JSON
   * state. When omitted, the view stays read-only (Phase-1 behavior).
   */
  onActivityAdd?: (activity: PipelineActivity) => void;
}

interface EdgePath { d: string; color: string; key: string; }

export function PipelineDagView({ activities, emptyHint, onActivityAdd }: PipelineDagViewProps) {
  const s = useStyles();
  const shellRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [svgSize, setSvgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const palette = onActivityAdd ? (
    <div className={s.palette} role="toolbar" aria-label="Add activity">
      <Caption1 className={s.paletteLabel}>Add activity:</Caption1>
      {PALETTE.map((p) => {
        const c = typeColor(p.type);
        return (
          <Button
            key={p.label}
            size="small"
            appearance="outline"
            data-palette-type={p.type}
            style={{ borderLeft: `4px solid ${c.bg}` }}
            onClick={() => {
              const n = nextNameSuffix(activities, p.namePrefix);
              onActivityAdd(p.build(`${p.namePrefix}${n}`));
            }}
          >
            {p.label}
          </Button>
        );
      })}
    </div>
  ) : null;

  // Measure node positions after layout to compute SVG paths between them.
  // Runs whenever the activities array (or edges) change.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const computePaths = () => {
      const shellRect = shell.getBoundingClientRect();
      const next: EdgePath[] = [];
      let maxW = 0, maxH = 0;
      for (const a of activities) {
        for (const dep of a.dependsOn || []) {
          const fromEl = shell.querySelector<HTMLElement>(`#activity-node-${CSS.escape(dep.activity)}`);
          const toEl = shell.querySelector<HTMLElement>(`#activity-node-${CSS.escape(a.name)}`);
          if (!fromEl || !toEl) continue;
          const fr = fromEl.getBoundingClientRect();
          const tr = toEl.getBoundingClientRect();
          const sx = fr.right - shellRect.left + shell.scrollLeft;
          const sy = fr.top + fr.height / 2 - shellRect.top + shell.scrollTop;
          const ex = tr.left - shellRect.left + shell.scrollLeft;
          const ey = tr.top + tr.height / 2 - shellRect.top + shell.scrollTop;
          const dx = Math.max(40, (ex - sx) / 2);
          const conds = dep.dependencyConditions || [];
          if (conds.length === 0) {
            next.push({
              d: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`,
              color: '#888',
              key: `${dep.activity}->${a.name}`,
            });
          } else {
            // Slight vertical offset per condition so multiple edges between
            // the same pair don't overlap.
            conds.forEach((c, i) => {
              const off = (i - (conds.length - 1) / 2) * 6;
              next.push({
                d: `M ${sx} ${sy + off} C ${sx + dx} ${sy + off}, ${ex - dx} ${ey + off}, ${ex} ${ey + off}`,
                color: condColor(c),
                key: `${dep.activity}->${a.name}:${c}`,
              });
            });
          }
          maxW = Math.max(maxW, ex + 8);
          maxH = Math.max(maxH, ey + 8, sy + 8);
        }
      }
      setPaths(next);
      setSvgSize({
        w: Math.max(shell.scrollWidth, maxW),
        h: Math.max(shell.scrollHeight, maxH),
      });
    };
    // After the columns render, measure on next frame so layout is stable.
    const raf = requestAnimationFrame(computePaths);
    // Recompute on resize too — pipelines can be wide.
    const ro = new ResizeObserver(computePaths);
    ro.observe(shell);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [activities]);

  const { columns, edges } = useMemo(() => {
    const ranks = computeRanks(activities);
    const cols: Map<number, PipelineActivity[]> = new Map();
    for (const a of activities) {
      const r = ranks.get(a.name) ?? 0;
      if (!cols.has(r)) cols.set(r, []);
      cols.get(r)!.push(a);
    }
    const ordered = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    const e: Array<{ from: string; to: string; cond?: string }> = [];
    for (const a of activities) {
      for (const dep of a.dependsOn || []) {
        const conds = dep.dependencyConditions || [];
        if (conds.length === 0) e.push({ from: dep.activity, to: a.name });
        else for (const c of conds) e.push({ from: dep.activity, to: a.name, cond: c });
      }
    }
    return { columns: ordered, edges: e };
  }, [activities]);

  if (activities.length === 0) {
    // Even with no activities, surface the palette so users can stamp the
    // first one with a click instead of hand-editing JSON.
    return (
      <div className={s.shell}>
        {palette}
        <MessageBar intent="info">
          <MessageBarBody>
            {emptyHint || (onActivityAdd
              ? 'No activities yet. Click a palette button above to add one.'
              : 'No activities yet. Add one via the JSON editor — the DAG view will render automatically.')}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.shell} ref={shellRef}>
      {palette}
      <div className={s.legend}>
        <Caption1>Edge color:</Caption1>
        <Badge appearance="filled" color="success" size="small">Succeeded</Badge>
        <Badge appearance="filled" color="danger" size="small">Failed</Badge>
        <Badge appearance="filled" color="brand" size="small">Completed</Badge>
        <Badge appearance="filled" color="subtle" size="small">Skipped</Badge>
      </div>
      <svg
        className={s.edgeOverlay}
        width={svgSize.w || '100%'}
        height={svgSize.h || '100%'}
        viewBox={svgSize.w && svgSize.h ? `0 0 ${svgSize.w} ${svgSize.h}` : undefined}
        aria-hidden="true"
      >
        <defs>
          {Object.entries(COND_COLORS).concat([['default', '#888']]).map(([k, c]) => (
            <marker
              key={k}
              id={`arrow-${k}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {paths.map((p) => {
          // Match color back to its marker id so arrowheads stay color-consistent.
          const markerKey = (Object.entries(COND_COLORS).find(([, v]) => v === p.color)?.[0]) || 'default';
          return (
            <path
              key={p.key}
              d={p.d}
              stroke={p.color}
              strokeWidth={1.5}
              fill="none"
              markerEnd={`url(#arrow-${markerKey})`}
            />
          );
        })}
      </svg>
      <div className={s.grid}>
        {columns.map((col, ci) => (
          <div key={ci} className={s.column}>
            {col.map((a) => {
              const c = typeColor(a.type);
              return (
                <div
                  key={a.name}
                  id={`activity-node-${a.name}`}
                  className={s.activity}
                  data-activity-name={a.name}
                  style={{ borderLeft: `4px solid ${c.bg}` }}
                >
                  <div className={s.activityName}>{a.name}</div>
                  <div>
                    <Badge appearance="filled" size="small" style={{ backgroundColor: c.bg, color: c.fg }}>
                      {a.type || 'Unknown'}
                    </Badge>
                  </div>
                  {a.description && <Caption1>{a.description}</Caption1>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {edges.length > 0 && (
        <Caption1 style={{ marginTop: 8, display: 'block', color: tokens.colorNeutralForeground3 }}>
          {edges.length} dependency edge{edges.length === 1 ? '' : 's'} drawn from <code>dependsOn[]</code>.
        </Caption1>
      )}
    </div>
  );
}

/** Helper: extract the activities array from any of the 3 pipeline JSON shapes. */
export function extractActivities(specJson: string): PipelineActivity[] {
  try {
    const parsed = JSON.parse(specJson);
    const a = parsed?.properties?.activities;
    return Array.isArray(a) ? a as PipelineActivity[] : [];
  } catch { return []; }
}
