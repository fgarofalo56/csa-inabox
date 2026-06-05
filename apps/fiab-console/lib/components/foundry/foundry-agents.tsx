'use client';

/**
 * FoundryAgentsPanel — the flagship "Agents" surface of the new Microsoft
 * Foundry portal, rebuilt in CSA Loom with full functionality + real backend.
 *
 * Two columns:
 *   1. Agent builder — list agents (name / model / description), a create/edit
 *      form (name, model deployment picker, instructions, tools multi-select:
 *      code_interpreter / file_search / function), Save (→ createOrUpdateAgent),
 *      Delete (→ deleteAgent).
 *   2. Playground / test pane — pick an agent, ask a question → POST
 *      /api/foundry/agents/run → render the final answer + the run STEPS
 *      (tool calls / status), the same inspector pattern the Data Agent uses.
 *
 * Every control calls a real BFF route backed by the Foundry Agent Service REST
 * (lib/azure/foundry-agent-client). When LOOM_FOUNDRY_PROJECT_ENDPOINT is unset
 * (the live case), each route returns 501 code:'not_configured' and this surface
 * renders a Fluent warning MessageBar naming the env var — the FULL UI still
 * renders (honest gate, not a greyed stub). No mocks (.claude/rules/no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Spinner, Button, Input, Textarea, Field,
  Dropdown, Option, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Bot24Regular, Play16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', minHeight: '0', flex: '1' },
  cols: { display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1fr)', gap: '16px', alignItems: 'start' },
  col: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '260px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '4px' },
  agentRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '4px', cursor: 'pointer' },
  agentRowSel: { backgroundColor: tokens.colorNeutralBackground1Selected },
  grow: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  form: { display: 'flex', flexDirection: 'column', gap: '8px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '12px' },
  toolsRow: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  step: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', padding: '8px', marginTop: '6px' },
  stepHead: { display: 'flex', gap: '8px', alignItems: 'center' },
  mono: { fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  answer: { whiteSpace: 'pre-wrap', marginTop: '6px' },
  empty: { color: tokens.colorNeutralForeground3, fontStyle: 'italic', padding: '8px' },
});

const TOOL_TYPES = [
  { value: 'code_interpreter', label: 'Code interpreter' },
  { value: 'file_search', label: 'File search' },
  { value: 'function', label: 'Function calling' },
] as const;
type ToolType = (typeof TOOL_TYPES)[number]['value'];

interface AgentRow {
  name: string;
  description?: string;
  definition?: Record<string, unknown>;
  metadata?: Record<string, string>;
}

interface DeploymentRow { name: string; modelName?: string }

interface Gate { msg: string; hint?: string }

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

/** Extract a model string from a Foundry agent's definition (loose schema). */
function agentModel(a: AgentRow): string {
  const def = (a.definition || {}) as any;
  return typeof def?.model === 'string' ? def.model : '';
}
function agentInstructions(a: AgentRow): string {
  const def = (a.definition || {}) as any;
  return typeof def?.instructions === 'string' ? def.instructions : '';
}
/** Pull the tool TYPE list off an agent definition's free-form tools array. */
function agentToolTypes(a: AgentRow): ToolType[] {
  const def = (a.definition || {}) as any;
  const tools = Array.isArray(def?.tools) ? def.tools : [];
  const out: ToolType[] = [];
  for (const t of tools) {
    const ty = typeof t?.type === 'string' ? t.type : '';
    if (TOOL_TYPES.some((x) => x.value === ty) && !out.includes(ty as ToolType)) out.push(ty as ToolType);
  }
  return out;
}

export interface FoundryAgentsAccount { name?: string; resourceGroup?: string }

/**
 * Agents builder + playground. `acct` (selected AOAI/AI-Services account) feeds
 * the model-deployment picker; agents themselves live on the Foundry PROJECT
 * (LOOM_FOUNDRY_PROJECT_ENDPOINT), independent of the account selector.
 */
