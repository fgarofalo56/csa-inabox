/**
 * Teeth for check-role-guid-consistency.mjs (#3608).
 *
 * The point of these is NOT that the guard reports something — a guard that
 * cannot report nothing is as useless as one that cannot report something. Each
 * block below pairs a case that MUST be found with a case that MUST NOT be, so
 * a matcher that has degenerated into "always fire" or "never fire" fails here.
 *
 * Every wrong case is ADDITIVE: the fixture also contains a correct binding, so
 * the guard has to distinguish them rather than merely notice that the file is
 * non-empty. Replacing the only entry would trip the population floor and read
 * as proven while proving nothing.
 *
 * Run: node --test scripts/ci/__tests__/check-role-guid-consistency.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL,
  ALIASES,
  CONTROLS,
  REPO_SHAPES,
  NEAR_MISS_PREFIX,
  OBJECT_WINDOW,
  normalise,
  labelCandidates,
  resolveLabel,
  harvest,
  evaluate,
  tableFaults,
  controlFaults,
  repoShapeFaults,
  scan,
  scanFiles,
  REPO_ROOT,
} from '../check-role-guid-consistency.mjs';

const CONTRIB = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const READER = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';
const BLOB_CONTRIB = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
/** The value that actually shipped in lz-rbac.ts. */
const BAD_CONTRIB = 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e';

function run(source, file = 'fixture.ts') {
  const { pairs, unparsed } = harvest(source, file);
  return { ...evaluate(pairs), pairs, unparsed };
}
const checks = (r, id) => r.findings.filter((f) => f.check === id);

// ── the reference table and the embedded controls ───────────────────────────

test('the canonical table is internally sound', () => {
  assert.deepEqual(tableFaults(), []);
});

test('every embedded control holds', () => {
  assert.deepEqual(controlFaults(), []);
});

test('the canonical table pins the documented Contributor id', () => {
  // The one fact this whole guard exists for. If this line is ever "corrected"
  // to the shipped value, everything below it becomes theatre.
  assert.equal(new Map(CANONICAL).get('Contributor'), CONTRIB);
  assert.notEqual(new Map(CANONICAL).get('Contributor'), BAD_CONTRIB);
});

test('every alias points at a role that exists and is stored normalised', () => {
  const names = new Set(CANONICAL.map(([n]) => n));
  for (const [alias, name] of ALIASES) {
    assert.ok(names.has(name), `alias ${alias} -> unknown role ${name}`);
    assert.equal(normalise(alias), alias);
  }
});

// ── C1: the mismatch, in every harvest shape ────────────────────────────────

test('C1 flags a wrong id in an object literal and leaves its correct siblings alone', () => {
  const r = run([
    "export const R = [",
    "  { name: 'Contributor',",
    `    guid: '${BAD_CONTRIB}' },`,
    "  { name: 'Storage Blob Data Contributor',",
    `    guid: '${BLOB_CONTRIB}' },`,
    "];",
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 3, 'must point at the offending line');
  assert.match(c1[0].detail, /Contributor/);
  assert.match(c1[0].detail, new RegExp(CONTRIB), 'must name the id it expected');
  assert.equal(r.resolved, 2, 'the correct sibling stays in the population');
});

test('C1 flags a wrong id bound to a declaration identifier', () => {
  const r = run([
    `var contributorRoleId = '${READER}'`,
    `var readerRoleId = '${READER}'`,
  ].join('\n'), 'm.bicep');
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 1);
  assert.equal(c1[0].file, 'm.bicep', 'the finding must name the file');
});

test('C1 flags a wrong id bound to a shell/YAML env assignment', () => {
  const r = run([
    `CONTRIBUTOR_ROLE_ID="${READER}"`,
    `READER_ROLE_ID="${READER}"`,
  ].join('\n'), 'x.sh');
  assert.equal(checks(r, 'C1').length, 1);
});

