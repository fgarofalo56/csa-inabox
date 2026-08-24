/**
 * LOOM BRAIN W10 — the RUN REPORT (#3936).
 *
 * PURE. Renders a {@link ScanOutcome} as the operator sees it: a plain-text
 * block for the workflow log and a markdown block for the Actions step summary.
 *
 * ── IT IS A DIGEST, NOT A BACKLOG DUMP ─────────────────────────────────────
 * #3936: *"a digest of what changed since the last run — not a re-listing of
 * every open finding."* A nightly report that re-prints the whole backlog is a
 * report the operator stops reading, and then the one line that mattered is
 * missed. So the LISTED sections are exactly the transitions — regressions,
 * new, fixed, expired suppressions — and everything else is a count.
 *
 * ── ORDERING IS THE MESSAGE ────────────────────────────────────────────────
 * REGRESSIONS FIRST, always, even when the list is empty (rendered as an
 * explicit "0"). A recurrence after a fix is the loudest thing this lane can
 * say, and burying it under a longer list of new findings would be the same
 * defect as reporting it as `new` — just at the presentation layer.
 *
 * ── THE VERDICT IS THE HEADLINE ────────────────────────────────────────────
 * A PAUSED run exits 0, so a green check on the lane does NOT mean a scan
 * happened. The verdict is therefore the first line of the log, the title of the
 * step summary, and a job output — three places, so a passing job cannot be
 * mistaken for a completed scan.
 */

import type { ScanOutcome } from './scan';
import { isReachFailure, type FindingRecord, type RunDigest, type ScanVerdict } from './model';

function line(label: string, value: string | number): string {
  return `${label.padEnd(24, ' ')} ${value}`;
}

/**
 * The verdict alone, rendered the moment it is formed.
 *
 * Printed BEFORE any persistence, because a persistence failure must not be able
 * to hide the verdict the run had already established. Measured on the first
 * smoke run of the compiled CLI: a missing `LOOM_COSMOS_ENDPOINT` made the run
 * die inside `recordRun` and the operator saw a Cosmos stack trace instead of
 * the UNREACHABLE verdict that had already been correctly classified.
 */
export function renderVerdictHeadline(v: ScanVerdict): string {
  return [
    '='.repeat(78),
    `LOOM BRAIN SCAN — VERDICT: ${v.kind.toUpperCase()}` +
      (v.kind === 'unreachable' ? ` (${v.reason})` : ''),
    '='.repeat(78),
    line('estate', v.estateId),
    line('cloud', v.cloud),
    line('at', v.at),
    line('scope', v.scope),
    '',
    v.message,
  ].join('\n');
}

function short(r: FindingRecord): string {
  return `[${r.severity}] ${r.detector} — ${r.title}`;
}

/** The counts block. #3936 acceptance: "and reports counts". */
export function renderCounts(outcome: ScanOutcome): string {
  const c = outcome.counts;
  if (c === null) {
    return line('counts', 'NONE — no detector ran on this path.');
  }
  return [
    line('graph nodes', c.nodes),
    line('graph edges', c.edges),
    line('detectors run', c.detectorsRun),
    line('detectors BLIND', c.detectorsBlind),
    line('findings produced', c.findingsProduced),
    line('records total', c.recordsTotal),
    line('REGRESSIONS', c.regressions),
    line('new', c.new),
    line('fixed', c.fixed),
    line('still open', c.stillOpen),
    line('suppressed', c.suppressed),
    line('suppressions expired', c.suppressionsExpired),
    line('not evaluated', c.notEvaluated),
  ].join('\n');
}

