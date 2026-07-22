'use client';

/**
 * LLM fine-tuning editor (WS-1.3) — a first-class fine-tuning surface over Azure
 * OpenAI in Azure AI Foundry fine-tuning (Azure-native DEFAULT, Gov-correct
 * *.openai.azure.us) — one-for-one with the Foundry "Fine-tuning" experience,
 * Loom-themed:
 *   - Overview   — backend badge, live jobs list, status, bind/select.
 *   - Submit     — base model + training JSONL (training-data-eval gate) +
 *                  hyperparameters → real fine-tuning job.
 *   - Progress   — real per-step training/validation-loss events for a job.
 *   - Safety & deploy — deploy the resulting model, run the resulting-model
 *                  safety-eval (red-team + Content Safety), and — only on PASS —
 *                  approve it for serving via WS-1.2 (model-serving-endpoint).
 *
 * Every control calls the real BFF (no mocks). When no fine-tuning backend is
 * configured the surface still renders and shows the shared HonestGate with an
 * inline "Fix it" wizard (gate svc-fine-tuning) — no dead buttons, no red banner
 * on a freshly created item (ux-baseline G1/G2).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Field, Dropdown, Option, Textarea,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular, Play20Regular, Rocket20Regular, ShieldCheckmark20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { DetailsPanel, type DetailsSection } from '@/lib/components/shared/details-panel';
import { useSharedEditorStyles } from './shared-styles';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useLocalStyles = makeStyles({
  card: { padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  tileRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  tile: {
    flex: '1 1 150px', minWidth: 0, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
  },
  tileVal: { fontSize: '26px', fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.1 },
  badges: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', minWidth: 0, rowGap: tokens.spacingVerticalXXS },
  form: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  mono: {
    width: '100%', minHeight: '160px', maxWidth: '100%', boxSizing: 'border-box',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300,
  },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

// ── shapes mirroring fine-tuning-client views ──
interface JobView {
  id: string; status: string; baseModel?: string; fineTunedModel?: string | null;
  createdAt?: number; finishedAt?: number | null; trainedTokens?: number | null;
  error?: { message?: string; code?: string } | null; terminal: boolean; succeeded: boolean; hasModel: boolean;
}
interface ModelLite { name: string; version?: string }
interface DeploymentLite { name: string; modelName?: string; provisioningState?: string }
interface Gate { backend: string; missing: string; hint: string; fixEnvVar: string; gateId: string }
interface SafetyEvalSnap { passed?: boolean; grade?: string; refusalRate?: number; attackSuccessRate?: number; unsafe?: number; contentSafetyConfigured?: boolean; reason?: string; ranAt?: string }
interface Binding { jobId?: string; baseModel?: string; fineTunedModel?: string; deploymentName?: string; deployable?: boolean; safetyEval?: SafetyEvalSnap }
interface FtEvent { createdAt?: number; level?: string; message?: string; step?: number; trainingLoss?: number; validationLoss?: number }

function statusColor(s?: string): 'success' | 'warning' | 'danger' | 'informative' {
  if (!s) return 'informative';
  const t = s.toLowerCase();
  if (t === 'succeeded') return 'success';
  if (t === 'failed' || t === 'cancelled' || t === 'canceled') return 'danger';
  return 'warning';
}

export function FineTuningJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const isNew = id === 'new' || !id;
  if (isNew) {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create fine-tuning job item"
        intro="Creates a fine-tuning-job item in your Loom workspace, then opens the editor where you submit a real fine-tuning job on Azure OpenAI in Azure AI Foundry (Databricks Mosaic optional), watch training progress, run a resulting-model safety evaluation (red-team + Content Safety), and — once it passes — deploy the fine-tuned model for serving via WS-1.2."
      />
    );
  }
  return <FineTuningBody item={item} id={id} />;
}

function FineTuningBody({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const apiBase = `/api/items/fine-tuning-job/${encodeURIComponent(id)}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('aoai');
  const [gate, setGate] = useState<Gate | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [models, setModels] = useState<ModelLite[]>([]);
  const [deployments, setDeployments] = useState<DeploymentLite[]>([]);
  const [binding, setBinding] = useState<Binding>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'submit' | 'progress' | 'safety'>('overview');

  // Submit form
  const [baseModel, setBaseModel] = useState('');
  const [suffix, setSuffix] = useState('');
  const [trainingData, setTrainingData] = useState('');
  const [epochs, setEpochs] = useState('');
  const [seed, setSeed] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Progress events
  const [events, setEvents] = useState<FtEvent[]>([]);
  const [eventsBusy, setEventsBusy] = useState(false);

  // Safety & deploy
  const [deployName, setDeployName] = useState('');
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [safetyBusy, setSafetyBusy] = useState(false);
  const [safety, setSafety] = useState<SafetyEvalSnap | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(apiBase);
      const j = await res.json();
      if (!j.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setBackend(j.backend || 'aoai');
      setGate(j.gate || null);
      setJobs(j.jobs || []);
      setModels(j.models || []);
      setDeployments(j.deployments || []);
      setBinding(j.binding || {});
      setSafety(j.binding?.safetyEval || null);
      setSelected((prev) => prev || j.binding?.jobId || j.jobs?.[0]?.id || null);
      if (!deployName && j.binding?.deploymentName) setDeployName(j.binding.deploymentName);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [apiBase, deployName]);

  useEffect(() => { load(); }, [load]);

  const current = useMemo(() => jobs.find((jb) => jb.id === selected) || null, [jobs, selected]);

  const loadEvents = useCallback(async (jobId: string) => {
    setEventsBusy(true);
    try {
      const res = await fetch(`${apiBase}/events?job=${encodeURIComponent(jobId)}`);
      const j = await res.json();
      setEvents(j.ok ? (j.events || []) : []);
    } catch { setEvents([]); }
    finally { setEventsBusy(false); }
  }, [apiBase]);

  useEffect(() => { if (tab === 'progress' && selected) loadEvents(selected); }, [tab, selected, loadEvents]);

  // Suggest a deployment name from the selected job's fine-tuned model.
  useEffect(() => {
    if (current?.fineTunedModel && !deployName) {
      setDeployName(`${current.fineTunedModel}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60) || 'ft-deploy');
    }
  }, [current, deployName]);

  const submit = useCallback(async () => {
    setSubmitting(true); setSubmitMsg(null);
    try {
      const hyperparameters = epochs.trim() ? { n_epochs: Number(epochs) || 'auto' } : undefined;
      const res = await fetch(apiBase, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseModel: baseModel.trim(), suffix: suffix.trim() || undefined,
          trainingData, seed: seed.trim() ? Number(seed) : undefined, hyperparameters,
        }),
      });
      const j = await res.json();
      if (!j.ok) { setSubmitMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      const warn = (j.trainingDataEval?.warnings || []).join(' ');
      setSubmitMsg({ intent: 'success', text: `${j.message}${warn ? ` — ${warn}` : ''}` });
      setSelected(j.job?.id || null);
      load();
    } catch (e: any) { setSubmitMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSubmitting(false); }
  }, [apiBase, baseModel, suffix, trainingData, epochs, seed, load]);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`${apiBase}?job=${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      const j = await res.json();
      if (j.ok) load();
    } catch { /* surfaced on reload */ }
  }, [apiBase, load]);

  const deploy = useCallback(async () => {
    if (!current?.fineTunedModel) return;
    setDeployBusy(true); setDeployMsg(null);
    try {
      const res = await fetch(`${apiBase}/deploy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fineTunedModel: current.fineTunedModel, deploymentName: deployName.trim() }),
      });
      const j = await res.json();
      if (!j.ok) { setDeployMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setDeployMsg({ intent: 'success', text: j.message || 'Deployment started.' });
      load();
    } catch (e: any) { setDeployMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setDeployBusy(false); }
  }, [apiBase, current, deployName, load]);

  const runSafety = useCallback(async () => {
    if (!deployName.trim()) return;
    setSafetyBusy(true); setDeployMsg(null);
    try {
      const res = await fetch(`${apiBase}/safety-eval`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deploymentName: deployName.trim() }),
      });
      const j = await res.json();
      if (!j.ok) { setDeployMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setSafety({ ...j.decision, ranAt: j.ranAt });
      load();
    } catch (e: any) { setDeployMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setSafetyBusy(false); }
  }, [apiBase, deployName, load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: loading ? 'Reloading…' : 'Reload', onClick: loading ? undefined : load, disabled: loading },
        { label: 'New job', onClick: gate ? undefined : () => setTab('submit'), disabled: !!gate },
      ]},
      { label: 'Model', actions: [
        { label: 'Progress', onClick: selected ? () => setTab('progress') : undefined, disabled: !selected },
        { label: 'Safety & deploy', onClick: current?.hasModel ? () => setTab('safety') : undefined, disabled: !current?.hasModel },
      ]},
    ]},
  ], [loading, load, gate, selected, current]);

  const detailsPanel = useMemo(() => {
    if (!current) return undefined;
    const sections: DetailsSection[] = [{
      key: 'job', title: 'Fine-tuning job',
      stats: [
        { key: 'id', label: 'Job', value: current.id },
        { key: 'base', label: 'Base model', value: current.baseModel || '—' },
        { key: 'status', label: 'Status', value: current.status },
        { key: 'model', label: 'Fine-tuned model', value: current.fineTunedModel || '—' },
        { key: 'tokens', label: 'Trained tokens', value: current.trainedTokens != null ? String(current.trainedTokens) : '—' },
      ],
    }];
    return <DetailsPanel title="Fine-tuning details" subtitle={current.id} sections={sections} />;
  }, [current]);

  const safetyBadgeColor = safety?.passed ? 'success' : (safety ? 'danger' : 'informative');

  return (
    <ItemEditorChrome
      splitKeyPrefix={item.slug}
      item={item}
      id={id}
      ribbon={ribbon}
      rightPanel={detailsPanel}
      rightPanelLabel="Details"
      leftPanel={
        <div style={{ padding: tokens.spacingVerticalS }}>
          <Caption1 style={{ padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, color: tokens.colorNeutralForeground3 }}>
            Fine-tuning jobs ({jobs.length})
          </Caption1>
          {jobs.length === 0 && !loading && (
            <Body1 style={{ padding: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
              {gate ? 'Backend not configured.' : 'No jobs yet — submit one on the Submit tab.'}
            </Body1>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
            {jobs.map((jb) => (
              <button
                key={jb.id}
                onClick={() => setSelected(jb.id)}
                style={{
                  textAlign: 'left', cursor: 'pointer', border: 'none', borderRadius: tokens.borderRadiusMedium,
                  padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
                  background: jb.id === selected ? tokens.colorNeutralBackground2 : 'transparent',
                  // Native <button>: without an explicit color, text inherits UA ButtonText (black-on-dark).
                  color: tokens.colorNeutralForeground1,
                }}
              >
                <div className={s.badges}>
                  <Body1 style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{jb.baseModel || jb.id}</Body1>
                  {jb.id === binding.jobId && <Badge appearance="tint" color="brand" size="small">bound</Badge>}
                </div>
                <div className={s.badges}>
                  <Badge appearance="tint" color={statusColor(jb.status)} size="small">{jb.status}</Badge>
                </div>
              </button>
            ))}
          </div>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading fine-tuning jobs…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody></MessageBar>
          )}

          {/* Honest gate (G2) — full surface still renders; inline Fix-it wizard. */}
          {gate && (
            <HonestGate
              gateId={gate.gateId}
              surface="Fine-tuning"
              missing={gate.missing}
              detail={gate.hint}
              onResolved={load}
            />
          )}

          {!loading && (
            <>
              <div className={s.badges}>
                <Badge appearance="filled" color="brand">{backend === 'databricks' ? 'Databricks Mosaic fine-tuning' : 'Azure OpenAI / AI Foundry fine-tuning'}</Badge>
                <Badge appearance="outline">{backend === 'databricks' ? 'opt-in backend' : 'Azure-native default'}</Badge>
                {current && <Badge appearance="tint" color={statusColor(current.status)}>{current.status}</Badge>}
              </div>

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
                <Tab value="overview">Overview</Tab>
                <Tab value="submit">Submit job</Tab>
                <Tab value="progress">Progress</Tab>
                <Tab value="safety">Safety &amp; deploy</Tab>
              </TabList>

              {/* ── Overview ── */}
              {tab === 'overview' && (
                <div className={s.card}>
                  <Subtitle2>Fine-tuning jobs</Subtitle2>
                  {jobs.length === 0 ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                      {gate ? 'Configure a fine-tuning backend to list jobs.' : 'No jobs yet. Submit one on the Submit job tab.'}
                    </Body1>
                  ) : (
                    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                      <Table aria-label="Fine-tuning jobs" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Base model</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Fine-tuned model</TableHeaderCell>
                          <TableHeaderCell>Job id</TableHeaderCell>
                          <TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {jobs.map((jb) => (
                            <TableRow key={jb.id} onClick={() => setSelected(jb.id)} style={{ cursor: 'pointer', background: jb.id === selected ? tokens.colorNeutralBackground2 : undefined }}>
                              <TableCell><strong>{jb.baseModel || '—'}</strong></TableCell>
                              <TableCell><Badge appearance="tint" color={statusColor(jb.status)}>{jb.status}</Badge></TableCell>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{jb.fineTunedModel || '—'}</TableCell>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>{jb.id}</TableCell>
                              <TableCell>
                                <div className={s.badges}>
                                  <Button size="small" appearance="subtle" disabled={jb.terminal} onClick={(e) => { e.stopPropagation(); cancelJob(jb.id); }}>Cancel</Button>
                                  {jb.hasModel && <Button size="small" appearance="subtle" onClick={(e) => { e.stopPropagation(); setSelected(jb.id); setTab('safety'); }}>Safety &amp; deploy</Button>}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}

              {/* ── Submit ── */}
              {tab === 'submit' && (
                <div className={s.card}>
                  <Subtitle2>Submit a fine-tuning job</Subtitle2>
                  <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Fine-tunes a base chat model on your labelled examples. The training data is validated (the training-data-eval gate) and uploaded, then a real fine-tuning job runs on {backend === 'databricks' ? 'Databricks Mosaic AI' : 'Azure OpenAI in Azure AI Foundry'}. One chat example per line, e.g. <code>{'{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}'}</code>.
                  </Body1>
                  <div className={s.form}>
                    <Field label="Base model" required>
                      {models.length ? (
                        <Dropdown placeholder="Select a base model" value={baseModel} selectedOptions={baseModel ? [baseModel] : []}
                          onOptionSelect={(_, d) => setBaseModel(d.optionValue || '')} disabled={!!gate}>
                          {models.map((m) => <Option key={`${m.name}:${m.version || ''}`} value={m.name}>{m.name}</Option>)}
                        </Dropdown>
                      ) : (
                        <Input value={baseModel} onChange={(_, d) => setBaseModel(d.value)} placeholder="e.g. gpt-4o-mini" disabled={!!gate} />
                      )}
                    </Field>
                    <Field label="Suffix" hint="Names the resulting model">
                      <Input value={suffix} onChange={(_, d) => setSuffix(d.value)} placeholder="e.g. support" style={{ width: 160 }} disabled={!!gate} />
                    </Field>
                    <Field label="Epochs" hint="blank = auto">
                      <Input type="number" value={epochs} onChange={(_, d) => setEpochs(d.value)} style={{ width: 96 }} disabled={!!gate} />
                    </Field>
                    <Field label="Seed" hint="optional">
                      <Input type="number" value={seed} onChange={(_, d) => setSeed(d.value)} style={{ width: 110 }} disabled={!!gate} />
                    </Field>
                  </div>
                  <Field label="Training data (JSONL)" required>
                    <Textarea className={s.mono} value={trainingData} onChange={(_, d) => setTrainingData(d.value)} resize="vertical"
                      placeholder={'{"messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}'} disabled={!!gate} />
                  </Field>
                  <div className={s.badges}>
                    <Button appearance="primary" icon={<Play20Regular />} disabled={submitting || !!gate || !baseModel.trim() || !trainingData.trim()} onClick={submit}>
                      {submitting ? 'Submitting…' : 'Submit fine-tuning job'}
                    </Button>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Needs at least 10 valid examples.</Caption1>
                  </div>
                  {submitMsg && <MessageBar intent={submitMsg.intent}><MessageBarBody>{submitMsg.text}</MessageBarBody></MessageBar>}
                </div>
              )}

              {/* ── Progress ── */}
              {tab === 'progress' && (
                <div className={s.card}>
                  <div className={s.badges}>
                    <Subtitle2>Training progress {selected ? `— ${selected}` : ''}</Subtitle2>
                    <Button size="small" appearance="subtle" icon={<ArrowClockwise20Regular />} disabled={!selected || eventsBusy} onClick={() => selected && loadEvents(selected)}>Refresh</Button>
                  </div>
                  {!selected ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>Select a job to see its training events.</Body1>
                  ) : eventsBusy && events.length === 0 ? (
                    <Spinner size="small" label="Reading job events…" labelPosition="after" />
                  ) : events.length === 0 ? (
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>No events yet — the job may be queued.</Body1>
                  ) : (
                    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
                      <Table aria-label="Training events" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Step</TableHeaderCell>
                          <TableHeaderCell>Train loss</TableHeaderCell>
                          <TableHeaderCell>Valid loss</TableHeaderCell>
                          <TableHeaderCell>Message</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {events.slice(0, 100).map((ev, i) => (
                            <TableRow key={i}>
                              <TableCell>{ev.step != null ? ev.step : '—'}</TableCell>
                              <TableCell>{ev.trainingLoss != null ? ev.trainingLoss.toFixed(4) : '—'}</TableCell>
                              <TableCell>{ev.validationLoss != null ? ev.validationLoss.toFixed(4) : '—'}</TableCell>
                              <TableCell style={{ color: tokens.colorNeutralForeground3 }}>{ev.message || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}

              {/* ── Safety & deploy ── */}
              {tab === 'safety' && (
                <>
                  <div className={s.card}>
                    <Subtitle2>Deploy the fine-tuned model</Subtitle2>
                    {!current?.hasModel ? (
                      <Body1 style={{ color: tokens.colorNeutralForeground3 }}>Select a succeeded job with a fine-tuned model to deploy and evaluate it.</Body1>
                    ) : (
                      <>
                        <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Deploys <code>{current.fineTunedModel}</code> as a real Azure OpenAI deployment (a strict content-filter policy is bound). The deployment is required to run the safety evaluation and is the served endpoint consumable by the Model serving item (WS-1.2).
                        </Body1>
                        <div className={s.form}>
                          <Field label="Deployment name" required>
                            <Input value={deployName} onChange={(_, d) => setDeployName(d.value)} placeholder="e.g. support-ft" disabled={!!gate} />
                          </Field>
                          <Button appearance="secondary" icon={<Rocket20Regular />} disabled={deployBusy || !!gate || !deployName.trim()} onClick={deploy}>
                            {deployBusy ? 'Deploying…' : 'Deploy model'}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>

                  <div className={s.card}>
                    <div className={s.badges}>
                      <Subtitle2>Resulting-model safety evaluation</Subtitle2>
                      {safety && <Badge appearance="filled" color={safetyBadgeColor}>{safety.passed ? `Approved (grade ${safety.grade})` : 'Blocked'}</Badge>}
                    </div>
                    <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Probes the deployed fine-tuned model with adversarial requests (Loom red-team) and scores each completion with Azure Content Safety (Foundry RAI). The model is approved for serving via WS-1.2 only when it refuses at a high rate (grade A/B) with no harmful completions.
                    </Body1>
                    <div className={s.badges}>
                      <Button appearance="primary" icon={<ShieldCheckmark20Regular />} disabled={safetyBusy || !!gate || !deployName.trim()} onClick={runSafety}>
                        {safetyBusy ? 'Evaluating…' : 'Run safety evaluation'}
                      </Button>
                    </div>
                    {deployMsg && <MessageBar intent={deployMsg.intent}><MessageBarBody>{deployMsg.text}</MessageBarBody></MessageBar>}
                    {safety && (
                      <>
                        <div className={s.tileRow}>
                          <div className={s.tile}>
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Refusal rate</Caption1>
                            <span className={s.tileVal}>{safety.refusalRate != null ? `${safety.refusalRate}%` : '—'}</span>
                          </div>
                          <div className={s.tile}>
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Attack success</Caption1>
                            <span className={s.tileVal} style={{ color: (safety.attackSuccessRate ?? 0) > 0 ? tokens.colorPaletteRedForeground1 : undefined }}>{safety.attackSuccessRate != null ? `${safety.attackSuccessRate}%` : '—'}</span>
                          </div>
                          <div className={s.tile}>
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Harmful completions</Caption1>
                            <span className={s.tileVal} style={{ color: (safety.unsafe ?? 0) > 0 ? tokens.colorPaletteRedForeground1 : undefined }}>{safety.unsafe ?? 0}</span>
                          </div>
                        </div>
                        <MessageBar intent={safety.passed ? 'success' : 'warning'} layout="multiline">
                          <MessageBarBody>
                            <MessageBarTitle>{safety.passed ? 'Approved for serving (WS-1.2)' : 'Not approved for serving'}</MessageBarTitle>
                            {safety.reason}
                          </MessageBarBody>
                        </MessageBar>
                        {safety.passed && binding.deployable && (
                          <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
                            Registered model <code>{binding.fineTunedModel || current?.fineTunedModel}</code> is deployed as <code>{binding.deploymentName || deployName}</code> and approved — open a <strong>Model serving endpoint</strong> item (WS-1.2) to route/monitor it.
                          </Body1>
                        )}
                      </>
                    )}
                    {deployments.length > 0 && (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Existing deployments on this account: {deployments.slice(0, 8).map((d) => d.name).join(', ')}
                      </Caption1>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      }
    />
  );
}
