#!/usr/bin/env node
/**
 * Every ContainerAppConsoleLogs_CL query MUST scope to a container.
 *
 * WHY THIS EXISTS
 * ---------------
 * `loom-ui-verify.yml`'s login-health preflight queried ContainerAppConsoleLogs_CL
 * filtering on log TEXT only, with no container filter. Every Container App and Job
 * in the environment writes to that one table — including `gh-aca-runner`, the
 * self-hosted Actions runner that EXECUTES the workflow.
 *
 * That made the detector count its own output, twice over:
 *   1. the runner echoes the step's `run:` body, which contains the KQL string
 *      itself — so the search terms appear in the logs verbatim;
 *   2. the verdict annotation ("LOGIN BROKEN - N auth/callback invalid_client
 *      errors") contains BOTH search terms AND the count.
 *
 * Each run therefore deposited >=2 new matching rows and the next run read a higher
 * number. Monotonic by construction, entirely independent of whether sign-in worked.
 * Measured: 48 matching rows over 7d, ALL from `gh-aca-runner`, ZERO from
 * `loom-console`. It reported a P0 outage for two weeks while sign-in was healthy,
 * and drove a production credential rotation that fixed nothing.
 *
 * A detector whose own alert text satisfies its own query cannot fail safe. Scope
 * by container so the query can only see the thing it claims to measure.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

const DIR = '.github/workflows';
const TABLE = 'ContainerAppConsoleLogs_CL';
// A query is scoped if it constrains the container by name. BOTH columns are real
// and mean different things: Container APPS surface `ContainerAppName_s`, Container
// App JOBS surface `ContainerName_s`. An earlier draft of this guard knew only the
// first and false-positived every job query in the repo -- the same defect it exists
// to catch, in the guard itself.
const SCOPED = /(ContainerAppName_s|ContainerName_s)\s*(==|=~|contains|startswith|has|in~?)\s*/;

// Lines that merely TALK about a query (an ::error:: string, an echo, a summary
// line) are not queries. Requiring the actual invocation keeps prose out of scope.
const DESCRIBES_ONLY = /::(error|warning|notice)::|^\s*echo/;

// e.g. `Log_s startswith '::eval-run::'` -- anchored to a marker the emitter controls.
const ANCHORED_MARKER = /Log_s\s+startswith\s+'[^']+'/;

const problems = [];
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
  const body = readFileSync(join(DIR, f), 'utf8');
  // LOGICAL lines (#3420). Three tokens have to co-occur on ONE command here —
  // the table, `--analytics-query`, and the scoping predicate — and an
  // `az monitor log-analytics query` is almost always wrapped:
  //
  //     az monitor log-analytics query \
  //       --workspace "$WS" \
  //       --analytics-query "ContainerAppConsoleLogs_CL | take 5"
  //
  // Per physical line the flag and the table sit together but a scope written
  // on a further continuation does not, and an unscoped query whose table name
  // lands on a different line than the flag is not seen at all.
  for (const { line, text: raw } of readLogicalLines(body)) {
    // Ignore comment-only lines: a guard that counts its own explanatory prose is
    // the sibling defect (a comment satisfying a check).
    if (/^\s*#/.test(raw)) continue;
    if (!raw.includes(TABLE)) continue;
    // Only an actual query invocation is in scope. A bare table name can appear in a
    // shell loop (`for TBL in ContainerAppConsoleLogs_CL ...`) or in prose; neither
    // reads the table. Requiring the flag is what distinguishes them.
    const at = raw.indexOf('--analytics-query');
    if (at < 0) continue;
    // POSITIONAL, not anywhere-on-the-line. On a folded command an annotation in
    // the invocation's OWN fallback (`… || echo "::error::query failed"`) sits
    // after the flag and must not be read as "this line is only prose" — that
    // over-broad test silently dropped four real call sites in the sibling
    // Key Vault guard when it adopted logical lines (#3420).
    if (DESCRIBES_ONLY.test(raw.slice(0, at)) || /^\s*echo/.test(raw)) continue;
    if (SCOPED.test(raw)) continue;
    // An anchored, distinctive marker is an acceptable alternative scope: it cannot
    // be produced incidentally the way a plain `has 'word'` filter can. The rule is
    // ANCHORED (startswith), not `contains` -- `contains` is what let the runner's
    // own annotation satisfy the login-health query.
    if (ANCHORED_MARKER.test(raw)) continue;
    problems.push(`${DIR}/${f}:${line}  ${TABLE} query is not scoped by ContainerAppName_s`);
  }
}

if (problems.length) {
  console.error('check-containerlog-query-scope: FAIL');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nAdd `| where ContainerAppName_s == \'<app>\'` — every other query in this repo does.');
  process.exit(1);
}
console.log('check-containerlog-query-scope: OK — every ContainerAppConsoleLogs_CL query is container-scoped');
