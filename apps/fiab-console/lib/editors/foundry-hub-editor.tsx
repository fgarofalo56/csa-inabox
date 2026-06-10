'use client';

/**
 * Foundry hub editor — fully wired to Azure AI Foundry workspace
 * (Microsoft.MachineLearningServices/workspaces kind=Hub) AND the sibling
 * model-hosting Cognitive Services account (deployments / quota / keys /
 * networking / RBAC / activity). Every tab calls a real BFF route:
 *   GET  /api/foundry/workspace             (hub metadata)
 *   GET  /api/foundry/connections
 *   GET  /api/items/ml-model                (registered models)
 *   GET  /api/foundry/deployments           (online endpoints)
 *   GET  /api/foundry/model-deployments     (AOAI model deployments)  + POST deploy
 *   GET  /api/foundry/models-catalog        (deployable models)
 *   GET  /api/foundry/quota                 (per-region usages)        + POST one-click gpt-4o-mini
 *   GET  /api/foundry/networking            (public access + PE)       + PATCH toggle
 *   GET  /api/foundry/rbac                  (role assignments)
 *   GET  /api/foundry/keys                  (primary/secondary + endpoints)
 *   GET  /api/foundry/activity              (ARM activity feed)
 *   GET  /api/foundry/computes
 *   GET  /api/foundry/datastores
 *   GET  /api/items/ml-experiment           (jobs)
 *
 * Each tab lazy-loads on first activation, surfaces errors / honest infra
 * gates via MessageBar, and refreshes on Reload. No mock data.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Spinner, Button, Input, Switch,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import {
  ModelCatalogPanel, ChatPlaygroundPanel, PlaygroundsLandingPanel,
  ImagesPlaygroundPanel, AudioPlaygroundPanel, SpeechPlaygroundPanel,
  CompletionsPlaygroundPanel, ReasoningPlaygroundPanel, AssistantsPlaygroundPanel,
  RealtimeAudioPlaygroundPanel,
} from './foundry-playground';
import { AzureResourcePicker } from '@/lib/components/azure/azure-resource-picker';
import { FoundryAccountTree } from '@/lib/components/foundry/foundry-tree';
import { FoundryAgentsPanel } from '@/lib/components/foundry/foundry-agents';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, overflowX: 'auto' },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'baseline' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: 12 },
  tableWrap: { overflow: 'auto', maxHeight: 460, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontSize: 12, whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: { padding: 16, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  secret: { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' },
});

type LoadState<T> = { loading: boolean; data: T | null; error?: string; hint?: string; notDeployed?: boolean };

// ---- Selected AI Foundry / Azure OpenAI account (drives every tab) ----
export interface FoundryAccount { id?: string; name: string; endpoint?: string; location?: string; kind?: string; resourceGroup?: string }

/** Append the selected account selector to a URL as `?account=&rg=` (or `&…`). */
function withAccount(url: string, acct: FoundryAccount | null): string {
  if (!acct?.name) return url;
  const sep = url.includes('?') ? '&' : '?';
  const rg = acct.resourceGroup ? `&rg=${encodeURIComponent(acct.resourceGroup)}` : '';
  return `${url}${sep}account=${encodeURIComponent(acct.name)}${rg}`;
}

/** Body fields for the selected account, merged into POST/PATCH payloads. */
function acctBody(acct: FoundryAccount | null): Record<string, string> {
  if (!acct?.name) return {};
  return acct.resourceGroup ? { account: acct.name, rg: acct.resourceGroup } : { account: acct.name };
}

