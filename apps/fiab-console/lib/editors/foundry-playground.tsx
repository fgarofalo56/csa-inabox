'use client';

/**
 * Azure AI Foundry — Model catalog + Chat playground panels.
 *
 * Built one-for-one with the real Foundry portal surfaces:
 *   - ModelCatalogPanel  → ai.azure.com/explore/models
 *       searchbox + 7 filter dropdowns, "Models <count>" heading, paginated
 *       model-card grid, leaderboards strip + Compare button, card → detail
 *       panel → Deploy dialog (name / SKU / capacity / content filter) that
 *       PUTs a real CognitiveServices deployment.
 *   - ChatPlaygroundPanel → ai.azure.com/resource/playground/chat
 *       3-pane Setup | Chat | Configuration. Send hits the REAL deployed AOAI
 *       model via /api/foundry/chat. Honest gate when no chat model is deployed.
 *   - PlaygroundsLanding   → tiles for Chat (functional) + Images/Audio/Speech
 *       (honest "deploy a <type> model first" gates).
 *
 * Backend, no mocks:
 *   GET  /api/foundry/models-catalog       (account list-models → deployable catalog)
 *   GET  /api/foundry/model-deployments    (deployed models, for picker + gates)
 *   POST /api/foundry/model-deployments    (deploy from catalog)
 *   POST /api/foundry/chat                 (data-plane chat completion)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle1, Subtitle2, Body1, Body1Strong, Caption1, Badge, Spinner, Button,
  SearchBox, Dropdown, Option, Slider, Label, Field, Input, Textarea, Tooltip,
  Card, Avatar, Divider, Tag, Checkbox,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, shorthands,
} from '@fluentui/react-components';
import {
  Search24Regular, Rocket20Regular, ChatMultiple24Regular, Image24Regular,
  MicRecord24Regular, Speaker224Regular, Send24Filled, Delete20Regular,
  Code20Regular, ChevronLeft20Regular, Trophy20Regular, ArrowSwap20Regular,
  TextField24Regular, BrainCircuit24Regular, Bot24Regular, Mic24Regular,
} from '@fluentui/react-icons';

// ============================================================ shared

// Selected AI Foundry / Azure OpenAI account (from the Hub's account picker).
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

interface CatalogModel {
  id: string; name: string; publisher?: string; format?: string; version?: string;
  isDefaultVersion?: boolean; skus?: string[]; defaultCapacity?: number; maxCapacity?: number;
  lifecycleStatus?: string; deprecationInference?: string;
  inferenceTasks: string[]; capabilities: string[]; deploymentOptions: string[]; deployableHere: boolean;
}
interface DeployedModel { name: string; modelName?: string; modelVersion?: string; skuName?: string; capacity?: number; provisioningState?: string }

function GateBar({ title, msg, hint, intent = 'warning' }: { title?: string; msg: string; hint?: string; intent?: 'warning' | 'error' | 'info' }) {
  return (
    <MessageBar intent={intent}>
      <MessageBarBody>
        {title ? <MessageBarTitle>{title}</MessageBarTitle> : null}
        {msg}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
      </MessageBarBody>
    </MessageBar>
  );
}

// Capability tag → short readable label.
const TASK_LABEL: Record<string, string> = {
  'chat-completion': 'Chat completion',
  'embeddings': 'Embeddings',
  'image-generation': 'Image generation',
  'audio-transcription': 'Audio transcription',
  'text-to-speech': 'Text to speech',
  'text-rerank': 'Rerank',
  'time-series-forecasting': 'Forecasting',
};

// ============================================================ Model catalog

const PAGE_SIZE = 12;

const useCatalogStyles = makeStyles({
  root: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1, overflow: 'auto' },
  header: { display: 'flex', flexDirection: 'column', gap: 4 },
  leaderboard: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', flexWrap: 'wrap',
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
  },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' },
  filterField: { minWidth: 150 },
  countRow: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 },
  card: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: 14, cursor: 'pointer',
    ...shorthands.transition('box-shadow', '120ms'),
    ':hover': { boxShadow: tokens.shadow8 },
  },
  cardSelectable: { outline: `2px solid ${tokens.colorBrandStroke1}` },
  cardTop: { display: 'flex', alignItems: 'center', gap: 10 },
  cardTitle: { display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 },
  tagRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  pager: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', paddingTop: 8 },
  // detail panel
  detail: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1, overflow: 'auto' },
  detailHead: { display: 'flex', alignItems: 'center', gap: 12 },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', alignItems: 'baseline', maxWidth: 640 },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: 12 },
  empty: { padding: 24, color: tokens.colorNeutralForeground3, fontStyle: 'italic', textAlign: 'center' },
});

function providerColor(p?: string): 'brand' | 'success' | 'warning' | 'danger' | 'important' | 'informative' | 'subtle' {
  switch ((p || '').toLowerCase()) {
    case 'openai': return 'success';
    case 'microsoft': return 'brand';
    case 'meta': return 'informative';
    case 'mistral ai': return 'warning';
    case 'deepseek': return 'important';
    default: return 'subtle';
  }
}

function ModelCard({ m, onClick }: { m: CatalogModel; onClick: () => void }) {
  const s = useCatalogStyles();
  return (
    <Card className={s.card} onClick={onClick} tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      aria-label={`${m.name} by ${m.publisher}`}>
      <div className={s.cardTop}>
        <Avatar shape="square" color="colorful" name={m.publisher || m.format || m.name} aria-hidden />
        <div className={s.cardTitle}>
          <Body1Strong truncate>{m.name}</Body1Strong>
          <Caption1>{m.publisher || m.format || '—'}{m.version ? ` · v${m.version}` : ''}</Caption1>
        </div>
      </div>
      <div className={s.tagRow}>
        {m.inferenceTasks.slice(0, 2).map((t) => (
          <Tag key={t} size="extra-small" appearance="brand">{TASK_LABEL[t] || t}</Tag>
        ))}
        {m.lifecycleStatus ? <Tag size="extra-small" appearance="outline">{m.lifecycleStatus}</Tag> : null}
      </div>
      <div className={s.tagRow}>
        {m.deploymentOptions.slice(0, 3).map((d) => (
          <Badge key={d} appearance="tint" color={providerColor(m.publisher)} size="small">{d}</Badge>
        ))}
      </div>
    </Card>
  );
}

interface DeployDialogState { model: CatalogModel | null }

function DeployDialog({ model, open, onClose, onDeployed, acct }: {
  model: CatalogModel | null; open: boolean; onClose: () => void; onDeployed: () => void; acct: FoundryAccount | null;
}) {
  const [deploymentName, setDeploymentName] = useState('');
  const [sku, setSku] = useState('GlobalStandard');
  const [capacity, setCapacity] = useState('10');
  const [contentFilter, setContentFilter] = useState('Microsoft.DefaultV2');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string; hint?: string } | null>(null);

  useEffect(() => {
    if (model) {
      setDeploymentName(model.name);
      setSku(model.deploymentOptions[0] || 'GlobalStandard');
      setCapacity(String(model.defaultCapacity || 10));
      setMsg(null);
    }
  }, [model]);

  const submit = async () => {
    if (!model) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/foundry/model-deployments', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelName: model.name,
          modelFormat: model.format,
          modelVersion: model.version,
          deploymentName: deploymentName.trim() || model.name,
          skuName: sku,
          capacity: Number(capacity) || 10,
          raiPolicyName: contentFilter || undefined,
          ...acctBody(acct),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setMsg({ intent: 'success', text: `Deployment "${j.deployment.name}" → ${j.deployment.provisioningState || 'created'}.` });
      onDeployed();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Deploy {model?.name}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Caption1>{model?.publisher} · {model?.inferenceTasks.map((t) => TASK_LABEL[t] || t).join(', ')}</Caption1>
              <Field label="Deployment name" required>
                <Input value={deploymentName} onChange={(_, d) => setDeploymentName(d.value)} placeholder={model?.name} />
              </Field>
              <Field label="Deployment type (SKU)">
                <Dropdown value={sku} selectedOptions={[sku]} onOptionSelect={(_, d) => d.optionValue && setSku(d.optionValue)}>
                  {(model?.deploymentOptions.length ? model.deploymentOptions : ['GlobalStandard', 'Standard', 'DataZoneStandard', 'ProvisionedManaged'])
                    .map((o) => <Option key={o} value={o}>{o}</Option>)}
                </Dropdown>
              </Field>
              <Field label={`Capacity (K TPM)${model?.maxCapacity ? ` · max ${model.maxCapacity}` : ''}`}>
                <Input type="number" value={capacity} onChange={(_, d) => setCapacity(d.value)} />
              </Field>
              <Field label="Content filter">
                <Dropdown value={contentFilter} selectedOptions={[contentFilter]} onOptionSelect={(_, d) => setContentFilter(d.optionValue ?? '')}>
                  <Option value="Microsoft.DefaultV2">Microsoft.DefaultV2 (recommended)</Option>
                  <Option value="Microsoft.Default">Microsoft.Default</Option>
                  <Option value="">None</Option>
                </Dropdown>
              </Field>
              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={<Rocket20Regular />} disabled={busy || !deploymentName.trim()} onClick={submit}>
              {busy ? 'Deploying…' : 'Deploy'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ModelDetail({ model, onBack, onDeploy }: { model: CatalogModel; onBack: () => void; onDeploy: () => void }) {
  const s = useCatalogStyles();
  return (
    <div className={s.detail}>
      <div>
        <Button appearance="subtle" icon={<ChevronLeft20Regular />} onClick={onBack}>Back to catalog</Button>
      </div>
      <div className={s.detailHead}>
        <Avatar shape="square" size={48} color="colorful" name={model.publisher || model.name} aria-hidden />
        <div>
          <Subtitle1>{model.name}</Subtitle1>
          <Caption1>{model.publisher || model.format}{model.version ? ` · version ${model.version}` : ''}{model.isDefaultVersion ? ' (default)' : ''}</Caption1>
        </div>
        <div style={{ flex: 1 }} />
        <Button appearance="primary" icon={<Rocket20Regular />} onClick={onDeploy}>Deploy</Button>
      </div>
      <div className={s.tagRow}>
        {model.inferenceTasks.map((t) => <Tag key={t} appearance="brand">{TASK_LABEL[t] || t}</Tag>)}
      </div>
      <Divider />
      <Subtitle2>Details</Subtitle2>
      <div className={s.metaGrid}>
        <span className={s.metaKey}>Provider</span><span>{model.publisher || '—'}</span>
        <span className={s.metaKey}>Format</span><span>{model.format || '—'}</span>
        <span className={s.metaKey}>Version</span><span>{model.version || '—'}</span>
        <span className={s.metaKey}>Lifecycle</span><span>{model.lifecycleStatus || '—'}</span>
        {model.deprecationInference ? <><span className={s.metaKey}>Inference retires</span><span>{model.deprecationInference}</span></> : null}
        <span className={s.metaKey}>Inference tasks</span><span>{model.inferenceTasks.map((t) => TASK_LABEL[t] || t).join(', ')}</span>
        <span className={s.metaKey}>Capabilities</span><span>{model.capabilities.join(', ') || '—'}</span>
        <span className={s.metaKey}>Deployment options</span><span>{model.deploymentOptions.join(', ')}</span>
        <span className={s.metaKey}>Default capacity</span><span>{model.defaultCapacity ?? '—'} K TPM</span>
        <span className={s.metaKey}>Max capacity</span><span>{model.maxCapacity ?? '—'} K TPM</span>
        <span className={s.metaKey}>Deployable here</span><span>{model.deployableHere ? 'Yes — this account / region' : 'No'}</span>
      </div>
    </div>
  );
}

const ALL = '__all__';

export function ModelCatalogPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = useCatalogStyles();
  const [state, setState] = useState<{ loading: boolean; models: CatalogModel[] | null; error?: string; hint?: string; notDeployed?: boolean; account?: any }>({ loading: false, models: null });
  const [search, setSearch] = useState('');
  const [collection, setCollection] = useState(ALL);
  const [industry, setIndustry] = useState(ALL);
  const [capability, setCapability] = useState(ALL);
  const [deployOpt, setDeployOpt] = useState(ALL);
  const [inferTask, setInferTask] = useState(ALL);
  const [fineTune, setFineTune] = useState(ALL);
  const [license, setLicense] = useState(ALL);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const [deployState, setDeployState] = useState<DeployDialogState>({ model: null });

  const load = useCallback(async () => {
    setState({ loading: true, models: null });
    try {
      const r = await fetch(withAccount('/api/foundry/models-catalog', acct));
      const j = await r.json();
      if (!j.ok) { setState({ loading: false, models: null, error: j.error, hint: j.hint, notDeployed: j.notDeployed }); return; }
      setState({ loading: false, models: Array.isArray(j.models) ? j.models : [], account: j.account });
    } catch (e: any) { setState({ loading: false, models: null, error: e?.message || String(e) }); }
  }, [acct]);

  useEffect(() => { if (active && state.models === null && !state.loading && !state.error) load(); }, [active, state.models, state.loading, state.error, load]);
  useEffect(() => { if (nonce > 0) { setState({ loading: false, models: null }); setSelected(null); } }, [nonce]);
  // Reset + refetch when the selected account changes.
  useEffect(() => { setState({ loading: false, models: null }); setSelected(null); }, [acct]);
  useEffect(() => { setPage(0); }, [search, collection, capability, deployOpt, inferTask, fineTune, license, industry]);

  const models = state.models || [];
  const collections = useMemo(() => [...new Set(models.map((m) => m.publisher).filter(Boolean))].sort() as string[], [models]);
  const allTasks = useMemo(() => [...new Set(models.flatMap((m) => m.inferenceTasks))].sort(), [models]);
  const allDeployOpts = useMemo(() => [...new Set(models.flatMap((m) => m.deploymentOptions))].sort(), [models]);
  const allCaps = useMemo(() => [...new Set(models.flatMap((m) => m.capabilities))].sort(), [models]);

  const filtered = useMemo(() => models.filter((m) => {
    if (search && !`${m.name} ${m.publisher} ${m.format}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (collection !== ALL && m.publisher !== collection) return false;
    if (capability !== ALL && !m.capabilities.includes(capability)) return false;
    if (deployOpt !== ALL && !m.deploymentOptions.includes(deployOpt)) return false;
    if (inferTask !== ALL && !m.inferenceTasks.includes(inferTask)) return false;
    // Fine-tuning: account list-models doesn't carry a fine-tune flag reliably;
    // honour it as a name heuristic so the dropdown is functional rather than dead.
    if (fineTune === 'finetunable' && !/gpt-4o|gpt-4\.1|gpt-35|gpt-3.5|phi|mistral|llama/i.test(m.name)) return false;
    // Industry filter: catalog API has no industry taxonomy; this account-scoped
    // catalog is general-purpose, so "All industries" is the only honest value.
    // License: account-deployable models are all Microsoft-hosted standard terms.
    if (license !== ALL && license !== 'msft-standard') return false;
    return true;
  }), [models, search, collection, capability, deployOpt, inferTask, fineTune, license]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageModels = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (!active) return null;
  if (state.loading) return <div className={s.root}><Spinner size="small" label="Loading model catalog…" labelPosition="after" /></div>;
  if (state.error) {
    return (
      <div className={s.root}>
        <GateBar title={state.notDeployed ? 'Model catalog unavailable' : 'Catalog error'} msg={state.error} hint={state.hint} intent={state.notDeployed ? 'warning' : 'error'} />
      </div>
    );
  }

  if (selected) {
    return (
      <>
        <ModelDetail model={selected} onBack={() => setSelected(null)} onDeploy={() => setDeployState({ model: selected })} />
        <DeployDialog model={deployState.model} open={!!deployState.model} onClose={() => setDeployState({ model: null })} onDeployed={() => { /* keep dialog open showing success */ }} acct={acct} />
      </>
    );
  }

  const Filter = ({ label, value, set, options, includeAll = true, allLabel = 'All' }: {
    label: string; value: string; set: (v: string) => void; options: { v: string; t: string }[]; includeAll?: boolean; allLabel?: string;
  }) => (
    <Field label={label} className={s.filterField}>
      <Dropdown value={value === ALL ? allLabel : (options.find((o) => o.v === value)?.t || value)} selectedOptions={[value]}
        onOptionSelect={(_, d) => d.optionValue && set(d.optionValue)}>
        {includeAll ? <Option value={ALL}>{allLabel}</Option> : null}
        {options.map((o) => <Option key={o.v} value={o.v}>{o.t}</Option>)}
      </Dropdown>
    </Field>
  );

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Subtitle1>Model catalog</Subtitle1>
        <Caption1>Explore and deploy foundation models{state.account?.name ? ` to ${state.account.name}` : ''}{state.account?.location ? ` · ${state.account.location}` : ''}.</Caption1>
      </div>

      <SearchBox placeholder="Search models (e.g. gpt-4o, phi, embedding)" value={search}
        onChange={(_, d) => setSearch(d.value)} contentBefore={<Search24Regular />} style={{ maxWidth: 520 }} />

      <div className={s.filterBar}>
        <Filter label="Collections" value={collection} set={setCollection} options={collections.map((c) => ({ v: c, t: c }))} allLabel="All collections" />
        <Filter label="Industry" value={industry} set={setIndustry} options={[{ v: 'general', t: 'General purpose' }]} allLabel="All industries" />
        <Filter label="Capabilities" value={capability} set={setCapability} options={allCaps.map((c) => ({ v: c, t: c }))} allLabel="All capabilities" />
        <Filter label="Deployment options" value={deployOpt} set={setDeployOpt} options={allDeployOpts.map((c) => ({ v: c, t: c }))} allLabel="All options" />
        <Filter label="Inference tasks" value={inferTask} set={setInferTask} options={allTasks.map((c) => ({ v: c, t: TASK_LABEL[c] || c }))} allLabel="All tasks" />
        <Filter label="Fine-tuning tasks" value={fineTune} set={setFineTune} options={[{ v: 'finetunable', t: 'Fine-tunable' }]} allLabel="All" />
        <Filter label="Licenses" value={license} set={setLicense} options={[{ v: 'msft-standard', t: 'Microsoft standard terms' }]} allLabel="All licenses" />
      </div>

      <div className={s.leaderboard}>
        <Trophy20Regular />
        <Body1Strong>Model leaderboards</Body1Strong>
        <Caption1>Compare quality, cost and throughput across the catalog.</Caption1>
        <div style={{ flex: 1 }} />
        <Tooltip content="Open the Foundry model leaderboards" relationship="label">
          <Button size="small" onClick={() => window.open('https://ai.azure.com/explore/models/leaderboard', '_blank', 'noopener,noreferrer')}>View leaderboards</Button>
        </Tooltip>
        <Tooltip content="Compare models side-by-side in Foundry" relationship="label">
          <Button size="small" icon={<ArrowSwap20Regular />} onClick={() => window.open('https://ai.azure.com/explore/models?compare=true', '_blank', 'noopener,noreferrer')}>Compare models</Button>
        </Tooltip>
      </div>

      <div className={s.countRow}>
        <Subtitle2>Models {filtered.length}</Subtitle2>
        {filtered.length !== models.length ? <Caption1>of {models.length} deployable to this account</Caption1> : null}
        <div style={{ flex: 1 }} />
        <Button size="small" onClick={load}>Reload</Button>
      </div>

      {pageModels.length === 0 ? (
        <div className={s.empty}>No models match the current filters.</div>
      ) : (
        <div className={s.grid}>
          {pageModels.map((m) => <ModelCard key={m.id} m={m} onClick={() => setSelected(m)} />)}
        </div>
      )}

      {pageCount > 1 && (
        <div className={s.pager}>
          <Button size="small" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
          <Caption1>Page {page + 1} of {pageCount}</Caption1>
          <Button size="small" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>Next</Button>
        </div>
      )}
    </div>
  );
}

