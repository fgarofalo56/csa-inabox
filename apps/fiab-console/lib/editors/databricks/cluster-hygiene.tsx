'use client';

/**
 * ClusterHygienePanel — the "clean up old & random clusters" surface. Lists
 * EVERY cluster in the bound workspace (from /api/items/databricks-cluster/
 * hygiene) with state, source, idle-days, Loom-managed / preset badges, and a
 * stale flag. Multi-select → bulk Terminate (clusters/delete) or Delete
 * (permanent-delete). A "stale only" filter isolates the cruft
 * (TERMINATED > 7 days, or RUNNING idle > 2 days). Honest gate MessageBar when
 * the workspace is unbound. No mock data (no-vaporware) — every row + action is
 * the real Databricks REST via the BFF.
 */

import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Checkbox, Switch, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Stop20Regular, Delete20Regular, Broom20Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { useConfirm } from '@/lib/components/confirm-dialog';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import type { ClusterHygieneRow } from '@/lib/databricks/cluster-presets';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  headText: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  tableWrap: { overflow: 'auto', maxHeight: '460px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  nameCell: { display: 'flex', flexDirection: 'column' },
  idle: { color: tokens.colorNeutralForeground3 },
  checkCol: { width: '44px' },
});

function stateColor(s?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (s === 'RUNNING') return 'success';
  if (s === 'PENDING' || s === 'RESTARTING' || s === 'RESIZING') return 'warning';
  if (s === 'TERMINATED') return 'informative';
  return 'severe';
}

