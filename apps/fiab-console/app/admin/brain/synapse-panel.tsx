'use client';

/**
 * LOOM BRAIN — THE SYNAPSE INSPECTOR.
 *
 * Four lanes beside the canvas, one per synapse layer, each of which reports its
 * own POPULATION before it reports a count. That ordering is the design:
 *
 *   "0 risk findings"                 reads as a clean estate
 *   "0 risk findings over 0 examined" reads as what it is
 *
 * and this repo has six measured instances of the first reading being taken
 * (`lib/brain/security/population.ts`). So every lane below renders a
 * NOT-EVALUATED state as a first-class outcome with the reason attached, and no
 * lane can render a zero without the denominator next to it.
 *
 * ── EVERY CONTROL HERE IS INERT ────────────────────────────────────────────
 * There are exactly two: expand a finding, and focus a node on the canvas. There
 * is no Approve on this surface at all — deliberately. A security finding's
 * remediation is a `DraftedRemediation`, which is not the `RemediationProposal`
 * the review route records decisions against, and inventing an approval path for
 * a class of finding whose remediation is "change an authorization check" is
 * exactly what PRP §3.7 forbids: "a wrong autonomous fix to authz is worse than
 * the gap". The proposed commands render as text to read and copy.
 * `__tests__/ui/synapse-no-mutation.test.tsx` walks every rendered control and
 * fails on any mutation verb, and additionally fails if any control issues a
 * network call at all.
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
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Cut20Regular,
  Flash20Regular,
  Shield20Regular,
  Sparkle20Regular,
} from '@fluentui/react-icons';
import type { WireRiskFinding } from '@/app/api/admin/brain/_lib/synapse-wire';
import type { SynapseOverlay } from './synapse-model';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: 0,
    height: '100%',
    overflowY: 'auto',
    paddingRight: tokens.spacingHorizontalS,
  },
  lane: {
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
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    flexWrap: 'wrap',
  },
  // flexWrap + minWidth:0 + truncation on EVERY badge row — `ux-baseline.md`
  // treats overlap at any width as a defect, and a right-hand inspector is the
  // narrowest column on the page.
  badges: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    alignItems: 'center',
  },
  badge: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  note: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
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
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    alignItems: 'center',
  },
});

export interface SynapsePanelProps {
  readonly overlay: SynapseOverlay;
  /** True while the risk lane is still in flight. Distinct from "not evaluated". */
  readonly riskLoading: boolean;
  /** Non-null when the risk lane could not be FETCHED — distinct again from both. */
  readonly riskError: string | null;
  readonly onRetryRisk: () => void;
  readonly onFocusNode: (id: string) => void;
}

