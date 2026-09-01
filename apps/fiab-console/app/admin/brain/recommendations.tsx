'use client';

/**
 * LOOM BRAIN VISUALIZER — the recommendations list.
 *
 * Ranked by DERIVED saving, each with its evidence chain, a proposal a human
 * can approve — and, for the classes the SERVER says the platform can execute,
 * a guarded Perform action (#4242).
 *
 * ── WHAT CHANGED IN #4242, AND WHAT DID NOT ────────────────────────────────
 * Review still records a decision and performs nothing: Approve / Dismiss POST
 * to `/api/admin/brain/proposals`, which writes a decision record. Execution is
 * a SEPARATE capability behind a SEPARATE route — `POST /api/admin/brain/perform`
 * — whose executors live outside `lib/brain` entirely (`lib/brain-actions/**`),
 * behind a guard chain re-derived server-side at execute time and, for every
 * phase-1 class, a staged two-step confirm. The Brain's four-layer inertness
 * contract is untouched: `RemediationProposal` still pins `mutatesAzure: false`
 * as a literal type, `assertInertRemediation` still rejects actuator keys, and a
 * FINDING still cannot be an action. Performing is a separate record about one.
 *
 * This file therefore decides NOTHING about performability. It renders the
 * server's registry verdict: a Perform control where the server says an executor
 * exists, and the server's own honest reason where it does not — never a
 * disabled button with no explanation (`ux-baseline.md` G2).
 *
 * ── WHY THE HEADER BANNER IS DERIVED, NOT WRITTEN ──────────────────────────
 * "Nothing on this page changes anything in Azure" was a standing claim. It is
 * now COMPUTED from what this render actually offers: it is stated only while
 * the surface carries no Perform control (registry unread, or nothing in a
 * performable class), and replaced by the truth when it does. A hard-coded
 * version of either sentence would be false half the time, which is exactly the
 * R7 failure `deploy-integrity.md` names. `__tests__/perform-ui.test.tsx` holds
 * both directions.
 *
 * PRP §1 decision 1 is still why the guards are as heavy as they are. Of the
 * Container App environments visible across these subscriptions, most are NOT
 * Loom's — an autonomous mutation on a wrong ownership inference destroys
 * someone else's production. That is a measured blast radius, not a caution.
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
  Text,
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
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import type { ProposalDecision, WireFinding } from '@/app/api/admin/brain/_lib/wire';
import type { RecommendationStateRecord } from '@/lib/brain-actions/types';
import {
  PerformControls,
  PerformStateDisclosure,
  PersistedStateBanner,
  RECOMMEND_ONLY_SENTENCE,
  fetchPerformState,
  performableCount,
  postPerform,
  recordsByFinding,
  type PerformOutcomeResult,
  type PerformRequestBody,
  type PerformStateResult,
} from './perform-actions';

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
  // The cost basis: a paragraph, so it WRAPS. `minWidth: 0` + `overflowWrap`
  // keep it inside its flex parent at every width — the badge it came out of
  // had neither, which is how ~650 characters ended up painted across the
  // rows above and below it on the live console.
  costBasis: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
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
  /**
   * The perform read-back (#4242): recorded per-finding states + the server's
   * performability registry. Production passes nothing and the real BFF is
   * used; a spec injects a resolved result so a render assertion never depends
   * on a network stub returning a different shape (the seam `submitDecision`
   * already established on this component).
   */
  readonly loadPerformState?: () => Promise<PerformStateResult>;
  /** Injected so a spec can drive stage → confirm without a network. */
  readonly performRecommendation?: (body: PerformRequestBody) => Promise<PerformOutcomeResult>;
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

