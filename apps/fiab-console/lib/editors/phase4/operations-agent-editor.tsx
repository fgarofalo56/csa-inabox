'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Operations Agent editor.
 *
 * A Fabric-IQ operations agent that MONITORS real-time signals and can ACT.
 * Four tabs, all backed by real Azure services (no Microsoft Fabric — see
 * .claude/rules/no-fabric-dependency.md):
 *
 *   Configure  — instructions / model / tools + typed Eventhouse & Ontology
 *                bindings (dropdowns, no freeform ids) + Deploy to the Azure AI
 *                Foundry Agent Service.
 *   Test / Run — a live run pane. Grounds the question on the bound Eventhouse
 *                (ADX) via the NL→KQL→execute→re-ground loop and reasons with the
 *                shared AOAI deployment; OR, when the agent is deployed to
 *                Foundry, runs the published agent and shows its run steps.
 *                Backed by POST /api/items/operations-agent/[id]/run.
 *   Triggers   — time/data-change triggers as real Azure Monitor
 *                scheduledQueryRules (+ action group) over Log Analytics or the
 *                Eventhouse. Backed by /api/items/operations-agent/[id]/rules,
 *                which calls the SAME activator-monitor backend the Activator
 *                editor uses (no duplication).
 *   Proposals  — human-in-the-loop: the agent drafts an operational action
 *                (scale pool / scale ADX / toggle OAP / create workspace), a
 *                human approves the before→after diff, then it executes a REAL
 *                ARM / Cosmos write. Backed by the existing /api/admin/ops-copilot
 *                (classify) + /api/admin/ops-copilot/execute routes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Card, Tab, TabList,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  tokens,
} from '@fluentui/react-components';
import {
  Bot24Regular, Database20Regular, Add20Regular, Sparkle20Regular,
  Flash20Regular, Play20Regular, Pulse20Regular, ShieldCheckmark20Regular,
  ArrowSync16Regular, CheckmarkCircle20Regular, Settings20Regular,
} from '@fluentui/react-icons';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ItemEditorChrome } from '../item-editor-chrome';
import { safeModelJson } from '../model-fetch';
import { DataAgentResultViz } from '../data-agent-result-viz';
import { useItemState, SaveBar, useStyles } from './shared';

// ----- state --------------------------------------------------------------
interface AgentState {
  systemPrompt: string; model: string; tools: string;
  eventhouse: string; ontology: string;
  foundryAgentId?: string; foundryProjectId?: string; lastDeployedAt?: string;
  rules?: unknown[];
  [k: string]: unknown;
}

interface DeployResponse {
  ok: boolean; deferred?: boolean; agentId?: string; projectId?: string;
  lastDeployedAt?: string; error?: string; hint?: string;
}

// ----- run-pane shapes ----------------------------------------------------
interface RunTool { source: string; type?: string; action: string; query?: string; executed?: boolean; rowCount?: number; columns?: string[]; rows?: unknown[][]; gate?: string }
interface RunStep { id: string; type: string; status: string; toolCalls?: { type: string; name?: string; input?: string; output?: string }[]; error?: string | null }
interface RunMsg {
  role: 'user' | 'assistant'; content: string; error?: boolean;
  backend?: string; model?: string; usage?: { totalTokens?: number };
  tools?: RunTool[]; steps?: RunStep[]; status?: string; runId?: string;
}

interface ItemOption { id: string; name: string }

