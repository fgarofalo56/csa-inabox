'use client';

/**
 * CopilotPane — collapsible right rail. v1.5 change: no floating
 * button (it covered the brand). Toggled exclusively via the topbar
 * Sparkle button, the openCopilot() export, or Ctrl+/.
 */

import { useEffect, useState } from 'react';
import {
  Button, Input, makeStyles, tokens, Caption1, Body1, Subtitle2,
} from '@fluentui/react-components';
import { Send24Regular, Sparkle24Regular, Dismiss20Regular } from '@fluentui/react-icons';

interface Msg { who: 'you' | 'copilot'; text: string; }

const SEED: Msg[] = [
  { who: 'copilot', text: 'Hi! I can help you build pipelines, write KQL or T-SQL, summarize a report, or set up an Activator rule. What are we working on?' },
];

const EVT_OPEN = 'csaloom:open-copilot';
const EVT_TOGGLE = 'csaloom:toggle-copilot';

/** Imperative API for non-React triggers (topbar button etc.). */
export function openCopilot() {
  window.dispatchEvent(new Event(EVT_OPEN));
}
export function toggleCopilot() {
  window.dispatchEvent(new Event(EVT_TOGGLE));
}

const useStyles = makeStyles({
  panel: {
    position: 'fixed',
    right: 0,
    top: 'var(--loom-topbar-height)',
    bottom: 0,
    width: 380,
    backgroundColor: tokens.colorNeutralBackground1,
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: '-8px 0 24px rgba(0,0,0,0.10)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 1000,
  },
  header: {
    padding: 12,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'linear-gradient(90deg, rgba(125,108,255,0.10), transparent)',
  },
  body: {
    flex: 1, overflowY: 'auto', padding: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  msg: {
    padding: '10px 14px',
    borderRadius: 14,
    maxWidth: '88%',
  },
  msgCopilot: {
    backgroundColor: tokens.colorNeutralBackground2,
    alignSelf: 'flex-start',
    borderTopLeftRadius: 4,
  },
  msgYou: {
    backgroundColor: tokens.colorBrandBackground2,
    alignSelf: 'flex-end',
    borderTopRightRadius: 4,
  },
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

  useEffect(() => {
    const o = () => setOpen(true);
    const t = () => setOpen((x) => !x);
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); t(); }
    };
    window.addEventListener(EVT_OPEN, o);
    window.addEventListener(EVT_TOGGLE, t);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener(EVT_OPEN, o);
      window.removeEventListener(EVT_TOGGLE, t);
      window.removeEventListener('keydown', k);
    };
  }, []);

  function send() {
    const t = draft.trim();
    if (!t) return;
    const next: Msg[] = [...msgs, { who: 'you' as const, text: t }];
    setMsgs(next);
    setDraft('');
    setTimeout(() => {
      setMsgs((m) => [...m, {
        who: 'copilot' as const,
        text: `For "${t.substring(0, 80)}", here's what I'd try:\n\n• Open the most relevant item editor.\n• Draft the KQL / DAX / T-SQL.\n• Wire an Activator rule if you want alerts.\n\n(Wire me to a real LLM by setting AZURE_OPENAI_ENDPOINT.)`,
      }]);
    }, 400);
  }

  if (!open) return null;

  return (
    <aside className={s.panel} aria-label="Copilot">
      <div className={s.header}>
        <Sparkle24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Copilot</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>Ctrl + /</Caption1>
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