function renderDigestSections(d: RunDigest): string[] {
  const out: string[] = [];

  // REGRESSIONS FIRST. Printed even at zero.
  out.push(`REGRESSIONS (recurred after being fixed): ${d.regressions.length}`);
  for (const r of d.regressions) {
    out.push(
      `  ! ${short(r)}\n` +
        `      fixed ${r.fixedAt} by run ${r.fixedByRunId}; back at ${r.regressedAt}. ` +
        `Recurrence #${r.regressionCount}.`,
    );
  }

  out.push(`NEW: ${d.newFindings.length}`);
  for (const r of d.newFindings) out.push(`  + ${short(r)}`);

  out.push(`FIXED this run: ${d.fixed.length}`);
  for (const r of d.fixed) out.push(`  - ${short(r)}`);

  out.push(`SUPPRESSIONS EXPIRED (finding re-surfaced): ${d.suppressionsExpired.length}`);
  for (const r of d.suppressionsExpired) out.push(`  ^ ${short(r)}`);

  out.push(`still open (unchanged, not listed): ${d.stillOpen}`);
  out.push(`suppressed by a live acceptance (not listed): ${d.suppressed}`);

  if (d.notEvaluated.length > 0) {
    out.push(
      `NOT EVALUATED: ${d.notEvaluated.length} record(s). These were left UNTOUCHED — ` +
        'absence of a finding is not evidence of repair when the detector did not look.',
    );
    for (const n of d.notEvaluated) {
      out.push(`  ? ${n.detector} [${n.state}] ${n.fingerprint}\n      ${n.reason}`);
    }
  }

  out.push(`detectors evaluated: ${d.evaluatedDetectors.join(', ') || '(none)'}`);
  for (const n of d.notes) out.push(`note: ${n}`);
  return out;
}

