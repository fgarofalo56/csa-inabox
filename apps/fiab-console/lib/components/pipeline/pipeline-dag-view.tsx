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
 *
 * Web-5.0 chrome: the read-only DAG REUSES the shared canvas-node-kit so every
 * node carries the SAME per-type glyph + per-category accent the editable
 * canvas nodes use (`getActivityVisual`), the legend / palette chips draw their
 * accents from the same tokens, and edge colours come from the kit's status
 * palette (`StatusChip` tokens) rather than raw hex. Every colour/space/radius/
 * shadow is a Fluent v9 `tokens.*` value or a `--loom-accent-*` var combined via
 * the kit's token-only `accentTint` / `accentGradient` helpers — no raw px /
 * hex / hardcoded shadow. The empty-DAG pane uses the shared `EmptyState`.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { Flowchart24Regular } from '@fluentui/react-icons';
import {
  getActivityVisual, accentTint, accentGradient,
} from '@/lib/components/canvas/canvas-node-kit';
import { EmptyState } from '@/lib/components/empty-state';

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    display: 'block',
    width: '100%',
    minHeight: '240px',
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalL,
    boxShadow: tokens.shadow4,
  },
  legend: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalS,
    flexWrap: 'wrap',
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  legendSwatch: {
    width: '14px',
    height: '4px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
  grid: {
    position: 'relative',
    display: 'flex',
    gap: tokens.spacingHorizontalXXL,
    alignItems: 'flex-start',
    zIndex: 1,
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: '180px',
  },
  // Node card — rail + gradient header + body, matching the editable canvas node.
  activity: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    minHeight: '56px',
    display: 'flex',
    flexDirection: 'column',
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
  rail: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '6px',
    borderRadius: tokens.borderRadiusSmall,
    zIndex: 1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginLeft: '6px',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
  },
  iconChip: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityName: {
    flex: 1,
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    marginLeft: '6px',
    paddingTop: 0,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalS,
  },
  description: {
    color: tokens.colorNeutralForeground3,
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
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalSNudge,
    marginBottom: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  paletteLabel: {
    alignSelf: 'center',
    marginRight: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
  },
  footer: {
    marginTop: tokens.spacingVerticalS,
    display: 'block',
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

/**
 * Dependency-condition → edge colour. Mapped to the SAME theme-aware status
 * tokens the kit's StatusChip uses (succeeded/failed/brand/skipped) so the DAG
 * edges read identically to the rest of the canvas. The neutral fallback is the
 * tokenized neutral stroke. No raw hex.
 */
const COND_COLORS: Record<string, string> = {
  Succeeded: tokens.colorPaletteGreenForeground1,
  Failed: tokens.colorPaletteRedForeground1,
  Completed: tokens.colorBrandForeground1,
  Skipped: tokens.colorNeutralForeground3,
};
const COND_FALLBACK = tokens.colorNeutralStroke1;
function condColor(c?: string): string {
  if (!c) return COND_FALLBACK;
  return COND_COLORS[c] || COND_FALLBACK;
}

/** Legend rows — label + the tokenized edge colour drawn as a swatch. */
const LEGEND: Array<{ label: string; color: string }> = [
  { label: 'Succeeded', color: COND_COLORS.Succeeded },
  { label: 'Failed', color: COND_COLORS.Failed },
  { label: 'Completed', color: COND_COLORS.Completed },
  { label: 'Skipped', color: COND_COLORS.Skipped },
];

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
        // Reuse the SAME accent the canvas node uses for this activity type.
        const { accent } = getActivityVisual(p.type);
        return (
          <Button
            key={p.label}
            size="small"
            appearance="outline"
            data-palette-type={p.type}
            style={{ borderLeft: `4px solid ${accent}` }}
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
              color: condColor(),
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
        <EmptyState
          icon={<Flowchart24Regular />}
          title="No activities yet"
          body={emptyHint || (onActivityAdd
            ? 'Click a palette button above to add the first activity — the DAG will render it and draw dependency edges automatically.'
            : 'Add an activity via the JSON editor — the DAG view will render it and draw dependency edges automatically.')}
        />
      </div>
    );
  }

  return (
    <div className={s.shell} ref={shellRef}>
      {palette}
      <div className={s.legend}>
        <Caption1>Edge color:</Caption1>
        {LEGEND.map((l) => (
          <span key={l.label} className={s.legendItem}>
            <span className={s.legendSwatch} style={{ background: l.color }} aria-hidden="true" />
            {l.label}
          </span>
        ))}
      </div>
      <svg
        className={s.edgeOverlay}
        width={svgSize.w || '100%'}
        height={svgSize.h || '100%'}
        viewBox={svgSize.w && svgSize.h ? `0 0 ${svgSize.w} ${svgSize.h}` : undefined}
        aria-hidden="true"
      >
        <defs>
          {LEGEND.map((l) => (
            <marker
              key={l.label}
              id={`arrow-${l.label}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={l.color} />
            </marker>
          ))}
          <marker
            id="arrow-default"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COND_FALLBACK} />
          </marker>
        </defs>
        {paths.map((p) => {
          // Match color back to its marker id so arrowheads stay color-consistent.
          const markerKey = (LEGEND.find((l) => l.color === p.color)?.label) || 'default';
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
              // Reuse the SAME glyph + accent the editable canvas node uses.
              const { icon, accent } = getActivityVisual(a.type);
              return (
                <div
                  key={a.name}
                  id={`activity-node-${a.name}`}
                  className={s.activity}
                  data-activity-name={a.name}
                >
                  {/* Accent rail anchoring the category colour. */}
                  <span className={s.rail} style={{ background: accent }} aria-hidden="true" />
                  {/* Header — icon chip + name, with the category gradient wash. */}
                  <div className={s.header} style={{ background: accentGradient(accent) }}>
                    <span
                      className={s.iconChip}
                      style={{ background: accentTint(accent, 14), color: accent }}
                      aria-hidden="true"
                    >
                      {icon}
                    </span>
                    <span className={s.activityName} title={a.name}>{a.name}</span>
                  </div>
                  {/* Body — type badge + optional description. */}
                  <div className={s.body}>
                    <div>
                      <Badge
                        appearance="tint"
                        size="small"
                        style={{
                          backgroundColor: accentTint(accent, 14),
                          color: accent,
                          borderColor: accentTint(accent, 28),
                        }}
                      >
                        {a.type || 'Unknown'}
                      </Badge>
                    </div>
                    {a.description && <Caption1 className={s.description}>{a.description}</Caption1>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {edges.length > 0 && (
        <Caption1 className={s.footer}>
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

/**
 * Re-serialize a spec JSON string with a replacement activities[] array,
 * preserving every other property of the pipeline definition. If the current
 * spec text is not valid JSON we synthesize a minimal valid pipeline so the
 * visual designer can still drive Save (the user can then refine in the JSON
 * tab). Returns pretty-printed JSON.
 */
export function writeActivitiesToSpec(specJson: string, activities: PipelineActivity[]): string {
  let parsed: any;
  try { parsed = JSON.parse(specJson); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') parsed = { properties: {} };
  if (!parsed.properties || typeof parsed.properties !== 'object') parsed.properties = {};
  parsed.properties.activities = activities;
  return JSON.stringify(parsed, null, 2);
}
