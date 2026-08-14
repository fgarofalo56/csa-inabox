/**
 * PlanReviewStep — the reviewable plan, shown BEFORE anything runs
 * (deploy-integrity.md R5.2; design §1.2 step 6).
 *
 * "The customer must never have to troubleshoot a deployment" (R4) starts here:
 * everything the deploy is about to do is stated on one surface, in the
 * operator's language, while it is still free to change.
 *
 * What it must show, and why each is non-negotiable:
 *
 *   · the PATH (greenfield / brownfield) — DERIVED from the decisions, never a
 *     stored flag. If it says brownfield, it is because something in this plan
 *     adopts, and the row that does is listed below.
 *
 *   · every ADOPT decision with the exact MUTATIONS Loom will apply. This is
 *     the last moment an operator can stop Loom assigning their production
 *     Databricks workspace to a Unity Catalog metastore.
 *
 *   · every CREATE decision reached WITHOUT full coverage, marked. "Loom will
 *     deploy a new Purview" reads very differently once you know four
 *     subscriptions could not be read.
 *
 *   · the BLOCKERS. Fitness is not advisory (design §4): a red — or UNKNOWN —
 *     verdict on an adopt decision blocks the deploy button. `unknown` blocks
 *     precisely because "I could not verify this" is not "this is fine".
 *
 *   · the plan HASH, so the same plan can be identified across the four deploy
 *     tiers rather than trusted to have survived them.
 */
'use client';

import * as React from 'react';
import { useMemo } from 'react';
import {
  Badge,
  Body1,
  Body1Strong,
  Button,
  Caption1,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  BuildingMultiple24Regular,
  CheckmarkCircle16Regular,
  Sparkle24Regular,
  Warning16Filled,
} from '@fluentui/react-icons';
import {
  coverageSentence,
  coverageSummary,
  isGreenfieldPlan,
  planBlockers,
  planCounts,
  type DeploymentPlan,
} from '@/lib/deploy/plan-model';
import type { ServiceScanRow } from '@/lib/deploy/plan-builder';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalL, minWidth: 0 },
  hero: {
    display: 'flex',
    alignItems: 'flex-start',
    columnGap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow4,
  },
  heroIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  heroBody: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS, minWidth: 0 },
  counts: { display: 'flex', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS, minWidth: 0 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
  },
  cardHead: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  mutations: { margin: 0, paddingLeft: tokens.spacingHorizontalL },
  truncate: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  hash: { fontFamily: tokens.fontFamilyMonospace },
});

