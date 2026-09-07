#!/usr/bin/env node
/**
 * CI HELPER: whatif-drift-verdict  (single source for both what-if lanes)
 * ------------------------------------------------------------------------
 * Turns an `az deployment sub what-if --no-pretty-print` JSON document into a
 * TRUSTWORTHY drift verdict:
 *
 *   1. NOISE FILTER — ARM what-if reports a property as "deleted" whenever the
 *      live resource carries a value the template does not declare, even when
 *      that value is read-only or a server-applied default that a redeploy
 *      would re-apply verbatim. Microsoft calls this out explicitly:
 *        "Properties can be incorrectly reported as deleted when they aren't in
 *         the Bicep file, but are automatically set during deployment as default
 *         values. This result is considered 'noise' in the what-if response."
 *        https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-what-if
 *      scripts/ci/whatif-noise-allowlist.json enumerates those properties per
 *      resource type, each with a schema-grounded reason. Suppression is
 *      conservative by construction:
 *        - only propertyChangeType Delete / NoEffect is ever suppressible;
 *          a Create or Modify on a property is a real template-vs-live conflict
 *        - a resource is only dropped from the verdict when EVERY one of its
 *          property deltas is allowlisted
 *        - a rule path may carry `*` for an ARM array index; `*` matches ONLY
 *          digits (`.0` or `[0]`), never a property name, so it cannot be used
 *          to blanket a subtree
 *        - a rule whose `reason` justifies suppression with the value the
 *          property was MEASURED to hold must ALSO carry a value predicate
 *          (`whenBeforeEquals` / `whenBeforeIn`), which this matcher checks
 *          against the delta's own `before`. Without it a path-only match
 *          suppresses the property at EVERY value, including the one the reason
 *          says it can never hold — e.g. the APIM legacy-protocol toggles are
 *          allowlisted because ARM defaults them to the SECURE 'False', and a
 *          path-only rule would have hidden a live 'True' (SSL 3.0 actually
 *          ENABLED) just as quietly. That is both a detection regression and a
 *          deploy-integrity R7 violation: the reason would assert a condition
 *          the code never established.
 *        - every suppressed delta is still printed, so it is auditable
 *
 *   2. COVERAGE — what-if silently gives up on nested deployments whose
 *      parameters it cannot evaluate (module outputs / reference()), emitting a
 *      `NestedDeploymentShortCircuited` diagnostic and marking the whole
 *      module's resources `Ignore`. A lane that only counts Create/Delete/
 *      Modify therefore reports "clean" for estate it never looked at. This
 *      script surfaces evaluated-vs-short-circuited counts so the blind spot is
 *      visible instead of being mistaken for a pass.
 *
 * USAGE
 *   node scripts/ci/whatif-drift-verdict.mjs <whatif.json> [--out-dir DIR]
 *                                            [--label commercial|gov|pr]
 * OUTPUTS (in --out-dir, default alongside the input)
 *   drift-list.txt        real drift  — "changeType<TAB>resourceId"
 *   suppressed-list.txt   filtered noise, with the matched reason
 *   summary.md            the markdown block written to $GITHUB_STEP_SUMMARY
 * Also appends to $GITHUB_OUTPUT (counts, drift_count, suppressed_count,
 * shortcircuit_count, evaluated_count, status, drift_list, suppressed_list,
 * shortcircuit_list, coverage_note) and $GITHUB_STEP_SUMMARY when set.
 *
 * EXIT CODES
 *   0  clean (zero REAL deltas — noise may have been suppressed)
 *   1  real drift
 *   2  unusable input (what-if failed / malformed JSON)
 *
 * Runbook: docs/fiab/runbooks/bicep-drift.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = path.join(HERE, 'whatif-noise-allowlist.json');

const SUPPRESSIBLE_PROPERTY_CHANGE_TYPES = new Set(['Delete', 'NoEffect']);
const DRIFT_CHANGE_TYPES = new Set(['Create', 'Delete', 'Modify']);
const MAX_LIST_LINES = 200;

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    opts[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  } else {
    positional.push(argv[i]);
  }
}
const inputPath = positional[0];
if (!inputPath) {
  console.error('usage: whatif-drift-verdict.mjs <whatif.json> [--out-dir DIR] [--label NAME]');
  process.exit(2);
}
const label = opts.label || 'whatif';
const outDir = opts['out-dir'] || path.dirname(path.resolve(inputPath));

// ---------------------------------------------------------------- load
let doc;
try {
  doc = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (err) {
  console.error(`::error::[${label}] what-if output is not parseable JSON (${err.message}) — the drift verdict is UNKNOWN.`);
  process.exit(2);
}
if (!Array.isArray(doc.changes)) {
  console.error(`::error::[${label}] what-if output has no .changes array — the drift verdict is UNKNOWN.`);
  process.exit(2);
}

const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).resourceTypes || {};
const allowlistByType = new Map(
  Object.entries(allowlist).map(([type, rules]) => [type.toLowerCase(), rules]),
);

// ---------------------------------------------------------------- helpers
function resourceTypeOf(change) {
  const declared = change.after?.type || change.before?.type;
  if (declared) return String(declared);
  const m = /\/providers\/(.+)$/.exec(change.resourceId || '');
  if (!m) return '';
  // ".../providers/<ns>/<type>/<name>[/<subtype>/<name>...]" -> "<ns>/<type>[/<subtype>]"
  const segs = m[1].split('/');
  const parts = [segs[0]];
  for (let i = 1; i < segs.length; i += 2) parts.push(segs[i]);
  return parts.join('/');
}

/** Flatten a what-if delta tree into leaf-ish entries with absolute paths. */
function flattenDelta(delta, prefix = '') {
  const out = [];
  for (const d of delta || []) {
    const full = prefix ? `${prefix}.${d.path}` : String(d.path ?? '');
    if (Array.isArray(d.children) && d.children.length > 0) {
      out.push(...flattenDelta(d.children, full));
    } else {
      out.push({ path: full, propertyChangeType: d.propertyChangeType, before: d.before, after: d.after });
    }
  }
  return out;
}