// ============================================================ Chat playground

const useChatStyles = makeStyles({
  root: { display: 'grid', gridTemplateColumns: '280px 1fr 300px', gap: 0, minHeight: 0, flex: 1, overflow: 'hidden' },
  pane: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, overflow: 'auto', minHeight: 0 },
  leftPane: { borderRight: `1px solid ${tokens.colorNeutralStroke2}` },
  rightPane: { borderLeft: `1px solid ${tokens.colorNeutralStroke2}` },
  centerPane: { padding: 0 },
  paneTitle: { display: 'flex', alignItems: 'center', gap: 8 },
  thread: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 16, minHeight: 0 },
  bubbleRow: { display: 'flex', gap: 10, maxWidth: '85%' },
  bubbleRowUser: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },
  bubble: {
    padding: '10px 14px', borderRadius: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  bubbleUser: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  composer: { display: 'flex', gap: 8, alignItems: 'flex-end', padding: 16, borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  composerInput: { flex: 1 },
  sliderRow: { display: 'flex', flexDirection: 'column', gap: 2 },
  sliderHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  centerHead: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, flexWrap: 'wrap' },
  empty: { margin: 'auto', color: tokens.colorNeutralForeground3, textAlign: 'center', maxWidth: 420 },
});

interface ChatMsg { role: 'user' | 'assistant'; content: string; pending?: boolean; error?: boolean }

