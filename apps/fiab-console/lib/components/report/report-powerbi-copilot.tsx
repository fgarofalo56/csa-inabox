'use client';

/**
 * ReportPowerBiCopilot — the Power BI Copilot pane docked in the report DESIGNER
 * right rail (lib/editors/report-designer.tsx). Parity with the Power BI "Copilot"
 * pane: a chat surface that answers report-building + Power BI questions grounded
 * in the open-source Power BI authoring SKILLS + the (opt-in) Power BI remote MCP,
 * and ACTS on the open report — it proposes "add a Bar chart of <measure> by
 * <category>" / "add a page" as STRUCTURED specs the designer applies (the user
 * approves each; the user never types DAX — no-freeform-config.md).
 *
 * HOW IT ROUTES + ACTS
 *   - Posts each turn to POST /api/items/report/[id]/powerbi-copilot, which runs
 *     the shared Copilot orchestrator with the Power BI skills + the opt-in Power
 *     BI remote MCP made available, plus the report tools + the designer-acting
 *     tools (report_designer_add_visual / report_designer_add_page).
 *   - Streams OrchestratorStep SSE. When a tool_result carries an `add_visual` /
 *     `add_page` action, the pane renders an APPLY card; on Apply it calls the
 *     designer callbacks (onApplyVisual / onAddPage) which mutate the designer's
 *     in-memory state — the new visual then live-renders via …/query and persists
 *     on the designer's existing Save (PUT …/definition).
 *
 * HONEST GATE (no-vaporware.md): the route's opening `meta` event reports whether
 * the opt-in Power BI remote MCP is connected. When it is not, the pane shows a
 * non-blocking Fluent MessageBar with the exact remediation
 * (POWERBI_REMOTE_MCP_GATE_TEXT) — the skills + report-acting still work
 * Azure-native without it.
 *
 * NO-FABRIC-DEPENDENCY: the acting path is the Loom-native AAS designer; the
 * Power BI remote MCP only adds a live Power BI tool surface. WEB3-UI: Fluent v9 +
 * Loom tokens, cards with elevation, an icon per affordance.
 */

import { useCallback, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Button, Caption1, Body1, Body1Strong, Subtitle2, Spinner, Badge, Textarea, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Send20Regular, Checkmark16Regular, Dismiss16Regular,
  Wrench16Regular, CheckmarkCircle16Regular, ErrorCircle16Regular, Lightbulb16Regular,
  DataBarHorizontal20Regular, DocumentAdd20Regular, BookQuestionMark20Regular,
} from '@fluentui/react-icons';
import { POWERBI_REMOTE_MCP_GATE_TEXT } from '@/lib/copilot/powerbi-skills';

// ── designer-acting spec contracts (the pane OWNS these; report-designer imports them) ──

export type CopilotWellField = {
  table?: string; column?: string; measure?: string;
  aggregation?: 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max';
};
export interface CopilotVisualSpec {
  type: 'table' | 'matrix' | 'card' | 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'slicer';
  title?: string;
  wells?: { category?: CopilotWellField[]; values?: CopilotWellField[]; legend?: CopilotWellField[] };
  w?: number;
  h?: number;
}

/** Minimal shape of the model fields the designer already loaded from …/fields. */
export interface CopilotModelTable {
  name: string;
  columns: Array<{ name: string; dataType?: string }>;
  measures: Array<{ name: string }>;
}

export interface ReportPowerBiCopilotProps {
  /** The report's Loom item id (route + …/query/definition share it). */
  reportId: string;
  /** The bound AAS model fields (already loaded by the designer) — grounding. */
  tables: CopilotModelTable[];
  /** Active page context (for the model + the page-add target). */
  pageIndex: number;
  pageName: string;
  visualCount: number;
  /** Apply a proposed visual spec to the designer's in-memory state. */
  onApplyVisual: (spec: CopilotVisualSpec) => void;
  /** Add a page to the designer (optional name). */
  onAddPage: (name?: string) => void;
}

