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
  Subtitle2, Body1, Caption1, Badge, Spinner, Button, Input, Switch, Textarea, Tooltip,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Home24Regular, Bot24Regular, Apps24Regular, Play24Regular, Chat24Regular,
  Image24Regular, MicRecord24Regular, PlugConnected24Regular, BrainCircuit24Regular,
  Beaker24Regular, ClipboardTaskListLtr24Regular, DataTrending24Regular, Gauge24Regular,
  Globe24Regular, ShieldKeyhole24Regular, Key24Regular, History24Regular,
  Server24Regular, Database24Regular, TaskListSquareLtr24Regular, Box24Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ModelCatalogPanel, ChatPlaygroundPanel, PlaygroundsLandingPanel, ImagesPlaygroundPanel, AudioPlaygroundPanel } from './foundry-playground';
import { AzureResourcePicker } from '@/lib/components/azure/azure-resource-picker';
import { FoundryAccountTree } from '@/lib/components/foundry/foundry-tree';
import { FoundryAgentsPanel } from '@/lib/components/foundry/foundry-agents';
import { LineChart, BarChart, StatTile, type LineSeries, type Bar } from '@/lib/components/foundry/foundry-charts';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, overflowX: 'auto' },
  // `minmax(0,1fr)` so a long unbroken value (Discovery URL, endpoint, principal
  // id) wraps instead of forcing the grid — and therefore the page — wider.
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'baseline' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  // Value cells in metaGrid: wrap long strings rather than overflow horizontally.
  metaVal: { minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  tableWrap: { overflow: 'auto', maxHeight: '460px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: { padding: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  // Compact, designed empty for stacked sub-section empties (icon chip + copy in
  // a dashed card) — lighter than the full hero EmptyState so several can stack
  // in one panel without ballooning its height.
  emptyCompact: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground3,
  },
  emptyChip: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: '20px',
  },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  secret: { fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
  // Stat tiles laid out as an even responsive grid (no ragged flex-wrap rows).
  statRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  // Charts laid out two-up on wide screens, single-column when narrow.
  chartGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  // A framed "card" around a chart + its heading/caption so the dashboard reads
  // as discrete panels rather than loose SVGs floating on the background.
  chartCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
    // Fixed-width SVG charts (width={420}/{620}) can exceed a narrow grid track;
    // scroll inside the card rather than pushing the page wider.
    minWidth: 0,
    overflowX: 'auto',
  },
  chartTitle: { fontWeight: 600 },
  chartCaption: { color: tokens.colorNeutralForeground3 },
  detailCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  // Reusable elevated panel for the fine-tuning upload / create-job + criterion
  // cards that were previously flat (border only, no elevation).
  panelCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
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

// Compact designed empty (gradient icon chip + copy in a dashed card) in place
// of the former bare italic line. Used for stacked sub-section empties; the
// existing descriptive copy at each call site flows through as the body, so no
// call-site changes are needed — only the visual treatment is upgraded.
function EmptyText({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.emptyCompact} role="status">
      <div className={s.emptyChip} aria-hidden>{icon ?? <Box24Regular />}</div>
      <Body1>{children}</Body1>
    </div>
  );
}