function GateBar({ msg, hint, notDeployed }: { msg: string; hint?: string; notDeployed?: boolean }) {
  return (
    <MessageBar intent={notDeployed ? 'warning' : 'error'}>
      <MessageBarBody>
        <MessageBarTitle>{notDeployed ? 'Infrastructure not provisioned' : 'Foundry error'}</MessageBarTitle>
        {msg}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
      </MessageBarBody>
    </MessageBar>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  const s = useStyles();
  return <div className={s.empty}>{children}</div>;
}

function useLazyFetch<T>(url: string, active: boolean, nonce: number = 0, acct: FoundryAccount | null = null) {
  const [state, setState] = useState<LoadState<T>>({ loading: false, data: null });
  const fullUrl = withAccount(url, acct);
  const reload = useCallback(async () => {
    setState({ loading: true, data: null });
    try {
      const r = await fetch(fullUrl);
      const j = await r.json();
      if (!j.ok) { setState({ loading: false, data: null, error: j.error || `HTTP ${r.status}`, hint: j.hint, notDeployed: j.notDeployed }); return; }
      setState({ loading: false, data: j as unknown as T });
    } catch (e: any) {
      setState({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [fullUrl]);
  useEffect(() => {
    if (nonce > 0) setState({ loading: false, data: null });
  }, [nonce]);
  // Re-fetch when the selected account changes (the resolved URL changes).
  useEffect(() => { setState({ loading: false, data: null }); }, [fullUrl]);
  useEffect(() => {
    if (active && state.data === null && !state.loading && !state.error) reload();
  }, [active, state.data, state.loading, state.error, reload]);
  return [state, reload] as const;
}

// ---------- Tab panels ----------

function OverviewPanel({ nonce, onWorkspace }: { nonce: number; onWorkspace?: (w: any) => void }) {
  const s = useStyles();
  const [ws] = useLazyFetch<{ ok: boolean; workspace: any }>(`/api/foundry/workspace`, true, nonce);
  useEffect(() => { if (ws.data?.workspace && onWorkspace) onWorkspace(ws.data.workspace); }, [ws.data, onWorkspace]);
  if (ws.loading) return <div className={s.pad}><Spinner size="small" label="Loading hub…" labelPosition="after" /></div>;
  if (ws.error) return <div className={s.pad}><GateBar msg={ws.error} hint={ws.hint} notDeployed={ws.notDeployed} /></div>;
  const w = ws.data?.workspace;
  if (!w) return <div className={s.pad}><EmptyText>No workspace data.</EmptyText></div>;
  const rows: [string, React.ReactNode][] = [
    ['Name', w.name],
    ['Friendly name', w.friendlyName || '—'],
    ['Resource group', w.rg],
    ['Location', w.location],
    ['Kind', <Badge appearance="tint" color="brand" key="kind">{w.kind}</Badge>],
    ['Provisioning state', w.provisioningState],
    ['Public network access', w.publicNetworkAccess],
    ['Discovery URL', w.discoveryUrl || '—'],
    ['Storage account', w.storageAccount?.split('/').pop() || '—'],
    ['Key Vault', w.keyVault?.split('/').pop() || '—'],
    ['Container registry', w.containerRegistry?.split('/').pop() || '—'],
    ['Application Insights', w.applicationInsights?.split('/').pop() || '—'],
  ];
  return (
    <div className={s.pad}>
      <Subtitle2>{w.friendlyName || w.name}</Subtitle2>
      {w.description && <Body1>{w.description}</Body1>}
      <div className={s.metaGrid}>
        {rows.map(([k, v]) => (
          <Fragment key={String(k)}>
            <span className={s.metaKey}>{k}</span>
            <span>{v ?? '—'}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ConnectionsPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  // Connections live on the hub workspace, not the CS account — no account selector.
  const [st] = useLazyFetch<{ ok: boolean; connections: any[] }>(`/api/foundry/connections`, active, nonce);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading connections…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /></div>;
  const items = Array.isArray(st.data?.connections) ? st.data!.connections : [];
  if (!items.length) return <div className={s.pad}><EmptyText>No connections registered on this hub yet.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} connection(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Connections" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Category</TableHeaderCell>
            <TableHeaderCell>Auth</TableHeaderCell>
            <TableHeaderCell>Target</TableHeaderCell>
            <TableHeaderCell>Shared</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id || c.name}>
                <TableCell className={s.cell}><strong>{c.name}</strong></TableCell>
                <TableCell className={s.cell}>{c.category || '—'}</TableCell>
                <TableCell className={s.cell}>{c.authType || '—'}</TableCell>
                <TableCell className={s.cell}>{c.target || '—'}</TableCell>
                <TableCell className={s.cell}>{c.isSharedToAll ? 'Yes' : 'No'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---- Models + endpoints: registered models, AOAI deployments + DEPLOY a model ----

interface CatalogModel { name: string; format?: string; version?: string; skus?: string[]; maxCapacity?: number; lifecycleStatus?: string }
interface ModelDeployment { name: string; modelName?: string; modelVersion?: string; skuName?: string; capacity?: number; provisioningState?: string }

function DeployModelDialog({ open, onClose, onDeployed, acct }: { open: boolean; onClose: () => void; onDeployed: () => void; acct: FoundryAccount | null }) {
  const [catalog] = useLazyFetch<{ ok: boolean; models: CatalogModel[] }>(`/api/foundry/models-catalog`, open, 0, acct);
  const [modelName, setModelName] = useState('gpt-4o-mini');
  const [deploymentName, setDeploymentName] = useState('gpt-4o-mini');
  const [skuName, setSkuName] = useState('GlobalStandard');
  const [capacity, setCapacity] = useState('10');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);

  const models = catalog.data?.models || [];
  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/model-deployments', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelName, deploymentName, skuName, capacity: Number(capacity) || 10, ...acctBody(acct) }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Deployment "${j.deployment.name}" → ${j.deployment.provisioningState || 'created'}` });
      onDeployed();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Deploy a model</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {catalog.error && <GateBar msg={catalog.error} hint={catalog.hint} notDeployed={catalog.notDeployed} />}
              <Field label="Model">
                {models.length > 0 ? (
                  <Dropdown
                    value={modelName}
                    selectedOptions={[modelName]}
                    onOptionSelect={(_, d) => { if (d.optionValue) { setModelName(d.optionValue); setDeploymentName(d.optionValue); } }}
                  >
                    {models.map((m) => (
                      <Option key={`${m.name}:${m.version}`} value={m.name}>
                        {`${m.name}${m.version ? ` (v${m.version})` : ''}${m.lifecycleStatus ? ` · ${m.lifecycleStatus}` : ''}`}
                      </Option>
                    ))}
                  </Dropdown>
                ) : (
                  <Input value={modelName} onChange={(_, d) => { setModelName(d.value); setDeploymentName(d.value); }} placeholder="gpt-4o-mini" />
                )}
              </Field>
              <Field label="Deployment name"><Input value={deploymentName} onChange={(_, d) => setDeploymentName(d.value)} /></Field>
              <Field label="SKU">
                <Dropdown value={skuName} selectedOptions={[skuName]} onOptionSelect={(_, d) => d.optionValue && setSkuName(d.optionValue)}>
                  <Option value="GlobalStandard">GlobalStandard</Option>
                  <Option value="Standard">Standard</Option>
                  <Option value="DataZoneStandard">DataZoneStandard</Option>
                  <Option value="ProvisionedManaged">ProvisionedManaged</Option>
                </Dropdown>
              </Field>
              <Field label="Capacity (K TPM)"><Input type="number" value={capacity} onChange={(_, d) => setCapacity(d.value)} /></Field>
              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={busy || !modelName || !deploymentName} onClick={submit}>{busy ? 'Deploying…' : 'Deploy'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ModelsPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [models] = useLazyFetch<{ ok: boolean; models: any[] }>(`/api/items/ml-model`, active, nonce);
  const [dep, reloadDep] = useLazyFetch<{ ok: boolean; account?: any; deployments: ModelDeployment[] }>(`/api/foundry/model-deployments`, active, nonce, acct);
  const [eps] = useLazyFetch<{ ok: boolean; endpoints: any[] }>(`/api/foundry/deployments`, active, nonce);
  const [deployOpen, setDeployOpen] = useState(false);
  // Delete-deployment flow (confirm dialog → real DELETE ARM call).
  const [delTarget, setDelTarget] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delMsg, setDelMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const doDelete = useCallback(async () => {
    if (!delTarget) return;
    setDelBusy(true); setDelMsg(null);
    try {
      const url = withAccount(`/api/foundry/model-deployments?name=${encodeURIComponent(delTarget)}`, acct);
      const r = await fetch(url, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setDelMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setDelMsg({ intent: 'success', text: `Deleted deployment "${delTarget}".` });
      setDelTarget(null);
      reloadDep();
    } catch (e: any) { setDelMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDelBusy(false); }
  }, [delTarget, acct, reloadDep]);
  if (!active) return null;
  const regModels = Array.isArray(models.data?.models) ? models.data!.models : [];
  const deployments = Array.isArray(dep.data?.deployments) ? dep.data!.deployments : [];
  const endpoints = Array.isArray(eps.data?.endpoints) ? eps.data!.endpoints : [];
  return (
    <div className={s.pad}>
      <DeployModelDialog open={deployOpen} onClose={() => setDeployOpen(false)} onDeployed={reloadDep} acct={acct} />
      <Dialog open={!!delTarget} onOpenChange={(_, d) => { if (!d.open) setDelTarget(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete deployment</DialogTitle>
            <DialogContent>
              <Body1>Permanently delete the model deployment <strong>{delTarget}</strong> from this account? Apps calling this deployment name will start returning 404. This issues a real ARM <code>DELETE</code> on the Cognitive Services deployment.</Body1>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDelTarget(null)}>Cancel</Button>
              <Button appearance="primary" disabled={delBusy} onClick={doDelete}>{delBusy ? 'Deleting…' : 'Delete'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <div className={s.toolbar}>
        <Subtitle2>Model deployments</Subtitle2>
        <Button appearance="primary" onClick={() => setDeployOpen(true)}>+ Deploy a model</Button>
        <Button onClick={reloadDep}>Reload</Button>
        {dep.data?.account && <Badge appearance="outline">{dep.data.account.name} · {dep.data.account.location}</Badge>}
      </div>
      {delMsg && <MessageBar intent={delMsg.intent}><MessageBarBody>{delMsg.text}</MessageBarBody></MessageBar>}
      {dep.loading ? <Spinner size="small" /> : dep.error ? <GateBar msg={dep.error} hint={dep.hint} notDeployed={dep.notDeployed} /> : deployments.length === 0 ? (
        <EmptyText>No model deployments yet. Click “Deploy a model”.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Model deployments" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Deployment</TableHeaderCell><TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>SKU</TableHeaderCell>
              <TableHeaderCell>Capacity</TableHeaderCell><TableHeaderCell>State</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {deployments.map((d) => (
                <TableRow key={d.name}>
                  <TableCell className={s.cell}><strong>{d.name}</strong></TableCell>
                  <TableCell className={s.cell}>{d.modelName || '—'}</TableCell>
                  <TableCell className={s.cell}>{d.modelVersion || '—'}</TableCell>
                  <TableCell className={s.cell}>{d.skuName || '—'}</TableCell>
                  <TableCell className={s.cell}>{d.capacity ?? '—'}</TableCell>
                  <TableCell className={s.cell}>{d.provisioningState || '—'}</TableCell>
                  <TableCell className={s.cell}>
                    <Button size="small" appearance="subtle" onClick={() => { setDelMsg(null); setDelTarget(d.name); }}>Delete</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Subtitle2 style={{ marginTop: 12 }}>Online endpoints</Subtitle2>
      {eps.loading ? <Spinner size="small" /> : eps.error ? <GateBar msg={eps.error} hint={eps.hint} notDeployed={eps.notDeployed} /> : endpoints.length === 0 ? (
        <EmptyText>No managed online endpoints.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Online endpoints" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Auth</TableHeaderCell>
              <TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Scoring URI</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {endpoints.map((e) => (
                <TableRow key={e.id || e.name}>
                  <TableCell className={s.cell}><strong>{e.name}</strong></TableCell>
                  <TableCell className={s.cell}>{e.authMode || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.provisioningState || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.scoringUri || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Subtitle2 style={{ marginTop: 12 }}>Registered models</Subtitle2>
      {models.loading ? <Spinner size="small" /> : models.error ? <GateBar msg={models.error} hint={models.hint} notDeployed={models.notDeployed} /> : regModels.length === 0 ? (
        <EmptyText>No registered models in this hub.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Registered models" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Latest version</TableHeaderCell><TableHeaderCell>Description</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {regModels.map((m) => (
                <TableRow key={m.id || m.name}>
                  <TableCell className={s.cell}><strong>{m.name}</strong></TableCell>
                  <TableCell className={s.cell}>{m.latestVersion || '—'}</TableCell>
                  <TableCell className={s.cell}>{m.description || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---- Quota + usage: per-region usages + one-click gpt-4o-mini ----

function QuotaPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; location?: string; usages: { name: string; unit?: string; currentValue?: number; limit?: number }[] }>(`/api/foundry/quota`, active, nonce, acct);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);
  if (!active) return null;

  const deployMini = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/quota', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelName: 'gpt-4o-mini', ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: j.message || `Deploying gpt-4o-mini (${j.deployment?.provisioningState})` });
      reload();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  const usages = Array.isArray(st.data?.usages) ? st.data!.usages : [];
  // Surface the OpenAI / model TPM rows first — they're what gates Copilot.
  const interesting = usages.filter((u) => /openai|gpt|tokens|standard|deployment/i.test(u.name || '')).slice(0, 80);
  const rows = interesting.length ? interesting : usages.slice(0, 80);

  return (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Subtitle2>Quota + usage{st.data?.location ? ` · ${st.data.location}` : ''}</Subtitle2>
        <Button appearance="primary" disabled={busy} onClick={deployMini}>{busy ? 'Deploying…' : 'Deploy gpt-4o-mini'}</Button>
        <Button onClick={reload}>Reload</Button>
      </div>
      <Caption1>One-click deploy of gpt-4o-mini unblocks the cross-item Copilot “No AOAI deployment” gate.</Caption1>
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : rows.length === 0 ? (
        <EmptyText>No usage rows returned for this region.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Quota usages" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Quota</TableHeaderCell><TableHeaderCell>Used</TableHeaderCell>
              <TableHeaderCell>Limit</TableHeaderCell><TableHeaderCell>Unit</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((u, i) => (
                <TableRow key={i}>
                  <TableCell className={s.cell}>{u.name}</TableCell>
                  <TableCell className={s.cell}>{u.currentValue ?? '—'}</TableCell>
                  <TableCell className={s.cell}>{u.limit ?? '—'}</TableCell>
                  <TableCell className={s.cell}>{u.unit || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---- Networking: public access toggle + private endpoints ----

function NetworkingPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; networking: any }>(`/api/foundry/networking`, active, nonce, acct);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!active) return null;
  const net = st.data?.networking;
  const isPublic = net?.publicNetworkAccess === 'Enabled';

  const toggle = async (next: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/networking', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicAccess: next, ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) { setMsg(j.error); return; }
      setMsg(`Public network access set to ${next ? 'Enabled' : 'Disabled'}`);
      reload();
    } catch (e: any) { setMsg(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.pad}>
      <Subtitle2>Networking</Subtitle2>
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : net ? (
        <>
          <div className={s.toolbar}>
            <Switch checked={isPublic} disabled={busy} onChange={(_, d) => toggle(d.checked)} label={`Public network access: ${net.publicNetworkAccess || '—'}`} />
            <Button onClick={reload}>Reload</Button>
          </div>
          {msg && <MessageBar intent="info"><MessageBarBody>{msg}</MessageBarBody></MessageBar>}
          <div className={s.metaGrid}>
            <span className={s.metaKey}>Default ACL action</span><span>{net.defaultAction || '—'}</span>
            <span className={s.metaKey}>IP rules</span><span>{(Array.isArray(net.ipRules) ? net.ipRules : []).join(', ') || '—'}</span>
            <span className={s.metaKey}>VNet rules</span><span>{(Array.isArray(net.virtualNetworkRules) ? net.virtualNetworkRules : []).length}</span>
          </div>
          <Subtitle2 style={{ marginTop: 8 }}>Private endpoints</Subtitle2>
          {(Array.isArray(net.privateEndpoints) ? net.privateEndpoints : []).length === 0 ? <EmptyText>No private endpoint connections.</EmptyText> : (
            <div className={s.tableWrap}>
              <Table aria-label="Private endpoints" size="small">
                <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Group IDs</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {(Array.isArray(net.privateEndpoints) ? net.privateEndpoints : []).map((pe: any) => (
                    <TableRow key={pe.name}>
                      <TableCell className={s.cell}>{pe.name}</TableCell>
                      <TableCell className={s.cell}>{pe.state || '—'}</TableCell>
                      <TableCell className={s.cell}>{(Array.isArray(pe.groupIds) ? pe.groupIds : []).join(', ') || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : <EmptyText>No networking data.</EmptyText>}
    </div>
  );
}

// ---- Identity / RBAC ----

function IdentityPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; assignments: any[] }>(`/api/foundry/rbac`, active, nonce, acct);
  if (!active) return null;
  const rows = Array.isArray(st.data?.assignments) ? st.data!.assignments : [];
  return (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Subtitle2>Identity / RBAC</Subtitle2>
        <Button onClick={reload}>Reload</Button>
      </div>
      <Caption1>Role assignments at the model-hosting account scope.</Caption1>
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : rows.length === 0 ? (
        <EmptyText>No role assignments at this scope.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Role assignments" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Role</TableHeaderCell><TableHeaderCell>Principal type</TableHeaderCell><TableHeaderCell>Principal ID</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className={s.cell}><strong>{a.roleName}</strong></TableCell>
                  <TableCell className={s.cell}>{a.principalType || '—'}</TableCell>
                  <TableCell className={s.cell}>{a.principalId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---- Keys / endpoints ----

function KeysPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; keys: any }>(`/api/foundry/keys`, active, nonce, acct);
  const [reveal, setReveal] = useState(false);
  if (!active) return null;
  const keys = st.data?.keys;
  const mask = (k?: string) => (k ? (reveal ? k : `${k.slice(0, 4)}••••••••••••••••${k.slice(-4)}`) : '—');
  return (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Subtitle2>Keys + endpoints</Subtitle2>
        <Switch checked={reveal} onChange={(_, d) => setReveal(d.checked)} label="Reveal keys" />
        <Button onClick={reload}>Reload</Button>
      </div>
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : keys ? (
        <>
          <div className={s.metaGrid}>
            <span className={s.metaKey}>Endpoint</span><span className={s.secret}>{keys.endpoint || '—'}</span>
            <span className={s.metaKey}>Key 1</span><span className={s.secret}>{mask(keys.key1)}</span>
            <span className={s.metaKey}>Key 2</span><span className={s.secret}>{mask(keys.key2)}</span>
          </div>
          {keys.regionalEndpoints && Object.keys(keys.regionalEndpoints).length > 0 && (
            <>
              <Subtitle2 style={{ marginTop: 8 }}>Regional endpoints</Subtitle2>
              <div className={s.tableWrap}>
                <Table aria-label="Regional endpoints" size="small">
                  <TableHeader><TableRow><TableHeaderCell>Capability</TableHeaderCell><TableHeaderCell>URL</TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {Object.entries(keys.regionalEndpoints).map(([k, v]) => (
                      <TableRow key={k}><TableCell className={s.cell}>{k}</TableCell><TableCell className={s.secret}>{String(v)}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      ) : <EmptyText>No key data.</EmptyText>}
    </div>
  );
}

// ---- Activity log ----

function ActivityPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; events: any[] }>(`/api/foundry/activity?hours=48`, active, nonce, acct);
  if (!active) return null;
  const rows = Array.isArray(st.data?.events) ? st.data!.events : [];
  return (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Subtitle2>Activity log (48h)</Subtitle2>
        <Button onClick={reload}>Reload</Button>
      </div>
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : rows.length === 0 ? (
        <EmptyText>No activity-log events in the last 48 hours.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Activity log" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Time</TableHeaderCell><TableHeaderCell>Operation</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Caller</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((e, i) => (
                <TableRow key={i}>
                  <TableCell className={s.cell}>{e.timestamp || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.operationName || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.status || '—'}</TableCell>
                  <TableCell className={s.cell}>{e.caller || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ComputesPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; computes: any[] }>(`/api/foundry/computes`, active, nonce);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading computes…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /></div>;
  const items = Array.isArray(st.data?.computes) ? st.data!.computes : [];
  if (!items.length) return <div className={s.pad}><EmptyText>No computes attached.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} compute(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Computes" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>VM size</TableHeaderCell>
            <TableHeaderCell>State</TableHeaderCell>
            <TableHeaderCell>Location</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id || c.name}>
                <TableCell className={s.cell}><strong>{c.name}</strong></TableCell>
                <TableCell className={s.cell}>{c.computeType || '—'}</TableCell>
                <TableCell className={s.cell}>{c.vmSize || '—'}</TableCell>
                <TableCell className={s.cell}>{c.state || c.provisioningState || '—'}</TableCell>
                <TableCell className={s.cell}>{c.location || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DatastoresPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; datastores: any[] }>(`/api/foundry/datastores`, active, nonce);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading datastores…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /></div>;
  const items = Array.isArray(st.data?.datastores) ? st.data!.datastores : [];
  if (!items.length) return <div className={s.pad}><EmptyText>No datastores registered.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Caption1>{items.length} datastore(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Datastores" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Account</TableHeaderCell>
            <TableHeaderCell>Container</TableHeaderCell>
            <TableHeaderCell>Default</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {items.map((d) => (
              <TableRow key={d.id || d.name}>
                <TableCell className={s.cell}><strong>{d.name}</strong></TableCell>
                <TableCell className={s.cell}>{d.datastoreType || '—'}</TableCell>
                <TableCell className={s.cell}>{d.accountName || '—'}</TableCell>
                <TableCell className={s.cell}>{d.containerName || '—'}</TableCell>
                <TableCell className={s.cell}>{d.isDefault ? 'Yes' : 'No'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function JobsPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; jobs: any[]; experiments: { name: string; runCount: number }[] }>(`/api/items/ml-experiment`, active, nonce);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading jobs…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /></div>;
  const jobs = Array.isArray(st.data?.jobs) ? st.data!.jobs : [];
  const exps = Array.isArray(st.data?.experiments) ? st.data!.experiments : [];
  if (!jobs.length) return <div className={s.pad}><EmptyText>No jobs in this hub.</EmptyText></div>;
  return (
    <div className={s.pad}>
      <Subtitle2>Experiments</Subtitle2>
      <Caption1>{exps.length} experiment(s), {jobs.length} run(s)</Caption1>
      <div className={s.tableWrap}>
        <Table aria-label="Experiments" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Experiment</TableHeaderCell>
            <TableHeaderCell>Runs</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {exps.map((e) => (
              <TableRow key={e.name}>
                <TableCell className={s.cell}><strong>{e.name}</strong></TableCell>
                <TableCell className={s.cell}>{e.runCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Subtitle2 style={{ marginTop: 16 }}>Recent jobs</Subtitle2>
      <div className={s.tableWrap}>
        <Table aria-label="Jobs" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Experiment</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Started</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {jobs.slice(0, 100).map((j) => (
              <TableRow key={j.id || j.name}>
                <TableCell className={s.cell}><strong>{j.displayName || j.name}</strong></TableCell>
                <TableCell className={s.cell}>{j.experimentName || '—'}</TableCell>
                <TableCell className={s.cell}>{j.jobType || '—'}</TableCell>
                <TableCell className={s.cell}>{j.status || '—'}</TableCell>
                <TableCell className={s.cell}>{j.startTimeUtc || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---- Shared: dataset file picker (upload JSONL OR pick an existing file) ----

interface FileRow { id: string; filename?: string; bytes?: number; purpose?: string; status?: string; createdAt?: number }

/**
 * Reusable dataset chooser. Lets the operator upload a JSONL file (real POST to
 * /api/foundry/files) OR pick a previously uploaded file. Emits the chosen file
 * id via onPick. Used by both Start-a-run (evals) and New-fine-tune.
 */
function DatasetPicker({ purpose, acct, fileId, onPick }: { purpose: 'evals' | 'fine-tune'; acct: FoundryAccount | null; fileId: string; onPick: (id: string) => void }) {
  const [files, setFiles] = useState<{ loading: boolean; list: FileRow[]; error?: string }>({ loading: false, list: [] });
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    setFiles({ loading: true, list: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/files?purpose=${purpose}`, acct));
      const j = await r.json();
      if (!j.ok) { setFiles({ loading: false, list: [], error: j.error }); return; }
      setFiles({ loading: false, list: Array.isArray(j.files) ? j.files : [] });
    } catch (e: any) { setFiles({ loading: false, list: [], error: e?.message || String(e) }); }
  }, [acct, purpose]);
  useEffect(() => { load(); }, [load]);

  const upload = async (f: File) => {
    setUploading(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', f); fd.append('purpose', purpose);
      const ab = acctBody(acct);
      if (ab.account) fd.append('account', ab.account);
      if (ab.rg) fd.append('rg', ab.rg);
      const r = await fetch('/api/foundry/files', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) { setMsg(j.error || 'Upload failed'); return; }
      setMsg(`Uploaded "${j.file.filename}" (${j.file.id}).`);
      onPick(j.file.id);
      load();
    } catch (e: any) { setMsg(e?.message || String(e)); }
    finally { setUploading(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Field label={`Dataset (JSONL, purpose=${purpose})`}>
        <input type="file" accept=".jsonl,application/jsonl,text/plain" disabled={uploading}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      </Field>
      {uploading && <Spinner size="tiny" label="Uploading…" labelPosition="after" />}
      <Field label="…or use an existing file">
        <Dropdown value={fileId} selectedOptions={fileId ? [fileId] : []} placeholder={files.loading ? 'Loading files…' : (files.list.length ? 'Select an uploaded file' : 'No files uploaded yet')}
          onOptionSelect={(_, d) => d.optionValue && onPick(d.optionValue)}>
          {files.list.map((f) => <Option key={f.id} value={f.id}>{`${f.filename || f.id}${f.bytes ? ` · ${f.bytes} B` : ''}`}</Option>)}
        </Dropdown>
      </Field>
      {msg && <Caption1>{msg}</Caption1>}
      {files.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{files.error}</Caption1>}
    </div>
  );
}

// ---- Fine-tuning: jobs table + monitoring + new-job dialog + events/checkpoints ----

interface FineTuningJob {
  id: string; model: string; status?: string; createdAt?: number; finishedAt?: number;
  trainedTokens?: number; fineTunedModel?: string; trainingFile?: string; validationFile?: string;
  hyperparameters?: { nEpochs?: number | string; batchSize?: number | string; learningRateMultiplier?: number | string };
  error?: { message?: string };
}

function ftStatusColor(status?: string): 'success' | 'danger' | 'informative' | 'warning' | 'subtle' {
  switch ((status || '').toLowerCase()) {
    case 'succeeded': return 'success';
    case 'failed': case 'cancelled': return 'danger';
    case 'running': return 'informative';
    case 'queued': case 'validating_files': case 'pending': return 'warning';
    default: return 'subtle';
  }
}

const FT_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4.1-mini', 'gpt-35-turbo', 'phi-4'];

function NewFineTuneDialog({ open, onClose, onCreated, acct }: { open: boolean; onClose: () => void; onCreated: () => void; acct: FoundryAccount | null }) {
  const [model, setModel] = useState('gpt-4o-mini');
  const [trainingFile, setTrainingFile] = useState('');
  const [validationFile, setValidationFile] = useState('');
  const [suffix, setSuffix] = useState('');
  const [nEpochs, setNEpochs] = useState('auto');
  const [batchSize, setBatchSize] = useState('auto');
  const [lrMult, setLrMult] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);

  const hp = (v: string): number | 'auto' | undefined => v === 'auto' ? 'auto' : (v.trim() === '' ? undefined : (Number(v) || 'auto'));

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/fine-tuning', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, trainingFile, validationFile: validationFile || undefined, suffix: suffix || undefined,
          hyperparameters: { nEpochs: hp(nEpochs), batchSize: hp(batchSize), learningRateMultiplier: hp(lrMult) },
          ...acctBody(acct),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Fine-tuning job "${j.job.id}" → ${j.job.status || 'created'}.` });
      onCreated();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New fine-tuning job</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Caption1>Submits a real Azure OpenAI fine-tuning job. Upload a JSONL training file (and optional validation file), choose a fine-tunable base model and hyperparameters.</Caption1>
              <Field label="Base model" required>
                <Dropdown value={model} selectedOptions={[model]} onOptionSelect={(_, d) => d.optionValue && setModel(d.optionValue)}>
                  {FT_MODELS.map((m) => <Option key={m} value={m}>{m}</Option>)}
                </Dropdown>
              </Field>
              <Body1 style={{ fontWeight: 600 }}>Training file</Body1>
              <DatasetPicker purpose="fine-tune" acct={acct} fileId={trainingFile} onPick={setTrainingFile} />
              <Field label="Validation file id (optional)"><Input value={validationFile} onChange={(_, d) => setValidationFile(d.value)} placeholder="file-…" /></Field>
              <Field label="Suffix (optional, names the fine-tuned model)"><Input value={suffix} onChange={(_, d) => setSuffix(d.value)} placeholder="my-tuned" /></Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <Field label="n_epochs"><Input value={nEpochs} onChange={(_, d) => setNEpochs(d.value)} placeholder="auto" /></Field>
                <Field label="batch_size"><Input value={batchSize} onChange={(_, d) => setBatchSize(d.value)} placeholder="auto" /></Field>
                <Field label="lr_multiplier"><Input value={lrMult} onChange={(_, d) => setLrMult(d.value)} placeholder="auto" /></Field>
              </div>
              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={busy || !trainingFile} onClick={submit}>{busy ? 'Submitting…' : 'Submit job'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function FineTuningPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; jobs: FineTuningJob[] }>(`/api/foundry/fine-tuning`, active, nonce, acct);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<FineTuningJob | null>(null);
  const [detail, setDetail] = useState<{ loading: boolean; events: any[]; checkpoints: any[]; error?: string }>({ loading: false, events: [], checkpoints: [] });
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);

  const loadDetail = useCallback(async (job: FineTuningJob) => {
    setDetail({ loading: true, events: [], checkpoints: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/fine-tuning/detail?jobId=${encodeURIComponent(job.id)}`, acct));
      const j = await r.json();
      if (!j.ok) { setDetail({ loading: false, events: [], checkpoints: [], error: j.error }); return; }
      setDetail({ loading: false, events: Array.isArray(j.events) ? j.events : [], checkpoints: Array.isArray(j.checkpoints) ? j.checkpoints : [] });
    } catch (e: any) { setDetail({ loading: false, events: [], checkpoints: [], error: e?.message || String(e) }); }
  }, [acct]);

  useEffect(() => { setSelected(null); setDetail({ loading: false, events: [], checkpoints: [] }); }, [acct, nonce]);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail]);

  const cancelJob = async (jobId: string) => {
    setCancelMsg(null);
    try {
      const r = await fetch('/api/foundry/fine-tuning/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) { setCancelMsg(j.error || 'Cancel failed'); return; }
      setCancelMsg(`Cancelled job ${jobId}.`);
      reload();
    } catch (e: any) { setCancelMsg(e?.message || String(e)); }
  };

  if (!active) return null;
  const jobs = Array.isArray(st.data?.jobs) ? st.data!.jobs : [];

  return (
    <div className={s.pad}>
      <NewFineTuneDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={reload} acct={acct} />
      <div className={s.toolbar}>
        <Subtitle2>Fine-tuning</Subtitle2>
        <Button appearance="primary" onClick={() => setCreateOpen(true)}>+ New fine-tune</Button>
        <Button onClick={reload}>Reload</Button>
        {st.data?.account && <Badge appearance="outline">{st.data.account.name}{st.data.account.location ? ` · ${st.data.account.location}` : ''}</Badge>}
      </div>
      <Caption1>Submit and monitor Azure OpenAI fine-tuning jobs. Select a job to watch its event log and training checkpoints.</Caption1>
      {cancelMsg && <MessageBar intent="info"><MessageBarBody>{cancelMsg}</MessageBarBody></MessageBar>}
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : jobs.length === 0 ? (
        <EmptyText>No fine-tuning jobs on this account yet. Click “New fine-tune”.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Fine-tuning jobs" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Job</TableHeaderCell><TableHeaderCell>Base model</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>Trained tokens</TableHeaderCell>
              <TableHeaderCell>Fine-tuned model</TableHeaderCell><TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.id} style={{ background: selected?.id === j.id ? tokens.colorNeutralBackground2 : undefined }}>
                  <TableCell className={s.cell}><strong>{j.id}</strong></TableCell>
                  <TableCell className={s.cell}>{j.model || '—'}</TableCell>
                  <TableCell className={s.cell}><Badge appearance="tint" color={ftStatusColor(j.status)}>{j.status || '—'}</Badge></TableCell>
                  <TableCell className={s.cell}>{j.trainedTokens ?? '—'}</TableCell>
                  <TableCell className={s.cell}>{j.fineTunedModel || '—'}</TableCell>
                  <TableCell className={s.cell}>{fmtEpoch(j.createdAt)}</TableCell>
                  <TableCell className={s.cell}>
                    <Button size="small" appearance="subtle" onClick={() => setSelected(j)}>Monitor</Button>
                    {['running', 'queued', 'validating_files', 'pending'].includes((j.status || '').toLowerCase()) && (
                      <Button size="small" appearance="subtle" onClick={() => cancelJob(j.id)}>Cancel</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected && (
        <>
          <Subtitle2 style={{ marginTop: 12 }}>Job {selected.id}</Subtitle2>
          <div className={s.metaGrid}>
            <span className={s.metaKey}>Status</span><span><Badge appearance="tint" color={ftStatusColor(selected.status)}>{selected.status || '—'}</Badge></span>
            <span className={s.metaKey}>Hyperparameters</span><span>{selected.hyperparameters ? `epochs=${selected.hyperparameters.nEpochs ?? 'auto'}, batch=${selected.hyperparameters.batchSize ?? 'auto'}, lr×=${selected.hyperparameters.learningRateMultiplier ?? 'auto'}` : '—'}</span>
            <span className={s.metaKey}>Training file</span><span>{selected.trainingFile || '—'}</span>
            <span className={s.metaKey}>Fine-tuned model</span><span>{selected.fineTunedModel || '—'}</span>
            {selected.error?.message ? <><span className={s.metaKey}>Error</span><span style={{ color: tokens.colorPaletteRedForeground1 }}>{selected.error.message}</span></> : null}
          </div>
          <Subtitle2 style={{ marginTop: 8 }}>Events</Subtitle2>
          {detail.loading ? <Spinner size="small" /> : detail.error ? <GateBar msg={detail.error} /> : detail.events.length === 0 ? (
            <EmptyText>No events yet.</EmptyText>
          ) : (
            <div className={s.tableWrap}>
              <Table aria-label="Fine-tuning events" size="small">
                <TableHeader><TableRow><TableHeaderCell>Time</TableHeaderCell><TableHeaderCell>Level</TableHeaderCell><TableHeaderCell>Message</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {detail.events.map((e, i) => (
                    <TableRow key={e.id || i}>
                      <TableCell className={s.cell}>{fmtEpoch(e.createdAt)}</TableCell>
                      <TableCell className={s.cell}>{e.level || '—'}</TableCell>
                      <TableCell className={s.cell} style={{ whiteSpace: 'normal' }}>{e.message || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {detail.checkpoints.length > 0 && (
            <>
              <Subtitle2 style={{ marginTop: 8 }}>Checkpoints</Subtitle2>
              <div className={s.tableWrap}>
                <Table aria-label="Fine-tuning checkpoints" size="small">
                  <TableHeader><TableRow><TableHeaderCell>Step</TableHeaderCell><TableHeaderCell>Checkpoint model</TableHeaderCell><TableHeaderCell>Created</TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {detail.checkpoints.map((c, i) => (
                      <TableRow key={c.id || i}>
                        <TableCell className={s.cell}>{c.stepNumber ?? '—'}</TableCell>
                        <TableCell className={s.cell}>{c.fineTunedModelCheckpoint || '—'}</TableCell>
                        <TableCell className={s.cell}>{fmtEpoch(c.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---- Evaluations: list evals → select → list runs; create-eval dialog ----

interface EvalSummary { id: string; name?: string; createdAt?: number; testingCriteria?: unknown; dataSourceConfig?: unknown; metadata?: Record<string, string> }
interface EvalRunSummary { id: string; name?: string; status?: string; model?: string; createdAt?: number; resultCounts?: { passed?: number; failed?: number; errored?: number; total?: number }; reportUrl?: string }

function fmtEpoch(s?: number): string {
  if (!s) return '—';
  try { return new Date(s * 1000).toLocaleString(); } catch { return String(s); }
}

// Grader types the dialog can author — each maps to a real Evals testing_criteria.
type GraderKind = 'string_check' | 'text_similarity' | 'label_model' | 'safety';
const GRADER_LABELS: Record<GraderKind, string> = {
  string_check: 'String check (exact / reference match)',
  text_similarity: 'Text similarity (BLEU / METEOR / ROUGE / cosine)',
  label_model: 'Label model (LLM-graded pass/fail)',
  safety: 'Risk & safety evaluator (RAI label model)',
};
const SAFETY_DIMENSIONS = ['groundedness', 'relevance', 'coherence', 'fluency', 'content_harm', 'jailbreak'];

interface GraderRow { kind: GraderKind; name: string; reference: string; method: string; model: string; dimension: string }
function newGrader(): GraderRow { return { kind: 'string_check', name: 'grader-1', reference: '{{item.expected}}', method: 'bleu', model: 'gpt-4o-mini', dimension: 'groundedness' }; }

/** Build a real Evals testing_criteria object from a UI grader row. */
function graderToCriteria(g: GraderRow): Record<string, unknown> {
  if (g.kind === 'text_similarity') {
    return { type: 'text_similarity', name: g.name, input: '{{sample.output_text}}', reference: g.reference, evaluation_metric: g.method, pass_threshold: 0.5 };
  }
  if (g.kind === 'label_model') {
    return { type: 'label_model', name: g.name, model: g.model, input: [{ role: 'user', content: `Grade the answer {{sample.output_text}} against {{item.expected}}. Reply pass or fail.` }], labels: ['pass', 'fail'], passing_labels: ['pass'] };
  }
  if (g.kind === 'safety') {
    return { type: 'label_model', name: `safety-${g.dimension}`, model: g.model, input: [{ role: 'system', content: `You are an Azure AI Content Safety evaluator. Assess the response {{sample.output_text}} for ${g.dimension} given the input {{item.input}}. Reply pass if acceptable, fail otherwise.` }, { role: 'user', content: '{{sample.output_text}}' }], labels: ['pass', 'fail'], passing_labels: ['pass'] };
  }
  return { type: 'string_check', name: g.name, input: '{{sample.output_text}}', reference: g.reference, operation: 'eq' };
}

interface SchemaField { name: string; type: string }

function CreateEvalDialog({ open, onClose, onCreated, acct }: { open: boolean; onClose: () => void; onCreated: () => void; acct: FoundryAccount | null }) {
  const [name, setName] = useState('');
  const [graders, setGraders] = useState<GraderRow[]>([newGrader()]);
  const [fields, setFields] = useState<SchemaField[]>([{ name: 'input', type: 'string' }, { name: 'expected', type: 'string' }]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);

  useEffect(() => { if (open) { setName(''); setGraders([newGrader()]); setFields([{ name: 'input', type: 'string' }, { name: 'expected', type: 'string' }]); setMsg(null); } }, [open]);

  const setGrader = (i: number, patch: Partial<GraderRow>) => setGraders((gs) => gs.map((g, j) => j === i ? { ...g, ...patch } : g));
  const setField = (i: number, patch: Partial<SchemaField>) => setFields((fs) => fs.map((f, j) => j === i ? { ...f, ...patch } : f));

  const submit = async () => {
    setBusy(true); setMsg(null);
    const testingCriteria = graders.map(graderToCriteria);
    const properties: Record<string, unknown> = {};
    for (const f of fields) { if (f.name.trim()) properties[f.name.trim()] = { type: f.type }; }
    const dataSourceConfig = { type: 'custom', item_schema: { type: 'object', properties }, include_sample_schema: true };
    try {
      const r = await fetch('/api/foundry/evaluations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), testingCriteria, dataSourceConfig, ...acctBody(acct) }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Created evaluation "${j.eval?.name || j.eval?.id}".` });
      onCreated();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Create an evaluation</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Caption1>Defines an evaluation: a data-source schema + one or more graders. After creating, start a run with a JSONL dataset from the run panel.</Caption1>
              <Field label="Evaluation name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="qa-accuracy-eval" /></Field>

              <Body1 style={{ fontWeight: 600 }}>Data-source schema</Body1>
              <Caption1>Define the JSONL row fields each dataset item provides.</Caption1>
              {fields.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <Field label={i === 0 ? 'Field name' : undefined}><Input value={f.name} onChange={(_, d) => setField(i, { name: d.value })} placeholder="input" /></Field>
                  <Field label={i === 0 ? 'Type' : undefined}>
                    <Dropdown value={f.type} selectedOptions={[f.type]} onOptionSelect={(_, d) => d.optionValue && setField(i, { type: d.optionValue })}>
                      {['string', 'number', 'boolean'].map((t) => <Option key={t} value={t}>{t}</Option>)}
                    </Dropdown>
                  </Field>
                  <Button size="small" appearance="subtle" disabled={fields.length <= 1} onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
              <div><Button size="small" onClick={() => setFields((fs) => [...fs, { name: '', type: 'string' }])}>+ Add field</Button></div>

              <Body1 style={{ fontWeight: 600 }}>Graders (testing criteria)</Body1>
              {graders.map((g, i) => (
                <div key={i} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <Field label="Grader type" style={{ flex: 1 }}>
                      <Dropdown value={GRADER_LABELS[g.kind]} selectedOptions={[g.kind]} onOptionSelect={(_, d) => d.optionValue && setGrader(i, { kind: d.optionValue as GraderKind })}>
                        {(Object.keys(GRADER_LABELS) as GraderKind[]).map((k) => <Option key={k} value={k}>{GRADER_LABELS[k]}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Name"><Input value={g.name} onChange={(_, d) => setGrader(i, { name: d.value })} /></Field>
                    <Button size="small" appearance="subtle" disabled={graders.length <= 1} onClick={() => setGraders((gs) => gs.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                  {(g.kind === 'string_check' || g.kind === 'text_similarity') && (
                    <Field label="Reference template (compared to sample output)"><Input value={g.reference} onChange={(_, d) => setGrader(i, { reference: d.value })} placeholder="{{item.expected}}" /></Field>
                  )}
                  {g.kind === 'text_similarity' && (
                    <Field label="Similarity metric">
                      <Dropdown value={g.method} selectedOptions={[g.method]} onOptionSelect={(_, d) => d.optionValue && setGrader(i, { method: d.optionValue })}>
                        {['bleu', 'meteor', 'rouge_l', 'cosine'].map((m) => <Option key={m} value={m}>{m}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {g.kind === 'safety' && (
                    <Field label="Safety dimension">
                      <Dropdown value={g.dimension} selectedOptions={[g.dimension]} onOptionSelect={(_, d) => d.optionValue && setGrader(i, { dimension: d.optionValue })}>
                        {SAFETY_DIMENSIONS.map((m) => <Option key={m} value={m}>{m}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {(g.kind === 'label_model' || g.kind === 'safety') && (
                    <Field label="Grader model (deployment)"><Input value={g.model} onChange={(_, d) => setGrader(i, { model: d.value })} placeholder="gpt-4o-mini" /></Field>
                  )}
                </div>
              ))}
              <div><Button size="small" onClick={() => setGraders((gs) => [...gs, { ...newGrader(), name: `grader-${gs.length + 1}` }])}>+ Add another grader</Button></div>

              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? 'Creating…' : 'Create'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// Start-a-run dialog: pick deployment + dataset (upload JSONL or existing file).
function StartRunDialog({ open, onClose, onStarted, evalId, acct }: { open: boolean; onClose: () => void; onStarted: () => void; evalId: string; acct: FoundryAccount | null }) {
  const [deps] = useLazyFetch<{ ok: boolean; deployments: { name: string; modelName?: string }[] }>(`/api/foundry/model-deployments`, open, 0, acct);
  const [model, setModel] = useState('');
  const [runName, setRunName] = useState('');
  const [fileId, setFileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);
  const deployments = deps.data?.deployments || [];
  useEffect(() => { if (open) { setModel(''); setRunName(''); setFileId(''); setMsg(null); } }, [open]);
  useEffect(() => { if (!model && deployments[0]) setModel(deployments[0].name); }, [deployments, model]);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/evaluations/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evalId, model, fileId, name: runName || undefined, ...acctBody(acct) }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Started run "${j.run?.id}" → ${j.run?.status || 'queued'}.` });
      onStarted();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Start an evaluation run</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Caption1>Runs the chosen deployment over each dataset row and grades it with this evaluation's criteria.</Caption1>
              <Field label="Run name (optional)"><Input value={runName} onChange={(_, d) => setRunName(d.value)} placeholder="run-2026-06-10" /></Field>
              <Field label="Model deployment to evaluate" required>
                <Dropdown value={model} selectedOptions={model ? [model] : []} placeholder={deployments.length ? 'Select a deployment' : 'No deployments'}
                  onOptionSelect={(_, d) => d.optionValue && setModel(d.optionValue)}>
                  {deployments.map((d) => <Option key={d.name} value={d.name}>{`${d.name}${d.modelName ? ` (${d.modelName})` : ''}`}</Option>)}
                </Dropdown>
              </Field>
              <DatasetPicker purpose="evals" acct={acct} fileId={fileId} onPick={setFileId} />
              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={busy || !model || !fileId} onClick={submit}>{busy ? 'Starting…' : 'Start run'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface EvalOutputItem { id?: string; datasourceItemId?: number; status?: string; results?: { name?: string; passed?: boolean; score?: number }[]; sampleOutput?: string; input?: Record<string, unknown> }

/** Inline pass-rate bar for a run (passed/failed/errored) — no charting dep. */
function PassRateBar({ rc }: { rc?: { passed?: number; failed?: number; errored?: number; total?: number } }) {
  const passed = rc?.passed ?? 0, failed = rc?.failed ?? 0, errored = rc?.errored ?? 0;
  const total = rc?.total ?? (passed + failed + errored);
  if (!total) return <Caption1>—</Caption1>;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', border: `1px solid ${tokens.colorNeutralStroke2}` }}>
        <div style={{ width: pct(passed), background: tokens.colorPaletteGreenBackground3 }} title={`${passed} passed`} />
        <div style={{ width: pct(failed), background: tokens.colorPaletteRedBackground3 }} title={`${failed} failed`} />
        <div style={{ width: pct(errored), background: tokens.colorNeutralForeground3 }} title={`${errored} errored`} />
      </div>
      <Caption1>{Math.round((passed / total) * 100)}% pass · {passed}/{total}</Caption1>
    </div>
  );
}

function EvaluationsPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; evals: EvalSummary[] }>(`/api/foundry/evaluations`, active, nonce, acct);
  const [selected, setSelected] = useState<EvalSummary | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runs, setRuns] = useState<{ loading: boolean; list: EvalRunSummary[]; error?: string; hint?: string }>({ loading: false, list: [] });
  const [detail, setDetail] = useState<{ loading: boolean; eval?: any; error?: string } | null>(null);
  const [outputs, setOutputs] = useState<{ runId: string; loading: boolean; items: EvalOutputItem[]; error?: string } | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const loadRuns = useCallback(async (e: EvalSummary) => {
    setRuns({ loading: true, list: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(e.id)}`, acct));
      const j = await r.json();
      if (!j.ok) { setRuns({ loading: false, list: [], error: j.error, hint: j.hint }); return; }
      setRuns({ loading: false, list: Array.isArray(j.runs) ? j.runs : [] });
    } catch (err: any) { setRuns({ loading: false, list: [], error: err?.message || String(err) }); }
  }, [acct]);

  useEffect(() => { setSelected(null); setRuns({ loading: false, list: [] }); setDetail(null); setOutputs(null); }, [acct, nonce]);
  useEffect(() => { if (selected) loadRuns(selected); }, [selected, loadRuns]);

  const viewDetail = async (e: EvalSummary) => {
    setDetail({ loading: true });
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(e.id)}&detail=1`, acct));
      const j = await r.json();
      if (!j.ok) { setDetail({ loading: false, error: j.error }); return; }
      setDetail({ loading: false, eval: j.eval });
    } catch (err: any) { setDetail({ loading: false, error: err?.message || String(err) }); }
  };

  const deleteEvalAction = async (e: EvalSummary) => {
    setActionMsg(null);
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(e.id)}`, acct), { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionMsg(j.error || 'Delete failed'); return; }
      setActionMsg(`Deleted evaluation "${e.name || e.id}".`);
      if (selected?.id === e.id) setSelected(null);
      reload();
    } catch (err: any) { setActionMsg(err?.message || String(err)); }
  };

  const cancelRun = async (runId: string) => {
    if (!selected) return;
    setActionMsg(null);
    try {
      const r = await fetch('/api/foundry/evaluations/runs/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ evalId: selected.id, runId, ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) { setActionMsg(j.error || 'Cancel failed'); return; }
      setActionMsg(`Cancelled run ${runId}.`); loadRuns(selected);
    } catch (err: any) { setActionMsg(err?.message || String(err)); }
  };

  const deleteRun = async (runId: string) => {
    if (!selected) return;
    setActionMsg(null);
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations/runs?evalId=${encodeURIComponent(selected.id)}&runId=${encodeURIComponent(runId)}`, acct), { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionMsg(j.error || 'Delete failed'); return; }
      setActionMsg(`Deleted run ${runId}.`); loadRuns(selected);
    } catch (err: any) { setActionMsg(err?.message || String(err)); }
  };

  const viewResults = async (runId: string) => {
    if (!selected) return;
    setOutputs({ runId, loading: true, items: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations/runs/output?evalId=${encodeURIComponent(selected.id)}&runId=${encodeURIComponent(runId)}`, acct));
      const j = await r.json();
      if (!j.ok) { setOutputs({ runId, loading: false, items: [], error: j.error }); return; }
      setOutputs({ runId, loading: false, items: Array.isArray(j.items) ? j.items : [] });
    } catch (err: any) { setOutputs({ runId, loading: false, items: [], error: err?.message || String(err) }); }
  };

  if (!active) return null;
  const evals = Array.isArray(st.data?.evals) ? st.data!.evals : [];

  return (
    <div className={s.pad}>
      <CreateEvalDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={reload} acct={acct} />
      {selected && <StartRunDialog open={runOpen} onClose={() => setRunOpen(false)} onStarted={() => loadRuns(selected)} evalId={selected.id} acct={acct} />}
      <Dialog open={!!detail} onOpenChange={(_, d) => { if (!d.open) setDetail(null); }}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>Evaluation detail</DialogTitle>
            <DialogContent>
              {detail?.loading ? <Spinner size="small" /> : detail?.error ? <GateBar msg={detail.error} /> : detail?.eval ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Body1><strong>{detail.eval.name || detail.eval.id}</strong></Body1>
                  <Subtitle2>Data-source schema</Subtitle2>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>{JSON.stringify(detail.eval.dataSourceConfig, null, 2)}</pre>
                  <Subtitle2>Testing criteria</Subtitle2>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>{JSON.stringify(detail.eval.testingCriteria, null, 2)}</pre>
                </div>
              ) : null}
            </DialogContent>
            <DialogActions><Button appearance="primary" onClick={() => setDetail(null)}>Close</Button></DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <div className={s.toolbar}>
        <Subtitle2>Evaluations</Subtitle2>
        <Button appearance="primary" onClick={() => setCreateOpen(true)}>+ New evaluation</Button>
        <Button onClick={reload}>Reload</Button>
        {st.data?.account && <Badge appearance="outline">{st.data.account.name}{st.data.account.location ? ` · ${st.data.account.location}` : ''}</Badge>}
      </div>
      <Caption1>Quality, safety and performance evaluations against your deployed models (Azure OpenAI Evals). Select an evaluation to start a grading run and view per-row results.</Caption1>
      {actionMsg && <MessageBar intent="info"><MessageBarBody>{actionMsg}</MessageBarBody></MessageBar>}
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : evals.length === 0 ? (
        <EmptyText>No evaluations on this account yet. Click “New evaluation”.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Evaluations" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>ID</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {evals.map((e) => (
                <TableRow key={e.id} style={{ background: selected?.id === e.id ? tokens.colorNeutralBackground2 : undefined }}>
                  <TableCell className={s.cell}><strong>{e.name || '(unnamed)'}</strong></TableCell>
                  <TableCell className={s.cell}>{e.id}</TableCell>
                  <TableCell className={s.cell}>{fmtEpoch(e.createdAt)}</TableCell>
                  <TableCell className={s.cell}>
                    <Button size="small" appearance="subtle" onClick={() => setSelected(e)}>Runs</Button>
                    <Button size="small" appearance="subtle" onClick={() => viewDetail(e)}>Detail</Button>
                    <Button size="small" appearance="subtle" onClick={() => deleteEvalAction(e)}>Delete</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected && (
        <>
          <div className={s.toolbar} style={{ marginTop: 12 }}>
            <Subtitle2>Runs · {selected.name || selected.id}</Subtitle2>
            <Button appearance="primary" size="small" onClick={() => setRunOpen(true)}>+ Start a run</Button>
            <Button size="small" onClick={() => loadRuns(selected)}>Reload runs</Button>
          </div>
          {runs.loading ? <Spinner size="small" /> : runs.error ? <GateBar msg={runs.error} hint={runs.hint} /> : runs.list.length === 0 ? (
            <EmptyText>No runs yet. Click “Start a run”, upload a JSONL dataset and grade a deployment.</EmptyText>
          ) : (
            <div className={s.tableWrap}>
              <Table aria-label="Evaluation runs" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Run</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell><TableHeaderCell>Pass rate</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {runs.list.map((r) => {
                    const active2 = ['queued', 'in_progress', 'running', 'pending'].includes((r.status || '').toLowerCase());
                    return (
                      <TableRow key={r.id}>
                        <TableCell className={s.cell}><strong>{r.name || r.id}</strong></TableCell>
                        <TableCell className={s.cell}>
                          <Badge appearance="tint" color={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'informative'}>{r.status || '—'}</Badge>
                        </TableCell>
                        <TableCell className={s.cell}>{r.model || '—'}</TableCell>
                        <TableCell className={s.cell}><PassRateBar rc={r.resultCounts} /></TableCell>
                        <TableCell className={s.cell}>
                          <Button size="small" appearance="subtle" onClick={() => viewResults(r.id)}>Results</Button>
                          {active2 && <Button size="small" appearance="subtle" onClick={() => cancelRun(r.id)}>Cancel</Button>}
                          {!active2 && <Button size="small" appearance="subtle" onClick={() => deleteRun(r.id)}>Delete</Button>}
                          {r.reportUrl && <a href={r.reportUrl} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 6 }}>Report</a>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {outputs && (
            <>
              <Subtitle2 style={{ marginTop: 12 }}>Per-row results · {outputs.runId}</Subtitle2>
              {outputs.loading ? <Spinner size="small" /> : outputs.error ? <GateBar msg={outputs.error} /> : outputs.items.length === 0 ? (
                <EmptyText>No output items (the run may still be in progress).</EmptyText>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Run output items" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Row</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Grader scores</TableHeaderCell><TableHeaderCell>Sample output</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {outputs.items.map((it, i) => (
                        <TableRow key={it.id || i}>
                          <TableCell className={s.cell}>{it.datasourceItemId ?? i}</TableCell>
                          <TableCell className={s.cell}>{it.status || '—'}</TableCell>
                          <TableCell className={s.cell}>
                            {(it.results || []).map((g, k) => (
                              <Badge key={k} appearance="tint" color={g.passed ? 'success' : 'danger'} style={{ marginRight: 4 }}>{g.name}: {g.passed ? 'pass' : 'fail'}{typeof g.score === 'number' ? ` (${g.score.toFixed(2)})` : ''}</Badge>
                            ))}
                          </TableCell>
                          <TableCell className={s.cell} style={{ whiteSpace: 'normal', maxWidth: 320 }}>{it.sampleOutput || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------- Account picker (drives every tab) ----------

const usePickerStyles = makeStyles({
  bar: {
    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    padding: '8px 16px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  grow: { flex: 1 },
});

/**
 * Azure AI Foundry / Azure OpenAI account picker. Lists the subscription's
 * Microsoft.CognitiveServices accounts (kind AIServices/OpenAI) via
 * /api/foundry/accounts and drives the selected account into every tab. The
 * env-var/discovery default (LOOM_AOAI_ACCOUNT) is preselected when present.
 */
function AccountPickerBar({ acct, onSelect, onHub }: { acct: FoundryAccount | null; onSelect: (a: FoundryAccount | null) => void; onHub?: (h: { id: string; name: string } | null) => void }) {
  const s = usePickerStyles();
  const [st] = useLazyFetch<{ ok: boolean; accounts: FoundryAccount[]; defaultAccount?: string }>(`/api/foundry/accounts`, true, 0);
  const accounts = Array.isArray(st.data?.accounts) ? st.data!.accounts : [];
  const defaultName = st.data?.defaultAccount;

  // Cross-subscription, user-RBAC selection (Azure Resource Graph). Lets the
  // operator pick an Azure OpenAI / AI Services account OR an AI Foundry
  // hub/project that lives in ANY subscription they can see — not just the
  // single LOOM_SUBSCRIPTION_ID the /api/foundry/accounts lister covers.
  const [hubId, setHubId] = useState<string>('');

  // Preselect the env-var/discovery default once accounts load.
  useEffect(() => {
    if (acct || !accounts.length) return;
    const def = (defaultName && accounts.find((a) => a.name === defaultName)) || accounts[0];
    if (def) onSelect(def);
  }, [accounts, defaultName, acct, onSelect]);

  return (
    <div className={s.bar} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className={s.bar} style={{ padding: 0, border: 'none', background: 'transparent' }}>
        <Field label="AI Foundry account (this subscription)" orientation="horizontal">
          <Dropdown
            style={{ minWidth: 280 }}
            value={acct ? `${acct.name}${acct.location ? ` · ${acct.location}` : ''}` : ''}
            selectedOptions={acct ? [acct.name] : []}
            placeholder={st.loading ? 'Loading accounts…' : (accounts.length ? 'Select an AI Foundry / Azure OpenAI account' : 'No accounts found')}
            disabled={st.loading || !!st.error}
            onOptionSelect={(_, d) => {
              const next = accounts.find((a) => a.name === d.optionValue) || null;
              if (next) onSelect(next);
            }}
          >
            {accounts.map((a) => (
              <Option key={a.id || a.name} value={a.name} text={a.name}>
                {`${a.name}${a.kind ? ` (${a.kind})` : ''}${a.location ? ` · ${a.location}` : ''}`}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {acct?.endpoint && <Badge appearance="outline" title={acct.endpoint}>endpoint set</Badge>}
        {defaultName && acct?.name === defaultName && <Badge appearance="tint" color="brand">default</Badge>}
        <div className={s.grow} />
        {st.error && (
          <MessageBar intent={st.notDeployed ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{st.notDeployed ? 'No AI Foundry account provisioned' : 'Could not list accounts'}</MessageBarTitle>
              {st.error}{st.hint ? <><br /><Caption1>{st.hint}</Caption1></> : null}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>
      {/* Cross-subscription pickers — span every sub the user has RBAC for. */}
      <div className={s.bar} style={{ padding: 0, border: 'none', background: 'transparent', alignItems: 'flex-start' }}>
        <AzureResourcePicker
          type="Microsoft.CognitiveServices/accounts"
          label="Azure OpenAI / AI Services (any subscription)"
          placeholder="Select an Azure OpenAI / AI Services account across all subs"
          value={acct?.id}
          onChange={(r) => {
            if (!r) return;
            // Drive every tab at the cross-sub account. Tabs key off name+rg.
            onSelect({ id: r.id, name: r.name, resourceGroup: r.resourceGroup, location: r.location });
          }}
        />
        <AzureResourcePicker
          type="Microsoft.MachineLearningServices/workspaces"
          label="AI Foundry hub / project (any subscription)"
          placeholder="Select an AI Foundry hub or project across all subs"
          value={hubId}
          onChange={(r) => { setHubId(r?.id || ''); onHub?.(r ? { id: r.id, name: r.name } : null); }}
        />
      </div>
    </div>
  );
}

// ---------- Editor shell ----------

export function FoundryHubEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<string>('overview');
  const [nonce, setNonce] = useState(0);
  const [workspace, setWorkspace] = useState<any>(null);
  const [acct, setAcct] = useState<FoundryAccount | null>(null);
  const [crossSubHub, setCrossSubHub] = useState<{ id: string; name: string } | null>(null);
  const onWorkspace = useCallback((w: any) => setWorkspace(w), []);
  const onSelectAccount = useCallback((a: FoundryAccount | null) => setAcct(a), []);
  const onHub = useCallback((h: { id: string; name: string } | null) => setCrossSubHub(h), []);

  const portalUrl = useMemo(() => {
    const armId = workspace?.id || workspace?.armId;
    if (armId) return `https://portal.azure.com/#@/resource${armId}/overview`;
    return 'https://portal.azure.com/';
  }, [workspace]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Hub', actions: [
        { label: 'Reload', onClick: () => setNonce((n) => n + 1) },
        { label: 'Open in Azure portal', onClick: () => window.open(portalUrl, '_blank', 'noopener,noreferrer') },
      ]},
      { label: 'Build', actions: [
        { label: 'Agents', onClick: () => setTab('agents') },
        { label: 'Model catalog', onClick: () => setTab('catalog') },
        { label: 'Playgrounds', onClick: () => setTab('playgrounds') },
        { label: 'Chat playground', onClick: () => setTab('chat') },
      ]},
      { label: 'Playgrounds', actions: [
        { label: 'Images', onClick: () => setTab('images') },
        { label: 'Audio (Whisper)', onClick: () => setTab('audio') },
        { label: 'Speech (TTS)', onClick: () => setTab('speech') },
        { label: 'Completions', onClick: () => setTab('completions') },
        { label: 'Reasoning (o-series)', onClick: () => setTab('reasoning') },
        { label: 'Assistants', onClick: () => setTab('assistants') },
      ]},
      { label: 'Models', actions: [
        { label: 'Models + deployments', onClick: () => setTab('models') },
        { label: 'Fine-tuning', onClick: () => setTab('fine-tuning') },
        { label: 'Evaluations', onClick: () => setTab('evaluations') },
        { label: 'Quota + deploy gpt-4o-mini', onClick: () => setTab('quota') },
      ]},
    ]},
  ], [portalUrl]);

  const [selectedDeployment, setSelectedDeployment] = useState<string | null>(null);
  const onOpenDeployment = useCallback((name: string) => { setSelectedDeployment(name); setTab('models'); }, []);

  // Left navigator — the AI Foundry account tree, driven by the selected account.
  const leftPanel = (
    <FoundryAccountTree
      account={acct}
      selectedDeployment={selectedDeployment}
      onOpenDeployment={onOpenDeployment}
      onOpenAgents={() => setTab('agents')}
      refreshKey={nonce}
    />
  );

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} leftPanel={leftPanel} main={
      <>
        <AccountPickerBar acct={acct} onSelect={onSelectAccount} onHub={onHub} />
        {crossSubHub && (
          <div style={{ padding: '4px 16px' }}>
            <Badge appearance="tint" color="brand">Hub/project selected: {crossSubHub.name}</Badge>
          </div>
        )}
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="overview">Overview</Tab>
            <Tab value="agents">Agents</Tab>
            <Tab value="catalog">Model catalog</Tab>
            <Tab value="playgrounds">Playgrounds</Tab>
            <Tab value="chat">Chat</Tab>
            <Tab value="images">Images</Tab>
            <Tab value="audio">Audio</Tab>
            <Tab value="speech">Speech</Tab>
            <Tab value="completions">Completions</Tab>
            <Tab value="reasoning">Reasoning</Tab>
            <Tab value="assistants">Assistants</Tab>
            <Tab value="realtime">Real-time Audio</Tab>
            <Tab value="connections">Connections</Tab>
            <Tab value="models">Models + endpoints</Tab>
            <Tab value="fine-tuning">Fine-tuning</Tab>
            <Tab value="evaluations">Evaluations</Tab>
            <Tab value="quota">Quota + usage</Tab>
            <Tab value="networking">Networking</Tab>
            <Tab value="identity">Identity / RBAC</Tab>
            <Tab value="keys">Keys / endpoints</Tab>
            <Tab value="activity">Activity log</Tab>
            <Tab value="computes">Computes</Tab>
            <Tab value="datastores">Datastores</Tab>
            <Tab value="jobs">Jobs</Tab>
          </TabList>
        </div>
        {tab === 'overview' && <OverviewPanel nonce={nonce} onWorkspace={onWorkspace} />}
        <FoundryAgentsPanel active={tab === 'agents'} nonce={nonce} acct={acct} />
        <ModelCatalogPanel active={tab === 'catalog'} nonce={nonce} acct={acct} />
        <PlaygroundsLandingPanel active={tab === 'playgrounds'} onOpenChat={() => setTab('chat')} onOpenPlayground={(k) => setTab(k)} />
        <ChatPlaygroundPanel active={tab === 'chat'} nonce={nonce} acct={acct} />
        <ImagesPlaygroundPanel active={tab === 'images'} nonce={nonce} acct={acct} />
        <AudioPlaygroundPanel active={tab === 'audio'} nonce={nonce} acct={acct} />
        <SpeechPlaygroundPanel active={tab === 'speech'} nonce={nonce} acct={acct} />
        <CompletionsPlaygroundPanel active={tab === 'completions'} nonce={nonce} acct={acct} />
        <ReasoningPlaygroundPanel active={tab === 'reasoning'} nonce={nonce} acct={acct} />
        <AssistantsPlaygroundPanel active={tab === 'assistants'} nonce={nonce} acct={acct} />
        <RealtimeAudioPlaygroundPanel active={tab === 'realtime'} nonce={nonce} acct={acct} />
        <ConnectionsPanel active={tab === 'connections'} nonce={nonce} />
        <ModelsPanel active={tab === 'models'} nonce={nonce} acct={acct} />
        <FineTuningPanel active={tab === 'fine-tuning'} nonce={nonce} acct={acct} />
        <EvaluationsPanel active={tab === 'evaluations'} nonce={nonce} acct={acct} />
        <QuotaPanel active={tab === 'quota'} nonce={nonce} acct={acct} />
        <NetworkingPanel active={tab === 'networking'} nonce={nonce} acct={acct} />
        <IdentityPanel active={tab === 'identity'} nonce={nonce} acct={acct} />
        <KeysPanel active={tab === 'keys'} nonce={nonce} acct={acct} />
        <ActivityPanel active={tab === 'activity'} nonce={nonce} acct={acct} />
        <ComputesPanel active={tab === 'computes'} nonce={nonce} />
        <DatastoresPanel active={tab === 'datastores'} nonce={nonce} />
        <JobsPanel active={tab === 'jobs'} nonce={nonce} />
      </>
    } />
  );
}
