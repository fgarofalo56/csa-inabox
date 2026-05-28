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
  Field,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  shell: {
    display: 'grid',
    gridTemplateColumns: '260px 1fr 320px',
    gap: 12,
    minHeight: 'calc(100vh - 220px)',
    flex: 1,
    minWidth: 0,
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
  },
  main: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
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
  let body = '';
  if (step.kind === 'thought') body = step.content;
  else if (step.kind === 'tool_call') body = JSON.stringify(step.args, null, 2);
  else if (step.kind === 'tool_result') body = step.error ? `ERROR: ${step.error}` : JSON.stringify(step.result, null, 2);

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
function ToolRow({ tool }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const invoke = useCallback(async () => {
    let parsed: any = {};
    try {
      parsed = args.trim() ? JSON.parse(args) : {};
    } catch (e: any) {
      setError(`Invalid JSON args: ${e?.message || e}`);
      return;
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
  }, [tool.name, args]);

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
              <Caption1 style={{ display: 'block', marginBottom: 8 }}>{tool.description}</Caption1>
              <Field label="Args (JSON)" hint='e.g. {"sql":"SELECT 1","database":"master"}'>
                <Textarea
                  value={args}
                  onChange={(_, d) => setArgs(d.value)}
                  rows={6}
                  style={{ fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 12 }}
                />
              </Field>
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
  aoai?: { ok: boolean; endpoint?: string; deployment?: string; error?: string; remediation?: string };
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

  const stepsEndRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [steps.length]);

  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setPrompt('');
    setSteps([]);
    setTopError(null);
  }, []);

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

  const foundryPortalUrl = useMemo(() => 'https://ai.azure.com', []);

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
              {running ? 'Running…' : 'Orchestrate'}
            </Button>
            {running && <Spinner size="tiny" />}
            <div style={{ flex: 1 }} />
            <Caption1>{toolCount} tools registered</Caption1>
          </div>
        </div>
        <div className={s.steps}>
          {steps.length === 0 && !running && (
            <Caption1>Ask anything across Synapse, Lakehouse, Databricks, APIM, ADX, ADF, Power BI, Fabric, and Foundry. The orchestrator will pick the right tools.</Caption1>
          )}
          {steps.map((step, i) => <StepCard key={i} step={step} />)}
          <div ref={stepsEndRef} />
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
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Title2>Loom Copilot</Title2>
      <Caption1>Orchestrate across every wired service from a single natural-language prompt.</Caption1>
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
