#!/usr/bin/env node
/**
 * deploy-fiab-gcch must ADOPT the live Front Door vanity domain, never pass ''
 * over one that exists (deploy-integrity.md R1/R7, cloud-parity.md).
 *
 * front-door.bicep renders `customDomains: empty(vanityDomain) ? [] : [...]`, so
 * a Gov apply with no loomVanityDomain unbinds the live vanity host and the edge
 * serves the Front Door fallback certificate. deploy-fiab-commercial.yml carries
 * the adoption step; the Gov lane had none. Every assertion below lifts its
 * subject out of the workflow source (no transcribed step bodies) and names the
 * edit that turns it RED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF = process.env.GCCH_WORKFLOW_UNDER_TEST
  || resolve(ROOT, '.github/workflows/deploy-fiab-gcch.yml');
const src = readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

const STEP_NAME = 'Adopt the live vanity domain (never unbind it)';

/** The text of one `- name:` step, from its header to the next step header. */
function stepBody(name) {
  const start = src.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `step "${name}" is missing from the Gov workflow - deleting it re-opens the unbind defect`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n      - name: /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every `az deployment sub (what-if|create)` invocation, to its last line. */
function deployCommands() {
  const out = [];
  const re = /az deployment sub (what-if|create) \\\n((?:[ \t]+.*\\\n)*[ \t]+.*\n)/g;
  for (const m of src.matchAll(re)) out.push({ kind: m[1], text: m[0] });
  return out;
}

test('the adoption step exists and runs before the what-if', () => {
  const body = stepBody(STEP_NAME);
  assert.match(body, /id: vanity_domain/);
  assert.ok(
    src.indexOf(`- name: ${STEP_NAME}`) < src.indexOf('- name: Bicep what-if'),
    'adoption must precede the what-if, else the preview describes a different deployment than the apply',
  );
});

test('discovery reads the profile and customDomains via az rest, not az afd', () => {
  const body = stepBody(STEP_NAME);
  // Breaks if someone swaps in `az afd ...` (preview cdn extension, Gov lacks its api-version).
  assert.match(body, /az rest --method get --url "\$BASE\?\$API"/);
  assert.match(body, /customDomains\?\$API/);
  assert.match(body, /API="api-version=2021-06-01"/);
  assert.match(body, /az cloud show --query endpoints\.resourceManager/);
  const code = body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /\baz afd\b/, 'az afd pulls a preview extension Gov lacks');
});

test('it reads BOTH the host and the resource name (#3287)', () => {
  const body = stepBody(STEP_NAME);
  // Breaks if only the host is read: the apply then fails Conflict on a second customDomain.
  assert.match(body, /value\[0\]\.properties\.hostName/);
  assert.match(body, /value\[0\]\.name \|\| ''"[^\n]*VD_ERR/);
  assert.match(body, /VD_NAME="\$\(az rest/);
});

test('it fails closed on an unreadable profile and never discards stderr', () => {
  const body = stepBody(STEP_NAME);
  // Breaks if the `exit 1` after a failed read is removed (unknown would pass '' over a live domain).
  const refusals = body.match(/Refusing\.[^\n]*\n\s+exit 1/g) || [];
  assert.ok(refusals.length >= 3, `expected >=3 fail-closed refusals (group, profiles, customDomains), got ${refusals.length}`);
  assert.match(body, /\$\(head -c 400 "\$VD_ERR"\)/, 'the failure must quote the captured stderr');
  assert.doesNotMatch(body, /2>\s*\/dev\/null/);
  assert.doesNotMatch(body, /\|\|\s*true/);
});

test('every deployment command passes BOTH vanity parameters', () => {
  const cmds = deployCommands();
  // Breaks if the regex finds none (vacuous pass) - need the what-if AND the apply.
  assert.deepEqual(cmds.map((c) => c.kind).sort(), ['create', 'what-if']);
  for (const c of cmds) {
    assert.match(c.text, /--parameters loomVanityDomain="\$LOOM_VANITY_DOMAIN"/, `${c.kind} drops loomVanityDomain`);
    assert.match(c.text, /--parameters loomVanityCustomDomainName="\$LOOM_VANITY_CUSTOM_DOMAIN_NAME"/, `${c.kind} drops loomVanityCustomDomainName`);
  }
});

test('the step exports exactly the variables the deployment commands read', () => {
  const body = stepBody(STEP_NAME);
  for (const v of ['LOOM_VANITY_DOMAIN', 'LOOM_VANITY_CUSTOM_DOMAIN_NAME']) {
    assert.match(body, new RegExp(`echo "${v}=\\$`), `${v} is never exported to GITHUB_ENV`);
  }
});

test('the vanity_domain dispatch input exists, optional, with no default, and reaches the env', () => {
  assert.match(src, /\n      vanity_domain:\n(?:        .*\n)*?        required: false\n/);
  const input = src.match(/\n      vanity_domain:\n((?:        .*\n)+)/)[1];
  assert.doesNotMatch(input, /^\s+default:/m, 'a default would be passed over a live domain');
  assert.match(src, /CSA_LOOM_VANITY_DOMAIN: \$\{\{ inputs\.vanity_domain \}\}/);
});
