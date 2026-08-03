/**
 * login-health-detector.test.mjs — binds the DETECTOR to the EMITTER (#2857).
 *
 * WHY THIS EXISTS
 * ---------------
 * #2840 made loom-ui-verify's login-health preflight able to fail (it had carried
 * both `continue-on-error: true` and a trailing `exit 0`). login-health-verdict.sh
 * is correct and its 13 unit tests pass. But those tests hand the verdict a COUNT
 * directly — nothing ever checked that the KQL which produces that count can match
 * the line the console actually writes during an outage.
 *
 * It could not. The query used the TERM-based `has` operator:
 *
 *     | where Log_s has 'auth/callback' and Log_s has 'invalid_client'
 *
 * A Kusto term is a "maximal sequence of alphanumeric characters"
 * (learn.microsoft.com/kusto/query/datatypes-string-operators#what-is-a-term), so
 * 'auth/callback' (slash) and 'invalid_client' (underscore) are NEVER terms — the
 * docs' own example is `"KustoExplorerQueryRun" has "Explorer"` → false. Both
 * predicates were false for every possible log line, `| count` returned a confident
 * 0, and the fixed exit code never fired. The exit-code half was fixed; the input
 * it grades was structurally always "healthy".
 *
 * WHAT THIS SUITE PINS
 * --------------------
 *   OUTAGE  — the workflow's own KQL predicates, parsed from the YAML at test time,
 *             must MATCH the line app/auth/callback/route.ts emits when MSAL rejects
 *             the client secret with AADSTS7000215. This is the test that goes RED
 *             on the `has` form and GREEN on `contains`.
 *   E2E     — that same match drives the REAL login-health-verdict.sh to exit 1.
 *   CONTROL — a HEALTHY callback line must NOT match. Green both ways, so an
 *             over-broad "just make it match" fix (dropping the invalid_client
 *             predicate, or the whole `where`) is caught rather than rewarded.
 *   CLASS   — a term-operator literal must be a single Kusto term, checked against a
 *             known-bad fixture so the guard is never a vacuous pass.
 *
 * A MODEL, STATED PLAINLY: evalPredicate() encodes the DOCUMENTED Kusto semantics
 * (`contains` = case-insensitive substring; `has` = whole-term). It is not a Kusto
 * engine, and no live Log Analytics cluster is reachable from CI or from a dev box.
 * The contract asserted is therefore the conservative one: the detector must work
 * under the documented semantics rather than rely on undocumented behaviour. That
 * is also why the fix is `contains` — it is a strict superset of `has` (every
 * whole-term match is also a substring match), so it cannot reduce detection even
 * if Kusto turns out to have an undocumented multi-term fallback.
 *
 * Run: node --test scripts/ci/__tests__/login-health-detector.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const WORKFLOW = resolve(REPO, '.github', 'workflows', 'loom-ui-verify.yml');
const ROUTE = resolve(REPO, 'apps', 'fiab-console', 'app', 'auth', 'callback', 'route.ts');
const VERDICT = resolve(REPO, 'scripts', 'ci', 'login-health-verdict.sh');

// ---------------------------------------------------------------------------
// Documented Kusto semantics (the model — see header)
// ---------------------------------------------------------------------------

/** Kusto terms: "each string value is broken into maximal sequences of
 *  alphanumeric characters, and each of those sequences is made into a term". */
export function kustoTerms(s) {
  return s.match(/[A-Za-z0-9]+/g) ?? [];
}

/** Evaluate one `Log_s <op> '<literal>'` predicate against a log line. */
export function evalPredicate(op, literal, line) {
  switch (op) {
    case 'contains':
      return line.toLowerCase().includes(literal.toLowerCase());
    case 'contains_cs':
      return line.includes(literal);
    case 'startswith':
      return line.toLowerCase().startsWith(literal.toLowerCase());
    case 'endswith':
      return line.toLowerCase().endsWith(literal.toLowerCase());
    case 'has':
      return kustoTerms(line).some((t) => t.toLowerCase() === literal.toLowerCase());
    case 'has_cs':
      return kustoTerms(line).some((t) => t === literal);
    default:
      // Refuse to guess. An unmodelled operator must fail loudly rather than
      // silently evaluate to `true` and turn this suite into another green
      // check that measures nothing.
      throw new Error(`unmodelled Kusto operator '${op}' — extend evalPredicate() before using it`);
  }
}

