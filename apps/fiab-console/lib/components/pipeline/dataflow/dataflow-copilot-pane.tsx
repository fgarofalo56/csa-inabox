'use client';

/**
 * DataflowCopilotPane — the AI authoring assistant docked beside the Power Query
 * surface in the Dataflow Gen2 editor, at parity with the Fabric Dataflow Gen2
 * Copilot pane. Five real capabilities, each rendered as a response card:
 *
 *   1. Generate a new query from natural language     (intent generate_query)
 *   2. Generate a query referencing the active query  (intent reference_query)
 *   3. Explain the active query + its applied steps    (intent explain)
 *   4. Add a transformation step                       (intent add_step)
 *   5. Undo the last applied step                      (intent undo)
 *
 * Generate/transform cards hold a PENDING diff: the new M is only written to the
 * dataflow's real M (via onApply) when the user clicks Apply, after which an
 * Undo button reverses exactly that change. The Applied Steps pane updates from
 * the shared M, so a Copilot step is indistinguishable from a ribbon step. No
 * fabricated Applied Steps — every step is parsed from the real M.
 *
 * Azure-native by default (no-fabric-dependency): talks only to
 * /api/items/dataflow/copilot. When AOAI is not wired the route returns an
 * honest 503 and the pane surfaces the exact remediation in a MessageBar.
 */

import { useCallback, useState } from 'react';
import {
  Subtitle2, Caption1, Body1Strong, Button, Textarea, Badge, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Sparkle20Regular, Add16Regular, BranchFork16Regular, Info16Regular,
  ArrowStepIn16Regular, ArrowUndo16Regular, Checkmark16Regular, Dismiss16Regular,
} from '@fluentui/react-icons';
import {
  parseSharedQueries, appendStep, setQueryBody, type RibbonTransform,
} from './m-script';

const useStyles = makeStyles({
  pane: {
    width: '360px', flexShrink: 0, display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalS, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1, overflow: 'auto', minHeight: '320px',
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  intentRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  cards: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalS, backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  code: {
    margin: 0, padding: tokens.spacingHorizontalS, overflow: 'auto',
    background: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusSmall,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12, whiteSpace: 'pre-wrap',
  },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: 2 },
  userBubble: {
    alignSelf: 'flex-end', maxWidth: '90%', padding: `4px 8px`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorBrandBackground2,
    fontSize: 13,
  },
});

type Intent = 'generate_query' | 'reference_query' | 'explain' | 'add_step' | 'undo';

interface CardBase { id: string }
type Card =
  | (CardBase & { kind: 'user'; text: string })
  | (CardBase & { kind: 'transform'; queryName: string; stepName: string; stepExpr: string; appliedPrevM?: string })
  | (CardBase & { kind: 'new_query'; queryName: string; mBody: string; appliedPrevM?: string })
  | (CardBase & { kind: 'undo'; queryName: string; removedStep: string; newBody: string; appliedPrevM?: string })
  | (CardBase & { kind: 'explain'; queryName: string; explanation: string })
  | (CardBase & { kind: 'gate'; error: string; hint?: string })
  | (CardBase & { kind: 'error'; message: string });

function bodyOf(mScript: string, name: string): string {
  return parseSharedQueries(mScript).find((q) => q.name === name)?.body || '';
}

export interface DataflowCopilotPaneProps {
  /** The current full M section (single source of truth). */
  mScript: string;
  /** The query the user is editing (target for explain / add_step / undo). */
  activeQuery: string;
  /** Apply a Copilot edit by replacing the whole M section. */
  onApply: (nextM: string) => void;
  disabled?: boolean;
}

