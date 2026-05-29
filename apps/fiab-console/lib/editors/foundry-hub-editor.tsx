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

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { ModelCatalogPanel, ChatPlaygroundPanel, PlaygroundsLandingPanel } from './foundry-playground';

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

function useLazyFetch<T>(url: string, active: boolean, nonce: number = 0) {
  const [state, setState] = useState<LoadState<T>>({ loading: false, data: null });
  const reload = useCallback(async () => {
    setState({ loading: true, data: null });
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!j.ok) { setState({ loading: false, data: null, error: j.error || `HTTP ${r.status}`, hint: j.hint, notDeployed: j.notDeployed }); return; }
      setState({ loading: false, data: j as unknown as T });
    } catch (e: any) {
      setState({ loading: false, data: null, error: e?.message || String(e) });
    }
  }, [url]);
  useEffect(() => {
    if (nonce > 0) setState({ loading: false, data: null });
  }, [nonce]);
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
          <>
            <span key={`k-${k}`} className={s.metaKey}>{k}</span>
            <span key={`v-${k}`}>{v ?? '—'}</span>
          </>
        ))}
      </div>
    </div>
  );
}

function ConnectionsPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st] = useLazyFetch<{ ok: boolean; connections: any[] }>(`/api/foundry/connections`, active, nonce);
  if (!active) return null;
  if (st.loading) return <div className={s.pad}><Spinner size="small" label="Loading connections…" labelPosition="after" /></div>;
  if (st.error) return <div className={s.pad}><GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /></div>;
  const items = st.data?.connections || [];
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