export function SynapsePanel({
  overlay,
  riskLoading,
  riskError,
  onRetryRisk,
  onFocusNode,
}: SynapsePanelProps) {
  const s = useStyles();
  const { prune, risk, hot, fresh } = overlay;

  return (
    <div className={s.root} data-testid="synapse-panel">
      {/* ── PRUNE ─────────────────────────────────────────────────────────── */}
      <Card className={s.lane} data-testid="lane-prune">
        <div className={s.head}>
          <Cut20Regular />
          <Subtitle2>Prune</Subtitle2>
        </div>
        {prune.evaluated ? (
          <>
            <div className={s.badges}>
              <Badge className={s.badge} appearance="filled" color="danger">
                {prune.costly} unreachable + billing
              </Badge>
              <Badge className={s.badge} appearance="tint" color="warning">
                {prune.idle} unreachable, scales to zero
              </Badge>
              <Badge className={s.badge} appearance="tint" color="subtle">
                {prune.unevaluated} not evaluable
              </Badge>
              <Badge className={s.badge} appearance="outline">
                over {prune.nodesExamined} node(s) in view
              </Badge>
            </div>
            <Body1>
              {prune.priced} of {prune.costly + prune.idle} prune candidate(s) carry a cost
              estimate, totalling roughly ${prune.derivedMonthlyUsd.toFixed(2)} per 30 days.
            </Body1>
            <Caption1 className={s.note} data-testid="prune-cost-provenance">
              DERIVED — a measured SKU multiplied by a published retail rate. NOT a bill. Node width
              on the canvas scales with this figure, so the widest node is the most expensive thing
              nothing is using.
            </Caption1>
          </>
        ) : (
          <MessageBar intent="warning" data-testid="prune-not-evaluated">
            <MessageBarBody>
              <MessageBarTitle>Prune was not evaluated.</MessageBarTitle>
              {prune.reason}
            </MessageBarBody>
          </MessageBar>
        )}
      </Card>

      {/* ── RISK ──────────────────────────────────────────────────────────── */}
      <Card className={s.lane} data-testid="lane-risk">
        <div className={s.head}>
          <Shield20Regular />
          <Subtitle2>Risk</Subtitle2>
        </div>

        {riskLoading && (
          <Body1 data-testid="risk-loading">Running the security detectors…</Body1>
        )}

        {!riskLoading && riskError !== null && (
          <MessageBar intent="error" data-testid="risk-error">
            <MessageBarBody>
              <MessageBarTitle>The risk lane could not be read.</MessageBarTitle>
              {riskError}
              <div>
                <Caption1>
                  NO risk verdict has been drawn. An empty lane here would look exactly like a clean
                  estate, which is the failure this message exists to prevent.
                </Caption1>
              </div>
              <Button appearance="primary" size="small" onClick={onRetryRisk}>
                Retry
              </Button>
            </MessageBarBody>
          </MessageBar>
        )}

        {!riskLoading && riskError === null && !risk.evaluated && (
          <MessageBar intent="warning" data-testid="risk-not-evaluated">
            <MessageBarBody>
              <MessageBarTitle>
                Risk was NOT evaluated — this is not a clean result.
              </MessageBarTitle>
              {risk.reason}
              <div className={s.badges}>
                <Badge className={s.badge} appearance="outline">
                  {risk.detectorsRegistered} detector(s) registered
                </Badge>
                <Badge className={s.badge} appearance="tint" color="warning">
                  0 examined
                </Badge>
              </div>
            </MessageBarBody>
          </MessageBar>
        )}

        {!riskLoading && riskError === null && risk.evaluated && (
          <>
            <div className={s.badges}>
              <Badge className={s.badge} appearance="filled" color="danger">
                {risk.findings.length} finding(s)
              </Badge>
              <Badge
                className={s.badge}
                appearance="tint"
                color={risk.candidates > 0 && risk.ratio >= 1 ? 'success' : 'danger'}
                data-testid="risk-coverage"
              >
                judged {risk.judged} of {risk.candidates}
              </Badge>
              <Badge className={s.badge} appearance="outline">
                {risk.detectorsRegistered} detector(s)
              </Badge>
              <Badge className={s.badge} appearance="outline">
                {risk.painted} painted on the graph
              </Badge>
            </div>

            {risk.incompleteDetectors.length > 0 && (
              <MessageBar intent="error" data-testid="risk-incomplete">
                <MessageBarBody>
                  <MessageBarTitle>A detector judged less than it enumerated.</MessageBarTitle>
                  {risk.incompleteDetectors.join(', ')} — a shrinking judged set is a P0 signal, not
                  a footnote. Measured precedent: a guard that found 15 candidates and judged 1
                  printed OK with a live defect in the tree.
                </MessageBarBody>
              </MessageBar>
            )}

            {risk.unjoined.length > 0 && (
              <MessageBar intent="info" data-testid="risk-unjoined">
                <MessageBarBody>
                  <MessageBarTitle>
                    {risk.unjoined.length} finding(s) are reported but not drawn.
                  </MessageBarTitle>
                  A security finding names SOURCE locations; the canvas draws Azure resources. The
                  two id spaces are disjoint until a producer mints a join, so these are listed
                  below rather than dropped.
                </MessageBarBody>
              </MessageBar>
            )}

            {risk.findings.map((f) => (
              <RiskFindingCard key={f.id} finding={f} onFocusNode={onFocusNode} />
            ))}
          </>
        )}
      </Card>

      {/* ── HOT PATHS ─────────────────────────────────────────────────────── */}
      <Card className={s.lane} data-testid="lane-hot">
        <div className={s.head}>
          <Flash20Regular />
          <Subtitle2>Hot paths</Subtitle2>
        </div>
        <div className={s.badges}>
          <Badge className={s.badge} appearance="filled" color="success">
            {hot.observed} observed
          </Badge>
          <Badge className={s.badge} appearance="tint" color="informative">
            {hot.wired} wired
          </Badge>
          <Badge className={s.badge} appearance="tint" color="subtle">
            {hot.declaredOnly} declared only
          </Badge>
          <Badge className={s.badge} appearance="tint" color="danger">
            {hot.broken} broken
          </Badge>
          <Badge className={s.badge} appearance="outline">
            over {hot.edgesExamined} edge(s) in view
          </Badge>
        </div>
        {hot.collected ? (
          <Caption1 className={s.note}>{hot.note}</Caption1>
        ) : (
          <MessageBar intent="warning" data-testid="hot-not-collected">
            <MessageBarBody>
              <MessageBarTitle>Hot paths were not evaluated.</MessageBarTitle>
              {hot.note}
            </MessageBarBody>
          </MessageBar>
        )}
      </Card>

      {/* ── NEW EDGES ─────────────────────────────────────────────────────── */}
      <Card className={s.lane} data-testid="lane-new">
        <div className={s.head}>
          <Sparkle20Regular />
          <Subtitle2>New since the last version</Subtitle2>
        </div>
        {fresh.available ? (
          <>
            <div className={s.badges}>
              <Badge className={s.badge} appearance="filled" color="brand">
                {fresh.newEdges} new edge(s)
              </Badge>
            </div>
            <Caption1 className={s.note}>{fresh.reason}</Caption1>
          </>
        ) : (
          <MessageBar intent="warning" data-testid="new-not-available">
            <MessageBarBody>
              <MessageBarTitle>Growth was not evaluated.</MessageBarTitle>
              {fresh.reason}
            </MessageBarBody>
          </MessageBar>
        )}
      </Card>
    </div>
  );
}

