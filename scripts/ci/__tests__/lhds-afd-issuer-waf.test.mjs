/**
 * LHDS issuer WAF: narrow SMART/OAuth exclusions on the dedicated Front Door policy (waflhdsauth*).
 *
 * Defect (measured 2026-11-26, Front Door WAF log in law-csa-loom-centralus, tracking ref
 * 20261126T224811Z-165649489d9qllrghC1BL1xk1s00000017tg0000000041h0): the operator's first headed SMART
 * authorize GET /auth/{tenant}/authorize scored 15 (DRS 2.1 blocks at 5) and was refused by
 * BLOCKING-EVALUATION-949110. Contributing rows (MEASURED below): RFI-931130 and RFI-931100 on
 * redirect_uri, MS-ThreatIntel-SQLI-99031002 on scope ('patient/*.rs').
 *
 * Method, stated: compile platform/fiab/bicep/modules/health/afd-issuer.bicep with `az bicep build` (a
 * missing `az` FAILS the suite) and read the WAF resource from the compiled ARM. Nothing here deploys, so
 * nothing here proves Front Door accepts the policy or that a live authorize now passes; those stay
 * "merged, not deployed" until deploy-health has run and a headed authorize has been retried.
 *
 * Each test names the value that breaks it (assertion-design.md). LHDS_REPO_ROOT points the suite at a
 * sandbox copy for mutation runs.
 *
 * Run: node --test scripts/ci/__tests__/lhds-afd-issuer-waf.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.env.LHDS_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REL = 'platform/fiab/bicep/modules/health/afd-issuer.bicep';

function compile(rel) {
  const tmp = mkdtempSync(join(tmpdir(), 'lhds-afd-waf-'));
  try {
    const outFile = join(tmp, 'out.json');
    const r = spawnSync('az', ['bicep', 'build', '--file', resolve(root, rel), '--outfile', outFile], { encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(r.status, 0, `az bicep build ${rel} failed (guard cannot run): ${r.stderr}`);
    return JSON.parse(readFileSync(outFile, 'utf8'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const arm = compile(REL);
const resources = Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources);
const wafs = resources.filter((r) => r.type === 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies');

// Resolve a whole-value `[variables('x')]` reference; anything else is returned as-is.
const deref = (v) => {
  const m = typeof v === 'string' ? /^\[variables\('([A-Za-z0-9_]+)'\)\]$/.exec(v) : null;
  return m ? arm.variables[m[1]] : v;
};

// The measured log rows: rule group, rule id, the query argument it fired on.
const MEASURED = [
  { group: 'RFI', ruleId: '931130', arg: 'redirect_uri' },
  { group: 'RFI', ruleId: '931100', arg: 'redirect_uri' },
  { group: 'MS-ThreatIntel-SQLI', ruleId: '99031002', arg: 'scope' },
  // Entra's &clientdata on the /auth/{tenant}/callback redirect (#5279): 29 hits 2026-11-09..11, all on this rule.
  { group: 'SQLI', ruleId: '942120', arg: 'clientdata' },
];

// The complete allowed exclusion map, rule id -> query arg names. Anything wider fails test 1.
const EXPECTED = {
  RFI: { '931100': ['redirect_uri'], '931130': ['aud', 'redirect_uri'] },
  'MS-ThreatIntel-SQLI': { '99031002': ['code', 'code_challenge', 'launch', 'req', 'scope', 'state'] },
  SQLI: { '942120': ['clientdata'] },
};

function allSets() {
  assert.equal(wafs.length, 1, `expected exactly one WAF policy in ${REL}, found ${wafs.length}`);
  return deref(wafs[0].properties.managedRules.managedRuleSets) ?? [];
}

function drs() {
  const set = allSets().find((s) => s.ruleSetType === 'Microsoft_DefaultRuleSet');
  assert.ok(set, 'Microsoft_DefaultRuleSet missing from the issuer policy');
  return set;
}

// Flatten to { group, ruleId, rule, exclusions } for every rule override in EVERY managed rule set, so an override
// added to a second set (e.g. a re-added Bot Manager set) is still seen by the exact-map check.
function ruleOverrides() {
  return allSets().flatMap((s) =>
    (deref(s.ruleGroupOverrides) ?? []).flatMap((g) => (g.rules ?? []).map((r) => ({ set: s.ruleSetType, group: g.ruleGroupName, ruleId: r.ruleId, rule: r, exclusions: r.exclusions ?? [] }))),
  );
}

// Would Front Door skip this (rule, arg) detection? Mirrors the exclusion semantics used here: Equals on the arg name.
function isExcluded(ruleId, arg) {
  return ruleOverrides().some((o) => o.ruleId === ruleId && o.exclusions.some((e) => e.matchVariable === 'QueryStringArgNames' && e.selectorMatchOperator === 'Equals' && e.selector === arg));
}

test('(a) exclusions sit at RULE scope, by exact query-arg NAME, and are exactly the allowed map', () => {
  const got = {};
  for (const o of ruleOverrides()) {
    for (const e of o.exclusions) {
      // Breaks on any other operator (Contains / StartsWith / EqualsAny widens to unnamed args) or matchVariable
      // (RequestHeaderNames, RequestCookieNames, RequestBodyPostArgNames are not what was measured).
      assert.equal(e.matchVariable, 'QueryStringArgNames', `rule ${o.ruleId}: matchVariable ${e.matchVariable}`);
      assert.equal(e.selectorMatchOperator, 'Equals', `rule ${o.ruleId}: operator ${e.selectorMatchOperator}`);
    }
    // Breaks if an exclusion sits on an override in any set other than the DRS (the map below is keyed by group only).
    if (o.exclusions.length) assert.equal(o.set, 'Microsoft_DefaultRuleSet', `exclusion on rule ${o.ruleId} in set ${o.set}`);
    if (o.exclusions.length) ((got[o.group] ??= {})[o.ruleId] = o.exclusions.map((e) => e.selector).sort());
  }
  // Breaks if: the scope exclusion is dropped ('scope' missing under 99031002); a new rule id gets an exclusion
  // (e.g. 942100); a new arg is added (e.g. client_id); aud moves onto 99031002; a group name is misspelled
  // ('APPLICATION-ATTACK-RFI' is the CRS name, not the DRS 2.1 ruleGroupName 'RFI').
  assert.deepEqual(got, EXPECTED);
});

test('(a) every override keeps its rule ON: enabledState Enabled + AnomalyScoring (an omitted enabledState DISABLES the rule)', () => {
  const overrides = ruleOverrides();
  // Positive control: the three measured rules are overridden at all (an empty list would pass the loop below).
  assert.deepEqual(overrides.map((o) => o.ruleId).sort(), ['931100', '931130', '942120', '99031002']);
  for (const o of overrides) {
    // Breaks on a deleted enabledState (ARM defaults a rule override to Disabled, which turns the rule off for ALL
    // args) or enabledState 'Disabled', and on action 'Log' / 'Allow'.
    assert.equal(o.rule.enabledState, 'Enabled', `rule ${o.ruleId} enabledState`);
    assert.equal(o.rule.action, 'AnomalyScoring', `rule ${o.ruleId} action`);
  }
});

test('(a)+(d) the measured rows are excluded; the same rules still inspect other args; redirect_uri and scope are covered', () => {
  for (const m of MEASURED) {
    // Breaks if any measured (rule, arg) pair loses its exclusion: that row alone scores 5 and blocks again.
    assert.equal(isExcluded(m.ruleId, m.arg), true, `measured ${m.group}-${m.ruleId} on ${m.arg} is not excluded`);
  }
  // Negative controls: the exclusion is per rule, per name. Breaks if client_id or nonce were added to 99031002, if
  // redirect_uri were excluded from SQLi 99031002 or from CRS SQLi 942100, or if scope were excluded from RFI.
  assert.equal(isExcluded('99031002', 'client_id'), false);
  assert.equal(isExcluded('99031002', 'nonce'), false);
  assert.equal(isExcluded('99031002', 'redirect_uri'), false);
  assert.equal(isExcluded('942100', 'redirect_uri'), false);
  assert.equal(isExcluded('931130', 'scope'), false);
  // aud stays on the RFI rules only (an off-domain https URL; no SQL-comment reason). Breaks if aud lands on 99031002.
  assert.equal(isExcluded('931130', 'aud'), true);
  assert.equal(isExcluded('99031002', 'aud'), false);
  // clientdata is excluded from 942120 only. Breaks if it lands on 99031002 or on another CRS SQLi rule (942100).
  assert.equal(isExcluded('99031002', 'clientdata'), false);
  assert.equal(isExcluded('942100', 'clientdata'), false);
  // The picker hop: req is covered on 99031002 (predicted). Breaks if req is dropped.
  assert.equal(isExcluded('99031002', 'req'), true);
});

test('(b) NO policy-wide, rule-set-wide or rule-group-wide exclusion', () => {
  const managed = wafs[0].properties.managedRules;
  // Breaks on managedRules.exclusions (rejected by the schema today, but checked so a future API cannot slip it in).
  assert.equal(Object.hasOwn(managed, 'exclusions'), false, 'managedRules.exclusions present');
  for (const set of allSets()) {
    // Breaks on managedRuleSets[].exclusions on ANY set: every rule in that set would skip the arg.
    assert.equal((deref(set.exclusions) ?? []).length, 0, `rule-set-wide exclusions on ${set.ruleSetType}: ${JSON.stringify(set.exclusions)}`);
    for (const g of deref(set.ruleGroupOverrides) ?? []) {
      // Breaks on ruleGroupOverrides[].exclusions: every rule in that group would skip the arg.
      assert.equal((g.exclusions ?? []).length, 0, `group-wide exclusions on ${set.ruleSetType}/${g.ruleGroupName}`);
    }
  }
  // Positive pair: rule-scope exclusions DO exist (a deleted override list would pass the absence checks above).
  assert.ok(ruleOverrides().some((o) => o.exclusions.length > 0), 'no rule-scope exclusions found');
});

test('(c) still Prevention, DRS 2.1, ruleSetAction Block, body inspection off (so no body-arg exclusions are needed)', () => {
  const p = wafs[0].properties.policySettings;
  // Breaks on Detection (logs and blocks nothing) and on enabledState Disabled.
  assert.equal(p.mode, 'Prevention');
  assert.equal(p.enabledState, 'Enabled');
  // Breaks if a second managed rule set is added: its overrides and exclusions would sit outside the DRS-only reasoning
  // in afd-issuer.bicep (and Bot Manager, the likeliest addition, would block the issuer's machine clients).
  assert.deepEqual(allSets().map((s) => s.ruleSetType), ['Microsoft_DefaultRuleSet']);
  const set = drs();
  // Breaks on 2.0 / 2.2 (rule ids and group names differ per version; these exclusions are 2.1-specific) and on
  // ruleSetAction Log.
  assert.equal(set.ruleSetVersion, '2.1');
  assert.equal(set.ruleSetAction, 'Block');
  // Breaks on 'Enabled': the token POST (client_assertion, code, code_verifier, refresh_token, redirect_uri, scope)
  // would then be inspected with NO RequestBodyPostArgNames exclusions, and SMART token exchange would start failing.
  assert.equal(p.requestBodyCheck, 'Disabled');
});
