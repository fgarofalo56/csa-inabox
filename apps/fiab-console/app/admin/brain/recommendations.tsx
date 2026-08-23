'use client';

/**
 * LOOM BRAIN VISUALIZER — the recommendations list.
 *
 * Ranked by DERIVED saving, each with its evidence chain and a proposal a human
 * can approve. Approval records a decision; it does not perform one.
 *
 * ── EVERY CONTROL ON THIS SURFACE IS INERT WITH RESPECT TO AZURE ───────────
 * There are exactly three actions: Approve, Dismiss, Copy. The first two POST
 * to `/api/admin/brain/proposals`, which writes an audit record and nothing
 * else. The third writes to the clipboard. There is no "Apply", no "Fix it",
 * no "Scale to zero" — and their absence is asserted, not assumed:
 * `__tests__/ui/no-mutation-controls.test.tsx` enumerates every rendered
 * button/link on the surface and fails on any label matching a mutation verb,
 * so adding one later trips a test rather than passing review on a glance.
 *
 * PRP §1 decision 1 is why. Of the Container App environments visible across
 * these subscriptions, most are NOT Loom's — an autonomous mutation on a wrong
 * ownership inference destroys someone else's production. That is a measured
 * blast radius, not a caution.
 *
 * ── WHY AN UNAPPROVABLE RECOMMENDATION IS STILL SHOWN ──────────────────────
 * When ownership is not established the proposal is withheld but the FINDING is
 * still rendered, with an explicit reason. PRP §1 decision 4 splits these
 * deliberately: reports cover all subscriptions, cleanup recommendations are
 * scoped by ownership. Hiding the finding would trade one dishonesty for
 * another — the operator would see a clean list over an estate that is not.
 *
 * ── COST IS ALWAYS RENDERED THROUGH ITS LABEL ──────────────────────────────
 * `costLabel` is produced server-side by `formatCostFigure`, which always
 * appends "DERIVED estimate — not a bill". Nothing here formats `amountUsd`
 * itself. The ranking uses the number; the display never shows it bare.
 */

import * as React from 'react';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Card,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Subtitle2,
  Textarea,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircle20Regular,
  Copy20Regular,
  DismissCircle20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import type { ProposalDecision, WireFinding } from '@/app/api/admin/brain/_lib/wire';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    ':hover': { boxShadow: tokens.shadow16 },
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
  },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    alignItems: 'center',
  },
  pre: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    minWidth: 0,
    margin: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  note: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
});

export interface RecommendationsProps {
  readonly findings: readonly WireFinding[];
  readonly onFocusNode: (id: string) => void;
  /** Injected so the test can drive review without a network. */
  readonly submitDecision?: (
    findingId: string,
    decision: ProposalDecision,
    note: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

async function postDecision(
  findingId: string,
  decision: ProposalDecision,
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/admin/brain/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ findingId, decision, note }),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
  return { ok: true };
}

export function Recommendations({ findings, onFocusNode, submitDecision }: RecommendationsProps) {
  const s = useStyles();
  const submit = submitDecision ?? postDecision;

  const totalDerived = findings.reduce((acc, f) => acc + (f.cost?.amountUsd ?? 0), 0);
  const priced = findings.filter((f) => f.cost).length;
  const approvable = findings.filter((f) => f.ownershipConfirmed).length;

  if (findings.length === 0) {
    return (
      <EmptyState
        title="No findings in this snapshot"
        body={
          'No detector produced a finding over the estate that was read. Check the Coverage panel ' +
          'before reading that as a clean estate: a detector that declined because its data was ' +
          'never collected also reports zero.'
        }
      />
    );
  }

  return (
    <div className={s.root} data-testid="recommendations">
      <Subtitle2>Recommendations ({findings.length})</Subtitle2>

      <MessageBar intent="info" data-testid="recommend-only-banner">
        <MessageBarBody>
          <MessageBarTitle>Recommend-only.</MessageBarTitle>
          Nothing on this page changes anything in Azure. Approving records that a person agreed
          with the recommendation; the change itself is a repository edit you make. {priced} of{' '}
          {findings.length} finding(s) carry a derived cost estimate totalling roughly $
          {totalDerived.toFixed(2)} per 30 days — a DERIVED figure from measured SKU x published
          retail rate, never a bill (the Cost Management API returned HTTP 429 on 11 consecutive
          attempts). {approvable} of {findings.length} have established ownership and can be
          approved.
        </MessageBarBody>
      </MessageBar>

      {findings.map((f) => (
        <FindingCard key={f.id} finding={f} onFocusNode={onFocusNode} submit={submit} />
      ))}
    </div>
  );
}