/**
 * Split a server-rendered cost label into the part a BADGE can hold and the
 * part it cannot.
 *
 * ── WHY THIS EXISTS (measured live, 2026-09-01) ────────────────────────────
 * `formatCostFigure` returns `"$46.66 (DERIVED estimate — not a bill; <basis>)"`
 * and `basis` is a full pricing methodology — on the live estate, ~650
 * characters naming the meters, the retail-rate source, the excluded free
 * grant, and the scale-fact provenance. That whole string was being passed as
 * the children of a Fluent `Badge`, which is a FIXED-HEIGHT (20px) chip with
 * `overflow: visible`. Measured on the live console: the badge's box stayed
 * 20px tall while its text laid out 1330px wide, painting straight over the
 * badge row above it and the "ownership NOT established" badge below. The
 * operator's report was "loom brain is not readeable" and THIS was the worst
 * instance of it — invisible to jsdom (no layout) and to the code-reading
 * audit that produced the other ten fixes, because the fixtures carry short
 * bases and only real estate data is long enough to overflow.
 *
 * The split is deliberate about WHAT stays in the badge: the amount and the
 * provenance marker. `DERIVED_MARKER` is a load-bearing contract — a derived
 * estimate must never read as a bill — so it must remain visible at a glance,
 * never demoted into a tooltip. The basis is reference detail and moves to
 * wrapping body text beneath the row, where a paragraph belongs. Nothing is
 * hidden: the full label still renders, and it stays selectable and readable
 * by assistive tech (a tooltip-only treatment would fail both).
 */
export function splitCostLabel(label: string): { chip: string; basis: string } {
  const open = label.indexOf('(');
  const semi = label.indexOf(';', open);
  if (open === -1 || semi === -1 || !label.endsWith(')')) {
    // Shape we do not recognise: keep it whole rather than guess at a split.
    return { chip: label, basis: '' };
  }
  return {
    chip: `${label.slice(0, semi)})`,
    basis: label.slice(semi + 1, -1).trim(),
  };
}

/**
 * The cost-provenance clause, DERIVED from the snapshot's own `CostFigure.source`
 * values — never a baked literal. The previous banner hard-coded a stale
 * 2026-08-23 measurement ("HTTP 429 on 11 consecutive attempts") as standing
 * fact, which is exactly the R7 error `deploy-integrity.md` forbids: a claim
 * about a past run rendered as the present tense of every future one.
 */
export function costSourceClause(findings: readonly WireFinding[]): string {
  const sources = [...new Set(findings.flatMap((f) => (f.cost ? [f.cost.source] : [])))].sort();
  if (sources.length === 0) return '';
  if (sources.length === 2) {
    return 'figures mix DERIVED estimates (measured SKU × published retail rate) and Cost Management billing-export data';
  }
  return sources[0] === 'derived'
    ? 'every figure is DERIVED (measured SKU × published retail rate), not a bill'
    : 'every figure comes from a Cost Management billing export';
}

