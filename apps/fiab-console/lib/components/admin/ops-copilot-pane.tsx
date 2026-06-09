'use client';

/**
 * OpsCopilotPane — Admin → Capacity & compute → "Ops Copilot".
 *
 * Natural-language ops actions over the Azure-native infrastructure Loom runs
 * on, each behind an approval diff + RBAC gate:
 *   - scale a Synapse dedicated SQL pool ("scale the SQL pool to DW200c")
 *   - scale the ADX cluster
 *   - toggle the Synapse workspace outbound-access policy
 *   - create a Loom workspace
 *
 * Flow: type → POST /api/admin/ops-copilot (classify, no mutation) → review the
 * before/after diff → Confirm → POST /api/admin/ops-copilot/execute (real ARM /
 * Cosmos write). Every non-functional state is an HONEST Fluent MessageBar
 * (warning = needs a role / env var; error = ARM said no). No fake success.
 */
import { useCallback, useState } from 'react';
import {
  Button, Textarea, Caption1, Body1, Subtitle2, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Send16Regular, Checkmark16Regular, Dismiss16Regular, Sparkle20Regular,
  ArrowRight16Regular,
} from '@fluentui/react-icons';

interface DiffRow { label: string; before: string; after: string }
interface ClassifyResponse {
  ok: boolean;
  intentionId?: string;
  intention?: { action: string };
  diffSummary?: string;
  diff?: DiffRow[];
  clarify?: string;
  rbacGate?: string;
  configGate?: string;
  error?: string;
}

type Phase = 'idle' | 'classifying' | 'awaiting' | 'executing' | 'done';

