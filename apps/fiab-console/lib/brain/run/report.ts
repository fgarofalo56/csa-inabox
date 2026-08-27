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

/**
 * The staleness block, printed on the two NON-SCANNING paths.
 *
 * ── WHY IT IS ABOVE THE OBSERVED STATES, NOT BELOW (review of #4014, S5) ──
 * A PAUSED run exits 0. Its whole log therefore reads as a normal night, and
 * the one thing that distinguishes "paused since yesterday" from "this lane has
 * not looked at anything in seven weeks" is this number. It goes first, and it
 * is marked when it is past the ceiling, for the same reason REGRESSIONS lead
 * the digest: burying the loudest line under a longer list is the same defect
 * as not printing it.
 */
function stalenessBlock(outcome: ScanOutcome): string[] {
  const s = outcome.scanStaleness;
  if (s === null) return [];
  if (s.exceeded) {
    return ['!'.repeat(78), 'SCAN STALENESS — THIS LANE HAS NOT SCANNED', '!'.repeat(78), s.message, ''];
  }
  return [`SCAN STALENESS: ${s.message}`, ''];
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
      ...stalenessBlock(outcome),
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
    const body: string[] = [...stalenessBlock(outcome)];
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

/**
 * ── ENCODING FOR THE STEP-SUMMARY SINK ─────────────────────────────────────
 *
 * The sink is GITHUB-FLAVORED MARKDOWN written to `$GITHUB_STEP_SUMMARY`, and
 * the text reaching it is ATTACKER-INFLUENCED: `ProbeFailure.detail` is a
 * verbatim ARM response body, and resource ids and detector subjects are Azure
 * resource names and tag values.
 *
 * The first version hand-rolled `detail.replace(/\|/g, '\\|')`, which CodeQL
 * flagged as `js/incomplete-sanitization` (HIGH) and which was genuinely broken:
 *
 *     input  a\|b
 *     step 1 the `|` becomes `\|`            ->  a\  \|  b
 *     result a\\|b
 *     GFM    `\\` is an ESCAPED BACKSLASH, so the `|` after it is UNESCAPED
 *            and splits the cell. Table structure breaks.
 *
 * It also did nothing about NEWLINES, and a newline ends the table ROW, not
 * merely the cell — an ARM error body is routinely multi-line, so the table
 * broke on ordinary input too.
 *
 * The fix is NOT "also escape backslash". Two structural changes:
 *
 *  1. ENTITY-ENCODE INSTEAD OF BACKSLASH-ESCAPE. There is then no escape
 *     character to re-escape, so the incomplete-escaping class cannot recur by
 *     construction. `&` is encoded FIRST, or the encoder would double-encode
 *     its own output.
 *
 *  2. PUT UNBOUNDED TEXT WHERE ESCAPING IS NOT NEEDED AT ALL. The ARM id and
 *     the response body move OUT of the table into a FENCED BLOCK, whose fence
 *     is computed to be longer than the longest backtick run in the content
 *     (the CommonMark rule). Nothing inside a fence is interpreted, so there is
 *     nothing to escape. Only union-typed and numeric fields stay in the table.
 *
 * Note that entities do NOT decode inside a code span, so nothing
 * entity-encoded is wrapped in backticks — that would render the raw entity.
 *
 * ── BLOCK-LEVEL IS NOT THE WHOLE THREAT (review of #4014, second pass) ─────
 * The first version of `mdParagraph` neutralised NOTHING. It collapsed newlines
 * and reasoned that "every block-level markdown construct must begin at the
 * start of a line", which is true and is beside the point: `[text](url)` and
 * `![alt](url)` are INLINE. They need no line start, and `mdParagraph` is applied
 * to `v.message`, which embeds `ProbeFailure.detail` — a verbatim ARM response
 * body, i.e. exactly the attacker-influenced text the comment above flags.
 * MEASURED end to end in the rendered summary before the fix:
 *
 *     link-live=true  img-live=true
 *
 * A live link in a scan summary is a phishing surface with the Brain's authority
 * behind it; a live image is an unauthenticated outbound GET from whoever opens
 * the run, which leaks the reader's IP and is how a "did anyone look at this
 * alert?" beacon works. `mdTableCell` had the same gap — its corpus tested forged
 * ROWS and HEADINGS, so an inline link in a cell was never exercised.
 *
 * Both now share ONE encoder ({@link mdInline}). Two copies would drift, and the
 * drift would be silent in the direction that matters.
 *
 * ── THE HONEST LIMIT: GFM EXTENDED AUTOLINKS ──────────────────────────────
 * A bare `https://host/path` (or `www.host`) still autolinks. That cannot be
 * encoded away without mangling the URL text, which would destroy the verbatim
 * failure R7 exists to preserve. It is a materially weaker shape and the
 * difference is the point: an autolink's visible text IS its destination, so it
 * cannot LIE about where it goes. `[click here](evil)` can, and that is what is
 * now dead.
 */

/**
 * Entity-encode every character that can open a markdown construct, BLOCK or
 * INLINE. Order matters: `&` first, or the encoder double-encodes its own output.
 *
 * Entities decode in rendered markdown, so `(` still READS as `(` — nothing is
 * lost from the evidence, only its power to become structure.
 *
 * `*`, `_` and `~` are deliberately NOT encoded: emphasis and strikethrough are
 * cosmetic and cannot carry a destination, and encoding them would litter
 * ordinary Azure resource names. `!` is not encoded either — it is necessary only
 * in company with `[`, and `[` is dead.
 */
function mdInline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '&#92;')
    .replace(/\|/g, '&#124;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    // The inline-link and inline-image quartet. `[` alone is sufficient to kill
    // both; all four are encoded so a reader of this list does not have to
    // reconstruct that argument to be sure.
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\(/g, '&#40;')
    .replace(/\)/g, '&#41;');
}

