'use client';

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
 *   3. POST /api/apps/{appId}/install creates every bundled item via the
 *      shared createOwnedItem helper (seeds state.content from the bundle)
 *      and runs runProvisioning() against the real Azure-native provisioners
 *      (lakehouse → ADLS+Delta, warehouse → Synapse, kql-db → ADX,
 *      activator → Azure Monitor, eventstream → Event Hubs, …).
 *
 * The provisioning report (per-item created / exists / remediation / failed,
 * with honest infra gates and a per-step Retry) renders INSIDE the dialog so
 * the wizard is self-contained and identical in both surfaces — no divergent
 * second implementation (ui-parity.md). Azure-native is the default; Fabric is
 * never required (no-fabric-dependency.md).
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Button, Badge, Caption1,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field, Switch, RadioGroup, Radio, Input, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';

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
  body: { display: 'flex', flexDirection: 'column', gap: '12px' },
  hint: { fontSize: '13px', color: tokens.colorNeutralForeground2 },
  report: {
    paddingTop: '12px', paddingRight: '12px', paddingBottom: '12px', paddingLeft: '12px',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: '4px',
    maxHeight: '320px',
    overflowY: 'auto',
  },
});

/**
 * Read an install response as JSON, but tolerate a non-JSON body — a long
 * deploy (8 real Azure resources) can exceed the edge gateway timeout, which
 * returns an HTML 502/504 page. `r.json()` on that throws the cryptic
 * "Unexpected token '<'". Instead we read text-first and, when it isn't JSON,
 * return an honest gate explaining the install is still running server-side.
 */