/**
 * A rule path may carry `*` in place of an ARM array index, because what-if
 * emits one delta per element: `properties.logs.0.retentionPolicy.days`,
 * `properties.logs.1.…`, and so on. Without this a per-element server default
 * would need one allowlist entry per index, which is unmaintainable and would
 * silently stop matching the day the estate grows an extra log category.
 *
 * The wildcard is deliberately NARROW: `*` matches ONLY a numeric index, in
 * either shape ARM emits — a dotted segment (`.0`) or a bracket (`[0]`). It
 * never matches a property NAME, so `properties.*` cannot be used to blanket a
 * resource type. Everything else in the path is literal. A rule path that
 * needs a literal `*` is therefore not expressible; none of the ARM property
 * names in this estate contain one.
 */
const wildcardRuleCache = new Map();
function ruleMatchesPath(rulePath, entryPath) {
  if (!rulePath.includes('*')) return rulePath === entryPath;
  let re = wildcardRuleCache.get(rulePath);
  if (!re) {
    // Escape every regex metacharacter, then re-open the escaped `*` as \d+.
    const escaped = rulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`^${escaped.split('\\*').join('\\d+')}$`);
    wildcardRuleCache.set(rulePath, re);
  }
  return re.test(entryPath);
}

/**
 * Structural equality between a delta's `before` and a rule's expected literal.
 *
 * Deliberately STRICT: no coercion (0 !== '0', false !== 'false'), and objects
 * must have exactly the same key set. A rule that cites a measured value is
 * making a claim about a specific shape, so anything else must fall through to
 * "not suppressed". The failure direction is the safe one — a shape this does
 * not recognise stays in the drift verdict, visible, rather than being hidden.
 */
