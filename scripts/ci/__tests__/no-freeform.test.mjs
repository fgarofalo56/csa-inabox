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
  ACCEPTED,
  CONTROLS,
  SHAPE_PATTERNS,
  analyze,
  applyAccepted,
  collect,
  extractSites,
  judge,
  maskJsx,
  selfTest,
  validateAccepted,
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
  const code = judge(measured({ 'a.tsx': 2 }), { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  assert.equal(code, 1);
});

test('a violation in a file that is NOT baselined FAILS', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  const code = judge(measured({ 'a.tsx': 1, 'b.tsx': 1 }), { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  assert.equal(code, 1);
});

test('a DRAINED baseline entry FAILS — a dead entry is cover for the next violation', () => {
  const file = tmpBaseline({ 'a.tsx': 1, 'b.tsx': 2 });
  const code = judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  assert.equal(code, 1);
});

test('a PARTIAL fix (2 -> 1) passes — that is the ratchet working, not a regression', () => {
  const file = tmpBaseline({ 'a.tsx': 2 });
  const code = judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  assert.equal(code, 0);
});

test('the boy-scout rule fails a baselined file that was touched but not cleared', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  const code = judge(measured({ 'a.tsx': 1 }), {
    argv: [],
    baselineFile: file, accepted: [],
    touchedFiles: new Set(['a.tsx']),
  });
  assert.equal(code, 1);
});

test('an unavailable base-ref diff SKIPS the boy-scout rule rather than failing spuriously', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  assert.equal(judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, accepted: [], touchedFiles: null }), 0);
});

// ── 6. the floors ──────────────────────────────────────────────────────────