export function ClusterHygienePanel({ onChanged }: { onChanged?: () => void }) {
  const s = useStyles();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [rows, setRows] = useState<ClusterHygieneRow[]>([]);
  const [staleCount, setStaleCount] = useState(0);
  const [gate, setGate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [staleOnly, setStaleOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch('/api/items/databricks-cluster/hygiene');
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      if (j.gate) { setGate(j.gate); setRows([]); setStaleCount(0); return; }
      setRows(j.rows || []);
      setStaleCount(j.staleCount || 0);
      setSelected(new Set());
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => (staleOnly ? rows.filter((r) => r.stale) : rows), [rows, staleOnly]);
  // Only all-purpose (user-created) clusters are actionable — ephemeral job
  // clusters clean themselves up and can't be terminated by the user.
  const selectable = useMemo(() => visible.filter((r) => r.allPurpose), [visible]);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.cluster_id));

  const toggle = useCallback((id: string) => {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (selectable.every((r) => prev.has(r.cluster_id))) return new Set();
      return new Set(selectable.map((r) => r.cluster_id));
    });
  }, [selectable]);

  const runBulk = useCallback(async (action: 'terminate' | 'delete') => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const verb = action === 'delete' ? 'Permanently delete' : 'Terminate';
    if (!(await confirm({
      title: `${verb} ${ids.length} cluster${ids.length > 1 ? 's' : ''}?`,
      body: action === 'delete'
        ? 'This permanently deletes the selected clusters from the workspace. This cannot be undone.'
        : 'This terminates (stops) the selected clusters. They can be restarted later.',
      danger: true,
      confirmLabel: verb,
    }))) return;
    setBusy(true); setActionMsg(null);
    try {
      const r = await clientFetch('/api/items/databricks-cluster/hygiene', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, clusterIds: ids }),
      });
      const j = await r.json();
      const results: Array<{ cluster_id: string; ok: boolean; error?: string }> = j.results || [];
      const okCount = results.filter((x) => x.ok).length;
      const failed = results.filter((x) => !x.ok);
      setActionMsg(
        failed.length === 0
          ? `${verb.replace('Permanently delete', 'Deleted').replace('Terminate', 'Terminated')} ${okCount} cluster${okCount > 1 ? 's' : ''}.`
          : `${okCount} succeeded, ${failed.length} failed: ${failed.map((f) => `${f.cluster_id} (${f.error || 'error'})`).join('; ')}`,
      );
      await load();
      onChanged?.();
    } catch (e: any) { setActionMsg(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, confirm, load, onChanged]);

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.headText}>
          <Broom20Regular />
          <Subtitle2>Cluster hygiene</Subtitle2>
          <LearnPopover
            title="Keep the workspace tidy"
            content="Every cluster in the bound workspace is listed here with how long it has been idle and where it came from. Stale clusters — terminated over a week ago, or running but idle for days — are flagged so you can bulk-terminate or permanently delete them. Ephemeral job clusters aren't actionable; they clean up on their own."
            tips={[
              'Stale = TERMINATED > 7 days, or RUNNING idle > 2 days',
              'Terminate stops a cluster (restartable); Delete removes it permanently',
              'Loom-managed clusters carry the loom-managed tag',
            ]}
            learnMoreHref="https://learn.microsoft.com/azure/databricks/compute/clusters-manage"
          />
        </div>
        <div className={s.spacer} />
        <Button size="small" icon={<ArrowSync20Regular />} appearance="subtle" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Databricks workspace not bound</MessageBarTitle>
            Set <code>{gate}</code> (and the Console UAMI Databricks grant) to list and clean clusters.
            No workspace is configured in this deployment, so there is nothing to show yet.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not load clusters</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}
      {actionMsg && (
        <MessageBar intent="info"><MessageBarBody>{actionMsg}</MessageBarBody></MessageBar>
      )}

      {!gate && !error && (
        <>
          <div className={s.toolbar}>
            <Switch checked={staleOnly} onChange={(_, d) => setStaleOnly(!!d.checked)}
              label={`Stale only (${staleCount})`} />
            <Caption1>{visible.length} of {rows.length} clusters{selected.size ? ` · ${selected.size} selected` : ''}</Caption1>
            <div className={s.spacer} />
            <Tooltip content="Terminate (stop) the selected clusters — they can be restarted" relationship="label">
              <Button appearance="outline" icon={<Stop20Regular />} disabled={busy || selected.size === 0}
                onClick={() => void runBulk('terminate')}>Terminate</Button>
            </Tooltip>
            <Tooltip content="Permanently delete the selected clusters — cannot be undone" relationship="label">
              <Button appearance="outline" icon={<Delete20Regular />} disabled={busy || selected.size === 0}
                onClick={() => void runBulk('delete')}>Delete</Button>
            </Tooltip>
          </div>

          {loading ? (
            <Spinner size="small" label="Loading clusters…" labelPosition="after" />
          ) : rows.length === 0 ? (
            <MessageBar intent="success"><MessageBarBody>No clusters in the workspace — nothing to clean up.</MessageBarBody></MessageBar>
          ) : (
            <div className={s.tableWrap}>
              <Table size="small" aria-label="Workspace clusters">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell className={s.checkCol}>
                      <Checkbox aria-label="Select all actionable clusters" checked={allSelected}
                        onChange={toggleAll} disabled={selectable.length === 0} />
                    </TableHeaderCell>
                    <TableHeaderCell>Cluster</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Source</TableHeaderCell>
                    <TableHeaderCell>Idle</TableHeaderCell>
                    <TableHeaderCell>Managed</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => (
                    <TableRow key={r.cluster_id}>
                      <TableCell>
                        <Checkbox aria-label={`Select ${r.cluster_name || r.cluster_id}`}
                          checked={selected.has(r.cluster_id)} onChange={() => toggle(r.cluster_id)}
                          disabled={!r.allPurpose} />
                      </TableCell>
                      <TableCell>
                        <div className={s.nameCell}>
                          <Body1>{r.cluster_name || r.cluster_id}</Body1>
                          <Caption1 className={s.idle}>{r.node_type_id || '—'}</Caption1>
                        </div>
                      </TableCell>
                      <TableCell><Badge appearance="filled" color={stateColor(r.state)} size="small">{r.state || '?'}</Badge></TableCell>
                      <TableCell><Caption1>{r.source}{!r.allPurpose ? ' · ephemeral' : ''}</Caption1></TableCell>
                      <TableCell><Caption1 className={s.idle}>{r.idleDays === 0 ? '< 1 day' : `${r.idleDays} day${r.idleDays > 1 ? 's' : ''}`}</Caption1></TableCell>
                      <TableCell>
                        {r.loomManaged
                          ? <Badge appearance="tint" color="brand" size="small">{r.loomPreset || 'loom-managed'}</Badge>
                          : <Caption1 className={s.idle}>—</Caption1>}
                      </TableCell>
                      <TableCell>
                        {r.stale
                          ? <Badge appearance="filled" color="warning" size="small">Stale</Badge>
                          : <Caption1 className={s.idle}>OK</Caption1>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      {confirmDialog}
    </div>
  );
}
