// UNMASKED bare-G2-gate ratchet for apps/fiab-console/lib/editors/foundry-sub-editors.tsx.
//
// WHY THIS FILE EXISTS — a fix that no CI check could tell from a mask.
//
// `scanSource` in check-honest-gate-coverage.mjs ends with
//
//     return { honestGate, bareGates: honestGate > 0 ? [] : bareGates };
//
// so ONE `<HonestGate>` anywhere in a file zeroes that file's ENTIRE bare-gate
// count. #4313 added its first `<HonestGate>` to this module for a NEW surface
// (svc-aoai, the AI Search vectorizer). That emptied the file's reported
// bareGates and forced its baseline key to be deleted — while the two bars the
// baseline actually recorded were untouched and byte-identical to main. Round 6
// then converted one of them (`LOOM_AI_SEARCH_SERVICE` in AiSearchBindPicker)
// to a real `<HonestGate gateId="svc-aisearch">`.
//
// The round-7 review measured the hole that leaves: reverting that conversion
// back to a bare `<MessageBar>` naming `LOOM_AI_SEARCH_SERVICE` left
// `check-honest-gate-coverage.mjs` at RC=0 — the sibling svc-aoai gate still
// fires the short-circuit and the baseline key is gone, so nothing in CI could
// notice the fix being undone. "Disclosed" and "ratcheted" are different states;
// this spec is the ratchet.
//
// It drives the guard's OWN exported `scanSource` over the real file twice:
// as-is (the masked view CI sees) and with the `<HonestGate` token renamed so
// the short-circuit cannot fire (the UNMASKED view, the only one that can tell
// a fix from a mask). The unmasked set is pinned EXACTLY — `LOOM_DRIFT_MONITOR`
// only, the Dataset editor's quality-tab bar, which has no gate-registry entry
// yet and is tracked as #4359. Any bar added, and any bar converted back to
// bare, fails here.
//
// The short-circuit itself is the wider defect: EVERY file mounting a first
// `<HonestGate>` silently leaves the ratchet for all of its other gates, and
// nobody has measured how large that population is. Also #4359. This spec fences
// one file, not the class.
//
// Run: node --test scripts/ci/__tests__/foundry-sub-editors-unmasked-bare-gates.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanSource } from '../check-honest-gate-coverage.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REL = 'apps/fiab-console/lib/editors/foundry-sub-editors.tsx';
const SRC = fs.readFileSync(path.join(REPO_ROOT, REL), 'utf-8');

/** The guard's view with its `honestGate > 0` short-circuit defused. */
function unmasked(text) {
  return scanSource(REL, text.replace(/<HonestGate\b/g, '<HonestGateMasked_'));
}

/**
 * POSITIVE CONTROL. If the file ever stops containing a `<HonestGate>`, the
 * masked/unmasked distinction this whole spec rests on is vacuous and every
 * assertion below would pass by measuring nothing.
 */
test('the file really is masked — it mounts at least one <HonestGate>', () => {
  assert.equal(scanSource(REL, SRC).honestGate, 1, `${REL} mounts no <HonestGate>; this spec measures nothing`);
  assert.equal(unmasked(SRC).honestGate, 0, 'the mask-defusing rewrite did not take');
});

/**
 * SECOND POSITIVE CONTROL. The scanner must be able to SEE a bare gate in this
 * file at all — otherwise "exactly one" below could be an artefact of a
 * detector that matches nothing here.
 */
test('the scanner can see a bare gate in this file when one is added', () => {
  const withExtra = SRC.replace(
    '<Subtitle2>New evaluation</Subtitle2>',
    '<MessageBar intent="warning"><MessageBarBody>Set LOOM_PROBE_ONLY to continue.</MessageBarBody></MessageBar>'
    + '<Subtitle2>New evaluation</Subtitle2>',
  );
  assert.notEqual(withExtra, SRC, 'the probe anchor moved — this control is no longer inserting anything');
  const vars = unmasked(withExtra).bareGates.map((g) => g.envVar);
  assert.ok(vars.includes('LOOM_PROBE_ONLY'), `injected bare gate not detected; saw ${JSON.stringify(vars)}`);
});

/**
 * THE RATCHET. Exactly one bare G2 bar survives in this module, and it is the
 * one #4359 tracks. Converting LOOM_AI_SEARCH_SERVICE back to a bare MessageBar
 * — the mutation the round-7 review ran, which left the guard itself green —
 * makes this list two entries long and fails here.
 */
test('exactly one bare G2 remediation bar survives, unmasked: LOOM_DRIFT_MONITOR (#4359)', () => {
  const found = unmasked(SRC).bareGates;
  assert.deepEqual(
    found.map((g) => g.envVar).sort(),
    ['LOOM_DRIFT_MONITOR'],
    `unmasked bare gates in ${REL}: ${JSON.stringify(found)}\n`
    + 'A NEW entry means a bare remediation bar was added behind the <HonestGate> mask — route it through '
    + '<HonestGate gateId="…"> instead. LOOM_AI_SEARCH_SERVICE reappearing means the round-6 fix was reverted.',
  );
});

/**
 * And the masked view — what check-honest-gate-coverage.mjs actually reports —
 * stays empty, so this file's DELETED baseline key remains correct. Pinning both
 * views keeps the disclosure in the PR body true: the guard's green is a mask,
 * and the assertion above is what holds the line underneath it.
 */
test('the masked view is empty, which is why this file has no baseline key', () => {
  assert.deepEqual(scanSource(REL, SRC).bareGates, []);
});