test('FLOOR: a collapsed file enumeration FAILS instead of reporting a clean sweep', () => {
  const file = tmpBaseline({});
  const code = judge({ files: ['a.tsx'], current: {}, detail: [], sites: 2298 }, { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  assert.equal(code, 1);
});

test('FLOOR: collapsed SITE extraction FAILS — the classifier reports a subset of sites, so this fires first', () => {
  const file = tmpBaseline({});
  const code = judge({ files: new Array(1286).fill('x'), current: {}, detail: [], sites: 3 }, { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  assert.equal(code, 1);
});

test('FLOOR: a classifier that stopped classifying FAILS — a ratchet only fails on a RISE', () => {
  // Deliberately NOT `measured()`: the filler key exists to clear this floor, so
  // using it here would test nothing.
  const file = tmpBaseline({});
  const code = judge(
    { files: new Array(1286).fill('x'), current: { 'a.tsx': 1 }, detail: [], sites: 2298 },
    { argv: [], baselineFile: file, accepted: [], touchedFiles: null },
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
    judge({ files: new Array(1286).fill('x'), current: {}, detail: [], sites: 0 }, { argv: [], baselineFile: file, accepted: [], touchedFiles: null });
  } finally {
    console.error = orig;
  }
  assert.match(errs.join('\n'), /site extraction found only 0/);
});

// ── 7. the ACCEPTED table (wave 1B) ────────────────────────────────────────
//
// An accepted file leaves the ratchet entirely, so the ONLY thing watching it
// is `applyAccepted`. If these properties break, 34 sites across 19 files
// become unwatched and nothing anywhere says so.

test('every ACCEPTED entry satisfies its own rules — no entry without a reference or a site count', () => {
  assert.deepEqual(validateAccepted(), []);
});

test('validateAccepted REJECTS an entry with no reference — the rule is enforced, not documented', () => {
  const p = validateAccepted([{ file: 'a.tsx', sites: 1, kind: 'byo', why: 'because' }]);
  assert.equal(p.length, 1);
  assert.match(p[0], /no reference/);
});

test('validateAccepted REJECTS an entry with no site count — an acceptance is not a blanket amnesty', () => {
  const p = validateAccepted([{ file: 'a.tsx', kind: 'byo', ref: '#1', why: 'because' }]);
  assert.equal(p.length, 1);
  assert.match(p[0], /how many sites/);
});

test('validateAccepted REJECTS a duplicate file — two reasons for one file means neither is the reason', () => {
  const e = { file: 'a.tsx', sites: 1, kind: 'byo', ref: '#1', why: 'because' };
  assert.equal(validateAccepted([e, { ...e }]).length, 1);
});

test('a STALE acceptance FAILS — the file no longer classifies, so the entry is cover', () => {
  assert.equal(applyAccepted({}, [{ file: 'a.tsx', sites: 1, kind: 'byo', ref: '#1', why: 'w' }]).problems.length, 1);
});

test('a RISE inside an accepted file FAILS — a new hand-typed value is not covered by the old reason', () => {
  const { problems } = applyAccepted({ 'a.tsx': 2 }, [{ file: 'a.tsx', sites: 1, kind: 'byo', ref: '#1', why: 'w' }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /NEW hand-typed/);
});

test('a DRAIN inside an accepted file FAILS until the count is corrected by a human', () => {
  const { problems } = applyAccepted({ 'a.tsx': 3 }, [{ file: 'a.tsx', sites: 4, kind: 'byo', ref: '#1', why: 'w' }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cleared/);
});

test('an EXACT match passes and removes the file from the ratchet population', () => {
  const { remaining, problems } = applyAccepted(
    { 'a.tsx': 2, 'b.tsx': 5 },
    [{ file: 'a.tsx', sites: 2, kind: 'byo', ref: '#1', why: 'w' }],
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(remaining, { 'b.tsx': 5 });
});

test('judge() FAILS when the real ACCEPTED table does not match the measured tree', () => {
  const file = tmpBaseline({ 'a.tsx': 1 });
  // The real table names 19 files; none of them is in this synthetic map, so
  // every entry is stale and the run must refuse to judge.
  const code = judge(measured({ 'a.tsx': 1 }), { argv: [], baselineFile: file, touchedFiles: null });
  assert.equal(code, 1);
});

test('an accepted file is NOT in the regenerated baseline — otherwise it is counted twice', () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'ci', 'no-freeform-inputs-baseline.json'), 'utf8'),
  );
  for (const a of ACCEPTED) {
    assert.ok(!(a.file in baseline.entries), `${a.file} is both ACCEPTED and baselined`);
  }
});

test('every ACCEPTED file still classifies exactly the number of sites it claims', () => {
  const { current } = collect();
  for (const a of ACCEPTED) {
    assert.equal(current[a.file], a.sites, `${a.file}: ACCEPTED says ${a.sites}, classifier finds ${current[a.file]}`);
  }
});

// ── 8. the ACCEPTED reasons are still TRUE of the tree ─────────────────────
//
// `applyAccepted` keeps the COUNTS honest. Nothing keeps the REASONS honest,
// and a reason is what the acceptance is actually made of — #3531's lesson is
// that an exception survives on the strength of having once been reasonable.
// Each test below reads the tree for the specific fact its acceptance rests on,
// so a change that invalidates a reason fails here instead of silently turning
// a considered judgement into a stale one.
//
// These are also the receipts for the three DELETE-THE-FIELD calls this wave
// DECLINED. Each declined deletion rested on a premise ("the value is the
// deployment's own tenant / derivable from the session"); the premise is
// measured here rather than argued.

/** Every tracked file under apps/fiab-console whose text contains `needle`. */
function filesContaining(needle) {
  const all = execFileSync('git', ['ls-files', 'apps/fiab-console'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(?:tsx?|mjs)$/.test(f));
  return all.filter((f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').includes(needle));
}

test('RECEIPT (declined DEL): `spnTenantId` is WRITE-ONLY — nothing derives it, so it cannot be deleted', () => {
  // The scoping called git-integration.tsx:526 and connection-builder.tsx:262
  // deletable because they "ask for the deployment's own tenant". Deleting a
  // field is only safe if the value resolves from somewhere else. It does not:
  // every consumer either RENDERS the field or PERSISTS it, and no credential
  // is ever constructed from it.
  const consumers = filesContaining('spnTenantId').filter((f) => !f.includes('__tests__'));
  assert.deepEqual(consumers.sort(), [
    'apps/fiab-console/app/api/admin/workspaces/[id]/git/branch-out/route.ts',
    'apps/fiab-console/app/api/admin/workspaces/[id]/git/route.ts',
    'apps/fiab-console/app/api/connections/[id]/route.ts',
    'apps/fiab-console/app/api/connections/route.ts',
    'apps/fiab-console/lib/azure/connections-store.ts',
    'apps/fiab-console/lib/azure/git-binding-store.ts',
    'apps/fiab-console/lib/components/connections/connection-builder.tsx',
    'apps/fiab-console/lib/panes/git-integration.tsx',
  ], 'a NEW consumer of spnTenantId appeared — re-judge the acceptance before trusting it');

  // None of them mints a token from it. If one starts to, the value has a real
  // authority behind it and this whole argument needs revisiting.
  for (const f of consumers) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    assert.ok(
      !/ClientSecretCredential|ConfidentialClientApplication|\/oauth2\/v2\.0\/token/.test(src),
      `${f} now builds a credential alongside spnTenantId — the "write-only" premise is dead`,
    );
  }
});

test('RECEIPT (declined DEL): the Request-access dialog is PRE-AUTH, so there is no session to derive ids from', () => {
  const route = fs.readFileSync(
    path.join(REPO_ROOT, 'apps/fiab-console/app/api/access-requests/public/route.ts'), 'utf8',
  );
  // The endpoint the dialog POSTs to has no session gate — it says so, and it
  // reads no session helper.
  assert.match(route, /UNAUTHENTICATED|deliberately reachable pre-auth/);
  assert.ok(!/getSession|requireSession|readSession/.test(route), 'the public access-request route now has a session');

  // And the deployment's own tenant is a DIFFERENT value from the requester's:
  // it comes from AZURE_TENANT_ID and is used only as a partition bucket, so
  // substituting it for the requester's tenant id would be wrong, not lossy.
  const helper = fs.readFileSync(
    path.join(REPO_ROOT, 'apps/fiab-console/lib/access/signin-access-request.ts'), 'utf8',
  );
  assert.match(helper, /deploymentTenantBucket[\s\S]{0,200}AZURE_TENANT_ID/);
});

test('RECEIPT: the webhook signing secret is GENERATED when the field is left blank', () => {
  const registry = fs.readFileSync(path.join(REPO_ROOT, 'apps/fiab-console/lib/events/webhook-registry.ts'), 'utf8');
  assert.match(registry, /function generateWebhookSecret/);
  // The compliant default: supplied-and-long-enough, else generate.
  assert.match(registry, /input\.secret && input\.secret\.length >= \d+ \? input\.secret : generateWebhookSecret\(\)/);
});

test('RECEIPT: both accepted git credentials are already Key Vault-backed, not stored on the record', () => {
  const binding = fs.readFileSync(path.join(REPO_ROOT, 'apps/fiab-console/lib/azure/git-binding-store.ts'), 'utf8');
  assert.match(binding, /putKeyVaultSecret\(/);
  assert.match(binding, /secretRef: name/);
  const runtimeRoute = fs.readFileSync(
    path.join(REPO_ROOT, 'apps/fiab-console/app/api/items/loom-app-runtime/[id]/git-credential/route.ts'), 'utf8',
  );
  assert.match(runtimeRoute, /putKeyVaultSecret\(/);
});

test('RECEIPT: the accepted Airflow URL is an override on a day-one MANAGED host, not the only path', () => {
  const editor = fs.readFileSync(path.join(REPO_ROOT, 'apps/fiab-console/lib/editors/airflow-job-editor.tsx'), 'utf8');
  assert.match(editor, /managedHost/);
  assert.match(editor, /Leave blank to use the managed host/);
});

test('RECEIPT: the accepted egress allow-list already has a picker for the enumerable case', () => {
  const pane = fs.readFileSync(path.join(REPO_ROOT, 'apps/fiab-console/lib/governance/workspace-egress-pane.tsx'), 'utf8');
  // Choosing "Service tag" swaps the Input for a Dropdown fed by discovery.
  assert.match(pane, /draftType === 'service-tag' \? \(\s*<Dropdown/);
  assert.match(pane, /serviceTags\.map/);
});

// ── 9. end to end, as CI runs it ───────────────────────────────────────────

test('the guard passes on the current tree at its baseline', () => {
  const r = execFileSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  assert.match(r, /baseline holds/);
});

test('every acceptance is PRINTED on a green run — an exception nobody is reminded of is not reviewed', () => {
  const r = execFileSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  for (const a of ACCEPTED) assert.ok(r.includes(a.file), `${a.file} is accepted but never printed`);
  assert.match(r, /no-freeform \[accepted\]: \d+ reviewed exception\(s\)/);
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
