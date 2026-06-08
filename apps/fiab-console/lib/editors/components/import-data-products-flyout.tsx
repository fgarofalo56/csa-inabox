'use client';

/**
 * ImportDataProductsFlyout — right-side OverlayDrawer that bulk-creates DRAFT
 * `data-product` items from a CSV (≤1000 rows) and monitors the import job.
 *
 * Two tabs:
 *  - Import: download a CSV template, pick a target workspace, choose a CSV,
 *    get instant client-side column/row validation (lib/util/csv-parse.ts), then
 *    POST multipart to /api/data-products/import. Switches to Monitor on submit.
 *  - Monitor: polls GET /api/data-products/jobs/<jobId> every 5s and shows live
 *    success/fail counts + a per-row error log. Invalid rows are reported here
 *    without aborting the valid rows.
 *
 * No mock data — every control hits the real BFF; invalid input surfaces a
 * Fluent MessageBar, and an unconfigured ADLS staging account surfaces an
 * honest gate (the import still runs inline). Per .claude/rules/no-vaporware.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Tab, TabList, Badge, Button, Field, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, ProgressBar, Caption1, Subtitle2, Body1,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, ArrowDownload20Regular, ArrowUpload20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { validateImportCsv, type CsvValidation } from '@/lib/util/csv-parse';
import type { DataProductImportJob } from '@/lib/azure/cosmos-client';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  fileInput: {
    padding: 8,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    width: '100%',
  },
  tableWrap: {
    overflow: 'auto', maxHeight: 240,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  kpis: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  mono: { fontFamily: 'Consolas, monospace', fontSize: 12, color: tokens.colorNeutralForeground3 },
});

interface WorkspaceLite { id: string; name: string }

function statusColor(status?: string): 'success' | 'danger' | 'warning' | 'informative' | 'brand' {
  switch (status) {
    case 'done': return 'success';
    case 'failed': return 'danger';
    case 'partial': return 'warning';
    case 'running': return 'brand';
    default: return 'informative';
  }
}

export interface ImportDataProductsFlyoutProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected workspace; the user can still change it in the flyout. */
  defaultWorkspaceId?: string;
  /** Called after the import job reaches a terminal state with ≥1 success. */
  onImportComplete?: (job: DataProductImportJob) => void;
}