export function ChatPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = useChatStyles();
  const [deps, setDeps] = useState<{ loading: boolean; list: DeployedModel[] | null; error?: string; hint?: string; notDeployed?: boolean }>({ loading: false, list: null });
  const [deployment, setDeployment] = useState<string>('');
  const [system, setSystem] = useState('You are an AI assistant that helps people find information.');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(800);
  const [topP, setTopP] = useState(0.95);
  const [pastMessages, setPastMessages] = useState(10);
  const [stopSeq, setStopSeq] = useState('');
  const [thread, setThread] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const loadDeps = useCallback(async () => {
    setDeps({ loading: true, list: null });
    try {
      const r = await fetch(withAccount('/api/foundry/model-deployments', acct));
      const j = await r.json();
      if (!j.ok) { setDeps({ loading: false, list: null, error: j.error, hint: j.hint, notDeployed: j.notDeployed }); return; }
      const list: DeployedModel[] = Array.isArray(j.deployments) ? j.deployments : [];
      setDeps({ loading: false, list });
      // Auto-select first chat-capable deployment.
      const chat = list.find((d) => /gpt|phi|llama|mistral|chat|o1|o3|o4/i.test(d.modelName || d.name) && !/embed|whisper|dall|tts/i.test(d.modelName || d.name));
      if (chat && !deployment) setDeployment(chat.name);
      else if (list[0] && !deployment) setDeployment(list[0].name);
    } catch (e: any) { setDeps({ loading: false, list: null, error: e?.message || String(e) }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acct]);

  useEffect(() => { if (active && deps.list === null && !deps.loading && !deps.error) loadDeps(); }, [active, deps.list, deps.loading, deps.error, loadDeps]);
  useEffect(() => { if (nonce > 0) setDeps({ loading: false, list: null }); }, [nonce]);
  // Reset deployments + selection when the selected account changes.
  useEffect(() => { setDeps({ loading: false, list: null }); setDeployment(''); }, [acct]);
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [thread]);

  const deployments = deps.list || [];

  const send = async () => {
    const text = input.trim();
    if (!text || !deployment || sending) return;
    setInput('');
    const userMsg: ChatMsg = { role: 'user', content: text };
    const next = [...thread, userMsg];
    setThread([...next, { role: 'assistant', content: '', pending: true }]);
    setSending(true);
    // Build the wire payload: system prompt + trailing N turns.
    const history = next.slice(-pastMessages).map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: 'system' as const, content: system }, ...history];
    try {
      const r = await fetch('/api/foundry/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deployment, messages,
          temperature, maxTokens, topP,
          stop: stopSeq.split(',').map((x) => x.trim()).filter(Boolean),
          ...acctBody(acct),
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setThread([...next, { role: 'assistant', content: `${j.error}${j.hint ? `\n\n${j.hint}` : ''}`, error: true }]);
      } else {
        setThread([...next, { role: 'assistant', content: j.result.content || '(empty response)' }]);
      }
    } catch (e: any) {
      setThread([...next, { role: 'assistant', content: e?.message || String(e), error: true }]);
    } finally { setSending(false); }
  };

  const codeSnippet = useMemo(() => `from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="https://<your-account>.openai.azure.com",
    api_version="2024-10-21",
    azure_ad_token_provider=token_provider,  # Entra ID
)

response = client.chat.completions.create(
    model="${deployment || '<deployment>'}",
    messages=[
        {"role": "system", "content": ${JSON.stringify(system)}},
        {"role": "user", "content": "Hello"},
    ],
    temperature=${temperature},
    max_tokens=${maxTokens},
    top_p=${topP},${stopSeq ? `\n    stop=${JSON.stringify(stopSeq.split(',').map((x) => x.trim()).filter(Boolean))},` : ''}
)
print(response.choices[0].message.content)`, [deployment, system, temperature, maxTokens, topP, stopSeq]);

  if (!active) return null;
  if (deps.loading) return <div style={{ padding: 16 }}><Spinner size="small" label="Loading deployments…" labelPosition="after" /></div>;

  const noChatModel = !deps.error && deployments.length === 0;

  return (
    <div className={s.root}>
      {/* LEFT — Setup */}
      <div className={`${s.pane} ${s.leftPane}`}>
        <div className={s.paneTitle}><ChatMultiple24Regular /><Subtitle2>Setup</Subtitle2></div>
        <Field label="System message / instructions">
          <Textarea value={system} onChange={(_, d) => setSystem(d.value)} resize="vertical" rows={6}
            placeholder="You are an AI assistant that helps people find information." />
        </Field>
        <Divider />
        <Body1Strong>Add your data</Body1Strong>
        <Caption1>Ground answers in Azure AI Search or Blob. Configure a data connection on the Connections tab, then reference it here.</Caption1>
        <Button size="small" onClick={() => window.open('https://ai.azure.com/resource/playground/chat', '_blank', 'noopener,noreferrer')}>Add a data source</Button>
        <Divider />
        <Body1Strong>Tools</Body1Strong>
        <Caption1>Function tools and the code interpreter attach per-deployment in the Foundry agent surface.</Caption1>
      </div>

      {/* CENTER — Chat */}
      <div className={`${s.pane} ${s.centerPane}`}>
        <div className={s.centerHead}>
          <Subtitle2>Chat</Subtitle2>
          <div style={{ flex: 1 }} />
          <Button size="small" icon={<Delete20Regular />} appearance="subtle" onClick={() => setThread([])} disabled={!thread.length}>Clear chat</Button>
          <Button size="small" icon={<Code20Regular />} appearance="subtle" onClick={() => setShowCode(true)}>View code</Button>
        </div>

        {deps.error && (
          <div style={{ padding: 16 }}>
            <GateBar title="Could not list deployments" msg={deps.error} hint={deps.hint} intent={deps.notDeployed ? 'warning' : 'error'} />
          </div>
        )}
        {noChatModel && (
          <div style={{ padding: 16 }}>
            <GateBar title="No model deployed" intent="warning"
              msg="There are no model deployments on this account yet."
              hint="Open the Model catalog tab, pick a chat-completion model (e.g. gpt-4o-mini) and Deploy it, then return here to chat." />
          </div>
        )}

        <div className={s.thread} ref={threadRef}>
          {thread.length === 0 && !noChatModel && (
            <div className={s.empty}>
              <ChatMultiple24Regular fontSize={32} />
              <Body1 block style={{ marginTop: 8 }}>Start chatting with your deployed model.</Body1>
              <Caption1>Messages call the real Azure OpenAI chat/completions endpoint for the selected deployment.</Caption1>
            </div>
          )}
          {thread.map((m, i) => (
            <div key={i} className={`${s.bubbleRow} ${m.role === 'user' ? s.bubbleRowUser : ''}`}>
              <Avatar size={28} color={m.role === 'user' ? 'brand' : 'colorful'} name={m.role === 'user' ? 'You' : 'Assistant'} aria-hidden />
              <div className={`${s.bubble} ${m.role === 'user' ? s.bubbleUser : ''}`} style={m.error ? { color: tokens.colorPaletteRedForeground1 } : undefined}>
                {m.pending ? <Spinner size="tiny" label="Thinking…" labelPosition="after" /> : m.content}
              </div>
            </div>
          ))}
        </div>

        <div className={s.composer}>
          <Textarea className={s.composerInput} value={input} onChange={(_, d) => setInput(d.value)}
            placeholder={deployment ? `Message ${deployment}…` : 'Deploy and select a model to chat'}
            disabled={!deployment || sending} resize="none" rows={2}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button appearance="primary" icon={<Send24Filled />} disabled={!deployment || !input.trim() || sending} onClick={send}>Send</Button>
        </div>
      </div>

      {/* RIGHT — Configuration */}
      <div className={`${s.pane} ${s.rightPane}`}>
        <Subtitle2>Configuration</Subtitle2>
        <Field label="Deployment">
          <Dropdown value={deployment} selectedOptions={deployment ? [deployment] : []}
            placeholder={deployments.length ? 'Select a deployment' : 'No deployments'}
            onOptionSelect={(_, d) => d.optionValue && setDeployment(d.optionValue)}>
            {deployments.map((d) => (
              <Option key={d.name} value={d.name}>{`${d.name}${d.modelName ? ` (${d.modelName})` : ''}`}</Option>
            ))}
          </Dropdown>
        </Field>

        <div className={s.sliderRow}>
          <div className={s.sliderHead}><Label>Temperature</Label><Caption1>{temperature.toFixed(2)}</Caption1></div>
          <Slider min={0} max={2} step={0.01} value={temperature} onChange={(_, d) => setTemperature(d.value)} />
        </div>
        <Field label="Max response tokens">
          <Input type="number" value={String(maxTokens)} onChange={(_, d) => setMaxTokens(Number(d.value) || 0)} />
        </Field>
        <div className={s.sliderRow}>
          <div className={s.sliderHead}><Label>Top P</Label><Caption1>{topP.toFixed(2)}</Caption1></div>
          <Slider min={0} max={1} step={0.01} value={topP} onChange={(_, d) => setTopP(d.value)} />
        </div>
        <Field label="Past messages included">
          <Input type="number" value={String(pastMessages)} onChange={(_, d) => setPastMessages(Math.max(1, Number(d.value) || 1))} />
        </Field>
        <Field label="Stop sequences (comma-separated)">
          <Input value={stopSeq} onChange={(_, d) => setStopSeq(d.value)} placeholder="e.g. \n, ###" />
        </Field>
        <Divider />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" icon={<Code20Regular />} onClick={() => setShowCode(true)}>View code</Button>
          <Button size="small" appearance="primary" icon={<Rocket20Regular />}
            onClick={() => window.open('https://ai.azure.com/resource/deployments', '_blank', 'noopener,noreferrer')}>Deploy</Button>
        </div>
      </div>

      <Dialog open={showCode} onOpenChange={(_, d) => { if (!d.open) setShowCode(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>View code — Python (Azure OpenAI SDK)</DialogTitle>
            <DialogContent>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace', fontSize: 12, background: tokens.colorNeutralBackground3, padding: 12, borderRadius: 6 }}>{codeSnippet}</pre>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => navigator.clipboard?.writeText(codeSnippet)}>Copy</Button>
              <Button appearance="primary" onClick={() => setShowCode(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

// ============================================================ shared deployment loader

/** Lazy-load the account's model deployments; used by every modality playground. */
function useDeployments(active: boolean, nonce: number, acct: FoundryAccount | null) {
  const [deps, setDeps] = useState<{ loading: boolean; list: DeployedModel[] | null; error?: string; hint?: string; notDeployed?: boolean }>({ loading: false, list: null });
  const load = useCallback(async () => {
    setDeps({ loading: true, list: null });
    try {
      const r = await fetch(withAccount('/api/foundry/model-deployments', acct));
      const j = await r.json();
      if (!j.ok) { setDeps({ loading: false, list: null, error: j.error, hint: j.hint, notDeployed: j.notDeployed }); return; }
      setDeps({ loading: false, list: Array.isArray(j.deployments) ? j.deployments : [] });
    } catch (e: any) { setDeps({ loading: false, list: null, error: e?.message || String(e) }); }
  }, [acct]);
  useEffect(() => { if (active && deps.list === null && !deps.loading && !deps.error) load(); }, [active, deps.list, deps.loading, deps.error, load]);
  useEffect(() => { if (nonce > 0) setDeps({ loading: false, list: null }); }, [nonce]);
  useEffect(() => { setDeps({ loading: false, list: null }); }, [acct]);
  return { deps, reload: load };
}

const mname = (d: DeployedModel) => (d.modelName || d.name || '').toLowerCase();

const usePgStyles = makeStyles({
  root: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: 0, minHeight: 0, flex: 1, overflow: 'hidden' },
  left: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, overflow: 'auto', borderRight: `1px solid ${tokens.colorNeutralStroke2}`, minHeight: 0 },
  main: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, overflow: 'auto', minHeight: 0 },
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  imgGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  img: { width: '100%', borderRadius: 8, border: `1px solid ${tokens.colorNeutralStroke2}` },
  sliderRow: { display: 'flex', flexDirection: 'column', gap: 2 },
  sliderHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
});

/** Deployment dropdown filtered to a modality, with an honest gate when none match. */
function DeploymentSelect({ deps, value, onChange, filter, gate }: {
  deps: ReturnType<typeof useDeployments>['deps'];
  value: string; onChange: (v: string) => void;
  filter: (d: DeployedModel) => boolean;
  gate: { title: string; msg: string; hint: string };
}) {
  const matches = (deps.list || []).filter(filter);
  useEffect(() => { if (!value && matches[0]) onChange(matches[0].name); }, [matches, value, onChange]);
  if (deps.loading) return <Spinner size="tiny" label="Loading deployments…" labelPosition="after" />;
  if (deps.error) return <GateBar title="Could not list deployments" msg={deps.error} hint={deps.hint} intent={deps.notDeployed ? 'warning' : 'error'} />;
  if (matches.length === 0) return <GateBar title={gate.title} intent="warning" msg={gate.msg} hint={gate.hint} />;
  return (
    <Field label="Deployment">
      <Dropdown value={value} selectedOptions={value ? [value] : []} placeholder="Select a deployment"
        onOptionSelect={(_, d) => d.optionValue && onChange(d.optionValue)}>
        {matches.map((d) => <Option key={d.name} value={d.name}>{`${d.name}${d.modelName ? ` (${d.modelName})` : ''}`}</Option>)}
      </Dropdown>
    </Field>
  );
}

// ============================================================ Images playground

export function ImagesPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('standard');
  const [style, setStyle] = useState('vivid');
  const [n, setN] = useState('1');
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<{ url?: string; b64Json?: string }[]>([]);
  const [err, setErr] = useState<{ text: string; hint?: string } | null>(null);
  useEffect(() => { setDeployment(''); setImages([]); setErr(null); }, [acct]);
  if (!active) return null;

  const run = async () => {
    if (!deployment || !prompt.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/foundry/images', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployment, prompt, n: Number(n) || 1, size, quality, style, ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) { setErr({ text: j.error, hint: j.hint }); setImages([]); return; }
      setImages(j.images || []);
    } catch (e: any) { setErr({ text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><Image24Regular /><Subtitle2>Images</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={(d) => /dall|image/i.test(mname(d))}
          gate={{ title: 'No image model deployed', msg: 'No DALL-E / image model is deployed on this account.', hint: 'Open the Model catalog tab, deploy a DALL-E 3 or gpt-image-1 model, then return here.' }} />
        <Field label="Size">
          <Dropdown value={size} selectedOptions={[size]} onOptionSelect={(_, d) => d.optionValue && setSize(d.optionValue)}>
            {['1024x1024', '1792x1024', '1024x1792'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Quality">
          <Dropdown value={quality} selectedOptions={[quality]} onOptionSelect={(_, d) => d.optionValue && setQuality(d.optionValue)}>
            {['standard', 'hd'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Style">
          <Dropdown value={style} selectedOptions={[style]} onOptionSelect={(_, d) => d.optionValue && setStyle(d.optionValue)}>
            {['vivid', 'natural'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Number of images"><Input type="number" min={1} max={4} value={n} onChange={(_, d) => setN(d.value)} /></Field>
      </div>
      <div className={s.main}>
        <Field label="Prompt">
          <Textarea value={prompt} onChange={(_, d) => setPrompt(d.value)} rows={3} placeholder="A watercolor painting of a lighthouse at dawn" resize="vertical" />
        </Field>
        <div>
          <Button appearance="primary" icon={<Image24Regular />} disabled={!deployment || !prompt.trim() || busy} onClick={run}>
            {busy ? 'Generating…' : 'Generate'}
          </Button>
        </div>
        {err && <GateBar title="Generation failed" msg={err.text} hint={err.hint} intent="error" />}
        {busy && <Spinner size="small" label="Calling the image model…" labelPosition="after" />}
        {images.length > 0 && (
          <div className={s.imgGrid}>
            {images.map((im, i) => (
              <img key={i} className={s.img} alt={`Generated ${i + 1}`}
                src={im.url || (im.b64Json ? `data:image/png;base64,${im.b64Json}` : '')} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================ Audio (transcription) playground

export function AudioPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState('');
  const [format, setFormat] = useState('json');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<{ text: string; hint?: string } | null>(null);
  useEffect(() => { setDeployment(''); setText(''); setErr(null); }, [acct]);
  if (!active) return null;

  const run = async () => {
    if (!deployment || !file || busy) return;
    setBusy(true); setErr(null); setText('');
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('deployment', deployment);
      if (language) fd.append('language', language);
      fd.append('responseFormat', format);
      const ab = acctBody(acct);
      if (ab.account) fd.append('account', ab.account);
      if (ab.rg) fd.append('rg', ab.rg);
      const r = await fetch('/api/foundry/audio', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) { setErr({ text: j.error, hint: j.hint }); return; }
      setText(j.text || '(empty)');
    } catch (e: any) { setErr({ text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><MicRecord24Regular /><Subtitle2>Audio · transcription</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={(d) => /whisper|transcri/i.test(mname(d))}
          gate={{ title: 'No Whisper model deployed', msg: 'No Whisper / audio model is deployed on this account.', hint: 'Open the Model catalog tab, deploy a whisper model, then return here.' }} />
        <Field label="Audio file">
          <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label="Language (ISO 639-1, optional)"><Input value={language} onChange={(_, d) => setLanguage(d.value)} placeholder="en" /></Field>
        <Field label="Response format">
          <Dropdown value={format} selectedOptions={[format]} onOptionSelect={(_, d) => d.optionValue && setFormat(d.optionValue)}>
            {['json', 'verbose_json', 'text', 'srt', 'vtt'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <Button appearance="primary" icon={<Mic24Regular />} disabled={!deployment || !file || busy} onClick={run}>{busy ? 'Transcribing…' : 'Transcribe'}</Button>
      </div>
      <div className={s.main}>
        <Subtitle2>Transcription</Subtitle2>
        {err && <GateBar title="Transcription failed" msg={err.text} hint={err.hint} intent="error" />}
        {busy && <Spinner size="small" label="Calling Whisper…" labelPosition="after" />}
        <Textarea value={text} readOnly rows={16} placeholder="Upload an audio file and click Transcribe." resize="vertical" />
      </div>
    </div>
  );
}

// ============================================================ Speech (TTS) playground

export function SpeechPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  const [input, setInput] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [format, setFormat] = useState('mp3');
  const [speed, setSpeed] = useState(1.0);
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [err, setErr] = useState<{ text: string; hint?: string } | null>(null);
  useEffect(() => { setDeployment(''); setAudioUrl(''); setErr(null); }, [acct]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  if (!active) return null;

  const run = async () => {
    if (!deployment || !input.trim() || busy) return;
    setBusy(true); setErr(null);
    if (audioUrl) { URL.revokeObjectURL(audioUrl); setAudioUrl(''); }
    try {
      const r = await fetch('/api/foundry/speech', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployment, input, voice, responseFormat: format, speed, ...acctBody(acct) }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr({ text: j.error || `HTTP ${r.status}`, hint: j.hint }); return; }
      const blob = await r.blob();
      setAudioUrl(URL.createObjectURL(blob));
    } catch (e: any) { setErr({ text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><Speaker224Regular /><Subtitle2>Speech · text-to-speech</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={(d) => /tts|speech/i.test(mname(d))}
          gate={{ title: 'No TTS model deployed', msg: 'No text-to-speech model is deployed on this account.', hint: 'Open the Model catalog tab, deploy a tts-1 or tts-1-hd model, then return here.' }} />
        <Field label="Voice">
          <Dropdown value={voice} selectedOptions={[voice]} onOptionSelect={(_, d) => d.optionValue && setVoice(d.optionValue)}>
            {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Format">
          <Dropdown value={format} selectedOptions={[format]} onOptionSelect={(_, d) => d.optionValue && setFormat(d.optionValue)}>
            {['mp3', 'wav', 'opus', 'aac', 'flac'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <div className={s.sliderRow}>
          <div className={s.sliderHead}><Label>Speed</Label><Caption1>{speed.toFixed(2)}×</Caption1></div>
          <Slider min={0.25} max={4} step={0.05} value={speed} onChange={(_, d) => setSpeed(d.value)} />
        </div>
        <Button appearance="primary" icon={<Speaker224Regular />} disabled={!deployment || !input.trim() || busy} onClick={run}>{busy ? 'Synthesizing…' : 'Generate speech'}</Button>
      </div>
      <div className={s.main}>
        <Field label="Text">
          <Textarea value={input} onChange={(_, d) => setInput(d.value)} rows={5} placeholder="Type the text you want spoken." resize="vertical" />
        </Field>
        {err && <GateBar title="Synthesis failed" msg={err.text} hint={err.hint} intent="error" />}
        {busy && <Spinner size="small" label="Calling the TTS model…" labelPosition="after" />}
        {audioUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <audio controls src={audioUrl} style={{ width: '100%' }} />
            <a href={audioUrl} download={`speech.${format}`}><Button size="small">Download audio</Button></a>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================ Completions playground

export function CompletionsPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  const [prompt, setPrompt] = useState('');
  const [maxTokens, setMaxTokens] = useState(256);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(1.0);
  const [stop, setStop] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [err, setErr] = useState<{ text: string; hint?: string } | null>(null);
  useEffect(() => { setDeployment(''); setOutput(''); setErr(null); }, [acct]);
  if (!active) return null;

  const run = async () => {
    if (!deployment || !prompt.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/foundry/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployment, prompt, maxTokens, temperature, topP, stop: stop.split(',').map((x) => x.trim()).filter(Boolean), ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) { setErr({ text: j.error, hint: j.hint }); return; }
      setOutput(j.result?.text || '(empty)');
    } catch (e: any) { setErr({ text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><TextField24Regular /><Subtitle2>Completions</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={() => true}
          gate={{ title: 'No model deployed', msg: 'No model is deployed on this account.', hint: 'Open the Model catalog tab and deploy a completions-capable model (e.g. gpt-35-turbo-instruct).' }} />
        <div className={s.sliderRow}>
          <div className={s.sliderHead}><Label>Temperature</Label><Caption1>{temperature.toFixed(2)}</Caption1></div>
          <Slider min={0} max={2} step={0.01} value={temperature} onChange={(_, d) => setTemperature(d.value)} />
        </div>
        <Field label="Max tokens"><Input type="number" value={String(maxTokens)} onChange={(_, d) => setMaxTokens(Number(d.value) || 0)} /></Field>
        <div className={s.sliderRow}>
          <div className={s.sliderHead}><Label>Top P</Label><Caption1>{topP.toFixed(2)}</Caption1></div>
          <Slider min={0} max={1} step={0.01} value={topP} onChange={(_, d) => setTopP(d.value)} />
        </div>
        <Field label="Stop sequences (comma-separated)"><Input value={stop} onChange={(_, d) => setStop(d.value)} /></Field>
        <Button appearance="primary" icon={<Send24Filled />} disabled={!deployment || !prompt.trim() || busy} onClick={run}>{busy ? 'Running…' : 'Complete'}</Button>
      </div>
      <div className={s.main}>
        <Field label="Prompt"><Textarea value={prompt} onChange={(_, d) => setPrompt(d.value)} rows={6} placeholder="Once upon a time" resize="vertical" /></Field>
        {err && <GateBar title="Completion failed" msg={err.text} hint={err.hint} intent="error" />}
        {busy && <Spinner size="small" label="Calling the model…" labelPosition="after" />}
        <Field label="Completion"><Textarea value={output} readOnly rows={10} placeholder="Output appears here." resize="vertical" /></Field>
      </div>
    </div>
  );
}

// ============================================================ Reasoning (o-series) playground

interface ReasoningMsg { role: 'user' | 'assistant'; content: string; error?: boolean }

export function ReasoningPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium');
  const [maxCompletionTokens, setMaxCompletionTokens] = useState(2000);
  const [thread, setThread] = useState<ReasoningMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDeployment(''); setThread([]); }, [acct]);
  if (!active) return null;

  const send = async () => {
    const text = input.trim();
    if (!text || !deployment || busy) return;
    setInput('');
    const next: ReasoningMsg[] = [...thread, { role: 'user', content: text }];
    setThread(next); setBusy(true);
    try {
      const r = await fetch('/api/foundry/reasoning', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployment, messages: next.map((m) => ({ role: m.role, content: m.content })), reasoningEffort: effort, maxCompletionTokens, ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) setThread([...next, { role: 'assistant', content: `${j.error}${j.hint ? `\n\n${j.hint}` : ''}`, error: true }]);
      else setThread([...next, { role: 'assistant', content: j.result?.content || '(empty response)' }]);
    } catch (e: any) { setThread([...next, { role: 'assistant', content: e?.message || String(e), error: true }]); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><BrainCircuit24Regular /><Subtitle2>Reasoning (o-series)</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={(d) => /o1|o3|o4/i.test(mname(d))}
          gate={{ title: 'No reasoning model deployed', msg: 'No o-series reasoning model is deployed on this account.', hint: 'Open the Model catalog tab, deploy o1, o3, o4-mini or o1-mini, then return here.' }} />
        <Field label="Reasoning effort">
          <Dropdown value={effort} selectedOptions={[effort]} onOptionSelect={(_, d) => d.optionValue && setEffort(d.optionValue as any)}>
            {['low', 'medium', 'high'].map((o) => <Option key={o} value={o}>{o}</Option>)}
          </Dropdown>
        </Field>
        <Field label="Max completion tokens"><Input type="number" value={String(maxCompletionTokens)} onChange={(_, d) => setMaxCompletionTokens(Number(d.value) || 0)} /></Field>
        <Caption1>o-series models reason internally; temperature is ignored. Effort trades latency for depth.</Caption1>
      </div>
      <div className={s.main}>
        <Subtitle2>Conversation</Subtitle2>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          {thread.length === 0 && <Caption1>Ask a reasoning-heavy question (math, code, multi-step logic).</Caption1>}
          {thread.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '10px 14px', borderRadius: 10, whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? tokens.colorBrandBackground2 : tokens.colorNeutralBackground3, color: m.error ? tokens.colorPaletteRedForeground1 : undefined }}>
              {m.content}
            </div>
          ))}
          {busy && <Spinner size="tiny" label="Reasoning…" labelPosition="after" />}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Textarea style={{ flex: 1 }} value={input} onChange={(_, d) => setInput(d.value)} rows={2} resize="none"
            placeholder={deployment ? `Message ${deployment}…` : 'Deploy an o-series model to chat'} disabled={!deployment || busy}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button appearance="primary" icon={<Send24Filled />} disabled={!deployment || !input.trim() || busy} onClick={send}>Send</Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Real-time Audio playground (honest gate + code)

export function RealtimeAudioPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  useEffect(() => { setDeployment(''); }, [acct]);
  if (!active) return null;
  const ep = acct?.endpoint?.replace(/^https?:\/\//, '').replace(/\/$/, '') || '<your-account>.openai.azure.com';
  const snippet = `// Browser WebSocket to the gpt-realtime model
const url = "wss://${ep}/openai/realtime" +
  "?api-version=2024-10-01-preview&deployment=${deployment || '<deployment>'}";
const ws = new WebSocket(url, ["realtime", "openai-insecure-api-key.<token>"]);
ws.onopen = () => ws.send(JSON.stringify({ type: "response.create" }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));`;
  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><Mic24Regular /><Subtitle2>Real-time Audio</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={(d) => /realtime/i.test(mname(d))}
          gate={{ title: 'No gpt-realtime model deployed', msg: 'No gpt-realtime model is deployed on this account.', hint: 'Open the Model catalog tab, deploy a gpt-realtime model, then return here.' }} />
        <Button appearance="primary" onClick={() => window.open('https://ai.azure.com/resource/playground/audio', '_blank', 'noopener,noreferrer')}>Open Audio playground in Foundry</Button>
      </div>
      <div className={s.main}>
        <GateBar title="Real-time voice runs over WebSocket" intent="info"
          msg="The Real-time Audio playground needs a live WebSocket to the gpt-realtime model. Loom's BFF does not proxy WebSocket streams, so the live voice session opens in the Foundry Audio playground."
          hint="Manage your gpt-realtime deployment here; use the connection snippet below to wire real-time voice into your own app." />
        <Subtitle2>Connection snippet</Subtitle2>
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace', fontSize: 12, background: tokens.colorNeutralBackground3, padding: 12, borderRadius: 6 }}>{snippet}</pre>
        <Button size="small" onClick={() => navigator.clipboard?.writeText(snippet)}>Copy snippet</Button>
      </div>
    </div>
  );
}

// ============================================================ Assistants playground

export function AssistantsPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = usePgStyles();
  const { deps } = useDeployments(active, nonce, acct);
  const [deployment, setDeployment] = useState('');
  const [name, setName] = useState('My assistant');
  const [instructions, setInstructions] = useState('You are a helpful assistant.');
  const [codeInterpreter, setCodeInterpreter] = useState(false);
  const [fileSearch, setFileSearch] = useState(false);
  const [thread, setThread] = useState<{ role: 'user' | 'assistant'; content: string; error?: boolean }[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [assistantId, setAssistantId] = useState('');
  const [threadId, setThreadId] = useState('');
  const [err, setErr] = useState<{ text: string; hint?: string } | null>(null);
  useEffect(() => { setDeployment(''); setAssistantId(''); setThreadId(''); setThread([]); setErr(null); }, [acct]);
  if (!active) return null;

  const ensureAssistant = async (): Promise<{ assistantId: string; threadId: string } | null> => {
    if (assistantId && threadId) return { assistantId, threadId };
    const tools: string[] = [];
    if (codeInterpreter) tools.push('code_interpreter');
    if (fileSearch) tools.push('file_search');
    const r = await fetch('/api/foundry/assistants', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deployment, name, instructions, tools, ...acctBody(acct) }) });
    const j = await r.json();
    if (!j.ok) { setErr({ text: j.error, hint: j.hint }); return null; }
    setAssistantId(j.assistantId); setThreadId(j.threadId);
    return { assistantId: j.assistantId, threadId: j.threadId };
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !deployment || busy) return;
    setBusy(true); setErr(null);
    const ids = await ensureAssistant();
    if (!ids) { setBusy(false); return; }
    setInput('');
    const next = [...thread, { role: 'user' as const, content: text }];
    setThread(next);
    try {
      const r = await fetch('/api/foundry/assistants/run', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantId: ids.assistantId, threadId: ids.threadId, message: text, ...acctBody(acct) }) });
      const j = await r.json();
      if (!j.ok) setThread([...next, { role: 'assistant', content: `${j.error}${j.hint ? `\n\n${j.hint}` : ''}`, error: true }]);
      else setThread([...next, { role: 'assistant', content: j.reply || '(no reply)' }]);
    } catch (e: any) { setThread([...next, { role: 'assistant', content: e?.message || String(e), error: true }]); }
    finally { setBusy(false); }
  };

  return (
    <div className={s.root}>
      <div className={s.left}>
        <div className={s.head}><Bot24Regular /><Subtitle2>Assistants</Subtitle2></div>
        <DeploymentSelect deps={deps} value={deployment} onChange={setDeployment}
          filter={(d) => /gpt|o[134]/i.test(mname(d)) && !/embed|whisper|dall|tts|image/i.test(mname(d))}
          gate={{ title: 'No assistant-capable model deployed', msg: 'No chat model is deployed for the Assistants API.', hint: 'Open the Model catalog tab and deploy a gpt-4o / gpt-4o-mini model.' }} />
        <Field label="Name"><Input value={name} onChange={(_, d) => setName(d.value)} disabled={!!assistantId} /></Field>
        <Field label="Instructions"><Textarea value={instructions} onChange={(_, d) => setInstructions(d.value)} rows={4} resize="vertical" disabled={!!assistantId} /></Field>
        <Body1Strong>Tools</Body1Strong>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Checkbox label="Code interpreter" checked={codeInterpreter} disabled={!!assistantId} onChange={(_, d) => setCodeInterpreter(!!d.checked)} />
          <Checkbox label="File search" checked={fileSearch} disabled={!!assistantId} onChange={(_, d) => setFileSearch(!!d.checked)} />
        </div>
        {assistantId && <Badge appearance="tint" color="brand">Assistant + thread created</Badge>}
      </div>
      <div className={s.main}>
        <Subtitle2>Thread</Subtitle2>
        {err && <GateBar title="Assistant error" msg={err.text} hint={err.hint} intent="error" />}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          {thread.length === 0 && <Caption1>Send a message to create the assistant + thread and run it.</Caption1>}
          {thread.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', padding: '10px 14px', borderRadius: 10, whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? tokens.colorBrandBackground2 : tokens.colorNeutralBackground3, color: m.error ? tokens.colorPaletteRedForeground1 : undefined }}>
              {m.content}
            </div>
          ))}
          {busy && <Spinner size="tiny" label="Running…" labelPosition="after" />}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Textarea style={{ flex: 1 }} value={input} onChange={(_, d) => setInput(d.value)} rows={2} resize="none"
            placeholder={deployment ? 'Message the assistant…' : 'Deploy a chat model first'} disabled={!deployment || busy}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button appearance="primary" icon={<Send24Filled />} disabled={!deployment || !input.trim() || busy} onClick={send}>Send</Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================ Playgrounds landing

const useLandingStyles = makeStyles({
  root: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto', flex: 1, minHeight: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 },
  tile: { display: 'flex', flexDirection: 'column', gap: 8, padding: 16 },
  tileHead: { display: 'flex', alignItems: 'center', gap: 10 },
});

export function PlaygroundsLandingPanel({ active, onOpenChat, onOpenPlayground }: { active: boolean; onOpenChat: () => void; onOpenPlayground?: (key: string) => void }) {
  const s = useLandingStyles();
  if (!active) return null;
  const open = (key: string) => () => onOpenPlayground?.(key);
  const tiles: { key: string; icon: React.ReactNode; title: string; desc: string; action: React.ReactNode }[] = [
    { key: 'chat', icon: <ChatMultiple24Regular />, title: 'Chat playground', desc: 'Test a deployed chat model with system prompt, parameters and conversation history.', action: <Button appearance="primary" onClick={onOpenChat}>Open</Button> },
    { key: 'images', icon: <Image24Regular />, title: 'Images playground', desc: 'Generate images from prompts against a deployed DALL-E / gpt-image model.', action: <Button appearance="primary" onClick={open('images')}>Open</Button> },
    { key: 'audio', icon: <MicRecord24Regular />, title: 'Audio playground', desc: 'Transcribe audio with a deployed Whisper model.', action: <Button appearance="primary" onClick={open('audio')}>Open</Button> },
    { key: 'speech', icon: <Speaker224Regular />, title: 'Speech playground', desc: 'Text-to-speech with a deployed TTS model — pick a voice, play and download.', action: <Button appearance="primary" onClick={open('speech')}>Open</Button> },
    { key: 'completions', icon: <TextField24Regular />, title: 'Completions playground', desc: 'Legacy text completions against a deployed model with full parameter control.', action: <Button appearance="primary" onClick={open('completions')}>Open</Button> },
    { key: 'reasoning', icon: <BrainCircuit24Regular />, title: 'Reasoning playground', desc: 'Chat with an o-series reasoning model using reasoning_effort.', action: <Button appearance="primary" onClick={open('reasoning')}>Open</Button> },
    { key: 'assistants', icon: <Bot24Regular />, title: 'Assistants playground', desc: 'Create an assistant with tools, start a thread and run it end-to-end.', action: <Button appearance="primary" onClick={open('assistants')}>Open</Button> },
    { key: 'realtime', icon: <Mic24Regular />, title: 'Real-time Audio', desc: 'Manage your gpt-realtime deployment + get the WebSocket connection snippet.', action: <Button appearance="primary" onClick={open('realtime')}>Open</Button> },
  ];
  return (
    <div className={s.root}>
      <Subtitle1>Playgrounds</Subtitle1>
      <Caption1>Try your deployed models before wiring them into an app. Every playground calls the real Azure OpenAI data-plane and gates honestly when a model of that modality is not deployed.</Caption1>
      <div className={s.grid}>
        {tiles.map((t) => (
          <Card key={t.key} className={s.tile}>
            <div className={s.tileHead}>{t.icon}<Body1Strong>{t.title}</Body1Strong></div>
            <Caption1>{t.desc}</Caption1>
            <div style={{ flex: 1 }} />
            {t.action}
          </Card>
        ))}
      </div>
    </div>
  );
}