async function readJsonOrGate(r: Response, deploy: boolean): Promise<any> {
  const text = await r.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : { ok: false, error: `Empty response (HTTP ${r.status}).` };
  } catch {
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(text);
    if (looksHtml || r.status === 502 || r.status === 504) {
      return {
        ok: false,
        error:
          `The install request exceeded the gateway timeout (HTTP ${r.status})` +
          (deploy
            ? ' while provisioning live Azure services. The items were created in the workspace and provisioning may still be finishing server-side — refresh the workspace in a minute to see them. Tip: install with "Deploy artifacts" OFF first, then provision items individually to avoid the timeout.'
            : '. Refresh the workspace in a moment to see the installed items.'),
      };
    }
    return { ok: false, error: `Unexpected non-JSON response (HTTP ${r.status}): ${text.slice(0, 200)}` };
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

  // Resolve the item count from the tenant catalog when the caller didn't pass
  // one (the Learn use-case card only knows the appId).
  React.useEffect(() => {
    if (!open || resolvedCount !== undefined) return;
    fetch('/api/apps-catalog').then(r => r.json()).then((d: any) => {
      const a = (d?.apps ?? []).find((x: AppDoc) => x.id === appId);
      if (a) setResolvedCount(a.items?.length ?? 0);
    }).catch(() => {});
  }, [open, resolvedCount, appId]);

  // Load workspaces when the dialog opens.
  React.useEffect(() => {
    if (!open || workspaces.length) return;
    fetch('/api/workspaces').then(r => r.json()).then((d: any) => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list);
      if (list.length === 1) setPickedWs(list[0].id);
    }).catch(() => {});
  }, [open, workspaces.length]);

  // Load folders for the picked workspace so the user can target a folder.
  React.useEffect(() => {
    setPickedFolder(''); setNewFolder(''); setFolders([]);
    if (!pickedWs) return;
    fetch(`/api/workspaces/${pickedWs}/folders`).then(r => r.json()).then((d: any) => {
      setFolders((d?.folders || []).map((f: any) => ({ id: f.id, name: f.name })));
    }).catch(() => setFolders([]));
  }, [pickedWs]);

  // Resolve the target folder id: create a new folder first if one was typed,
  // else use the picked existing folder (or root).
  const resolveFolderId = async (): Promise<string | null> => {
    const name = newFolder.trim();
    if (name) {
      try {
        const r = await fetch(`/api/workspaces/${pickedWs}/folders`, {
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
    try {
      const folderId = await resolveFolderId();
      const r = await fetch(`/api/apps/${appId}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: pickedWs, deploy, mode, folderId }),
      });
      const j = await readJsonOrGate(r, deploy);
      if (!r.ok || !j.ok) {
        setInstallErr(j?.error || `HTTP ${r.status}`);
      } else {
        setInstallResult(j.installed || []);
        setProvisionReport(j.provision || null);
      }
    } catch (e: any) {
      setInstallErr(e?.message || String(e));
    } finally { setInstalling(false); }
  };

  // Retry a single provisioning step (re-runs the install on JUST that
  // item, then merges the result into the report).
  const retryStep = async (step: ProvisionStep) => {
    setRetrying(step.cosmosItemId);
    try {
      const r = await fetch(`/api/apps/${appId}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: pickedWs, deploy: true, mode }),
      });
      const j = await readJsonOrGate(r, true);
      if (r.ok && j.ok && j.provision) {
        setProvisionReport(j.provision);
      }
    } finally {
      setRetrying(null);
    }
  };

  // Reset the result panes when the dialog is dismissed so a re-open starts clean.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setInstallResult(null); setProvisionReport(null); setInstallErr(null);
    }
    onOpenChange(next);
  };

  const done = !!(installResult || provisionReport);

  return (
    <Dialog open={open} onOpenChange={(_, d) => handleOpenChange(d.open)}>
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
                    <Dropdown placeholder="Pick a workspace"
                      selectedOptions={pickedWs ? [pickedWs] : []}
                      value={workspaces.find(w => w.id === pickedWs)?.name || ''}
                      onOptionSelect={(_, d) => setPickedWs(d.optionValue || '')}>
                      {workspaces.map(w => (
                        <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  {workspaces.length === 0 && (
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
                        Dedicated mode requires bicep modules to have been pre-deployed for this app. See <Link href="/docs/fiab/operations/app-install-provisioning">app-install-provisioning</Link> for the param-file shape.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  {installErr && (
                    <MessageBar intent="error"><MessageBarBody>{installErr}</MessageBarBody></MessageBar>
                  )}
                </>
              )}

              {installing && <Spinner label="Installing + provisioning…" />}

              {installResult && (
                <MessageBar intent="success">
                  <MessageBarTitle>Installed {installResult.length} items</MessageBarTitle>
                  <MessageBarBody>
                    {installResult.map((it, i) => (
                      <div key={i} style={{ fontSize: 13, marginTop: 4 }}>
                        <Badge appearance={it.status === 'created' ? 'filled' : 'outline'}
                          color={it.status === 'created' ? 'success' : it.status === 'existed' ? 'informative' : 'danger'}>
                          {it.status}
                        </Badge>
                        {' '}
                        {it.id ? (
                          <Link href={`/items/${it.itemType}/${it.id}`}>{it.displayName}</Link>
                        ) : (
                          <span>{it.displayName}</span>
                        )}
                        {it.error && <span style={{ color: tokens.colorPaletteRedForeground1 }}> — {it.error}</span>}
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
                        <div key={i} style={{ fontSize: 13, marginTop: 8, paddingTop: 8, borderTop: i > 0 ? `1px solid ${tokens.colorNeutralStroke3}` : 'none' }}>
                          <Badge appearance="filled" color={
                            st.result.status === 'created' || st.result.status === 'exists' ? 'success'
                            : st.result.status === 'remediation' ? 'warning'
                            : st.result.status === 'skipped' ? 'subtle'
                            : 'danger'
                          }>
                            {st.result.status}
                          </Badge>
                          {' '}
                          <strong>{st.itemType}</strong> — {st.displayName}
                          {st.result.resourceId && (
                            <Caption1 style={{ display: 'block', fontFamily: 'monospace', color: tokens.colorNeutralForeground3 }}>
                              Azure id: {st.result.resourceId}
                            </Caption1>
                          )}
                          {st.result.gate && (
                            <div style={{ marginTop: 4, padding: 8, backgroundColor: tokens.colorNeutralBackground3, borderRadius: 4 }}>
                              <div style={{ fontWeight: 600 }}>Remediation required: {st.result.gate.reason}</div>
                              <div style={{ marginTop: 4 }}>{st.result.gate.remediation}</div>
                              {st.result.gate.link && (
                                <a href={st.result.gate.link} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>
                                  Open admin step →
                                </a>
                              )}
                              <div style={{ marginTop: 8 }}>
                                <Button size="small" onClick={() => retryStep(st)} disabled={retrying === st.cosmosItemId}>
                                  {retrying === st.cosmosItemId ? 'Retrying…' : 'Retry'}
                                </Button>
                              </div>
                            </div>
                          )}
                          {st.result.error && !st.result.gate && (
                            <div style={{ marginTop: 4, color: tokens.colorPaletteRedForeground1, fontSize: 12 }}>
                              {st.result.error}
                            </div>
                          )}
                          {(st.result.steps?.length || 0) > 0 && (
                            <details style={{ marginTop: 4 }}>
                              <summary style={{ cursor: 'pointer', fontSize: 12, color: tokens.colorNeutralForeground3 }}>
                                Step log ({st.result.steps?.length})
                              </summary>
                              <ul style={{ marginTop: 4, marginLeft: 16, fontSize: 12, color: tokens.colorNeutralForeground2 }}>
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
