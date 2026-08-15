// Behaviour tests for scripts/ci/check-no-freeform.mjs.
//
// The guard this replaced reported `0 candidate raw-JSON-config surfaces` on a
// tree carrying SIX operator-filed hand-typed-infrastructure surfaces, because
// its vocabulary was four tags in one directory and `<Input>` was not among
// them. So the tests that matter most are not "does it pass" — it passed for
// months — but:
//
//   1. can it reproduce the six incidents (CONTROLS, asserted individually so a
//      failure names WHICH incident regressed rather than a count);
//   2. does it FAIL when it should, in both ratchet directions;
//   3. do its floors fire, so a detector that stopped detecting cannot read as
//      a clean sweep.
//
// Run: node --test scripts/ci/__tests__/no-freeform.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CONTROLS,
  SHAPE_PATTERNS,
  analyze,
  collect,
  extractSites,
  judge,
  maskJsx,
  selfTest,
} from '../check-no-freeform.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'ci', 'check-no-freeform.mjs');

/**
 * The ratchet tests must clear the guard's own MIN_LIVE_SITES floor, or every
 * one of them fails for the wrong reason and a real ratchet regression would be
 * invisible behind a floor message. Both helpers inject the same filler key, so
 * the floor is satisfied while the key under test stays the only variable.
 */
const FLOOR_KEY = 'zz-floor-filler.tsx';
const FLOOR_N = 400;

/** A throwaway baseline file, so a ratchet property never touches the real one. */
function tmpBaseline(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-freeform-'));
  const file = path.join(dir, 'baseline.json');
  const doc = { _owner: 't', _why: 't', _unblock: 't', entries: { ...entries, [FLOOR_KEY]: FLOOR_N } };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

/** A measured population large enough to clear every floor. */
function measured(current) {
  return {
    files: new Array(1286).fill('x.tsx'),
    current: { ...current, [FLOOR_KEY]: FLOOR_N },
    detail: [],
    sites: 2298,
  };
}

// ── 1. importing the guard runs nothing (#3436) ────────────────────────────

test('importing the guard did NOT run its scan — this suite proves its own premise', () => {
  // Reaching this assertion at all is the proof: an unfenced main() would have
  // scanned the repo and process.exit()'d before node:test got here.
  assert.equal(typeof analyze, 'function');
});

// ── 2. the six incidents ───────────────────────────────────────────────────

test('every embedded control holds', () => {
  assert.deepEqual(selfTest(), []);
});

for (const c of CONTROLS.filter((x) => x.name.startsWith('OPERATOR'))) {
  test(`reproduces ${c.name}`, () => {
    const got = analyze(c.src).violations;
    assert.ok(got.length > 0, `the guard does NOT flag this surface — it is not measuring what motivated it`);
  });
}

test('the six operator-filed surfaces are flagged in the LIVE tree, not only as fixtures', () => {
  // A control set can pass on a synthetic copy of a defect while the real file
  // has drifted out of reach — the fixture-models-the-code failure. These
  // assertions read the actual files.
  const { detail } = collect();
  const at = (needle) => detail.filter((d) => d.f.includes(needle));
  const cases = [
    ['lib/editors/phase3/activator-editor.tsx', 'ADX cluster URI + Logic App ARM id'],
    ['lib/editors/palantir/health-check-editor.tsx', 'Logic App ARM id'],
    ['lib/editors/databricks/uc-dialogs.tsx', 'Databricks UC credential dialog'],
    ['app/catalog/unity/page.tsx', 'UC storage credential ARM id'],
    ['lib/editors/foundry-sub-editors.tsx', 'New evaluation azureml:// dataset id'],
    ['lib/editors/copilot-studio-editors.tsx', 'Copilot Studio knowledge-source URI'],
    ['lib/components/pipeline/manage-panel.tsx', 'descriptor-driven AccountKey= connection strings'],
  ];
  for (const [file, what] of cases) {
    assert.ok(at(file).length > 0, `${file} (${what}) is not flagged — the guard is blind to the incident again`);
  }
});

// ── 3. the JSX lexer ───────────────────────────────────────────────────────

test('maskJsx does not eat a JSX element after a self-closing `/>`', () => {
  // check-external-origin-urls' maskNonCode returns `<Input … /` + spaces here:
  // its regex-vs-division heuristic is TS-correct and JSX-hostile, and reusing
  // it silently halved site extraction.
  const masked = maskJsx('<Input value={a} onChange={f} /><Textarea value={b} onChange={f} />');
  assert.match(masked, /<Textarea/);
  assert.equal(extractSites('<Input value={a} onChange={f} /><Textarea value={b} onChange={f} />').length, 2);
});

test('maskJsx blanks a comment but preserves offsets, so annotations land on the right line', () => {
  const v = analyze('// <Input placeholder="abfss://x" />\n<Input placeholder="abfss://c@a.dfs.core.windows.net/p" value={v} onChange={f} />').violations;
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
});

test('maskJsx treats an intra-word apostrophe in JSX text as prose, not a string opener', () => {
  // With the apostrophe read as a string opener the mask runs to end of line and
  // takes `<Field label="` with it, so the whole element becomes unfindable.
  // String BODIES are blanked by design — the discriminator is that the element
  // STRUCTURE after the apostrophe survives.
  const masked = maskJsx("<Caption1>don't type this</Caption1><Field label=\"Cluster URI\">");
  assert.match(masked, /<Field label="/);
  assert.ok(analyze("<Caption1>don't type this</Caption1><Field label=\"Cluster URI\"><Input value={v} onChange={f} /></Field>").violations.length > 0);
});

test('a closed sibling <Field> cannot lend its label to the next input', () => {
  const v = analyze(
    '<Field label="Logic App resource id"><Input value={a} onChange={f} /></Field>\n<Field label="Display name"><Input value={b} onChange={f} /></Field>',
  ).violations;
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
});

// ── 4. the azure-host DNS-label boundary (#3560) ───────────────────────────

test('azure-host matches a real Azure FQDN in every position it appears in the corpus', () => {
  const re = SHAPE_PATTERNS.find((p) => p.id === 'azure-host').re;
  for (const s of [
    'https://<cluster>.<region>.kusto.windows.net',
    'e.g. adb-1234567890.19.azuredatabricks.net',
    'abfss://container@account.dfs.core.windows.net/path',
    'myserver.database.windows.net',
    'ws-ondemand.sql.azuresynapse.net (Synapse)',
    'myacr.azurecr.io/img:tag',
    'https://c.eastus.kusto.usgovcloudapi.net',
    'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=x',
    // sentence-final prose: the boundary must allow a trailing period
    'the host is a.dfs.core.windows.net. Then click save.',
  ]) {
    assert.ok(re.test(s), `azure-host no longer matches ${s} — detection coverage lost`);
  }
});

test('azure-host does NOT match a host that merely CONTAINS an Azure suffix', () => {
  // Every one of these matched before the DNS-label boundary was added, and the
  // pattern's own `why` says "an Azure service FQDN" — so this was a real
  // classifier defect, not only a CodeQL complaint.
  const re = SHAPE_PATTERNS.find((p) => p.id === 'azure-host').re;
  for (const s of [
    'x.azconfig.iowa',
    'y.azure-api.network',
    'z.cloudapp.azure.community',
    'q.kusto.windows.network',
    'r.azurehdinsight.networking',
    's.azuredatalakestore.networks',
    'https://loom.kusto.windows.net.evil.test/steal',
    'account.blob.core.windows.net.attacker.example',
  ]) {
    assert.equal(re.test(s), false, `azure-host still matches ${s} — the label boundary regressed`);
  }
});

// ── 5. the ratchet, both directions ────────────────────────────────────────

test('a NEW violation in a baselined file FAILS', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  const code = judge(measured({ 'a.tsx': 2 }), { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 1);
});

test('a violation in a file that is NOT baselined FAILS', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  const code = judge(measured({ 'a.tsx': 1, 'b.tsx': 1 }), { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 1);
});

test('a DRAINED baseline entry FAILS — a dead entry is cover for the next violation', () => {
  const file = tmpBaseline({ 'a.tsx': 1, 'b.tsx': 2 });
  const code = judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 1);
});

test('a PARTIAL fix (2 -> 1) passes — that is the ratchet working, not a regression', () => {
  const file = tmpBaseline({ 'a.tsx': 2 });
  const code = judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 0);
});