export function DataflowCopilotPane({ mScript, activeQuery, onApply, disabled }: DataflowCopilotPaneProps) {
  const s = useStyles();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);

  const newId = () => `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const push = useCallback((c: Card) => setCards((prev) => [...prev, c]), []);

  const send = useCallback(async (intent: Intent, promptOverride?: string) => {
    const p = (promptOverride ?? prompt).trim();
    const needsPrompt = intent === 'generate_query' || intent === 'reference_query' || intent === 'add_step';
    if (needsPrompt && !p) return;
    setBusy(true);
    const echo =
      intent === 'explain' ? 'Explain my query'
      : intent === 'undo' ? 'Undo last step'
      : intent === 'reference_query' ? `Reference “${activeQuery}”: ${p}`
      : p;
    push({ id: newId(), kind: 'user', text: echo });
    if (needsPrompt && !promptOverride) setPrompt('');
    try {
      const res = await fetch('/api/items/dataflow/copilot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, prompt: p, mScript, activeQuery, sourceQuery: activeQuery }),
      });
      const j = await res.json();
      if (res.status === 503 && j.code === 'no_aoai') {
        push({ id: newId(), kind: 'gate', error: j.error || 'Azure OpenAI not configured', hint: j.hint });
        return;
      }
      if (!j.ok) { push({ id: newId(), kind: 'error', message: j.error || `Request failed (${res.status})` }); return; }
      switch (j.kind) {
        case 'new_query':
          push({ id: newId(), kind: 'new_query', queryName: j.queryName, mBody: j.mBody });
          break;
        case 'transform':
          push({ id: newId(), kind: 'transform', queryName: j.queryName, stepName: j.stepName, stepExpr: j.stepExpr });
          break;
        case 'explain':
          push({ id: newId(), kind: 'explain', queryName: j.queryName, explanation: j.explanation });
          break;
        case 'undo':
          push({ id: newId(), kind: 'undo', queryName: j.queryName, removedStep: j.removedStep, newBody: j.newBody });
          break;
        default:
          push({ id: newId(), kind: 'error', message: 'Unexpected response from Copilot.' });
      }
    } catch (e: any) {
      push({ id: newId(), kind: 'error', message: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [prompt, mScript, activeQuery, push]);

  // Apply a pending diff to the real M, recording the pre-apply snapshot so the
  // card's Undo can reverse exactly this edit.
  const applyCard = useCallback((card: Card) => {
    const prevM = mScript;
    let next = mScript;
    if (card.kind === 'transform') {
      const t: RibbonTransform = {
        key: 'copilot', label: card.stepName, tab: 'transform', stepName: card.stepName, expr: () => card.stepExpr,
      };
      const newBody = appendStep(bodyOf(mScript, card.queryName) || `let\n    Source = #table({}, {})\nin\n    Source`, t);
      next = setQueryBody(mScript, card.queryName, newBody);
    } else if (card.kind === 'new_query') {
      next = setQueryBody(mScript, card.queryName, card.mBody);
    } else if (card.kind === 'undo') {
      next = setQueryBody(mScript, card.queryName, card.newBody);
    } else {
      return;
    }
    onApply(next);
    setCards((prev) => prev.map((c) => (c.id === card.id ? ({ ...c, appliedPrevM: prevM } as Card) : c)));
  }, [mScript, onApply]);

  const undoCard = useCallback((card: Card & { appliedPrevM?: string }) => {
    if (!card.appliedPrevM) return;
    onApply(card.appliedPrevM);
    setCards((prev) => prev.map((c) => (c.id === card.id ? ({ ...c, appliedPrevM: undefined } as Card) : c)));
  }, [onApply]);

  const dismissCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const hasActive = !!activeQuery;

  return (
    <div className={s.pane} aria-label="Dataflow Copilot">
      <div className={s.header}>
        <Sparkle20Regular />
        <Subtitle2>Copilot</Subtitle2>
        {busy && <Spinner size="tiny" />}
      </div>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
        Active query: {hasActive ? <strong>{activeQuery}</strong> : '—'}
      </Caption1>

      <Textarea
        value={prompt}
        onChange={(_, d) => setPrompt(d.value)}
        placeholder='e.g. "only keep European customers" or "count employees by City"'
        disabled={disabled || busy}
        resize="vertical"
        rows={2}
        aria-label="Copilot prompt"
      />
      <div className={s.intentRow}>
        <Tooltip content="Generate a new query from your description" relationship="label">
          <Button size="small" appearance="primary" icon={<Add16Regular />} disabled={disabled || busy || !prompt.trim()} onClick={() => send('generate_query')}>New query</Button>
        </Tooltip>
        <Tooltip content="Add a transformation step to the active query" relationship="label">
          <Button size="small" appearance="outline" icon={<ArrowStepIn16Regular />} disabled={disabled || busy || !prompt.trim() || !hasActive} onClick={() => send('add_step')}>Add step</Button>
        </Tooltip>
        <Tooltip content="New query that references the active query" relationship="label">
          <Button size="small" appearance="outline" icon={<BranchFork16Regular />} disabled={disabled || busy || !prompt.trim() || !hasActive} onClick={() => send('reference_query')}>Reference</Button>
        </Tooltip>
        <Tooltip content="Explain the active query and its applied steps" relationship="label">
          <Button size="small" appearance="subtle" icon={<Info16Regular />} disabled={disabled || busy || !hasActive} onClick={() => send('explain')}>Explain</Button>
        </Tooltip>
        <Tooltip content="Remove the last applied step from the active query" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowUndo16Regular />} disabled={disabled || busy || !hasActive} onClick={() => send('undo')}>Undo last step</Button>
        </Tooltip>
      </div>

      <div className={s.cards}>
        {cards.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Ask Copilot to build a query, add a step, explain your query, or undo the last step.
            Generated M is validated and previewed as an Applied Step before it touches your dataflow.
          </Caption1>
        )}
        {cards.map((c) => {
          if (c.kind === 'user') {
            return <div key={c.id} className={s.userBubble}>{c.text}</div>;
          }
          if (c.kind === 'gate') {
            return (
              <MessageBar key={c.id} intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>
                  {c.hint || c.error}
                </MessageBarBody>
              </MessageBar>
            );
          }
          if (c.kind === 'error') {
            return (
              <MessageBar key={c.id} intent="error">
                <MessageBarBody>{c.message}</MessageBarBody>
              </MessageBar>
            );
          }
          if (c.kind === 'explain') {
            return (
              <div key={c.id} className={s.card}>
                <div className={s.cardHead}>
                  <Body1Strong>Explanation — {c.queryName}</Body1Strong>
                  <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => dismissCard(c.id)} aria-label="Dismiss" />
                </div>
                <Caption1 style={{ whiteSpace: 'pre-wrap' }}>{c.explanation}</Caption1>
              </div>
            );
          }
          // Pending-diff cards: transform / new_query / undo
          const applied = !!c.appliedPrevM;
          const title =
            c.kind === 'transform' ? `Add step: ${c.stepName}`
            : c.kind === 'new_query' ? `New query: ${c.queryName}`
            : `Remove step: ${c.removedStep}`;
          const codeText =
            c.kind === 'transform' ? `${c.stepName} =\n    ${c.stepExpr}`
            : c.kind === 'new_query' ? c.mBody
            : c.newBody;
          return (
            <div key={c.id} className={s.card}>
              <div className={s.cardHead}>
                <Body1Strong>{title}</Body1Strong>
                {applied
                  ? <Badge appearance="tint" color="success" icon={<Checkmark16Regular />}>Applied</Badge>
                  : <Badge appearance="tint" color="brand">Pending</Badge>}
              </div>
              <pre className={s.code}>{codeText}</pre>
              <div className={s.cardActions}>
                {!applied ? (
                  <>
                    <Button size="small" appearance="primary" icon={<Checkmark16Regular />} onClick={() => applyCard(c)}>Apply</Button>
                    <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => dismissCard(c.id)}>Dismiss</Button>
                  </>
                ) : (
                  <Button size="small" appearance="outline" icon={<ArrowUndo16Regular />} onClick={() => undoCard(c)}>Undo</Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
