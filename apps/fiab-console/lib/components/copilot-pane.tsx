'use client';

/**
 * CopilotPane — collapsible right rail with a Copilot chat surface.
 * Renders on every page. Phase 6 "Copilot side-pane in every editor"
 * scope. Floating button toggles open/close.
 */

import { useState } from 'react';
import {
  Button, Input, makeStyles, tokens, Caption1, Body1, Subtitle2,
} from '@fluentui/react-components';
import { Send24Regular, Sparkle24Regular, Dismiss20Regular } from '@fluentui/react-icons';

interface Msg { who: 'you' | 'copilot'; text: string; }

const SEED: Msg[] = [
  { who: 'copilot', text: 'Hi! I can help you build pipelines, write KQL or T-SQL, summarize a report, or set up an Activator rule. What are we working on?' },
];

const useStyles = makeStyles({
  toggle: {
    position: 'fixed',
    right: 16,
    bottom: 16,
    zIndex: 1000,
    boxShadow: tokens.shadow16,
    borderRadius: '50%',
    width: 48,
    height: 48,
    minWidth: 48,
  },
  panel: {
    position: 'fixed',
    right: 0,
    top: 'var(--loom-topbar-height)',
    bottom: 0,
    width: 360,
    backgroundColor: tokens.colorNeutralBackground1,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
    display: 'flex',
    flexDirection: 'column',
    zIndex: 999,
  },
  header: {
    padding: 12,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: 8,
  },
  body: {
    flex: 1, overflowY: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  msg: {
    padding: '8px 12px',
    borderRadius: 12,
    maxWidth: '85%',
  },
  msgCopilot: { backgroundColor: tokens.colorNeutralBackground2, alignSelf: 'flex-start' },
  msgYou: { backgroundColor: tokens.colorBrandBackground2, alignSelf: 'flex-end' },
  composer: {
    padding: 12, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', gap: 8,
  },
});

export function CopilotPane() {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(SEED);
  const [draft, setDraft] = useState('');

  function send() {
    const t = draft.trim();
    if (!t) return;
    const next: Msg[] = [...msgs, { who: 'you' as const, text: t }];
    setMsgs(next);
    setDraft('');
    setTimeout(() => {
      setMsgs((m) => [...m, {
        who: 'copilot' as const,
        text: `Sure — for "${t.substring(0, 60)}", here's what I'd try:\n\n• Open the most relevant item editor.\n• Draft the KQL / DAX / T-SQL.\n• Wire an Activator rule if you want alerts.\n\n(Wire me to a real LLM by setting AZURE_OPENAI_ENDPOINT.)`,
      }]);
    }, 400);
  }

  if (!open) {
    return (
      <Button
        className={s.toggle}
        appearance="primary"
        icon={<Sparkle24Regular />}
        aria-label="Open Copilot"
        title="Copilot (Ctrl+/)"
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <aside className={s.panel} aria-label="Copilot">
      <div className={s.header}>
        <Sparkle24Regular />
        <Subtitle2>Copilot</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>preview</Caption1>
        <Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setOpen(false)} aria-label="Close Copilot" />
      </div>
      <div className={s.body}>
        {msgs.map((m, i) => (
          <div key={i} className={`${s.msg} ${m.who === 'copilot' ? s.msgCopilot : s.msgYou}`}>
            <Body1 style={{ whiteSpace: 'pre-wrap' }}>{m.text}</Body1>
          </div>
        ))}
      </div>
      <div className={s.composer}>
        <Input
          style={{ flex: 1 }}
          value={draft}
          onChange={(_, d) => setDraft(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Ask Copilot…"
          aria-label="Message Copilot"
        />
        <Button appearance="primary" icon={<Send24Regular />} onClick={send} aria-label="Send message" />
      </div>
    </aside>
  );
}