function FindingCard({
  finding,
  onFocusNode,
  submit,
}: {
  finding: WireFinding;
  onFocusNode: (id: string) => void;
  submit: (id: string, d: ProposalDecision, note: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const s = useStyles();
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<{ decision: ProposalDecision } | { error: string } | null>(
    null,
  );
  const [copied, setCopied] = React.useState(false);

  const decide = React.useCallback(
    async (decision: ProposalDecision) => {
      setBusy(true);
      try {
        const r = await submit(finding.id, decision, note);
        setOutcome(r.ok ? { decision } : { error: r.error ?? 'failed' });
      } finally {
        setBusy(false);
      }
    },
    [finding.id, note, submit],
  );

  const copy = React.useCallback(() => {
    void navigator.clipboard
      ?.writeText(finding.remediation.proposedChange)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [finding.remediation.proposedChange]);

  return (
    <Card className={s.card} data-testid="finding-card" data-finding-id={finding.id}>
      <div className={s.badges}>
        <Badge
          appearance="filled"
          color={
            finding.severity === 'critical' || finding.severity === 'high'
              ? 'danger'
              : finding.severity === 'medium'
                ? 'warning'
                : 'informative'
          }
        >
          {finding.severity}
        </Badge>
        <Badge appearance="outline">{finding.detector}</Badge>
        <Badge appearance="outline">confidence: {finding.confidence}</Badge>
        {finding.costLabel ? (
          <Badge appearance="tint" color="warning" data-cost-source={finding.cost?.source}>
            {finding.costLabel}
          </Badge>
        ) : (
          // NOT "$0". An unpriced finding is unpriced.
          <Badge appearance="tint" color="subtle" data-cost-source="none">
            no cost derived
          </Badge>
        )}
        {finding.ownershipConfirmed ? (
          <Badge appearance="tint" color="success">ownership established</Badge>
        ) : (
          <Badge appearance="tint" color="danger" data-testid="ownership-withheld">
            ownership NOT established
          </Badge>
        )}
      </div>

      <Body1Strong>{finding.title}</Body1Strong>
      <Body1>{finding.summary}</Body1>

      <div className={s.actions}>
        {finding.subjects.map((id) => (
          <Button
            key={id}
            size="small"
            appearance="subtle"
            onClick={() => onFocusNode(id)}
            data-testid="focus-node"
          >
            Show on graph
          </Button>
        ))}
      </div>

      <Accordion collapsible>
        <AccordionItem value="evidence">
          <AccordionHeader>Evidence ({finding.evidence.notes.length} established fact(s))</AccordionHeader>
          <AccordionPanel>
            <Caption1 className={s.note}>Query</Caption1>
            <pre className={s.pre}>{finding.evidence.query}</pre>
            <Caption1 className={s.note}>What the code established</Caption1>
            <ul>
              {finding.evidence.notes.map((n, i) => (
                <li key={i}>
                  <Caption1 className={s.note}>{n}</Caption1>
                </li>
              ))}
            </ul>
            <Caption1 className={s.note}>
              Population examined: {finding.population.scope}
              {finding.population.blind && ' — BLIND: the examined set was empty.'}
            </Caption1>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="proposal">
          <AccordionHeader>Proposed change (not applied)</AccordionHeader>
          <AccordionPanel>
            <Body1>{finding.remediation.summary}</Body1>
            <pre className={s.pre} data-testid="proposed-change">
              {finding.remediation.proposedChange}
            </pre>
            <Caption1 className={s.note}>
              requiresHumanApproval={String(finding.remediation.requiresHumanApproval)} ·
              mutatesAzure={String(finding.remediation.mutatesAzure)} — both are literal types in
              the Brain&apos;s contract, so a self-approving or self-applying proposal is not
              constructible.
            </Caption1>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      {finding.ownershipConfirmed ? (
        <>
          <Textarea
            size="small"
            placeholder="Why? (recorded verbatim in the audit trail)"
            value={note}
            onChange={(_, d) => setNote(d.value)}
            aria-label="Review note"
          />
          <div className={s.actions}>
            <Button
              appearance="primary"
              size="small"
              icon={<CheckmarkCircle20Regular />}
              disabled={busy || outcome !== null}
              onClick={() => void decide('approved')}
              data-testid="approve"
            >
              Approve recommendation
            </Button>
            <Button
              appearance="secondary"
              size="small"
              icon={<DismissCircle20Regular />}
              disabled={busy || outcome !== null}
              onClick={() => void decide('dismissed')}
              data-testid="dismiss"
            >
              Dismiss
            </Button>
            <Tooltip content="Copy the proposed change to the clipboard" relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={<Copy20Regular />}
                onClick={copy}
                data-testid="copy-proposal"
              >
                {copied ? 'Copied' : 'Copy change'}
              </Button>
            </Tooltip>
            <Caption1 className={s.note}>
              Approving records a decision. It does not scale, delete or modify anything.
            </Caption1>
          </div>
        </>
      ) : (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Reported, not approvable.</MessageBarTitle>
            No ownership edge covers this resource, so the Brain cannot prove it belongs to this
            Loom estate. The finding stands; the proposal is withheld. Stamp the estate ownership
            tag in the deploy and this becomes approvable.
          </MessageBarBody>
        </MessageBar>
      )}

      {outcome !== null && 'decision' in outcome && (
        <MessageBar intent="success" data-testid="decision-recorded">
          <MessageBarBody>
            Recorded as <strong>{outcome.decision}</strong>. Nothing in Azure was changed.
          </MessageBarBody>
        </MessageBar>
      )}
      {outcome !== null && 'error' in outcome && (
        <MessageBar intent="error" data-testid="decision-failed">
          <MessageBarBody>Could not record the decision: {outcome.error}</MessageBarBody>
        </MessageBar>
      )}
    </Card>
  );
}