test('the boy-scout rule fails a baselined file that was touched but not cleared', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  const code = judge(measured({ 'a.tsx': 1 }), {
    argv: [],
    baselineFile: file,
    touchedFiles: new Set(['a.tsx']),
  });
  assert.equal(code, 1);
});

test('an unavailable base-ref diff SKIPS the boy-scout rule rather than failing spuriously', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  assert.equal(judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, touchedFiles: null }), 0);
});

// ── 6. the floors ──────────────────────────────────────────────────────────

test('FLOOR: a collapsed file enumeration FAILS instead of reporting a clean sweep', () => {
  const file = tmpBaseline({});
  const code = judge({ files: ['a.tsx'], current: {}, detail: [], sites: 2298 }, { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 1);
});

test('FLOOR: collapsed SITE extraction FAILS — the classifier reports a subset of sites, so this fires first', () => {
  const file = tmpBaseline({});
  const code = judge({ files: new Array(1286).fill('x'), current: {}, detail: [], sites: 3 }, { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 1);
});

test('FLOOR: a classifier that stopped classifying FAILS — a ratchet only fails on a RISE', () => {
  // Deliberately NOT `measured()`: the filler key exists to clear this floor, so
  // using it here would test nothing.
  const file = tmpBaseline({});
  const code = judge(
    { files: new Array(1286).fill('x'), current: { 'a.tsx': 1 }, detail: [], sites: 2298 },
    { argv: [], baselineFile: file, touchedFiles: null },
  );
  assert.equal(code, 1);
});

test('the floors are ordered so extraction breakage is reported BEFORE a classifier zero', () => {
  // Both are broken here; the message must name site extraction, because a
  // "only N sites classified" verdict from a scanner that extracted nothing
  // sends the reader at the classifier instead of the extractor.
  const file = tmpBaseline({});
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    judge({ files: new Array(1286).fill('x'), current: {}, detail: [], sites: 0 }, { argv: [], baselineFile: file, touchedFiles: null });
  } finally {
    console.error = orig;
  }
  assert.match(errs.join('\n'), /site extraction found only 0/);
});

// ── 7. end to end, as CI runs it ───────────────────────────────────────────

test('the guard passes on the current tree at its baseline', () => {
  const r = execFileSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  assert.match(r, /baseline holds/);
});

test('the measured population is real: hundreds of sites, and not everything is a violation', () => {
  const { files, current, sites } = collect();
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  assert.ok(files.length > 1000, `only ${files.length} tracked .tsx enumerated`);
  assert.ok(sites > 1800, `only ${sites} free-text sites extracted`);
  assert.ok(total > 200, `only ${total} violations classified`);
  // A classifier that flagged every free-text box would be useless in the other
  // direction: `<Input>` for a display name is correct and there are thousands.
  assert.ok(total < sites / 4, `${total}/${sites} sites flagged — the classifier is no longer discriminating`);
});