function RiskFindingCard({
  finding,
  onFocusNode,
}: {
  finding: WireRiskFinding;
  onFocusNode: (id: string) => void;
}) {
  const s = useStyles();
  return (
    <Card className={s.lane} data-testid="risk-finding" data-finding-id={finding.id}>
      <div className={s.badges}>
        <Badge
          className={s.badge}
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
        <Badge className={s.badge} appearance="outline">
          {finding.findingClass}
        </Badge>
        <Badge className={s.badge} appearance="outline">
          confidence: {finding.confidence}
        </Badge>
      </div>

      <Body1Strong>{finding.title}</Body1Strong>

      {finding.evidence.nodeIds.length > 0 && (
        <div className={s.actions}>
          {finding.evidence.nodeIds.map((id) => (
            <Button
              key={id}
              size="small"
              appearance="subtle"
              onClick={() => onFocusNode(id)}
              data-testid="risk-focus-node"
            >
              Show on graph
            </Button>
          ))}
        </div>
      )}

      <Accordion collapsible>
        <AccordionItem value="evidence">
          <AccordionHeader>
            Evidence ({finding.evidence.facts.length} established fact(s))
          </AccordionHeader>
          <AccordionPanel>
            <Caption1 className={s.note}>Query</Caption1>
            <pre className={s.pre}>{finding.evidence.query}</pre>
            <Caption1 className={s.note}>What the detector established</Caption1>
            <ul>
              {finding.evidence.facts.map((fact, i) => (
                <li key={i}>
                  <Caption1 className={s.note}>{fact}</Caption1>
                </li>
              ))}
            </ul>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="draft">
          <AccordionHeader>Drafted remediation (not applied)</AccordionHeader>
          <AccordionPanel>
            <Body1>{finding.remediation.summary}</Body1>
            {finding.remediation.proposedCommands.length > 0 && (
              <pre className={s.pre} data-testid="risk-proposed-commands">
                {finding.remediation.proposedCommands.join('\n')}
              </pre>
            )}
            {finding.remediation.proposedPatchDescription !== null && (
              <pre className={s.pre} data-testid="risk-proposed-patch">
                {finding.remediation.proposedPatchDescription}
              </pre>
            )}
            <Caption1 className={s.note}>
              requiresHumanApproval={String(finding.remediation.requiresHumanApproval)} — the Brain
              reports and drafts; it never patches an authorization path on its own, because a wrong
              autonomous fix to authz is worse than the gap. There is no approve control on this
              lane and there must never be one.
            </Caption1>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}
