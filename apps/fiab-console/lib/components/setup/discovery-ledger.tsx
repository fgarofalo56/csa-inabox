/**
 * DiscoveryLedger — the per-subscription coverage table (design §2.3).
 *
 * This component exists because of one specific class of untrue statement.
 * The scan it replaces reported `subscriptionsScanned: subsSeen.size`, computed
 * from MATCHED ROWS — so an operator with 12 subscriptions and hits in 2 was
 * told "2 subscriptions scanned". That is an untrue claim about coverage, and
 * every downstream "no Purview found" inherited it.
 *
 * Here each row states what was ESTABLISHED about one subscription, and the two
 * answers that must never collapse are rendered differently and unmistakably:
 *
 *   status 'scanned', matched 0   → "Read — nothing adoptable"
 *   status 'no-access'            → "Could not read"
 *
 * The tier badge is shown because it changes what the row means: a subscription
 * read by the Console managed identity may legitimately see less than the
 * operator would, and the operator should know which rows those are.
 */
'use client';

import * as React from 'react';
import {
  Badge,
  Body1,
  Caption1,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Subtitle2,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircle16Filled,
  Clock16Regular,
  ErrorCircle16Filled,
  Warning16Filled,
} from '@fluentui/react-icons';
import { coverageSentence, coverageSummary, type SubscriptionScanResult } from '@/lib/deploy/plan-model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  head: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS },
  table: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalXS,
    // Real tables get proper padding — content never butts the border (web3-ui.md).
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  headRow: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  cell: { display: 'flex', flexDirection: 'column', rowGap: '2px', minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  badges: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
    minWidth: 0,
    justifyContent: 'flex-end',
  },
  ok: { color: tokens.colorPaletteGreenForeground1 },
  warn: { color: tokens.colorPaletteYellowForeground1 },
  bad: { color: tokens.colorPaletteRedForeground1 },
});

/** How one ledger row reads. Kept pure + exported so a test can pin the wording. */
export function statusLabel(r: SubscriptionScanResult): { label: string; tone: 'ok' | 'warn' | 'bad'; detail: string } {
  switch (r.status) {
    case 'scanned':
      return r.matchedResources > 0
        ? {
            label: 'Read',
            tone: 'ok',
            detail: `${r.matchedResources} adoptable resource${r.matchedResources === 1 ? '' : 's'} found.`,
          }
        : { label: 'Read — nothing adoptable', tone: 'ok', detail: 'This subscription was read in full and contains nothing Loom can adopt.' };
    case 'partial':
      return {
        label: 'Partially read',
        tone: 'warn',
        detail: r.detail ?? 'The scan stopped before the last page, so this subscription was not read in full.',
      };
    case 'timed-out':
      return { label: 'Timed out', tone: 'warn', detail: r.detail ?? 'The scan ran out of time before this subscription was read.' };
    case 'no-access':
      return { label: 'Could not read', tone: 'bad', detail: r.detail ?? 'Neither your account nor the Console identity could read this subscription.' };
    default:
      return { label: 'Not requested', tone: 'warn', detail: 'You deselected this subscription, so it was not read.' };
  }
}

function ToneIcon({ tone, className }: { tone: 'ok' | 'warn' | 'bad'; className: string }) {
  if (tone === 'ok') return <CheckmarkCircle16Filled className={className} />;
  if (tone === 'warn') return <Warning16Filled className={className} />;
  return <ErrorCircle16Filled className={className} />;
}

export function DiscoveryLedger({ ledger, compact }: { ledger: SubscriptionScanResult[]; compact?: boolean }) {
  const styles = useStyles();
  const summary = coverageSummary(ledger);
  const toneClass = { ok: styles.ok, warn: styles.warn, bad: styles.bad };

  return (
    <div className={styles.root}>
      {!compact && (
        <div className={styles.head}>
          <Subtitle2>Coverage</Subtitle2>
          <Body1>{coverageSentence(ledger)}</Body1>
        </div>
      )}

      {summary.incomplete && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>This scan did not see everything you selected</MessageBarTitle>
            {summary.noAccess > 0 && `${summary.noAccess} subscription${summary.noAccess === 1 ? '' : 's'} could not be read. `}
            {summary.partial + summary.timedOut > 0 &&
              `${summary.partial + summary.timedOut} did not finish. `}
            Every service below that says &quot;not found&quot; means &quot;not found in what Loom could read&quot;.
            If you know a service exists in one of those subscriptions, use <b>I have one</b> on its row to point
            Loom at it — it will be validated exactly like a discovered one.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.table} role="table" aria-label="Per-subscription scan coverage">
        <div className={`${styles.row} ${styles.headRow}`} role="row">
          <Caption1 role="columnheader">Subscription</Caption1>
          <Caption1 role="columnheader">Result</Caption1>
          <Caption1 role="columnheader" style={{ textAlign: 'right' }}>
            Read as
          </Caption1>
        </div>
        {ledger.map((r) => {
          const s = statusLabel(r);
          return (
            <div key={r.subscriptionId} className={styles.row} role="row">
              <div className={styles.cell}>
                <Body1 className={styles.truncate}>{r.displayName}</Body1>
                <Caption1 className={styles.truncate}>{r.subscriptionId}</Caption1>
              </div>
              <div className={styles.cell}>
                <Body1 className={styles.truncate}>
                  <ToneIcon tone={s.tone} className={toneClass[s.tone]} /> {s.label}
                </Body1>
                <Caption1>{s.detail}</Caption1>
              </div>
              <div className={styles.badges}>
                {r.truncated && (
                  <Tooltip content="A page token was still outstanding when the scan's time budget expired." relationship="description">
                    <Badge appearance="outline" color="warning" size="small" icon={<Clock16Regular />}>
                      truncated
                    </Badge>
                  </Tooltip>
                )}
                <Tooltip
                  content={
                    r.credentialTier === 1
                      ? 'Read with your own Azure permissions.'
                      : 'Read with the Loom managed identity — it may see less than you do.'
                  }
                  relationship="description"
                >
                  <Badge appearance="tint" color={r.credentialTier === 1 ? 'brand' : 'informative'} size="small">
                    {r.credentialTier === 1 ? 'you' : 'Loom identity'}
                  </Badge>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DiscoveryLedger;
