'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * InstallAppDialog — the shared "install a content-bundle app" wizard.
 *
 * One implementation, used by BOTH surfaces that can install an app:
 *   • /apps/[id]            — the app detail page's "Install into workspace".
 *   • /learn (use-case card) — "Install live example" on an appId-bearing
 *                              use case.
 *
 * The dialog drives the REAL install → provision → seed flow end to end:
 *   1. user picks a workspace (+ optional folder),
 *   2. chooses whether to deploy artifacts to live Azure services,
 *   3. POST /api/apps/{appId}/install returns 202 { jobId }; the install runs
 *      async server-side (item creation via the shared createOwnedItem helper +
 *      runProvisioning() against the real Azure-native provisioners — lakehouse
 *      → ADLS+Delta, warehouse → Synapse, kql-db → ADX, activator → Azure
 *      Monitor, eventstream → Event Hubs, …). The dialog polls
 *      /api/apps/install-jobs/{jobId} every 5s (via the module-scope jobs-store,
 *      so a long provision survives the dialog closing / tab switching — a
 *      backgrounded install raises a Fluent toast naming the app on completion).
 *
 * The provisioning report (per-item created / exists / remediation / failed,
 * with honest infra gates and a per-step Retry) renders INSIDE the dialog so
 * the wizard is self-contained and identical in both surfaces — no divergent
 * second implementation (ui-parity.md). Azure-native is the default; Fabric is
 * never required (no-fabric-dependency.md).
 */

import * as React from 'react';
import Link from 'next/link';
import { loomDocUrl } from '@/lib/learn/content';
import {
  Button, Badge, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field, Switch, RadioGroup, Radio, Input, ProgressBar, Spinner,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import { useJobsStore } from '@/lib/state/jobs-store';

interface AppItemRef { type: string; template?: string; displayName?: string; }
interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
  items?: AppItemRef[];
}
interface WorkspaceLite { id: string; name: string; }
interface InstallResult { itemType: string; id?: string; displayName: string; status: string; error?: string; }
interface ProvisionStep {
  itemType: string;
  displayName: string;
  cosmosItemId: string;
  result: {
    status: 'created' | 'exists' | 'skipped' | 'remediation' | 'failed';
    resourceId?: string;
    secondaryIds?: Record<string, string>;
    error?: string;
    gate?: { reason: string; remediation: string; link?: string };
    steps?: string[];
  };
}
interface ProvisionReport {
  outcome: 'all-created' | 'partial' | 'all-remediation' | 'skipped';
  mode: 'shared' | 'dedicated';
  steps: ProvisionStep[];
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  hint: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  report: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: tokens.spacingVerticalXXS,
    maxHeight: '320px',
    overflowY: 'auto',
  },
  // Async install progress block.
  progress: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS },
  progressHint: { color: tokens.colorNeutralForeground3 },
  // Installed-items result rows.
  resultRow: {
    display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalXXS,
  },
  resultErr: { color: tokens.colorPaletteRedForeground1 },
  // Provisioning-report per-step blocks.
  step: {
    fontSize: tokens.fontSizeBase200,
    marginTop: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
  },
  stepDivider: { borderTop: `1px solid ${tokens.colorNeutralStroke3}` },
  stepHead: {
    display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, flexWrap: 'wrap',
  },
  resourceId: { display: 'block', fontFamily: 'monospace', color: tokens.colorNeutralForeground3 },
  gate: {
    marginTop: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall,
  },
  gateTitle: { fontWeight: tokens.fontWeightSemibold },
  gateBody: { marginTop: tokens.spacingVerticalXS },
  gateLink: { display: 'inline-block', marginTop: tokens.spacingVerticalXS },
  gateRetry: { marginTop: tokens.spacingVerticalS },
  stepErr: {
    marginTop: tokens.spacingVerticalXS, color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase100,
  },
  stepLog: { marginTop: tokens.spacingVerticalXS },
  stepLogSummary: {
    cursor: 'pointer', fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3,
  },
  stepLogList: {
    marginTop: tokens.spacingVerticalXS, marginLeft: tokens.spacingHorizontalL,
    fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground2,
  },
});

/**
 * Map the server job's coarse phase to a human progress label. The install runs
 * async (202 + poll) so the gateway-timeout band-aid is gone — we show real
 * forward progress instead.
 */
function phaseLabel(phase?: string): string {
  switch (phase) {
    case 'creating-items': return 'Creating workspace items';
    case 'provisioning': return 'Provisioning live Azure services';
    case 'finalizing': return 'Finalizing';
    case 'done': return 'Done';
    default: return 'Installing';
  }
}

