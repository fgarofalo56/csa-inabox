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
  Card, Avatar, Divider, Tag,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens, shorthands,
} from '@fluentui/react-components';
import {
  Search24Regular, Rocket20Regular, ChatMultiple24Regular, Image24Regular,
  MicRecord24Regular, Speaker224Regular, Send24Filled, Delete20Regular,
  Code20Regular, ChevronLeft20Regular, Trophy20Regular, ArrowSwap20Regular,
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
  root: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1, overflow: 'auto' },
  header: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  leaderboard: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, flexWrap: 'wrap',
    backgroundColor: tokens.colorNeutralBackground2, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
  },
  filterBar: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' },
  filterField: { minWidth: '150px' },
  countRow: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingVerticalM },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, cursor: 'pointer',
    ...shorthands.transition('box-shadow', '120ms'),
    ':hover': { boxShadow: tokens.shadow8 },
  },
  cardSelectable: { outline: `2px solid ${tokens.colorBrandStroke1}` },
  cardTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  cardTitle: { display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 },
  tagRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  pager: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', justifyContent: 'center', paddingTop: tokens.spacingVerticalS },
  // detail panel
  detail: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1, overflow: 'auto' },
  detailHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  metaGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'baseline', maxWidth: '640px' },
  metaKey: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  empty: { padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3, fontStyle: 'italic', textAlign: 'center' },
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, overflow: 'auto', minHeight: 0 },
  leftPane: { borderRight: `1px solid ${tokens.colorNeutralStroke2}` },
  rightPane: { borderLeft: `1px solid ${tokens.colorNeutralStroke2}` },
  centerPane: { padding: 0 },
  paneTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  thread: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minHeight: 0 },
  bubbleRow: { display: 'flex', gap: tokens.spacingHorizontalS, maxWidth: '85%' },
  bubbleRowUser: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },
  bubble: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderRadius: tokens.borderRadiusLarge, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  bubbleUser: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  composer: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', padding: tokens.spacingVerticalL, borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  composerInput: { flex: 1 },
  sliderRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  sliderHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  centerHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, flexWrap: 'wrap' },
  empty: { margin: 'auto', color: tokens.colorNeutralForeground3, textAlign: 'center', maxWidth: '420px' },
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
  if (deps.loading) return <div style={{ padding: tokens.spacingVerticalL }}><Spinner size="small" label="Loading deployments…" labelPosition="after" /></div>;

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
          <div style={{ padding: tokens.spacingVerticalL }}>
            <GateBar title="Could not list deployments" msg={deps.error} hint={deps.hint} intent={deps.notDeployed ? 'warning' : 'error'} />
          </div>
        )}
        {noChatModel && (
          <div style={{ padding: tokens.spacingVerticalL }}>
            <GateBar title="No model deployed" intent="warning"
              msg="There are no model deployments on this account yet."
              hint="Open the Model catalog tab, pick a chat-completion model (e.g. gpt-4o-mini) and Deploy it, then return here to chat." />
          </div>
        )}

        <div className={s.thread} ref={threadRef}>
          {thread.length === 0 && !noChatModel && (
            <div className={s.empty}>
              <ChatMultiple24Regular fontSize={32} />
              <Body1 block style={{ marginTop: tokens.spacingVerticalS }}>Start chatting with your deployed model.</Body1>
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
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
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
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, background: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge }}>{codeSnippet}</pre>
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

// ============================================================ Playgrounds landing

