'use client';

/**
 * Cross-item Copilot view — shared UI for both
 *   - /copilot                                (full-screen page)
 *   - /items/cross-item-copilot/<id>          (embedded editor)
 *
 * Layout: left rail (sessions) · main (chat + live step stream) ·
 * right rail (registered tools grouped by service).
 *
 * Streams from POST /api/copilot/orchestrate via SSE.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Body1, Caption1, Subtitle2, Title2, Badge, Spinner,
  Button, Textarea, Divider,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Accordion, AccordionHeader, AccordionItem, AccordionPanel,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import { CopilotResult } from '@/lib/components/copilot-result';
import { tagResult } from '@/lib/components/copilot-result-tagger';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  // Bounded-height grid (rows = minmax(0,1fr)) so the three columns scroll
  // INTERNALLY instead of growing the page. This breaks the scrollbar-race
  // flicker: previously `minHeight: calc(100vh - 220px)` on an unbounded
  // wrapper let the page height sit at the viewport threshold, so any content
  // change toggled the AppShell scrollbar (width change -> reflow -> toggle
  // again = constant twitch). Fixed-bound layout + min-height:0 children fixes it.
  shell: {
    display: 'grid',
    gridTemplateColumns: '260px 1fr 320px',
    gridTemplateRows: 'minmax(0, 1fr)',
    gap: 12,
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  rail: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    padding: 12,
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 0,
  },
  main: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
  },
  promptBar: {
    padding: 12,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  steps: {
    flex: 1,
    overflow: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 0,
  },
  step: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    padding: 10,
    fontSize: 12,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  stepHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  stepBody: { fontFamily: 'var(--loom-font-mono, ui-monospace, Menlo, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  sessionItem: {
    padding: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
  },
  sessionItemActive: {
    borderColor: tokens.colorBrandStroke1,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  toolPill: {
    padding: '4px 6px',
    borderRadius: 4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: 11,
    marginBottom: 4,
  },
  finalCard: {
    border: `1px solid ${tokens.colorPaletteGreenBorder2}`,
    backgroundColor: tokens.colorPaletteGreenBackground1,
    borderRadius: 4,
    padding: 12,
  },
  errorCard: {
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
    borderRadius: 4,
    padding: 12,
  },
});

type Step =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string };

interface Tool { name: string; description: string; service: string; parameters: any; }
interface SessionSummary { id: string; sessionId: string; prompt: string; createdAt: string; updatedAt: string; stepCount: number; }

/**
 * shouldAutoScroll — pure predicate for the step-stream autoscroll guard.
 *
 * Returns true only when the viewport is already within `threshold` px of the
 * bottom of the scroll container. This is the load-bearing half of the flicker
 * fix: instead of a smooth scrollIntoView on every streamed step (which stacked
 * animations and yanked the outer page scroll = constant flicker), we only nudge
 * the inner container to the bottom, instantly, when the user hasn't scrolled
 * up to read history. Exported so it can be unit-tested without a DOM.
 */
