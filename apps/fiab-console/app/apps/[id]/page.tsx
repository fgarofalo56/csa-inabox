'use client';

/**
 * /apps/[id] — App detail page. Reads /api/apps-catalog and finds the
 * matching app, then renders its description + bundled item templates.
 *
 * **Install** button: picks a workspace and POSTs /api/apps/[id]/install
 * which creates every bundled item in the chosen workspace via the
 * shared createOwnedItem helper. Idempotent — items with the same
 * displayName + itemType already in the workspace are skipped.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field, Switch, RadioGroup, Radio, Caption1, Input,
} from '@fluentui/react-components';
import { ArrowLeft24Regular, Add24Regular, AppGeneric24Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';

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
  meta: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' },
  desc: { fontSize: '14px', lineHeight: 1.6, marginBottom: '20px', color: tokens.colorNeutralForeground2 },
  toolbar: { display: 'flex', gap: '12px', marginBottom: '20px', alignItems: 'center', flexWrap: 'wrap' },
  items: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
  itemCard: {
    paddingTop: '14px', paddingRight: '14px', paddingBottom: '14px', paddingLeft: '14px',
    borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    display: 'flex', flexDirection: 'column', gap: '4px',
    ':hover': { borderColor: tokens.colorBrandStroke1 },
  },
  itemType: { fontSize: '13px', fontWeight: 600 },
  itemTpl: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  installResult: {
    paddingTop: '12px', paddingRight: '12px', paddingBottom: '12px', paddingLeft: '12px',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: '16px',
  },
});

export default function AppDetailPage() {
  const styles = useStyles();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [app, setApp] = useState<AppDoc | null | 'notfound'>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [pickedWs, setPickedWs] = useState<string>('');
  // Install target folder inside the workspace ('' = workspace root).
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [pickedFolder, setPickedFolder] = useState<string>('');
  const [newFolder, setNewFolder] = useState<string>('');
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<InstallResult[] | null>(null);
  const [installErr, setInstallErr] = useState<string | null>(null);
  // Phase-2 wizard state.
  const [deploy, setDeploy] = useState(true);
  const [mode, setMode] = useState<'shared' | 'dedicated'>('shared');
  const [provisionReport, setProvisionReport] = useState<ProvisionReport | null>(null);
  // Per-step retry state.
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/apps-catalog').then(r => r.json()).then(d => {
      const a = (d?.apps ?? []).find((x: AppDoc) => x.id === params.id);
      setApp(a ?? 'notfound');
    }).catch(() => setApp('notfound'));
  }, [params.id]);

  // Load workspaces when install dialog opens.
  useEffect(() => {
    if (!installOpen || workspaces.length) return;
    fetch('/api/workspaces').then(r => r.json()).then((d: any) => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list);
      if (list.length === 1) setPickedWs(list[0].id);
    }).catch(() => {});
  }, [installOpen, workspaces.length]);

  // Load folders for the picked workspace so the user can target a folder.
  useEffect(() => {
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
      const r = await fetch(`/api/apps/${params.id}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: pickedWs, deploy, mode, folderId }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setInstallErr(j?.error || `HTTP ${r.status}`);
      } else {
        setInstallResult(j.installed || []);
        setProvisionReport(j.provision || null);
        setInstallOpen(false);
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
      const r = await fetch(`/api/apps/${params.id}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: pickedWs, deploy: true, mode }),
      });
      const j = await r.json();
      if (r.ok && j.ok && j.provision) {
        setProvisionReport(j.provision);
      }
    } finally {
      setRetrying(null);
    }
  };

  if (app === null) return <Spinner label="Loading…" />;
  if (app === 'notfound') {
    return (
      <PageShell title="App not found">
        <MessageBar intent="warning">
          <MessageBarBody>No app with id <code>{params.id}</code> in this tenant.</MessageBarBody>
        </MessageBar>
        <div style={{ marginTop: 16 }}>
          <Button icon={<ArrowLeft24Regular />} onClick={() => router.push('/apps')}>
            Back to Apps
          </Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title={app.name}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ArrowLeft24Regular />} appearance="subtle" onClick={() => router.push('/apps')}>
            All apps
          </Button>
          <Button appearance="primary" icon={<AppGeneric24Regular />}
            onClick={() => setInstallOpen(true)}
            disabled={!app.items?.length}>
            Install into workspace
          </Button>
        </div>}>
      <div className={styles.meta}>
        {app.category && <Badge appearance="outline">{app.category}</Badge>}
        {app.publisher && <Badge appearance="outline" color="brand">by {app.publisher}</Badge>}
      </div>
      {app.description && <div className={styles.desc}>{app.description}</div>}

      <h3 style={{ marginBottom: 12 }}>Bundled items ({app.items?.length ?? 0})</h3>
      {(!app.items || app.items.length === 0) ? (
        <div style={{ color: tokens.colorNeutralForeground3, fontSize: 13 }}>
          This app doesn't bundle any items yet.
        </div>
      ) : (
        <div className={styles.items}>
          {app.items.map((it, i) => (
            // v2 validator finding: prefetch={false} kills the RSC payload
            // bursts that the validator caught as "URL auto-rotator" —
            // Next 14 Link prefetches every visible item card on mount,
            // which against /items/<type>/new flooded the network panel
            // and made the page look like it was navigating itself.
            <Link
              key={`${it.type}-${i}`}
              href={`/items/${it.type}/new`}
              className={styles.itemCard}
              prefetch={false}
            >
              <div className={styles.itemType}>{it.type.replace(/-/g, ' ')}</div>
              {it.template && <div className={styles.itemTpl}>template: {it.template}</div>}
            </Link>
          ))}
        </div>
      )}

      {installResult && (
        <div className={styles.installResult}>
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
        </div>
      )}

      {provisionReport && (
        <div className={styles.installResult} data-testid="provision-report">
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
              {provisionReport.steps.map((s, i) => (
                <div key={i} style={{ fontSize: 13, marginTop: 8, paddingTop: 8, borderTop: i > 0 ? `1px solid ${tokens.colorNeutralStroke3}` : 'none' }}>
                  <Badge appearance="filled" color={
                    s.result.status === 'created' || s.result.status === 'exists' ? 'success'
                    : s.result.status === 'remediation' ? 'warning'
                    : s.result.status === 'skipped' ? 'subtle'
                    : 'danger'
                  }>
                    {s.result.status}
                  </Badge>
                  {' '}
                  <strong>{s.itemType}</strong> — {s.displayName}
                  {s.result.resourceId && (
                    <Caption1 style={{ display: 'block', fontFamily: 'monospace', color: tokens.colorNeutralForeground3 }}>
                      Azure id: {s.result.resourceId}
                    </Caption1>
                  )}
                  {s.result.gate && (
                    <div style={{ marginTop: 4, padding: 8, backgroundColor: tokens.colorNeutralBackground3, borderRadius: 4 }}>
                      <div style={{ fontWeight: 600 }}>Remediation required: {s.result.gate.reason}</div>
                      <div style={{ marginTop: 4 }}>{s.result.gate.remediation}</div>
                      {s.result.gate.link && (
                        <a href={s.result.gate.link} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>
                          Open admin step →
                        </a>
                      )}
                      <div style={{ marginTop: 8 }}>
                        <Button size="small" onClick={() => retryStep(s)} disabled={retrying === s.cosmosItemId}>
                          {retrying === s.cosmosItemId ? 'Retrying…' : 'Retry'}
                        </Button>
                      </div>
                    </div>
                  )}
                  {s.result.error && !s.result.gate && (
                    <div style={{ marginTop: 4, color: tokens.colorPaletteRedForeground1, fontSize: 12 }}>
                      {s.result.error}
                    </div>
                  )}
                  {(s.result.steps?.length || 0) > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12, color: tokens.colorNeutralForeground3 }}>
                        Step log ({s.result.steps?.length})
                      </summary>
                      <ul style={{ marginTop: 4, marginLeft: 16, fontSize: 12, color: tokens.colorNeutralForeground2 }}>
                        {s.result.steps?.map((line, ix) => <li key={ix}>{line}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </MessageBarBody>
          </MessageBar>
        </div>
      )}

      <Dialog open={installOpen} onOpenChange={(_, d) => setInstallOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Install {app.name}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 13, color: tokens.colorNeutralForeground2 }}>
                  Creates {app.items?.length ?? 0} items in the chosen workspace.
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
                <Field label="Deploy artifacts to live Azure services" hint="When ON, every Notebook / Lakehouse / KQL DB / Warehouse / AI Search Index / Activator rule / Pipeline / Eventstream / Semantic Model in the bundle is provisioned via real Fabric / ADX / Synapse / AI Search REST. Turn OFF to keep the install Cosmos-only (templates without backend resources).">
                  <Switch checked={deploy} onChange={(_e, d) => setDeploy(!!d.checked)} label={deploy ? 'On (recommended)' : 'Off (Cosmos-only)'} />
                </Field>
                {deploy && (
                  <Field label="Compute" hint="Shared uses your existing tenant resources; Dedicated provisions an isolated set (requires admin-pre-provisioned bicep deltas).">
                    <RadioGroup value={mode} onChange={(_e, d) => setMode(d.value as 'shared' | 'dedicated')}>
                      <Radio value="shared" label="Shared (use existing tenant Fabric / ADX / Synapse / AI Search)" />
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
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={install}
                disabled={!pickedWs || installing}>
                {installing ? 'Installing…' : 'Install'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </PageShell>
  );
}