function valueEquals(actual, expected) {
  if (actual === expected) return true;
  if (actual === null || expected === null) return false;
  if (typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const ka = Object.keys(actual);
  const kb = Object.keys(expected);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => Object.prototype.hasOwnProperty.call(expected, k) && valueEquals(actual[k], expected[k]),
  );
}

/** @returns {{suppressed: boolean, reason?: string}} */
function classifyDelta(resourceType, entry) {
  if (!SUPPRESSIBLE_PROPERTY_CHANGE_TYPES.has(entry.propertyChangeType)) return { suppressed: false };
  const rules = allowlistByType.get(resourceType.toLowerCase());
  if (!rules) return { suppressed: false };
  for (const rule of rules) {
    if (!ruleMatchesPath(rule.path, entry.path)) continue;
    // VALUE PREDICATE — the path matched, but a rule whose reason rests on the
    // property holding a particular server default only applies AT that value.
    if (Object.prototype.hasOwnProperty.call(rule, 'whenBeforeEquals')) {
      if (!valueEquals(entry.before, rule.whenBeforeEquals)) continue;
    }
    if (Array.isArray(rule.whenBeforeIn)) {
      if (!rule.whenBeforeIn.some((candidate) => valueEquals(entry.before, candidate))) continue;
    }
    if (Array.isArray(rule.whenBeforeKeysSubsetOf)) {
      const before = entry.before;
      if (!before || typeof before !== 'object' || Array.isArray(before)) continue;
      const allowed = new Set(rule.whenBeforeKeysSubsetOf);
      if (!Object.keys(before).every((k) => allowed.has(k))) continue;
    }
    return { suppressed: true, reason: rule.reason };
  }
  return { suppressed: false };
}

// ---------------------------------------------------------------- classify
const realDrift = [];
const suppressed = [];
const counts = {};

for (const change of doc.changes) {
  counts[change.changeType] = (counts[change.changeType] || 0) + 1;
  if (!DRIFT_CHANGE_TYPES.has(change.changeType)) continue;

  const type = resourceTypeOf(change);

  // Only a Modify can be pure property noise. Create/Delete of a whole
  // resource is always real.
  if (change.changeType !== 'Modify') {
    realDrift.push({ change, type, unmatched: [] });
    continue;
  }

  const entries = flattenDelta(change.delta);
  if (entries.length === 0) {
    // Modify with no delta detail — cannot prove it is noise, so keep it.
    realDrift.push({ change, type, unmatched: [] });
    continue;
  }

  const unmatched = [];
  const matched = [];
  for (const entry of entries) {
    const verdict = classifyDelta(type, entry);
    if (verdict.suppressed) matched.push({ entry, reason: verdict.reason });
    else unmatched.push(entry);
  }

  if (unmatched.length === 0) suppressed.push({ change, type, matched });
  else realDrift.push({ change, type, unmatched });
}

// ---------------------------------------------------------------- coverage
const diagnostics = Array.isArray(doc.diagnostics) ? doc.diagnostics : [];
const shortCircuited = diagnostics.filter((d) => d.code === 'NestedDeploymentShortCircuited');
const evaluated = (counts.NoChange || 0) + (counts.Create || 0) + (counts.Delete || 0) + (counts.Modify || 0);
const ignored = counts.Ignore || 0;

// ---------------------------------------------------------------- render
const driftLines = realDrift.map(({ change, unmatched }) => {
  const paths = unmatched.slice(0, 6).map((u) => `${u.propertyChangeType}:${u.path}`).join(', ');
  return `${change.changeType}\t${change.resourceId}${paths ? `\t[${paths}]` : ''}`;
});
const suppressedLines = suppressed.map(({ change, type, matched }) =>
  `${change.resourceId}\t${type}\t${matched.map((m) => m.entry.path).join(', ')}`);
const shortCircuitLines = shortCircuited.map((d) => String(d.target || '').split('/deployments/').pop());

