'use client';

/**
 * ReconcileLineageButton — admin action on the Lineage surface (LIN-GC-2/4).
 *
 * Reconciles TWO orphan planes and purges both: (1) Loom-provisioned Microsoft
 * Purview entities whose backing item was deleted, and (2) Loom-native
 * Weave/Thread edges (rendered on /thread) with a source or target item that no
 * longer exists. Both are lineage that outlived its item after a per-item /
 * workspace / bulk delete. A DRY-RUN preview always runs first; the actual purge
 * is a second, explicit confirm — never a one-click destructive action.
 *
 * The Thread-edge sweep is meaningful even without Purview, so the button is
 * self-gated on tenant-admin only (probes GET /api/admin/lineage/reconcile) and
 * renders nothing for non-admins — safe to drop onto a shared surface.
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
interface ThreadEdgeOrphan {
  edgeId: string;
  fromItemId: string; fromType: string; fromName?: string;
  toItemId: string; toType: string; toName?: string;
  toExternal?: boolean;
  missing: Array<'from' | 'to'>;
}
interface ThreadEdgePurgeResult { edgeId: string; result: 'deleted' | 'error'; }
interface ThreadEdgeSection { scanned?: number; orphans?: ThreadEdgeOrphan[]; purged?: ThreadEdgePurgeResult[]; }
interface ScanResponse {
  ok: boolean;
  dryRun?: boolean;
  purviewConfigured?: boolean;
  scanned?: number;
  orphans?: Orphan[];
  purged?: PurgeResult[];
  threadEdges?: ThreadEdgeSection;
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
  const [threadPurged, setThreadPurged] = useState<ThreadEdgePurgeResult[] | null>(null);
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
    setLoading(true); setError(null); setPurged(null); setThreadPurged(null); setScan(null);
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
        setThreadPurged(j.threadEdges?.purged || []);
        setScan((prev) => (prev ? { ...prev, orphans: [], threadEdges: { ...prev.threadEdges, orphans: [] } } : prev));
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, []);

  const onOpenChange = (_: unknown, d: { open: boolean }) => {
    setOpen(d.open);
    if (d.open) runDryRun();
    else { setScan(null); setPurged(null); setThreadPurged(null); setError(null); }
  };

  if (!isAdmin) return null;

  const orphans = scan?.orphans || [];
  const threadOrphans = scan?.threadEdges?.orphans || [];
  const threadScanned = scan?.threadEdges?.scanned ?? 0;
  const totalOrphans = orphans.length + threadOrphans.length;
  const purgeDone = purged !== null || threadPurged !== null;
  const deletedCount = (purged || []).filter((p) => p.result === 'deleted').length;
  const threadDeletedCount = (threadPurged || []).filter((p) => p.result === 'deleted').length;
  const totalPurged = (purged?.length || 0) + (threadPurged?.length || 0);
  const totalDeleted = deletedCount + threadDeletedCount;
  const purgeHadError =
    (purged || []).some((p) => p.result === 'error') || (threadPurged || []).some((p) => p.result === 'error');

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
              Finds lineage that outlived its item — Loom-provisioned Purview catalog
              entities <strong>and</strong> Loom-native Weave/Thread edges (on the Lineage graph)
              whose source or target item was deleted — then purges them. A dry-run
              preview runs first; nothing is deleted until you confirm.
            </Body1>

            {purviewConfigured === false && (
              <MessageBar intent="info" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>Purview not configured</MessageBarTitle>
                  No Microsoft Purview account is bound (set <code>LOOM_PURVIEW_ACCOUNT</code> to
                  register catalog entities), so only the Loom-native Weave/Thread edges are
                  reconciled here.
                </MessageBarBody>
              </MessageBar>
            )}

            {error && (
              <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody><MessageBarTitle>Reconcile failed</MessageBarTitle>{error}</MessageBarBody>
              </MessageBar>
            )}

            {loading && (
              <div className={s.spinnerRow}><Spinner label={purgeDone ? 'Purging orphans…' : 'Scanning for orphaned lineage…'} /></div>
            )}

            {!loading && scan && !purgeDone && (
              <>
                <div className={s.summary}>
                  <Badge appearance="tint" color="informative">{scan.scanned ?? 0} Purview entities scanned</Badge>
                  <Badge appearance="tint" color="informative">{threadScanned} Weave edges scanned</Badge>
                  <Badge appearance="tint" color={totalOrphans > 0 ? 'warning' : 'success'}>
                    {totalOrphans} orphan{totalOrphans === 1 ? '' : 's'}
                  </Badge>
                </div>

                {totalOrphans === 0 ? (
                  <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                    <MessageBarBody>No orphaned lineage — every Purview entity and Weave edge maps to a live Loom item.</MessageBarBody>
                  </MessageBar>
                ) : (
                  <>
                    {orphans.length > 0 && (
                      <>
                        <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM }}>
                          Purview catalog entities ({orphans.length})
                        </Caption1>
                        <div className={s.scroll}>
                          <Table size="small" aria-label="Orphaned Purview lineage entities">
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
                      </>
                    )}

                    {threadOrphans.length > 0 && (
                      <>
                        <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalM }}>
                          Weave / Thread edges ({threadOrphans.length})
                        </Caption1>
                        <div className={s.scroll}>
                          <Table size="small" aria-label="Orphaned Weave lineage edges">
                            <TableHeader>
                              <TableRow>
                                <TableHeaderCell>Source</TableHeaderCell>
                                <TableHeaderCell>Target</TableHeaderCell>
                                <TableHeaderCell>Missing</TableHeaderCell>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {threadOrphans.map((e) => (
                                <TableRow key={e.edgeId}>
                                  <TableCell>{e.fromName || e.fromItemId}<Caption1> · {e.fromType}</Caption1></TableCell>
                                  <TableCell>{e.toName || e.toItemId}<Caption1> · {e.toType}</Caption1></TableCell>
                                  <TableCell><Caption1>{e.missing.join(' + ')}</Caption1></TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {!loading && purgeDone && (
              <MessageBar intent={!purgeHadError ? 'success' : 'warning'} style={{ marginTop: tokens.spacingVerticalM }}>
                <MessageBarBody>
                  <MessageBarTitle>Purge complete</MessageBarTitle>
                  Removed {totalDeleted} of {totalPurged} orphan{totalPurged === 1 ? '' : 's'}
                  {' '}({deletedCount} Purview entit{deletedCount === 1 ? 'y' : 'ies'}, {threadDeletedCount} Weave edge{threadDeletedCount === 1 ? '' : 's'}).
                  {purgeHadError && ' Some could not be removed — re-run to retry.'}
                </MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            {!purgeDone && totalOrphans > 0 && (
              <Button
                appearance="primary"
                icon={<DeleteRegular />}
                disabled={loading}
                onClick={runPurge}
              >
                Purge {totalOrphans} orphan{totalOrphans === 1 ? '' : 's'}
              </Button>
            )}
            {(purgeDone || scan) && (
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
