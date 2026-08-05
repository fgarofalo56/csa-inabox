/**
 * DeploymentScopeStep — the wizard's consent gate for the multi-subscription
 * analysis (deploy-integrity.md R5.1; design §2.1).
 *
 * R5 says the platform must OFFER a multi-subscription analysis. The scan it
 * replaced fired on `useEffect` mount over the whole tenant, so nothing was
 * ever offered. This step asks first, and says in plain words exactly what will
 * be read and that nothing will be written.
 *
 * DEFAULT IS EVERYTHING, PRE-CHECKED — not opt-in from empty. Two reasons:
 * `loom_default_on_opt_out` (features are opt-out, never opt-in), and an
 * unchecked-by-default list manufactures a false "nothing found" that then
 * becomes an all-`create` plan next to the customer's existing estate. Consent
 * here is confirm-and-proceed, and deselecting is one click per subscription.
 *
 * The operator is NEVER asked "greenfield or brownfield?" (design §1.2). It is
 * a question they frequently cannot answer correctly about their own tenant,
 * and asking it is a `no_questions_in_product` violation. They are asked which
 * subscriptions may be looked at; the result determines the path.
 */
'use client';

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  Checkbox,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  EyeOff20Regular,
  Search24Regular,
} from '@fluentui/react-icons';

export interface ScopeSubscription {
  subscriptionId: string;
  displayName: string;
  state?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL },
  notice: {
    display: 'flex',
    columnGap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  noticeIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  noticeBody: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXS, minWidth: 0 },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    rowGap: tokens.spacingVerticalS,
  },
  actions: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  list: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    maxHeight: '340px',
    overflowY: 'auto',
    padding: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowMain: { display: 'flex', flexDirection: 'column', rowGap: '2px', minWidth: 0 },
  // flexWrap + minWidth:0 + truncation: a badge row must never overlap at any
  // width (ux-baseline.md "Badges never overlap").
  badges: { display: 'flex', columnGap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
});

interface Props {
  /** All subscriptions the operator can enumerate. */
  subscriptions: ScopeSubscription[] | null;
  loading: boolean;
  /** Honest error from the subscription list — rendered, never swallowed. */
  error?: string | null;
  onReload: () => void;
  /** The consented set. Controlled by the wizard. */
  selected: string[];
  onChange: (next: string[]) => void;
}

export function DeploymentScopeStep({ subscriptions, loading, error, onReload, selected, onChange }: Props) {
  const styles = useStyles();
  const [seeded, setSeeded] = useState(false);

  // Pre-check everything the first time the list arrives (default-ON), then
  // leave the operator's edits alone.
  useEffect(() => {
    if (seeded || !subscriptions || subscriptions.length === 0) return;
    setSeeded(true);
    if (selected.length === 0) onChange(subscriptions.map((s) => s.subscriptionId));
  }, [subscriptions, seeded, selected.length, onChange]);

  const toggle = useCallback(
    (id: string, on: boolean) => {
      const set = new Set(selected);
      if (on) set.add(id);
      else set.delete(id);
      onChange(Array.from(set));
    },
    [selected, onChange],
  );

  const all = subscriptions ?? [];
  const allSelected = all.length > 0 && selected.length === all.length;

  return (
    <div className={styles.root}>
      <div className={styles.notice}>
        <Search24Regular className={styles.noticeIcon} />
        <div className={styles.noticeBody}>
          <Body1Strong>What this scan does</Body1Strong>
          <Body1>
            Loom runs a read-only Azure Resource Graph query for 26 resource types across the subscriptions
            you select below. It reads resource names, resource groups, regions, SKUs and network
            configuration so it can offer you an existing service instead of deploying a duplicate.
          </Body1>
          <Caption1>
            <EyeOff20Regular style={{ verticalAlign: 'text-bottom' }} /> It writes nothing. No resource is
            created, modified or deleted by this step — the plan you review afterwards decides all of that.
          </Caption1>
        </div>
      </div>

      <div className={styles.head}>
        <div>
          <Subtitle2>Subscriptions to analyse</Subtitle2>
          <Caption1>
            {all.length > 0
              ? `${selected.length} of ${all.length} selected. Anything you deselect is not read — and services that live only there will be reported as "not found in what I could read", never as "does not exist".`
              : 'Loom lists every subscription your account can enumerate.'}
          </Caption1>
        </div>
        <div className={styles.actions}>
          <Button
            appearance="subtle"
            size="small"
            onClick={() => onChange(allSelected ? [] : all.map((s) => s.subscriptionId))}
            disabled={all.length === 0}
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </Button>
          <Button appearance="subtle" size="small" icon={<ArrowClockwise20Regular />} onClick={onReload} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {loading && <Spinner label="Listing the subscriptions you can access…" />}

      {error && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not list your subscriptions</MessageBarTitle>
            {error} Loom has not concluded that you have none — it could not read the list. Sign in again or
            retry; if it persists, the deployment can still proceed with everything deployed new.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && !error && all.length === 0 && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>No subscriptions were returned</MessageBarTitle>
            Your account enumerated zero Azure subscriptions. Loom will deploy every backing service new. If
            you expected to see subscriptions here, check that your account has at least Reader on them.
          </MessageBarBody>
        </MessageBar>
      )}

      {all.length > 0 && (
        <div className={styles.list} role="group" aria-label="Subscriptions to analyse">
          {all.map((s) => {
            const on = selected.includes(s.subscriptionId);
            return (
              <div key={s.subscriptionId} className={styles.row}>
                <div className={styles.rowMain}>
                  <Checkbox
                    checked={on}
                    onChange={(_e, d) => toggle(s.subscriptionId, !!d.checked)}
                    label={<span className={styles.truncate}>{s.displayName}</span>}
                  />
                  <Caption1 className={styles.truncate}>{s.subscriptionId}</Caption1>
                </div>
                <div className={styles.badges}>
                  {s.state && s.state.toLowerCase() !== 'enabled' && (
                    <Badge appearance="outline" color="warning" size="small">
                      {s.state}
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DeploymentScopeStep;