export function Recommendations({
  findings,
  onFocusNode,
  submitDecision,
  loadPerformState,
  performRecommendation,
}: RecommendationsProps) {
  const s = useStyles();
  const submit = submitDecision ?? postDecision;
  const load = loadPerformState ?? fetchPerformState;
  const perform = performRecommendation ?? postPerform;

  // `null` is "not answered yet" and is NOT the same as "nothing performable" —
  // the banner and the per-card controls both distinguish them.
  const [performState, setPerformState] = React.useState<PerformStateResult | null>(null);
  const [reloadTick, setReloadTick] = React.useState(0);

  // The loader is held in a ref, and the effect depends on the tick alone. A
  // caller passing an inline arrow would otherwise give the effect a new
  // identity on every render and re-fetch forever.
  const loadRef = React.useRef(load);
  loadRef.current = load;

  React.useEffect(() => {
    let live = true;
    void (async () => {
      // `fetchPerformState` is written to RESOLVE rather than reject (a
      // transport failure is an `unavailable` result), but an injected loader
      // is not bound by that, so a rejection still becomes a rendered
      // disclosure — never an unhandled rejection, and never a silently
      // missing Perform action.
      try {
        const r = await loadRef.current();
        if (live) setPerformState(r);
      } catch (e) {
        if (live) {
          setPerformState({
            kind: 'unavailable',
            reason: `the read threw (${e instanceof Error ? e.message : String(e)}).`,
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [reloadTick]);

  const records = recordsByFinding(performState);
  const performable = performableCount(findings, performState);

  const totalDerived = findings.reduce((acc, f) => acc + (f.cost?.amountUsd ?? 0), 0);
  const priced = findings.filter((f) => f.cost).length;
  const approvable = findings.filter((f) => f.ownershipConfirmed).length;
  const costClause = costSourceClause(findings);

  if (findings.length === 0) {
    return (
      <EmptyState
        title="No findings in this snapshot"
        body={
          'No detector produced a finding. Before reading that as a clean estate, check ' +
          'Coverage — a detector whose data was never collected also reports zero.'
        }
      />
    );
  }

  return (
    <div className={s.root} data-testid="recommendations">
      <Subtitle2>Recommendations ({findings.length})</Subtitle2>

      {/* DERIVED, never asserted. `performable` counts the findings this render
          actually offers a Perform control for, so the two sentences below can
          never be false about the surface the operator is looking at. */}
      <MessageBar intent="info" data-testid="recommend-only-banner" data-performable={performable}>
        <MessageBarBody>
          <MessageBarTitle>
            {performable > 0 ? 'Review, or perform.' : 'Recommend-only.'}
          </MessageBarTitle>
          {performable > 0 ? (
            <>
              {performable} of {findings.length} finding(s) are in a class the platform can execute
              itself, behind a staged two-step confirm — performing one is a REAL change to Azure
              with a real before/after receipt. Every other finding is recommend-only: approving
              records a decision; the change itself is a repository edit you make.{' '}
            </>
          ) : (
            <>
              {RECOMMEND_ONLY_SENTENCE} — approving records a decision; the change itself is a
              repository edit you make.{' '}
              {performState === null
                ? 'Checking which findings the platform can execute itself… '
                : performState.kind === 'ready'
                  ? 'No finding in this snapshot is in a class the platform can execute itself. '
                  : ''}
            </>
          )}
          {priced > 0 && (
            <>
              {priced} of {findings.length} finding(s) are priced at roughly $
              {totalDerived.toFixed(2)} per 30 days ({costClause}).{' '}
            </>
          )}
          {approvable} of {findings.length} can be approved (ownership established).{' '}
          <LearnPopover
            title="Recommendations"
            content={
              'Each card is a detector finding over the estate snapshot: its severity, the ' +
              'evidence chain that established it, and a proposed change a person can approve. ' +
              'Cost figures always carry their provenance — a DERIVED figure is a measured SKU ' +
              'multiplied by a published retail rate, never a bill. Proposals are withheld until ' +
              "the resource's ownership is established by the estate tag."
            }
          />
        </MessageBarBody>
      </MessageBar>

      <PerformStateDisclosure state={performState} onRetry={() => setReloadTick((t) => t + 1)} />

      {findings.map((f) => {
        const record: RecommendationStateRecord | undefined = records.get(f.id);
        return (
          <FindingCard
            key={f.id}
            finding={f}
            onFocusNode={onFocusNode}
            submit={submit}
            performState={performState}
            perform={perform}
            {...(record ? { record } : {})}
          />
        );
      })}
    </div>
  );
}

function FindingCard({
  finding,
  onFocusNode,
  submit,
  performState,
  perform,
  record,
}: {
  finding: WireFinding;
  onFocusNode: (id: string) => void;
  submit: (id: string, d: ProposalDecision, note: string) => Promise<{ ok: boolean; error?: string }>;
  performState: PerformStateResult | null;
  perform: (body: PerformRequestBody) => Promise<PerformOutcomeResult>;
  record?: RecommendationStateRecord;
}) {
  const s = useStyles();
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  // A PERSISTED decision seeds this, so a reload no longer forgets that a human
  // already reviewed the finding (the decision-amnesia the #4242 store cures).
  const persistedDecision: ProposalDecision | null =
    record?.state === 'approved' || record?.state === 'dismissed' ? record.state : null;
  const [outcome, setOutcome] = React.useState<{ decision: ProposalDecision } | { error: string } | null>(
    null,
  );
  const decided = outcome ?? (persistedDecision ? { decision: persistedDecision } : null);
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
      {/* WHAT the Brain recommends leads the card; the meta badges follow it
          (#4241 defect 10). A five-badge row above the title buried the one
          thing the operator opened this tab to read. */}
      <Body1Strong>{finding.title}</Body1Strong>
      <Body1>{finding.summary}</Body1>

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
          // Only the amount + provenance marker rides in the chip; the basis
          // renders as body text below the row (see `splitCostLabel`).
          <Badge appearance="tint" color="warning" data-cost-source={finding.cost?.source}>
            {splitCostLabel(finding.costLabel).chip}
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

      {finding.costLabel && splitCostLabel(finding.costLabel).basis ? (
        // The pricing methodology, as WRAPPING body text. It is reference
        // detail, so it reads at caption scale — but it is never truncated and
        // never tooltip-only: how a figure was derived is the claim's evidence.
        <Text className={s.costBasis} data-testid="cost-basis">
          {splitCostLabel(finding.costLabel).basis}
        </Text>
      ) : null}

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

      {/* The PROPOSAL is open by default — the actual proposed change is the
          substance of the card, not a drawer to hunt for (#4241 defect 10).
          Evidence stays collapsed until asked for. */}
      <Accordion collapsible defaultOpenItems="proposal">
        <AccordionItem value="proposal">
          <AccordionHeader>Proposed change (not applied)</AccordionHeader>
          <AccordionPanel>
            <Body1>{finding.remediation.summary}</Body1>
            <pre className={s.pre} data-testid="proposed-change">
              {finding.remediation.proposedChange}
            </pre>
            <Caption1>
              requiresHumanApproval={String(finding.remediation.requiresHumanApproval)} ·
              mutatesAzure={String(finding.remediation.mutatesAzure)} — pinned as literal types in
              the Brain&apos;s contract.
            </Caption1>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="evidence">
          <AccordionHeader>Evidence ({finding.evidence.notes.length} established fact(s))</AccordionHeader>
          <AccordionPanel>
            <Caption1 className={s.note}>Query</Caption1>
            <pre className={s.pre}>{finding.evidence.query}</pre>
            <Caption1 className={s.note}>What the code established</Caption1>
            <ul>
              {/* The established facts are the substance — reading size,
                  default foreground; only the labels stay Caption1 (#4241
                  defect 1). */}
              {finding.evidence.notes.map((n, i) => (
                <li key={i}>
                  <Body1>{n}</Body1>
                </li>
              ))}
            </ul>
            <Body1>
              Population examined: {finding.population.scope}
              {finding.population.blind && ' — BLIND: the examined set was empty.'}
            </Body1>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      {/* WHAT THE STORE REMEMBERS. Rendered from the persisted record, so a
          reload shows the decision, the receipt or the real error — the
          decision-amnesia #4242's state store exists to cure. */}
      {record ? <PersistedStateBanner record={record} /> : null}

      {/* THE PERFORM HALF. It decides nothing: performability, the executor
          kind and every refusal reason come from the server's registry and its
          guard chain. */}
      <PerformControls
        findingId={finding.id}
        detector={finding.detector}
        subjects={finding.subjects}
        ownershipConfirmed={finding.ownershipConfirmed}
        state={performState}
        perform={perform}
        {...(record ? { record } : {})}
      />

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
              disabled={busy || decided !== null}
              onClick={() => void decide('approved')}
              data-testid="approve"
            >
              Approve recommendation
            </Button>
            <Button
              appearance="secondary"
              size="small"
              icon={<DismissCircle20Regular />}
              disabled={busy || decided !== null}
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
            <Caption1>
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

      {decided !== null && 'decision' in decided && (
        <MessageBar intent="success" data-testid="decision-recorded">
          <MessageBarBody>
            Recorded as <strong>{decided.decision}</strong>. Nothing in Azure was changed.
          </MessageBarBody>
        </MessageBar>
      )}
      {decided !== null && 'error' in decided && (
        <MessageBar intent="error" data-testid="decision-failed">
          <MessageBarBody>Could not record the decision: {decided.error}</MessageBarBody>
        </MessageBar>
      )}
    </Card>
  );
}