// Full-pane hero empty (gradient illustration + icon + body) for panels whose
// entire body is empty (Overview, Connections, Computes, Datastores, Jobs).
function EmptyPane({ title, body, icon }: { title: string; body: string; icon?: React.ReactNode }) {
  const s = useStyles();
  return <div className={s.pad}><EmptyState icon={icon ?? <Box24Regular />} title={title} body={body} /></div>;
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
  if (!w) return <EmptyPane icon={<Home24Regular />} title="No workspace data" body="No hub workspace metadata was returned for the selected account." />;
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
            <span key={`v-${k}`} className={s.metaVal}>{v ?? '—'}</span>
          </>
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
  if (!items.length) return <EmptyPane icon={<PlugConnected24Regular />} title="No connections yet" body="No connections are registered on this hub yet. Connections link the hub to Azure OpenAI, AI Search, storage and other resources." />;
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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

      <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Online endpoints</Subtitle2>
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

      <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Registered models</Subtitle2>
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
            <span className={s.metaKey}>Default ACL action</span><span className={s.metaVal}>{net.defaultAction || '—'}</span>
            <span className={s.metaKey}>IP rules</span><span className={s.metaVal}>{(Array.isArray(net.ipRules) ? net.ipRules : []).join(', ') || '—'}</span>
            <span className={s.metaKey}>VNet rules</span><span className={s.metaVal}>{(Array.isArray(net.virtualNetworkRules) ? net.virtualNetworkRules : []).length}</span>
          </div>
          <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Private endpoints</Subtitle2>
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
              <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Regional endpoints</Subtitle2>
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
  if (!items.length) return <EmptyPane icon={<Server24Regular />} title="No computes attached" body="No compute instances or clusters are attached to this hub yet." />;
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
  if (!items.length) return <EmptyPane icon={<Database24Regular />} title="No datastores registered" body="No datastores are registered on this hub yet. Datastores connect the hub to blob, ADLS Gen2 and other storage." />;
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
  if (!jobs.length) return <EmptyPane icon={<TaskListSquareLtr24Regular />} title="No jobs in this hub" body="No experiment jobs or runs have been recorded for this hub yet." />;
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
      <Subtitle2 style={{ marginTop: tokens.spacingVerticalL }}>Recent jobs</Subtitle2>
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

// ---- Evaluations: list evals → select → list runs; create-eval dialog ----

interface EvalSummary { id: string; name?: string; createdAt?: number; dataSourceConfig?: unknown; testingCriteria?: unknown; metadata?: Record<string, string> }
interface EvalRunSummary { id: string; name?: string; status?: string; model?: string; createdAt?: number; resultCounts?: { passed?: number; failed?: number; errored?: number; total?: number }; reportUrl?: string }

function fmtEpoch(s?: number): string {
  if (!s) return '—';
  try { return new Date(s * 1000).toLocaleString(); } catch { return String(s); }
}

// A single grader (testing_criteria) row in the create-eval repeater.
interface CriterionRow {
  type: 'string_check' | 'text_similarity' | 'label_model' | 'string_contains';
  name: string;
  reference: string;
  operation: string;     // string_check op (eq/ne/like/ilike) or similarity metric
  graderModel: string;   // label_model deployment
}

const GRADER_LABEL: Record<CriterionRow['type'], string> = {
  string_check: 'String check (exact / reference match)',
  text_similarity: 'Text similarity (BLEU / ROUGE / F1)',
  label_model: 'Model-graded (LLM pass/fail — groundedness, relevance, …)',
  string_contains: 'String contains (substring match)',
};

function defaultCriterion(type: CriterionRow['type'], idx: number): CriterionRow {
  return {
    type,
    name: `${type}-${idx + 1}`,
    reference: '{{item.expected}}',
    operation: type === 'text_similarity' ? 'fuzzy_match' : 'eq',
    graderModel: 'gpt-4o-mini',
  };
}

/** Map a CriterionRow → a real AOAI Evals testing_criteria object. */
function toTestingCriterion(c: CriterionRow): unknown {
  switch (c.type) {
    case 'label_model':
      return { type: 'label_model', name: c.name, model: c.graderModel, input: [{ role: 'user', content: `Grade the answer {{sample.output_text}} against ${c.reference}. Reply pass or fail.` }], labels: ['pass', 'fail'], passing_labels: ['pass'] };
    case 'text_similarity':
      return { type: 'text_similarity', name: c.name, input: '{{sample.output_text}}', reference: c.reference, evaluation_metric: c.operation, pass_threshold: 0.5 };
    case 'string_contains':
      return { type: 'string_check', name: c.name, input: '{{sample.output_text}}', reference: c.reference, operation: 'like' };
    case 'string_check':
    default:
      return { type: 'string_check', name: c.name, input: '{{sample.output_text}}', reference: c.reference, operation: c.operation };
  }
}

function CreateEvalDialog({ open, onClose, onCreated, acct }: { open: boolean; onClose: () => void; onCreated: () => void; acct: FoundryAccount | null }) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState<CriterionRow[]>([defaultCriterion('string_check', 0)]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);

  useEffect(() => { if (open) { setName(''); setRows([defaultCriterion('string_check', 0)]); setMsg(null); } }, [open]);

  const setRow = (i: number, patch: Partial<CriterionRow>) => setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addRow = () => setRows((rs) => [...rs, defaultCriterion('label_model', rs.length)]);
  const removeRow = (i: number) => setRows((rs) => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs);

  const submit = async () => {
    setBusy(true); setMsg(null);
    // REAL AOAI Evals schema: a custom data source + one OR MORE graders.
    const testingCriteria = rows.map(toTestingCriterion);
    const dataSourceConfig = { type: 'custom', item_schema: { type: 'object', properties: { input: { type: 'string' }, expected: { type: 'string' } } }, include_sample_schema: true };
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
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>Create an evaluation</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1>Defines an evaluation structure (data schema + one or more graders). After creating, upload a JSONL dataset and start a run from the Runs section below — no portal hop required.</Caption1>
              <Field label="Evaluation name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="qa-accuracy-eval" /></Field>
              <Body1 style={{ fontWeight: 600 }}>Testing criteria (graders)</Body1>
              {rows.map((c, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge }}>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="Grader type" style={{ flex: 1, minWidth: 0 }}>
                      <Dropdown value={GRADER_LABEL[c.type]} selectedOptions={[c.type]} onOptionSelect={(_, d) => d.optionValue && setRow(i, { type: d.optionValue as CriterionRow['type'] })}>
                        {(Object.keys(GRADER_LABEL) as CriterionRow['type'][]).map((t) => <Option key={t} value={t}>{GRADER_LABEL[t]}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Criterion name"><Input value={c.name} onChange={(_, d) => setRow(i, { name: d.value })} /></Field>
                    <Button appearance="subtle" disabled={rows.length <= 1} onClick={() => removeRow(i)} title="Remove this criterion">−</Button>
                  </div>
                  <Field label="Reference template (compared to {{sample.output_text}})">
                    <Input value={c.reference} onChange={(_, d) => setRow(i, { reference: d.value })} placeholder="{{item.expected}}" />
                  </Field>
                  {c.type === 'string_check' && (
                    <Field label="Operation">
                      <Dropdown value={c.operation} selectedOptions={[c.operation]} onOptionSelect={(_, d) => d.optionValue && setRow(i, { operation: d.optionValue })}>
                        <Option value="eq">Equals</Option>
                        <Option value="ne">Not equals</Option>
                        <Option value="like">Like (case-sensitive contains)</Option>
                        <Option value="ilike">ILike (case-insensitive contains)</Option>
                      </Dropdown>
                    </Field>
                  )}
                  {c.type === 'text_similarity' && (
                    <Field label="Similarity metric">
                      <Dropdown value={c.operation} selectedOptions={[c.operation]} onOptionSelect={(_, d) => d.optionValue && setRow(i, { operation: d.optionValue })}>
                        <Option value="fuzzy_match">Fuzzy match</Option>
                        <Option value="bleu">BLEU</Option>
                        <Option value="rouge_l">ROUGE-L</Option>
                        <Option value="meteor">METEOR</Option>
                        <Option value="f1_score">F1 score</Option>
                      </Dropdown>
                    </Field>
                  )}
                  {c.type === 'label_model' && (
                    <Field label="Grader model (deployment)"><Input value={c.graderModel} onChange={(_, d) => setRow(i, { graderModel: d.value })} placeholder="gpt-4o-mini" /></Field>
                  )}
                </div>
              ))}
              <Button appearance="secondary" onClick={addRow}>+ Add criterion</Button>
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

// ---- Start-run dialog: upload JSONL → start a grading run on a deployment ----

function StartRunDialog({ open, onClose, onStarted, evalItem, acct }: {
  open: boolean; onClose: () => void; onStarted: () => void; evalItem: EvalSummary | null; acct: FoundryAccount | null;
}) {
  const [dep] = useLazyFetch<{ ok: boolean; deployments: { name: string; modelName?: string }[] }>(`/api/foundry/model-deployments`, open, 0, acct);
  const [runName, setRunName] = useState('');
  const [model, setModel] = useState('');
  const [fileId, setFileId] = useState('');
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);
  const deployments = dep.data?.deployments || [];

  useEffect(() => { if (open) { setRunName(''); setFileId(''); setFileName(''); setMsg(null); } }, [open]);
  useEffect(() => { if (deployments[0] && !model) setModel(deployments[0].name); }, [deployments, model]);

  const upload = async (f: File) => {
    setUploading(true); setMsg(null);
    try {
      const form = new FormData();
      form.append('file', f, f.name);
      const ab = acctBody(acct);
      if (ab.account) form.append('account', ab.account);
      if (ab.rg) form.append('rg', ab.rg);
      const r = await fetch('/api/foundry/evaluations/files', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setFileId(j.file?.id || ''); setFileName(f.name);
      setMsg({ intent: 'success', text: `Uploaded ${f.name} (${j.file?.bytes ?? '?'} bytes) → ${j.file?.id}` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setUploading(false); }
  };

  const start = async () => {
    if (!evalItem || !fileId || !model) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/evaluations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start_run', evalId: evalItem.id, fileId, model, name: runName.trim() || undefined, ...acctBody(acct) }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Started run "${j.run?.name || j.run?.id}" (${j.run?.status || 'queued'}).` });
      onStarted();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Start a run · {evalItem?.name || evalItem?.id}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1>Upload a JSONL dataset (one object per line with an <code>input</code> and <code>expected</code> field), pick the deployment to grade, and start. The run samples the model per row, then applies this evaluation’s graders.</Caption1>
              <Field label="Run name (optional)"><Input value={runName} onChange={(_, d) => setRunName(d.value)} placeholder="baseline-run" /></Field>
              <Field label="Deployment to grade" required>
                <Dropdown value={model} selectedOptions={model ? [model] : []} placeholder={deployments.length ? 'Select a deployment' : 'No deployments'}
                  onOptionSelect={(_, d) => d.optionValue && setModel(d.optionValue)}>
                  {deployments.map((d) => <Option key={d.name} value={d.name}>{`${d.name}${d.modelName ? ` (${d.modelName})` : ''}`}</Option>)}
                </Dropdown>
              </Field>
              <Field label="JSONL dataset" required>
                <input type="file" accept=".jsonl,.json,application/jsonl,text/plain" disabled={uploading}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
              </Field>
              {fileId ? <Caption1>Uploaded file: <code>{fileName}</code> ({fileId})</Caption1> : null}
              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Close</Button>
            <Button appearance="primary" disabled={busy || uploading || !fileId || !model} onClick={start}>{busy ? 'Starting…' : 'Start run'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

interface EvalOutputItem { id: string; status?: string; model?: string; datasourceItemIndex?: number; results: { name?: string; passed?: boolean; score?: number }[]; sampleOutput?: string }

/**
 * A7 — eval detail card. Renders the data-source schema (item fields the eval
 * grades against) and the testing criteria (graders) carried on the selected
 * eval. Real data from the AOAI Evals list (mapEval → dataSourceConfig /
 * testingCriteria); no extra fetch. Surfaces the Foundry portal's "evaluation
 * details" view that was previously runs-only.
 */
function EvalDetailCard({ evalItem }: { evalItem: EvalSummary }) {
  const s = useStyles();
  const dsc = evalItem.dataSourceConfig as any;
  const criteria = Array.isArray(evalItem.testingCriteria) ? (evalItem.testingCriteria as any[]) : [];
  // Pull item-schema field names from the custom data-source schema when present.
  const itemSchema = dsc?.item_schema?.properties || dsc?.item_schema || dsc?.schema?.properties;
  const fields: string[] = itemSchema && typeof itemSchema === 'object' ? Object.keys(itemSchema) : [];
  return (
    <div className={s.detailCard}>
      <Body1 style={{ fontWeight: 600 }}>Evaluation details</Body1>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalL}`, alignItems: 'baseline' }}>
        <Caption1>ID</Caption1><Caption1 style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{evalItem.id}</Caption1>
        <Caption1>Data-source type</Caption1><Caption1>{dsc?.type || 'custom'}</Caption1>
        <Caption1>Item schema fields</Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
          {fields.length ? fields.map((f) => <Badge key={f} appearance="outline">{f}</Badge>) : <Caption1>—</Caption1>}
        </div>
      </div>
      <Caption1 style={{ fontWeight: 600, marginTop: tokens.spacingVerticalXS }}>Testing criteria ({criteria.length})</Caption1>
      {criteria.length === 0 ? <Caption1>No graders defined.</Caption1> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
          {criteria.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge appearance="tint" color="brand">{c?.type || 'grader'}</Badge>
              <Caption1>{c?.name || `criterion ${i + 1}`}</Caption1>
              {c?.model && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· model: {c.model}</Caption1>}
              {typeof c?.pass_threshold === 'number' && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· threshold: {c.pass_threshold}</Caption1>}
              {Array.isArray(c?.evaluation_metrics) && c.evaluation_metrics.length > 0 && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· {c.evaluation_metrics.join(', ')}</Caption1>
              )}
            </div>
          ))}
        </div>
      )}
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
  const [selectedRun, setSelectedRun] = useState<EvalRunSummary | null>(null);
  const [items, setItems] = useState<{ loading: boolean; list: EvalOutputItem[]; error?: string; hint?: string }>({ loading: false, list: [] });
  const [actionMsg, setActionMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const loadRuns = useCallback(async (e: EvalSummary) => {
    setRuns({ loading: true, list: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(e.id)}`, acct));
      const j = await r.json();
      if (!j.ok) { setRuns({ loading: false, list: [], error: j.error, hint: j.hint }); return; }
      setRuns({ loading: false, list: Array.isArray(j.runs) ? j.runs : [] });
    } catch (err: any) { setRuns({ loading: false, list: [], error: err?.message || String(err) }); }
  }, [acct]);

  const loadItems = useCallback(async (evalId: string, run: EvalRunSummary) => {
    setItems({ loading: true, list: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(evalId)}&runId=${encodeURIComponent(run.id)}&items=1`, acct));
      const j = await r.json();
      if (!j.ok) { setItems({ loading: false, list: [], error: j.error, hint: j.hint }); return; }
      setItems({ loading: false, list: Array.isArray(j.items) ? j.items : [] });
    } catch (err: any) { setItems({ loading: false, list: [], error: err?.message || String(err) }); }
  }, [acct]);

  // Drop the open eval/run when the account changes / panel reloads.
  useEffect(() => { setSelected(null); setSelectedRun(null); setRuns({ loading: false, list: [] }); setItems({ loading: false, list: [] }); }, [acct, nonce]);
  useEffect(() => { if (selected) loadRuns(selected); setSelectedRun(null); setItems({ loading: false, list: [] }); }, [selected, loadRuns]);
  useEffect(() => { if (selected && selectedRun) loadItems(selected.id, selectedRun); }, [selected, selectedRun, loadItems]);

  const delEval = async (e: EvalSummary) => {
    setActionMsg(null);
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(e.id)}`, acct), { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setActionMsg({ intent: 'success', text: `Deleted evaluation "${e.name || e.id}".` });
      if (selected?.id === e.id) setSelected(null);
      reload();
    } catch (err: any) { setActionMsg({ intent: 'error', text: err?.message || String(err) }); }
  };

  const delRun = async (run: EvalRunSummary) => {
    if (!selected) return;
    setActionMsg(null);
    try {
      const r = await fetch(withAccount(`/api/foundry/evaluations?evalId=${encodeURIComponent(selected.id)}&runId=${encodeURIComponent(run.id)}`, acct), { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setActionMsg({ intent: 'success', text: `Deleted run "${run.name || run.id}".` });
      if (selectedRun?.id === run.id) setSelectedRun(null);
      loadRuns(selected);
    } catch (err: any) { setActionMsg({ intent: 'error', text: err?.message || String(err) }); }
  };

  if (!active) return null;
  const evals = Array.isArray(st.data?.evals) ? st.data!.evals : [];

  return (
    <div className={s.pad}>
      <CreateEvalDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={reload} acct={acct} />
      <StartRunDialog open={runOpen} onClose={() => setRunOpen(false)} onStarted={() => { if (selected) loadRuns(selected); }} evalItem={selected} acct={acct} />
      <div className={s.toolbar}>
        <Subtitle2>Evaluations</Subtitle2>
        <Button appearance="primary" onClick={() => setCreateOpen(true)}>+ New evaluation</Button>
        <Button onClick={reload}>Reload</Button>
        {st.data?.account && <Badge appearance="outline">{st.data.account.name}{st.data.account.location ? ` · ${st.data.account.location}` : ''}</Badge>}
      </div>
      <Caption1>Quality, safety and performance evaluations against your deployed models (Azure OpenAI Evals). Select an evaluation to view its grading runs, start a new run, or drill into per-row results.</Caption1>
      {actionMsg && <MessageBar intent={actionMsg.intent}><MessageBarBody>{actionMsg.text}</MessageBarBody></MessageBar>}
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
                    <Button size="small" appearance="subtle" onClick={() => setSelected(e)}>View runs</Button>
                    <Button size="small" appearance="subtle" onClick={() => delEval(e)}>Delete</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected && (
        <>
          {/* A7 — eval detail: the data-source schema + testing criteria the eval grades on. */}
          <EvalDetailCard evalItem={selected} />
          <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalM }}>
            <Subtitle2>Runs · {selected.name || selected.id}</Subtitle2>
            <Button size="small" appearance="primary" onClick={() => setRunOpen(true)}>+ Start a run</Button>
            <Button size="small" onClick={() => loadRuns(selected)}>Reload runs</Button>
          </div>
          {runs.loading ? <Spinner size="small" /> : runs.error ? <GateBar msg={runs.error} hint={runs.hint} /> : runs.list.length === 0 ? (
            <EmptyText>No runs for this evaluation yet. Click “Start a run”, upload a JSONL dataset and pick a deployment to grade.</EmptyText>
          ) : (
            <div className={s.tableWrap}>
              <Table aria-label="Evaluation runs" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Run</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell><TableHeaderCell>Passed</TableHeaderCell>
                  <TableHeaderCell>Failed</TableHeaderCell><TableHeaderCell>Total</TableHeaderCell>
                  <TableHeaderCell>Report</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {runs.list.map((r) => (
                    <TableRow key={r.id} style={{ background: selectedRun?.id === r.id ? tokens.colorNeutralBackground2 : undefined }}>
                      <TableCell className={s.cell}><strong>{r.name || r.id}</strong></TableCell>
                      <TableCell className={s.cell}>
                        <Badge appearance="tint" color={r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : 'informative'}>{r.status || '—'}</Badge>
                      </TableCell>
                      <TableCell className={s.cell}>{r.model || '—'}</TableCell>
                      <TableCell className={s.cell}>{r.resultCounts?.passed ?? '—'}</TableCell>
                      <TableCell className={s.cell}>{r.resultCounts?.failed ?? '—'}</TableCell>
                      <TableCell className={s.cell}>{r.resultCounts?.total ?? '—'}</TableCell>
                      <TableCell className={s.cell}>{r.reportUrl ? <a href={r.reportUrl} target="_blank" rel="noopener noreferrer">Open</a> : '—'}</TableCell>
                      <TableCell className={s.cell}>
                        <Button size="small" appearance="subtle" onClick={() => setSelectedRun(r)}>Results</Button>
                        <Button size="small" appearance="subtle" onClick={() => delRun(r)}>Delete</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {/* C8 + C9 — pass-rate trend across runs + per-run passed/failed compare. */}
          {!runs.loading && !runs.error && runs.list.length > 0 && (() => {
            // Only completed runs with a known total contribute a pass-rate point.
            const graded = runs.list.filter((r) => (r.resultCounts?.total ?? 0) > 0);
            if (!graded.length) return null;
            // Trend: oldest→newest by createdAt; x = run index, y = pass-rate %.
            const ordered = [...graded].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
            const trend: LineSeries[] = [{
              label: 'Pass rate %', color: tokens.colorPaletteGreenForeground1,
              points: ordered.map((r, i) => ({ x: i + 1, y: Math.round(((r.resultCounts!.passed ?? 0) / (r.resultCounts!.total || 1)) * 100) })),
            }];
            const compareBars: Bar[] = ordered.map((r) => ({
              label: r.name || r.id,
              value: r.resultCounts?.passed ?? 0,
              value2: r.resultCounts?.failed ?? Math.max(0, (r.resultCounts?.total ?? 0) - (r.resultCounts?.passed ?? 0)),
            }));
            return (
              <div className={s.chartGrid} style={{ marginTop: tokens.spacingVerticalM }}>
                <div className={s.chartCard}>
                  <Body1 className={s.chartTitle}>Pass-rate trend</Body1>
                  <Caption1 className={s.chartCaption}>Pass rate across this evaluation’s graded runs (oldest → newest).</Caption1>
                  <LineChart series={trend} xLabel="run #" yLabel="%" yFormat={(v) => `${Math.round(v)}%`} width={420} height={200} />
                </div>
                <div className={s.chartCard}>
                  <Body1 className={s.chartTitle}>Compare runs (passed vs failed)</Body1>
                  <Caption1 className={s.chartCaption}>Side-by-side passed (green) / failed (red) counts per run.</Caption1>
                  <BarChart bars={compareBars} width={420} />
                </div>
              </div>
            );
          })()}
        </>
      )}

      {selected && selectedRun && (
        <>
          <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Per-row results · {selectedRun.name || selectedRun.id}</Subtitle2>
          {items.loading ? <Spinner size="small" /> : items.error ? <GateBar msg={items.error} hint={items.hint} /> : items.list.length === 0 ? (
            <EmptyText>No output items for this run yet. Items appear once the run completes grading.</EmptyText>
          ) : (
            <div className={s.tableWrap}>
              <Table aria-label="Run output items" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Row</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Criteria results</TableHeaderCell><TableHeaderCell>Sample output</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {items.list.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className={s.cell}>{it.datasourceItemIndex ?? '—'}</TableCell>
                      <TableCell className={s.cell}>{it.status || '—'}</TableCell>
                      <TableCell className={s.cell}>
                        {it.results.length ? it.results.map((r, i) => (
                          <Badge key={i} appearance="tint" color={r.passed === true ? 'success' : r.passed === false ? 'danger' : 'informative'} style={{ marginRight: tokens.spacingHorizontalXS }}>
                            {(r.name || 'grader')}{r.score !== undefined ? ` ${r.score.toFixed(2)}` : ''}{r.passed === true ? ' ✓' : r.passed === false ? ' ✗' : ''}
                          </Badge>
                        )) : '—'}
                      </TableCell>
                      <TableCell className={s.cell}>{it.sampleOutput ? it.sampleOutput.slice(0, 120) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Monitoring / Observability — Application analytics dashboard (A6) ----
//
// Foundry portal's Monitoring → "Application analytics": token consumption,
// request volume + failures, latency p50/p95, and a per-operation latency
// breakdown — all aggregated from the hub's bound Application Insights resource
// (the same one the tracing span-tree uses). KQL runs server-side in
// /api/foundry/observability; honest 503 gate when no App Insights is bound.

interface ObsSummary {
  hours: number;
  totals: { requests: number; dependencies: number; failures: number; inputTokens: number; outputTokens: number; p50Ms?: number; p95Ms?: number };
  requestsOverTime: { t: string; count: number; failed: number }[];
  tokensOverTime: { t: string; input: number; output: number }[];
  byOperation: { operation: string; count: number; p95Ms?: number; failed: number }[];
}

function MonitoringPanel({ active, nonce }: { active: boolean; nonce: number }) {
  const s = useStyles();
  const [hours, setHours] = useState('24');
  // useLazyFetch keys off the resolved URL, so changing hours re-fetches.
  const [st, reload] = useLazyFetch<{ ok: boolean; summary: ObsSummary }>(`/api/foundry/observability?hours=${hours}`, active, nonce);
  const sum = st.data?.summary;

  // Sortable Operations table (defaults to slowest-first by p95, like the chart).
  // NOTE: hooks must run before the early `!active` return — keep them here.
  type OpCol = 'operation' | 'count' | 'p95Ms' | 'failed';
  const [opSort, setOpSort] = useState<{ col: OpCol; dir: 'ascending' | 'descending' }>({ col: 'p95Ms', dir: 'descending' });
  const toggleOpSort = (col: OpCol) =>
    setOpSort((prev) => (prev.col === col ? { col, dir: prev.dir === 'ascending' ? 'descending' : 'ascending' } : { col, dir: col === 'operation' ? 'ascending' : 'descending' }));
  const sortedOps = useMemo(() => {
    const list = sum ? [...sum.byOperation] : [];
    const { col, dir } = opSort;
    const sign = dir === 'ascending' ? 1 : -1;
    return list.sort((a, b) => {
      if (col === 'operation') return sign * (a.operation || '').localeCompare(b.operation || '');
      return sign * (((a[col] as number) ?? 0) - ((b[col] as number) ?? 0));
    });
  }, [sum, opSort]);

  if (!active) return null;

  const reqSeries: LineSeries[] = sum ? [
    { label: 'Requests', color: tokens.colorBrandForeground1, points: sum.requestsOverTime.map((r) => ({ x: new Date(r.t).getTime(), y: r.count })) },
    { label: 'Failures', color: tokens.colorPaletteRedForeground1, points: sum.requestsOverTime.map((r) => ({ x: new Date(r.t).getTime(), y: r.failed })) },
  ] : [];
  const tokSeries: LineSeries[] = sum ? [
    { label: 'Input tokens', color: tokens.colorPalettePurpleForeground2, points: sum.tokensOverTime.map((r) => ({ x: new Date(r.t).getTime(), y: r.input })) },
    { label: 'Output tokens', color: tokens.colorPaletteGreenForeground1, points: sum.tokensOverTime.map((r) => ({ x: new Date(r.t).getTime(), y: r.output })) },
  ] : [];
  const opBars: Bar[] = sum ? sum.byOperation.map((o) => ({ label: o.operation, value: Math.round(o.p95Ms || 0) })) : [];
  const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Subtitle2>Monitoring · Application analytics</Subtitle2>
        <Field label="Window" orientation="horizontal">
          <Dropdown value={`${hours}h`} selectedOptions={[hours]} onOptionSelect={(_, d) => d.optionValue && setHours(d.optionValue)} style={{ minWidth: 110 }}>
            <Option value="6">Last 6 hours</Option>
            <Option value="24">Last 24 hours</Option>
            <Option value="168">Last 7 days</Option>
            <Option value="720">Last 30 days</Option>
          </Dropdown>
        </Field>
        <Button onClick={reload}>Reload</Button>
      </div>
      <Caption1>Token consumption, request volume, latency and exceptions from the Foundry hub’s bound Application Insights resource. Same resource as Tracing — aggregated over the selected window.</Caption1>
      {st.loading ? <Spinner size="small" /> : st.error ? <GateBar msg={st.error} hint={st.hint} notDeployed={st.notDeployed} /> : !sum ? (
        <EmptyText>No telemetry available.</EmptyText>
      ) : (
        <>
          <div className={s.statRow}>
            <StatTile label="Requests" value={fmtNum(sum.totals.requests)} />
            <StatTile label="Dependency calls" value={fmtNum(sum.totals.dependencies)} />
            <StatTile label="Failures" value={fmtNum(sum.totals.failures)} sub={sum.totals.requests + sum.totals.dependencies > 0 ? `${((sum.totals.failures / (sum.totals.requests + sum.totals.dependencies)) * 100).toFixed(1)}% error rate` : undefined} />
            <StatTile label="Input tokens" value={fmtNum(sum.totals.inputTokens)} />
            <StatTile label="Output tokens" value={fmtNum(sum.totals.outputTokens)} />
            <StatTile label="Latency p50" value={sum.totals.p50Ms !== undefined ? `${Math.round(sum.totals.p50Ms)} ms` : '—'} />
            <StatTile label="Latency p95" value={sum.totals.p95Ms !== undefined ? `${Math.round(sum.totals.p95Ms)} ms` : '—'} />
          </div>
          <div className={s.chartGrid} style={{ marginTop: tokens.spacingVerticalS }}>
            <div className={s.chartCard}>
              <Body1 className={s.chartTitle}>Request volume</Body1>
              <Caption1 className={s.chartCaption}>Requests vs failures over time.</Caption1>
              <LineChart series={reqSeries} xIsTime xLabel="time" yLabel="count" yFormat={(v) => fmtNum(Math.round(v))} width={480} height={220} emptyText="No requests in this window." />
            </div>
            <div className={s.chartCard}>
              <Body1 className={s.chartTitle}>Token consumption</Body1>
              <Caption1 className={s.chartCaption}>GenAI input/output tokens over time (OpenTelemetry usage spans).</Caption1>
              <LineChart series={tokSeries} xIsTime xLabel="time" yLabel="tokens" yFormat={(v) => fmtNum(Math.round(v))} width={480} height={220} emptyText="No token usage telemetry in this window." />
            </div>
          </div>
          <div className={s.chartCard} style={{ marginTop: tokens.spacingVerticalS }}>
            <Body1 className={s.chartTitle}>Latency by operation (p95)</Body1>
            <Caption1 className={s.chartCaption}>Slowest operations by 95th-percentile duration (top 12 by call count).</Caption1>
            <BarChart bars={opBars} width={620} valueFormat={(v) => `${v} ms`} emptyText="No operations recorded in this window." />
          </div>
          <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Operations ({sum.byOperation.length})</Subtitle2>
          <Caption1 className={s.chartCaption}>Click a column header to sort.</Caption1>
          <div className={s.tableWrap} style={{ maxHeight: 260 }}>
            <Table size="small" aria-label="Operations" sortable>
              <TableHeader><TableRow>
                <TableHeaderCell
                  sortDirection={opSort.col === 'operation' ? opSort.dir : undefined}
                  onClick={() => toggleOpSort('operation')}
                >Operation</TableHeaderCell>
                <TableHeaderCell
                  sortDirection={opSort.col === 'count' ? opSort.dir : undefined}
                  onClick={() => toggleOpSort('count')}
                >Calls</TableHeaderCell>
                <TableHeaderCell
                  sortDirection={opSort.col === 'p95Ms' ? opSort.dir : undefined}
                  onClick={() => toggleOpSort('p95Ms')}
                >p95 (ms)</TableHeaderCell>
                <TableHeaderCell
                  sortDirection={opSort.col === 'failed' ? opSort.dir : undefined}
                  onClick={() => toggleOpSort('failed')}
                >Failures</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {sortedOps.map((o, i) => (
                  <TableRow key={i}>
                    <TableCell className={s.cell}>{o.operation || '—'}</TableCell>
                    <TableCell className={s.cell}>{o.count}</TableCell>
                    <TableCell className={s.cell}>{o.p95Ms !== undefined ? Math.round(o.p95Ms) : '—'}</TableCell>
                    <TableCell className={s.cell}>{o.failed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Fine-tuning: upload training data → create job → monitor jobs + events ----

interface FineTuningFile { id: string; filename?: string; bytes?: number; status?: string }
interface FineTuningJob { id: string; status?: string; model?: string; fineTunedModel?: string | null; trainingFile?: string; validationFile?: string | null; createdAt?: number; hyperparameters?: { n_epochs?: number | string; batch_size?: number | string; learning_rate_multiplier?: number | string }; trainedTokens?: number | null; error?: { message?: string } | null }
interface FineTuningEvent { createdAt?: number; level?: string; message?: string; step?: number; trainingLoss?: number; validationLoss?: number }

function FineTuningPanel({ active, nonce, acct }: { active: boolean; nonce: number; acct: FoundryAccount | null }) {
  const s = useStyles();
  const [jobsState, reloadJobs] = useLazyFetch<{ ok: boolean; account?: any; jobs: FineTuningJob[] }>(`/api/foundry/fine-tuning`, active, nonce, acct);
  const [filesState, reloadFiles] = useLazyFetch<{ ok: boolean; files: FineTuningFile[] }>(`/api/foundry/fine-tuning?files=1`, active, nonce, acct);
  const [catalog] = useLazyFetch<{ ok: boolean; models: { name: string; version?: string }[] }>(`/api/foundry/models-catalog`, active, nonce, acct);

  const [model, setModel] = useState('');
  const [trainingFileId, setTrainingFileId] = useState('');
  const [validationFileId, setValidationFileId] = useState('');
  const [suffix, setSuffix] = useState('');
  const [epochs, setEpochs] = useState('');
  const [batchSize, setBatchSize] = useState('');
  const [lrMult, setLrMult] = useState('');
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);

  // Selected job → events drill.
  const [selectedJob, setSelectedJob] = useState<FineTuningJob | null>(null);
  const [events, setEvents] = useState<{ loading: boolean; list: FineTuningEvent[]; error?: string }>({ loading: false, list: [] });

  const files = filesState.data?.files || [];
  const jobs = jobsState.data?.jobs || [];
  // Fine-tunable model heuristic (same family list as the catalog Fine-tuning filter).
  const fineTunable = useMemo(() => (catalog.data?.models || []).filter((m) => /gpt-4o|gpt-4\.1|gpt-35|gpt-3.5|phi|mistral|llama/i.test(m.name)), [catalog.data]);

  useEffect(() => { if (fineTunable[0] && !model) setModel(fineTunable[0].name); }, [fineTunable, model]);
  useEffect(() => { if (files[0] && !trainingFileId) setTrainingFileId(files[0].id); }, [files, trainingFileId]);
  useEffect(() => { setModel(''); setTrainingFileId(''); setValidationFileId(''); setSelectedJob(null); }, [acct]);

  const loadEvents = useCallback(async (job: FineTuningJob) => {
    setEvents({ loading: true, list: [] });
    try {
      const r = await fetch(withAccount(`/api/foundry/fine-tuning/${encodeURIComponent(job.id)}`, acct));
      const j = await r.json();
      if (!j.ok) { setEvents({ loading: false, list: [], error: j.error }); return; }
      setEvents({ loading: false, list: Array.isArray(j.events) ? j.events : [] });
    } catch (e: any) { setEvents({ loading: false, list: [], error: e?.message || String(e) }); }
  }, [acct]);

  useEffect(() => { if (selectedJob) loadEvents(selectedJob); }, [selectedJob, loadEvents]);

  const upload = async (f: File) => {
    setUploading(true); setMsg(null);
    try {
      const form = new FormData();
      form.append('file', f, f.name);
      const ab = acctBody(acct);
      if (ab.account) form.append('account', ab.account);
      if (ab.rg) form.append('rg', ab.rg);
      const r = await fetch('/api/foundry/fine-tuning/files', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Uploaded ${f.name} → ${j.file?.id}` });
      setTrainingFileId(j.file?.id || trainingFileId);
      reloadFiles();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setUploading(false); }
  };

  const createJob = async () => {
    if (!model || !trainingFileId) return;
    setCreating(true); setMsg(null);
    const hyperparameters: any = {};
    if (epochs.trim()) hyperparameters.n_epochs = Number(epochs) || epochs;
    if (batchSize.trim()) hyperparameters.batch_size = Number(batchSize) || batchSize;
    if (lrMult.trim()) hyperparameters.learning_rate_multiplier = Number(lrMult) || lrMult;
    try {
      const r = await fetch('/api/foundry/fine-tuning', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, trainingFileId,
          validationFileId: validationFileId || undefined,
          suffix: suffix.trim() || undefined,
          hyperparameters: Object.keys(hyperparameters).length ? hyperparameters : undefined,
          ...acctBody(acct),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Created fine-tuning job "${j.job?.id}" (${j.job?.status || 'queued'}).` });
      reloadJobs();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setCreating(false); }
  };

  const cancelJob = async (job: FineTuningJob) => {
    setMsg(null);
    try {
      const r = await fetch(withAccount(`/api/foundry/fine-tuning/${encodeURIComponent(job.id)}`, acct), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', ...acctBody(acct) }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setMsg({ intent: 'success', text: `Cancelled job "${job.id}".` });
      reloadJobs();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  };

  if (!active) return null;

  return (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Subtitle2>Fine-tuning</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
        <Button onClick={() => { reloadJobs(); reloadFiles(); }}>Reload</Button>
        {jobsState.data?.account && <Badge appearance="outline">{jobsState.data.account.name}{jobsState.data.account.location ? ` · ${jobsState.data.account.location}` : ''}</Badge>}
      </div>
      <Caption1>Customize a base model on your own JSONL training data (Azure OpenAI fine-tuning). Standard / RegionalStandard SKUs only — Global training jobs are not supported.</Caption1>
      {jobsState.error && <GateBar msg={jobsState.error} hint={jobsState.hint} notDeployed={jobsState.notDeployed} />}
      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: tokens.spacingHorizontalL, alignItems: 'start' }}>
        {/* Upload training data */}
        <div className={s.panelCard}>
          <Body1 style={{ fontWeight: 600 }}>Upload training data</Body1>
          <Caption1>JSONL with chat-format examples (one <code>{'{ "messages": [...] }'}</code> per line).</Caption1>
          <input type="file" accept=".jsonl,.json,text/plain" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          {filesState.loading ? <Spinner size="tiny" /> : files.length === 0 ? <Caption1>No fine-tune files uploaded yet.</Caption1> : (
            <div className={s.tableWrap} style={{ maxHeight: 180 }}>
              <Table size="small" aria-label="Fine-tune files">
                <TableHeader><TableRow><TableHeaderCell>File</TableHeaderCell><TableHeaderCell>ID</TableHeaderCell><TableHeaderCell>Bytes</TableHeaderCell></TableRow></TableHeader>
                <TableBody>
                  {files.map((f) => (
                    <TableRow key={f.id}><TableCell className={s.cell}>{f.filename || '—'}</TableCell><TableCell className={s.cell}>{f.id}</TableCell><TableCell className={s.cell}>{f.bytes ?? '—'}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* Create job */}
        <div className={s.panelCard}>
          <Body1 style={{ fontWeight: 600 }}>Create a fine-tuning job</Body1>
          <Field label="Base model">
            {fineTunable.length ? (
              <Dropdown value={model} selectedOptions={model ? [model] : []} placeholder="Select a fine-tunable model" onOptionSelect={(_, d) => d.optionValue && setModel(d.optionValue)}>
                {fineTunable.map((m) => <Option key={m.name} value={m.name}>{`${m.name}${m.version ? ` (v${m.version})` : ''}`}</Option>)}
              </Dropdown>
            ) : (
              <Input value={model} onChange={(_, d) => setModel(d.value)} placeholder="gpt-4o-mini" />
            )}
          </Field>
          <Field label="Training file" required>
            <Dropdown value={files.find((f) => f.id === trainingFileId)?.filename || trainingFileId} selectedOptions={trainingFileId ? [trainingFileId] : []}
              placeholder={files.length ? 'Select a training file' : 'Upload a file first'} onOptionSelect={(_, d) => d.optionValue && setTrainingFileId(d.optionValue)}>
              {files.map((f) => <Option key={f.id} value={f.id}>{f.filename || f.id}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Validation file (optional)">
            <Dropdown value={validationFileId ? (files.find((f) => f.id === validationFileId)?.filename || validationFileId) : ''} selectedOptions={validationFileId ? [validationFileId] : []}
              placeholder="(none)" onOptionSelect={(_, d) => setValidationFileId(d.optionValue ?? '')}>
              <Option value="">(none)</Option>
              {files.map((f) => <Option key={f.id} value={f.id}>{f.filename || f.id}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Suffix (optional — names the fine-tuned model)"><Input value={suffix} onChange={(_, d) => setSuffix(d.value)} placeholder="my-tuned" /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacingVerticalS }}>
            <Field label="Epochs"><Input type="number" value={epochs} onChange={(_, d) => setEpochs(d.value)} placeholder="auto" /></Field>
            <Field label="Batch size"><Input type="number" value={batchSize} onChange={(_, d) => setBatchSize(d.value)} placeholder="auto" /></Field>
            <Field label="LR multiplier"><Input type="number" value={lrMult} onChange={(_, d) => setLrMult(d.value)} placeholder="auto" /></Field>
          </div>
          <Button appearance="primary" disabled={creating || uploading || !model || !trainingFileId} onClick={createJob}>{creating ? 'Creating…' : 'Create fine-tuning job'}</Button>
        </div>
      </div>

      <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Fine-tuning jobs</Subtitle2>
      {jobsState.loading ? <Spinner size="small" /> : jobs.length === 0 ? (
        <EmptyText>No fine-tuning jobs yet. Upload training data and create a job above.</EmptyText>
      ) : (
        <div className={s.tableWrap}>
          <Table size="small" aria-label="Fine-tuning jobs">
            <TableHeader><TableRow>
              <TableHeaderCell>Job</TableHeaderCell><TableHeaderCell>Base model</TableHeaderCell>
              <TableHeaderCell>Fine-tuned model</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.id} style={{ background: selectedJob?.id === j.id ? tokens.colorNeutralBackground2 : undefined }}>
                  <TableCell className={s.cell}><strong>{j.id}</strong></TableCell>
                  <TableCell className={s.cell}>{j.model || '—'}</TableCell>
                  <TableCell className={s.cell}>{j.fineTunedModel || '—'}</TableCell>
                  <TableCell className={s.cell}>
                    <Badge appearance="tint" color={j.status === 'succeeded' ? 'success' : (j.status === 'failed' || j.status === 'cancelled') ? 'danger' : 'informative'}>{j.status || '—'}</Badge>
                  </TableCell>
                  <TableCell className={s.cell}>{fmtEpoch(j.createdAt)}</TableCell>
                  <TableCell className={s.cell}>
                    <Button size="small" appearance="subtle" onClick={() => setSelectedJob(j)}>Events</Button>
                    {(j.status === 'running' || j.status === 'queued' || j.status === 'pending' || j.status === 'validating_files' || j.status === 'created') ? (
                      <Button size="small" appearance="subtle" onClick={() => cancelJob(j)}>Cancel</Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selectedJob && (
        <>
          <Subtitle2 style={{ marginTop: tokens.spacingVerticalM }}>Training metrics · {selectedJob.id}</Subtitle2>
          {selectedJob.error?.message ? <GateBar msg={selectedJob.error.message} /> : null}
          {events.loading ? <Spinner size="small" /> : events.error ? <GateBar msg={events.error} /> : events.list.length === 0 ? (
            <EmptyText>No training events yet. Loss metrics appear here as the job trains.</EmptyText>
          ) : (
            <>
              {/* Loss curve over training steps (Azure portal "metrics" tab parity). */}
              {(() => {
                const train: { x: number; y: number }[] = [];
                const valid: { x: number; y: number }[] = [];
                for (const ev of events.list) {
                  if (ev.step === undefined) continue;
                  if (typeof ev.trainingLoss === 'number') train.push({ x: ev.step, y: ev.trainingLoss });
                  if (typeof ev.validationLoss === 'number') valid.push({ x: ev.step, y: ev.validationLoss });
                }
                const lossSeries: LineSeries[] = [];
                if (train.length) lossSeries.push({ label: 'Training loss', color: tokens.colorBrandForeground1, points: train });
                if (valid.length) lossSeries.push({ label: 'Validation loss', color: tokens.colorPaletteRedForeground1, points: valid });
                if (!lossSeries.length) return null;
                return (
                  <div className={s.chartCard} style={{ marginBottom: tokens.spacingVerticalM }}>
                    <Body1 className={s.chartTitle}>Loss curve</Body1>
                    <Caption1 className={s.chartCaption}>Training and validation loss over training steps.</Caption1>
                    <LineChart series={lossSeries} xLabel="step" yLabel="loss" width={620} height={240} emptyText="No loss metrics emitted yet." />
                  </div>
                );
              })()}
              <Body1 style={{ fontWeight: 600 }}>Training events</Body1>
              <div className={s.tableWrap}>
              <Table size="small" aria-label="Fine-tuning events">
                <TableHeader><TableRow>
                  <TableHeaderCell>Time</TableHeaderCell><TableHeaderCell>Level</TableHeaderCell>
                  <TableHeaderCell>Step</TableHeaderCell><TableHeaderCell>Train loss</TableHeaderCell>
                  <TableHeaderCell>Valid loss</TableHeaderCell><TableHeaderCell>Message</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {events.list.map((ev, i) => (
                    <TableRow key={i}>
                      <TableCell className={s.cell}>{fmtEpoch(ev.createdAt)}</TableCell>
                      <TableCell className={s.cell}>{ev.level || '—'}</TableCell>
                      <TableCell className={s.cell}>{ev.step ?? '—'}</TableCell>
                      <TableCell className={s.cell}>{ev.trainingLoss !== undefined ? ev.trainingLoss.toFixed(4) : '—'}</TableCell>
                      <TableCell className={s.cell}>{ev.validationLoss !== undefined ? ev.validationLoss.toFixed(4) : '—'}</TableCell>
                      <TableCell className={s.cell}>{ev.message || '—'}</TableCell>
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

// ---------- Account picker (drives every tab) ----------

const usePickerStyles = makeStyles({
  bar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
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
      <div className={s.bar} style={{ padding: tokens.spacingVerticalNone, border: 'none', background: 'transparent' }}>
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
      <div className={s.bar} style={{ padding: tokens.spacingVerticalNone, border: 'none', background: 'transparent', alignItems: 'flex-start' }}>
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
        { label: 'Chat playground', onClick: () => setTab('chat') },
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
          <div style={{ padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalL}` }}>
            <Badge appearance="tint" color="brand">Hub/project selected: {crossSubHub.name}</Badge>
          </div>
        )}
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="overview" icon={<Home24Regular />}>Overview</Tab>
            <Tab value="agents" icon={<Bot24Regular />}>Agents</Tab>
            <Tab value="catalog" icon={<Apps24Regular />}>Model catalog</Tab>
            <Tab value="playgrounds" icon={<Play24Regular />}>Playgrounds</Tab>
            <Tab value="chat" icon={<Chat24Regular />}>Chat</Tab>
            <Tab value="images" icon={<Image24Regular />}>Images</Tab>
            <Tab value="audio" icon={<MicRecord24Regular />}>Audio</Tab>
            <Tab value="connections" icon={<PlugConnected24Regular />}>Connections</Tab>
            <Tab value="models" icon={<BrainCircuit24Regular />}>Models + endpoints</Tab>
            <Tab value="fine-tuning" icon={<Beaker24Regular />}>Fine-tuning</Tab>
            <Tab value="evaluations" icon={<ClipboardTaskListLtr24Regular />}>Evaluations</Tab>
            <Tab value="monitoring" icon={<DataTrending24Regular />}>Monitoring</Tab>
            <Tab value="quota" icon={<Gauge24Regular />}>Quota + usage</Tab>
            <Tab value="networking" icon={<Globe24Regular />}>Networking</Tab>
            <Tab value="identity" icon={<ShieldKeyhole24Regular />}>Identity / RBAC</Tab>
            <Tab value="keys" icon={<Key24Regular />}>Keys / endpoints</Tab>
            <Tab value="activity" icon={<History24Regular />}>Activity log</Tab>
            <Tab value="computes" icon={<Server24Regular />}>Computes</Tab>
            <Tab value="datastores" icon={<Database24Regular />}>Datastores</Tab>
            <Tab value="jobs" icon={<TaskListSquareLtr24Regular />}>Jobs</Tab>
          </TabList>
        </div>
        {tab === 'overview' && <OverviewPanel nonce={nonce} onWorkspace={onWorkspace} />}
        <FoundryAgentsPanel active={tab === 'agents'} nonce={nonce} acct={acct} />
        <ModelCatalogPanel active={tab === 'catalog'} nonce={nonce} acct={acct} />
        <PlaygroundsLandingPanel active={tab === 'playgrounds'} onOpenChat={() => setTab('chat')} onOpenImages={() => setTab('images')} onOpenAudio={() => setTab('audio')} />
        <ChatPlaygroundPanel active={tab === 'chat'} nonce={nonce} acct={acct} />
        <ImagesPlaygroundPanel active={tab === 'images'} nonce={nonce} acct={acct} />
        <AudioPlaygroundPanel active={tab === 'audio'} nonce={nonce} acct={acct} />
        <ConnectionsPanel active={tab === 'connections'} nonce={nonce} />
        <ModelsPanel active={tab === 'models'} nonce={nonce} acct={acct} />
        <FineTuningPanel active={tab === 'fine-tuning'} nonce={nonce} acct={acct} />
        <EvaluationsPanel active={tab === 'evaluations'} nonce={nonce} acct={acct} />
        <MonitoringPanel active={tab === 'monitoring'} nonce={nonce} />
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
