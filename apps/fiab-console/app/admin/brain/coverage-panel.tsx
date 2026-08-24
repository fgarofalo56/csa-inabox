'use client';

/**
 * LOOM BRAIN VISUALIZER — the COVERAGE panel.
 *
 * THIS IS THE MOST IMPORTANT PANEL ON THE SURFACE, and it is the one a normal
 * product would not ship. It renders what the Brain did NOT look at.
 *
 * The failure it exists to prevent is specific and has happened repeatedly in
 * this repo: a check that reports green over an empty population. PRP §3.2 and
 * §3.7 both call it out as non-negotiable — "a detector over an empty node set
 * is green and blind". The substrate makes the population impossible to omit
 * from a query RESULT; this panel makes it impossible to omit from the SCREEN.
 *
 * Three distinct states are rendered differently, because collapsing any two of
 * them produces a confident wrong answer:
 *
 *   COLLECTED, n > 0      the detector ran over real data. A clean result means
 *                         something.
 *   COLLECTED, n = 0      the extractor ran and found nothing. "No inbound X"
 *                         is now VACUOUSLY TRUE OF EVERY NODE. `Population.blind`
 *                         does NOT fire here — the node set was not empty — so
 *                         this state is invisible unless it is drawn.
 *   NOT COLLECTED         the extractor never ran. Establishes nothing at all.
 *
 * The middle one is the trap. It is the state where a query returns the LOUDEST
 * possible answer (every node) and the answer is worthless.
 */

import * as React from 'react';
import {
  Badge,
  Body1,
  Caption1,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { BrainSnapshot } from '@/app/api/admin/brain/_lib/wire';
import type { EdgeProvenance } from '@/lib/brain/graph';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  note: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, minWidth: 0 },
});

export type CoverageState = 'collected' | 'collected-empty' | 'not-collected';

/** The three-way verdict, as a pure function so a test can pin it. */
export function coverageState(collected: boolean, edgeCount: number): CoverageState {
  if (!collected) return 'not-collected';
  return edgeCount === 0 ? 'collected-empty' : 'collected';
}

const STATE_COPY: Record<CoverageState, { label: string; color: 'success' | 'warning' | 'danger'; meaning: string }> = {
  collected: {
    label: 'collected',
    color: 'success',
    meaning: 'the extractor ran and produced edges — queries over this provenance are meaningful',
  },
  'collected-empty': {
    label: 'collected, ZERO edges',
    color: 'warning',
    meaning:
      'the extractor ran and produced nothing. Any "no inbound edge" query over this provenance ' +
      'is now vacuously true of EVERY node. Population.blind does not fire on this — the node set ' +
      'is not empty — so it is called out here instead.',
  },
  'not-collected': {
    label: 'NOT collected',
    color: 'danger',
    meaning:
      'the extractor never ran in this snapshot. Detectors depending on it emit nothing and say ' +
      'so, rather than returning every node as a "finding".',
  },
};