export function shouldAutoScroll(
  m: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 120,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

function StepCard({ step }: { step: Step }) {
  const s = useStyles();
  const intent =
    step.kind === 'final' ? 'success' :
    step.kind === 'error' ? 'error' :
    step.kind === 'tool_result' && (step as any).error ? 'error' :
    step.kind === 'tool_call' ? 'brand' : 'informative';
  const label =
    step.kind === 'thought' ? 'thought' :
    step.kind === 'tool_call' ? `${(step as any).name}` :
    step.kind === 'tool_result' ? `${(step as any).name} · ${(step as any).durationMs}ms` :
    step.kind === 'final' ? 'final' : 'error';

  if (step.kind === 'final') {
    return (
      <div className={s.finalCard}>
        <Subtitle2 block>Final answer</Subtitle2>
        <Body1 style={{ whiteSpace: 'pre-wrap' }}>{step.content || '(no content)'}</Body1>
      </div>
    );
  }
  if (step.kind === 'error') {
    return (
      <div className={s.errorCard}>
        <Subtitle2 block>Error</Subtitle2>
        <Caption1>{step.error}</Caption1>
      </div>
    );
  }
  // tool_result success → typed renderer (DataGrid / chart / Monaco / markdown /
  // change-set) instead of the old raw JSON.stringify dump. The error path keeps
  // its readable text below.
  if (step.kind === 'tool_result' && !step.error && step.result != null) {
    return (
      <div className={s.step}>
        <div className={s.stepHeader}>
          <Badge appearance="filled" color="success">tool_result</Badge>
          <Caption1><strong>{step.name}</strong> · {step.durationMs}ms</Caption1>
        </div>
        <CopilotResult result={tagResult(step.result, step.name)} toolName={step.name} />
      </div>
    );
  }
  let body = '';
  if (step.kind === 'thought') body = step.content;
  else if (step.kind === 'tool_call') body = JSON.stringify(step.args, null, 2);
  else if (step.kind === 'tool_result') body = step.error ? `ERROR: ${step.error}` : '';

  return (
    <div className={s.step}>
      <div className={s.stepHeader}>
        <Badge appearance="filled" color={intent as any}>{step.kind}</Badge>
        <Caption1><strong>{label}</strong></Caption1>
      </div>
      <div className={s.stepBody}>{body}</div>
    </div>
  );
}

/**
 * ToolRow — single registered tool in the right rail with a "Run"
 * button that opens a small JSON-args dialog and POSTs to
 * /api/copilot/tools/[name]/invoke. Lets the user execute a tool
 * directly without coaxing the LLM into picking it (or when AOAI
 * isn't deployed at all — the underlying tool handler still works
 * if its own backing service is reachable).
 */
/**
 * Guided argument form generated from a tool's JSON-Schema `parameters`
 * (no JSON typing — loom_no_freeform_config). Each property becomes the right
 * control: enum → Dropdown, boolean → Switch, number/integer → number Input,
 * string → Input. Nested object/array params fall back to a labeled value box
 * (rare — only a couple of tools take object params like pipeline parameters).
 */
function SchemaArgForm({ schema, value, onChange }: { schema: any; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const props: Record<string, any> = schema?.properties || {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>This tool takes no parameters — just run it.</Caption1>;
  }
  const set = (k: string, v: any) => onChange({ ...value, [k]: v });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {keys.map((k) => {
        const p = props[k] || {};
        const label = `${k}${required.includes(k) ? ' *' : ''}`;
        const hint = p.description as string | undefined;
        const enumVals: any[] | undefined = Array.isArray(p.enum) ? p.enum : undefined;
        if (enumVals) {
          const cur = value[k] != null ? String(value[k]) : '';
          return (
            <Field key={k} label={label} hint={hint}>
              <Dropdown placeholder={`Select ${k}`} selectedOptions={cur ? [cur] : []} value={cur}
                onOptionSelect={(_e, d) => set(k, d.optionValue)}>
                {enumVals.map((o) => <Option key={String(o)} value={String(o)}>{String(o)}</Option>)}
              </Dropdown>
            </Field>
          );
        }
        if (p.type === 'boolean') {
          return (
            <Field key={k} label={label} hint={hint}>
              <Switch checked={!!value[k]} onChange={(_e, d) => set(k, d.checked)} />
            </Field>
          );
        }
        if (p.type === 'number' || p.type === 'integer') {
          return (
            <Field key={k} label={label} hint={hint}>
              <Input type="number" value={value[k] != null ? String(value[k]) : ''}
                onChange={(_e, d) => set(k, d.value === '' ? undefined : Number(d.value))} />
            </Field>
          );
        }
        if (p.type === 'object' || p.type === 'array') {
          // Rare: a structured param (e.g. pipeline parameters). Offer a clearly
          // labeled key:value value box rather than raw "args JSON".
          return (
            <Field key={k} label={`${label} (one key=value per line)`} hint={hint}>
              <Textarea rows={3}
                value={typeof value[`__kv_${k}`] === 'string' ? value[`__kv_${k}`] : ''}
                onChange={(_e, d) => {
                  const obj: Record<string, string> = {};
                  for (const line of d.value.split('\n')) {
                    const i = line.indexOf('=');
                    if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                  }
                  onChange({ ...value, [`__kv_${k}`]: d.value, [k]: p.type === 'array' ? Object.values(obj) : obj });
                }} />
            </Field>
          );
        }
        return (
          <Field key={k} label={label} hint={hint}>
            <Input value={value[k] != null ? String(value[k]) : ''} onChange={(_e, d) => set(k, d.value)} />
          </Field>
        );
      })}
    </div>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const [argv, setArgv] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const invoke = useCallback(async () => {
    // Build the args object from the guided form, dropping UI-only helper keys
    // and empty values so the tool receives a clean payload.
    const parsed: Record<string, any> = {};
    for (const [k, v] of Object.entries(argv)) {
      if (k.startsWith('__kv_')) continue;
      if (v === undefined || v === '') continue;
      parsed[k] = v;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch(`/api/copilot/tools/${encodeURIComponent(tool.name)}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: parsed }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) setResult(j);
      else setError(j.remediation ? `${j.error}\n\nRemediation: ${j.remediation}` : (j.error || `HTTP ${r.status}`));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [tool.name, argv]);

  return (
    <>
      <div
        style={{
          display: 'flex', gap: 6, alignItems: 'flex-start',
          padding: '6px 8px', borderRadius: 4,
          backgroundColor: tokens.colorNeutralBackground2,
          marginBottom: 4,
        }}
        title={tool.description}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{tool.name}</div>
          <div style={{ color: tokens.colorNeutralForeground3, fontSize: 11, lineHeight: 1.35 }}>
            {tool.description}
          </div>
        </div>
        <Button size="small" appearance="subtle" onClick={() => setOpen(true)}>Run</Button>
      </div>
      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>{tool.name}</DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: 12 }}>{tool.description}</Caption1>
              <SchemaArgForm schema={tool.parameters} value={argv} onChange={setArgv} />
              <Button appearance="subtle" size="small" style={{ marginTop: 8 }} onClick={() => setArgv({})}>Reset inputs</Button>
              {error && (
                <MessageBar intent="error" style={{ marginTop: 12 }}>
                  <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{error}</MessageBarBody>
                </MessageBar>
              )}
              {result && (
                <MessageBar intent="success" style={{ marginTop: 12 }}>
                  <MessageBarBody>
                    <MessageBarTitle>OK — {result.durationMs}ms</MessageBarTitle>
                    <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', fontSize: 11, margin: 0 }}>
                      {JSON.stringify(result.result, null, 2)}
                    </pre>
                  </MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={invoke} disabled={busy}>
                {busy ? 'Running…' : 'Invoke'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

interface OrchestratorStatus {
  ok: boolean;
  ready?: boolean;
  /** Top-level config flags (task contract): is AOAI wired + active sovereign cloud. */
  configured?: boolean;
  cloud?: string;
  endpoint?: string;
  model?: string;
  aoai?: {
    ok: boolean;
    endpoint?: string;
    deployment?: string;
    model?: string;
    error?: string;
    remediation?: string;
    /** Cloud-correct AI Foundry portal (ai.azure.com vs ai.azure.us) for the honest gate. */
    portalDeepLink?: string;
  };
  tools?: { count: number; byService: Record<string, number> };
  sessions?: { recent: number };
}

export function CopilotConsoleView({ embedded = false }: { embedded?: boolean }) {
  const s = useStyles();
  const [prompt, setPrompt] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [aoaiUnavailable, setAoaiUnavailable] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [tools, setTools] = useState<Record<string, Tool[]>>({});
  const [toolCount, setToolCount] = useState(0);
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/copilot/status');
      const j = await r.json();
      setStatus(j);
    } catch {/* ignore */}
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Scroll container for the live step stream. We scroll THIS element
  // directly (not scrollIntoView on a sentinel) so the auto-scroll never
  // bubbles up to the outer AppShell <main> scroll region.
  const stepsRef = useRef<HTMLDivElement | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch('/api/copilot/sessions');
      const j = await r.json();
      if (j.ok) setSessions(j.sessions || []);
    } catch {}
  }, []);

  const loadTools = useCallback(async () => {
    try {
      const r = await fetch('/api/copilot/tools');
      const j = await r.json();
      if (j.ok) { setTools(j.grouped || {}); setToolCount(j.count || 0); }
    } catch {}
  }, []);

  const loadSessionDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/copilot/sessions/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok && j.session) {
        setActiveSessionId(id);
        setPrompt(j.session.prompt || '');
        setSteps((j.session.steps || []) as Step[]);
      }
    } catch {}
  }, []);

  useEffect(() => { loadSessions(); loadTools(); }, [loadSessions, loadTools]);

  // Auto-scroll the step stream to the bottom as new steps arrive.
  //
  // ROOT-CAUSE FIX (Copilot tab "constant flicker"): the previous version
  // called stepsEndRef.scrollIntoView({ behavior: 'smooth' }) keyed on
  // steps.length. During an orchestrate run the SSE stream appends a step
  // per event (thought / tool_call / tool_result …) in rapid succession, so
  // this queued a brand-new *smooth* scroll animation on every append — and
  // scrollIntoView walks every scrollable ancestor, so it also yanked the
  // outer AppShell <main> scroll region. Dozens of overlapping smooth-scroll
  // animations on two nested scroll containers read as a constant screen
  // flicker that made the surface unusable while the agent was working.
  //
  // Fix: scroll the inner container directly, instantly (no animation to
  // stack), and only when the user is already near the bottom — so a user
  // who scrolled up to read an earlier step isn't fought by the autoscroll.
  useEffect(() => {
    const el = stepsRef.current;
    if (!el) return;
    if (shouldAutoScroll(el)) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setPrompt('');
    setSteps([]);
    setTopError(null);
  }, []);

  // Wire the embedded editor's ribbon "New" / "Refresh" buttons. The
  // CrossItemCopilotEditor ribbon dispatches a `loom-copilot:session`
  // CustomEvent — previously nothing listened for it, so both buttons were
  // dead (no-vaporware violation). Listen here when embedded and act on it.
  useEffect(() => {
    if (!embedded || typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: 'new' | 'refresh' }>).detail?.kind;
      if (kind === 'new') newSession();
      else if (kind === 'refresh') loadSessions();
    };
    window.addEventListener('loom-copilot:session', handler);
    return () => window.removeEventListener('loom-copilot:session', handler);
  }, [embedded, newSession, loadSessions]);

  const runOrchestrate = useCallback(async () => {
    const p = prompt.trim();
    if (!p || running) return;
    setRunning(true);
    setSteps([]);
    setAoaiUnavailable(null);
    setTopError(null);

    try {
      const res = await fetch('/api/copilot/orchestrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: p, sessionId: activeSessionId || undefined }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({}));
        setAoaiUnavailable(j.error || 'No AOAI deployment on Foundry hub.');
        setRunning(false);
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        setTopError(j.error || `HTTP ${res.status}`);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentEvent = 'message';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (currentEvent === 'session') {
                if (parsed.sessionId) setActiveSessionId(parsed.sessionId);
              } else if (currentEvent === 'step') {
                setSteps((prev) => [...prev, parsed as Step]);
              }
            } catch {}
          }
        }
      }
    } catch (e: any) {
      setTopError(e?.message || String(e));
    } finally {
      setRunning(false);
      loadSessions();
    }
  }, [prompt, running, activeSessionId, loadSessions]);

  // AI Foundry portal deep-link. Prefer the server-resolved, cloud-correct link
  // from /api/copilot/status (ai.azure.com for Commercial/GCC, ai.azure.us for
  // GCC-High / IL5 / DoD); fall back to Commercial only if status hasn't loaded.
  const foundryPortalUrl = useMemo(
    () => status?.aoai?.portalDeepLink ?? 'https://ai.azure.com',
    [status?.aoai?.portalDeepLink],
  );

  const body = (
    <div className={s.shell}>
      {/* Left rail — sessions */}
      <aside className={s.rail}>
        <Subtitle2>Sessions</Subtitle2>
        <Button appearance="primary" onClick={newSession}>+ New session</Button>
        <Divider />
        {sessions.length === 0 && <Caption1>No sessions yet.</Caption1>}
        {sessions.map((sess) => (
          <div
            key={sess.id}
            className={`${s.sessionItem} ${activeSessionId === sess.sessionId ? s.sessionItemActive : ''}`}
            onClick={() => loadSessionDetail(sess.sessionId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') loadSessionDetail(sess.sessionId); }}
          >
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(sess.prompt || '(no prompt)').slice(0, 60)}
            </div>
            <Caption1>{sess.stepCount} steps · {new Date(sess.updatedAt).toLocaleString()}</Caption1>
          </div>
        ))}
      </aside>

      {/* Main */}
      <section className={s.main}>
        <div className={s.promptBar}>
          {/* Orchestrator status banner — shows AOAI + tool + session state
              on every load so users see immediately whether the orchestrator
              can actually run. Even when AOAI is missing, the per-tool
              "Run" buttons in the right rail still work for tools whose
              backing service is reachable. */}
          {status && !status.ready && (
            <MessageBar intent={status.aoai?.ok ? 'warning' : 'info'}>
              <MessageBarBody>
                <MessageBarTitle>Orchestrator status</MessageBarTitle>
                {status.aoai?.ok
                  ? `AOAI reachable (${status.aoai.deployment}) · ${status.tools?.count ?? 0} tools registered. Ready.`
                  : `AOAI not reachable — ${status.aoai?.error || 'unknown'}. ${status.tools?.count ?? 0} tools still callable directly via the right rail Run buttons.`}
                {status.aoai?.remediation && (
                  <div style={{ marginTop: 6, fontSize: 12 }}>{status.aoai.remediation}</div>
                )}
              </MessageBarBody>
              <MessageBarActions>
                {!status.aoai?.ok && (
                  <Button
                    as="a"
                    href={foundryPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    appearance="primary"
                  >
                    Configure in AI Studio
                  </Button>
                )}
                <Button appearance="subtle" onClick={loadStatus}>Recheck</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {status?.ready && (
            <Badge appearance="filled" color="success" style={{ alignSelf: 'flex-start' }}>
              Ready · {status.tools?.count} tools · AOAI {status.aoai?.deployment}
            </Badge>
          )}
          {aoaiUnavailable && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No AOAI deployment</MessageBarTitle>
                {aoaiUnavailable}
              </MessageBarBody>
              <MessageBarActions>
                <Button as="a" href={foundryPortalUrl} target="_blank" rel="noopener noreferrer">
                  Go to AI Foundry
                </Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {topError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Orchestrator error</MessageBarTitle>{topError}</MessageBarBody>
            </MessageBar>
          )}
          <Textarea
            placeholder='e.g. "Find the top 10 revenue customers from gold.fact_sales last quarter, write the result to gold/snapshots/customer_top10.parquet, and refresh the Sales semantic model."'
            value={prompt}
            onChange={(_e, d) => setPrompt(d.value)}
            rows={3}
            disabled={running}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button appearance="primary" disabled={running || !prompt.trim()} onClick={runOrchestrate}>
              {running ? 'Working…' : 'Ask CSA Loom Copilot'}
            </Button>
            {running && <Spinner size="tiny" />}
            <div style={{ flex: 1 }} />
            <Caption1>{toolCount} tools registered</Caption1>
          </div>
        </div>
        <div className={s.steps} ref={stepsRef}>
          {steps.length === 0 && !running && (
            <Caption1>Ask anything across Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, and Foundry. The orchestrator will pick the right tools.</Caption1>
          )}
          {steps.map((step, i) => <StepCard key={i} step={step} />)}
        </div>
      </section>

      {/* Right rail — tools */}
      <aside className={s.rail}>
        <Subtitle2>Tools ({toolCount})</Subtitle2>
        <Accordion multiple collapsible>
          {Object.keys(tools).sort().map((svc) => (
            <AccordionItem key={svc} value={svc}>
              <AccordionHeader>{svc} ({tools[svc].length})</AccordionHeader>
              <AccordionPanel>
                {tools[svc].map((t) => (
                  <ToolRow key={t.name} tool={t} />
                ))}
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      </aside>
    </div>
  );

  if (embedded) return body;
  // Bounded-height column so {body} (flex:1, min-height:0) fills the remaining
  // space and its panels scroll internally — the page itself never grows past
  // the viewport, so the AppShell scrollbar never toggles (no flicker).
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 52px)', minHeight: 0, overflow: 'hidden', boxSizing: 'border-box' }}>
      <Title2>Loom Copilot</Title2>
      <Caption1>Ask CSA Loom Copilot anything — it plans + runs the right tools across every wired CSA Loom service from one natural-language prompt.</Caption1>
      {body}
    </div>
  );
}

// -------- Editor variant (for /items/cross-item-copilot/<id>) --------
// v3.27: wire the previously-dead 'View registry' ribbon button. The
// tools list is always visible in the right rail of CopilotConsoleView,
// so the button now opens the raw /api/copilot/tools JSON in a new tab
// for debugging/inspection. The session ribbon buttons dispatch window
// events the embedded console listens for.

function dispatchSessionEvent(kind: 'new' | 'refresh') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('loom-copilot:session', { detail: { kind } }));
}

function viewToolRegistry() {
  if (typeof window === 'undefined') return;
  window.open('/api/copilot/tools', '_blank', 'noopener,noreferrer');
}

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Session', actions: [
      { label: 'New', onClick: () => dispatchSessionEvent('new') },
      { label: 'Refresh', onClick: () => dispatchSessionEvent('refresh') },
    ] },
    { label: 'Tools', actions: [
      { label: 'View registry', onClick: viewToolRegistry },
    ] },
  ]},
];

export function CrossItemCopilotEditor({ item, id }: { item: FabricItemType; id: string }) {
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      main={<CopilotConsoleView embedded />}
    />
  );
}
