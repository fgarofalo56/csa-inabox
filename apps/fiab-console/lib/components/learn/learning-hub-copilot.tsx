'use client';

/**
 * LearningHubCopilot — the Learning Hub's guided learning assistant.
 *
 * A real, streaming Copilot panel wired to the EXISTING help-copilot backend
 * (POST /api/help-copilot/chat — SSE of HelpStep) which until now shipped with
 * no front-end. The help agent is grounded in the CSA Loom docs (docs-search
 * tool) and is screen-aware via `context`; here we scope it to "help me
 * learn / build X in Loom" by sending the Learn route as the page context and
 * offering starter prompts tied to the gallery items.
 *
 * No new backend, no new env var: it consumes /api/help-copilot/chat which
 * resolves the tenant Copilot config (helpAgentDeployment) → AOAI, and returns
 * a 503 { gate:'aoai' } when no deployment is wired so the panel can surface an
 * honest infra gate with a deep-link to the admin Copilot config — never a
 * fabricated answer (no-vaporware.md).
 *
 * Markdown answers render through the shared CopilotMarkdown surface so model
 * prose + fenced code (T-SQL / KQL / PySpark) match the main Copilot console.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Button, Caption1, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Send16Filled, SparkleRegular, BotSparkle24Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import { CopilotMarkdown } from '@/lib/components/copilot/markdown';

/** Minimal HelpStep shape we consume from the SSE stream. */
type HelpStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string }
  | { kind: 'tool_result'; name: string }
  | { kind: 'citation'; citations: Array<{ id: string; title?: string; url?: string }> }
  | { kind: 'handoff'; reason: string; deepLink: string; suggestedPrompt: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string; code?: string };

interface Citation { id: string; title?: string; url?: string }
interface Turn {
  who: 'you' | 'copilot';
  text: string;
  streaming?: boolean;
  status?: string;
  citations?: Citation[];
  handoff?: { reason: string; deepLink: string; suggestedPrompt: string };
}

