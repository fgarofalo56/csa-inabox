'use client';

import { clientFetch } from '@/lib/client-fetch';
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
import { buildToolDefinition, BROWSER_TOOL_ENV } from '@/lib/azure/agent-tool-kinds';
import {
  Subtitle2, Body1, Caption1, Badge, Spinner, Button, Input, Textarea, Field,
  Dropdown, Option, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Bot24Regular, Play16Regular,
  History16Regular, ArrowClockwise16Regular, DataHistogram16Regular, Beaker16Regular,
} from '@fluentui/react-icons';
import { mcpToolOptions } from '@/lib/copilot/agent-tool-catalog';
import { runMetrics, type AgentRollup } from '@/lib/foundry/agentops';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', minHeight: '0', flex: '1' },
  // minmax(0,…) tracks — px floors (320+360=680) overflowed at narrow width.
  cols: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px', alignItems: 'start' },
  col: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '0' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '260px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '4px' },
  threadList: { maxHeight: '160px' },
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
  // AgentOps (AIF-13)
  metricGrid: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' },
  metric: { display: 'flex', flexDirection: 'column', minWidth: '84px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', padding: '6px 10px' },
  metricVal: { fontSize: '16px', fontWeight: 600 },
  metricKey: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  opsSection: { display: 'flex', flexDirection: 'column', gap: '8px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px', padding: '12px', marginTop: '4px' },
  evalRow: { display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '6px', alignItems: 'center' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
});

// Shared typed tool catalog (AIF-5). The Foundry project builder exposes the
// same kinds as the Loom item agents; `mcp` / `openapi` bind to a typed config
// below rather than a freeform box.
const TOOL_TYPES = [
  { value: 'code_interpreter', label: 'Code interpreter' },
  { value: 'file_search', label: 'File search' },
  { value: 'function', label: 'Function calling' },
  { value: 'mcp', label: 'MCP server' },
  { value: 'openapi', label: 'OpenAPI' },
  { value: 'connected_agent', label: 'Connected agent' },
  // Browser automation (AIF-18) — honest-gated on a deployed Playwright runner.
  { value: 'browser_automation', label: 'Browser automation' },
] as const;
type ToolType = (typeof TOOL_TYPES)[number]['value'];

interface AgentRow {
  name: string;
  description?: string;
  definition?: Record<string, unknown>;
  metadata?: Record<string, string>;
}

interface DeploymentRow { name: string; modelName?: string }

/** A persisted run thread summary (AIF-14 durable memory). */
interface ThreadSummary {
  threadId: string;
  runId?: string;
  status: string;
  tier?: string;
  question: string;
  answerPreview: string;
  createdAt: string;
}

