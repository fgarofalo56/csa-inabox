'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * RunningWorkloadsButton — topbar switcher that lists the caller's currently
 * RUNNING notebooks + pipelines and lets them jump BACK to any of them.
 *
 * A notebook cell run (Livy session) and a pipeline run (ADF run id) both
 * execute server-side, so navigating away never ends the run — this switcher is
 * how the user returns to it. Clicking a row opens the item editor as a tab; the
 * editor re-attaches to the live run id (notebook `resumePendingRuns`, pipeline
 * runs list) and resumes streaming output rather than restarting.
 *
 * Data: GET /api/running-workloads (real Cosmos pendingRuns + live ADF monitor
 * API — no mocks). Polls every 15s while signed in; honest empty state when
 * nothing runs. Badge shows the live count.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Button, Tooltip, makeStyles, tokens,
  Popover, PopoverTrigger, PopoverSurface, Spinner,
} from '@fluentui/react-components';
import {
  PlayCircle24Regular, Notebook20Regular, Flow20Regular, Open16Regular,
} from '@fluentui/react-icons';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import type { RunningWorkload } from '@/lib/workloads/running-workloads';

const POLL_MS = 15_000;

const useStyles = makeStyles({
  trigger: {
    color: 'white',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.10)' },
    flexShrink: 0,
    position: 'relative',
  },
  badge: {
    position: 'absolute', top: tokens.spacingVerticalXS, right: tokens.spacingHorizontalXS,
    minWidth: tokens.spacingHorizontalL, height: tokens.spacingVerticalL, padding: '0 4px',
    borderRadius: 'var(--loom-radius-full)',
    backgroundColor: tokens.colorPaletteGreenBackground3,
    color: 'white',
    fontSize: tokens.fontSizeBase100, fontWeight: 700,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--loom-topbar-bg)',
  },
  surface: {
    width: '380px', maxHeight: '480px', padding: 0,
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: 'var(--loom-space-3)',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontWeight: 600,
  },
  headerCount: {
    marginLeft: 'auto', fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3, fontWeight: 400,
  },
  list: { flex: 1, overflow: 'auto' },
  item: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    width: '100%', textAlign: 'left',
    padding: 'var(--loom-space-3)',
    background: 'transparent',
    borderTopWidth: 0, borderRightWidth: 0, borderLeftWidth: 0,
    borderBottomWidth: '1px', borderBottomStyle: 'solid',
    borderBottomColor: tokens.colorNeutralStroke2,
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  icon: {
    flexShrink: 0, display: 'inline-flex',
    color: tokens.colorBrandForeground1,
  },
  itemMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  itemTitle: {
    fontSize: '13px', fontWeight: 600,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  itemMeta: {
    fontSize: '11px', color: tokens.colorNeutralForeground3,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  pulse: {
    width: '8px', height: '8px', borderRadius: 'var(--loom-radius-full)',
    backgroundColor: tokens.colorPaletteGreenForeground1,
    flexShrink: 0,
    animationName: {
      '0%': { opacity: 1 }, '50%': { opacity: 0.35 }, '100%': { opacity: 1 },
    },
    animationDuration: '1.6s',
    animationIterationCount: 'infinite',
  },
  openHint: { flexShrink: 0, color: tokens.colorNeutralForeground3 },
  empty: {
    padding: 'var(--loom-space-5)', textAlign: 'center',
    color: tokens.colorNeutralForeground2, fontSize: '13px', lineHeight: 1.5,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
  },
  loading: {
    padding: 'var(--loom-space-5)', display: 'flex', justifyContent: 'center',
  },
});

/** Compact relative-time ("3m", "1h 4m") for a run's start. */
function elapsed(startedAt?: string): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

export function RunningWorkloadsButton() {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [workloads, setWorkloads] = useState<RunningWorkload[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    clientFetch('/api/running-workloads')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.workloads)) setWorkloads(d.workloads);
      })
      .catch(() => { /* silent — transient network / signed out */ })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const openItem = useCallback((w: RunningWorkload) => {
    const title = w.displayName || itemVisual(w.itemType).label;
    // Same tab-open contract the object explorer uses; the editor then
    // re-attaches to the live run id on mount.
    window.dispatchEvent(new CustomEvent('loom:open-tab', {
      detail: { title, href: w.href, type: w.itemType },
    }));
    setOpen(false);
  }, []);

  const count = workloads.length;

  return (
    <Popover open={open} onOpenChange={(_, d) => { setOpen(d.open); if (d.open) load(); }}>
      <PopoverTrigger disableButtonEnhancement>
        <Tooltip content={count ? `${count} running workload${count === 1 ? '' : 's'}` : 'Running workloads'} relationship="label">
          <Button appearance="transparent" className={styles.trigger}
            icon={<PlayCircle24Regular />}
            aria-label={`Running workloads${count ? ` (${count} active)` : ''}`}>
            {count > 0 && <span className={styles.badge}>{count > 99 ? '99+' : count}</span>}
          </Button>
        </Tooltip>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface}>
        <div className={styles.header}>
          <PlayCircle24Regular />
          <span>Running workloads</span>
          {count > 0 && <span className={styles.headerCount}>{count} active</span>}
        </div>
        {!loaded ? (
          <div className={styles.loading}><Spinner size="tiny" label="Checking for running work…" /></div>
        ) : count === 0 ? (
          <div className={styles.empty}>
            <PlayCircle24Regular style={{ color: tokens.colorNeutralForeground4, width: 28, height: 28 }} />
            <span>Nothing is running right now.</span>
            <span style={{ fontSize: '11px', color: tokens.colorNeutralForeground3 }}>
              Notebooks and pipelines you run keep executing when you navigate away — they'll appear here so you can jump back.
            </span>
          </div>
        ) : (
          <div className={styles.list}>
            {workloads.map((w) => (
              <button
                key={`${w.itemId}:${w.runId}`}
                type="button"
                className={styles.item}
                onClick={() => openItem(w)}
                aria-label={`Open ${w.displayName} (${w.kind}, running)`}
              >
                <span className={styles.icon}>
                  {w.kind === 'notebook' ? <Notebook20Regular /> : <Flow20Regular />}
                </span>
                <span className={styles.itemMain}>
                  <span className={styles.itemTitle}>{w.displayName}</span>
                  <span className={styles.itemMeta}>
                    <span className={styles.pulse} aria-hidden />
                    <span>{w.kind === 'notebook' ? 'Notebook' : 'Pipeline'}</span>
                    <span aria-hidden>·</span>
                    <span>{w.status === 'running' ? 'Running' : w.status}</span>
                    {elapsed(w.startedAt) && (<><span aria-hidden>·</span><span>{elapsed(w.startedAt)}</span></>)}
                  </span>
                </span>
                <Open16Regular className={styles.openHint} />
              </button>
            ))}
          </div>
        )}
      </PopoverSurface>
    </Popover>
  );
}