export function FoundryAgentsPanel({ active, nonce = 0, acct = null }: { active: boolean; nonce?: number; acct?: FoundryAgentsAccount | null }) {
  const s = useStyles();

  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<Gate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  // model deployments for the picker (from the selected account)
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);

  // ---- editor form ----
  const [selected, setSelected] = useState<string | null>(null);
  const [fName, setFName] = useState('');
  const [fModel, setFModel] = useState('');
  const [fInstructions, setFInstructions] = useState('');
  const [fTools, setFTools] = useState<ToolType[]>([]);
  const [fDescription, setFDescription] = useState('');
  const [fFnName, setFFnName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // ---- playground ----
  const [pgAgent, setPgAgent] = useState('');
  const [pgQuestion, setPgQuestion] = useState('');
  const [pgRunning, setPgRunning] = useState(false);
  const [pgResult, setPgResult] = useState<any>(null);
  const [pgGate, setPgGate] = useState<string | null>(null);
  const [pgError, setPgError] = useState<string | null>(null);

  const accountKey = `${acct?.name || ''}|${acct?.resourceGroup || ''}`;

  const withAccount = useCallback((url: string) => {
    if (!acct?.name) return url;
    const sep = url.includes('?') ? '&' : '?';
    const rg = acct.resourceGroup ? `&rg=${encodeURIComponent(acct.resourceGroup)}` : '';
    return `${url}${sep}account=${encodeURIComponent(acct.name)}${rg}`;
  }, [acct]);

  const loadAgents = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/foundry/agents');
      const j = await readJson(res);
      if (res.status === 501 || j?.code === 'not_configured') {
        setGate({ msg: j?.error || 'Foundry Agent Service not configured.', hint: j?.hint });
        setAgents([]); setProjectId(null);
        return;
      }
      setGate(null);
      if (!j.ok) { setError(j.error || `HTTP ${res.status}`); return; }
      setAgents(Array.isArray(j.agents) ? j.agents : []);
      setProjectId(typeof j.projectId === 'string' ? j.projectId : null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDeployments = useCallback(async () => {
    try {
      const res = await fetch(withAccount('/api/foundry/model-deployments'));
      const j = await readJson(res);
      if (j?.ok && Array.isArray(j.deployments)) setDeployments(j.deployments);
      else setDeployments([]);
    } catch { setDeployments([]); }
  }, [withAccount]);

  useEffect(() => {
    if (!active) return;
    loadAgents();
    loadDeployments();
  }, [active, nonce, accountKey, loadAgents, loadDeployments]);

  const resetForm = useCallback(() => {
    setSelected(null); setFName(''); setFModel(''); setFInstructions('');
    setFTools([]); setFDescription(''); setFFnName(''); setSaveMsg(null);
  }, []);

  const openAgent = useCallback((a: AgentRow) => {
    setSelected(a.name);
    setFName(a.name);
    setFModel(agentModel(a));
    setFInstructions(agentInstructions(a));
    setFTools(agentToolTypes(a));
    setFDescription(a.description || '');
    setFFnName('');
    setSaveMsg(null);
    setPgAgent(a.name);
  }, []);

  const toggleTool = useCallback((t: ToolType, checked: boolean) => {
    setFTools((prev) => (checked ? Array.from(new Set([...prev, t])) : prev.filter((x) => x !== t)));
  }, []);

  /** Build the free-form FoundryAgentBody.tools array from the checked types. */
  const buildTools = useCallback((): Array<Record<string, unknown>> => {
    return fTools.map((t) => {
      if (t === 'function') {
        const name = fFnName.trim() || 'my_function';
        return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } };
      }
      return { type: t };
    });
  }, [fTools, fFnName]);

  const save = useCallback(async () => {
    const name = fName.trim();
    if (!name || !fModel.trim() || !fInstructions.trim()) {
      setSaveMsg({ intent: 'error', text: 'Name, model, and instructions are required.' });
      return;
    }
    setSaving(true); setSaveMsg(null);
    try {
      const payload: any = {
        name,
        model: fModel.trim(),
        instructions: fInstructions,
        tools: buildTools(),
      };
      if (fDescription.trim()) payload.description = fDescription.trim();
      const res = await fetch('/api/foundry/agents', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await readJson(res);
      if (res.status === 501 || j?.code === 'not_configured') {
        setGate({ msg: j?.error || 'Foundry Agent Service not configured.', hint: j?.hint });
        setSaveMsg({ intent: 'error', text: 'Foundry Agent Service not configured — see the gate above.' });
        return;
      }
      if (!j.ok) { setSaveMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      setSaveMsg({ intent: 'success', text: `Agent "${name}" saved.` });
      setSelected(name);
      setPgAgent(name);
      await loadAgents();
    } catch (e: any) {
      setSaveMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setSaving(false);
    }
  }, [fName, fModel, fInstructions, fDescription, buildTools, loadAgents]);

  const del = useCallback(async (name: string) => {
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch(`/api/foundry/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await readJson(res);
      if (res.status === 501 || j?.code === 'not_configured') {
        setGate({ msg: j?.error || 'Foundry Agent Service not configured.', hint: j?.hint });
        return;
      }
      if (!j.ok) { setSaveMsg({ intent: 'error', text: j.error || `delete failed` }); return; }
      if (selected === name) resetForm();
      if (pgAgent === name) setPgAgent('');
      await loadAgents();
    } catch (e: any) {
      setSaveMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setSaving(false);
    }
  }, [selected, pgAgent, resetForm, loadAgents]);

  // ---- playground run ----
  const runPlayground = useCallback(async () => {
    const agent = pgAgent.trim(); const q = pgQuestion.trim();
    if (!agent || !q || pgRunning) return;
    setPgRunning(true); setPgResult(null); setPgGate(null); setPgError(null);
    try {
      const res = await fetch('/api/foundry/agents/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, question: q }),
      });
      const j = await readJson(res);
      if (res.status === 501 || j?.code === 'not_configured') {
        setPgGate(j?.hint || j?.error || 'Foundry Agent Service not configured.');
        return;
      }
      if (!j.ok) { setPgError(j.error || `HTTP ${res.status}`); return; }
      setPgResult(j.data);
    } catch (e: any) {
      setPgError(e?.message || String(e));
    } finally {
      setPgRunning(false);
    }
  }, [pgAgent, pgQuestion, pgRunning]);

  const deploymentNames = useMemo(() => {
    const names = deployments.map((d) => d.name).filter(Boolean);
    // ensure the currently-selected model is offered even if not in the list
    if (fModel && !names.includes(fModel)) names.unshift(fModel);
    return names;
  }, [deployments, fModel]);

  if (!active) return null;

  return (
    <div className={s.root}>
      <div className={s.toolbar}>
        <Bot24Regular />
        <Subtitle2>Agents</Subtitle2>
        {projectId && <Badge appearance="outline" title="Foundry project (LOOM_FOUNDRY_PROJECT_ID)">project {projectId.slice(0, 8)}…</Badge>}
        <div style={{ flex: 1 }} />
        <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={resetForm}>New agent</Button>
        <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => { loadAgents(); loadDeployments(); }} disabled={loading}>Refresh</Button>
      </div>

      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Build an agent (model + instructions + tools) and test it in the playground. Every control calls the live
        Foundry Agent Service REST on the project endpoint.
      </Caption1>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Azure AI Foundry Agent Service not configured</MessageBarTitle>
            {gate.msg}
            {gate.hint ? <><br /><Caption1>{gate.hint}</Caption1></> : null}
            <br />
            <Caption1>
              Set <code>LOOM_FOUNDRY_PROJECT_ENDPOINT</code> (a Microsoft Foundry <strong>project</strong> endpoint shaped{' '}
              <code>https://&lt;ai-services-account&gt;.services.ai.azure.com/api/projects/&lt;project&gt;</code>) plus{' '}
              <code>LOOM_FOUNDRY_PROJECT_ID</code>. Provision the project via{' '}
              <code>platform/fiab/bicep/modules/ai/foundry-project.bicep</code> and grant the Loom UAMI the{' '}
              <strong>Azure AI User</strong> role at the project scope. The full Agents UI still renders below — it just can't reach a backend yet.
            </Caption1>
          </MessageBarBody>
        </MessageBar>
      )}
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Agents error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

      <div className={s.cols}>
        {/* ------- Left: builder ------- */}
        <div className={s.col}>
          <Caption1>Agents{loading ? ' · loading…' : ` (${agents.length})`}</Caption1>
          <div className={s.list}>
            {loading && <div className={s.empty}><Spinner size="tiny" label="Loading agents…" /></div>}
            {!loading && agents.length === 0 && <div className={s.empty}>No agents yet. Fill the form to create one.</div>}
            {agents.map((a) => (
              <div
                key={a.name}
                className={`${s.agentRow} ${selected === a.name ? s.agentRowSel : ''}`}
                role="button" tabIndex={0}
                onClick={() => openAgent(a)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAgent(a); } }}
              >
                <Bot24Regular />
                <span className={s.grow}>
                  <strong>{a.name}</strong>
                  {agentModel(a) && <Caption1 style={{ marginLeft: 6, color: tokens.colorNeutralForeground3 }}>{agentModel(a)}</Caption1>}
                  {a.description && <><br /><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{a.description}</Caption1></>}
                </span>
                <Button
                  size="small" appearance="subtle" icon={<Delete16Regular />} disabled={saving}
                  aria-label={`Delete ${a.name}`}
                  onClick={(e) => { e.stopPropagation(); del(a.name); }}
                />
              </div>
            ))}
          </div>

          <div className={s.form}>
            <Subtitle2>{selected ? `Edit "${selected}"` : 'Create an agent'}</Subtitle2>
            <Field label="Name" required>
              <Input value={fName} onChange={(_, d) => setFName(d.value)} placeholder="finance-assistant" disabled={!!selected} />
            </Field>
            <Field label="Model (deployment)" required>
              {deploymentNames.length > 0 ? (
                <Dropdown
                  value={fModel}
                  selectedOptions={fModel ? [fModel] : []}
                  placeholder="Select a model deployment"
                  onOptionSelect={(_, d) => d.optionValue && setFModel(d.optionValue)}
                >
                  {deploymentNames.map((n) => <Option key={n} value={n} text={n}>{n}</Option>)}
                </Dropdown>
              ) : (
                <Input value={fModel} onChange={(_, d) => setFModel(d.value)} placeholder="gpt-4o" />
              )}
            </Field>
            <Field label="Instructions" required>
              <Textarea value={fInstructions} rows={5} onChange={(_, d) => setFInstructions(d.value)} placeholder="You are a helpful assistant that…" />
            </Field>
            <Field label="Tools">
              <div className={s.toolsRow}>
                {TOOL_TYPES.map((t) => (
                  <Checkbox key={t.value} label={t.label} checked={fTools.includes(t.value)} onChange={(_, d) => toggleTool(t.value, !!d.checked)} />
                ))}
              </div>
            </Field>
            {fTools.includes('function') && (
              <Field label="Function name (for the function tool)">
                <Input value={fFnName} onChange={(_, d) => setFFnName(d.value)} placeholder="my_function" />
              </Field>
            )}
            <Field label="Description (optional — orchestrators see this)">
              <Input value={fDescription} onChange={(_, d) => setFDescription(d.value)} placeholder="Answers finance questions grounded on the FY warehouse." />
            </Field>
            <div className={s.toolbar}>
              <Button appearance="primary" onClick={save} disabled={saving || !fName.trim() || !fModel.trim() || !fInstructions.trim()}>
                {saving ? 'Saving…' : selected ? 'Save changes' : 'Create agent'}
              </Button>
              {selected && <Button appearance="secondary" onClick={resetForm} disabled={saving}>New</Button>}
              {selected && <Button appearance="subtle" icon={<Delete16Regular />} onClick={() => del(selected)} disabled={saving}>Delete</Button>}
            </div>
            {saveMsg && <MessageBar intent={saveMsg.intent}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
          </div>
        </div>

        {/* ------- Right: playground ------- */}
        <div className={s.col}>
          <div className={s.form}>
            <div className={s.toolbar}>
              <Play16Regular />
              <Subtitle2>Playground</Subtitle2>
              <Badge appearance="tint" color="brand">threads · runs · steps</Badge>
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Pick an agent, ask a question. The run is traced step-by-step (tool calls / status) — the same inspector the Data Agent uses.
            </Caption1>
            <Field label="Agent">
              {agents.length > 0 ? (
                <Dropdown
                  value={pgAgent}
                  selectedOptions={pgAgent ? [pgAgent] : []}
                  placeholder="Select an agent to test"
                  onOptionSelect={(_, d) => d.optionValue && setPgAgent(d.optionValue)}
                >
                  {agents.map((a) => <Option key={a.name} value={a.name} text={a.name}>{a.name}</Option>)}
                </Dropdown>
              ) : (
                <Input value={pgAgent} onChange={(_, d) => setPgAgent(d.value)} placeholder="agent name" />
              )}
            </Field>
            <Field label="Question">
              <Textarea
                value={pgQuestion} rows={2}
                onChange={(_, d) => setPgQuestion(d.value)}
                placeholder="Ask the agent…"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runPlayground(); } }}
              />
            </Field>
            <div>
              <Button appearance="primary" icon={<Play16Regular />} onClick={runPlayground} disabled={pgRunning || !pgAgent.trim() || !pgQuestion.trim()}>
                {pgRunning ? 'Running…' : 'Run'}
              </Button>
            </div>

            {pgGate && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Foundry Agent Service not configured</MessageBarTitle>
                  {pgGate}
                </MessageBarBody>
              </MessageBar>
            )}
            {pgError && <MessageBar intent="error"><MessageBarBody>{pgError}</MessageBarBody></MessageBar>}

            {pgResult && (
              <div>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color={pgResult.status === 'completed' ? 'success' : pgResult.status === 'failed' ? 'danger' : 'warning'}>{pgResult.status}</Badge>
                  {pgResult.runId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>run {pgResult.runId}</Caption1>}
                </div>
                {pgResult.lastError && <MessageBar intent="error" style={{ marginTop: 6 }}><MessageBarBody>{pgResult.lastError}</MessageBarBody></MessageBar>}
                {pgResult.answer && (
                  <div style={{ marginTop: 8 }}>
                    <Subtitle2>Answer</Subtitle2>
                    <Body1 className={s.answer}>{pgResult.answer}</Body1>
                  </div>
                )}
                <Subtitle2 style={{ marginTop: 10 }}>Run steps ({pgResult.steps?.length || 0})</Subtitle2>
                {(pgResult.steps || []).length === 0 && <Caption1 className={s.empty}>No run steps returned.</Caption1>}
                {(pgResult.steps || []).map((st: any, i: number) => (
                  <div key={st.id || i} className={s.step}>
                    <div className={s.stepHead}>
                      <Badge appearance="outline">{st.type}</Badge>
                      <Badge appearance="filled" color={st.status === 'completed' ? 'success' : st.status === 'failed' ? 'danger' : 'informative'}>{st.status}</Badge>
                    </div>
                    {(st.toolCalls || []).map((tc: any, j: number) => (
                      <div key={j} className={s.mono} style={{ marginTop: 6 }}>
                        <div><strong>{tc.type}{tc.name ? ` · ${tc.name}` : ''}</strong></div>
                        {tc.input && <div style={{ color: tokens.colorNeutralForeground3 }}>{tc.input}</div>}
                        {tc.output && <div>{tc.output}</div>}
                      </div>
                    ))}
                    {st.error && <div style={{ color: tokens.colorPaletteRedForeground1, marginTop: 4 }}>{st.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
