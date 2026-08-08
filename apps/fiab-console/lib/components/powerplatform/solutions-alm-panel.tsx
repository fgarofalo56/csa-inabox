'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * SolutionsAlmPanel — in-Loom Power Platform solution ALM (list / export /
 * import / publish / delete).
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/fiab/parity/power-platform.md` row I5 ("Solutions / ALM
 * (managed/unmanaged, import/export)") was an honest ⚠️ whose remediation was
 * "open the maker portal", and the navigator carried a literal
 * "tracked for a follow-up ... Open the maker portal to import/export now" row.
 * `ui-parity.md` explicitly rejects deep-link-as-parity and "tracked for
 * follow-up" tooltips as substitutes for building the surface. This panel is
 * the build: every control calls the real Dataverse Web API through
 * `/api/powerplatform/solutions`.
 *
 * WORKFLOW (matches the maker portal's Solutions grid + import wizard)
 * -------------------------------------------------------------------
 *   Export  — pick a solution, choose Managed/Unmanaged, download the .zip.
 *   Import  — choose a .zip; it is STAGED first (`StageSolution`) so the
 *             operator sees validation findings BEFORE anything is applied,
 *             then imported asynchronously with live progress polling.
 *   Publish — `PublishAllXml`, the step the portal runs after an unmanaged
 *             import so changes become visible.
 *   Delete  — removes the solution.
 *
 * The file never leaves the browser except as the base64 body of the staged
 * import, and the export download is produced client-side from the base64 the
 * API returns — no server-side temp files.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Badge, Spinner, Divider, Switch,
  MessageBar, MessageBarBody, MessageBarTitle, ProgressBar,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Table, TableBody, TableRow, TableCell, TableHeader, TableHeaderCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, ArrowUpload20Regular, ArrowSync20Regular,
  Delete20Regular, CheckmarkCircle20Regular, Warning20Regular,
  BoxMultiple24Regular, CloudArrowUp20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';

export interface DvSolution {
  solutionid: string;
  uniquename: string;
  friendlyname?: string;
  version?: string;
  ismanaged?: boolean;
  installedon?: string;
}

interface StageResult {
  uploadId?: string;
  status?: string;
  validationResults: Array<{ errorCode?: number; message?: string; solutionValidationResultType?: string }>;
}

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  nameCell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0, alignItems: 'center' },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '480px' },
  fileRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  optionStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  progressWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  findings: {
    maxHeight: '220px', overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
  },
  err: { color: tokens.colorPaletteRedForeground1, overflowWrap: 'anywhere' },
  ok: { color: tokens.colorPaletteGreenForeground1, overflowWrap: 'anywhere' },
  hiddenInput: { display: 'none' },
});

/** base64 → Blob download, so the export never needs a server temp file. */
function downloadBase64Zip(fileBase64: string, fileName: string) {
  const bin = atob(fileBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** File → base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read the selected file.'));
    r.onload = () => {
      const s = String(r.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(file);
  });
}

async function callSolutions(envId: string, body: unknown): Promise<any> {
  const r = await clientFetch(`/api/powerplatform/solutions?envId=${encodeURIComponent(envId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j;
}

export function SolutionsAlmPanel({ envId }: { envId?: string }) {
  const s = useStyles();
  const [solutions, setSolutions] = useState<DvSolution[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<{ error: string; hint?: string } | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Import wizard state
  const [importOpen, setImportOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [staging, setStaging] = useState(false);
  const [stage, setStage] = useState<StageResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; status?: string; error?: string } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [publishWorkflows, setPublishWorkflows] = useState(true);
  const [holding, setHolding] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!envId) { setSolutions(null); return; }
    setLoading(true); setGate(null);
    try {
      const r = await clientFetch(`/api/powerplatform/solutions?envId=${encodeURIComponent(envId)}`, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setGate({ error: j?.error || `Failed to list solutions (${r.status})`, hint: j?.hint }); setSolutions(null); }
      else setSolutions(Array.isArray(j.solutions) ? j.solutions : []);
    } catch (e: any) {
      setGate({ error: e?.message || String(e) });
      setSolutions(null);
    } finally { setLoading(false); }
  }, [envId]);

  useEffect(() => { void load(); }, [load]);
  // Stop polling when the panel unmounts so a closed dialog cannot keep firing.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const doExport = useCallback(async (sol: DvSolution, managed: boolean) => {
    if (!envId) return;
    const key = `${sol.solutionid}:${managed ? 'm' : 'u'}`;
    setBusy((b) => ({ ...b, [key]: 'working' })); setNotice(null);
    try {
      const j = await callSolutions(envId, { action: 'export', uniqueName: sol.uniquename, managed });
      downloadBase64Zip(j.fileBase64, j.fileName || `${sol.uniquename}.zip`);
      setNotice({ kind: 'ok', text: `Exported ${sol.uniquename} (${managed ? 'managed' : 'unmanaged'}).` });
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message || String(e) });
    } finally { setBusy((b) => { const n = { ...b }; delete n[key]; return n; }); }
  }, [envId]);

  const doDelete = useCallback(async (sol: DvSolution) => {
    if (!envId) return;
    setBusy((b) => ({ ...b, [sol.solutionid]: 'deleting' })); setNotice(null);
    try {
      const r = await clientFetch(
        `/api/powerplatform/solutions?envId=${encodeURIComponent(envId)}&solutionId=${encodeURIComponent(sol.solutionid)}`,
        { method: 'DELETE' },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || `Delete failed (${r.status})`);
      setNotice({ kind: 'ok', text: `Deleted ${sol.uniquename}.` });
      await load();
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message || String(e) });
    } finally { setBusy((b) => { const n = { ...b }; delete n[sol.solutionid]; return n; }); }
  }, [envId, load]);

  const doPublish = useCallback(async () => {
    if (!envId) return;
    setBusy((b) => ({ ...b, __publish: 'working' })); setNotice(null);
    try {
      await callSolutions(envId, { action: 'publish' });
      setNotice({ kind: 'ok', text: 'Published all customizations.' });
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message || String(e) });
    } finally { setBusy((b) => { const n = { ...b }; delete n.__publish; return n; }); }
  }, [envId]);

  /** Step 1 of import: stage + validate, so findings surface before anything applies. */
  const doStage = useCallback(async () => {
    if (!envId || !file) return;
    setStaging(true); setStage(null); setProgress(null); setNotice(null);
    try {
      const fileBase64 = await fileToBase64(file);
      const j = await callSolutions(envId, { action: 'stage', fileBase64 });
      setStage({ uploadId: j.uploadId, status: j.status, validationResults: j.validationResults || [] });
    } catch (e: any) {
      setNotice({ kind: 'err', text: e?.message || String(e) });
    } finally { setStaging(false); }
  }, [envId, file]);

  /** Step 2: import the staged solution and poll real progress until terminal. */
  const doImport = useCallback(async () => {
    if (!envId || !stage?.uploadId) return;
    setImporting(true); setProgress({ pct: 0 }); setNotice(null);
    try {
      const job = await callSolutions(envId, {
        action: 'import',
        stageSolutionUploadId: stage.uploadId,
        overwriteUnmanagedCustomizations: overwrite,
        publishWorkflows,
        importAsHoldingSolution: holding,
      });
      if (!job.importJobId) throw new Error('Dataverse accepted the import but returned no job id to track.');
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const st = await callSolutions(envId, {
            action: 'import-status', importJobId: job.importJobId, asyncOperationId: job.asyncOperationId,
          });
          setProgress({ pct: Math.max(0, Math.min(100, st.progress || 0)), status: st.status, error: st.error });
          const terminal = st.error || st.status === 'Succeeded' || st.status === 'Failed' || st.status === 'Canceled';
          if (terminal) {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            setImporting(false);
            if (st.error || st.status === 'Failed') {
              setNotice({ kind: 'err', text: st.error || 'The solution import failed.' });
            } else if (st.status === 'Succeeded') {
              setNotice({ kind: 'ok', text: 'Solution imported.' });
              setImportOpen(false);
              void load();
            }
          }
        } catch (e: any) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setImporting(false);
          setNotice({ kind: 'err', text: e?.message || String(e) });
        }
      }, 4000);
    } catch (e: any) {
      setImporting(false);
      setNotice({ kind: 'err', text: e?.message || String(e) });
    }
  }, [envId, stage, overwrite, publishWorkflows, holding, load]);

  if (!envId) {
    return (
      <EmptyState
        icon={<BoxMultiple24Regular />}
        title="Pick an environment"
        body="Select a Power Platform environment to manage its solutions — export a managed or unmanaged .zip, import one with validation, publish customizations, or delete a solution."
      />
    );
  }

  const blockingFindings = (stage?.validationResults || []).filter(
    (v) => (v.solutionValidationResultType || '').toLowerCase() !== 'warning',
  );

  return (
    <div className={s.wrap}>
      <div className={s.head}>
        <Subtitle2>Solutions</Subtitle2>
        <Badge appearance="tint" color="brand">Dataverse ALM</Badge>
        <div className={s.spacer} />
        <div className={s.actions}>
          <Button icon={<ArrowSync20Regular />} appearance="secondary" onClick={() => void load()} disabled={loading}>Reload</Button>
          <Button icon={<CloudArrowUp20Regular />} appearance="secondary" onClick={() => void doPublish()} disabled={!!busy.__publish}>
            {busy.__publish ? 'Publishing…' : 'Publish all'}
          </Button>
          <Button icon={<ArrowUpload20Regular />} appearance="primary"
            onClick={() => { setImportOpen(true); setFile(null); setStage(null); setProgress(null); }}>
            Import solution
          </Button>
        </div>
      </div>

      <Caption1>
        Export produces the same managed / unmanaged .zip the maker portal does. Import stages the
        solution first so validation findings appear before anything is applied, then runs the
        asynchronous import with live progress. All calls are the real Dataverse Web API.
      </Caption1>

      {notice && (
        <MessageBar intent={notice.kind === 'ok' ? 'success' : 'error'} layout="multiline">
          <MessageBarBody>{notice.text}</MessageBarBody>
        </MessageBar>
      )}

      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Solutions unavailable</MessageBarTitle>
            {gate.error}{gate.hint ? ` — ${gate.hint}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && <Spinner size="small" label="Loading solutions…" labelPosition="after" />}

      {!loading && !gate && solutions && solutions.length === 0 && (
        <EmptyState
          icon={<BoxMultiple24Regular />}
          title="No solutions in this environment"
          body="This Dataverse environment has no solutions yet. Import one to bring in components from another environment."
          primaryAction={{ label: 'Import solution', appearance: 'primary', onClick: () => setImportOpen(true) }}
        />
      )}

      {!loading && !gate && solutions && solutions.length > 0 && (
        <Table size="small" aria-label="Dataverse solutions">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Solution</TableHeaderCell>
              <TableHeaderCell>Version</TableHeaderCell>
              <TableHeaderCell>Installed</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {solutions.map((sol) => {
              const mBusy = busy[`${sol.solutionid}:m`];
              const uBusy = busy[`${sol.solutionid}:u`];
              const dBusy = busy[sol.solutionid];
              return (
                <TableRow key={sol.solutionid}>
                  <TableCell>
                    <div className={s.nameCell}>
                      <Body1 className={s.truncate}>{sol.friendlyname || sol.uniquename}</Body1>
                      <div className={s.badgeRow}>
                        <Caption1 className={s.truncate}>{sol.uniquename}</Caption1>
                        <Badge size="small" appearance="tint" color={sol.ismanaged ? 'informative' : 'brand'}>
                          {sol.ismanaged ? 'Managed' : 'Unmanaged'}
                        </Badge>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Caption1>{sol.version || '—'}</Caption1></TableCell>
                  <TableCell><Caption1>{sol.installedon ? new Date(sol.installedon).toLocaleDateString() : '—'}</Caption1></TableCell>
                  <TableCell>
                    <div className={s.rowActions}>
                      <Button size="small" icon={<ArrowDownload20Regular />} disabled={!!uBusy}
                        onClick={() => void doExport(sol, false)}>
                        {uBusy ? '…' : 'Unmanaged'}
                      </Button>
                      <Button size="small" icon={<ArrowDownload20Regular />} disabled={!!mBusy}
                        onClick={() => void doExport(sol, true)}>
                        {mBusy ? '…' : 'Managed'}
                      </Button>
                      <Button size="small" icon={<Delete20Regular />} disabled={!!dBusy}
                        onClick={() => void doDelete(sol)}>
                        {dBusy ? '…' : 'Delete'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={importOpen} onOpenChange={(_, d) => { if (!d.open && !importing) setImportOpen(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Import solution</DialogTitle>
            <DialogContent>
              <div className={s.dialogBody}>
                <div className={s.fileRow}>
                  <Button icon={<ArrowUpload20Regular />} appearance="secondary"
                    onClick={() => fileRef.current?.click()} disabled={staging || importing}>
                    Choose .zip
                  </Button>
                  <Caption1>{file ? file.name : 'No file selected'}</Caption1>
                  <input ref={fileRef} type="file" accept=".zip,application/zip" className={s.hiddenInput}
                    onChange={(ev) => { setFile(ev.target.files?.[0] || null); setStage(null); setProgress(null); }} />
                </div>

                <div className={s.optionStack}>
                  <Switch checked={publishWorkflows} disabled={importing}
                    onChange={(_, d) => setPublishWorkflows(!!d.checked)}
                    label="Activate processes and plug-ins after import" />
                  <Switch checked={overwrite} disabled={importing}
                    onChange={(_, d) => setOverwrite(!!d.checked)}
                    label="Overwrite unmanaged customizations" />
                  <Switch checked={holding} disabled={importing}
                    onChange={(_, d) => setHolding(!!d.checked)}
                    label="Import as a holding solution (stage for upgrade)" />
                </div>

                <Divider />

                {!stage && (
                  <Button appearance="primary" icon={<CheckmarkCircle20Regular />}
                    disabled={!file || staging} onClick={() => void doStage()}>
                    {staging ? 'Validating…' : 'Validate solution'}
                  </Button>
                )}

                {stage && (
                  <>
                    <div className={s.badgeRow}>
                      <Badge appearance="tint" color={blockingFindings.length ? 'danger' : 'success'}>
                        {blockingFindings.length ? `${blockingFindings.length} blocking finding(s)` : 'Validation passed'}
                      </Badge>
                      {stage.status && <Caption1>{stage.status}</Caption1>}
                    </div>
                    {stage.validationResults.length > 0 && (
                      <div className={s.findings}>
                        {stage.validationResults.map((v, i) => (
                          <Caption1 key={i} className={(v.solutionValidationResultType || '').toLowerCase() === 'warning' ? undefined : s.err}>
                            {(v.solutionValidationResultType || 'Finding')}{v.errorCode ? ` (${v.errorCode})` : ''}: {v.message || 'no detail'}
                          </Caption1>
                        ))}
                      </div>
                    )}
                    {!stage.uploadId && (
                      <MessageBar intent="warning" layout="multiline">
                        <MessageBarBody>
                          Dataverse staged the file but returned no upload id, so the import cannot proceed from the staged
                          copy. Resolve the findings above and validate again.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </>
                )}

                {progress && (
                  <div className={s.progressWrap}>
                    <ProgressBar value={progress.pct / 100} />
                    <Caption1 className={progress.error ? s.err : undefined}>
                      {progress.error ? progress.error : `${progress.pct}%${progress.status ? ` · ${progress.status}` : ''}`}
                    </Caption1>
                  </div>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={importing} onClick={() => setImportOpen(false)}>Close</Button>
              <Button appearance="primary" icon={<Warning20Regular />}
                disabled={!stage?.uploadId || importing || blockingFindings.length > 0}
                onClick={() => void doImport()}>
                {importing ? 'Importing…' : 'Import'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
