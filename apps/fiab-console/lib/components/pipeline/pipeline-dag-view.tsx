'use client';

/**
 * PipelineDagView — read-only DAG renderer for ADF / Synapse / Fabric
 * pipeline activity arrays. All three share the same JSON shape:
 *   { properties: { activities: [{ name, type, dependsOn: [{ activity, dependencyConditions: [] }] }] } }
 *
 * Layout: simple topological ranking — sources at column 0, dependents
 * one column right of their deepest upstream. Activities at the same
 * rank stack vertically. SVG overlay draws success/failure/completion/
 * skip dependency arrows.
 *
 * This is the v3.27 shared DAG canvas — Phase 1 (read-only). Drag-drop
 * authoring is queued for Phase 2.
 */

import { useMemo } from 'react';
import { Badge, Caption1, MessageBar, MessageBarBody, makeStyles, tokens } from '@fluentui/react-components';

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
    top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: 'none',
  },
});

export interface PipelineActivityRef { activity: string; dependencyConditions?: string[]; }
export interface PipelineActivity {
  name: string;
  type?: string;
  dependsOn?: PipelineActivityRef[];
  description?: string;
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

export interface PipelineDagViewProps {
  activities: PipelineActivity[];
  emptyHint?: string;
}

export function PipelineDagView({ activities, emptyHint }: PipelineDagViewProps) {
  const s = useStyles();

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
    return (
      <MessageBar intent="info">
        <MessageBarBody>{emptyHint || 'No activities yet. Add one via the JSON editor — the DAG view will render automatically.'}</MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.shell}>
      <div className={s.legend}>
        <Caption1>Edge color:</Caption1>
        <Badge appearance="filled" color="success" size="small">Succeeded</Badge>
        <Badge appearance="filled" color="danger" size="small">Failed</Badge>
        <Badge appearance="filled" color="brand" size="small">Completed</Badge>
        <Badge appearance="filled" color="subtle" size="small">Skipped</Badge>
      </div>
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
          {edges.length} dependency edge{edges.length === 1 ? '' : 's'} — direction inferred from
          {' '}<code>dependsOn[]</code>. Hover an activity card to see its name.
          {edges.length > 0 && (
            <>
              {' '}First few:
              {' '}{edges.slice(0, 5).map((e, i) => (
                <span key={i} style={{ color: condColor(e.cond), marginLeft: 4 }}>
                  {e.from} → {e.to}{e.cond ? ` (${e.cond})` : ''}
                </span>
              ))}{edges.length > 5 && ` … +${edges.length - 5} more`}
            </>
          )}
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
