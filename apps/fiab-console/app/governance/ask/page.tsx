'use client';

/**
 * /governance/ask — B-N14b: the natural-language GOVERNANCE copilot.
 *
 * "Who can read PII in EU?" answered over THIS deployment's real authorization
 * and governance facts — the entitlement ledger, live workspace ACLs, the tenant
 * governance policy document, the ODCS data-contract registry's authored column
 * classifications, and the Purview built-in classification catalog — retrieved
 * as a POLICY GRAPH with the N11 GraphRAG primitives.
 *
 * Two things make this an audit artifact rather than a chatbot:
 *   • EVERY answer lists the policy PATHS it rests on. Each path is a real edge
 *     chain (`Alice (principal) —[HOLDS]→ Reader (grant) —[GRANTS]→ Orders …`).
 *   • The copilot REFUSES when the graph cannot support a claim, and says which
 *     evidence is missing — it never fills the gap with a plausible guess.
 *
 * Fluent v9 + Loom tokens only (web3-ui.md); GovernanceShell chrome so it sits
 * inside the Purview-mirroring governance rail like every sibling surface.
 */

import { useCallback, useState } from 'react';
import {
  Badge, Body1, Body1Strong, Button, Caption1, Divider, Spinner, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ChatSparkle24Regular, Flowchart16Regular, ShieldQuestion20Regular,
  Send16Regular, Warning16Regular, DatabaseStack16Regular,
} from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Section } from '@/lib/components/ui/section';
import { EmptyState } from '@/lib/components/empty-state';
import { clientFetch } from '@/lib/client-fetch';

/** Mirrors `GraphPathCitation` — the shared N11 citation shape. */
interface PathCitation {
  id?: string;
  hops: number;
  text: string;
}

/** Mirrors `GovernanceAnswer` from lib/governance/nl-governance-copilot.ts. */
interface GovernanceAnswer {
  question: string;
  answer: string;
  refused: boolean;
  refusalReason?: string;
  note?: string;
  citations: PathCitation[];
  kindsTouched: string[];
  graphSize: number;
  scanned: number;
  unavailable: Array<{ source: string; reason: string }>;
  gate?: { code: string; error: string; hint: string };
  durationMs: number;
  graphMs: number;
}

/** Starter questions — every one answerable from the policy graph's own edges. */
const EXAMPLES: readonly string[] = [
  'Who can read PII in EU?',
  'Which contracted columns are classified as financial data?',
  'What policies apply to the customers dataset?',
  'Which principals hold a write grant on a governed asset?',
  'Which assets carry a credential or secret classification?',
];

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  askRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  actions: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS,
    alignItems: 'center', minWidth: 0,
  },
  chips: {
    display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS,
    alignItems: 'center', minWidth: 0,
  },
  answer: {
    whiteSpace: 'pre-wrap',
    color: tokens.colorNeutralForeground1,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  pathList: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    margin: 0, paddingLeft: tokens.spacingHorizontalL, minWidth: 0,
  },
  path: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
  meta: { color: tokens.colorNeutralForeground3 },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
});