/** Inline SSE frame parser (same wire format as the main Copilot pane). */
function parseSse(buffer: string): { events: Array<{ event: string; data: string }>; remaining: string } {
  const events: Array<{ event: string; data: string }> = [];
  const chunks = buffer.split('\n\n');
  const remaining = chunks.pop() ?? '';
  for (const chunk of chunks) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, remaining };
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '560px',
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 80%)`,
  },
  headIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand,
    flexShrink: 0,
  },
  headText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  headTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  headSub: { color: tokens.colorNeutralForeground3 },

  log: {
    flex: 1,
    overflowY: 'auto',
    padding: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  empty: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground3,
  },
  starters: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  starter: { justifyContent: 'flex-start', textAlign: 'left' },

  turn: { display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '100%' },
  you: { alignSelf: 'flex-end', maxWidth: '85%' },
  youBubble: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    borderBottomRightRadius: tokens.borderRadiusSmall,
    wordBreak: 'break-word',
  },
  copilot: { alignSelf: 'flex-start', maxWidth: '95%' },
  copilotBubble: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusLarge,
    borderBottomLeftRadius: tokens.borderRadiusSmall,
  },
  status: { color: tokens.colorNeutralForeground3, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  citations: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, marginTop: '4px' },
  cite: {
    fontSize: tokens.fontSizeBase200, color: tokens.colorBrandForeground1,
    textDecorationLine: 'none', ':hover': { textDecorationLine: 'underline' },
  },
  handoff: { marginTop: tokens.spacingVerticalXS },

  composer: {
    display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  input: {
    flex: 1, resize: 'none', minHeight: '40px', maxHeight: '120px',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'inherit', fontSize: tokens.fontSizeBase300, lineHeight: tokens.lineHeightBase300,
    outlineWidth: 0,
    ':focus': { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: `0 0 0 1px ${tokens.colorBrandStroke1}` },
  },
});

export interface StarterPrompt { label: string; prompt: string }

const DEFAULT_STARTERS: StarterPrompt[] = [
  { label: 'How do I build a medallion lakehouse in Loom?', prompt: 'Walk me through building a bronze/silver/gold medallion lakehouse in CSA Loom, step by step.' },
  { label: 'Set up a real-time KQL dashboard', prompt: 'How do I stand up a real-time KQL dashboard over Event Hubs and ADX in Loom?' },
  { label: 'Which use case fits fraud detection?', prompt: 'I want to detect fraud on streaming data. Which Learning Hub use case should I install, and what does it provision?' },
  { label: 'What is the no-Fabric Azure-native backend?', prompt: 'Explain how CSA Loom delivers Fabric parity on Azure-native services without a real Fabric capacity.' },
];

export interface LearningHubCopilotProps {
  /** Starter prompts; defaults to a learning-oriented set. The gallery passes
   *  context-specific prompts tied to the visible items. */
  starters?: StarterPrompt[];
  /** Optional dismiss handler — when set, a close button shows in the header. */
  onDismiss?: () => void;
}

/**
 * The guided learning assistant. Streams real answers from the help-copilot
 * backend; surfaces an honest gate when AOAI isn't wired.
 */
export function LearningHubCopilot({ starters = DEFAULT_STARTERS, onDismiss }: LearningHubCopilotProps): React.ReactElement {
  const s = useStyles();
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [gate, setGate] = React.useState<string | null>(null);
  const sessionRef = React.useRef<string | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);

  // Keep the log scrolled to the newest turn.
  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [turns]);

  const send = React.useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setGate(null);
    setDraft('');
    setBusy(true);
    setTurns((t) => [...t, { who: 'you', text: prompt }, { who: 'copilot', text: '', streaming: true, status: 'Thinking…', citations: [] }]);

    try {
      const res = await fetch('/api/help-copilot/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt,
          sessionId: sessionRef.current ?? undefined,
          context: { path: '/learn', label: 'Learning Hub' },
        }),
      });

      if (res.status === 503) {
        const j = await res.json().catch(() => ({ error: 'Copilot AOAI deployment not wired' }));
        setGate(j.error || 'Copilot AOAI deployment not wired');
        setTurns((t) => t.filter((x) => !x.streaming));
        return;
      }
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setTurns((t) => t.map((x) => (x.streaming ? { ...x, text: `Error: ${j.error || res.statusText}`, streaming: false, status: undefined } : x)));
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
            continue;
          }
          if (ev.event !== 'step') continue;
          let step: HelpStep;
          try { step = JSON.parse(ev.data) as HelpStep; } catch { continue; }
          setTurns((t) => t.map((x) => {
            if (!x.streaming) return x;
            switch (step.kind) {
              case 'thought': return { ...x, status: step.content };
              case 'tool_call': return { ...x, status: `Searching the docs (${step.name})…` };
              case 'tool_result': return { ...x, status: 'Reading results…' };
              case 'citation': {
                const merged = [...(x.citations ?? [])];
                for (const c of step.citations) if (!merged.find((m) => m.id === c.id)) merged.push(c);
                return { ...x, citations: merged };
              }
              case 'handoff': return { ...x, handoff: { reason: step.reason, deepLink: step.deepLink, suggestedPrompt: step.suggestedPrompt } };
              case 'final': return { ...x, text: step.content, streaming: false, status: undefined };
              case 'error': return { ...x, text: `Error: ${step.error}`, streaming: false, status: undefined };
              default: return x;
            }
          }));
          if (step.kind === 'final' || step.kind === 'error') break;
        }
      }
    } catch (e: any) {
      setTurns((t) => t.map((x) => (x.streaming ? { ...x, text: `Error: ${e?.message || String(e)}`, streaming: false, status: undefined } : x)));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return (
    <div className={s.root}>
      <div className={s.head}>
        <span className={s.headIcon} aria-hidden><BotSparkle24Regular /></span>
        <div className={s.headText}>
          <span className={s.headTitle}>Learning Hub Copilot</span>
          <Caption1 className={s.headSub}>Grounded in the CSA Loom docs — ask how to learn or build anything.</Caption1>
        </div>
        <Badge appearance="tint" color="brand">Beta</Badge>
        {onDismiss && (
          <Button appearance="subtle" icon={<Dismiss16Regular />} aria-label="Close Copilot" onClick={onDismiss} />
        )}
      </div>

      <div className={s.log} ref={logRef}>
        {turns.length === 0 && (
          <div className={s.empty}>
            <Caption1>Try one of these, or ask your own question:</Caption1>
            <div className={s.starters}>
              {starters.map((p, i) => (
                <Button
                  key={i}
                  size="small"
                  appearance="outline"
                  icon={<SparkleRegular />}
                  className={s.starter}
                  onClick={() => send(p.prompt)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {gate && (
          <MessageBar intent="warning">
            <MessageBarTitle>Copilot not configured</MessageBarTitle>
            <MessageBarBody>
              {gate}{' '}
              <Link href="/admin/tenant-settings">Configure a Copilot model deployment →</Link>
            </MessageBarBody>
          </MessageBar>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={turn.who === 'you' ? s.you : s.copilot}>
            <div className={s.turn}>
              {turn.who === 'you' ? (
                <div className={s.youBubble}>{turn.text}</div>
              ) : (
                <div className={s.copilotBubble}>
                  {turn.streaming && !turn.text ? (
                    <Caption1 className={s.status}>
                      <Spinner size="tiny" /> {turn.status || 'Thinking…'}
                    </Caption1>
                  ) : (
                    <CopilotMarkdown source={turn.text} />
                  )}
                  {turn.citations && turn.citations.length > 0 && (
                    <div className={s.citations}>
                      {turn.citations.map((c) => (
                        c.url ? (
                          <a key={c.id} className={s.cite} href={c.url} target="_blank" rel="noreferrer">
                            {c.title || c.url}
                          </a>
                        ) : (
                          <Caption1 key={c.id}>{c.title || c.id}</Caption1>
                        )
                      ))}
                    </div>
                  )}
                  {turn.handoff && (
                    <div className={s.handoff}>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          {turn.handoff.reason}{' '}
                          <Link href={turn.handoff.deepLink}>Open →</Link>
                        </MessageBarBody>
                      </MessageBar>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className={s.composer}>
        <textarea
          className={s.input}
          placeholder="Ask how to build or learn something in Loom…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft); }
          }}
          rows={1}
          aria-label="Ask the Learning Hub Copilot"
        />
        <Button
          appearance="primary"
          icon={<Send16Filled />}
          disabled={busy || !draft.trim()}
          onClick={() => send(draft)}
          aria-label="Send"
        />
      </div>
    </div>
  );
}

export default LearningHubCopilot;