export interface InstallAppDialogProps {
  appId: string;
  appName: string;
  /** Item count for the "creates N items" hint. When omitted, the dialog
   *  resolves it from /api/apps-catalog when opened. */
  itemCount?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The shared install wizard. Renders nothing until `open` is true. The caller
 * owns the trigger (a Button) and the open state.
 */
export function InstallAppDialog({
  appId, appName, itemCount, open, onOpenChange,
}: InstallAppDialogProps): React.ReactElement {
  const s = useStyles();

  const [resolvedCount, setResolvedCount] = React.useState<number | undefined>(itemCount);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceLite[]>([]);
  const [pickedWs, setPickedWs] = React.useState<string>('');
  const [folders, setFolders] = React.useState<Array<{ id: string; name: string }>>([]);
  const [pickedFolder, setPickedFolder] = React.useState<string>('');
  const [newFolder, setNewFolder] = React.useState<string>('');
  const [installing, setInstalling] = React.useState(false);
  const [installResult, setInstallResult] = React.useState<InstallResult[] | null>(null);
  const [installErr, setInstallErr] = React.useState<string | null>(null);
  const [deploy, setDeploy] = React.useState(true);
  const [mode, setMode] = React.useState<'shared' | 'dedicated'>('shared');
  const [provisionReport, setProvisionReport] = React.useState<ProvisionReport | null>(null);
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);
  const [wsLoading, setWsLoading] = React.useState(false);

  // Module-scope async-install kickoff + poll (task-019). Owning the poll in the
  // jobs-store means a long provision survives the dialog closing / tab nav and
  // raises a completion toast naming the app. The dialog selects its active job
  // to render live percentComplete.
  const startInstall = useJobsStore((st) => st.startInstall);
  const activeJob = useJobsStore((st) => st.jobs.find((j) => j.id === activeJobId) || null);

  // Resolve the item count from the tenant catalog when the caller didn't pass
  // one (the Learn use-case card only knows the appId).
  React.useEffect(() => {
    if (!open || resolvedCount !== undefined) return;
    clientFetch('/api/apps-catalog').then(r => r.json()).then((d: any) => {
      const a = (d?.apps ?? []).find((x: AppDoc) => x.id === appId);
      if (a) setResolvedCount(a.items?.length ?? 0);
    }).catch(() => {});
  }, [open, resolvedCount, appId]);

