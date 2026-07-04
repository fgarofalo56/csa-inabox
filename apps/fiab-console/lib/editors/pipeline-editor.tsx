'use client';

/**
 * pipeline-editor.tsx — Pipeline Copilot pane + canvas apply bridge.
 *
 * `PipelineCopilotPane` docks in the data-pipeline editor's right rail
 * (ItemEditorChrome.rightPanel, wired from pipeline-editor-core.tsx). It is the
 * NL→pipeline / `/`-completion / run / summarize / error-assistant surface that
 * the operator chats with.
 *
 * Backends (per no-fabric-dependency.md): the pane POSTs to
 *   POST /api/items/{slug}/{id}/copilot   (slug = adf-pipeline | synapse-pipeline)
 * which streams orchestrator `step` events PLUS a `canvas_apply` event carrying
 * the generated pipeline spec. The CANVAS APPLY BRIDGE is the onApplySpec
 * callback: on `canvas_apply`, the pane hands the spec to PipelineEditorCore,
 * which sets it on the real React-Flow canvas (and it's already persisted to the
 * bound ADF/Synapse pipeline by the pipeline_apply_canvas tool). No placeholder
 * pipeline JSON — every node is a real activity from a real upsert.
 *
 * `/` completion: typing "/" populates a linked-service picker from
 *   GET /api/items/{slug}/{id}/connections
 * so the operator can drop a REAL source/dest connection name into the prompt.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Textarea, MessageBar, MessageBarBody, MessageBarTitle,
  Badge, Caption1, Body1, Subtitle2, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Send24Regular, Sparkle20Regular, PlugConnected20Regular, Warning16Regular, Checkmark16Regular, Comment16Regular } from '@fluentui/react-icons';
import type { PipelineSpec } from '@/lib/components/pipeline/types';

interface CopilotUsage { promptTokens: number; completionTokens: number; totalTokens: number; aoaiCalls: number; toolCalls: number; }

type Step =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; error?: string }
  | { kind: 'final'; content: string; usage?: CopilotUsage; model?: string }
  | { kind: 'error'; error: string };

interface Msg {
  who: 'you' | 'copilot';
  text: string;
  steps?: Step[];
  streaming?: boolean;
  usage?: CopilotUsage;
  model?: string;
}

interface Connection { name: string; type: string; capable: Array<'source' | 'sink'> }

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: tokens.spacingVerticalS },
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, paddingRight: tokens.spacingHorizontalXS },
  msg: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderRadius: tokens.borderRadiusXLarge,
    maxWidth: '95%', fontSize: tokens.fontSizeBase300, minWidth: 0,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  msgCopilot: { backgroundColor: tokens.colorNeutralBackground2, alignSelf: 'flex-start', borderTopLeftRadius: tokens.borderRadiusSmall },
  msgYou: { backgroundColor: tokens.colorBrandBackground2, alignSelf: 'flex-end', borderTopRightRadius: tokens.borderRadiusSmall },
  stepRow: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, paddingLeft: tokens.spacingHorizontalXXS, marginTop: tokens.spacingVerticalXS,
    overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  composer: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, paddingTop: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  picker: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    maxHeight: '168px', overflowY: 'auto', backgroundColor: tokens.colorNeutralBackground1,
  },
  pickItem: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, minWidth: 0,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    cursor: 'pointer', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
});

function parseSse(buffer: string): { events: Array<{ event: string; data: string }>; remaining: string } {
  const out: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split(/\n\n/);
  const remaining = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.slice(6);
    }
    if (data) out.push({ event, data });
  }
  return { events: out, remaining };
}

const SEED: Msg[] = [{
  who: 'copilot',
  text: 'I can build this pipeline from a description — e.g. "copy from ADLS folder raw/orders to SQL table dbo.Orders". I can also run it, summarize it, or explain a failed run. Type "/" to drop in a real connection name.',
}];

export interface PipelineCopilotPaneProps {
  /** `/api/items/{slug}/{id}` base for the copilot + connections routes. */
  apiBase: string;
  /** The bound Azure pipeline name, or null when the item isn't bound yet. */
  bound: string | null;
  /** Canvas apply bridge — called with the generated spec on `canvas_apply`. */
  onApplySpec: (spec: PipelineSpec) => void;
}

