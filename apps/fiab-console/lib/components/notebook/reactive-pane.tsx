'use client';

/**
 * N19a — Reactive pane for the Loom notebook.
 *
 * Shows the live dependency graph the reactive runtime derives from the cells
 * (Marimo-style): what each cell defines, what it depends on, which cells are
 * stale, and which are trapped in a dependency cycle. Every control acts on the
 * REAL run path (the editor's per-cell run against Spark / Livy / AML) — this
 * pane never fabricates a result.
 *
 * Reactive auto-run is a user toggle (default OFF, per-notebook). Staleness is
 * tracked either way, so the notebook can always tell the user "this output no
 * longer follows from this code" instead of silently showing an old number.
 */

import { useMemo } from 'react';
import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Badge, Caption1, Switch, Body1Strong, MessageBar, MessageBarBody, MessageBarTitle,
  Divider, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, Flash20Regular, Play20Regular, CheckmarkCircle20Regular,
  ArrowSyncCircle20Regular, Warning20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import type { NotebookDag } from '@/lib/notebook/reactive-dag';

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS, rowGap: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalS,
  },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    cursor: 'pointer',
    minWidth: 0,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  cardStale: { boxShadow: tokens.shadow4, outlineWidth: tokens.strokeWidthThin, outlineStyle: 'solid', outlineColor: tokens.colorPaletteYellowBorder1 },
  badgeRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXXS, minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  section: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalXS },
});

/** First non-empty source line, truncated — the cell's readable title. */
function cellTitle(cell: NotebookCell | undefined, index: number): string {
  const first = (cell?.source || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  const label = first ? (first.length > 52 ? `${first.slice(0, 52)}…` : first) : '(empty cell)';
  return `[${index + 1}] ${label}`;
}

export interface ReactivePaneProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cells: NotebookCell[];
  dag: NotebookDag;
  stale: Set<string>;
  cycleCells: Set<string>;
  enabled: boolean;
  onEnabledChange: (on: boolean) => void;
  running: boolean;
  onRunStale: () => void;
  onClearStale: () => void;
  onJump: (cellId: string) => void;
  /** False when an admin has turned the capability off (FLAG0). */
  available: boolean;
}

export function ReactivePane(props: ReactivePaneProps) {
  const s = useStyles();
  const {
    open, onOpenChange, cells, dag, stale, cycleCells, enabled, onEnabledChange,
    running, onRunStale, onClearStale, onJump, available,
  } = props;

  const indexOfCell = useMemo(() => {
    const m = new Map<string, number>();
    cells.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [cells]);
  const byId = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells]);
  const staleCount = dag.order.filter((id) => stale.has(id)).length;

  return (
    <Drawer type="overlay" position="end" open={open} onOpenChange={(_, d) => onOpenChange(d.open)} size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Close" onClick={() => onOpenChange(false)} />}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <Flash20Regular /> Reactive
          </span>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {!available && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Reactive mode is turned off</MessageBarTitle>
              An administrator disabled the <code>n19a-reactive-notebook</code> runtime flag. Re-enable it
              under Admin → Runtime flags; the notebook keeps working exactly as before in the meantime.
            </MessageBarBody>
          </MessageBar>
        )}

        <div className={s.toolbar}>
          <Switch
            checked={enabled}
            disabled={!available}
            onChange={(_, d) => onEnabledChange(!!d.checked)}
            label={enabled ? 'Reactive re-run on' : 'Reactive re-run off'}
          />
          <div style={{ flex: 1, minWidth: 0 }} />
          <Tooltip relationship="label" content="Run every stale cell in dependency order">
            <Button
              size="small" appearance="primary" icon={<Play20Regular />}
              disabled={staleCount === 0 || running} onClick={onRunStale}
            >
              {running ? 'Running…' : `Run stale (${staleCount})`}
            </Button>
          </Tooltip>
          <Tooltip relationship="label" content="Accept the current outputs and clear the stale marks">
            <Button size="small" appearance="subtle" icon={<CheckmarkCircle20Regular />} disabled={staleCount === 0 || running} onClick={onClearStale}>
              Mark fresh
            </Button>
          </Tooltip>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Loom derives the cell dependency graph from the variables each Python cell defines and reads.
          With reactive re-run on, running or editing a cell re-executes only the cells downstream of it —
          on the same Spark/Livy session your manual runs use.
        </Caption1>

        {dag.cycles.length > 0 && (
          <div style={{ marginTop: tokens.spacingVerticalM }}>
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Dependency cycle</MessageBarTitle>
                {dag.cycles.map((cyc) => cyc.map((id) => cellTitle(byId.get(id), indexOfCell.get(id) ?? 0)).join(' ↔ ')).join(' · ')}
                {' — these cells define names each other reads, so there is no valid run order. '}
                They are never auto-run; break the cycle by moving one definition into its own cell.
              </MessageBarBody>
            </MessageBar>
          </div>
        )}

        {dag.collisions.length > 0 && (
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            <MessageBar intent="info" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Redefined variables</MessageBarTitle>
                {dag.collisions.map((c) => c.name).join(', ')} {dag.collisions.length === 1 ? 'is' : 'are'} defined
                in more than one cell, so Loom cannot tell which definition a reader depends on and links it to all
                of them (a wider re-run than necessary). Rename or consolidate for precise reactivity.
              </MessageBarBody>
            </MessageBar>
          </div>
        )}

        <div className={s.section}>
          <ArrowSyncCircle20Regular />
          <Body1Strong>Cells ({dag.order.length})</Body1Strong>
        </div>

        {dag.order.length === 0 ? (
          <EmptyState
            icon={<Flash20Regular />}
            title="No code cells yet"
            body="Add a Python or PySpark cell. Loom reads the variables it defines and consumes to build the dependency graph that powers reactive re-run."
          />
        ) : (
          <div className={s.list}>
            {dag.order.map((id) => {
              const cell = byId.get(id);
              const idx = indexOfCell.get(id) ?? 0;
              const a = dag.analyses[id];
              const ups = dag.dependencies[id] || [];
              const downs = dag.dependents[id] || [];
              const isStale = stale.has(id);
              const inCycle = cycleCells.has(id);
              return (
                <div
                  key={id}
                  className={isStale ? `${s.card} ${s.cardStale}` : s.card}
                  role="button" tabIndex={0}
                  onClick={() => onJump(id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(id); } }}
                  title={cellTitle(cell, idx)}
                >
                  <div className={s.badgeRow}>
                    <Caption1 className={s.truncate} style={{ flex: 1 }}>{cellTitle(cell, idx)}</Caption1>
                    {isStale && <Badge size="small" appearance="tint" color="warning">stale</Badge>}
                    {!isStale && inCycle && <Badge size="small" appearance="tint" color="danger" icon={<Warning20Regular />}>cycle</Badge>}
                  </div>
                  <div className={s.badgeRow}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      {!a?.analyzed
                        ? `${(cell?.lang || 'sql')} cell — not analyzed for dependencies`
                        : `defines ${a.defs.length ? a.defs.join(', ') : '—'} · reads ${a.uses.length ? a.uses.join(', ') : '—'}`}
                    </Caption1>
                  </div>
                  <div className={s.badgeRow}>
                    <Badge size="small" appearance="outline">{ups.length} upstream</Badge>
                    <Badge size="small" appearance="outline">{downs.length} downstream</Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Divider style={{ marginTop: tokens.spacingVerticalM }} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          SQL, Scala, R, T-SQL and C# cells are listed but not statically analyzed, so they are never
          auto-invalidated — run them yourself when their inputs change.
        </Caption1>
      </DrawerBody>
    </Drawer>
  );
}