/** ASCII-punctuation entities. Order matters: `&` first, then `\`. */
export function mdTableCell(text: string): string {
  return (
    mdInline(text)
      // A newline ends the ROW. This is not cosmetic.
      .replace(/\r\n|\r|\n/g, ' ')
  );
}

/**
 * A single-line paragraph with every construct neutralised.
 *
 * Collapsing newlines kills the BLOCK-level constructs — a heading, a list item,
 * a blockquote, a fence, a table row all have to begin at the start of a line,
 * and with no line breaks there is no such position. That is necessary and it is
 * NOT sufficient: see the note above on inline links and images, which was
 * measured live in the rendered summary. {@link mdInline} handles those.
 */
export function mdParagraph(text: string): string {
  return mdInline(text)
    .replace(/\r\n|\r|\n/g, ' ')
    .trim();
}

/**
 * A fenced block whose fence cannot be closed early by the content.
 *
 * CommonMark: a fenced block ends at a fence of AT LEAST the opening length, so
 * an opening fence longer than any backtick run in the content cannot be closed
 * from inside it. Nothing else needs escaping, which is the point of choosing
 * this sink for unbounded text.
 */
export function mdFence(text: string, info = ''): string[] {
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  const fence = '`'.repeat(Math.max(3, (runs.length > 0 ? Math.max(...runs) : 0) + 1));
  return [`${fence}${info}`, text.replace(/\r\n|\r/g, '\n'), fence];
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. Same content, same ordering. */
export function renderStepSummary(outcome: ScanOutcome): string {
  const v = outcome.verdict;
  // A stale lane is named IN THE HEADLINE, not only in a section further down.
  // The headline is the one thing an operator reads on a run they did not open
  // deliberately, and "PAUSED" alone made 60 unscanned nights look like one.
  const stale = outcome.scanStaleness?.exceeded === true;
  const badge =
    v.kind === 'ok'
      ? outcome.populationRegression
        ? 'POPULATION REGRESSION — the estate was scanned and the SCAN got worse'
        : 'OK — the estate was scanned'
      : v.kind === 'paused'
        ? stale
          ? 'PAUSED, AND STALE — the estate is stopped, and this lane has not actually ' +
            `scanned in ${outcome.scanStaleness?.ageDays ?? '?'} day(s)`
          : 'PAUSED — the estate is stopped; NOTHING was scanned'
        : `UNREACHABLE — ${v.reason}${isReachFailure(v.reason) ? '' : ' (Azure WAS reached)'}`;

  const out: string[] = [
    `## Loom Brain scan — ${badge}`,
    '',
    `| | |`,
    `|---|---|`,
    `| estate | ${mdTableCell(v.estateId)} |`,
    `| cloud | ${mdTableCell(v.cloud)} |`,
    `| run | ${mdTableCell(outcome.runRecord.runId)} |`,
    `| at | ${mdTableCell(v.at)} |`,
    `| scope | ${mdTableCell(v.scope)} |`,
    '',
    // The verdict message EMBEDS `ProbeFailure.detail` verbatim, so it is
    // attacker-influenced even though this lane composed the sentence around it.
    mdParagraph(v.message),
    '',
  ];

  // The staleness section sits directly under the verdict on both non-scanning
  // paths, above everything else those paths render.
  const s = outcome.scanStaleness;
  if (s !== null) {
    out.push(
      s.exceeded
        ? '### :rotating_light: This lane has not actually scanned'
        : '### Scan staleness',
      '',
      mdParagraph(s.message),
      '',
      '| | |',
      '|---|---|',
      `| last actual scan | ${mdTableCell(s.lastScannedAt ?? 'NEVER')} |`,
      `| basis run | ${mdTableCell(s.lastScannedRunId ?? 'none')} |`,
      `| age (days) | ${s.ageDays === null ? '_not established_' : s.ageDays} |`,
      `| age (runs) | ${s.lastScannedAgeRuns} |`,
      `| ceiling (days) | ${s.ceilingDays} |`,
      '',
    );
  }

  if (v.kind === 'paused') {
    out.push('### Observed resource states', '', '| state | resource | api-version |', '|---|---|---|');
    for (const o of v.observed) {
      // `powerState` and `armApiVersion` are constrained, but `resourceId` is an
      // Azure resource name. Encoded, and NOT wrapped in backticks — entities do
      // not decode inside a code span.
      out.push(
        `| ${mdTableCell(o.powerState)} | ${mdTableCell(o.resourceId)} | ` +
          `${mdTableCell(o.armApiVersion)} |`,
      );
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
      // Only the CONSTRAINED fields are tabulated: `stage` and `classification`
      // are string-union types and `httpStatus` is a number or null. The ARM id
      // and the response body are unbounded attacker-influenced text and go into
      // a fenced block, where nothing is interpreted and nothing needs escaping.
      out.push('### Probe failures', '', '| # | stage | class | http |', '|---|---|---|---|');
      v.failures.forEach((f, i) => {
        out.push(
          `| ${i + 1} | ${mdTableCell(f.stage)} | ${mdTableCell(f.classification)} | ` +
            `${f.httpStatus === null ? '_none_' : f.httpStatus} |`,
        );
      });
      out.push('', 'Target and detail, verbatim:', '');
      v.failures.forEach((f, i) => {
        out.push(...mdFence(`[${i + 1}] ${f.target}\n${f.detail}`));
      });
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
      mdParagraph(outcome.populationRegression.message),
      '',
      '| detector | kind | examined before | examined now |',
      '|---|---|---|---|',
      ...outcome.populationRegression.detectors.map(
        (r) =>
          `| ${mdTableCell(r.detector)} | ${mdTableCell(r.kind)} | ${r.previousExamined} | ` +
          `${r.examined} |`,
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
      `| graph version | ${mdTableCell(outcome.graphVersion?.versionId ?? 'none')} ` +
        `(${mdTableCell(outcome.graphVersion?.status ?? 'n/a')}) |`,
      '',
      '### Changed since the last run',
      '',
      // The digest carries finding titles and ARM ids. A fence whose length is
      // computed from the content cannot be closed early from inside it.
      ...mdFence(renderDigestSections(d).join('\n')),
    );
  }
  // `outcome.notes` — NOT just `digest.notes`. The step summary is the surface
  // the operator actually reads, and the run-level notes are where "population
  // comparison: NO BASIS", the basis age, the graph-composition change and the
  // graph-version receipt live. Rendering only the digest's notes here left all
  // of those visible in the log and invisible in the summary (review of #4014).
  if (outcome.notes.length > 0) {
    out.push('', '### Run notes', '', ...outcome.notes.map((n) => `- ${mdParagraph(n)}`));
  }
  return out.join('\n');
}