// ---------------------------------------------------------------------------
// Parsing: workflow (detector) and route (emitter)
// ---------------------------------------------------------------------------

/** Drop `#` comment lines. A predicate that only exists in a comment must not
 *  satisfy any assertion here (the "a guard a COMMENT can satisfy" class). */
export function stripShellComments(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** Drop `//` KQL comments that are outside single-quoted string literals. */
export function stripKqlComments(query) {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === "'") inQuote = !inQuote;
    if (!inQuote && c === '/' && query[i + 1] === '/') {
      while (i < query.length && query[i] !== '\n') i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** The `--analytics-query` of the Login-health preflight step, comments removed. */
export function loginHealthQuery(yamlText = readFileSync(WORKFLOW, 'utf8')) {
  const start = yamlText.indexOf('- name: Login-health preflight');
  assert.notEqual(
    start,
    -1,
    'loom-ui-verify.yml no longer has a "Login-health preflight" step — the only in-workflow detector for the AADSTS7000215 class is gone',
  );
  const rest = yamlText.slice(start);
  // Stop at the next sibling step so a neighbour's query can never be picked up.
  const end = rest.indexOf('\n      - name:', 1);
  const body = stripShellComments(end === -1 ? rest : rest.slice(0, end));
  const m = body.match(/--analytics-query\s+"([^"]+)"/);
  assert.ok(m, 'the Login-health preflight must carry an --analytics-query');
  return stripKqlComments(m[1]);
}

/** Every `Log_s <op> '<literal>'` predicate in a KQL query. */
export function logPredicates(query) {
  const re =
    /Log_s\s+(contains_cs|contains|startswith|endswith|has_cs|has)\s+'([^']*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(query)) !== null) out.push({ op: m[1], literal: m[2] });
  return out;
}

/** The literal prefix route.ts logs when the MSAL code exchange throws. */
export function callbackExceptionPrefix(routeText = readFileSync(ROUTE, 'utf8')) {
  const m = routeText.match(/console\.error\(\s*'([^']+)'\s*,\s*msg\s*\)/);
  assert.ok(
    m,
    'app/auth/callback/route.ts no longer logs the exchange exception as console.error(\'<prefix>\', msg) — the detector searches for a string this route must still emit',
  );
  return m[1];
}

// ---------------------------------------------------------------------------
// The simulated AADSTS7000215 condition
// ---------------------------------------------------------------------------

/**
 * `e.message` as @azure/msal-node surfaces it. msal-common's AuthError builds the
 * message as `${errorCode}: ${errorMessage}`, so a token-endpoint response of
 * {"error":"invalid_client","error_description":"AADSTS7000215: …"} arrives with
 * `invalid_client` leading the string. route.ts logs that verbatim after its prefix.
 */
const MSAL_INVALID_CLIENT_MESSAGE =
  "invalid_client: 7000215 - [2026-07-19 14:02:11Z]: AADSTS7000215: Invalid client secret provided. " +
  "Ensure the secret being sent in the request is the client secret value, not the client secret ID, " +
  "for a secret added to app '<redacted>'. Trace ID: <redacted> Correlation ID: <redacted>";

/** console.error('<prefix>', msg) renders as "<prefix> <msg>". */
const OUTAGE_LINE = `${callbackExceptionPrefix()} ${MSAL_INVALID_CLIENT_MESSAGE}`;

/** A successful sign-in, as route.ts logs it on the happy path. */
const HEALTHY_LINE =
  '[auth/callback] session encoded for upn# a1b2c3d4e5f6 — cookie length 812';