const EXAMPLES = [
  'Scale the SQL pool to DW200c',
  'Enable outbound access on the Synapse workspace',
  'Create a workspace named Analytics Sandbox',
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  inputRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  examples: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  chip: { cursor: 'pointer' },
  card: {
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
  },
  diffGrid: {
    display: 'grid', gridTemplateColumns: '160px 1fr 24px 1fr', alignItems: 'center',
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  before: { color: tokens.colorNeutralForeground3 },
  after: { color: tokens.colorBrandForeground1, fontWeight: 600 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

export function OpsCopilotPane() {
  const s = useStyles();
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [cls, setCls] = useState<ClassifyResponse | null>(null);
  const [clarify, setClarify] = useState<string | null>(null);
  const [gate, setGate] = useState<{ kind: 'rbac' | 'config' | 'role'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = useCallback((keepPrompt = false) => {
    setPhase('idle'); setCls(null); setClarify(null); setGate(null); setError(null); setDone(null);
    if (!keepPrompt) setPrompt('');
  }, []);

  const classify = useCallback(async (text: string) => {
    const p = text.trim();
    if (!p) return;
    setPhase('classifying'); setCls(null); setClarify(null); setGate(null); setError(null); setDone(null);
    try {
      const r = await fetch('/api/admin/ops-copilot', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: p }),
      });
      const j: ClassifyResponse = await r.json();
      if (r.status === 403 && j.rbacGate) { setGate({ kind: 'rbac', text: j.rbacGate }); setPhase('idle'); return; }
      if (j.configGate) { setGate({ kind: 'config', text: j.configGate }); setPhase('idle'); return; }
      if (!j.ok) { setError(j.error || 'Classification failed.'); setPhase('idle'); return; }
      if (j.clarify) { setClarify(j.clarify); setPhase('idle'); return; }
      setCls(j); setPhase('awaiting');
    } catch (e: any) {
      setError(e?.message || String(e)); setPhase('idle');
    }
  }, []);

  const execute = useCallback(async () => {
    if (!cls?.intentionId) return;
    setPhase('executing'); setError(null);
    try {
      const r = await fetch('/api/admin/ops-copilot/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intentionId: cls.intentionId }),
      });
      const j = await r.json();
      if (r.status === 403 && j.roleGate) { setGate({ kind: 'role', text: j.roleGate }); setPhase('awaiting'); return; }
      if (j.configGate) { setGate({ kind: 'config', text: j.configGate }); setPhase('awaiting'); return; }
      if (!j.ok) { setError(j.error || 'Execution failed.'); setPhase('awaiting'); return; }
      setDone(j.detail || 'Done.'); setPhase('done');
    } catch (e: any) {
      setError(e?.message || String(e)); setPhase('awaiting');
    }
  }, [cls]);

  return (
    <div className={s.root}>
      <Body1 style={{ color: tokens.colorNeutralForeground2 }}>
        Describe an operation — scale a SQL pool or the ADX cluster, toggle the
        Synapse outbound-access policy, or create a workspace. Loom proposes the
        exact change; you approve the before/after diff before anything runs.
      </Body1>

      {phase !== 'awaiting' && phase !== 'executing' && phase !== 'done' && (
        <>
          <div className={s.inputRow}>
            <Textarea
              value={prompt}
              onChange={(_, d) => setPrompt(d.value)}
              placeholder="e.g. Scale the SQL pool to DW200c"
              resize="vertical"
              style={{ flex: 1 }}
              disabled={phase === 'classifying'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) classify(prompt); }}
            />
            <Button
              appearance="primary"
              icon={phase === 'classifying' ? <Spinner size="tiny" /> : <Send16Regular />}
              disabled={!prompt.trim() || phase === 'classifying'}
              onClick={() => classify(prompt)}
            >
              {phase === 'classifying' ? 'Reading…' : 'Propose'}
            </Button>
          </div>
          <div className={s.examples}>
            {EXAMPLES.map((ex) => (
              <Badge key={ex} appearance="outline" color="brand" className={s.chip}
                onClick={() => { setPrompt(ex); classify(ex); }}>
                <Sparkle20Regular style={{ width: 12, height: 12, marginInlineEnd: 4 }} />{ex}
              </Badge>
            ))}
          </div>
        </>
      )}

      {clarify && (
        <MessageBar intent="info">
          <MessageBarBody><MessageBarTitle>Need a bit more</MessageBarTitle>{clarify}</MessageBarBody>
        </MessageBar>
      )}

      {gate?.kind === 'rbac' && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Ops Admin role required</MessageBarTitle>{gate.text}</MessageBarBody>
        </MessageBar>
      )}
      {gate?.kind === 'config' && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Resource not configured</MessageBarTitle>{gate.text}</MessageBarBody>
        </MessageBar>
      )}
      {gate?.kind === 'role' && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Azure role required</MessageBarTitle>{gate.text}</MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {(phase === 'awaiting' || phase === 'executing') && cls && (
        <div className={s.card}>
          <div className={s.head}>
            <Subtitle2>Review &amp; approve</Subtitle2>
            <Badge appearance="tint" color="brand">{cls.intention?.action}</Badge>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>{cls.diffSummary}</Caption1>

          {cls.diff && cls.diff.length > 0 && (
            <div className={s.diffGrid}>
              {cls.diff.map((row) => (
                <div key={row.label} style={{ display: 'contents' }}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{row.label}</Caption1>
                  <Caption1 className={s.before}>{row.before}</Caption1>
                  <ArrowRight16Regular style={{ color: tokens.colorNeutralForeground3 }} />
                  <Caption1 className={s.after}>{row.after}</Caption1>
                </div>
              ))}
            </div>
          )}

          <div className={s.actions}>
            <Button
              appearance="primary"
              icon={phase === 'executing' ? <Spinner size="tiny" /> : <Checkmark16Regular />}
              disabled={phase === 'executing'}
              onClick={execute}
            >
              {phase === 'executing' ? 'Executing…' : 'Confirm & run'}
            </Button>
            <Button
              appearance="subtle"
              icon={<Dismiss16Regular />}
              disabled={phase === 'executing'}
              onClick={() => reset()}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === 'done' && done && (
        <>
          <MessageBar intent="success">
            <MessageBarBody><MessageBarTitle>Done</MessageBarTitle>{done}</MessageBarBody>
          </MessageBar>
          <div>
            <Button appearance="secondary" onClick={() => reset()}>New action</Button>
          </div>
        </>
      )}
    </div>
  );
}