const useLandingStyles = makeStyles({
  root: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, overflow: 'auto', flex: 1, minHeight: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacingVerticalM },
  tile: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalL },
  tileHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export function PlaygroundsLandingPanel({ active, onOpenChat, onOpenImages, onOpenAudio }: {
  active: boolean; onOpenChat: () => void; onOpenImages?: () => void; onOpenAudio?: () => void;
}) {
  const s = useLandingStyles();
  if (!active) return null;
  const tiles = [
    { key: 'chat', icon: <ChatMultiple24Regular />, title: 'Chat playground', desc: 'Test a deployed chat model with system prompt, parameters and conversation history.', action: <Button appearance="primary" onClick={onOpenChat}>Open chat</Button> },
    { key: 'images', icon: <Image24Regular />, title: 'Images playground', desc: 'Generate images from prompts against a deployed gpt-image model. Honest gate when no image model is deployed.', action: <Button appearance="primary" onClick={() => onOpenImages?.()}>Open images</Button> },
    { key: 'audio', icon: <MicRecord24Regular />, title: 'Audio playground', desc: 'Transcribe audio against a deployed Whisper model. Honest gate when no audio model is deployed.', action: <Button appearance="primary" onClick={() => onOpenAudio?.()}>Open audio</Button> },
    { key: 'speech', icon: <Speaker224Regular />, title: 'Speech (TTS) playground', desc: 'Text-to-speech requires a deployed TTS model + in-browser audio playback — open the Foundry speech playground.', action: <Button onClick={() => window.open('https://ai.azure.com/resource/playground/speech', '_blank', 'noopener,noreferrer')}>Open in Foundry</Button> },
  ];
  return (
    <div className={s.root}>
      <Subtitle1>Playgrounds</Subtitle1>
      <Caption1>Try your deployed models before wiring them into an app. Chat, Images and Audio call the real Azure OpenAI data-plane; each gates honestly on a model of that modality being deployed.</Caption1>
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

// ============================================================ Images playground

const useMediaStyles = makeStyles({
  root: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, overflow: 'auto', flex: 1, minHeight: 0 },
  twoCol: { display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL },
  // Result panel keeps a stable height so the empty / loading placeholder reads
  // as an intentional, centered drop-zone rather than a collapsed card.
  resultPanel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minHeight: '320px' },
  resultGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingVerticalM },
  img: { width: '100%', maxHeight: '360px', objectFit: 'contain', backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}` },
  empty: { margin: 'auto', color: tokens.colorNeutralForeground3, textAlign: 'center', padding: tokens.spacingVerticalXXL },
});

/** Heuristic: which deployed models can generate images. */
function imageDeployments(list: DeployedModel[]): DeployedModel[] {
  return list.filter((d) => /gpt-image|dall-?e|image/i.test(`${d.modelName || ''} ${d.name}`));
}
/** Heuristic: which deployed models can transcribe audio. */
function audioDeployments(list: DeployedModel[]): DeployedModel[] {
  return list.filter((d) => /whisper/i.test(`${d.modelName || ''} ${d.name}`));
}

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
  return deps;
}

export function ImagesPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = useMediaStyles();
  const deps = useDeployments(active, nonce, acct);
  const list = deps.list || [];
  const imgDeps = useMemo(() => imageDeployments(list), [list]);
  const [deployment, setDeployment] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('standard');
  const [style, setStyle] = useState('vivid');
  const [n, setN] = useState('1');
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<{ url?: string; b64_json?: string; revised_prompt?: string }[]>([]);
  const [msg, setMsg] = useState<{ intent: 'error' | 'warning'; text: string; hint?: string } | null>(null);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => { if (imgDeps[0] && !deployment) setDeployment(imgDeps[0].name); }, [imgDeps, deployment]);
  useEffect(() => { setDeployment(''); setImages([]); }, [acct]);

  const generate = async () => {
    if (!deployment || !prompt.trim()) return;
    setBusy(true); setMsg(null); setImages([]);
    try {
      const r = await fetch('/api/foundry/images', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deployment, prompt: prompt.trim(), n: Number(n) || 1, size, quality, style, ...acctBody(acct) }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setImages(Array.isArray(j.images) ? j.images : []);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  const codeSnippet = useMemo(() => `from openai import AzureOpenAI

client = AzureOpenAI(azure_endpoint="https://<acct>.openai.azure.com", api_version="2024-10-21", azure_ad_token_provider=token_provider)
result = client.images.generate(
    model="${deployment || '<deployment>'}",
    prompt=${JSON.stringify(prompt || 'a photo of ...')},
    n=${Number(n) || 1}, size="${size}", quality="${quality}", style="${style}",
)
print(result.data[0].url)`, [deployment, prompt, n, size, quality, style]);

  if (!active) return null;
  if (deps.loading) return <div className={s.root}><Spinner size="small" label="Loading deployments…" labelPosition="after" /></div>;

  const noImageModel = !deps.error && imgDeps.length === 0;

  return (
    <div className={s.root}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <Image24Regular /><Subtitle1>Images playground</Subtitle1>
        <Badge appearance="tint" color="brand">Preview</Badge>
      </div>
      {deps.error && <GateBar title="Could not list deployments" msg={deps.error} hint={deps.hint} intent={deps.notDeployed ? 'warning' : 'error'} />}
      {noImageModel && (
        <GateBar title="No image model deployed" intent="warning"
          msg="There is no image-generation model deployed on this account."
          hint="Open the Model catalog tab, pick an image-generation model (e.g. gpt-image-1) and Deploy it, then return here. (dall-e-3 retired 2026-03-04.)" />
      )}
      {!noImageModel && (
        <div className={s.twoCol}>
          <Card className={s.panel}>
            <Field label="Deployment">
              <Dropdown value={deployment} selectedOptions={deployment ? [deployment] : []} placeholder="Select an image deployment"
                onOptionSelect={(_, d) => d.optionValue && setDeployment(d.optionValue)}>
                {imgDeps.map((d) => <Option key={d.name} value={d.name}>{`${d.name}${d.modelName ? ` (${d.modelName})` : ''}`}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Prompt" required>
              <Textarea value={prompt} onChange={(_, d) => setPrompt(d.value)} resize="vertical" rows={4} placeholder="A watercolor painting of a lighthouse at dawn" />
            </Field>
            <Field label="Size">
              <Dropdown value={size} selectedOptions={[size]} onOptionSelect={(_, d) => d.optionValue && setSize(d.optionValue)}>
                <Option value="1024x1024">1024×1024 (square)</Option>
                <Option value="1792x1024">1792×1024 (landscape)</Option>
                <Option value="1024x1792">1024×1792 (portrait)</Option>
              </Dropdown>
            </Field>
            <Field label="Quality">
              <Dropdown value={quality} selectedOptions={[quality]} onOptionSelect={(_, d) => d.optionValue && setQuality(d.optionValue)}>
                <Option value="standard">Standard</Option>
                <Option value="hd">HD</Option>
              </Dropdown>
            </Field>
            <Field label="Style">
              <Dropdown value={style} selectedOptions={[style]} onOptionSelect={(_, d) => d.optionValue && setStyle(d.optionValue)}>
                <Option value="vivid">Vivid</Option>
                <Option value="natural">Natural</Option>
              </Dropdown>
            </Field>
            <Field label="Number of images">
              <Input type="number" value={n} onChange={(_, d) => setN(d.value)} min={1} max={4} />
            </Field>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
              <Button appearance="primary" icon={<Image24Regular />} disabled={busy || !deployment || !prompt.trim()} onClick={generate}>{busy ? 'Generating…' : 'Generate'}</Button>
              <Button icon={<Code20Regular />} onClick={() => setShowCode(true)}>View code</Button>
            </div>
            {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
          </Card>
          <Card className={s.resultPanel}>
            <Subtitle2>Result</Subtitle2>
            {busy ? <div className={s.empty}><Spinner size="small" label="Generating image…" labelPosition="after" /></div> : images.length === 0 ? (
              <div className={s.empty}><Image24Regular fontSize={32} /><Body1 block style={{ marginTop: tokens.spacingVerticalS }}>Generated images appear here.</Body1></div>
            ) : (
              <div className={s.resultGrid}>
                {images.map((img, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                    <img className={s.img} alt={img.revised_prompt || `Generated image ${i + 1}`}
                      src={img.url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : '')} />
                    {img.revised_prompt ? <Caption1>{img.revised_prompt}</Caption1> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <Dialog open={showCode} onOpenChange={(_, d) => { if (!d.open) setShowCode(false); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>View code — Python (Azure OpenAI SDK)</DialogTitle>
            <DialogContent>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, background: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge }}>{codeSnippet}</pre>
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

// ============================================================ Audio playground

export function AudioPlaygroundPanel({ active, nonce, acct = null }: { active: boolean; nonce: number; acct?: FoundryAccount | null }) {
  const s = useMediaStyles();
  const deps = useDeployments(active, nonce, acct);
  const list = deps.list || [];
  const audDeps = useMemo(() => audioDeployments(list), [list]);
  const [deployment, setDeployment] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ intent: 'error' | 'warning'; text: string; hint?: string } | null>(null);

  useEffect(() => { if (audDeps[0] && !deployment) setDeployment(audDeps[0].name); }, [audDeps, deployment]);
  useEffect(() => { setDeployment(''); setText(''); setFile(null); }, [acct]);

  const transcribe = async () => {
    if (!deployment || !file) return;
    setBusy(true); setMsg(null); setText('');
    try {
      const form = new FormData();
      form.append('deployment', deployment);
      form.append('file', file, file.name);
      const ab = acctBody(acct);
      if (ab.account) form.append('account', ab.account);
      if (ab.rg) form.append('rg', ab.rg);
      const r = await fetch('/api/foundry/audio', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: j.notDeployed ? 'warning' : 'error', text: j.error, hint: j.hint }); return; }
      setText(j.text || '(empty transcript)');
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  };

  if (!active) return null;
  if (deps.loading) return <div className={s.root}><Spinner size="small" label="Loading deployments…" labelPosition="after" /></div>;

  const noAudioModel = !deps.error && audDeps.length === 0;

  return (
    <div className={s.root}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
        <MicRecord24Regular /><Subtitle1>Audio playground</Subtitle1>
        <Badge appearance="tint" color="brand">Preview</Badge>
      </div>
      {deps.error && <GateBar title="Could not list deployments" msg={deps.error} hint={deps.hint} intent={deps.notDeployed ? 'warning' : 'error'} />}
      {noAudioModel && (
        <GateBar title="No audio model deployed" intent="warning"
          msg="There is no Whisper / audio-transcription model deployed on this account."
          hint="Open the Model catalog tab, pick a Whisper model and Deploy it, then return here to transcribe audio." />
      )}
      {!noAudioModel && (
        <div className={s.twoCol}>
          <Card className={s.panel}>
            <Field label="Deployment">
              <Dropdown value={deployment} selectedOptions={deployment ? [deployment] : []} placeholder="Select an audio deployment"
                onOptionSelect={(_, d) => d.optionValue && setDeployment(d.optionValue)}>
                {audDeps.map((d) => <Option key={d.name} value={d.name}>{`${d.name}${d.modelName ? ` (${d.modelName})` : ''}`}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Audio file (mp3 / wav / m4a / ogg / flac)" required>
              <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.webm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </Field>
            {file ? <Caption1>{file.name} · {(file.size / 1024).toFixed(0)} KB</Caption1> : null}
            <Button appearance="primary" icon={<MicRecord24Regular />} disabled={busy || !deployment || !file} onClick={transcribe}>{busy ? 'Transcribing…' : 'Transcribe'}</Button>
            {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}</MessageBarBody></MessageBar>}
          </Card>
          <Card className={s.resultPanel}>
            <Subtitle2>Transcript</Subtitle2>
            {busy ? <div className={s.empty}><Spinner size="small" label="Transcribing…" labelPosition="after" /></div> : (
              <Textarea value={text} readOnly resize="vertical" rows={12} placeholder="The transcript appears here after you upload an audio file and click Transcribe." />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