export default function GovernanceAskPage() {
  const s = useStyles();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GovernanceAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await clientFetch('/api/governance/copilot/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      const j = await res.json();
      if (!j?.ok) {
        setError(j?.error || `The governance copilot request failed (${res.status}).`);
        return;
      }
      setResult(j as GovernanceAnswer);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <GovernanceShell
      sectionTitle="Governance Q&A"
      sectionBadge="Preview"
      explainer="Ask about access, sensitivity, policies, and residency — answered from this deployment's own governance facts, with the policy edges cited."
    >
      <div className={s.stack}>
        <Section title="Ask a governance question">
          <Body1 className={s.intro}>
            Questions are answered from a policy graph assembled out of the entitlement ledger, live
            workspace ACLs, the tenant policy document, the ODCS data-contract registry, and the
            Purview built-in classification catalog. Every answer cites the policy paths it rests on,
            and the copilot refuses rather than guess when the graph cannot support a claim.
          </Body1>
          <div className={s.askRow}>
            <Textarea
              value={question}
              onChange={(_, d) => setQuestion(d.value)}
              placeholder="e.g. Who can read PII in EU?"
              resize="vertical"
              disabled={busy}
              aria-label="Governance question"
            />
            <div className={s.actions}>
              <Button
                appearance="primary"
                icon={busy ? <Spinner size="tiny" /> : <Send16Regular />}
                disabled={busy || !question.trim()}
                onClick={() => ask(question)}
              >
                Ask
              </Button>
              <Caption1 className={s.meta}>Read-only — this never changes a grant or a policy.</Caption1>
            </div>
            <div className={s.chips}>
              <Caption1 className={s.meta}>Try:</Caption1>
              {EXAMPLES.map((ex) => (
                <Button
                  key={ex}
                  size="small"
                  appearance="outline"
                  disabled={busy}
                  onClick={() => { setQuestion(ex); void ask(ex); }}
                >
                  {ex}
                </Button>
              ))}
            </div>
          </div>
        </Section>

        {error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>The question could not be answered</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        )}

        {!result && !error && !busy && (
          <Section bare>
            <EmptyState
              icon={<ChatSparkle24Regular />}
              title="Ask your first governance question"
              body="Pick one of the examples above, or ask about who can reach a dataset, which columns carry a sensitivity classification, or which policies govern an asset. Answers are grounded in this deployment's real grants and contracts — never in generic guidance."
            />
          </Section>
        )}

        {result && (
          <Section
            title={result.refused ? 'Refused — insufficient evidence' : 'Answer'}
            actions={
              <div className={s.chips}>
                <Badge appearance="tint" color={result.refused ? 'warning' : 'success'}>
                  {result.refused ? 'Refused' : 'Answered'}
                </Badge>
                <Badge appearance="outline" color="informative" icon={<Flowchart16Regular />}>
                  {result.citations.length} cited path{result.citations.length === 1 ? '' : 's'}
                </Badge>
                <Badge appearance="outline" color="informative" icon={<DatabaseStack16Regular />}>
                  {result.graphSize.toLocaleString()} policy node{result.graphSize === 1 ? '' : 's'}
                </Badge>
              </div>
            }
          >
            <div className={s.stack}>
              {result.gate && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>Azure OpenAI is not wired in this deployment</MessageBarTitle>
                    {result.gate.hint} The retrieved policy paths below are still the real evidence
                    for this question — they are just not narrated.
                  </MessageBarBody>
                </MessageBar>
              )}

              {result.unavailable.length > 0 && (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>This answer is based on incomplete governance data</MessageBarTitle>
                    {result.unavailable.map((u) => `${u.source}: ${u.reason}`).join(' · ')}
                  </MessageBarBody>
                </MessageBar>
              )}

              {result.refused ? (
                <MessageBar intent="info" layout="multiline" icon={<Warning16Regular />}>
                  <MessageBarBody>
                    <MessageBarTitle>The policy graph cannot support an answer</MessageBarTitle>
                    {result.note || 'No supporting evidence was found.'}
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <div className={s.answer}>{result.answer}</div>
              )}

              {result.citations.length > 0 && (
                <>
                  <Divider />
                  <Body1Strong>
                    <ShieldQuestion20Regular aria-hidden /> Policy paths cited
                  </Body1Strong>
                  <ol className={s.pathList}>
                    {result.citations.map((c, i) => (
                      <li key={c.id || i} className={s.path}>
                        {c.text} <Caption1 className={s.meta}>({c.hops} hop{c.hops === 1 ? '' : 's'})</Caption1>
                      </li>
                    ))}
                  </ol>
                </>
              )}

              <Caption1 className={s.meta}>
                {result.scanned.toLocaleString()} policy node(s) scanned ·{' '}
                {result.kindsTouched.length ? `evidence kinds: ${result.kindsTouched.join(', ')} · ` : ''}
                graph {result.graphMs} ms · total {result.durationMs} ms
              </Caption1>
            </div>
          </Section>
        )}
      </div>
    </GovernanceShell>
  );
}