export function OperationsAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = !id || id === 'new';
  const { state, setState, loading, saving, error, savedAt, save, reload, dirty } = useItemState<AgentState>('operations-agent', id, {
    systemPrompt: 'You monitor real-time operational signals and trigger actions when thresholds are breached.',
    model: 'gpt-4o', tools: 'eventhouse-query, activator-trigger', eventhouse: '', ontology: '',
  });

  const [tab, setTab] = useState<'configure' | 'run' | 'triggers' | 'proposals'>('configure');

  // ---- typed binding pickers (no freeform ids — loom_no_freeform_config) ----
  const [ehOpts, setEhOpts] = useState<ItemOption[]>([]);
  const [ontoOpts, setOntoOpts] = useState<ItemOption[]>([]);
  useEffect(() => {
    const load = (type: string, set: (o: ItemOption[]) => void) => {
      clientFetch(`/api/items/by-type?types=${encodeURIComponent(type)}`)
        .then((r) => r.json())
        .then((j) => set((j.items || []).map((it: any) => ({ id: it.id, name: it.displayName || it.id }))))
        .catch(() => { /* leave empty; user can still type below */ });
    };
    load('eventhouse', setEhOpts);
    load('ontology', setOntoOpts);
  }, []);

  // ---- deploy to Foundry ----
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(null);
  const onDeploy = useCallback(async () => {
    setDeploying(true); setDeployResult(null);
    try {
      const saved = await save();
      if (!saved) { setDeployResult({ ok: false, error: 'Save failed before deploy — fix the save error and retry.' }); return; }
      const r = await clientFetch(`/api/items/operations-agent/${encodeURIComponent(id)}/deploy`, { method: 'POST' });
      const j: DeployResponse = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      setDeployResult(j);
      if (j.ok) await reload();
    } catch (e: any) {
      setDeployResult({ ok: false, error: e?.message || String(e) });
    } finally { setDeploying(false); }
  }, [id, save, reload]);

  const deployedAgentId = state.foundryAgentId;
  const deployedAt = state.lastDeployedAt;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Agent', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: () => save(), disabled: saving || dirty === false },
        { label: 'Configure', onClick: () => setTab('configure') },
        { label: 'Test / Run', onClick: () => setTab('run') },
        { label: 'Triggers', onClick: () => setTab('triggers') },
        { label: 'Proposals', onClick: () => setTab('proposals') },
        { label: deploying ? 'Deploying…' : 'Deploy to Foundry', onClick: onDeploy, disabled: deploying || saving },
      ]},
    ]},
  ], [save, saving, dirty, onDeploy, deploying]);

  const ehValue = ehOpts.find((o) => o.id === state.eventhouse)?.name || (state.eventhouse || '');
  const ontoValue = ontoOpts.find((o) => o.id === state.ontology)?.name || (state.ontology || '');

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
            <Tab value="configure" icon={<Settings20Regular />}>Configure</Tab>
            <Tab value="run" icon={<Play20Regular />}>Test / Run</Tab>
            <Tab value="triggers" icon={<Pulse20Regular />}>Triggers</Tab>
            <Tab value="proposals" icon={<ShieldCheckmark20Regular />}>Proposals</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading…" labelPosition="after" />}

          {/* ------------------------------ Configure ------------------------------ */}
          {tab === 'configure' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Azure-native operations agent</MessageBarTitle>
                  This agent&rsquo;s instructions, model, and tools are saved to your workspace. It runs against your bound <strong>Eventhouse</strong> (Azure Data Explorer) and Ontology — no Microsoft Fabric required. <strong>Deploy to Foundry</strong> optionally publishes the agent definition to the Azure AI Foundry Agent Service.
                </MessageBarBody>
              </MessageBar>
              {deployedAgentId && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Caption1>Deployed agent:</Caption1>
                  <Badge appearance="filled" color="success">{deployedAgentId}</Badge>
                  {state.foundryProjectId && <Badge appearance="outline">project {state.foundryProjectId}</Badge>}
                  {deployedAt && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>last deployed {new Date(deployedAt).toLocaleString()}</Caption1>}
                </div>
              )}

              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Bot24Regular /></span>
                  <Subtitle2>Agent</Subtitle2>
                </div>
                <Field label="System prompt" hint="What the agent watches for and when it should act.">
                  <Textarea value={state.systemPrompt} rows={6} onChange={(_, d) => setState((p) => ({ ...p, systemPrompt: d.value }))} />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
                  <Field label="Model" hint="AOAI deployment name (e.g. gpt-4o).">
                    <Input value={state.model} onChange={(_, d) => setState((p) => ({ ...p, model: d.value }))} />
                  </Field>
                  <Field label="Tools (comma-separated)">
                    <Input value={state.tools} onChange={(_, d) => setState((p) => ({ ...p, tools: d.value }))} />
                  </Field>
                </div>
              </div>

              <div className={s.daSection}>
                <div className={s.daSectionHead}>
                  <span className={s.daSectionIcon}><Database20Regular /></span>
                  <Subtitle2>Bindings</Subtitle2>
                  <Badge appearance="tint" color="brand">Eventhouse · ADX</Badge>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingHorizontalM }}>
                  <Field label="Eventhouse" hint="The Azure Data Explorer / Eventhouse the agent grounds on and triggers over.">
                    <Dropdown
                      value={ehValue}
                      selectedOptions={state.eventhouse ? [state.eventhouse] : []}
                      placeholder={ehOpts.length ? 'Select an Eventhouse…' : 'No Eventhouse items found'}
                      onOptionSelect={(_, d) => d.optionValue != null && setState((p) => ({ ...p, eventhouse: d.optionValue as string }))}
                    >
                      <Option value="">(none)</Option>
                      {ehOpts.map((o) => <Option key={o.id} value={o.id}>{o.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Ontology" hint="Optional Fabric-IQ ontology the agent reasons over.">
                    <Dropdown
                      value={ontoValue}
                      selectedOptions={state.ontology ? [state.ontology] : []}
                      placeholder={ontoOpts.length ? 'Select an ontology…' : 'No ontology items found'}
                      onOptionSelect={(_, d) => d.optionValue != null && setState((p) => ({ ...p, ontology: d.optionValue as string }))}
                    >
                      <Option value="">(none)</Option>
                      {ontoOpts.map((o) => <Option key={o.id} value={o.id}>{o.name}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              </div>

              {deployResult && (
                <MessageBar intent={deployResult.ok ? 'success' : deployResult.deferred ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>
                      {deployResult.ok ? 'Deployed to Foundry'
                        : deployResult.deferred ? 'Deploy deferred — Foundry not configured'
                        : 'Deploy failed'}
                    </MessageBarTitle>
                    {deployResult.ok && deployResult.agentId && (
                      <>Agent <code>{deployResult.agentId}</code> upserted in project <code>{deployResult.projectId}</code>. The Foundry Agent Service is now the source of truth for runtime behavior.</>
                    )}
                    {deployResult.error && <div>{deployResult.error}</div>}
                    {deployResult.hint && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>Hint:</em> {deployResult.hint}</div>}
                  </MessageBarBody>
                </MessageBar>
              )}

              <SaveBar
                saving={saving} savedAt={savedAt} error={error} dirty={dirty} onSave={() => save()}
                extraRight={
                  <Button appearance="primary" icon={<Flash20Regular />} onClick={onDeploy} disabled={deploying || saving}>
                    {deploying ? 'Deploying…' : 'Deploy to Foundry'}
                  </Button>
                }
              />
            </>
          )}

          {/* ------------------------------ Test / Run ------------------------------ */}
          {tab === 'run' && (isNew
            ? <SaveFirst what="Test / Run" />
            : <RunPane id={id} deployedAgentId={deployedAgentId} boundEventhouse={!!state.eventhouse} dirty={dirty} save={save} chatStyles={s} />)}

          {/* ------------------------------ Triggers ------------------------------ */}
          {tab === 'triggers' && (isNew
            ? <SaveFirst what="Triggers" />
            : <TriggersPane id={id} chatStyles={s} />)}

          {/* ------------------------------ Proposals ------------------------------ */}
          {tab === 'proposals' && (isNew
            ? <SaveFirst what="Proposals" />
            : <ProposalsPane chatStyles={s} agentName={item.displayName} />)}
        </div>
      </>
    } />
  );
}

// ---------------------------------------------------------------------------
function SaveFirst({ what }: { what: string }) {
  return (
    <MessageBar intent="info">
      <MessageBarBody>Save this operations agent first — <strong>{what}</strong> needs a persisted item bound to your workspace.</MessageBarBody>
    </MessageBar>
  );
}

// ---------------------------------------------------------------------------
// Test / Run pane — live grounded run (Eventhouse/ADX + AOAI) or published
// Foundry-agent run with real run steps.
// ---------------------------------------------------------------------------
type StyleBag = ReturnType<typeof useStyles>;

function RunPane({ id, deployedAgentId, boundEventhouse, dirty, save, chatStyles: s }: {
  id: string; deployedAgentId?: string; boundEventhouse: boolean;
  dirty: boolean; save: () => Promise<boolean>; chatStyles: StyleBag;
}) {
  const [chat, setChat] = useState<RunMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const el = threadRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat, asking]);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking) return;
    if (dirty) await save();
    const history = chat.filter((m) => !m.error).slice(-10).map((m) => ({ role: m.role, content: m.content }));
    setChat((c) => [...c, { role: 'user', content: q }]);
    setQuestion(''); setAsking(true);
    let asst: RunMsg;
    try {
      const r = await clientFetch(`/api/items/operations-agent/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
      });
      const res = await safeModelJson<{ answer?: string; backend?: string; model?: string; usage?: { totalTokens?: number }; tools?: RunTool[]; steps?: RunStep[]; status?: string; runId?: string; hint?: string }>(r);
      const j = res.data;
      if (res.ok && j) {
        asst = { role: 'assistant', content: String(j.answer ?? ''), backend: j.backend, model: j.model, usage: j.usage, tools: j.tools, steps: j.steps, status: j.status, runId: j.runId };
      } else {
        const detail = res.error || j?.error || `HTTP ${res.status}`;
        const hint = j?.hint ? `\n\n${j.hint}` : '';
        asst = { role: 'assistant', content: `${detail}${hint}`, error: true };
      }
    } catch (e: any) {
      asst = { role: 'assistant', content: e?.message || String(e), error: true };
    } finally { setAsking(false); }
    setChat((c) => [...c, asst]);
  }, [question, asking, chat, dirty, save, id]);

  return (
    <div className={s.chatShell}>
      <div className={s.chatHead}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Subtitle2>Test / Run</Subtitle2>
          <Badge appearance="tint" color="brand">{deployedAgentId ? 'Foundry agent' : 'live · grounded'}</Badge>
          <div style={{ flex: 1 }} />
          <Button size="small" appearance="subtle" onClick={() => { setChat([]); setQuestion(''); }} disabled={asking || (chat.length === 0 && !question)}>+ New run</Button>
        </div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          {deployedAgentId
            ? 'Runs the published Foundry agent (thread → run → steps). Falls back to the Azure-native grounded run if the agent is not reachable.'
            : 'Each turn grounds on the bound Eventhouse (ADX): the model writes KQL, Loom runs it read-only, and the answer is grounded on the real rows — via the same AOAI deployment as Copilot.'}
        </Caption1>
        {!deployedAgentId && !boundEventhouse && (
          <MessageBar intent="warning"><MessageBarBody>No Eventhouse bound — answers will be ungrounded. Bind an Eventhouse on the <strong>Configure</strong> tab for real grounded responses.</MessageBarBody></MessageBar>
        )}
      </div>

      <div ref={threadRef} className={s.chatThread} aria-live="polite">
        {chat.length === 0 && !asking && (
          <div style={{ margin: 'auto', textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
            <Body1 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Ask the operations agent a question to start a run.</Body1>
            <Caption1>e.g. &ldquo;Which nodes breached the CPU threshold in the last 15 minutes?&rdquo;</Caption1>
          </div>
        )}
        {chat.map((m, i) => {
          const tools = m.tools && m.tools.length ? m.tools : [];
          const meta = m.role === 'user' ? 'You' : m.error ? 'Agent · error' : 'Agent';
          const backendLabel = !m.error && m.backend ? ` · ${m.backend === 'foundry-published' ? 'Foundry' : 'ADX-grounded'}` : '';
          return (
            <div key={i} className={m.role === 'user' ? s.chatRowUser : s.chatRowBot}>
              <span className={s.chatMeta}>{meta}{backendLabel}{m.model && !m.error ? ` · ${m.model}` : ''}{m.usage?.totalTokens && !m.error ? ` · ${m.usage.totalTokens} tokens` : ''}</span>
              <div className={m.role === 'user' ? s.bubbleUser : m.error ? s.bubbleErr : s.bubbleBot}>
                {m.content || (m.error ? 'Unknown error' : '')}
              </div>
              {m.role === 'assistant' && !m.error && tools.length > 0 && (
                <details style={{ marginTop: tokens.spacingVerticalXXS }} open={tools.length === 1}>
                  <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 }}>Tools used ({tools.length})</summary>
                  {tools.map((t, ti) => (
                    <div key={ti} style={{ marginTop: tokens.spacingVerticalXS }}>
                      <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                        <strong>{t.source}</strong>{t.type ? ` · ${t.type}` : ''} · {t.action}
                        {t.executed && (
                          <Badge appearance="tint" color="success" size="extra-small" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>
                            ✓ ran · {t.rowCount ?? 0} row{t.rowCount === 1 ? '' : 's'}
                          </Badge>
                        )}
                      </Caption1>
                      {t.query && <pre className={s.chatSource}>{t.query}</pre>}
                      {t.executed && t.columns && t.columns.length > 0 && t.rows && t.rows.length > 0 && (
                        <DataAgentResultViz tool={t} />
                      )}
                      {!t.executed && t.gate && (
                        <Caption1 style={{ color: tokens.colorPaletteYellowForeground1, display: 'block', marginTop: tokens.spacingVerticalXXS }}>⚠ {t.gate}</Caption1>
                      )}
                    </div>
                  ))}
                </details>
              )}
              {m.role === 'assistant' && !m.error && m.steps && m.steps.length > 0 && (
                <details style={{ marginTop: tokens.spacingVerticalXXS }} open>
                  <summary style={{ cursor: 'pointer', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 }}>Run steps ({m.steps.length}){m.status ? ` · ${m.status}` : ''}</summary>
                  {m.steps.map((st, si) => (
                    <div key={st.id || si} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalSNudge }}>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                        <Badge appearance="outline">{st.type}</Badge>
                        <Badge appearance="filled" color={st.status === 'completed' ? 'success' : st.status === 'failed' ? 'danger' : 'informative'}>{st.status}</Badge>
                      </div>
                      {(st.toolCalls || []).map((tc, j) => (
                        <div key={j} style={{ marginTop: tokens.spacingVerticalSNudge, fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, minWidth: 0, overflowWrap: 'anywhere' }}>
                          <div><strong>{tc.type}{tc.name ? ` · ${tc.name}` : ''}</strong></div>
                          {tc.input && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: tokens.colorNeutralForeground3 }}>{tc.input}</div>}
                          {tc.output && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{tc.output}</div>}
                        </div>
                      ))}
                      {st.error && <div style={{ color: tokens.colorPaletteRedForeground1, marginTop: tokens.spacingVerticalXS }}>{st.error}</div>}
                    </div>
                  ))}
                </details>
              )}
            </div>
          );
        })}
        {asking && (
          <div className={s.chatRowBot}>
            <span className={s.chatMeta}>Agent</span>
            <div className={s.bubbleBot} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Spinner size="tiny" /> Running…
            </div>
          </div>
        )}
      </div>

      <div className={s.chatComposer}>
        <Textarea
          value={question}
          onChange={(_, d) => setQuestion(d.value)}
          placeholder="Ask the operations agent…  (Enter to run · Shift+Enter for a new line)"
          resize="none" rows={2}
          textarea={{ style: { maxHeight: 120, overflowY: 'auto' } }}
          style={{ flex: 1 }}
          disabled={asking}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (question.trim() && !asking) ask(); } }}
        />
        <Button appearance="primary" icon={<Play20Regular />} onClick={ask} disabled={!question.trim() || asking}>{asking ? 'Running…' : 'Run'}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Triggers pane — real Azure Monitor scheduledQueryRules (Log Analytics or
// Eventhouse/ADX) via /api/items/operations-agent/[id]/rules.
// ---------------------------------------------------------------------------
interface OpsRule {
  id: string; name: string; query?: string; azureRuleName?: string; severity?: number;
  evaluationFrequency?: string; windowSize?: string; state?: string; sourceKind?: string;
  scheduled?: boolean; note?: string;
}
const SEVERITY_OPTS = [
  { value: 0, label: '0 — Critical' }, { value: 1, label: '1 — Error' }, { value: 2, label: '2 — Warning' },
  { value: 3, label: '3 — Informational' }, { value: 4, label: '4 — Verbose' },
];
const FREQ_OPTS = ['PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'P1D'];
const WINDOW_OPTS = ['PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H', 'PT24H'];
const SOURCE_OPTS = [
  { value: 'adx', label: 'Eventhouse (ADX)' },
  { value: 'log-analytics', label: 'Log Analytics' },
];

function TriggersPane({ id, chatStyles: s }: { id: string; chatStyles: StyleBag }) {
  const [rules, setRules] = useState<OpsRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ reason?: string; remediation?: string } | null>(null);

  const [ruleName, setRuleName] = useState('');
  const [query, setQuery] = useState('');
  const [sourceTable, setSourceTable] = useState('');
  const [sourceKind, setSourceKind] = useState<'adx' | 'log-analytics'>('adx');
  const [adxDatabase, setAdxDatabase] = useState('');
  const [severity, setSeverity] = useState(2);
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [winSize, setWinSize] = useState('PT5M');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [triggerResult, setTriggerResult] = useState<{ ruleId: string; fired: boolean; count: number } | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    setLoading(true); setListErr(null); setGate(null);
    try {
      const r = await clientFetch(`/api/items/operations-agent/${encodeURIComponent(id)}/rules`);
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setRules([]); if (j?.gate) setGate(j.gate); setListErr(j?.error || `HTTP ${r.status}`); return; }
      setRules(Array.isArray(j.rules) ? j.rules : []);
    } catch (e: any) { setRules([]); setListErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { loadRules(); }, [loadRules]);

  const createRule = useCallback(async () => {
    if (!ruleName.trim()) return;
    setCreating(true); setCreateErr(null); setGate(null);
    const body: Record<string, unknown> = { name: ruleName.trim(), severity, evaluationFrequency: evalFreq, windowSize: winSize, sourceKind };
    if (query.trim()) body.query = query.trim();
    if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
    if (sourceKind === 'adx' && adxDatabase.trim()) body.adxDatabase = adxDatabase.trim();
    try {
      const r = await clientFetch(`/api/items/operations-agent/${encodeURIComponent(id)}/rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { if (j?.gate) setGate(j.gate); setCreateErr(j?.error || j?.gate?.remediation || `HTTP ${r.status}`); return; }
      setRuleName(''); setQuery(''); setSourceTable('');
      await loadRules();
    } catch (e: any) { setCreateErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }, [ruleName, query, sourceTable, sourceKind, adxDatabase, severity, evalFreq, winSize, id, loadRules]);

  const triggerNow = useCallback(async (ruleId: string) => {
    setTriggering(ruleId); setTriggerResult(null); setListErr(null); setGate(null);
    try {
      const r = await clientFetch(`/api/items/operations-agent/${encodeURIComponent(id)}/rules?trigger=${encodeURIComponent(ruleId)}`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { if (j?.gate) setGate(j.gate); setListErr(j?.error || j?.gate?.remediation || `HTTP ${r.status}`); return; }
      setTriggerResult({ ruleId, fired: !!j.fired, count: typeof j.count === 'number' ? j.count : (Array.isArray(j.rows) ? j.rows.length : 0) });
    } catch (e: any) { setListErr(e?.message || String(e)); }
    finally { setTriggering(null); }
  }, [id]);

  const deleteRule = useCallback(async (ruleId: string) => {
    setDeleting(ruleId); setListErr(null); setGate(null);
    try {
      const r = await clientFetch(`/api/items/operations-agent/${encodeURIComponent(id)}/rules?ruleId=${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { if (j?.gate) setGate(j.gate); setListErr(j?.error || `HTTP ${r.status}`); return; }
      await loadRules();
    } catch (e: any) { setListErr(e?.message || String(e)); }
    finally { setDeleting(null); }
  }, [id, loadRules]);

  return (
    <div className={s.daSection}>
      <div className={s.daSectionHead}>
        <span className={s.daSectionIcon}><Pulse20Regular /></span>
        <Subtitle2>Triggers</Subtitle2>
        <Badge appearance="tint" color="brand">Azure Monitor</Badge>
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadRules} disabled={loading}>Refresh</Button>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Fire actions on time / data-change. Each trigger is a real
        <strong> Microsoft.Insights/scheduledQueryRule</strong> (+ action group) evaluating KQL over the Eventhouse (ADX) or Log Analytics on a cadence — no Microsoft Fabric required.
      </Caption1>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure Monitor not configured</MessageBarTitle>
            {gate.reason && <div>{gate.reason}</div>}
            {gate.remediation && <div style={{ marginTop: tokens.spacingVerticalXS }}><em>To enable:</em> {gate.remediation}</div>}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* New trigger (typed wizard — no freeform JSON). */}
      <div className={s.daAddBar} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Trigger name" style={{ minWidth: 200 }}>
            <Input value={ruleName} onChange={(_, d) => setRuleName(d.value)} placeholder="e.g. CPU threshold breach" />
          </Field>
          <Field label="Source">
            <Dropdown value={SOURCE_OPTS.find((o) => o.value === sourceKind)?.label} selectedOptions={[sourceKind]}
              onOptionSelect={(_, d) => d.optionValue && setSourceKind(d.optionValue as 'adx' | 'log-analytics')}>
              {SOURCE_OPTS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Severity">
            <Dropdown value={SEVERITY_OPTS.find((o) => o.value === severity)?.label} selectedOptions={[String(severity)]}
              onOptionSelect={(_, d) => d.optionValue != null && setSeverity(Number(d.optionValue))}>
              {SEVERITY_OPTS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Evaluate every">
            <Dropdown value={evalFreq} selectedOptions={[evalFreq]} onOptionSelect={(_, d) => d.optionValue && setEvalFreq(d.optionValue)}>
              {FREQ_OPTS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Lookback window">
            <Dropdown value={winSize} selectedOptions={[winSize]} onOptionSelect={(_, d) => d.optionValue && setWinSize(d.optionValue)}>
              {WINDOW_OPTS.map((o) => <Option key={o} value={o}>{o}</Option>)}
            </Dropdown>
          </Field>
        </div>
        <Field label="Alert KQL" hint="The trigger fires when this query returns one or more rows. Leave blank to alert on any new row in the source table below.">
          <Textarea value={query} rows={3} onChange={(_, d) => setQuery(d.value)} placeholder={'Metrics\n| where cpu_pct > 90\n| where Timestamp > ago(15m)'} />
        </Field>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Source table (optional)" hint="Used to compose the query when Alert KQL is blank." style={{ minWidth: 220 }}>
            <Input value={sourceTable} onChange={(_, d) => setSourceTable(d.value)} placeholder="Metrics" />
          </Field>
          {sourceKind === 'adx' && (
            <Field label="Eventhouse database (optional)" hint="Defaults to the shared ADX database." style={{ minWidth: 220 }}>
              <Input value={adxDatabase} onChange={(_, d) => setAdxDatabase(d.value)} placeholder="loomdb-default" />
            </Field>
          )}
          <Button appearance="primary" icon={<Add20Regular />} onClick={createRule} disabled={creating || !ruleName.trim()}>
            {creating ? 'Creating…' : 'Create trigger'}
          </Button>
        </div>
        {createErr && !gate && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{createErr}</Caption1>}
      </div>

      {loading && <Spinner size="tiny" label="Loading triggers…" labelPosition="after" />}
      {!loading && rules.length === 0 && !gate && !listErr && (
        <MessageBar intent="info"><MessageBarBody>
          <Pulse20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalSNudge }} />
          No triggers yet. Create one above to fire actions on this agent&rsquo;s data via Azure Monitor.
        </MessageBarBody></MessageBar>
      )}
      {!loading && listErr && !gate && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
      {rules.map((r) => (
        <div key={r.id} className={s.daSrcCard}>
          <div className={s.daSrcHead}>
            <span className={s.daSrcIcon}><Pulse20Regular /></span>
            <strong>{r.name}</strong>
            {r.state && <Badge appearance="tint" color={r.state === 'Active' ? 'success' : 'warning'}>{r.state}</Badge>}
            <Badge appearance="outline">{r.sourceKind === 'adx' ? 'ADX' : 'Log Analytics'}</Badge>
            {typeof r.severity === 'number' && <Badge appearance="outline">sev {r.severity}</Badge>}
            <Badge appearance="outline">{r.evaluationFrequency} / {r.windowSize}</Badge>
            <div style={{ flex: 1 }} />
            <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => triggerNow(r.id)} disabled={triggering === r.id}>
              {triggering === r.id ? 'Running…' : 'Trigger now'}
            </Button>
            <Button size="small" appearance="subtle" onClick={() => deleteRule(r.id)} disabled={deleting === r.id} style={{ color: tokens.colorPaletteRedForeground1 }}>
              {deleting === r.id ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
          {r.query && <pre className={s.chatSource}>{r.query}</pre>}
          {r.note && <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>⚠ {r.note}</Caption1>}
          {triggerResult && triggerResult.ruleId === r.id && (
            <Caption1 style={{ color: triggerResult.fired ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
              {triggerResult.fired
                ? `Would fire — ${triggerResult.count} matching row${triggerResult.count === 1 ? '' : 's'} right now.`
                : 'No matching rows right now — the trigger would not fire.'}
            </Caption1>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposals pane — human-in-the-loop. The agent drafts an operational action
// (classify), a human approves the before→after diff, then it executes a REAL
// ARM / Cosmos write. Backed by /api/admin/ops-copilot + /execute.
// ---------------------------------------------------------------------------
interface Proposal {
  intentionId?: string; diffSummary?: string;
  diff?: { label: string; before: string; after: string }[];
  clarify?: string; rbacGate?: string; configGate?: string;
}
function ProposalsPane({ chatStyles: s, agentName }: { chatStyles: StyleBag; agentName?: string }) {
  const [prompt, setPrompt] = useState('');
  const [classifying, setClassifying] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [classErr, setClassErr] = useState<string | null>(null);

  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<{ ok: boolean; detail?: string; roleGate?: string; configGate?: string; error?: string } | null>(null);

  const classify = useCallback(async () => {
    const p = prompt.trim();
    if (!p || classifying) return;
    setClassifying(true); setProposal(null); setClassErr(null); setExecResult(null);
    try {
      const r = await fetch('/api/admin/ops-copilot', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: p }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403 && j?.rbacGate) { setProposal({ rbacGate: j.rbacGate }); return; }
      if (r.status === 503) { setClassErr(j?.error || 'No AOAI model deployed. Deploy one from the AI Foundry hub.'); return; }
      if (j?.configGate) { setProposal({ configGate: j.configGate }); return; }
      if (!j?.ok) { setClassErr(j?.error || `HTTP ${r.status}`); return; }
      if (j.clarify) { setProposal({ clarify: j.clarify }); return; }
      setProposal({ intentionId: j.intentionId, diffSummary: j.diffSummary, diff: j.diff || [] });
    } catch (e: any) { setClassErr(e?.message || String(e)); }
    finally { setClassifying(false); }
  }, [prompt, classifying]);

  const execute = useCallback(async () => {
    if (!proposal?.intentionId || executing) return;
    setExecuting(true); setExecResult(null);
    try {
      const r = await fetch('/api/admin/ops-copilot/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intentionId: proposal.intentionId }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.roleGate) { setExecResult({ ok: false, roleGate: j.roleGate }); return; }
      if (j?.configGate) { setExecResult({ ok: false, configGate: j.configGate }); return; }
      if (!j?.ok) { setExecResult({ ok: false, error: j?.error || `HTTP ${r.status}` }); return; }
      setExecResult({ ok: true, detail: j.detail });
      setProposal(null);
    } catch (e: any) { setExecResult({ ok: false, error: e?.message || String(e) }); }
    finally { setExecuting(false); }
  }, [proposal, executing]);

  return (
    <div className={s.daSection}>
      <div className={s.daSectionHead}>
        <span className={s.daSectionIcon}><ShieldCheckmark20Regular /></span>
        <Subtitle2>Proposals</Subtitle2>
        <Badge appearance="tint" color="brand">human-in-the-loop</Badge>
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        {agentName ? <>{agentName} </> : null}drafts an operational action from your request, shows the before→after diff, and executes a <strong>real</strong> Azure change only after you approve — scale a Synapse pool / ADX cluster, toggle outbound access, or create a workspace. No action runs without approval.
      </Caption1>

      <Field label="Describe the operation">
        <Textarea value={prompt} rows={2} onChange={(_, d) => setPrompt(d.value)}
          placeholder="e.g. Scale the ADX cluster to Standard_E8ads_v5, or scale the SQL pool to DW500c"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); classify(); } }} />
      </Field>
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
        <Button appearance="primary" icon={<Sparkle20Regular />} onClick={classify} disabled={classifying || !prompt.trim()}>
          {classifying ? 'Drafting…' : 'Draft proposal'}
        </Button>
        {classifying && <Spinner size="tiny" />}
      </div>

      {classErr && <MessageBar intent="error"><MessageBarBody>{classErr}</MessageBarBody></MessageBar>}

      {proposal?.rbacGate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Not authorized</MessageBarTitle><div>{proposal.rbacGate}</div></MessageBarBody></MessageBar>
      )}
      {proposal?.configGate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Resource not configured</MessageBarTitle><div>{proposal.configGate}</div></MessageBarBody></MessageBar>
      )}
      {proposal?.clarify && (
        <MessageBar intent="info"><MessageBarBody><MessageBarTitle>Needs clarification</MessageBarTitle><div>{proposal.clarify}</div></MessageBarBody></MessageBar>
      )}

      {proposal?.intentionId && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
            <CheckmarkCircle20Regular style={{ color: tokens.colorBrandForeground1 }} />
            <Subtitle2>Proposed change</Subtitle2>
            <Badge appearance="tint" color="warning">awaiting approval</Badge>
          </div>
          <Body1>{proposal.diffSummary}</Body1>
          {proposal.diff && proposal.diff.length > 0 && (
            <Table aria-label="Proposed change diff" size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Field</TableHeaderCell>
                <TableHeaderCell>Before</TableHeaderCell>
                <TableHeaderCell>After</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {proposal.diff.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell>{d.label}</TableCell>
                    <TableCell><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{d.before}</Caption1></TableCell>
                    <TableCell><strong>{d.after}</strong></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
            <Button appearance="primary" icon={<CheckmarkCircle20Regular />} onClick={execute} disabled={executing}>
              {executing ? 'Executing…' : 'Approve & execute'}
            </Button>
            <Button appearance="subtle" onClick={() => setProposal(null)} disabled={executing}>Discard</Button>
            {executing && <Spinner size="tiny" />}
          </div>
        </Card>
      )}

      {execResult?.ok && (
        <MessageBar intent="success"><MessageBarBody><MessageBarTitle>Executed</MessageBarTitle><div>{execResult.detail}</div></MessageBarBody></MessageBar>
      )}
      {execResult?.roleGate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure rejected — missing role</MessageBarTitle><div>{execResult.roleGate}</div></MessageBarBody></MessageBar>
      )}
      {execResult?.configGate && (
        <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Resource not configured</MessageBarTitle><div>{execResult.configGate}</div></MessageBarBody></MessageBar>
      )}
      {execResult && !execResult.ok && !execResult.roleGate && !execResult.configGate && (
        <MessageBar intent="error"><MessageBarBody>{execResult.error}</MessageBarBody></MessageBar>
      )}
    </div>
  );
}