function DeployModelDialog({ open, onClose, onDeployed }: { open: boolean; onClose: () => void; onDeployed: () => void }) {
  const [catalog] = useLazyFetch<{ ok: boolean; models: CatalogModel[] }>(`/api/foundry/models-catalog`, open, 0);
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
        body: JSON.stringify({ modelName, deploymentName, skuName, capacity: Number(capacity) || 10 }),
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

function ModelsPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [models] = useLazyFetch<{ ok: boolean; models: any[] }>(`/api/items/ml-model`, active, nonce);
  const [dep, reloadDep] = useLazyFetch<{ ok: boolean; account?: any; deployments: ModelDeployment[] }>(`/api/foundry/model-deployments`, active, nonce);
  const [eps] = useLazyFetch<{ ok: boolean; endpoints: any[] }>(`/api/foundry/deployments`, active, nonce);
  const [deployOpen, setDeployOpen] = useState(false);
  if (!active) return null;
  const regModels = models.data?.models || [];
  const deployments = dep.data?.deployments || [];
  const endpoints = eps.data?.endpoints || [];
  return (
    <div className={s.pad}>
      <DeployModelDialog open={deployOpen} onClose={() => setDeployOpen(false)} onDeployed={reloadDep} />
      <div className={s.toolbar}>
        <Subtitle2>Model deployments</Subtitle2>
        <Button appearance="primary" onClick={() => setDeployOpen(true)}>+ Deploy a model</Button>
        <Button onClick={reloadDep}>Reload</Button>
        {dep.data?.account && <Badge appearance="outline">{dep.data.account.name} · {dep.data.account.location}</Badge>}
      </div>
      {dep.loading ? <Spinner size="small" /> : dep.error ? <GateBar msg={dep.error} hint={dep.hint} notDeployed={dep.notDeployed} /> : deployments.length === 0 ? (
        <EmptyText>No model deployments yet. Click “Deploy a model”.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Model deployments" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Deployment</TableHeaderCell><TableHeaderCell>Model</TableHeaderCell>
              <TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>SKU</TableHeaderCell>
              <TableHeaderCell>Capacity</TableHeaderCell><TableHeaderCell>State</TableHeaderCell>
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

function QuotaPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; location?: string; usages: { name: string; unit?: string; currentValue?: number; limit?: number }[] }>(`/api/foundry/quota`, active, nonce);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);
  if (!active) return null;

  const deployMini = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/quota', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelName: 'gpt-4o-mini' }) });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: j.message || `Deploying gpt-4o-mini (${j.deployment?.provisioningState})` });
      reload();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  const usages = st.data?.usages || [];
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

function NetworkingPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; networking: any }>(`/api/foundry/networking`, active, nonce);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!active) return null;
  const net = st.data?.networking;
  const isPublic = net?.publicNetworkAccess === 'Enabled';

  const toggle = async (next: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/networking', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicAccess: next }) });
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
            <span className={s.metaKey}>IP rules</span><span>{(net.ipRules || []).join(', ') || '—'}</span>
            <span className={s.metaKey}>VNet rules</span><span>{(net.virtualNetworkRules || []).length}</span>
          </div>
          <Subtitle2 style={{ marginTop: 8 }}>Private endpoints</Subtitle2>
          {(net.privateEndpoints || []).length === 0 ? <EmptyText>No private endpoint connections.</EmptyText> : (
            <div className={s.tableWrap}>
              <Table aria-label="Private endpoints" size="small">
                <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Group IDs</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {net.privateEndpoints.map((pe: any) => (
                    <TableRow key={pe.name}>
                      <TableCell className={s.cell}>{pe.name}</TableCell>
                      <TableCell className={s.cell}>{pe.state || '—'}</TableCell>
                      <TableCell className={s.cell}>{(pe.groupIds || []).join(', ') || '—'}</TableCell>
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

function IdentityPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; assignments: any[] }>(`/api/foundry/rbac`, active, nonce);
  if (!active) return null;
  const rows = st.data?.assignments || [];
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

function KeysPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; account?: any; keys: any }>(`/api/foundry/keys`, active, nonce);
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

function ActivityPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [st, reload] = useLazyFetch<{ ok: boolean; events: any[] }>(`/api/foundry/activity?hours=48`, active, nonce);
  if (!active) return null;
  const rows = st.data?.events || [];
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
  const items = st.data?.computes || [];
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
  const items = st.data?.datastores || [];
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
  const jobs = st.data?.jobs || [];
  const exps = st.data?.experiments || [];
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

// ---------- Editor shell ----------

export function FoundryHubEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState<string>('overview');
  const [nonce, setNonce] = useState(0);
  const [workspace, setWorkspace] = useState<any>(null);
  const onWorkspace = useCallback((w: any) => setWorkspace(w), []);

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
        { label: 'Model catalog', onClick: () => setTab('catalog') },
        { label: 'Chat playground', onClick: () => setTab('chat') },
      ]},
      { label: 'Models', actions: [
        { label: 'Models + deployments', onClick: () => setTab('models') },
        { label: 'Quota + deploy gpt-4o-mini', onClick: () => setTab('quota') },
      ]},
    ]},
  ], [portalUrl]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="overview">Overview</Tab>
            <Tab value="catalog">Model catalog</Tab>
            <Tab value="playgrounds">Playgrounds</Tab>
            <Tab value="chat">Chat</Tab>
            <Tab value="connections">Connections</Tab>
            <Tab value="models">Models + endpoints</Tab>
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
        <ModelCatalogPanel active={tab === 'catalog'} nonce={nonce} />
        <PlaygroundsLandingPanel active={tab === 'playgrounds'} onOpenChat={() => setTab('chat')} />
        <ChatPlaygroundPanel active={tab === 'chat'} nonce={nonce} />
        <ConnectionsPanel active={tab === 'connections'} nonce={nonce} />
        <ModelsPanel active={tab === 'models'} nonce={nonce} />
        <QuotaPanel active={tab === 'quota'} nonce={nonce} />
        <NetworkingPanel active={tab === 'networking'} nonce={nonce} />
        <IdentityPanel active={tab === 'identity'} nonce={nonce} />
        <KeysPanel active={tab === 'keys'} nonce={nonce} />
        <ActivityPanel active={tab === 'activity'} nonce={nonce} />
        <ComputesPanel active={tab === 'computes'} nonce={nonce} />
        <DatastoresPanel active={tab === 'datastores'} nonce={nonce} />
        <JobsPanel active={tab === 'jobs'} nonce={nonce} />
      </>
    } />
  );
}