// ── SSE step contract (subset of OrchestratorStep the pane renders) ──

type Step =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; callId: string; args?: unknown }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string; code?: string };

interface ApplyCard {
  id: string;
  kind: 'visual' | 'page';
  applied: boolean;
  spec?: CopilotVisualSpec;     // visual
  pageName?: string;            // page
  label: string;
}

interface Turn {
  who: 'you' | 'copilot';
  text: string;
  steps: Step[];
  cards: ApplyCard[];
  streaming?: boolean;
}

const QUICK_PROMPTS: { label: string; icon: JSX.Element; prompt: string }[] = [
  { label: 'Suggest visuals', icon: <DataBarHorizontal20Regular />, prompt: 'Suggest a few visuals for this page grounded in the model fields, and add the best one.' },
  { label: 'Design brief', icon: <BookQuestionMark20Regular />, prompt: 'Give me a short design brief for this report — audience, the top questions, and a page layout.' },
];

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0, height: '100%' },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  ctx: { color: tokens.colorNeutralForeground3 },
  thread: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, paddingRight: tokens.spacingHorizontalXXS },
  bubble: { padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusLarge, maxWidth: '94%' },
  you: { alignSelf: 'flex-end', backgroundColor: tokens.colorBrandBackground2 },
  bot: { alignSelf: 'flex-start', backgroundColor: tokens.colorNeutralBackground2 },
  stepRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalXXS,
  },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  err: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorBrandStroke2}`, borderRadius: tokens.borderRadiusLarge,
    padding: tokens.spacingHorizontalS, backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, marginTop: tokens.spacingVerticalXS,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalXS },
  wells: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
  quick: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  composer: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  sendRow: { display: 'flex', gap: tokens.spacingHorizontalXS, justifyContent: 'flex-end' },
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

/** One-line summary of a visual spec's wells for the Apply card. */
function describeWells(spec: CopilotVisualSpec): string {
  const fmt = (f: CopilotWellField) => f.measure || `${f.aggregation ? `${f.aggregation} of ` : ''}${f.column}`;
  const parts: string[] = [];
  if (spec.wells?.values?.length) parts.push(`Values: ${spec.wells.values.map(fmt).join(', ')}`);
  if (spec.wells?.category?.length) parts.push(`Axis: ${spec.wells.category.map(fmt).join(', ')}`);
  if (spec.wells?.legend?.length) parts.push(`Legend: ${spec.wells.legend.map(fmt).join(', ')}`);
  return parts.join(' · ') || 'no fields';
}

export function ReportPowerBiCopilot({
  reportId, tables, pageIndex, pageName, visualCount, onApplyVisual, onAddPage,
}: ReportPowerBiCopilotProps) {
  const s = useStyles();
  const [turns, setTurns] = useState<Turn[]>([{
    who: 'copilot',
    text: 'I am your Power BI Copilot for this report. Ask me to add a chart ("a bar chart of total sales by region"), add a page, or for a design brief — I build with the bound model\'s fields and you approve each change.',
    steps: [], cards: [],
  }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [aoaiGate, setAoaiGate] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const scrollDown = () => {
    requestAnimationFrame(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; });
  };

  const applyCard = useCallback((turnIdx: number, cardId: string) => {
    setTurns((prev) => prev.map((t, i) => {
      if (i !== turnIdx) return t;
      return {
        ...t,
        cards: t.cards.map((c) => {
          if (c.id !== cardId || c.applied) return c;
          if (c.kind === 'visual' && c.spec) onApplyVisual(c.spec);
          if (c.kind === 'page') onAddPage(c.pageName);
          return { ...c, applied: true };
        }),
      };
    }));
  }, [onApplyVisual, onAddPage]);

  const dismissCard = useCallback((turnIdx: number, cardId: string) => {
    setTurns((prev) => prev.map((t, i) => (i === turnIdx ? { ...t, cards: t.cards.filter((c) => c.id !== cardId) } : t)));
  }, []);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setDraft('');
    setAoaiGate(null);
    setBusy(true);
    setTurns((prev) => [...prev, { who: 'you', text, steps: [], cards: [] }, { who: 'copilot', text: '', steps: [], cards: [], streaming: true }]);
    scrollDown();

    // Compact field grounding (names only) so the model references real fields.
    const fields = {
      tables: (tables || []).map((t) => ({
        name: t.name,
        columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
        measures: (t.measures || []).map((m) => ({ name: m.name })),
      })),
    };

    try {
      const res = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/powerbi-copilot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          sessionId: sessionRef.current ?? undefined,
          fields,
          page: { index: pageIndex, name: pageName, visualCount },
        }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({ error: 'Copilot AOAI not wired' }));
        setAoaiGate(j.error || 'Copilot AOAI deployment not wired');
        setTurns((prev) => prev.filter((t) => !t.streaming));
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: `Error: ${j.error || res.statusText}`, streaming: false } : t)));
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
            try { const d = JSON.parse(ev.data); if (d.sessionId) sessionRef.current = d.sessionId; } catch { /* ignore */ }
          } else if (ev.event === 'meta') {
            try {
              const d = JSON.parse(ev.data) as { pbiMcpConnected?: boolean; gate?: string };
              setGate(d.pbiMcpConnected ? null : (d.gate || POWERBI_REMOTE_MCP_GATE_TEXT));
            } catch { /* ignore */ }
          } else if (ev.event === 'step') {
            let step: Step | null = null;
            try { step = JSON.parse(ev.data) as Step; } catch { step = null; }
            if (!step) continue;
            setTurns((prev) => prev.map((t) => {
              if (!t.streaming) return t;
              if (step!.kind === 'final') return { ...t, text: step!.content || t.text, streaming: false };
              if (step!.kind === 'error') return { ...t, text: `Error: ${step!.error}`, streaming: false };
              // A designer-acting tool result → an Apply card.
              if (step!.kind === 'tool_result' && !step!.error) {
                const card = cardFromResult(step!.name, step!.result);
                if (card) return { ...t, steps: [...t.steps, step!], cards: [...t.cards, card] };
              }
              return { ...t, steps: [...t.steps, step!] };
            }));
            scrollDown();
          } else if (ev.event === 'done') {
            setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, streaming: false } : t)));
          }
        }
      }
    } catch (e: any) {
      setTurns((prev) => prev.map((t) => (t.streaming ? { ...t, text: `Network error: ${e?.message || e}`, streaming: false } : t)));
    } finally {
      setBusy(false);
      scrollDown();
    }
  }, [busy, reportId, tables, pageIndex, pageName, visualCount]);

  return (
    <div className={s.pane} aria-label="Power BI Copilot">
      <div className={s.head}>
        <Sparkle20Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Power BI Copilot</Subtitle2>
        {busy && <Spinner size="tiny" />}
      </div>
      <Caption1 className={s.ctx}>
        Page <strong>{pageName || `Page ${pageIndex + 1}`}</strong> · {visualCount} visual{visualCount === 1 ? '' : 's'} · {tables.length} table{tables.length === 1 ? '' : 's'} in model
      </Caption1>

      {aoaiGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Copilot AOAI deployment not wired</MessageBarTitle>
            {aoaiGate} — open the AI Foundry editor and deploy a gpt-4o / gpt-4.1-class chat model.
          </MessageBarBody>
        </MessageBar>
      )}
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power BI remote MCP not connected (optional)</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.thread} ref={threadRef} aria-live="polite">
        {turns.map((t, ti) => (
          <div key={ti} className={`${s.bubble} ${t.who === 'you' ? s.you : s.bot}`}>
            {t.text && <Body1 style={{ whiteSpace: 'pre-wrap' }}>{t.text}</Body1>}
            {t.steps.map((step, si) => {
              if (step.kind === 'tool_call') {
                return <div key={si} className={s.stepRow}><Wrench16Regular aria-hidden /> calling <strong>{step.name}</strong>…</div>;
              }
              if (step.kind === 'tool_result') {
                return (
                  <div key={si} className={s.stepRow}>
                    {step.error ? <ErrorCircle16Regular className={s.err} aria-label="failed" /> : <CheckmarkCircle16Regular className={s.ok} aria-label="ok" />}
                    {step.name} ({step.durationMs}ms){step.error ? ` — ${step.error}` : ''}
                  </div>
                );
              }
              if (step.kind === 'thought') {
                return <div key={si} className={s.stepRow}><Lightbulb16Regular aria-hidden /> {step.content.slice(0, 120)}</div>;
              }
              return null;
            })}
            {t.streaming && !t.text && <div className={s.stepRow}><Spinner size="extra-tiny" /> Thinking…</div>}
            {t.cards.map((c) => (
              <div key={c.id} className={s.card}>
                <div className={s.cardHead}>
                  <Body1Strong>
                    {c.kind === 'visual' ? <DataBarHorizontal20Regular style={{ verticalAlign: 'middle' }} /> : <DocumentAdd20Regular style={{ verticalAlign: 'middle' }} />}
                    {' '}{c.label}
                  </Body1Strong>
                  {c.applied
                    ? <Badge appearance="tint" color="success" icon={<Checkmark16Regular />}>Applied</Badge>
                    : <Badge appearance="tint" color="brand">Proposed</Badge>}
                </div>
                {c.kind === 'visual' && c.spec && <Caption1 className={s.wells}>{describeWells(c.spec)}</Caption1>}
                {!c.applied && (
                  <div className={s.cardActions}>
                    <Button size="small" appearance="primary" icon={<Checkmark16Regular />} onClick={() => applyCard(ti, c.id)}>
                      {c.kind === 'visual' ? 'Add to canvas' : 'Add page'}
                    </Button>
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => dismissCard(ti, c.id)}>Dismiss</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {turns.length <= 1 && (
        <div className={s.quick}>
          {QUICK_PROMPTS.map((q) => (
            <Tooltip key={q.label} content={q.prompt} relationship="label">
              <Button size="small" appearance="outline" icon={q.icon} disabled={busy} onClick={() => void send(q.prompt)}>{q.label}</Button>
            </Tooltip>
          ))}
          <Tooltip content="Add a new report page" relationship="label">
            <Button size="small" appearance="subtle" icon={<DocumentAdd20Regular />} disabled={busy} onClick={() => onAddPage()}>Add page</Button>
          </Tooltip>
        </div>
      )}

      <div className={s.composer}>
        <Textarea
          value={draft}
          onChange={(_e, d) => setDraft(d.value)}
          placeholder='e.g. "add a bar chart of total revenue by region"'
          disabled={busy}
          resize="vertical"
          rows={2}
          aria-label="Ask Power BI Copilot"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !busy) { e.preventDefault(); void send(draft); } }}
        />
        <div className={s.sendRow}>
          <Button appearance="primary" icon={<Send20Regular />} disabled={busy || !draft.trim()} onClick={() => void send(draft)}>Send</Button>
        </div>
      </div>
    </div>
  );
}

/** Build an Apply card from a designer-acting tool result, else null. */
function cardFromResult(name: string, result: unknown): ApplyCard | null {
  const r = (result || {}) as Record<string, unknown>;
  if (name === 'report_designer_add_visual' && r.ok && r.spec && typeof r.spec === 'object') {
    const spec = r.spec as CopilotVisualSpec;
    return {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'visual', applied: false, spec,
      label: spec.title ? `${spec.title} (${spec.type})` : `New ${spec.type}`,
    };
  }
  if (name === 'report_designer_add_page' && r.ok && r.action === 'add_page') {
    const nm = typeof r.name === 'string' ? r.name : undefined;
    return {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'page', applied: false, pageName: nm,
      label: nm ? `New page: ${nm}` : 'New page',
    };
  }
  return null;
}

export default ReportPowerBiCopilot;