/** A stored eval run (AIF-13). */
interface AgentEvalResultRow { prompt: string; criteria?: string; answer: string; score: number; rationale?: string; status: string }
interface AgentEvalRun {
  id: string; name: string; model?: string; createdAt: string;
  avgScore: number; passRate: number; passThreshold: number;
  results: AgentEvalResultRow[];
}

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
    let ty = typeof t?.type === 'string' ? t.type : '';
    // browser_automation serializes as a named function tool (agent-tool-kinds).
    if (ty === 'function' && t?.function?.name === 'browser_automation') ty = 'browser_automation';
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

  // browser-automation runner gate (AIF-18): null = unknown, true = a Playwright
  // runner is deployed, false = honest-gate the browser_automation tool.
  const [browserConfigured, setBrowserConfigured] = useState<boolean | null>(null);

  // ---- editor form ----
  const [selected, setSelected] = useState<string | null>(null);
  const [fName, setFName] = useState('');
  const [fModel, setFModel] = useState('');
  const [fInstructions, setFInstructions] = useState('');
  const [fTools, setFTools] = useState<ToolType[]>([]);
  const [fDescription, setFDescription] = useState('');
  const [fFnName, setFFnName] = useState('');
  // Typed config for the mcp / openapi tool kinds (AIF-5).
  const [fMcpServerId, setFMcpServerId] = useState('');
  const [fOpenapiUrl, setFOpenapiUrl] = useState('');
  // Connected sub-agent (AIF-4) — the agent this agent delegates to.
  const [fConnectedAgent, setFConnectedAgent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // ---- playground ----
  const [pgAgent, setPgAgent] = useState('');
  const [pgQuestion, setPgQuestion] = useState('');
  const [pgRunning, setPgRunning] = useState(false);
  const [pgResult, setPgResult] = useState<any>(null);
  const [pgTier, setPgTier] = useState<string | null>(null);
  const [pgGate, setPgGate] = useState<string | null>(null);
  const [pgError, setPgError] = useState<string | null>(null);

  // ---- durable threads (AIF-14) ----
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadReloadNonce, setThreadReloadNonce] = useState(0);

  // ---- AgentOps (AIF-13): per-run model, rollup, eval ----
  const [pgRunModel, setPgRunModel] = useState('');
  const [rollup, setRollup] = useState<AgentRollup | null>(null);
  const [rollupLoading, setRollupLoading] = useState(false);
  const [evalRows, setEvalRows] = useState<{ prompt: string; criteria: string }[]>([{ prompt: '', criteria: '' }]);
  const [evalName, setEvalName] = useState('');
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalMsg, setEvalMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [evalRuns, setEvalRuns] = useState<AgentEvalRun[]>([]);

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
      const res = await clientFetch('/api/foundry/agents');
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

  const loadBrowserStatus = useCallback(async () => {
    try {
      const res = await clientFetch('/api/foundry/browser-tool/status');
      const j = await readJson(res);
      setBrowserConfigured(j?.ok ? !!j.configured : false);
    } catch { setBrowserConfigured(false); }
  }, []);

  useEffect(() => {
    if (!active) return;
    loadAgents();
    loadDeployments();
    loadBrowserStatus();
  }, [active, nonce, accountKey, loadAgents, loadDeployments, loadBrowserStatus]);

  const mcpOpts = useMemo(() => mcpToolOptions(), []);

  const resetForm = useCallback(() => {
    setSelected(null); setFName(''); setFModel(''); setFInstructions('');
    setFTools([]); setFDescription(''); setFFnName(''); setFMcpServerId(''); setFOpenapiUrl(''); setFConnectedAgent('');
    setSaveMsg(null);
  }, []);

  const openAgent = useCallback((a: AgentRow) => {
    setSelected(a.name);
    setFName(a.name);
    setFModel(agentModel(a));
    setFInstructions(agentInstructions(a));
    setFTools(agentToolTypes(a));
    setFDescription(a.description || '');
    setFFnName('');
    // Best-effort round-trip of the mcp / openapi bindings from the definition.
    const def = (a.definition || {}) as any;
    const toolsArr = Array.isArray(def?.tools) ? def.tools : [];
    const mcp = toolsArr.find((x: any) => x?.type === 'mcp');
    setFMcpServerId(mcp ? (mcpOpts.find((o) => o.endpoint && o.endpoint === mcp.server_url)?.id || '') : '');
    const oapi = toolsArr.find((x: any) => x?.type === 'openapi');
    setFOpenapiUrl(oapi?.openapi?.spec_url ? String(oapi.openapi.spec_url) : '');
    const conn = toolsArr.find((x: any) => x?.type === 'connected_agent');
    setFConnectedAgent(conn?.connected_agent?.id ? String(conn.connected_agent.id) : '');
    setSaveMsg(null);
    setPgAgent(a.name);
  }, [mcpOpts]);

  const toggleTool = useCallback((t: ToolType, checked: boolean) => {
    setFTools((prev) => (checked ? Array.from(new Set([...prev, t])) : prev.filter((x) => x !== t)));
  }, []);

  /** Build the FoundryAgentBody.tools array from the checked types + typed config. */
  const buildTools = useCallback((): Array<Record<string, unknown>> => {
    return fTools.map((t) => {
      if (t === 'function') {
        const name = fFnName.trim() || 'my_function';
        return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } };
      }
      if (t === 'mcp') {
        const opt = mcpOpts.find((o) => o.id === fMcpServerId);
        return { type: 'mcp', server_label: opt?.label || fMcpServerId || 'mcp', server_url: opt?.endpoint || undefined };
      }
      if (t === 'openapi') {
        return { type: 'openapi', openapi: { name: 'openapi_tool', spec_url: fOpenapiUrl.trim() || undefined, auth: { type: 'anonymous' } } };
      }
      if (t === 'connected_agent') {
        const target = fConnectedAgent.trim();
        return { type: 'connected_agent', connected_agent: { id: target || undefined, name: target || 'sub_agent', description: `Delegate to ${target || 'the connected agent'}` } };
      }
      if (t === 'browser_automation') {
        // Shared tool-kind contract (agent-tool-kinds.ts) — Foundry + MAF + the
        // AIF-5 catalog serialize browser automation identically.
        return buildToolDefinition(t, { functionName: fFnName });
      }
      return { type: t };
    });
  }, [fTools, fFnName, fMcpServerId, fOpenapiUrl, fConnectedAgent, mcpOpts]);

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
      const res = await clientFetch('/api/foundry/agents', {
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
      const res = await clientFetch(`/api/foundry/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
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
    setPgRunning(true); setPgResult(null); setPgTier(null); setPgGate(null); setPgError(null);
    try {
      // Pass the selected agent's definition (instructions + model) so the MAF
      // Gov runtime tier can serve the run when no Foundry Agent Service host is
      // reachable (GCC-High / IL5) — it has no Foundry project to load it from.
      // The Foundry tier loads the agent by name and ignores these.
      const def = agents.find((a) => a.name === agent);
      const runModel = def ? agentModel(def) : (selected === agent ? fModel : '');
      setPgRunModel(runModel);
      const res = await clientFetch('/api/foundry/agents/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent, question: q,
          instructions: def ? agentInstructions(def) : (selected === agent ? fInstructions : undefined),
          model: runModel || undefined,
        }),
      });
      const j = await readJson(res);
      if (res.status === 501 || j?.code === 'not_configured') {
        setPgGate(j?.hint || j?.error || 'Foundry Agent Service not configured.');
        return;
      }
      if (!j.ok) { setPgError(j.error || `HTTP ${res.status}`); return; }
      setPgResult(j.data);
      setPgTier(typeof j.tier === 'string' ? j.tier : null);
      // Refresh the persisted-threads list (the run was just saved server-side).
      setThreadReloadNonce((n) => n + 1);
    } catch (e: any) {
      setPgError(e?.message || String(e));
    } finally {
      setPgRunning(false);
    }
  }, [pgAgent, pgQuestion, pgRunning, agents, selected, fInstructions, fModel]);

  // ---- durable threads (AIF-14): list + resume + delete ----
  const loadThreads = useCallback(async (agentName: string) => {
    const a = agentName.trim();
    if (!a) { setThreads([]); return; }
    setThreadsLoading(true);
    try {
      const res = await clientFetch(`/api/foundry/agents/threads?agent=${encodeURIComponent(a)}`);
      const j = await readJson(res);
      setThreads(j?.ok && Array.isArray(j.threads) ? j.threads : []);
    } catch { setThreads([]); }
    finally { setThreadsLoading(false); }
  }, []);

  useEffect(() => { if (active && pgAgent.trim()) loadThreads(pgAgent); else setThreads([]); }, [active, pgAgent, threadReloadNonce, loadThreads]);

  const resumeThread = useCallback(async (threadId: string) => {
    const a = pgAgent.trim();
    if (!a || !threadId) return;
    setPgError(null); setPgGate(null);
    try {
      const res = await clientFetch(`/api/foundry/agents/threads?agent=${encodeURIComponent(a)}&threadId=${encodeURIComponent(threadId)}`);
      const j = await readJson(res);
      if (!j?.ok || !j.thread) { setPgError(j?.error || 'Could not load thread'); return; }
      const t = j.thread;
      setPgQuestion(t.question || '');
      setPgResult({ threadId: t.threadId, runId: t.runId, status: t.status, answer: t.answer, steps: t.steps || [], usage: t.usage, model: t.model });
      setPgRunModel(t.model || '');
      setPgTier(typeof t.tier === 'string' ? t.tier : null);
    } catch (e: any) { setPgError(e?.message || String(e)); }
  }, [pgAgent]);

  const deleteThread = useCallback(async (threadId: string) => {
    const a = pgAgent.trim();
    if (!a || !threadId) return;
    try {
      await clientFetch(`/api/foundry/agents/threads?agent=${encodeURIComponent(a)}&threadId=${encodeURIComponent(threadId)}`, { method: 'DELETE' });
      await loadThreads(a);
    } catch { /* best-effort */ }
  }, [pgAgent, loadThreads]);

  // ---- AgentOps rollup (AIF-13): aggregate cost/latency/success over runs ----
  const loadRollup = useCallback(async (agentName: string) => {
    const a = agentName.trim();
    if (!a) { setRollup(null); return; }
    setRollupLoading(true);
    try {
      const res = await clientFetch(`/api/foundry/agents/rollup?agent=${encodeURIComponent(a)}`);
      const j = await readJson(res);
      setRollup(j?.ok && j.rollup ? j.rollup : null);
    } catch { setRollup(null); }
    finally { setRollupLoading(false); }
  }, []);

  // ---- AgentOps eval (AIF-13): run a prompt-set + judge; list past runs ----
  const loadEvalRuns = useCallback(async (agentName: string) => {
    const a = agentName.trim();
    if (!a) { setEvalRuns([]); return; }
    try {
      const res = await clientFetch(`/api/foundry/agents/eval?agent=${encodeURIComponent(a)}`);
      const j = await readJson(res);
      setEvalRuns(j?.ok && Array.isArray(j.runs) ? j.runs : []);
    } catch { setEvalRuns([]); }
  }, []);

  // Refresh rollup + eval history whenever the playground agent changes or a run
  // is persisted (threadReloadNonce bumps after each playground run).
  useEffect(() => {
    if (active && pgAgent.trim()) { loadRollup(pgAgent); loadEvalRuns(pgAgent); }
    else { setRollup(null); setEvalRuns([]); }
  }, [active, pgAgent, threadReloadNonce, loadRollup, loadEvalRuns]);

  const runEval = useCallback(async () => {
    const a = pgAgent.trim();
    if (!a || evalRunning) return;
    const prompts = evalRows.map((r) => ({ prompt: r.prompt.trim(), criteria: r.criteria.trim() || undefined })).filter((r) => r.prompt);
    if (!prompts.length) { setEvalMsg({ intent: 'error', text: 'Add at least one prompt to the eval set.' }); return; }
    setEvalRunning(true); setEvalMsg(null);
    try {
      const def = agents.find((x) => x.name === a);
      const res = await clientFetch('/api/foundry/agents/eval', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: a, name: evalName.trim() || undefined, prompts,
          instructions: def ? agentInstructions(def) : (selected === a ? fInstructions : undefined),
          model: def ? agentModel(def) : (selected === a ? fModel : undefined),
        }),
      });
      const j = await readJson(res);
      if (res.status === 501 || j?.code === 'not_configured') {
        setEvalMsg({ intent: 'warning', text: j?.hint || j?.error || 'Foundry Agent Service not configured — eval needs a runtime tier.' });
        return;
      }
      if (!j.ok) { setEvalMsg({ intent: 'error', text: j.error || `HTTP ${res.status}` }); return; }
      const avg = j.eval?.avgScore ?? j.summary?.avgScore;
      setEvalMsg({ intent: 'success', text: `Eval "${j.eval?.name}" scored ${avg}/5 avg · ${Math.round((j.eval?.passRate ?? 0) * 100)}% pass.` });
      loadEvalRuns(a);
    } catch (e: any) { setEvalMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setEvalRunning(false); }
  }, [pgAgent, evalRunning, evalRows, evalName, agents, selected, fInstructions, fModel, loadEvalRuns]);

  const runMetricsForResult = useMemo(() => {
    if (!pgResult) return null;
    return runMetrics({ model: pgResult.model || pgRunModel, usage: pgResult.usage, steps: pgResult.steps });
  }, [pgResult, pgRunModel]);

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
                  {agentModel(a) && <Caption1 style={{ marginLeft: tokens.spacingHorizontalSNudge, color: tokens.colorNeutralForeground3 }}>{agentModel(a)}</Caption1>}
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
            {fTools.includes('browser_automation') && browserConfigured === false && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Browser-automation runner not deployed</MessageBarTitle>
                  The browser automation tool needs a Loom-owned Playwright runner. Deploy{' '}
                  <code>platform/fiab/bicep/modules/copilot/browser-tool.bicep</code> (a scale-to-zero
                  Azure Container Apps Job) and set <code>{BROWSER_TOOL_ENV}</code> to the job resource id.
                  You can still add the tool to the agent now — it will run once the runner is wired.
                </MessageBarBody>
              </MessageBar>
            )}
            {fTools.includes('function') && (
              <Field label="Function name (for the function tool)">
                <Input value={fFnName} onChange={(_, d) => setFFnName(d.value)} placeholder="my_function" />
              </Field>
            )}
            {fTools.includes('mcp') && (
              <Field label="MCP server (for the MCP tool)">
                <Dropdown
                  value={mcpOpts.find((o) => o.id === fMcpServerId)?.label || ''}
                  selectedOptions={fMcpServerId ? [fMcpServerId] : []}
                  placeholder="Select an MCP server"
                  onOptionSelect={(_, d) => d.optionValue && setFMcpServerId(d.optionValue)}
                >
                  {mcpOpts.map((o) => <Option key={o.id} value={o.id} text={o.label}>{o.label}{o.optIn ? ' (opt-in)' : ''}</Option>)}
                </Dropdown>
              </Field>
            )}
            {fTools.includes('openapi') && (
              <Field label="OpenAPI spec URL (for the OpenAPI tool)">
                <Input value={fOpenapiUrl} onChange={(_, d) => setFOpenapiUrl(d.value)} placeholder="https://api.example.com/openapi.json" />
              </Field>
            )}
            {fTools.includes('connected_agent') && (
              <Field label="Sub-agent (for the connected-agent tool)" hint="Pick another agent in this project to delegate to.">
                {agents.filter((a) => a.name !== fName).length > 0 ? (
                  <Dropdown
                    value={fConnectedAgent}
                    selectedOptions={fConnectedAgent ? [fConnectedAgent] : []}
                    placeholder="Select an agent to connect"
                    onOptionSelect={(_, d) => d.optionValue && setFConnectedAgent(d.optionValue)}
                  >
                    {agents.filter((a) => a.name !== fName).map((a) => <Option key={a.name} value={a.name} text={a.name}>{a.name}</Option>)}
                  </Dropdown>
                ) : (
                  <Input value={fConnectedAgent} onChange={(_, d) => setFConnectedAgent(d.value)} placeholder="sub-agent name" />
                )}
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

            {/* Durable threads (AIF-14) — resume a past conversation. The agent
                also recalls durable facts learned in earlier threads. */}
            {pgAgent.trim() && (
              <div>
                <div className={s.toolbar}>
                  <History16Regular />
                  <Caption1>Threads{threadsLoading ? ' · loading…' : ` (${threads.length})`}</Caption1>
                  <Badge appearance="tint" color="brand" title="This agent remembers durable facts across threads">durable memory</Badge>
                  <div style={{ flex: 1 }} />
                  <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => loadThreads(pgAgent)} disabled={threadsLoading} aria-label="Refresh threads" />
                </div>
                <div className={`${s.list} ${s.threadList}`}>
                  {!threadsLoading && threads.length === 0 && <div className={s.empty}>No saved threads yet. Run a question to start one.</div>}
                  {threads.map((t) => (
                    <div key={t.threadId} className={s.agentRow} role="button" tabIndex={0}
                      onClick={() => resumeThread(t.threadId)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resumeThread(t.threadId); } }}>
                      <History16Regular />
                      <span className={s.grow}>
                        <strong>{t.question || '(no prompt)'}</strong>
                        <br />
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          {new Date(t.createdAt).toLocaleString()} · {t.status}{t.tier === 'maf' ? ' · MAF' : ''}
                        </Caption1>
                      </span>
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Delete thread ${t.threadId}`}
                        onClick={(e) => { e.stopPropagation(); deleteThread(t.threadId); }} />
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                  {pgTier && (
                    <Badge
                      appearance="tint"
                      color={pgTier === 'maf' ? 'important' : 'brand'}
                      title={pgTier === 'maf'
                        ? 'Served by the Microsoft Agent Framework OSS runtime tier (Gov AOAI direct) — the GCC-High / IL5 backstop'
                        : 'Served by the Azure AI Foundry Agent Service tier'}
                    >
                      {pgTier === 'maf' ? 'runtime · MAF (Gov)' : 'runtime · Foundry'}
                    </Badge>
                  )}
                  {pgResult.runId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>run {pgResult.runId}</Caption1>}
                </div>
                {/* Per-run trace metrics (AIF-13): real token counts; cost is an estimate. */}
                {runMetricsForResult && (
                  <div className={s.metricGrid}>
                    <div className={s.metric}><span className={s.metricVal}>{runMetricsForResult.usage.totalTokens.toLocaleString()}</span><span className={s.metricKey}>tokens ({runMetricsForResult.usage.promptTokens.toLocaleString()} in / {runMetricsForResult.usage.completionTokens.toLocaleString()} out)</span></div>
                    <div className={s.metric}><span className={s.metricVal}>${runMetricsForResult.costUsd.toFixed(4)}</span><span className={s.metricKey}>est. cost{runMetricsForResult.model ? ` · ${runMetricsForResult.model}` : ''}</span></div>
                    <div className={s.metric}><span className={s.metricVal}>{(runMetricsForResult.latencyMs / 1000).toFixed(2)}s</span><span className={s.metricKey}>latency</span></div>
                    <div className={s.metric}><span className={s.metricVal}>{runMetricsForResult.stepCount}</span><span className={s.metricKey}>steps</span></div>
                  </div>
                )}
                {pgResult.lastError && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalSNudge }}><MessageBarBody>{pgResult.lastError}</MessageBarBody></MessageBar>}
                {pgResult.answer && (
                  <div style={{ marginTop: tokens.spacingVerticalS }}>
                    <Subtitle2>Answer</Subtitle2>
                    <Body1 className={s.answer}>{pgResult.answer}</Body1>
                  </div>
                )}
                <Subtitle2 style={{ marginTop: tokens.spacingVerticalMNudge }}>Run steps ({pgResult.steps?.length || 0})</Subtitle2>
                {(pgResult.steps || []).length === 0 && <Caption1 className={s.empty}>No run steps returned.</Caption1>}
                {(pgResult.steps || []).map((st: any, i: number) => (
                  <div key={st.id || i} className={s.step}>
                    <div className={s.stepHead}>
                      <Badge appearance="outline">{st.type}</Badge>
                      <Badge appearance="filled" color={st.status === 'completed' ? 'success' : st.status === 'failed' ? 'danger' : 'informative'}>{st.status}</Badge>
                      {st.createdAt && st.completedAt && st.completedAt >= st.createdAt && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{(st.completedAt - st.createdAt).toFixed(0)}s</Caption1>
                      )}
                    </div>
                    {(st.toolCalls || []).map((tc: any, j: number) => (
                      <div key={j} className={s.mono} style={{ marginTop: tokens.spacingVerticalSNudge }}>
                        <div><strong>{tc.type}{tc.name ? ` · ${tc.name}` : ''}</strong></div>
                        {tc.input && <div style={{ color: tokens.colorNeutralForeground3 }}>{tc.input}</div>}
                        {tc.output && <div>{tc.output}</div>}
                      </div>
                    ))}
                    {st.error && <div style={{ color: tokens.colorPaletteRedForeground1, marginTop: tokens.spacingVerticalXS }}>{st.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ------- AgentOps (AIF-13): rollup + eval ------- */}
      {pgAgent.trim() && (
        <div className={s.opsSection}>
          <div className={s.toolbar}>
            <DataHistogram16Regular />
            <Subtitle2>AgentOps · {pgAgent}</Subtitle2>
            <Badge appearance="tint" color="brand">cost · latency · evals</Badge>
            <div style={{ flex: 1 }} />
            <Button size="small" appearance="subtle" icon={<ArrowClockwise16Regular />} onClick={() => { loadRollup(pgAgent); loadEvalRuns(pgAgent); }} disabled={rollupLoading}>Refresh</Button>
          </div>

          {/* Rollup — aggregate over persisted runs */}
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Aggregated over your persisted runs for this agent. Token counts are real (live usage); $ cost is an estimate (Azure OpenAI list price).
          </Caption1>
          {rollupLoading ? <Spinner size="tiny" /> : !rollup || rollup.runs === 0 ? (
            <div className={s.empty}>No runs recorded yet. Run this agent in the playground to populate the rollup.</div>
          ) : (
            <>
              <div className={s.metricGrid}>
                <div className={s.metric}><span className={s.metricVal}>{rollup.runs}</span><span className={s.metricKey}>runs</span></div>
                <div className={s.metric}><span className={s.metricVal}>{Math.round(rollup.successRate * 100)}%</span><span className={s.metricKey}>success ({rollup.completed}/{rollup.runs})</span></div>
                <div className={s.metric}><span className={s.metricVal}>${rollup.totalCostUsd.toFixed(4)}</span><span className={s.metricKey}>total est. cost</span></div>
                <div className={s.metric}><span className={s.metricVal}>${rollup.avgCostUsd.toFixed(4)}</span><span className={s.metricKey}>avg / run</span></div>
                <div className={s.metric}><span className={s.metricVal}>{rollup.totalTokens.toLocaleString()}</span><span className={s.metricKey}>total tokens</span></div>
                <div className={s.metric}><span className={s.metricVal}>{(rollup.avgLatencyMs / 1000).toFixed(2)}s</span><span className={s.metricKey}>avg latency</span></div>
                <div className={s.metric}><span className={s.metricVal}>{(rollup.p95LatencyMs / 1000).toFixed(2)}s</span><span className={s.metricKey}>p95 latency</span></div>
              </div>
              {rollup.byModel.length > 0 && (
                <table className={s.table}>
                  <thead><tr><th style={{ textAlign: 'left' }}>Model</th><th style={{ textAlign: 'right' }}>Runs</th><th style={{ textAlign: 'right' }}>Tokens</th><th style={{ textAlign: 'right' }}>Est. cost</th></tr></thead>
                  <tbody>
                    {rollup.byModel.map((m) => (
                      <tr key={m.model}>
                        <td>{m.model}</td>
                        <td style={{ textAlign: 'right' }}>{m.runs}</td>
                        <td style={{ textAlign: 'right' }}>{m.totalTokens.toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>${m.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {/* Eval — run a prompt-set, judge each answer 1-5 */}
          <div className={s.toolbar} style={{ marginTop: tokens.spacingVerticalS }}>
            <Beaker16Regular />
            <Subtitle2>Evaluation</Subtitle2>
            <Badge appearance="tint" color="brand">real agent runs · AOAI judge</Badge>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Run a prompt-set through this agent; an AOAI judge scores each answer 1-5 against your criteria. Results are stored per agent.
          </Caption1>
          <Field label="Eval name (optional)">
            <Input value={evalName} onChange={(_, d) => setEvalName(d.value)} placeholder="Smoke suite" />
          </Field>
          {evalRows.map((row, i) => (
            <div key={i} className={s.evalRow}>
              <Input value={row.prompt} placeholder="Prompt to send the agent"
                onChange={(_, d) => setEvalRows((prev) => prev.map((r, j) => j === i ? { ...r, prompt: d.value } : r))} />
              <Input value={row.criteria} placeholder="Grading criteria (optional)"
                onChange={(_, d) => setEvalRows((prev) => prev.map((r, j) => j === i ? { ...r, criteria: d.value } : r))} />
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={`Remove eval prompt ${i + 1}`}
                onClick={() => setEvalRows((prev) => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev)} />
            </div>
          ))}
          <div className={s.toolbar}>
            <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => setEvalRows((prev) => prev.length < 8 ? [...prev, { prompt: '', criteria: '' }] : prev)} disabled={evalRows.length >= 8}>Add prompt</Button>
            <Button size="small" appearance="primary" icon={<Play16Regular />} onClick={runEval} disabled={evalRunning || !pgAgent.trim()}>{evalRunning ? 'Running eval…' : 'Run eval'}</Button>
          </div>
          {evalMsg && <MessageBar intent={evalMsg.intent}><MessageBarBody>{evalMsg.text}</MessageBarBody></MessageBar>}

          {evalRuns.length > 0 && (
            <div>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Past eval runs ({evalRuns.length})</Caption1>
              {evalRuns.map((er) => (
                <div key={er.id} className={s.step}>
                  <div className={s.stepHead}>
                    <strong>{er.name}</strong>
                    <Badge appearance="filled" color={er.avgScore >= er.passThreshold ? 'success' : er.avgScore >= 3 ? 'warning' : 'danger'}>{er.avgScore.toFixed(2)}/5</Badge>
                    <Badge appearance="outline">{Math.round(er.passRate * 100)}% pass</Badge>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{new Date(er.createdAt).toLocaleString()} · {er.results.length} prompts</Caption1>
                  </div>
                  <table className={s.table} style={{ marginTop: '6px' }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>Prompt</th><th style={{ textAlign: 'right' }}>Score</th><th style={{ textAlign: 'left' }}>Rationale</th></tr></thead>
                    <tbody>
                      {er.results.map((rr, k) => (
                        <tr key={k}>
                          <td>{rr.prompt}</td>
                          <td style={{ textAlign: 'right' }}>{rr.score || '—'}</td>
                          <td style={{ color: tokens.colorNeutralForeground3 }}>{rr.rationale || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
