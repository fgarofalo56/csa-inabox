#!/usr/bin/env node
/**
 * check-required-lane-concurrency — MUTATION PROOFS. (refs #3426)
 *
 * The scan that FOUND this defect was written twice. The first version read
 * `group:` and `cancel-in-progress:` with a plain regex and reported trivy.yml
 * as RISKY — from a line inside a COMMENT that quoted the old broken config,
 * and rag-reindex.yml as RISKY from `false  # don't cancel mid-embed`, which is
 * false. Two false positives out of 17, both from comment blindness. So the
 * comment handling is not incidental here; it is the thing most likely to make
 * this guard lie, and it is tested directly below.
 *
 * Run: node --test scripts/ci/__tests__/check-required-lane-concurrency.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripComments,
  parseRequiredManifest,
  parseConcurrency,
  judge,
} from '../check-required-lane-concurrency.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

test('stripComments removes YAML comments without eating a mid-token #', () => {
  assert.equal(stripComments('  cancel-in-progress: false  # keep it'), '  cancel-in-progress: false');
  assert.equal(stripComments('# whole line'), '');
  assert.equal(stripComments('  group: a-b'), '  group: a-b');
  // A `#` with no preceding whitespace is not a comment in YAML.
  assert.equal(stripComments('  group: sha#frag'), '  group: sha#frag');
});

test('the REQUIRED manifest parses to the 14 declared contexts across 4 producers', () => {
  const m = parseRequiredManifest(readFileSync(path.join(WORKFLOWS, 'release-please.yml'), 'utf8'));
  assert.equal(m.length, 14, `expected 14 required contexts, parsed ${m.length}`);
  const producers = [...new Set(m.map((x) => x.workflow))].sort();
  assert.deepEqual(producers, [
    'fiab-console-ci.yml',
    'loom-guardrails.yml',
    'test.yml',
    'validate.yml',
  ]);
  assert.ok(m.some((x) => x.context === 'guardrails' && x.workflow === 'loom-guardrails.yml'));
  assert.ok(m.filter((x) => x.workflow === 'test.yml').length === 7, 'test.yml publishes 7 required contexts');
});

test('the manifest parser ignores a commented-out entry', () => {
  const src = [
    '          REQUIRED=(',
    '            "Real Context|real.yml"',
    '            # "Retired Context|gone.yml"',
    '          )',
  ].join('\n');
  const m = parseRequiredManifest(src);
  assert.deepEqual(m, [{ context: 'Real Context', workflow: 'real.yml' }]);
});

test('parseConcurrency reads the real block, not a comment quoting an old one', () => {
  // This is trivy.yml's exact shape after #3424: the fixed config, preceded by
  // a comment that QUOTES the broken config it replaced.
  const src = [
    'on:',
    '  push:',
    '',
    'concurrency:',
    '  # #3423 — this was `group: <workflow>-<ref>` + `cancel-in-progress: true`.',
    '  # Every push to main shared refs/heads/main.',
    "  group: ${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'push' && github.sha || '' }}",
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    '',
    'permissions:',
    '  contents: read',
  ].join('\n');
  const c = parseConcurrency(src);
  assert.ok(c.present);
  assert.ok(c.group.includes('github.sha'), `group was read from a comment: ${c.group}`);
  assert.equal(c.cancelInProgress, "${{ github.event_name == 'pull_request' }}");
  assert.equal(judge(c).ok, true);
});

test('parseConcurrency stops at the next top-level key', () => {
  const src = ['concurrency:', '  group: a', 'jobs:', '  build:', '    group: NOT-THIS'].join('\n');
  assert.equal(parseConcurrency(src).group, 'a');
});

test('judge — the four verdicts', () => {
  assert.equal(judge({ present: false, group: null, cancelInProgress: null }).ok, true);
  assert.equal(judge({ present: true, group: 'x-${{ github.ref }}', cancelInProgress: 'false' }).ok, true);
  // `false` with a trailing comment already stripped — rag-reindex.yml's shape.
  assert.equal(judge(parseConcurrency(['concurrency:', '  group: g-${{ github.ref }}', "  cancel-in-progress: false  # don't cancel mid-embed"].join('\n'))).ok, true);
  assert.equal(judge({ present: true, group: 'x-${{ github.ref }}-${{ github.sha }}', cancelInProgress: 'true' }).ok, true);

  // THE DEFECT. This is the exact config all three required lanes carried.
  const bad = judge({ present: true, group: 'x-${{ github.ref }}', cancelInProgress: 'true' });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /CANCELS this commit's run/);
});

test('every required-context producer in the REAL tree renders a verdict per commit', () => {
  const m = parseRequiredManifest(readFileSync(path.join(WORKFLOWS, 'release-please.yml'), 'utf8'));
  const producers = [...new Set(m.map((x) => x.workflow))];
  assert.ok(producers.length >= 4, 'embedded control: the manifest must yield producers to check');
  for (const wf of producers) {
    const v = judge(parseConcurrency(readFileSync(path.join(WORKFLOWS, wf), 'utf8')));
    assert.equal(v.ok, true, `${wf}: ${v.why}`);
  }
});

/**
 * Re-introduce the pre-#3426 config in a workflow's real text, CRLF-safely.
 * A regex spanning the whole block was tried first and silently matched
 * NOTHING on this checkout (core.autocrlf=true puts a \r before every \n) —
 * which the control below caught, because a mutation that does not apply
 * proves nothing.
 */
function reBreak(src) {
  const lines = src.split(/\r?\n/);
  const at = lines.findIndex((l) => /^concurrency:\s*$/.test(l));
  assert.ok(at >= 0, 'no top-level concurrency block to re-break');
  let hitGroup = false;
  let hitCancel = false;
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break;
    if (/^\s+group:/.test(lines[i])) {
      lines[i] = '  group: ${{ github.workflow }}-${{ github.ref }}';
      hitGroup = true;
    } else if (/^\s+cancel-in-progress:/.test(lines[i])) {
      lines[i] = '  cancel-in-progress: true';
      hitCancel = true;
    }
  }
  assert.ok(hitGroup && hitCancel, 'the mutation did not apply — this control proves nothing');
  return lines.join('\n');
}

test('the guard is NOT vacuous — it fails the tree it was written against', () => {
  // Non-weakening control: re-introduce the pre-#3426 config for each of the
  // three lanes and confirm the judgement flips. A guard whose verdict does not
  // change when you re-break the thing it watches is not watching it.
  for (const wf of ['loom-guardrails.yml', 'test.yml', 'validate.yml']) {
    const src = readFileSync(path.join(WORKFLOWS, wf), 'utf8');
    assert.equal(judge(parseConcurrency(src)).ok, true, `${wf} should be compliant before mutation`);
    const v = judge(parseConcurrency(reBreak(src)));
    assert.equal(v.ok, false, `${wf}: re-broken config still judged OK — the guard is blind`);
    assert.match(v.why, /CANCELS this commit's run/);
  }
});