const status = realDrift.length > 0 ? 'Drift' : 'Clean';
const coverageNote =
  `evaluated ${evaluated} resource(s); ${ignored} Ignore; ${shortCircuited.length} nested deployment(s) short-circuited`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'drift-list.txt'), `${driftLines.slice(0, MAX_LIST_LINES).join('\n')}\n`);
fs.writeFileSync(path.join(outDir, 'suppressed-list.txt'), `${suppressedLines.slice(0, MAX_LIST_LINES).join('\n')}\n`);

const md = [];
md.push(`### [${label}] bicep-drift — ${realDrift.length} real delta(s), ${suppressed.length} what-if noise suppressed`);
md.push('');
md.push(`Change counts: \`${JSON.stringify(counts)}\``);
md.push(`Coverage: ${coverageNote}`);
md.push('');
if (driftLines.length > 0) {
  md.push('**Real drift**');
  md.push('```');
  md.push(driftLines.slice(0, MAX_LIST_LINES).join('\n'));
  md.push('```');
} else {
  md.push('**Real drift:** none.');
}
md.push('');
if (suppressedLines.length > 0) {
  md.push(`<details><summary>Suppressed as what-if noise (${suppressed.length}) — scripts/ci/whatif-noise-allowlist.json</summary>`);
  md.push('');
  md.push('```');
  md.push(suppressedLines.slice(0, MAX_LIST_LINES).join('\n'));
  md.push('```');
  md.push('</details>');
  md.push('');
}
if (shortCircuited.length > 0) {
  md.push(`> **Coverage gap — ${shortCircuited.length} nested deployment(s) short-circuited.** what-if could not expand these modules (their params come from module outputs / \`reference()\`), so their resources were reported \`Ignore\` and NOT compared. "Zero deltas" only covers the ${evaluated} resource(s) above. See docs/fiab/runbooks/bicep-drift.md#coverage.`);
  md.push('');
  md.push('<details><summary>Short-circuited nested deployments</summary>');
  md.push('');
  md.push('```');
  md.push(shortCircuitLines.slice(0, MAX_LIST_LINES).join('\n'));
  md.push('```');
  md.push('</details>');
}
const summaryMd = md.join('\n');
fs.writeFileSync(path.join(outDir, 'summary.md'), `${summaryMd}\n`);

// ---------------------------------------------------------------- emit
function appendOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delim = `EOF_${key.toUpperCase()}_${process.pid}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<${delim}\n${value}\n${delim}\n`);
}
appendOutput('status', status);
appendOutput('counts', JSON.stringify(counts));
appendOutput('drift_count', String(realDrift.length));
appendOutput('suppressed_count', String(suppressed.length));
appendOutput('shortcircuit_count', String(shortCircuited.length));
appendOutput('evaluated_count', String(evaluated));
appendOutput('coverage_note', coverageNote);
appendOutput('drift_list', driftLines.slice(0, MAX_LIST_LINES).join('\n'));
appendOutput('suppressed_list', suppressedLines.slice(0, MAX_LIST_LINES).join('\n'));
appendOutput('shortcircuit_list', shortCircuitLines.slice(0, MAX_LIST_LINES).join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMd}\n`);
}

console.log(summaryMd);

if (shortCircuited.length > 0) {
  console.log(`::warning::[${label}] what-if coverage gap — ${shortCircuited.length} nested deployment(s) short-circuited; ${evaluated} resource(s) actually compared. A clean verdict does not cover the short-circuited modules.`);
}
if (suppressed.length > 0) {
  console.log(`::notice::[${label}] ${suppressed.length} Modify delta(s) suppressed as documented ARM what-if noise (read-only / server-defaulted properties). See suppressed-list.txt.`);
}
if (realDrift.length > 0) {
  console.log(`::error::[${label}] UNMANAGED DRIFT — ${realDrift.length} real Create/Delete/Modify delta(s) between platform/fiab/bicep and the live estate. Runbook: docs/fiab/runbooks/bicep-drift.md`);
  process.exit(1);
}
console.log(`::notice::[${label}] estate matches IaC — zero real deltas (${coverageNote}).`);
process.exit(0);
