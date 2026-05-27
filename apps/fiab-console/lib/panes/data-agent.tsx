'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  Title2,
  Body1,
  makeStyles,
  tokens,
  Button,
  Input,
  Avatar,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  MessageBarActions,
} from '@fluentui/react-components';
import { Send24Regular, Bot24Regular, Person24Regular } from '@fluentui/react-icons';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: { kind: 'sql' | 'dax' | 'kql' | 'doc'; source: string; preview: string }[];
  timestamp: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 96px)' },
  header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' },
  spacer: { flex: 1 },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  message: { display: 'flex', gap: '12px', alignItems: 'flex-start' },
  bubble: {
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '12px',
    borderRadius: '8px',
    maxWidth: '720px',
  },
  citation: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: '12px',
    padding: '8px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    margin: '8px 0',
    whiteSpace: 'pre-wrap',
  },
  composer: { display: 'flex', gap: '8px', marginTop: '12px' },
});

interface Remediation {
  message?: string;
  redirectTo?: string;
  env?: string[];
  bicepModule?: string;
}

export function DataAgentPane() {
  const styles = useStyles();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [gate, setGate] = useState<Remediation | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (!input.trim() || sending) return;
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/data-agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMsg] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Per no-vaporware.md: surface backend gating honestly so the user
        // knows where to go instead of getting a polite-looking fake reply.
        if (res.status === 503 && data.remediation) {
          setGate(data.remediation as Remediation);
        } else {
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: `Backend error (HTTP ${res.status}): ${data?.error || 'unknown error'}`,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        return;
      }
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.content ?? 'No response.',
          citations: data.citations,
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${e instanceof Error ? e.message : String(e)}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Data Agent</Title2>
        <div className={styles.spacer} />
      </div>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Data agent backend not deployed</MessageBarTitle>
            {gate.message}
            {gate.env && gate.env.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Required env: <code>{gate.env.join(', ')}</code>
              </div>
            )}
            {gate.bicepModule && (
              <div style={{ fontSize: 12 }}>
                Bicep module: <code>{gate.bicepModule}</code>
              </div>
            )}
          </MessageBarBody>
          <MessageBarActions>
            {gate.redirectTo && (
              <Link href={gate.redirectTo}>
                <Button appearance="primary">Open Copilot orchestrator</Button>
              </Link>
            )}
          </MessageBarActions>
        </MessageBar>
      )}

      <div className={styles.messages} ref={scrollRef}>
        {messages.length === 0 && (
          <Body1 style={{ textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
            Ask a question about your data. The agent uses NL2SQL, NL2DAX, or NL2KQL depending on the
            registered source. Every query executes under your Entra identity — RLS/CLS applies.
          </Body1>
        )}
        {messages.map((m) => (
          <div key={m.id} className={styles.message}>
            <Avatar
              icon={m.role === 'assistant' ? <Bot24Regular /> : <Person24Regular />}
              color={m.role === 'assistant' ? 'brand' : 'neutral'}
            />
            <div className={styles.bubble}>
              <Body1>{m.content}</Body1>
              {m.citations?.map((c, i) => (
                <div key={i} className={styles.citation}>
                  <div style={{ fontWeight: 600 }}>
                    {c.kind.toUpperCase()} · {c.source}
                  </div>
                  {c.preview}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.composer}>
        <Input
          style={{ flex: 1 }}
          value={input}
          onChange={(_, d) => setInput(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask the agent..."
          disabled={sending}
        />
        <Button appearance="primary" icon={<Send24Regular />} onClick={send} disabled={sending}>
          Send
        </Button>
      </div>
    </div>
  );
}