export function PipelineCopilotPane({ apiBase, bound, onApplySpec }: PipelineCopilotPaneProps) {
  const s = useStyles();
  const [msgs, setMsgs] = useState<Msg[]>(SEED);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Load connections once bound (for `/` completion). Soft-fail: a config gate
  // just means the picker stays empty; chat still works.
  useEffect(() => {
    if (!bound) return;
    let cancelled = false;
    fetch(`${apiBase}/connections`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.connections) setConnections(d.connections); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase, bound]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs]);

  const onDraftChange = useCallback((val: string) => {
    setDraft(val);
    setShowPicker(val.endsWith('/') && connections.length > 0);
  }, [connections.length]);

  const pickConnection = useCallback((name: string) => {
    setDraft((prev) => (prev.endsWith('/') ? prev.slice(0, -1) : prev) + name + ' ');
    setShowPicker(false);
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setShowPicker(false);
    setGateError(null);
    setBusy(true);
    setMsgs((m) => [...m, { who: 'you', text }, { who: 'copilot', text: '', steps: [], streaming: true }]);

    try {
      const res = await fetch(`${apiBase}/copilot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, sessionId: sessionRef.current ?? undefined }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({ error: 'Copilot Azure OpenAI not wired' }));
        setGateError(j.error || 'Azure OpenAI deployment not wired');
        setMsgs((m) => m.filter((x) => !x.streaming));
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMsgs((m) => m.map((x) => (x.streaming ? { ...x, text: `Error: ${j.error || res.statusText}`, streaming: false } : x)));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSse(buffer);
        buffer = remaining;
        for (const ev of events) {
          if (ev.event === 'session') {
            try { const d = JSON.parse(ev.data); if (d.sessionId) sessionRef.current = d.sessionId; } catch {}
          } else if (ev.event === 'canvas_apply') {
            // CANVAS APPLY BRIDGE — push the generated spec to the React-Flow canvas.
            try { const d = JSON.parse(ev.data); if (d.spec) onApplySpec(d.spec as PipelineSpec); } catch {}
          } else if (ev.event === 'step') {
            try {
              const step = JSON.parse(ev.data) as Step;
              setMsgs((m) => m.map((x) => {
                if (!x.streaming) return x;
                if (step.kind === 'final') return { ...x, text: step.content, streaming: false, usage: step.usage, model: step.model };
                if (step.kind === 'error') return { ...x, text: `Error: ${step.error}`, streaming: false };
                return { ...x, steps: [...(x.steps ?? []), step] };
              }));
            } catch {}
          } else if (ev.event === 'done') {
            setMsgs((m) => m.map((x) => (x.streaming ? { ...x, streaming: false } : x)));
          }
        }
      }
    } catch (e: any) {
      setMsgs((m) => m.map((x) => (x.streaming ? { ...x, text: `Network error: ${e?.message || e}`, streaming: false } : x)));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, apiBase, onApplySpec]);

  return (
    <div className={s.pane} aria-label="Pipeline Copilot">
      <div className={s.header}>
        <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Pipeline Copilot</Subtitle2>
      </div>

      {!bound && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Bind a pipeline first</MessageBarTitle>
            Copilot generates and runs against the bound Azure pipeline. Bind this item to an existing pipeline (or create one) to start.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.body} ref={bodyRef}>
        {gateError && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>
              {gateError} — set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or deploy the AI Foundry project) and grant the console UAMI &quot;Cognitive Services OpenAI User&quot;.
            </MessageBarBody>
          </MessageBar>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`${s.msg} ${m.who === 'copilot' ? s.msgCopilot : s.msgYou}`}>
            {m.text && <Body1 style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Body1>}
            {m.steps?.map((step, j) => {
              if (step.kind === 'tool_call') return <div key={j} className={s.stepRow}>↪ calling <strong>{step.name}</strong>…</div>;
              if (step.kind === 'tool_result') return (
                <div key={j} className={s.stepRow}>
                  {step.error ? <Warning16Regular style={{ verticalAlign: 'text-bottom', color: tokens.colorPaletteRedForeground1 }} /> : <Checkmark16Regular style={{ verticalAlign: 'text-bottom', color: tokens.colorPaletteGreenForeground1 }} />} {step.name} <span>({step.durationMs}ms)</span>
                  {step.error && <span style={{ color: tokens.colorPaletteRedForeground1 }}> — {step.error}</span>}
                </div>
              );
              if (step.kind === 'thought') return <div key={j} className={s.stepRow}><Comment16Regular style={{ verticalAlign: 'text-bottom' }} /> {step.content.slice(0, 120)}</div>;
              return null;
            })}
            {m.streaming && !m.text && (<div className={s.stepRow}><Spinner size="extra-tiny" /> Thinking…</div>)}
            {m.who === 'copilot' && !m.streaming && m.usage && (
              <Caption1 className={s.stepRow} style={{ color: tokens.colorNeutralForeground3 }}>
                {m.usage.toolCalls > 0 ? `${m.usage.toolCalls} tool${m.usage.toolCalls === 1 ? '' : 's'} · ` : ''}
                {m.usage.totalTokens.toLocaleString()} tokens
                {m.model ? ` · ${m.model}` : ''}
              </Caption1>
            )}
          </div>
        ))}
      </div>

      {showPicker && (
        <div className={s.picker} role="listbox" aria-label="Connections">
          {connections.map((c) => (
            <div key={c.name} className={s.pickItem} role="option" aria-selected={false}
              tabIndex={0}
              onClick={() => pickConnection(c.name)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickConnection(c.name); } }}>
              <PlugConnected20Regular style={{ fontSize: tokens.fontSizeBase300 }} />
              <strong>{c.name}</strong>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.type}</Caption1>
              {c.capable.map((cap) => (
                <Badge key={cap} size="extra-small" appearance="outline" color={cap === 'source' ? 'informative' : 'success'}>{cap}</Badge>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className={s.composer}>
        <Textarea
          value={draft}
          onChange={(_, d) => onDraftChange(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) { e.preventDefault(); send(); } }}
          placeholder={bound ? 'Copy from ADLS folder raw/orders to SQL table dbo.Orders   (/ for connections)' : 'Bind a pipeline to start'}
          rows={3}
          disabled={busy || !bound}
          aria-label="Message Pipeline Copilot"
        />
        <Button appearance="primary" icon={<Send24Regular />} onClick={send} disabled={busy || !bound || !draft.trim()}>
          {busy ? 'Working…' : 'Send (Ctrl+Enter)'}
        </Button>
      </div>
    </div>
  );
}
