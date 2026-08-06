/**
 * The two deployment-planner step BODIES, extracted from `setup-wizard.tsx`.
 *
 * Extraction rather than a baseline bump: `scripts/ci/check-file-size.mjs`
 * froze `setup-wizard.tsx` at 1,900 LOC and adding the greenfield/brownfield
 * flow inline pushed it to 1,979. Raising the ceiling would satisfy the ratchet
 * while doing the exact thing it exists to prevent, so the step bodies live
 * here and the wizard keeps only its step wiring and footers.
 *
 * These are presentational containers: all scan/plan state lives in
 * `useAdoptionPlanner`, and the Back/Next footer stays with the wizard because
 * it owns step navigation.
 */
'use client';

import * as React from 'react';
import { Body1, Subtitle2, makeStyles, tokens } from '@fluentui/react-components';
import { DeploymentScopeStep, type ScopeSubscription } from './deployment-scope-step';
import { AdoptionPlanStep, type AdoptionPlanStepProps } from './adoption-plan-step';

const useStyles = makeStyles({
  header: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalXXS },
});

export function ScopeStepBody(props: {
  subscriptions: ScopeSubscription[];
  loading: boolean;
  error?: string | null;
  onReload: () => void;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const styles = useStyles();
  return (
    <>
      <div className={styles.header}>
        <Subtitle2>Analyse your existing Azure estate</Subtitle2>
        <Body1>
          Before deploying anything, Loom can look at what you already have and offer to use it instead of
          deploying a duplicate. Confirm which subscriptions it may read.
        </Body1>
      </div>
      <DeploymentScopeStep
        subscriptions={props.subscriptions}
        loading={props.loading}
        error={props.error}
        onReload={props.onReload}
        selected={props.selected}
        onChange={props.onChange}
      />
    </>
  );
}

export function AdoptionStepBody(props: AdoptionPlanStepProps) {
  const styles = useStyles();
  return (
    <>
      <div className={styles.header}>
        <Subtitle2>Reuse what exists, or deploy new</Subtitle2>
        <Body1>
          For every backing service, choose whether Loom binds to something you already have or deploys its own.
          Nothing here is applied until you confirm the plan on the next step.
        </Body1>
      </div>
      <AdoptionPlanStep {...props} />
    </>
  );
}