export function CoveragePanel({ snapshot }: { snapshot: BrainSnapshot }) {
  const s = useStyles();
  const provenances = Object.keys(snapshot.coverage) as EdgeProvenance[];
  const declined = snapshot.detectors.filter((d) => d.vacuous);
  const ran = snapshot.detectors.filter((d) => !d.vacuous);

  return (
    <div className={s.root} data-testid="coverage-panel">
      <Subtitle2>What this snapshot can and cannot establish</Subtitle2>

      {!snapshot.collection.complete && (
        <MessageBar intent="error" data-testid="incomplete-collection">
          <MessageBarBody>
            <MessageBarTitle>The estate read is INCOMPLETE.</MessageBarTitle>
            {snapshot.collection.rowsFetched} row(s) were read
            {snapshot.collection.totalRecords === null
              ? ', and Azure Resource Graph did not report a total — so completeness is UNKNOWN, not confirmed.'
              : ` but Resource Graph reported ${snapshot.collection.totalRecords}. Rows were lost.`}{' '}
            Every reachability verdict below ranges over a partial graph and may name a service as
            unreachable purely because the thing that calls it was not read.
          </MessageBarBody>
        </MessageBar>
      )}

      {snapshot.ownership.blind && (
        <MessageBar intent="warning" data-testid="ownership-blind">
          <MessageBarBody>
            <MessageBarTitle>Ownership is not established for anything in this estate.</MessageBarTitle>
            {snapshot.ownership.note} Findings are still reported — reports cover every
            subscription — but no remediation is offered for approval, because a cleanup scoped
            by a guessed owner can reach resources that are not Loom&apos;s.
          </MessageBarBody>
        </MessageBar>
      )}

      <Table size="small" aria-label="Edge provenance coverage">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Provenance</TableHeaderCell>
            <TableHeaderCell>Edges</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>What that means</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {provenances.map((p) => {
            const c = snapshot.coverage[p];
            const st = coverageState(c.collected, c.edgeCount);
            const copy = STATE_COPY[st];
            return (
              <TableRow key={p} data-coverage-provenance={p} data-coverage-state={st}>
                <TableCell>{p}</TableCell>
                <TableCell>{c.edgeCount}</TableCell>
                <TableCell>
                  <Badge appearance="tint" color={copy.color}>{copy.label}</Badge>
                </TableCell>
                <TableCell>
                  <Caption1 className={s.note}>{copy.meaning}</Caption1>
                  <Caption1 className={s.note}> {c.note}</Caption1>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Subtitle2>Detectors</Subtitle2>
      <Table size="small" aria-label="Detector populations">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Detector</TableHeaderCell>
            <TableHeaderCell>Findings</TableHeaderCell>
            <TableHeaderCell>Population examined</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...ran, ...declined].map((d) => (
            <TableRow key={d.detector} data-detector={d.detector} data-detector-vacuous={String(d.vacuous)}>
              <TableCell>
                {d.detector}
                {d.vacuous && (
                  <>
                    {' '}
                    <Badge appearance="tint" color="danger">declined</Badge>
                  </>
                )}
              </TableCell>
              <TableCell>{d.vacuous ? '—' : d.findingCount}</TableCell>
              <TableCell>
                {/* The population is rendered ALWAYS, including — especially —
                    when the finding count is zero. */}
                <Caption1 className={s.note}>
                  {d.vacuousReason ?? d.population.scope}
                </Caption1>
                {d.population.blind && !d.vacuous && (
                  <Badge appearance="tint" color="danger">BLIND: examined 0 subjects</Badge>
                )}
                {d.skipped.length > 0 && (
                  <Caption1 className={s.note}>
                    {' '}
                    Skipped: {d.skipped.map((sk) => `${sk.subject} — ${sk.reason}`).join(' | ')}
                  </Caption1>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Subtitle2>What was read</Subtitle2>
      <div className={s.badges}>
        <Badge appearance="outline">cloud: {snapshot.cloud}</Badge>
        <Badge appearance="outline">{snapshot.collection.subscriptionsSeen} subscription(s)</Badge>
        <Badge appearance="outline">{snapshot.collection.rowsFetched} row(s), {snapshot.collection.pages} page(s)</Badge>
        <Badge appearance="outline">{snapshot.collection.containerApps} container app(s)</Badge>
        <Badge appearance="outline">{snapshot.collection.containerAppJobs} job(s)</Badge>
        <Badge appearance="outline">{snapshot.collection.managedEnvironments} environment(s)</Badge>
        <Badge appearance="outline">{snapshot.collection.envEntriesRead} env entries read</Badge>
        <Badge appearance="outline">{snapshot.collection.envEntriesEmpty} empty</Badge>
        <Badge appearance="outline">{snapshot.collection.envEntriesSecretRef} secretRef (NOT readable)</Badge>
        <Badge appearance="outline">{snapshot.collection.durationMs} ms</Badge>
      </div>

      {snapshot.skipped.length > 0 && (
        <>
          <Subtitle2>Inputs that could not be processed ({snapshot.skipped.length})</Subtitle2>
          <Body1 className={s.note}>
            Recorded rather than dropped. A subject skipped for lack of data is not a subject that
            passed.
          </Body1>
          <Table size="extra-small" aria-label="Skipped inputs">
            <TableBody>
              {snapshot.skipped.slice(0, 50).map((sk, i) => (
                <TableRow key={`${sk.subject}-${i}`}>
                  <TableCell>{sk.subject}</TableCell>
                  <TableCell><Caption1 className={s.note}>{sk.reason}</Caption1></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {snapshot.skipped.length > 50 && (
            <Caption1 className={s.note}>
              {snapshot.skipped.length - 50} more not shown here — the count above is the full one.
            </Caption1>
          )}
        </>
      )}
    </div>
  );
}
