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
  body.split('\n').forEach((line, i) => {
    // Ignore comment-only lines: a guard that counts its own explanatory prose is
    // the sibling defect (a comment satisfying a check).
    if (/^\s*#/.test(line)) return;
    if (!line.includes(TABLE)) return;
    // Only an actual query invocation is in scope. A bare table name can appear in a
    // shell loop (`for TBL in ContainerAppConsoleLogs_CL ...`) or in prose; neither
    // reads the table. Requiring the flag is what distinguishes them.
    if (!line.includes('--analytics-query')) return;
    if (DESCRIBES_ONLY.test(line)) return;
    if (SCOPED.test(line)) return;
    // An anchored, distinctive marker is an acceptable alternative scope: it cannot
    // be produced incidentally the way a plain `has 'word'` filter can. The rule is
    // ANCHORED (startswith), not `contains` -- `contains` is what let the runner's
    // own annotation satisfy the login-health query.
    if (ANCHORED_MARKER.test(line)) return;
    problems.push(`${DIR}/${f}:${i + 1}  ${TABLE} query is not scoped by ContainerAppName_s`);
  });
}

if (problems.length) {
  console.error('check-containerlog-query-scope: FAIL');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nAdd `| where ContainerAppName_s == \'<app>\'` — every other query in this repo does.');
  process.exit(1);
}
console.log('check-containerlog-query-scope: OK — every ContainerAppConsoleLogs_CL query is container-scoped');