/** Fixed clock so the verdict's expiry maths is deterministic. */
const NOW = 1785974400; // 2026-08-02T00:00:00Z
const FAR_FUTURE = new Date((NOW + 400 * 86400) * 1000).toISOString();

function runVerdict(env) {
  const r = spawnSync('bash', [VERDICT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      LH_NOW_EPOCH: String(NOW),
      LH_APP_ID: 'app-under-test',
      LH_CONSOLE_RG: 'rg-under-test',
      ...env,
    },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------------------
// OUTAGE — RED on `has`, GREEN on `contains`
// ---------------------------------------------------------------------------

test('the preflight query filters on Log_s at all', () => {
  const preds = logPredicates(loginHealthQuery());
  assert.ok(
    preds.length >= 2,
    `expected the callback-error query to constrain Log_s on both the route marker and the failure code; got ${JSON.stringify(preds)}`,
  );
});

test('OUTAGE: the preflight query MATCHES the line route.ts emits under AADSTS7000215', () => {
  const preds = logPredicates(loginHealthQuery());
  const misses = preds.filter((p) => !evalPredicate(p.op, p.literal, OUTAGE_LINE));
  assert.deepEqual(
    misses,
    [],
    `the detector cannot see a live sign-in outage.\n` +
      `  emitted line : ${OUTAGE_LINE}\n` +
      `  unmatched    : ${JSON.stringify(misses)}\n` +
      `  A Kusto term is a maximal sequence of ALPHANUMERIC characters, so a literal\n` +
      `  containing '/' or '_' is never a whole term and a term operator (has/has_cs)\n` +
      `  can never match it. Use contains.`,
  );
});

test('E2E: a matching outage line drives the REAL verdict script to exit 1', () => {
  const preds = logPredicates(loginHealthQuery());
  const matched = preds.length > 0 && preds.every((p) => evalPredicate(p.op, p.literal, OUTAGE_LINE));
  const hits = matched ? 1 : 0;
  const r = runVerdict({ LH_LAW: 'ws-guid', LH_HITS_RAW: String(hits), LH_MIN_END: FAR_FUTURE });
  assert.equal(
    r.code,
    1,
    `the login-health gate must go RED for an AADSTS7000215 outage. The query produced ${hits} hit(s); ` +
      `a query that cannot match its own emitter hands the (correct) verdict a permanent 0.`,
  );
  assert.match(r.out, /::error::LOGIN BROKEN/);
});

// ---------------------------------------------------------------------------
// CONTROL — green BOTH ways; catches an over-broad fix
// ---------------------------------------------------------------------------

test('CONTROL: a HEALTHY callback line must NOT match the outage query', () => {
  const preds = logPredicates(loginHealthQuery());
  const matched = preds.length > 0 && preds.every((p) => evalPredicate(p.op, p.literal, HEALTHY_LINE));
  assert.equal(
    matched,
    false,
    'a successful sign-in was counted as an outage — the query lost the failure-code predicate ' +
      '(or the whole `where`), which would page on every healthy run',
  );
});

test('CONTROL: an unrelated console line must NOT match the outage query', () => {
  const preds = logPredicates(loginHealthQuery());
  const line = '[items/lakehouse] provisioned adls container loom-bronze in 412ms';
  const matched = preds.length > 0 && preds.every((p) => evalPredicate(p.op, p.literal, line));
  assert.equal(matched, false, 'unrelated traffic must not be counted as a sign-in outage');
});

test('CONTROL: the verdict stays green when the query genuinely finds nothing', () => {
  const r = runVerdict({ LH_LAW: 'ws-guid', LH_HITS_RAW: '0', LH_MIN_END: FAR_FUTURE });
  assert.equal(r.code, 0, 'a real zero is healthy — this must not start failing');
  assert.doesNotMatch(r.out, /::error::/);
});

// ---------------------------------------------------------------------------
// CLASS GUARD — a term operator needs a term. Driven against a known-bad fixture
// so it can never pass vacuously once the real query stops using `has`.
// ---------------------------------------------------------------------------

const termOperatorViolations = (query) =>
  logPredicates(query)
    .filter((p) => p.op === 'has' || p.op === 'has_cs')
    .filter((p) => {
      const terms = kustoTerms(p.literal);
      return terms.length !== 1 || terms[0] !== p.literal;
    });

test('CLASS: the guard has teeth — it catches the exact query that shipped', () => {
  const shipped =
    "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(7d) | " +
    "where Log_s has 'auth/callback' and Log_s has 'invalid_client' | count";
  assert.deepEqual(
    termOperatorViolations(shipped).map((p) => p.literal),
    ['auth/callback', 'invalid_client'],
    'the term-operator guard must flag both literals of the query that shipped blind',
  );
});

test('CLASS: the guard does not over-reach — a real single-term `has` is fine', () => {
  const ok = "T | where Log_s has 'AADSTS7000215' | count";
  assert.deepEqual(termOperatorViolations(ok), []);
});

test('CLASS: the live preflight query has no term-operator violations', () => {
  assert.deepEqual(
    termOperatorViolations(loginHealthQuery()).map((p) => `${p.op} '${p.literal}'`),
    [],
    'a Log_s term operator (has/has_cs) was given a literal that is not a single Kusto term',
  );
});

// ---------------------------------------------------------------------------
// MASKED BODY — a predicate that exists only in a comment must not count
// ---------------------------------------------------------------------------

test('MASKED: a #-commented predicate does not satisfy the parser', () => {
  const yaml = [
    '      - name: Login-health preflight (fixture)',
    '        run: |',
    "          # --analytics-query \"T | where Log_s contains 'auth/callback' and Log_s contains 'invalid_client' | count\"",
    '          echo nothing-real-here',
    '      - name: next step',
  ].join('\n');
  assert.throws(
    () => loginHealthQuery(yaml),
    /must carry an --analytics-query/,
    'a query that exists only inside a comment must not be accepted as the detector',
  );
});

test('MASKED: a //-commented KQL predicate is not counted', () => {
  const q = "T | where Log_s contains 'real' // and Log_s contains 'commented_out'\n| count";
  assert.deepEqual(logPredicates(stripKqlComments(q)).map((p) => p.literal), ['real']);
});

test('MASKED: a // inside a quoted literal is preserved, not treated as a comment', () => {
  const q = "T | where Log_s contains 'https://example.test/cb' | count";
  assert.deepEqual(
    logPredicates(stripKqlComments(q)).map((p) => p.literal),
    ['https://example.test/cb'],
    'stripping comments must not corrupt a literal that legitimately contains //',
  );
});

// ---------------------------------------------------------------------------
// az `-o tsv` null → the literal string "None" (#2857 secondary)
// ---------------------------------------------------------------------------

test('an unresolvable workspace arriving as "None" is unknown, not "resolved"', () => {
  const r = runVerdict({ LH_LAW: 'None', LH_HITS_RAW: '', LH_MIN_END: FAR_FUTURE });
  assert.equal(r.code, 0, '"could not check" must never fail the verify');
  assert.match(
    r.out,
    /::warning::could not resolve the console Log Analytics workspace/,
    'az -o tsv renders a null result as the literal "None"; treating it as a resolved workspace ' +
      'points triage at "no Log Analytics Reader" when the real problem is "no workspace found"',
  );
  assert.doesNotMatch(r.out, /resolved the workspace but could NOT read/);
});

test('CONTROL: a real workspace id is still treated as resolved', () => {
  const r = runVerdict({ LH_LAW: 'ws-guid', LH_HITS_RAW: '', LH_MIN_END: FAR_FUTURE });
  assert.equal(r.code, 0);
  assert.match(r.out, /resolved the workspace but could NOT read the invalid_client count/);
});