/** The full plain-text report for the workflow log. */
export function renderRunReport(outcome: ScanOutcome): string {
  const v = outcome.verdict;
  const head = [
    '='.repeat(78),
    `LOOM BRAIN SCAN — VERDICT: ${v.kind.toUpperCase()}` +
      (v.kind === 'unreachable' ? ` (${v.reason})` : ''),
    '='.repeat(78),
    line('estate', v.estateId),
    line('cloud', v.cloud),
    line('run', outcome.runRecord.runId),
    line('at', v.at),
    line('scope', v.scope),
    '',
    v.message,
    '',
  ];

  if (v.kind === 'paused') {
    return [
      ...head,
      'OBSERVED RESOURCE STATES (each from a direct ARM GET):',
      ...v.observed.map(
        (o) => `  ${o.powerState.padEnd(12, ' ')} ${o.resourceId}  [api ${o.armApiVersion} @ ${o.readAt}]`,
      ),
      '',
      'NOTHING was scanned and NO finding state was changed.',
      ...outcome.notes.map((n) => `note: ${n}`),
    ].join('\n');
  }

  if (v.kind === 'unreachable') {
    const body: string[] = [];
    if (v.failures.length > 0) {
      body.push('PROBE FAILURES, verbatim:');
      for (const f of v.failures) {
        body.push(
          `  [${f.stage}] ${f.target}\n` +
            `      class=${f.classification} http=${f.httpStatus === null ? 'none' : f.httpStatus}\n` +
            `      ${f.detail}`,
        );
      }
    } else {
      body.push(
        `No probe FAILURE occurred: this run REACHED Azure. The verdict is red because ` +
          `'${v.reason}' means the run could not establish anything it could report on. ` +
          'It deliberately does not claim a connectivity problem it did not observe ' +
          '(deploy-integrity.md R7).',
      );
    }
    if (v.readings.length > 0) {
      body.push('', 'STATES THAT WERE read before the run was declared red:');
      for (const r of v.readings) body.push(`  ${r.powerState.padEnd(12, ' ')} ${r.resourceId}`);
    }
    return [...head, ...body, '', ...outcome.notes.map((n) => `note: ${n}`)].join('\n');
  }

  return [
    ...head,
    ...(outcome.populationRegression
      ? [
          '!'.repeat(78),
          'POPULATION REGRESSION — THE SCAN GOT WORSE',
          '!'.repeat(78),
          outcome.populationRegression.message,
          '',
        ]
      : []),
    'COUNTS',
    renderCounts(outcome),
    '',
    'CHANGED SINCE THE LAST RUN',
    ...(outcome.digest ? renderDigestSections(outcome.digest) : ['(no digest)']),
    '',
    ...outcome.notes.map((n) => `note: ${n}`),
  ].join('\n');
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. Same content, same ordering. */
export function renderStepSummary(outcome: ScanOutcome): string {
  const v = outcome.verdict;
  const badge =
    v.kind === 'ok'
      ? outcome.populationRegression
        ? 'POPULATION REGRESSION — the estate was scanned and the SCAN got worse'
        : 'OK — the estate was scanned'
      : v.kind === 'paused'
        ? 'PAUSED — the estate is stopped; NOTHING was scanned'
        : `UNREACHABLE — ${v.reason}${isReachFailure(v.reason) ? '' : ' (Azure WAS reached)'}`;

  const out: string[] = [
    `## Loom Brain scan — ${badge}`,
    '',
    `| | |`,
    `|---|---|`,
    `| estate | \`${v.estateId}\` |`,
    `| cloud | \`${v.cloud}\` |`,
    `| run | \`${outcome.runRecord.runId}\` |`,
    `| at | \`${v.at}\` |`,
    `| scope | ${v.scope} |`,
    '',
    v.message,
    '',
  ];

  if (v.kind === 'paused') {
    out.push('### Observed resource states', '', '| state | resource | api-version |', '|---|---|---|');
    for (const o of v.observed) {
      out.push(`| \`${o.powerState}\` | \`${o.resourceId}\` | \`${o.armApiVersion}\` |`);
    }
    out.push(
      '',
      'Every reading above came from a direct ARM `GET`, never from Resource Graph — ' +
        'ARG is a replicated index and reports a paused Synapse pool `Online` for minutes ' +
        'afterwards (measured 2026-08-22).',
    );
    return out.join('\n');
  }

  if (v.kind === 'unreachable') {
    if (v.failures.length > 0) {
      out.push('### Probe failures', '', '| stage | target | class | http | detail |', '|---|---|---|---|---|');
      for (const f of v.failures) {
        out.push(
          `| ${f.stage} | \`${f.target}\` | ${f.classification} | ` +
            `${f.httpStatus === null ? '_none_' : f.httpStatus} | ${f.detail.replace(/\|/g, '\\|')} |`,
        );
      }
    }
    out.push('', 'No graph was built, no detector ran, and no finding state was changed.');
    return out.join('\n');
  }

  const c = outcome.counts;
  const d = outcome.digest;
  if (outcome.populationRegression) {
    out.push(
      '### :rotating_light: Population regression',
      '',
      outcome.populationRegression.message,
      '',
      '| detector | kind | examined before | examined now |',
      '|---|---|---|---|',
      ...outcome.populationRegression.detectors.map(
        (r) => `| \`${r.detector}\` | ${r.kind} | ${r.previousExamined} | ${r.examined} |`,
      ),
      '',
    );
  }
  if (c && d) {
    out.push(
      '### Counts',
      '',
      '| metric | value |',
      '|---|---|',
      `| **regressions** | **${c.regressions}** |`,
      `| new | ${c.new} |`,
      `| fixed | ${c.fixed} |`,
      `| still open | ${c.stillOpen} |`,
      `| suppressed | ${c.suppressed} |`,
      `| suppressions expired | ${c.suppressionsExpired} |`,
      `| not evaluated | ${c.notEvaluated} |`,
      `| findings produced | ${c.findingsProduced} |`,
      `| detectors run / blind | ${c.detectorsRun} / ${c.detectorsBlind} |`,
      `| graph nodes / edges | ${c.nodes} / ${c.edges} |`,
      `| graph version | \`${outcome.graphVersion?.versionId ?? 'none'}\` (${outcome.graphVersion?.status ?? 'n/a'}) |`,
      '',
      '### Changed since the last run',
      '',
      '```',
      ...renderDigestSections(d),
      '```',
    );
  }
  return out.join('\n');
}
