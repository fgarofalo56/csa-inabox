'use client';

/**
 * AdfCdcEditor — the Change Data Capture (preview) detail panel.
 *
 * Opened from the Factory Resources navigator when the operator clicks a CDC
 * resource. Mirrors ADF Studio's CDC resource view: the live status pill,
 * the latency/policy mode, and the source → target connection mapping — so the
 * operator can *preview* the CDC configuration and current state before
 * clicking Start (the "preview CDC output before executing" workflow).
 *
 * Every value comes from real ARM REST through /api/adf/cdc:
 *   - GET  /api/adf/cdc?name=X            → resource detail (mode, sources, targets)
 *   - GET  /api/adf/cdc?name=X&status=1   → live status poll (string)
 *   - POST /api/adf/cdc { name, action }  → Start / Stop / Delete
 *
 * No mocks, no Fabric dependency — the adfcdcs resource is plain Azure Data
 * Factory and works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Badge, Spinner, Caption1, Body1, Subtitle2, Divider,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Play16Regular, Stop16Regular, Delete16Regular, ArrowSync16Regular,
  DatabaseArrowRight20Regular, DatabaseLink20Regular, ArrowRepeatAll20Regular,
} from '@fluentui/react-icons';

const ROUTE = '/api/adf/cdc';
const POLL_MS = 5000;

interface CdcConn { linkedService: string; connectorType: string; entities: string[] }
interface CdcDetail {
  name: string;
  status: string;
  description: string;
  mode: string;
  recurrence: { frequency: string; interval: number } | null;
  folder: string;
  sources: CdcConn[];
  targets: CdcConn[];
}

const useStyles = makeStyles({
  surface: { maxWidth: '760px', width: '760px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  intro: { display: 'block', color: tokens.colorNeutralForeground3 },
  meta: {
    display: 'flex', gap: '16px', flexWrap: 'wrap',
    marginTop: '12px', marginBottom: '12px',
    ...shorthands.padding('12px'),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: tokens.colorNeutralBackground2,
  },
  metaItem: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' },
  metaLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  metaValue: { fontSize: tokens.fontSizeBase300 },
  desc: { display: 'block', marginBottom: '8px' },
  section: { marginTop: '16px' },
  sectionHead: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' },
  sortable: { cursor: 'pointer', userSelect: 'none' },
  muted: { color: tokens.colorNeutralForeground3 },
  spinnerWrap: { ...shorthands.padding('16px') },
  errorBar: { marginBottom: '8px' },
  leadActions: { display: 'flex', gap: '6px', alignItems: 'center', marginRight: 'auto' },
});

function statusColor(s: string): 'success' | 'informative' | 'warning' | 'danger' {
  const v = (s || '').toLowerCase();
  if (v === 'running') return 'success';
  if (v === 'stopped') return 'informative';
  if (v === 'starting' || v === 'stopping') return 'warning';
  return 'danger';
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

type ConnSortKey = 'linkedService' | 'connectorType';

/** Sortable source/target connection mapping table (Linked service · Connector · Entities). */
function ConnTable({ rows, emptyLabel }: { rows: CdcConn[]; emptyLabel: string }) {
  const s = useStyles();
  const [sortKey, setSortKey] = useState<ConnSortKey>('linkedService');
  const [dir, setDir] = useState<'ascending' | 'descending'>('ascending');

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const cmp = (a[sortKey] || '').localeCompare(b[sortKey] || '');
      return dir === 'ascending' ? cmp : -cmp;
    });
    return out;
  }, [rows, sortKey, dir]);

  const onSort = (key: ConnSortKey) => {
    if (key === sortKey) setDir((d) => (d === 'ascending' ? 'descending' : 'ascending'));
    else { setSortKey(key); setDir('ascending'); }
  };
  const sortProps = (key: ConnSortKey) => ({
    sortable: true,
    sortDirection: sortKey === key ? dir : undefined,
    className: s.sortable,
    onClick: () => onSort(key),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(key); } },
    tabIndex: 0,
  });

  if (rows.length === 0) return <Caption1 className={s.muted}>{emptyLabel}</Caption1>;
  return (
    <Table size="small" aria-label="CDC connections">
      <TableHeader>
        <TableRow>
          <TableHeaderCell {...sortProps('linkedService')}>Linked service</TableHeaderCell>
          <TableHeaderCell {...sortProps('connectorType')}>Connector</TableHeaderCell>
          <TableHeaderCell>Entities</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((c, i) => (
          <TableRow key={`${c.linkedService}-${i}`}>
            <TableCell>{c.linkedService}</TableCell>
            <TableCell><Badge size="small" appearance="outline">{c.connectorType}</Badge></TableCell>
            <TableCell>{c.entities.length ? c.entities.join(', ') : <Caption1 className={s.muted}>auto-discover</Caption1>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export interface AdfCdcEditorProps {
  /** CDC resource name to inspect; null closes the panel. */
  name: string | null;
  /** Called after close or after a destructive action that requires a tree refresh. */
  onClose: (changed?: boolean) => void;
}

export function AdfCdcEditor({ name, onClose }: AdfCdcEditorProps) {
  const s = useStyles();
  const [detail, setDetail] = useState<CdcDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async (n: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${ROUTE}?name=${encodeURIComponent(n)}`);
      const body = await readJson(res);
      if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); setLoading(false); return; }
      setGate(null);
      if (!body.ok) { setError(body.error || 'failed to load CDC resource'); setLoading(false); return; }
      setDetail(body.cdc as CdcDetail);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load when opened / name changes.
  useEffect(() => {
    setDetail(null); setError(null); setGate(null); setChanged(false);
    if (name) load(name);
  }, [name, load]);

  // Live status poll while Running / transitioning (matches ADF Studio's
  // auto-refreshing status pill). Only the cheap status endpoint is polled.
  useEffect(() => {
    if (!name || !detail) return;
    const v = (detail.status || '').toLowerCase();
    if (v !== 'running' && v !== 'starting' && v !== 'stopping') return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${ROUTE}?name=${encodeURIComponent(name)}&status=1`);
        const body = await readJson(res);
        if (body.ok && typeof body.status === 'string') {
          setDetail((d) => (d ? { ...d, status: body.status } : d));
        }
      } catch { /* transient; next tick retries */ }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [name, detail]);

  const lifecycle = useCallback(async (action: 'start' | 'stop' | 'delete') => {
    if (!name) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, action }),
      });
      const body = await readJson(res);
      if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); setBusy(false); return; }
      if (!body.ok) { setError(body.error || `${action} failed`); setBusy(false); return; }
      setChanged(true);
      if (action === 'delete') { setBusy(false); onClose(true); return; }
      await load(name);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [name, load, onClose]);

  const isRunning = (detail?.status || '').toLowerCase() === 'running';
  const transitioning = ['starting', 'stopping'].includes((detail?.status || '').toLowerCase());

  return (
    <Dialog open={name !== null} onOpenChange={(_, d) => { if (!d.open) onClose(changed); }}>
      <DialogSurface className={s.surface}>
        <DialogBody>
          <DialogTitle>
            <span className={s.titleRow}>
              <ArrowRepeatAll20Regular />
              Change Data Capture (preview){detail ? ` — ${detail.name}` : name ? ` — ${name}` : ''}
              {detail && (
                <Badge appearance="filled" color={statusColor(detail.status)}>{detail.status}</Badge>
              )}
            </span>
          </DialogTitle>
          <DialogContent>
            {gate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Data Factory not configured</MessageBarTitle>
                  Set <code>{gate.missing}</code> (plus <code>LOOM_SUBSCRIPTION_ID</code>, <code>LOOM_DLZ_RG</code>,{' '}
                  <code>LOOM_ADF_NAME</code>) so the console can reach a real Azure Data Factory. The Loom UAMI needs{' '}
                  <strong>Data Factory Contributor</strong> on that factory.
                </MessageBarBody>
              </MessageBar>
            )}

            {loading && <div className={s.spinnerWrap}><Spinner size="small" label="Loading CDC resource…" /></div>}

            {error && (
              <MessageBar intent="error" className={s.errorBar}>
                <MessageBarBody><MessageBarTitle>CDC error</MessageBarTitle>{error}</MessageBarBody>
              </MessageBar>
            )}

            {detail && !gate && (
              <>
                <Body1 className={s.intro}>
                  Inspect this Change Data Capture resource&apos;s status, latency policy, and source → target
                  mapping before executing it. Start the resource to run an initial load then continuously
                  capture changes into the Delta target; Stop to pause (landed data and the resource remain).
                </Body1>

                <div className={s.meta}>
                  <div className={s.metaItem}>
                    <span className={s.metaLabel}>Status</span>
                    <Badge appearance="filled" color={statusColor(detail.status)}>{detail.status}</Badge>
                  </div>
                  <div className={s.metaItem}>
                    <span className={s.metaLabel}>Latency / mode</span>
                    <span className={s.metaValue}>{detail.mode}{detail.recurrence ? ` · every ${detail.recurrence.interval} ${detail.recurrence.frequency}` : ''}</span>
                  </div>
                  {detail.folder && (
                    <div className={s.metaItem}>
                      <span className={s.metaLabel}>Folder</span>
                      <span className={s.metaValue}>{detail.folder}</span>
                    </div>
                  )}
                </div>
                {detail.description && <Caption1 className={s.desc}>{detail.description}</Caption1>}

                <Divider />

                <div className={s.section}>
                  <div className={s.sectionHead}><DatabaseLink20Regular /><Subtitle2>Source</Subtitle2></div>
                  <ConnTable rows={detail.sources} emptyLabel="No source connections configured." />
                </div>

                <div className={s.section}>
                  <div className={s.sectionHead}><DatabaseArrowRight20Regular /><Subtitle2>Target (Delta)</Subtitle2></div>
                  <ConnTable rows={detail.targets} emptyLabel="No target connections configured." />
                </div>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <div className={s.leadActions}>
              {name && !gate && (
                <Tooltip content="Refresh" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} disabled={loading || busy} onClick={() => load(name)} aria-label="Refresh CDC resource" />
                </Tooltip>
              )}
            </div>
            {detail && !gate && (
              isRunning
                ? <Button appearance="secondary" icon={<Stop16Regular />} disabled={busy || transitioning} onClick={() => lifecycle('stop')}>{busy ? 'Working…' : 'Stop'}</Button>
                : <Button appearance="primary" icon={<Play16Regular />} disabled={busy || transitioning} onClick={() => lifecycle('start')}>{busy ? 'Working…' : 'Start'}</Button>
            )}
            {detail && !gate && (
              <Button appearance="secondary" icon={<Delete16Regular />} disabled={busy} onClick={() => lifecycle('delete')}>Delete</Button>
            )}
            <Button appearance="subtle" onClick={() => onClose(changed)} disabled={busy}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