test('C1 uses a trailing comment as the label when the identifier says nothing', () => {
  const r = run([
    `const A = '${READER}'; // Contributor`,
    `const B = '${READER}'; // Reader`,
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 1);
});

test('C1 reads a value that sits on the line after the `=`', () => {
  const r = run(['var contributorRoleId =', `  '${READER}'`].join('\n'), 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
});

// ── the shapes the rework review measured as UNREAD ─────────────────────────

test('C1 flags a wrong id in a name-keyed map — the shape that was silently green', () => {
  // Verbatim SQL_DATABASE_ROLES, a live grant path: grantDatabaseRole() does
  // SQL_DATABASE_ROLES[roleNameOrGuid] to pick the id that reaches ARM.
  // Re-introducing #3608's own value here produced exit 0 under the shipped
  // guard, with the population count unchanged — the line was not even residue.
  const r = run([
    'export const SQL_DATABASE_ROLES: Record<string, string> = {',
    `  'Reader':             '${READER}',`,
    `  'Contributor':        '${BAD_CONTRIB}',`,
    "  'SQL DB Contributor': '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec',",
    '};',
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 3);
  assert.equal(r.resolved, 3, 'the correct siblings stay in the population');
});

test('a name-keyed map that is correct produces nothing', () => {
  const r = run([
    'const BLOB_DATA_ROLES: Record<string, string> = {',
    `  'Storage Blob Data Contributor':  '${BLOB_CONTRIB}',`,
    "  'Storage Blob Data Owner':        'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',",
    '};',
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 2);
});

test('C1 flags a wrong id in an array member labelled by its comment (the Gov lane shape)', () => {
  const r = run([
    '            roles: [',
    `              '${BLOB_CONTRIB}', // Storage Blob Data Contributor`,
    `              '${BLOB_CONTRIB}', // Azure Event Hubs Data Sender`,
    '            ]',
  ].join('\n'), '.github/workflows/gov-workspace-identity.yml');
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 3);
  assert.match(c1[0].detail, /Azure Event Hubs Data Sender/);
});

test('C1 flags a wrong id in a one-line object literal', () => {
  const r = run([
    `  { name: 'Contributor', guid: '${READER}' },`,
    `  { name: 'Reader', guid: '${READER}' },`,
  ].join('\n'));
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(checks(r, 'C1')[0].line, 1);
});

test('C1 flags a wrong id in a bicep `param … string = …` default', () => {
  const r = run(`param contributorRoleId string = '${READER}'`, 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
});

test('a WRAPPED subscriptionResourceId call is read, not just the compact one', () => {
  // The bicep formatter splits the call over three lines, which is the dominant
  // formatting in platform/fiab/bicep. A single-line matcher reads the compact
  // form and is silently blind to this one.
  const r = run([
    '    // Contributor',
    '    roleDefinitionId: subscriptionResourceId(',
    "      'Microsoft.Authorization/roleDefinitions',",
    `      '${READER}')`,
  ].join('\n'), 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(r.resolved, 1);
});

test('a comment above one grant is not attributed to the NEXT grant', () => {
  // The label walk must stop at another binding. Both ids here are correct for
  // their own role; if the second inherited "// Contributor" it would be a
  // fabricated finding against a correct line.
  const r = run([
    '  // Contributor',
    `  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${CONTRIB}')`,
    `  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${READER}')`,
  ].join('\n'), 'm.bicep');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 1, 'only the commented one is judged');
});

// ── #3420: a binding folded across a `\` must not be invisible ──────────────

test('a grant folded across a backslash continuation is READ, not skipped', () => {
  // `scripts/` and `.github/` are scan roots, so `.sh` and `.yml` are in the
  // population, and a shell author folds a long `az` invocation across a
  // trailing `\`. Judged by PHYSICAL line the `roleDefinitions` marker is on
  // one line and the id on the next, mid-line, out of reach of the bare-GUID
  // lookahead — MEASURED against the pre-adoption revision, this fixture
  // produced ZERO pairs and ZERO findings there. A guard that reports clean on
  // a tree carrying the defect is the #3417 class, not a near miss.
  const r = run([
    'az role assignment create --assignee "$OID" \\',
    '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
    `  --id '${READER}' --scope "$SCOPE"   # Contributor`,
  ].join('\n'), 'grant.sh');
  assert.equal(r.resolved, 1);
  assert.equal(checks(r, 'C1').length, 1);
});

test('the same folded grant with the RIGHT id produces nothing', () => {
  // Must-not-fire half. Without it, a matcher that flagged every folded line
  // would look proven by the test above.
  const r = run([
    'az role assignment create --assignee "$OID" \\',
    '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
    `  --id '${CONTRIB}' --scope "$SCOPE"   # Contributor`,
  ].join('\n'), 'grant.sh');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 1);
});

test('a folded finding still points at the PHYSICAL line the statement starts on', () => {
  // Folding is an analysis device, not a reporting one. If the reported line
  // were the logical index the annotation would land on the wrong code, which
  // is how a true finding gets dismissed as noise.
  const r = run([
    '# a preamble line',
    '# another preamble line',
    'export CONTRIBUTOR_ROLE_ID=\\',
    `  '${READER}'`,
  ].join('\n'), 'grant.sh');
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(checks(r, 'C1')[0].line, 3, 'the `export` is on physical line 3');
});

test('an EVEN run of trailing backslashes does not splice the next line', () => {
  // Over-reach fails the same way under-reach does: splice this and `var …` is
  // no longer at the start of its logical line, DECL_RE stops matching, and a
  // wrong id goes unjudged.
  const r = run([
    'echo "a literal trailing pair" \\\\',
    `var contributorRoleId = '${READER}'`,
  ].join('\n'), 'grant.sh');
  assert.equal(r.resolved, 1);
  assert.equal(checks(r, 'C1').length, 1);
});

// ── R7: C1 must not assert an outcome it has not established ────────────────

test('C1 says ARM ACCEPTS the grant when the bound id is another KNOWN role', () => {
  // The rework finding. "every role assignment written from this value is
  // rejected" was false here: ARM resolves by id, finds Reader, and grants
  // Reader — a silent wrong privilege with nothing in any deploy log, which is
  // strictly harder to diagnose than a rejected PUT.
  const r = run(`var contributorRoleId = '${READER}'`, 'm.bicep');
  const [c1] = checks(r, 'C1');
  assert.match(c1.detail, /ACCEPTS this assignment and grants "Reader"/);
  assert.match(c1.detail, /silently, with no error to find/);
  assert.doesNotMatch(c1.detail, /REJECTS every assignment/);
});

test('C1 says it CANNOT TELL when the bound id is outside its partial table', () => {
  // #3608's own value. This guard's table is deliberately partial, so it cannot
  // establish that the id names no role — only that it does not name the one
  // that was written. UNKNOWN must be reported as unknown, not as "rejected".
  const r = run(`var contributorRoleId = '${BAD_CONTRIB}'`, 'm.bicep');
  const [c1] = checks(r, 'C1');
  assert.match(c1.detail, /cannot establish which of two outcomes applies/);
  assert.match(c1.detail, /REJECTS every assignment/);
  assert.match(c1.detail, /ACCEPTS the assignment and grants THAT role/);
  assert.match(c1.detail, /az role definition list/, 'must hand back a way to settle it');
});

test('both C1 wordings state the one thing that IS established', () => {
  for (const guid of [READER, BAD_CONTRIB]) {
    const [c1] = checks(run(`var contributorRoleId = '${guid}'`, 'm.bicep'), 'C1');
    assert.match(c1.detail, /Established either way: this binding does not grant "Contributor"/);
  }
});

// ── the guard must be able to stay silent ───────────────────────────────────

test('a fully correct tree produces nothing', () => {
  const r = run([
    `var contributorRoleId = '${CONTRIB}'`,
    `const RBAC_READER = '${READER}';`,
    `STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID='${BLOB_CONTRIB}'`,
    'const X = {',
    "  name: 'Reader',",
    `  guid: '${READER}',`,
    '};',
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 4);
});

test('a role-GUID key with no findable name is recorded as unjudged, not dropped', () => {
  // Silence and invisibility are different failures. This shape yields no
  // verdict, but it must still appear in the residue so `--list` shows it.
  const r = run(['  roleGuid: ' + `'${READER}',`].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 0);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].why, /no name key/);
});

test('a GUID that is not a role is not judged (no invented finding)', () => {
  // AzureDatabricks first-party app id, and a Cosmos SQL data role — both are
  // GUID-shaped, neither is an Azure RBAC role definition.
  const r = run([
    "var dbxResource = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d'",
    "var cosmosDataContributorGuid = '00000000-0000-0000-0000-000000000002'",
  ].join('\n'), 'm.bicep');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 0);
  assert.equal(r.unresolved.length, 2, 'the residue is reported, not dropped');
});

// ── the specific false pairing found while writing this guard ───────────────

test('an env-var `name:` is not paired with a nearby role GUID', () => {
  // Measured in app-resources.ts: `{ name: 'LOOM_ADLS_ACCOUNT', … }` six lines
  // above a `roleGuid:`. A forward scan from `name:` paired them. Here the
  // decoy is literally spelled "Contributor" — if it were paired, the guard
  // would report a finding against a value that is not a role binding at all.
  const r = run([
    '  envVars: [',
    "    { name: 'Contributor', value: env('X') },",
    '  ],',
    '  grantScope: armId(a, b, c),',
    `  roleGuid: '${READER}',`,
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 0);
});

test('`roleName:` BELOW its `roleGuid:` is still paired', () => {
  const r = run([
    '  grantScope: armId(a, b, c),',
    `  roleGuid: '${READER}',`,
    "  roleName: 'Storage Blob Data Contributor',",
  ].join('\n'));
  assert.equal(checks(r, 'C1').length, 1, 'the real pair must be judged');
  assert.equal(r.resolved, 1);
});

test('a bare `name:` in a DIFFERENT object is not pulled in', () => {
  // What rejects this is the bracket boundary, not a distance window: the
  // decoy's object opens and closes on its own line, so the span between it and
  // the roleGuid dips out of the enclosing object. The filler is sized past the
  // old window purely so this stays a fair test of the new rule.
  const far = ["    { name: 'Contributor', value: 1 },"];
  for (let i = 0; i < OBJECT_WINDOW - 2; i += 1) far.push('    filler,');
  far.push(`    roleGuid: '${READER}',`);
  const r = run(far.join('\n'));
  assert.equal(r.resolved, 0);
});

test('a bare `name:` in the SAME object is still paired, however far the window allows', () => {
  // The other half. Removing the tight bare-name window would be a regression
  // if it also stopped finding the real thing; it must still pair here, and the
  // binding is wrong, so it must be a finding.
  const r = run([
    '  {',
    "    name: 'Contributor',",
    "    why: 'a',",
    "    why2: 'b',",
    `    guid: '${READER}',`,
    '  },',
  ].join('\n'));
  assert.equal(checks(r, 'C1').length, 1);
  assert.match(checks(r, 'C1')[0].detail, /Contributor/);
});

// ── the false pairing measured on rework: nearest-in-either-direction ────────

test('an object that CLOSES on its guid line does not borrow the next object\'s name', () => {
  // Measured on the shipped guard: with any line between `name:` and `guid:`,
  // the NEXT object's `name:` was strictly nearer and won. Contributor bound to
  // Reader's real id produced NO finding at all — a false negative in the exact
  // name/GUID-swap class this guard exists to catch.
  const r = run([
    'const R = [',
    "  { name: 'Contributor',",
    "    why: 'the DLZ attach needs it',",
    `    guid: '${READER}' },`,
    "  { name: 'Reader',",
    `    guid: '${READER}' },`,
    '];',
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1, 'the wrong binding must be found');
  assert.equal(c1[0].line, 4);
  assert.match(c1[0].detail, /names the built-in role "Contributor"/);
  assert.equal(r.resolved, 2);
});

test('the same layout with CORRECT bindings produces no finding', () => {
  // The other half of the same defect: the shipped guard labelled Contributor's
  // own correct id "Reader" and reported a FALSE C1 on two right answers.
  const r = run([
    'const R = [',
    "  { name: 'Contributor',",
    "    why: 'the DLZ attach needs it',",
    `    guid: '${CONTRIB}' },`,
    "  { name: 'Reader',",
    `    guid: '${READER}' },`,
    '];',
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 2);
});

// ── C2: contradictory labels ────────────────────────────────────────────────

test('C2 fires when the identifier and the comment name different roles', () => {
  const r = run(`var contributorRoleId = '${CONTRIB}' // Reader`, 'm.bicep');
  const c2 = checks(r, 'C2');
  assert.equal(c2.length, 1);
  assert.match(c2[0].detail, /Contributor/);
  assert.match(c2[0].detail, /Reader/);
  // It must not also claim to know which is right.
  assert.match(c2[0].detail, /not something this guard can establish/);
});

test('C2 does NOT fire when the identifier and the comment agree', () => {
  const r = run(`var contributorRoleId = '${CONTRIB}' // Contributor`, 'm.bicep');
  assert.deepEqual(r.findings, []);
});

// ── C3: near miss ───────────────────────────────────────────────────────────

test('C3 flags an unlabelled GUID that closely resembles one canonical id', () => {
  const r = run("var frobnicatorRoleId = 'b24988ac-6180-42a0-9999-999999999999'", 'm.bicep');
  const c3 = checks(r, 'C3');
  assert.equal(c3.length, 1);
  // R7: it must describe a resemblance, not assert an intent it cannot prove.
  assert.match(c3[0].detail, /does NOT establish/);
  assert.match(c3[0].detail, /Contributor/);
});

test('C3 stays quiet on an unrelated GUID', () => {
  const r = run("var frobnicatorRoleId = '11111111-2222-3333-4444-555555555555'", 'm.bicep');
  assert.deepEqual(r.findings, []);
});

test('C3 does not double-report a binding C1 already explained', () => {
  const r = run(`var contributorRoleId = '${BAD_CONTRIB}'`, 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(checks(r, 'C3').length, 0);
});

test('NEAR_MISS_PREFIX is long enough that a coincidence is not plausible', () => {
  // 19 chars spans the first three groups: 16 hex digits, 64 bits.
  assert.ok(NEAR_MISS_PREFIX >= 19);
});

// ── label resolution ────────────────────────────────────────────────────────

test('label resolution reaches the same role from every spelling used in-repo', () => {
  for (const spelling of ['Contributor', 'contributorRoleId', 'RBAC_CONTRIBUTOR', 'CONTRIBUTOR_ROLE_ID', 'contributor']) {
    assert.equal(resolveLabel(spelling)?.name, 'Contributor', spelling);
  }
  for (const spelling of ['storageBlobDataContributorRoleId', 'blobDataContributorGuid', 'Storage Blob Data Contributor']) {
    assert.equal(resolveLabel(spelling)?.name, 'Storage Blob Data Contributor', spelling);
  }
});

test('a trailing parenthetical note does not defeat resolution', () => {
  assert.equal(resolveLabel('Storage Blob Data Reader (global built-in)')?.name, 'Storage Blob Data Reader');
});

test('a label that names nothing known resolves to null, not to a guess', () => {
  for (const s of ['dbxResource', 'SENTINEL_APP_ID', 'WORKSPACE_ID', 'placeholder', '']) {
    assert.equal(resolveLabel(s), null, s);
  }
});

test('candidate generation never yields an empty key', () => {
  for (const s of ['ROLE', 'role', 'guid', 'id', 'RoleId', '']) {
    assert.ok(!labelCandidates(s).includes(''), s);
  }
});

// ── F5: an unreadable value is UNKNOWN, never assumed safe ──────────────────

test('a known role identifier with an empty value is surfaced, not skipped', () => {
  const { unparsed } = harvest('var contributorRoleId =\n\n\n\nvar other = 1', 'm.bicep');
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].ident, 'contributorRoleId');
});

test('an UNKNOWN identifier with an empty value is not reported (nothing to claim)', () => {
  const { unparsed } = harvest('var somethingElse =\n\n\n\nvar other = 1', 'm.bicep');
  assert.deepEqual(unparsed, []);
});

// ── scope + floors ──────────────────────────────────────────────────────────

test('test files are out of scope — their GUIDs are fixtures, not grants', () => {
  const files = scanFiles().map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(!f.includes('__tests__/'), f);
    assert.ok(!/\.(test|spec)\./.test(f), f);
  }
});

test('the guard does not harvest its own reference table', () => {
  const self = 'scripts/ci/check-role-guid-consistency.mjs';
  const { pairs } = scan();
  assert.equal(pairs.filter((p) => p.file === self).length, 0);
});

test('the real repo yields a substantial, resolvable population', () => {
  // The floors in main() are `> 0`; this asserts the tree is genuinely being
  // read, so a matcher that silently degrades to a handful of hits is visible
  // here even while the binary floor still passes.
  const { pairs, resolved } = scan();
  assert.ok(pairs.length >= 100, `only ${pairs.length} bindings harvested`);
  assert.ok(resolved >= 80, `only ${resolved} bindings resolved`);
});

test('the repo is clean — every resolved binding carries its documented id', () => {
  // The baseline half of the mutation proof, pinned so a regression is a test
  // failure and not just a red CI step somebody reruns.
  const { findings } = scan();
  assert.deepEqual(findings.map((f) => `${f.check} ${f.file}:${f.line}`), []);
});

test('every embedded control has a name and both halves are exercised somewhere', () => {
  // What this DOES prove: each implemented shape still behaves. What it CANNOT
  // prove — and what the old test called "CONTROLS covers every harvest shape
  // the guard claims to read" wrongly implied — is that a shape exists at all.
  // CONTROLS can only exercise shapes the harvester implements, and this
  // assertion reads its ids from that same list, so as a coverage claim it is
  // circular. It caught OBJ_GUID_RE drift; it could never have caught the
  // name-keyed map, which was simply never written. The non-circular half is
  // the repo-anchored test below.
  assert.ok(CONTROLS.length >= 15);
  const ids = new Set(CONTROLS.map((c) => c.id));
  assert.equal(ids.size, CONTROLS.length, 'control ids must be unique');
  const fires = CONTROLS.filter((c) => (c.expect.C1 ?? 0) + (c.expect.C3 ?? 0) > 0).length;
  const silent = CONTROLS.filter((c) => (c.expect.C1 ?? 0) + (c.expect.C3 ?? 0) === 0).length;
  assert.ok(fires > 0 && silent > 0, 'a control set with no silent case cannot detect "always fire"');
});

test('REPO_SHAPES is anchored to the real repo, not to the implementation', () => {
  // The non-circular coverage claim. Its population is the code: every entry is
  // a VERBATIM excerpt that must still exist in the file it names, and the
  // harvester must still read it. Deleting a shape from the harvester turns
  // this red; so does moving the code out from under the sample. This is what
  // would have caught the name-keyed map — SQL_DATABASE_ROLES was in the repo
  // and unread the whole time the old coverage test passed.
  assert.deepEqual(repoShapeFaults(), []);
});

test('REPO_SHAPES covers the live grant paths the rework review reintroduced the defect in', () => {
  // Named explicitly so deleting one is a visible diff and not a silent
  // shrinking of the population. Each of these was measured GREEN under the
  // shipped guard with this story's own bad GUID planted in it.
  const files = REPO_SHAPES.map((s) => s.file);
  for (const need of [
    'apps/fiab-console/lib/azure/azure-sql-client.ts',   // SQL_DATABASE_ROLES -> grantDatabaseRole
    'apps/fiab-console/lib/azure/adls-client.ts',        // BLOB_DATA_ROLES -> grant value + allow-list
    '.github/workflows/gov-workspace-identity.yml',      // the GOV lane, pinned nowhere before this
    'apps/fiab-console/lib/setup/lz-rbac.ts',            // #3608 itself
  ]) {
    assert.ok(files.includes(need), `no repo-anchored shape sample for ${need}`);
  }
});

test('a repo shape sample that no longer matches its file is a FAULT, not a pass', () => {
  // The floor must be able to fail, and it must fail for the right reason: a
  // fixture that has drifted away from the code it models is worthless, and
  // this repo has an incident of exactly that.
  const faults = repoShapeFaults(path.join(REPO_ROOT, 'scripts'));
  assert.ok(faults.length > 0, 'pointed at a root with none of the files, F6 must refuse');
  assert.ok(faults.some((f) => /unreadable|no longer contains/.test(f)), faults.join('\n'));
});

test('importing this module runs no scan as a side effect', () => {
  // check-guard-import-side-effects.mjs enforces the same property statically;
  // reaching this line at all is the runtime half.
  assert.ok(typeof scan === 'function');
  assert.ok(path.isAbsolute(fileURLToPath(import.meta.url)));
});
