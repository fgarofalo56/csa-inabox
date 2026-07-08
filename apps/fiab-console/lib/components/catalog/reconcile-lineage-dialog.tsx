'use client';

/**
 * ReconcileLineageButton — admin action on the Lineage surface (LIN-GC-2).
 *
 * Diffs Loom-provisioned Microsoft Purview entities against live Cosmos items
 * and purges the orphans (lineage that outlived its item after a per-item /
 * workspace / bulk delete). A DRY-RUN preview always runs first; the actual
 * purge is a second, explicit confirm — never a one-click destructive action.
 *
 * Self-gating: probes GET /api/admin/lineage/reconcile and renders nothing for
 * non-admins, so it's safe to drop onto a shared surface.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Button, Spinner, Badge,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Caption1, Body1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { BroomRegular, DeleteRegular, ArrowSyncRegular } from '@fluentui/react-icons';

interface Orphan {
  qualifiedName: string;
  typeName: string;
  itemType: string;
  itemId: string;
  displayName?: string;
}
interface PurgeResult { qualifiedName: string; itemId: string; result: 'deleted' | 'not_found' | 'error'; error?: string; }
interface ScanResponse {
  ok: boolean;
  dryRun?: boolean;
  purviewConfigured?: boolean;
  scanned?: number;
  orphans?: Orphan[];
  purged?: PurgeResult[];
  error?: string;
}

const useStyles = makeStyles({
  surface: { maxWidth: '720px' },
  scroll: {
    maxHeight: '340px', overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalM,
  },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
  summary: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  spinnerRow: { paddingTop: tokens.spacingVerticalXL, paddingBottom: tokens.spacingVerticalXL },
});

export function ReconcileLineageButton() {
  const s = useStyles();
  const [isAdmin, setIsAdmin] = useState(false);
  const [purviewConfigured, setPurviewConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [purged, setPurged] = useState<PurgeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Probe admin + Purview state once; render nothing for non-admins.
  useEffect(() => {
    let alive = true;
    clientFetch('/api/admin/lineage/reconcile')
      .then((r) => r.json())
      .then((j) => { if (alive && j?.ok) { setIsAdmin(!!j.isAdmin); setPurviewConfigured(!!j.purviewConfigured); } })
      .catch(() => { /* probe is best-effort; button stays hidden */ });
    return () => { alive = false; };
  }, []);

  const runDryRun = useCallback(() => {
    setLoading(true); setError(null); setPurged(null); setScan(null);
    clientFetch('/api/admin/lineage/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    })
      .then((r) => r.json())
      .then((j: ScanResponse) => {
        if (!j.ok) { setError(j.error || 'Reconcile scan failed'); return; }
        setScan(j);
        if (typeof j.purviewConfigured === 'boolean') setPurviewConfigured(j.purviewConfigured);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  const runPurge = useCallback(() => {
    setLoading(true); setError(null);
    clientFetch('/api/admin/lineage/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false }),
    })
      .then((r) => r.json())
      .then((j: ScanResponse) => {
        if (!j.ok) { setError(j.error || 'Purge failed'); return; }
        setPurged(j.purged || []);
        setScan((prev) => (prev ? { ...prev, orphans: [] } : prev));
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  const onOpenChange = (_: unknown, d: { open: boolean }) => {
    setOpen(d.open);
    if (d.open) runDryRun();
    else { setScan(null); setPurged(null); setError(null); }
  };

  if (!isAdmin) return null;

  const orphans = scan?.orphans || [];
  const deletedCount = (purged || []).filter((p) => p.result === 'deleted').length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger disableButtonEnhancement>
        <Button icon={<BroomRegular />} appearance="subtle">Reconcile lineage</Button>
      </DialogTrigger>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>Reconcile lineage</DialogTitle>
          <DialogContent>
            <Body1>
              Finds Loom-provisioned Purview catalog entities whose backing item was
              deleted and still render on the lineage graph, then purges them. A dry-run
              preview runs first — nothing is deleted until you confirm.
            </Body1>

            {purviewConfigured === false && (
              <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>Purview not configured</MessageBarTitle>
                  Lineage entities are only registered when a Microsoft Purview account is bound
                  (set <code>LOOM_PURVIEW_ACCOUNT</code>). There is nothing to reconcile in this
                  deployment — Loom-native Weave edges are already cleaned on delete.
                </MessageBarBody>
              </MessageBar>
            )}

            {error && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody><MessageBarTitle>Reconcile failed</MessageBarTitle>{error}</MessageBarBody>
              </MessageBar>
            )}

            {loading && (
              <div className={s.spinnerRow}><Spinner label={purged ? 'Purging orphans…' : 'Scanning Purview for orphaned lineage…'} /></div>
            )}

            {!loading && scan && !purged && (
              <>
                <div className={s.summary}>
                  <Badge appearance="tint" color="informative">{scan.scanned ?? 0} Loom entities scanned</Badge>
                  <Badge appearance="tint" color={orphans.length > 0 ? 'warning' : 'success'}>
                    {orphans.length} orphan{orphans.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                {orphans.length === 0 ? (
                  <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                    <MessageBarBody>No orphaned lineage — every Purview entity maps to a live Loom item.</MessageBarBody>
                  </MessageBar>
                ) : (
                  <div className={s.scroll}>
                    <Table size="small" aria-label="Orphaned lineage entities">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Asset</TableHeaderCell>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Item id</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {orphans.map((o) => (
                          <TableRow key={o.qualifiedName}>
                            <TableCell>{o.displayName || o.itemId}</TableCell>
                            <TableCell><Caption1>{o.itemType}</Caption1></TableCell>
                            <TableCell><span className={s.mono}>{o.itemId}</span></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {!loading && purged && (
              <MessageBar intent={deletedCount === purged.length ? 'success' : 'warning'} style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>Purge complete</MessageBarTitle>
                  Removed {deletedCount} of {purged.length} orphaned entit{purged.length === 1 ? 'y' : 'ies'} from the Purview catalog.
                  {purged.some((p) => p.result === 'error') && ' Some entities could not be removed — re-run to retry.'}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            {!purged && orphans.length > 0 && (
              <Button
                appearance="primary"
                icon={<DeleteRegular />}
                disabled={loading}
                onClick={runPurge}
              >
                Purge {orphans.length} orphan{orphans.length === 1 ? '' : 's'}
              </Button>
            )}
            {(purged || scan) && (
              <Button appearance="secondary" icon={<ArrowSyncRegular />} disabled={loading} onClick={runDryRun}>
                Re-scan
              </Button>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="subtle">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