  // Load workspaces when the dialog opens. Track loading so the picker shows a
  // "Loading…" hint instead of the misleading "no workspaces yet" message
  // during the (sometimes multi-second) /api/workspaces fetch.
  React.useEffect(() => {
    if (!open || workspaces.length) return;
    setWsLoading(true);
    clientFetch('/api/workspaces').then(r => r.json()).then((d: any) => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list);
      if (list.length === 1) setPickedWs(list[0].id);
    }).catch(() => {}).finally(() => setWsLoading(false));
  }, [open, workspaces.length]);

  // Load folders for the picked workspace so the user can target a folder.
  React.useEffect(() => {
    setPickedFolder(''); setNewFolder(''); setFolders([]);
    if (!pickedWs) return;
    clientFetch(`/api/workspaces/${pickedWs}/folders`).then(r => r.json()).then((d: any) => {
      setFolders((d?.folders || []).map((f: any) => ({ id: f.id, name: f.name })));
    }).catch(() => setFolders([]));
  }, [pickedWs]);

  // Resolve the target folder id: create a new folder first if one was typed,
  // else use the picked existing folder (or root).
  const resolveFolderId = async (): Promise<string | null> => {
    const name = newFolder.trim();
    if (name) {
      try {
        const r = await clientFetch(`/api/workspaces/${pickedWs}/folders`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const j = await r.json();
        if (r.ok && j?.folder?.id) return j.folder.id;
      } catch { /* fall through to root */ }
    }
    return pickedFolder || null;
  };

  const install = async () => {
    if (!pickedWs) return;
    setInstalling(true); setInstallErr(null); setInstallResult(null); setProvisionReport(null);
    const folderId = await resolveFolderId();
    // Kick off the async install via the jobs-store; it POSTs (202 { jobId }) and
    // owns the 5s poll. onDone fires on terminal status whether or not the dialog
    // is still mounted.
    const localId = startInstall({
      appId, appName, workspaceId: pickedWs, deploy, mode, folderId,
      onDone: (r) => {
        setInstalling(false);
        if (!r.ok && r.error) { setInstallErr(r.error); return; }
        setInstallResult((r.installed as InstallResult[]) || []);
        setProvisionReport((r.provision as ProvisionReport) || null);
      },
    });
    setActiveJobId(localId);
  };

  // Retry: re-run the full async install. It is idempotent — items matching
  // name+type are skipped (status 'existed') and only remediation/failed items
  // re-provision against the real backend — so a single re-run resolves the
  // remediation step that prompted the Retry.
  const retryStep = (step: ProvisionStep) => {
    if (!pickedWs) return;
    setRetrying(step.cosmosItemId);
    const localId = startInstall({
      appId, appName, workspaceId: pickedWs, deploy: true, mode, folderId: null,
      onDone: (r) => {
        setRetrying(null);
        if (r.installed) setInstallResult(r.installed as InstallResult[]);
        if (r.provision) setProvisionReport(r.provision as ProvisionReport);
      },
    });
    setActiveJobId(localId);
  };

  // Reset the result panes when the dialog is dismissed so a re-open starts
  // clean. The async install job keeps running server-side regardless — its
  // completion toast (raised by the global job toaster) names the app.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setInstallResult(null); setProvisionReport(null); setInstallErr(null);
      setActiveJobId(null);
    }
    onOpenChange(next);
  };

  const done = !!(installResult || provisionReport);

  // inertTrapFocus: use the native HTML-dialog `inert`-the-background focus trap
  // instead of Tabster's aria-hidden modalizer. On Fluent 9.73 + react-tabster
  // 9.26 under React 19 the modalizer inverted and applied aria-hidden to the
  // ACTIVE DialogSurface itself (Section 508 break + the surface drops out of the
  // a11y tree, which is why Playwright's role engine couldn't find the dialog and
  // all 27 use-case-app UAT tests failed at `getByRole('dialog')`). `inert` on the
  // background is the correct modal behavior and keeps the surface accessible. rel-T09b.
  return (
    <Dialog open={open} inertTrapFocus onOpenChange={(_, d) => handleOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Install {appName}</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {!done && (
                <>
                  <div className={s.hint}>
                    Creates {resolvedCount ?? '…'} items in the chosen workspace.
                    Items with matching name + type are skipped (idempotent).
                  </div>
                  <Field label="Workspace" required>
                    <Dropdown placeholder={wsLoading ? 'Loading workspaces…' : 'Pick a workspace'}
                      disabled={wsLoading}
                      selectedOptions={pickedWs ? [pickedWs] : []}
                      value={workspaces.find(w => w.id === pickedWs)?.name || ''}
                      onOptionSelect={(_, d) => setPickedWs(d.optionValue || '')}>
                      {workspaces.map(w => (
                        <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  {wsLoading && (
                    <div className={s.hint}><Spinner size="tiny" label="Loading your workspaces…" labelPosition="after" /></div>
                  )}
                  {!wsLoading && workspaces.length === 0 && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        You don't have any workspaces yet. Create one at <Link href="/workspaces">/workspaces</Link> first.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {pickedWs && (
                    <Field label="Install location" hint="Install all items into the workspace root, or into a folder inside it.">
                      <Dropdown
                        value={newFolder.trim()
                          ? `New folder: ${newFolder.trim()}`
                          : (pickedFolder ? (folders.find(f => f.id === pickedFolder)?.name || 'Folder') : 'Workspace root')}
                        selectedOptions={[newFolder.trim() ? '__new__' : pickedFolder || '__root__']}
                        onOptionSelect={(_, d) => {
                          if (d.optionValue === '__new__') return; // handled by the input below
                          setNewFolder('');
                          setPickedFolder(d.optionValue === '__root__' ? '' : (d.optionValue || ''));
                        }}
                      >
                        <Option value="__root__">Workspace root</Option>
                        {folders.map(f => <Option key={f.id} value={f.id}>{f.name}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {pickedWs && (
                    <Field label="…or create a new folder" hint="Leave blank to use the selection above. If set, the folder is created and all items install into it.">
                      <Input
                        placeholder="e.g. Real-Time Analytics"
                        value={newFolder}
                        onChange={(_, d) => setNewFolder(d.value)}
                      />
                    </Field>
                  )}
                  <Field label="Deploy artifacts to live Azure services" hint="When ON, every Notebook / Lakehouse / KQL DB / Warehouse / AI Search Index / Activator rule / Pipeline / Eventstream / Semantic Model in the bundle is provisioned via real ADX / Synapse / Event Hubs / Azure Monitor / AI Search REST. Turn OFF to keep the install Cosmos-only (templates without backend resources).">
                    <Switch checked={deploy} onChange={(_e, d) => setDeploy(!!d.checked)} label={deploy ? 'On (recommended)' : 'Off (Cosmos-only)'} />
                  </Field>
                  {deploy && (
                    <Field label="Compute" hint="Shared uses your existing tenant resources; Dedicated provisions an isolated set (requires admin-pre-provisioned bicep deltas).">
                      <RadioGroup value={mode} onChange={(_e, d) => setMode(d.value as 'shared' | 'dedicated')}>
                        <Radio value="shared" label="Shared (use existing tenant ADX / Synapse / Event Hubs / AI Search)" />
                        <Radio value="dedicated" label="Dedicated (provision a new isolated cluster + storage)" />
                      </RadioGroup>
                    </Field>
                  )}
                  {deploy && mode === 'dedicated' && (
                    <MessageBar intent="info">
                      <MessageBarBody>
                        Dedicated mode requires bicep modules to have been pre-deployed for this app. See <a href={loomDocUrl('fiab/operations/app-install-provisioning')} target="_blank" rel="noreferrer">app-install-provisioning</a> for the param-file shape.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {installErr && (
                    <MessageBar intent="error"><MessageBarBody>{installErr}</MessageBarBody></MessageBar>
                  )}
                </>
              )}

              {installing && (
                <div className={s.progress} data-testid="install-progress">
                  <ProgressBar
                    value={(activeJob?.percentComplete ?? 0) / 100}
                    thickness="large"
                  />
                  <Caption1>
                    {phaseLabel(activeJob?.installPhase)} — {activeJob?.percentComplete ?? 0}%
                    {activeJob?.totalItems ? ` · ${activeJob.totalItems} items` : ''}
                  </Caption1>
                  <Caption1 className={s.progressHint}>
                    Long provisions (ADX, Synapse pools, pipelines) run in the
                    background — you can close this dialog and a toast will name
                    the app when it finishes.
                  </Caption1>
                </div>
              )}

              {installResult && (
                <MessageBar intent="success">
                  <MessageBarTitle>Installed {installResult.length} items</MessageBarTitle>
                  <MessageBarBody>
                    {installResult.map((it, i) => (
                      <div key={i} className={s.resultRow}>
                        <Badge appearance={it.status === 'created' ? 'filled' : 'outline'}
                          color={it.status === 'created' ? 'success' : it.status === 'existed' ? 'informative' : 'danger'}>
                          {it.status}
                        </Badge>
                        {it.id ? (
                          <Link href={`/items/${it.itemType}/${it.id}`}>{it.displayName}</Link>
                        ) : (
                          <span>{it.displayName}</span>
                        )}
                        {it.error && <span className={s.resultErr}> — {it.error}</span>}
                      </div>
                    ))}
                  </MessageBarBody>
                </MessageBar>
              )}

              {provisionReport && (
                <div className={s.report} data-testid="provision-report">
                  <MessageBar
                    intent={provisionReport.outcome === 'all-created' ? 'success'
                      : provisionReport.outcome === 'all-remediation' ? 'warning'
                      : provisionReport.outcome === 'skipped' ? 'info'
                      : 'warning'}
                  >
                    <MessageBarTitle>
                      Provisioning report — {provisionReport.outcome} ({provisionReport.mode} mode)
                    </MessageBarTitle>
                    <MessageBarBody>
                      {provisionReport.steps.map((st, i) => (
                        <div key={i} className={mergeClasses(s.step, i > 0 && s.stepDivider)}>
                          <div className={s.stepHead}>
                            <Badge appearance="filled" color={
                              st.result.status === 'created' || st.result.status === 'exists' ? 'success'
                              : st.result.status === 'remediation' ? 'warning'
                              : st.result.status === 'skipped' ? 'subtle'
                              : 'danger'
                            }>
                              {st.result.status}
                            </Badge>
                            <span><strong>{st.itemType}</strong> — {st.displayName}</span>
                          </div>
                          {st.result.resourceId && (
                            <Caption1 className={s.resourceId}>
                              Azure id: {st.result.resourceId}
                            </Caption1>
                          )}
                          {st.result.gate && (
                            <div className={s.gate}>
                              <div className={s.gateTitle}>Remediation required: {st.result.gate.reason}</div>
                              <div className={s.gateBody}>{st.result.gate.remediation}</div>
                              {st.result.gate.link && (
                                <a href={st.result.gate.link} target="_blank" rel="noreferrer" className={s.gateLink}>
                                  Open admin step →
                                </a>
                              )}
                              <div className={s.gateRetry}>
                                <Button size="small" onClick={() => retryStep(st)} disabled={retrying === st.cosmosItemId}>
                                  {retrying === st.cosmosItemId ? 'Retrying…' : 'Retry'}
                                </Button>
                              </div>
                            </div>
                          )}
                          {st.result.error && !st.result.gate && (
                            <div className={s.stepErr}>
                              {st.result.error}
                            </div>
                          )}
                          {(st.result.steps?.length || 0) > 0 && (
                            <details className={s.stepLog}>
                              <summary className={s.stepLogSummary}>
                                Step log ({st.result.steps?.length})
                              </summary>
                              <ul className={s.stepLogList}>
                                {st.result.steps?.map((line, ix) => <li key={ix}>{line}</li>)}
                              </ul>
                            </details>
                          )}
                        </div>
                      ))}
                    </MessageBarBody>
                  </MessageBar>
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {done ? (
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary">Done</Button>
              </DialogTrigger>
            ) : (
              <>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button appearance="primary" onClick={install}
                  disabled={!pickedWs || installing}>
                  {installing ? 'Installing…' : 'Install'}
                </Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default InstallAppDialog;