export function ImportDataProductsFlyout({
  open, onOpenChange, defaultWorkspaceId, onImportComplete,
}: ImportDataProductsFlyoutProps) {
  const s = useStyles();
  const [tab, setTab] = useState<'import' | 'monitor'>('import');

  // --- workspaces ---
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || '');

  // --- file + client-side validation ---
  const [fileName, setFileName] = useState('');
  const [fileBlob, setFileBlob] = useState<Blob | null>(null);
  const [validation, setValidation] = useState<CsvValidation | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // --- submit ---
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string; message: string } | null>(null);

  // --- monitor ---
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<DataProductImportJob | null>(null);
  const [polling, setPolling] = useState(false);
  const [monitorErr, setMonitorErr] = useState<string | null>(null);
  const completeFired = useRef(false);

  // Load workspaces when the drawer opens.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        if (!j.ok) { setWsError(j.error || `HTTP ${r.status}`); setWorkspaces([]); return; }
        setWorkspaces(j.workspaces || []);
        setWorkspaceId((cur) => cur || defaultWorkspaceId || j.workspaces?.[0]?.id || '');
      } catch (e: any) {
        setWsError(e?.message || String(e));
        setWorkspaces([]);
      }
    })();
  }, [open, defaultWorkspaceId]);

  const handleFile = useCallback(async (f: File | null) => {
    setParseErr(null); setValidation(null); setFileBlob(null); setFileName('');
    if (!f) return;
    setFileName(f.name);
    try {
      const text = await f.text();
      const v = validateImportCsv(text);
      setValidation(v);
      setFileBlob(f);
    } catch (e: any) {
      setParseErr(e?.message || String(e));
    }
  }, []);

  const downloadTemplate = useCallback(() => {
    // Hit the real template route so the downloaded file is the single source of
    // truth for the column contract.
    window.open('/api/data-products/import/template', '_blank');
  }, []);

  const canImport = !!workspaceId && !!fileBlob && !!validation
    && validation.validRowCount > 0 && !validation.tooLarge
    && validation.errors.filter((e) => e.row === 1).length === 0
    && !busy;

  const handleImport = useCallback(async () => {
    if (!fileBlob || !workspaceId) return;
    setBusy(true); setSubmitErr(null); setGate(null);
    setJob(null); setJobId(null); completeFired.current = false;
    try {
      const formData = new FormData();
      formData.append('file', fileBlob, fileName || 'import.csv');
      const r = await fetch(`/api/data-products/import?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', body: formData,
      });
      const j = await r.json();
      if (!j.ok) { setSubmitErr(j.error || `HTTP ${r.status}`); return; }
      if (j.gate) setGate(j.gate);
      setJobId(j.jobId);
      setPolling(true);
      setTab('monitor');
    } catch (e: any) {
      setSubmitErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [fileBlob, fileName, workspaceId]);

  // Poll the job every 5s while running.
  const pollOnce = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/data-products/jobs/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setMonitorErr(j.error || `HTTP ${r.status}`); return null; }
      setMonitorErr(null);
      setJob(j.job as DataProductImportJob);
      return j.job as DataProductImportJob;
    } catch (e: any) {
      setMonitorErr(e?.message || String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!jobId || !polling) return;
    let cancelled = false;
    // Immediate fetch, then every 5s.
    (async () => { await pollOnce(jobId); })();
    const t = setInterval(async () => {
      if (cancelled) return;
      const latest = await pollOnce(jobId);
      if (latest && latest.status !== 'running') {
        setPolling(false);
      }
    }, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [jobId, polling, pollOnce]);

  // Fire onImportComplete once when the job terminates with ≥1 success.
  useEffect(() => {
    if (!job || job.status === 'running' || completeFired.current) return;
    completeFired.current = true;
    if (job.successCount > 0) onImportComplete?.(job);
  }, [job, onImportComplete]);

  const wsOptions = workspaces || [];
  const headerColErrors = useMemo(
    () => (validation?.errors || []).filter((e) => e.row === 1),
    [validation],
  );
  const rowColErrors = useMemo(
    () => (validation?.errors || []).filter((e) => e.row > 1),
    [validation],
  );

  return (
    <OverlayDrawer open={open} onOpenChange={(_, d) => onOpenChange(d.open)} position="end" size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => onOpenChange(false)} aria-label="Close import flyout" />}
        >
          Bulk import data products
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'import' | 'monitor')}>
          <Tab value="import">Import</Tab>
          <Tab value="monitor" disabled={!jobId}>Monitor</Tab>
        </TabList>

        {tab === 'import' && (
          <div className={s.body}>
            <Caption1>
              Upload a CSV (max 1,000 rows) to create draft data products. Columns:
              {' '}<strong>name</strong>, <strong>description</strong>, <strong>domain</strong>, <strong>owner</strong> (required) and <strong>tags</strong> (optional, semicolon-separated).
            </Caption1>

            <div className={s.row}>
              <Button appearance="subtle" icon={<ArrowDownload20Regular />} onClick={downloadTemplate}>
                Download CSV template
              </Button>
            </div>

            <Field label="Target workspace" required>
              <Dropdown
                placeholder={workspaces === null ? 'Loading workspaces…' : wsOptions.length === 0 ? 'No workspaces — create one first' : 'Select a workspace'}
                value={wsOptions.find((w) => w.id === workspaceId)?.name || ''}
                selectedOptions={workspaceId ? [workspaceId] : []}
                disabled={workspaces === null || wsOptions.length === 0}
                onOptionSelect={(_, d) => setWorkspaceId(d.optionValue || '')}
              >
                {wsOptions.map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
              </Dropdown>
            </Field>
            {wsError && (
              <MessageBar intent="warning"><MessageBarBody>
                <MessageBarTitle>Workspaces not reachable</MessageBarTitle>{wsError}
              </MessageBarBody></MessageBar>
            )}

            <Field label="CSV file" required>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className={s.fileInput}
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </Field>

            {parseErr && (
              <MessageBar intent="error"><MessageBarBody>{parseErr}</MessageBarBody></MessageBar>
            )}

            {validation && validation.tooLarge && (
              <MessageBar intent="error"><MessageBarBody>
                <MessageBarTitle>Too many rows</MessageBarTitle>
                CSV has {validation.parsed.rows.length} rows — the limit is 1,000. Trim the file and re-upload.
              </MessageBarBody></MessageBar>
            )}

            {validation && headerColErrors.length > 0 && (
              <MessageBar intent="error"><MessageBarBody>
                <MessageBarTitle>Missing required columns</MessageBarTitle>
                {headerColErrors.map((e) => e.error).join('; ')}
              </MessageBarBody></MessageBar>
            )}

            {validation && headerColErrors.length === 0 && (
              <MessageBar intent={validation.validRowCount > 0 ? 'success' : 'warning'}><MessageBarBody>
                {validation.parsed.rows.length} row(s) parsed — {validation.validRowCount} valid,
                {' '}{validation.parsed.rows.length - validation.validRowCount} with errors. Valid rows import;
                invalid rows are listed in the error log without blocking the rest.
              </MessageBarBody></MessageBar>
            )}

            {rowColErrors.length > 0 && (
              <div className={s.tableWrap}>
                <Table size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Row</TableHeaderCell>
                    <TableHeaderCell>Column</TableHeaderCell>
                    <TableHeaderCell>Error</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {rowColErrors.map((e, i) => (
                      <TableRow key={i}>
                        <TableCell>{e.row}</TableCell>
                        <TableCell><code>{e.column}</code></TableCell>
                        <TableCell>{e.error}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {submitErr && (
              <MessageBar intent="error"><MessageBarBody>{submitErr}</MessageBarBody></MessageBar>
            )}

            <div className={s.row}>
              <Button appearance="primary" icon={<ArrowUpload20Regular />} disabled={!canImport} onClick={handleImport}>
                {busy ? 'Importing…' : `Import ${validation?.validRowCount ?? 0} data product(s)`}
              </Button>
            </div>
          </div>
        )}

        {tab === 'monitor' && (
          <div className={s.body}>
            {!jobId && <Caption1>Start an import to monitor its progress here.</Caption1>}

            {gate && (
              <MessageBar intent="warning"><MessageBarBody>
                <MessageBarTitle>CSV not archived to Blob</MessageBarTitle>
                Missing <code>{gate.missing}</code>. {gate.message}
              </MessageBarBody></MessageBar>
            )}

            {jobId && (
              <>
                <div className={s.row}>
                  <Subtitle2>Import job</Subtitle2>
                  <code className={s.mono}>{jobId.slice(0, 8)}…</code>
                  <div className={s.spacer} />
                  <Button
                    size="small" appearance="subtle" icon={<ArrowSync20Regular />}
                    onClick={() => jobId && pollOnce(jobId)}
                  >
                    Refresh
                  </Button>
                </div>
                <Caption1>Auto-refreshes every 5 seconds while running.</Caption1>

                <div className={s.kpis}>
                  <Badge appearance="filled" color={statusColor(job?.status)}>
                    {job?.status ?? (polling ? 'running' : '—')}
                  </Badge>
                  <Caption1>
                    <strong>{job?.successCount ?? 0}</strong> created ·{' '}
                    <strong>{job?.failCount ?? 0}</strong> failed ·{' '}
                    {job?.totalRows ?? 0} total
                  </Caption1>
                  {(job?.status === 'running' || polling) && <Spinner size="extra-tiny" />}
                </div>

                {job && job.totalRows > 0 && (
                  <ProgressBar
                    value={(job.successCount + job.failCount) / job.totalRows}
                    thickness="large"
                  />
                )}

                {monitorErr && (
                  <MessageBar intent="error"><MessageBarBody>{monitorErr}</MessageBarBody></MessageBar>
                )}

                <Subtitle2>Error log ({job?.rowErrors?.length ?? 0})</Subtitle2>
                {(job?.rowErrors?.length ?? 0) === 0 ? (
                  <Caption1>{job?.status === 'running' ? 'No errors yet.' : 'No row errors — all valid rows imported.'}</Caption1>
                ) : (
                  <div className={s.tableWrap}>
                    <Table size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Row</TableHeaderCell>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Error</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(job?.rowErrors || []).map((e, i) => (
                          <TableRow key={i}>
                            <TableCell>{e.row}</TableCell>
                            <TableCell>{e.name || <span className={s.mono}>(blank)</span>}</TableCell>
                            <TableCell>{e.error}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {job && job.status !== 'running' && (
                  <MessageBar intent={job.status === 'failed' ? 'error' : job.status === 'partial' ? 'warning' : 'success'}>
                    <MessageBarBody>
                      <MessageBarTitle>
                        {job.status === 'done' ? 'Import complete' : job.status === 'partial' ? 'Import completed with errors' : 'Import failed'}
                      </MessageBarTitle>
                      Created {job.successCount} of {job.totalRows} data product(s)
                      {job.failCount > 0 ? `; ${job.failCount} row(s) failed (see error log).` : '.'}
                      {job.staged && ' CSV archived to Blob.'}
                    </MessageBarBody>
                  </MessageBar>
                )}

                {polling && (
                  <div className={s.row}>
                    <Button size="small" onClick={() => setPolling(false)}>Stop polling</Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}
