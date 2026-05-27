'use client';

/**
 * ComputePicker — shared dropdown + lifecycle controls for any editor that
 * executes against an Azure compute target.
 *
 * Backed by /api/loom/compute-targets (returns the unified Synapse Spark /
 * Databricks cluster / Synapse Dedicated SQL / Synapse Serverless list) and
 * /api/loom/compute-targets/[id]/[verb] (start / stop / restart routed to
 * the right Azure REST per kind).
 *
 * Used by:
 *   - notebook-editor (already inlined the same pattern — left intact)
 *   - DbtJobEditor                (Databricks cluster)
 *   - MlModelEditor / MlExperimentEditor (Spark + Databricks)
 *   - WarehouseEditor             (Synapse Dedicated SQL pool — needs Resume)
 *   - SynapseSparkPoolEditor      (Synapse Spark)
 *   - SynapseDedicatedSqlPoolEditor (Synapse Dedicated SQL pool selector)
 *
 * Failures (list fetch, lifecycle POST) surface verbatim via MessageBar —
 * no mock data, per no-vaporware.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Select, Caption1, Button, Badge, Spinner, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles,
} from '@fluentui/react-components';
import { Play16Regular, Pause16Regular, ArrowSync16Regular } from '@fluentui/react-icons';

export type ComputeKind = 'synapse-spark' | 'databricks-cluster' | 'synapse-dedicated-sql' | 'synapse-serverless-sql';

export interface ComputeTarget {
  id: string;
  name: string;
  kind: ComputeKind;
  state?: string;
  sku?: string;
  nodeSize?: string;
  runEndpoint: string;
}

interface UseComputes {
  computes: ComputeTarget[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Subscribe to /api/loom/compute-targets. Optional `filter` narrows the
 * returned list to specific kinds (e.g. only Databricks clusters).
 */
export function useComputes(filter?: ComputeKind[]): UseComputes {
  const [computes, setComputes] = useState<ComputeTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true); setError(null);
    fetch('/api/loom/compute-targets')
      .then(r => r.json())
      .then(j => {
        if (!j.ok) { setError(j.error || 'failed'); return; }
        const all = (j.computes || []) as ComputeTarget[];
        setComputes(filter ? all.filter(c => filter.includes(c.kind)) : all);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { reload(); }, [reload]);
  return { computes, loading, error, reload };
}

function isPaused(state?: string): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === 'paused' || s === 'stopped' || s === 'terminated';
}

function isRunning(state?: string): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === 'running' || s === 'online' || s === 'available';
}

export interface ComputePickerProps {
  /** Currently selected compute id. */
  value: string;
  onChange: (id: string) => void;
  /** Restrict to a subset of kinds. */
  filter?: ComputeKind[];
  /** Label shown above the dropdown. */
  label?: string;
  /** Show start/stop/resume actions when compute exposes that lifecycle. */
  showLifecycle?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '280px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
});

export function ComputePicker({ value, onChange, filter, label, showLifecycle = true }: ComputePickerProps) {
  const s = useStyles();
  const { computes, loading, error, reload } = useComputes(filter);
  const selected = computes.find(c => c.id === value);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const lifecycleAction = useCallback(async (verb: 'start' | 'stop' | 'restart') => {
    if (!selected) return;
    setActionBusy(verb); setActionMsg(null);
    try {
      const r = await fetch(`/api/loom/compute-targets/${encodeURIComponent(selected.id)}/${verb}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setActionMsg(j.error || `${verb} failed`);
      else { setActionMsg(`${verb} requested — state will update shortly`); reload(); }
    } catch (e: any) { setActionMsg(e?.message || String(e)); }
    finally { setActionBusy(null); }
  }, [selected, reload]);

  const stateBadge = (state?: string) => {
    const color: 'success' | 'warning' | 'informative' = isRunning(state) ? 'success' : isPaused(state) ? 'warning' : 'informative';
    return <Badge color={color} size="small">{state || 'unknown'}</Badge>;
  };

  return (
    <div className={s.root}>
      <Caption1>{label || 'Compute target'}</Caption1>
      <div className={s.row}>
        <Select
          value={value}
          onChange={(_, d) => onChange(d.value)}
          disabled={loading || computes.length === 0}
          style={{ flex: 1, minWidth: 220 }}
        >
          {!value && <option value="">{loading ? 'Loading…' : computes.length ? 'Select compute' : 'No compute configured'}</option>}
          {computes.map(c => (
            <option key={c.id} value={c.id}>{c.name}{c.state ? ` · ${c.state}` : ''}</option>
          ))}
        </Select>
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={reload} disabled={loading} title="Refresh compute list" />
      </div>
      {selected && (
        <div className={s.row}>
          {stateBadge(selected.state)}
          {selected.sku && <Caption1>SKU: {selected.sku}</Caption1>}
          {selected.nodeSize && <Caption1>· {selected.nodeSize}</Caption1>}
        </div>
      )}
      {selected && showLifecycle && (
        <div className={s.row}>
          {isPaused(selected.state) && (
            <Button size="small" appearance="primary" icon={<Play16Regular />}
              onClick={() => lifecycleAction('start')} disabled={actionBusy !== null}>
              {actionBusy === 'start' ? 'Starting…' : 'Resume'}
            </Button>
          )}
          {isRunning(selected.state) && selected.kind !== 'synapse-serverless-sql' && (
            <Button size="small" appearance="secondary" icon={<Pause16Regular />}
              onClick={() => lifecycleAction('stop')} disabled={actionBusy !== null}>
              {actionBusy === 'stop' ? 'Stopping…' : 'Pause'}
            </Button>
          )}
          {(selected.kind === 'databricks-cluster') && (
            <Button size="small" appearance="subtle"
              onClick={() => lifecycleAction('restart')} disabled={actionBusy !== null}>
              {actionBusy === 'restart' ? 'Restarting…' : 'Restart'}
            </Button>
          )}
        </div>
      )}
      {actionMsg && (
        <MessageBar intent="info" style={{ marginTop: 4 }}>
          <MessageBarBody>{actionMsg}</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Compute not reachable</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {loading && <Spinner size="tiny" label="Loading compute…" />}
    </div>
  );
}