export function PlanReviewStep({
  plan,
  rows,
  onValidate,
  validating = false,
}: {
  plan: DeploymentPlan;
  rows: ServiceScanRow[];
  /** Runs the adopt-fitness probe. Absent → the Fix-it button is not offered. */
  onValidate?: () => Promise<void> | void;
  validating?: boolean;
}) {
  const styles = useStyles();
  const greenfield = isGreenfieldPlan(plan);
  const counts = planCounts(plan.services);
  const blockers = planBlockers(plan);
  const coverage = coverageSummary(plan.scanResults);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.service.key, r])), [rows]);

  /**
   * Only offer the Fix-it when at least one adopt decision has NO verdict yet.
   * A plan blocked because a resource was measured and found `unusable` is not
   * fixed by measuring it again, and offering the button there would imply it
   * might be.
   */
  const needsValidation = useMemo(
    () => Object.values(plan.services).some((d) => d.mode === 'adopt' && !d.fitness),
    [plan.services],
  );

  const adopts = Object.entries(plan.services).filter(([, d]) => d.mode === 'adopt');
  const uncertainCreates = Object.entries(plan.services).filter(([, d]) => d.mode === 'create' && d.uncertain);
  const skips = Object.entries(plan.services).filter(([, d]) => d.mode === 'skip');

  return (
    <div className={styles.root}>
      <div className={styles.hero}>
        {greenfield ? (
          <Sparkle24Regular className={styles.heroIcon} />
        ) : (
          <BuildingMultiple24Regular className={styles.heroIcon} />
        )}
        <div className={styles.heroBody}>
          <Body1Strong>
            {greenfield
              ? 'Greenfield deployment — everything is new'
              : `Brownfield deployment — ${counts.adopt} existing service${counts.adopt === 1 ? '' : 's'} will be reused`}
          </Body1Strong>
          <Body1>
            {greenfield
              ? `Nothing in this plan binds to an existing resource, so Loom will deploy all ${counts.create} backing services itself.`
              : 'Loom will bind to the resources listed below rather than deploying duplicates, and will deploy the rest.'}
          </Body1>
          <div className={styles.counts}>
            <Badge appearance="tint" color="brand" size="small">
              {counts.adopt} reuse
            </Badge>
            <Badge appearance="tint" color="informative" size="small">
              {counts.create} deploy new
            </Badge>
            {counts.skip > 0 && (
              <Badge appearance="tint" color="subtle" size="small">
                {counts.skip} skipped
              </Badge>
            )}
            <Badge appearance="outline" size="small" className={styles.hash}>
              plan {plan.planHash.slice(0, 8)}
            </Badge>
          </div>
        </div>
      </div>

      {blockers.length > 0 && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>This plan cannot be deployed yet</MessageBarTitle>
            <ul className={styles.mutations}>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            Validation is not advisory — a resource Loom could not confirm is usable is not adopted, because a
            mid-deploy failure leaves a partial estate you would have to unpick by hand.
          </MessageBarBody>
          {/* G2 inline Fix-it. Until #3376 this bar said "run the validation
              step" and there was no step to run — the blocker could never
              clear. This button IS that step: it reads every adopted resource
              and attaches its verdict. */}
          {onValidate && needsValidation && (
            <MessageBarActions>
              <Button
                appearance="primary"
                size="small"
                disabled={validating}
                icon={validating ? <Spinner size="tiny" /> : <CheckmarkCircle16Regular />}
                onClick={() => void onValidate()}
              >
                {validating ? 'Validating…' : 'Validate these resources'}
              </Button>
            </MessageBarActions>
          )}
        </MessageBar>
      )}

      {/* Coverage travels with the plan so a later reader still knows what was
          and was not visible when these decisions were made. */}
      <div className={styles.section}>
        <Subtitle2>What Loom looked at</Subtitle2>
        <Body1>{coverageSentence(plan.scanResults)}</Body1>
        {coverage.incomplete && (
          <Caption1>
            <Warning16Filled style={{ verticalAlign: 'text-bottom' }} /> Because part of the estate could not be
            read, the &quot;deploy new&quot; decisions marked below are &quot;nothing found in what I could
            read&quot;, not &quot;nothing exists&quot;.
          </Caption1>
        )}
      </div>

      {adopts.length > 0 && (
        <div className={styles.section}>
          <Subtitle2>Existing resources Loom will use — and what it will change</Subtitle2>
          {adopts.map(([key, d]) => {
            const row = byKey.get(key);
            const muts = row?.service.mutations ?? [];
            return (
              <div key={key} className={styles.card}>
                <div className={styles.cardHead}>
                  <Body1Strong className={styles.truncate}>{row?.service.label ?? key}</Body1Strong>
                  <Badge appearance="tint" color="brand" size="small">
                    reuse
                  </Badge>
                  {d.source === 'manual' && (
                    <Badge appearance="outline" size="small">
                      you supplied this
                    </Badge>
                  )}
                  {d.fitness?.verdict === 'usable-with-changes' && (
                    <Badge appearance="tint" color="warning" size="small">
                      Loom will adjust it
                    </Badge>
                  )}
                </div>
                <Caption1 className={styles.truncate}>
                  {d.target?.name} · {d.target?.rg || '—'}
                  {d.target?.location ? ` · ${d.target.location}` : ''}
                </Caption1>
                {muts.length === 0 ? (
                  <Caption1>Loom only reads this resource — it changes nothing.</Caption1>
                ) : (
                  <>
                    <Caption1>Loom will:</Caption1>
                    <ul className={styles.mutations}>
                      {muts.map((m) => (
                        <li key={m}>
                          <Caption1>{m}</Caption1>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {d.fitness && d.fitness.checks.some((c) => c.verdict !== 'pass') && (
                  <ul className={styles.mutations}>
                    {d.fitness.checks
                      .filter((c) => c.verdict !== 'pass')
                      .map((c) => (
                        <li key={c.id}>
                          <Caption1>
                            <b>{c.what}</b> — {c.why} (observed: {c.established})
                            {c.remediation?.kind === 'platform-will-fix' && ` Loom will fix this: ${c.remediation.description}`}
                          </Caption1>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {uncertainCreates.length > 0 && (
        <div className={styles.section}>
          <Subtitle2>Deploying new, but Loom could not see everywhere</Subtitle2>
          <Caption1>
            These are being deployed new because nothing was found — in the part of the estate Loom could
            actually read. If any of them already exists somewhere it could not reach, go back and point Loom at
            it rather than letting a duplicate be created.
          </Caption1>
          {uncertainCreates.map(([key]) => (
            <div key={key} className={styles.card}>
              <div className={styles.cardHead}>
                <Body1Strong className={styles.truncate}>{byKey.get(key)?.service.label ?? key}</Body1Strong>
                <Badge appearance="tint" color="warning" size="small">
                  unverified absence
                </Badge>
              </div>
              <Caption1>{byKey.get(key)?.service.usedFor}</Caption1>
            </div>
          ))}
        </div>
      )}

      {skips.length > 0 && (
        <div className={styles.section}>
          <Subtitle2>Skipped</Subtitle2>
          <Caption1>
            Neither deployed nor bound. The surfaces that need these will explain exactly what is missing and
            offer to fix it — they will not fail silently.
          </Caption1>
          <div className={styles.counts}>
            {skips.map(([key]) => (
              <Badge key={key} appearance="outline" size="small">
                {byKey.get(key)?.service.label ?? key}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanReviewStep;
