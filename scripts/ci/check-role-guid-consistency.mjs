#!/usr/bin/env node
/**
 * check-role-guid-consistency.mjs — a role NAME and the role definition GUID
 * written next to it must agree. (issue #3608)
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * apps/fiab-console/lib/setup/lz-rbac.ts declared, for the entire life of the
 * module (added 0b9e0513, untouched through b558e9f4):
 *
 *     { name: 'Contributor', guid: 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e' }
 *
 * The documented Contributor id is `b24988ac-6180-42a0-ab88-20f7382dd24c`
 * (learn.microsoft.com/azure/role-based-access-control/built-in-roles#privileged).
 * The first three groups match; the last two do not. grantRgScopedRoles()
 * interpolates that value straight into
 *
 *     /subscriptions/<sub>/providers/Microsoft.Authorization/roleDefinitions/<guid>
 *
 * and PUTs it, so every automatic ARM Contributor grant on a DLZ attach was
 * rejected. The other two GUIDs in the same array are correct, and
 * buildRgScopedGrantCommands() emits `--role "Contributor"` BY NAME, so the
 * operator copy-paste fallback was unaffected — only the automatic PUT.
 *
 * ── WHY THE EXISTING TEST DID NOT CATCH IT ─────────────────────────────────
 * lz-rbac.test.ts asserted only the GUID *shape*:
 *
 *     expect(r.guid).toMatch(/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i)
 *
 * A wrong GUID is still a well-shaped GUID. The test passed happily on a value
 * that ARM rejects, for the module's whole life. That is the difference between
 * checking a FORMAT and checking a FACT.
 *
 * ── WHAT THIS GUARD KEYS ON, AND WHY IT IS NOT KEYED ON THE BAD STRING ─────
 * It would be trivial, and useless, to grep for
 * `b24988ac-6180-42a0-bb6f-b91a8f3d3d0e`. Adopting the fix deletes that token,
 * so the rule would immediately go quiet and protect nothing — the repo has a
 * recorded incident of exactly that shape.
 *
 * So the key is the MISMATCH, not the string: wherever this guard can read a
 * role NAME bound to a GUID, the GUID must equal the canonical id for that
 * name. The fixed line stays in the population forever and is re-checked on
 * every run; a NEW wrong binding, of a role that does not exist today, is
 * caught the day it lands.
 *
 * ── EXACTLY WHICH SHAPES ARE READ (do not read this as "every binding") ────
 * An earlier revision of this header claimed "for every place the repo binds a
 * role NAME to a GUID". That was false, and measurably so: re-introducing this
 * story's own defect as
 *
 *     'Contributor': 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e'
 *
 * in azure-sql-client.ts's SQL_DATABASE_ROLES — a live grant path, read at
 * grantDatabaseRole() to pick the id that reaches ARM — produced exit 0 and did
 * not even move the population count. A guard that cannot fail on a real shape
 * is not a guard for that shape, and a docstring that says otherwise is an R7
 * violation in the guard's own prose. The name-keyed map is now READ, and this
 * header enumerates the shapes rather than generalising over them.
 *
 * READ (each has an embedded control, and REPO_SHAPES pins each to a real file
 * so the sample cannot drift away from the code it claims to model):
 *   S1  object literal            `{ name: 'X', … guid: 'g' }` (multi-line)
 *   S2  object literal, one line  `{ name: 'X', guid: 'g' },`
 *   S3  declaration               `var xRoleId = 'g'`  /  `param xRoleId string = 'g'`
 *   S4  env / shell assignment    `X_ROLE_ID='g'`
 *   S5  trailing-comment label    `const A = 'g'; // Role Name`
 *   S6  name-keyed map entry      `'Role Name': 'g',`  (TS Record, JSON, YAML)
 *   S7  array member              `'g', // Role Name`   (and unlabelled members)
 *   S8  inline role-definition id `subscriptionResourceId('…/roleDefinitions', 'g')`,
 *                                 compact on one line or WRAPPED across three
 *
 * NOT READ, and deliberately COUNTED so the gap is visible rather than
 * invisible: any other line carrying a GUID that is a canonical role id or a
 * near-miss to one is reported as `unharvested` residue (`--list` prints the
 * file and line). That count is the honest measure of this guard's blind spot.
 * Markdown and other prose under `docs/` is outside the scan roots entirely —
 * a wrong role id in a doc is NOT caught here.
 *
 * ── CLOUD PARITY (cloud-parity.md is BLOCKING) ─────────────────────────────
 * Azure built-in role definition GUIDs are GLOBAL: the same id in Commercial,
 * GCC, GCC-High, DoD and every sovereign boundary. A wrong id is therefore
 * wrong in EVERY cloud simultaneously — this is not a Commercial-only defect
 * and this is not a Commercial-only check. The scan roots are whole trees
 * (platform/fiab/bicep, apps/fiab-console, scripts, .github), not a
 * per-boundary file list, so Gov params, Gov workflows and Gov-only modules are
 * covered by construction rather than by a name that would have to be kept in
 * sync. There is no per-cloud branch anywhere in this file.
 *
 * ── THE CHECKS ─────────────────────────────────────────────────────────────
 *   C1  A binding whose label resolves to a known built-in role carries a GUID
 *       that is not that role's id. THE defect above. What C1 asserts depends
 *       on what it can establish: if the bound GUID is ANOTHER role's id, ARM
 *       accepts the assignment and silently grants THAT role instead — a wrong
 *       privilege, not a rejected call. If the GUID is one this guard's partial
 *       table does not carry, C1 says it cannot tell which of the two outcomes
 *       applies, because it cannot. Both wordings agree on the one thing that
 *       IS established: the assignment does not grant the role that was named.
 *   C2  A binding's identifier and its trailing comment name two DIFFERENT
 *       known roles. One of them is wrong; this guard cannot establish which,
 *       and says so rather than picking.
 *   C3  A GUID that is not any known built-in role id but shares a >= 19-char
 *       prefix with exactly one (the first three groups). This is what the
 *       lz-rbac value looks like. Stated for what it is — a resemblance, not a
 *       proven intent (R7).
 *
 * ── WHAT IT DELIBERATELY DOES NOT CLAIM (R7) ───────────────────────────────
 * A label it cannot resolve to a role in CANONICAL is NOT judged. Custom role
 * definitions exist, first-party app ids are shaped like GUIDs
 * (`dbxResource = '2ff814a6-…'` is the AzureDatabricks application, not a
 * role), and Cosmos SQL data roles use their own id space
 * (`cosmosDataContributorGuid = '00000000-…-000000000002'`). Judging those
 * would be inventing findings. They are counted and printed by `--list` so the
 * residue is visible instead of silently dropped.
 *
 * Test files are out of scope: `__tests__/`, `*.test.*`, `*.spec.*`,
 * `__fixtures__/`. Their GUIDs are literals chosen for the test and never
 * reach ARM — and they actively lie, e.g. `const OWNER = 'f4f25dd9-…'` in
 * uc-effective-owner.test.ts is a principal object id, not the Owner role.
 * Judging it would produce a finding that is false.
 *
 * ── FLOORS: THIS GUARD REFUSES TO PASS ON AN EMPTY POPULATION ──────────────
 * A zero here means the matcher drifted off the code, which is not the same as
 * a clean tree. F2 fails on zero harvested bindings, F3 on zero RESOLVED
 * bindings, and F4 runs embedded controls that exercise EVERY harvest shape
 * against synthetic input — so if one shape's matcher breaks while the others
 * still find things (a count floor's blind spot), F4 still fails.
 *
 * F4 alone is CIRCULAR as a coverage claim: it can only exercise shapes the
 * harvester already implements, so it proves the implemented shapes still work
 * and says nothing about a shape that was never implemented. That is precisely
 * how the name-keyed map went unread. F6 closes it from the other side:
 * REPO_SHAPES holds excerpts of real binding sites, each pinned to the file it
 * was copied from. F6 fails if that SHAPE no longer appears in the file, and if
 * harvesting the file's own lines stops producing the expected pairing. Its
 * population is the repo, not the implementation.
 *
 * USAGE
 *   node scripts/ci/check-role-guid-consistency.mjs
 *   node scripts/ci/check-role-guid-consistency.mjs --list
 *
 * Tests: node --test scripts/ci/__tests__/check-role-guid-consistency.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalLines } from './_logical-lines.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Azure built-in roles this repo binds, each id read from Microsoft Learn
 * (learn.microsoft.com/azure/role-based-access-control/built-in-roles), not
 * from memory — reading it from memory is what produced #3608.
 *
 * Coverage is deliberately partial: a role that is not here is NOT JUDGED
 * rather than guessed at. Adding one is a pure improvement, so long as the id
 * is copied from Learn.
 */
export const CANONICAL = [
  // Privileged / General
  ['Contributor', 'b24988ac-6180-42a0-ab88-20f7382dd24c'],
  ['Owner', '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'],
  ['Reader', 'acdd72a7-3385-48ef-bd42-f606fba81ae7'],
  ['Role Based Access Control Administrator', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'],
  ['User Access Administrator', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9'],
  // Storage
  ['Storage Blob Data Contributor', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'],
  ['Storage Blob Data Owner', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'],
  ['Storage Blob Data Reader', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'],
  ['Storage Blob Delegator', 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'],
  ['Storage Account Contributor', '17d1049b-9a84-46fb-8f53-869881c3d3ab'],
  ['Storage Queue Data Contributor', '974c5e8b-45b9-4653-ba55-5f855dd0fb88'],
  // Analytics / messaging
  ['Azure Event Hubs Data Owner', 'f526a384-b230-433a-b45c-95f59c4a2dec'],
  ['Azure Event Hubs Data Receiver', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde'],
  ['Azure Event Hubs Data Sender', '2b629674-e913-4c01-ae53-ef4638d8f975'],
  ['Data Factory Contributor', '673868aa-7521-48a0-acc6-0f60742d39f5'],
  // Security / Key Vault
  ['Key Vault Administrator', '00482a5a-887f-4fb3-b363-3b7fe8e74483'],
  ['Key Vault Secrets User', '4633458b-17de-408a-b874-0445c86b69e6'],
  ['Key Vault Crypto Service Encryption User', 'e147488a-f6f5-4113-8e2d-b22465e65bf6'],
  // AI + search
  ['Cognitive Services Contributor', '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68'],
  ['Cognitive Services OpenAI User', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'],
  ['Cognitive Services User', 'a97b65f3-24c7-4388-baec-2e87135dc908'],
  ['Search Index Data Reader', '1407120a-92aa-4202-b7e9-c0e197c71c8f'],
  ['Search Service Contributor', '7ca78c08-252a-4471-8644-bb5ff32d4ba0'],
  // Monitor
  ['Grafana Viewer', '60921a7e-fef1-4a43-9b16-a26c52ad4769'],
  ['Log Analytics Contributor', '92aaf0da-9dab-42b6-94a3-d43ce8d16293'],
  ['Monitoring Contributor', '749f88d5-cbae-40b8-bcfc-e573ddc772fa'],
  // Networking
  ['Network Contributor', '4d97b98b-1d4f-4787-a291-c67834d212e7'],
  ['Private DNS Zone Contributor', 'b12aa53e-6015-4669-85d0-8515ebb3ae7f'],
  // Databases / integration / web
  ['DocumentDB Account Contributor', '5bd9cd88-fe45-4216-938b-f97437e15450'],
  ['SQL DB Contributor', '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec'],
  ['Logic App Contributor', '87a39d53-fc1b-424a-814c-f7e04687dc9e'],
  ['Website Contributor', 'de139f84-1756-47ae-9be6-808fbbe84772'],
];

/**
 * Abbreviations this repo genuinely uses for a role, each checked against the
 * declaration it appears on. An alias is only safe when it is unambiguous
 * across the whole built-in catalogue, so each one is justified individually —
 * an alias that could denote two roles is how a guard starts asserting things
 * it has not established.
 */
export const ALIASES = new Map([
  // `blobData*` — the only "Blob Data" roles in Azure are the Storage ones.
  ['blobdatacontributor', 'Storage Blob Data Contributor'],
  ['blobdataowner', 'Storage Blob Data Owner'],
  ['blobdatareader', 'Storage Blob Data Reader'],
  ['blobowner', 'Storage Blob Data Owner'],
  ['storageblobdatacontrib', 'Storage Blob Data Contributor'],
  // builtin-mcp.bicep's queue grant; "Queue Data Contributor" has one referent.
  ['queuecontrib', 'Storage Queue Data Contributor'],
  // Event Hubs roles are spelled without the leading "Azure " in bicep vars.
  ['eventhubsdataowner', 'Azure Event Hubs Data Owner'],
  ['eventhubsdatareceiver', 'Azure Event Hubs Data Receiver'],
  ['eventhubsdatasender', 'Azure Event Hubs Data Sender'],
  // Key Vault: no other built-in role is called "Secrets User".
  ['secretsuser', 'Key Vault Secrets User'],
  ['kvcryptosvcencuser', 'Key Vault Crypto Service Encryption User'],
  // AOAI: "OpenAI User" is Cognitive Services OpenAI User; the Contributor
  // variant is spelled out in full wherever it is used.
  ['openaiuser', 'Cognitive Services OpenAI User'],
  // workspace-rbac / label-rbac spell RBAC Administrator this way.
  ['rbacadmin', 'Role Based Access Control Administrator'],
  // sql-database-share-rbac.bicep, which also names it in a trailing comment.
  ['sqldbcontrib', 'SQL DB Contributor'],
]);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_SRC = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** How much of a canonical id a foreign GUID must share before C3 speaks. */
export const NEAR_MISS_PREFIX = 19; // "b24988ac-6180-42a0-" — 16 hex digits.

/** Lowercase alphanumerics only. Case and punctuation are not semantics here. */
export function normalise(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const SUFFIXES = [
  'roledefinitionid', 'roledefinition', 'roledefid',
  'roleguid', 'roleid', 'guid', 'role', 'id',
];

/**
 * Every plausible normalised form of a label, so `contributorRoleId`,
 * `RBAC_CONTRIBUTOR` and `// Contributor` all reach the same key. Generating
 * candidates and requiring an UNAMBIGUOUS hit is safer than one clever regex:
 * if two candidates land on two different roles the label is not resolved at
 * all, rather than resolved to whichever the code tried first.
 */
export function labelCandidates(raw) {
  const out = new Set();
  const add = (v) => { if (v) out.add(v); };
  // A trailing parenthetical is a note, not part of the name:
  //   "Storage Blob Data Reader (global built-in)".
  const stripped = String(raw ?? '').replace(/\([^)]*\)/g, ' ');
  for (const base of [normalise(raw), normalise(stripped)]) {
    if (!base) continue;
    add(base);
    for (const suf of SUFFIXES) {
      if (base.length > suf.length && base.endsWith(suf)) {
        const cut = base.slice(0, -suf.length);
        add(cut);
        if (cut.startsWith('role') && cut.length > 4) add(cut.slice(4));
        if (cut.startsWith('rbac') && cut.length > 4) add(cut.slice(4));
        break; // longest match wins; stacking suffixes invents keys
      }
    }
    if (base.startsWith('role') && base.length > 4) add(base.slice(4));
    if (base.startsWith('rbac') && base.length > 4) add(base.slice(4));
  }
  return [...out];
}

function buildLookup() {
  const m = new Map();
  for (const [name] of CANONICAL) m.set(normalise(name), name);
  for (const [alias, name] of ALIASES) m.set(alias, name);
  return m;
}
const LOOKUP = buildLookup();
const BY_NAME = new Map(CANONICAL.map(([n, g]) => [n, g.toLowerCase()]));
const CANON_GUIDS = new Set(BY_NAME.values());

/**
 * @returns {{name:string}|{ambiguous:string[]}|null} the single role the label
 *   denotes, the competing roles when it denotes more than one, or null.
 */
export function resolveLabel(raw) {
  const hits = new Set();
  for (const c of labelCandidates(raw)) {
    const n = LOOKUP.get(c);
    if (n) hits.add(n);
  }
  if (hits.size === 1) return { name: [...hits][0] };
  if (hits.size > 1) return { ambiguous: [...hits].sort() };
  return null;
}

// ── harvest ──────────────────────────────────────────────────────────────────

export const SCAN_ROOTS = ['platform/fiab/bicep', 'apps/fiab-console', 'scripts', '.github'];
const SCAN_EXT = /\.(bicep|ts|tsx|mjs|cjs|js|sh|ya?ml)$/;
const SKIP_DIR = new Set(['node_modules', '__tests__', '__fixtures__', '.next', 'dist', 'build', 'coverage', '.turbo']);
const SKIP_FILE = /(\.test\.|\.spec\.)/;
/**
 * This file IS the reference table, so harvesting it would compare CANONICAL
 * against itself and can never fail — a self-satisfying entry in the
 * population, which is the pattern that let a billing record pass an ownership
 * test elsewhere in this repo.
 */
const SELF = 'scripts/ci/check-role-guid-consistency.mjs';

export function scanFiles(root = REPO_ROOT, roots = SCAN_ROOTS) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(path.join(d, e.name));
      } else if (SCAN_EXT.test(e.name) && !SKIP_FILE.test(e.name)) {
        out.push(path.join(d, e.name));
      }
    }
  };
  for (const r of roots) {
    const abs = path.join(root, r);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out.sort();
}

// Each key regex ENDS at the closing quote of its value and asserts a legal
// terminator with a LOOKAHEAD instead of consuming it. That matters: the
// same-object test below measures the brackets in the text BETWEEN two keys,
// and a tail that swallowed `, why: 'x' },` would hide the `}` that closes the
// object — the boundary would then be invisible to the very test that needs it.
//
// The terminator set is `, ; } ] )` and not just `, ;`: `guid: '…' },` closes
// its object on the value's own line, which is ordinary formatting and which an
// earlier cut of this regex silently refused to match — a harvester that drops
// a shape reports a clean tree for it forever.
const OBJ_TAIL = "(?=\\s*[,;}\\])]|\\s*$)";
const OBJ_ROLENAME_RE = new RegExp(`^\\s*\\{?\\s*role[_]?[Nn]ame\\s*:\\s*['"]([^'"]+)['"]${OBJ_TAIL}`);
const OBJ_BARENAME_RE = new RegExp(`^\\s*\\{?\\s*[Nn]ame\\s*:\\s*['"]([^'"]+)['"]${OBJ_TAIL}`);
const OBJ_GUID_KEYS = "guid|roleGuid|roleId|roleDefinitionId|roleDefinitionGuid";
const OBJ_GUID_RE = new RegExp(`^\\s*\\{?\\s*(?:${OBJ_GUID_KEYS})\\s*:\\s*['"](${GUID_SRC})['"]${OBJ_TAIL}`);
// S2 — the whole object on one line. `{ name: 'X', guid: 'g' }` is not reachable
// by the anchored keys above (the guid key is not at the start of the line), so
// without this the most compact form of the defect is unreadable.
const ONE_LINE_OBJ_RE = new RegExp(
  `\\{[^{}]*?\\b(?:name|roleName|role_name)\\s*:\\s*['"]([^'"]+)['"][^{}]*?\\b(?:${OBJ_GUID_KEYS})\\s*:\\s*['"](${GUID_SRC})['"]`,
);
const ONE_LINE_OBJ_REV_RE = new RegExp(
  `\\{[^{}]*?\\b(?:${OBJ_GUID_KEYS})\\s*:\\s*['"](${GUID_SRC})['"][^{}]*?\\b(?:name|roleName|role_name)\\s*:\\s*['"]([^'"]+)['"]`,
);
// S3 — `var x = …`, `const x = …`, and bicep's `param x string = …`.
const DECL_RE = new RegExp(
  `^\\s*(?:export\\s+)?(?:var|const|let|param)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?::[^=]*|\\s+string\\s*)?=\\s*(.*)$`,
);
const ENV_RE = new RegExp(`^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$`);
// `'guid';  // Key Vault Secrets User` — the statement terminator sits BETWEEN
// the value and the comment, so it has to be consumed here, not stripped off
// the end of the line.
const QUOTED_GUID_RE = new RegExp(`^['"]?(${GUID_SRC})['"]?\\s*[;,]*\\s*(?://\\s*(.*)|#\\s*(.*))?$`);
/**
 * S6 — a map entry keyed by the role NAME. THE shape this guard could not read
 * until the #3608 rework: `SQL_DATABASE_ROLES` and `BLOB_DATA_ROLES` are
 * `Record<string,string>` literals whose KEY is the role name and whose value
 * reaches ARM, and a YAML mapping has the same shape. The key may be quoted or
 * bare; a key that resolves to no known role becomes residue, never a guess.
 */
const MAP_KEY_RE = new RegExp(
  `^\\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z][A-Za-z0-9_.-]*))\\s*:\\s*['"](${GUID_SRC})['"]${OBJ_TAIL}`,
);
/** S7 — an array member: a bare quoted GUID, optionally labelled by a comment. */
const ARRAY_MEMBER_RE = new RegExp(
  `^\\s*['"](${GUID_SRC})['"]\\s*,?\\s*(?:(?://\\s*(.*))|(?:#\\s*(.*)))?$`,
);
/**
 * S8 — an inline role-definition id, the single largest shape in the bicep.
 *
 * Two regexes, because the call is routinely WRAPPED: the bicep formatter puts
 * `subscriptionResourceId(` on one line, the `'…/roleDefinitions',` argument on
 * the next and the id on a third. A single-line matcher reads the compact form
 * and is silently blind to the wrapped one — the continuation-line blindness
 * this repo has already paid for in a different guard, and measured here on
 * ai-search.bicep where every wrapped grant sat in the unread residue.
 */
const INLINE_ROLEDEF_RE = new RegExp(`roleDefinitions['"/][^'"]*?['"](${GUID_SRC})['"]`);
const ROLEDEF_MARKER_RE = /roleDefinitions['"/,)\s]/;
const BARE_GUID_LINE_RE = new RegExp(`^\\s*['"](${GUID_SRC})['"]`);
/** How far past a wrapped `…/roleDefinitions',` the id may sit. */
const ROLEDEF_CONTINUATION = 2;
const COMMENT_ONLY_RE = /^\s*(?:\/\/|#)\s*(.+?)\s*$/;

/** How far from a role-GUID key its name-key partner may sit. */
export const OBJECT_WINDOW = 6;

/**
 * Strip string literals and line comments so the bracket counting below sees
 * structure and not content. A `{` inside `'${x}'` is not an object.
 */
function codeOnly(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

/**
 * True when the text between two keys leaves the object that contains the
 * first one. THE fix for the false pairing measured on rework: the old scan
 * took the nearest name key in either direction, so an object that closed on
 * its own GUID line handed the NEXT object's `name:` a shorter distance than
 * its own. Both halves were measured — two CORRECT bindings produced a false
 * C1, and `{ name: 'Contributor', why: …, guid: '<Reader id>' }` produced NO
 * finding at all, a false negative in the exact name/GUID-swap class this
 * guard exists for. A distance window cannot express "same object"; brackets
 * can. The below-direction stays open because it is real —
 * app-resources.ts writes `roleGuid:` with `roleName:` on the next line.
 */
function crossesObjectBoundary(span) {
  let depth = 0;
  for (const raw of span.split('\n')) {
    for (const ch of codeOnly(raw)) {
      if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth < 0) return true; // left the enclosing object
      }
    }
  }
  return depth !== 0; // entered a nested one and never came back out
}

/** The text strictly between two matches, `a` at or above `b`. */
function spanBetween(lines, aLine, aEnd, bLine, bStart) {
  if (aLine === bLine) return lines[aLine].slice(aEnd, bStart);
  const parts = [lines[aLine].slice(aEnd)];
  for (let k = aLine + 1; k < bLine; k += 1) parts.push(lines[k]);
  parts.push(lines[bLine].slice(0, bStart));
  return parts.join('\n');
}


/**
 * Every (label, guid) binding in one file.
 *
 * ── LOGICAL LINES, NOT PHYSICAL ONES (#3420) ───────────────────────────────
 * The scan roots include `scripts/` and `.github/`, i.e. `.sh` and `.yml`, and
 * MOST of the shapes below need the label and the GUID on ONE line: S2
 * `{ name: 'X', guid: 'g' }`, S5 `const A = 'g'; // Role Name`, S6
 * `'Role Name': 'g'`, S7 `'g', // Role Name`, S8 `roleDefinitions … 'g'`. A
 * shell author routinely folds exactly that pair across a trailing `\`:
 *
 *     az role assignment create --assignee "$OID" \
 *       --role "b24988ac-6180-42a0-bb6f-b91a8f3d3d0e"   # Contributor
 *
 * Judged by PHYSICAL line the second token is on a line the matcher has
 * already left, the binding is not harvested at all, and the guard reports the
 * tree clean — the #3417 class this repo has paid for twice, and the reason
 * check-guard-logical-lines.mjs exists. So the source is folded FIRST, by the
 * one shared primitive, and every index below is an index into LOGICAL lines.
 *
 * `lineNo[i]` keeps the 1-based PHYSICAL line the logical line STARTS on, so a
 * finding still points a reader at the code. A file with no continuation folds
 * to itself — every `.ts` and `.bicep` here — so this widens what is read
 * without changing how anything already read is judged.
 *
 * `unparsed` is NOT the same as "nothing here": a declaration whose identifier
 * names a known role but whose value this cannot read is returned so the
 * caller can fail on it. An empty value read as harmless is the specific way a
 * guard elsewhere in this repo went quiet on the line carrying the defect.
 *
 * `unharvested` is the honest measure of this guard's blind spot: a line that
 * carries a canonical role id (or a near-miss to one) and that NO shape below
 * claimed. It is not judged — this cannot establish that such a line is a
 * binding at all — but it is counted and printed, because the alternative is a
 * gap that is invisible rather than merely unread.
 */
export function harvest(source, file = '<memory>') {
  const logical = readLogicalLines(source);
  const lines = logical.map((l) => l.text);
  /** 1-based PHYSICAL line each logical line starts on. */
  const lineNo = logical.map((l) => l.line);
  const pairs = [];
  const unparsed = [];
  const claimed = new Set(); // 0-based LOGICAL line indexes some shape read


  /** The nearest name key that is inside the SAME object as the guid key. */
  const findPartner = (i, guidStart, guidEnd) => {
    for (let d = 1; d <= OBJECT_WINDOW; d += 1) {
      for (const j of [i - d, i + d]) {
        if (j < 0 || j >= lines.length) continue;
        if (OBJ_GUID_RE.test(lines[j])) continue; // a different object's guid
        const nm = OBJ_ROLENAME_RE.exec(lines[j]) || OBJ_BARENAME_RE.exec(lines[j]);
        if (!nm) continue;
        const span = j < i
          ? spanBetween(lines, j, nm[0].length, i, guidStart)
          : spanBetween(lines, i, guidEnd, j, nm.index);
        if (crossesObjectBoundary(span)) continue;
        return nm[1];
      }
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // S2 — the whole object on one line. Checked BEFORE the anchored keys so a
    // compact `{ name: 'X', guid: 'g' }` is not left to the line-anchored
    // matchers, which cannot see a key that is not at the start of the line.
    const one = ONE_LINE_OBJ_RE.exec(line);
    const oneRev = one ? null : ONE_LINE_OBJ_REV_RE.exec(line);
    if (one || oneRev) {
      const label = one ? one[1] : oneRev[2];
      const guid = one ? one[2] : oneRev[1];
      pairs.push({ file, line: lineNo[i], shape: 'S2', labels: [{ text: label, from: 'name' }], guid: guid.toLowerCase() });
      claimed.add(i);
      continue;
    }

    // S1 — object literal. ANCHORED ON THE GUID, then the nearest name key in
    // either direction THAT IS IN THE SAME OBJECT. `name:` above it (lz-rbac)
    // and `roleName:` below it (app-resources) are both real; the bracket test
    // is what keeps the next object's `name:` from winning on distance alone.
    const gm = OBJ_GUID_RE.exec(line);
    if (gm) {
      const label = findPartner(i, gm.index, gm[0].length);
      // A role-GUID key whose name key this could not find is RECORDED with no
      // label, not dropped. Dropping it would remove it from the residue count
      // as well as from the verdict, so a shape the harvester cannot pair would
      // be invisible in `--list` rather than merely unjudged.
      pairs.push({
        file,
        line: lineNo[i],
        shape: 'S1',
        labels: label ? [{ text: label, from: 'name' }] : [],
        guid: gm[1].toLowerCase(),
      });
      claimed.add(i);
      continue;
    }

    // S3 and S4 — a declaration or an env assignment.
    const dm = DECL_RE.exec(line);
    const em = dm ? null : ENV_RE.exec(line);
    const m = dm || em;
    if (m) {
      const ident = m[1];
      let rhs = m[2].trim();
      let atIdx = i;

      // A value on the FOLLOWING line is still this binding's value.
      if (rhs === '') {
        for (let j = i + 1; j < Math.min(lines.length, i + 3); j += 1) {
          if (lines[j].trim() === '') continue;
          rhs = lines[j].trim();
          atIdx = j;
          break;
        }
      }
      if (rhs === '' || /^(\/\/|#)/.test(rhs)) {
        if (resolveLabel(ident)?.name) unparsed.push({ file, line: lineNo[i], ident, why: 'value is empty' });
        continue;
      }

      const qm = QUOTED_GUID_RE.exec(rhs.replace(/,\s*$/, ''));
      if (qm) {
        const labels = [{ text: ident, from: 'identifier' }];
        const comment = qm[2] ?? qm[3];
        if (comment && comment.trim()) labels.push({ text: comment.trim(), from: 'comment' });
        pairs.push({ file, line: lineNo[atIdx], shape: dm ? 'S3' : 'S4', labels, guid: qm[1].toLowerCase() });
        claimed.add(i);
        claimed.add(atIdx);
        continue;
      }
      // Not a literal GUID — fall through: an `= subscriptionResourceId(…, 'g')`
      // still carries a literal id that S8 must see.
    }

    // S6 — a map entry keyed by the role name.
    const mk = MAP_KEY_RE.exec(line);
    if (mk) {
      const label = mk[1] ?? mk[2] ?? mk[3];
      pairs.push({ file, line: lineNo[i], shape: 'S6', labels: [{ text: label, from: 'map key' }], guid: mk[4].toLowerCase() });
      claimed.add(i);
      continue;
    }

    // S7 — an array member, labelled by its trailing comment when it has one.
    const am = ARRAY_MEMBER_RE.exec(line);
    if (am) {
      const comment = am[2] ?? am[3];
      pairs.push({
        file,
        line: lineNo[i],
        shape: 'S7',
        labels: comment && comment.trim() ? [{ text: comment.trim(), from: 'comment' }] : [],
        guid: am[1].toLowerCase(),
      });
      claimed.add(i);
      continue;
    }

    // S8 — an inline role-definition id, compact or wrapped across lines.
    if (ROLEDEF_MARKER_RE.test(line)) {
      const im = INLINE_ROLEDEF_RE.exec(line);
      let guid = im ? im[1] : null;
      let at = i;
      let tail = im ? line.slice(im.index + im[0].length) : '';
      if (!guid) {
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + ROLEDEF_CONTINUATION); j += 1) {
          const bm = BARE_GUID_LINE_RE.exec(lines[j]);
          if (bm) { guid = bm[1]; at = j; tail = lines[j].slice(bm[0].length); break; }
          if (lines[j].trim() === '') break;
        }
      }
      if (guid) {
        const trailing = /(?:\/\/|#)\s*(.+?)\s*$/.exec(tail);
        // Walk up past continuation lines of the SAME statement to the nearest
        // comment-only line. Stop at a brace, a blank, or any line that is
        // itself a binding (another roleDefinitions marker, or a GUID): a
        // comment on the far side of one of those belongs to a different
        // statement, and attributing it here would be a fabricated label. The
        // embedded control caught exactly that — two consecutive grants, the
        // first one's comment claimed by the second — before this ran on the
        // repo at all.
        let above = null;
        for (let j = i - 1; j >= 0 && j >= i - 3; j -= 1) {
          const cm = COMMENT_ONLY_RE.exec(lines[j]);
          if (cm) { above = cm[1]; break; }
          if (lines[j].trim() === '') break;
          if (/[{}]/.test(codeOnly(lines[j]))) break;
          if (ROLEDEF_MARKER_RE.test(lines[j]) || new RegExp(GUID_SRC).test(lines[j])) break;
        }
        const label = (trailing && trailing[1]) || above || null;
        pairs.push({
          file,
          line: lineNo[at],
          shape: 'S8',
          labels: label ? [{ text: label, from: 'comment' }] : [],
          guid: guid.toLowerCase(),
        });
        claimed.add(i);
        claimed.add(at);
        continue;
      }
    }
  }

  // The blind spot, counted. Anything left carrying a role-shaped id.
  const unharvested = [];
  const GUID_ANY = new RegExp(GUID_SRC, 'gi');
  for (let i = 0; i < lines.length; i += 1) {
    if (claimed.has(i)) continue;
    for (const g of lines[i].match(GUID_ANY) ?? []) {
      const lower = g.toLowerCase();
      const near = CANON_GUIDS.has(lower)
        || [...CANON_GUIDS].some((c) => c.slice(0, NEAR_MISS_PREFIX) === lower.slice(0, NEAR_MISS_PREFIX));
      if (near) unharvested.push({ file, line: lineNo[i], guid: lower });
    }
  }
  return { pairs, unparsed, unharvested };
}

export function inventory(root = REPO_ROOT, roots = SCAN_ROOTS) {
  const pairs = [];
  const unparsed = [];
  const unharvested = [];
  for (const abs of scanFiles(root, roots)) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel === SELF) continue;
    const h = harvest(fs.readFileSync(abs, 'utf8'), rel);
    pairs.push(...h.pairs);
    unparsed.push(...h.unparsed);
    unharvested.push(...h.unharvested);
  }
  return { pairs, unparsed, unharvested };
}

// ── checks ───────────────────────────────────────────────────────────────────

/**
 * @returns {{findings:object[], resolved:number, judged:object[], unresolved:object[]}}
 *   `judged` is every pair a role was actually established for. `--list` prints
 *   THAT rather than re-resolving the first label, because re-resolving printed
 *   "(not judged)" beside pairs this had in fact judged via their trailing
 *   comment — a listing asserting something the code did not establish (R7).
 */
export function evaluate(pairs) {
  const findings = [];
  const unresolved = [];
  const judged = [];
  let resolved = 0;

  for (const p of pairs) {
    const seen = new Map(); // role name -> the label that produced it
    let ambiguous = null;
    for (const l of p.labels) {
      const r = resolveLabel(l.text);
      if (!r) continue;
      if (r.ambiguous) { ambiguous = { label: l, roles: r.ambiguous }; continue; }
      if (!seen.has(r.name)) seen.set(r.name, l);
    }

    if (seen.size > 1) {
      const parts = [...seen.entries()].map(([n, l]) => `${l.from} "${l.text}" -> ${n}`);
      findings.push({
        check: 'C2',
        file: p.file,
        line: p.line,
        detail:
          `this binding carries two labels naming DIFFERENT built-in roles (${parts.join('; ')}). ` +
          'One of them is wrong — which one is not something this guard can establish, so it names ' +
          'both rather than picking. Make the identifier and the comment agree, then C1 can check the GUID.',
      });
      continue;
    }

    if (seen.size === 0) {
      unresolved.push({
        file: p.file,
        line: p.line,
        guid: p.guid,
        labels: p.labels.map((l) => l.text),
        why: ambiguous
          ? `label "${ambiguous.label.text}" matches ${ambiguous.roles.join(' and ')}`
          : p.labels.length === 0
            ? 'a role-GUID key with no name key found within the object window'
            : 'no label resolves to a known built-in role',
      });
      continue;
    }

    resolved += 1;
    const [name, label] = [...seen.entries()][0];
    const want = BY_NAME.get(name);
    judged.push({ file: p.file, line: p.line, labels: p.labels.map((l) => l.text), guid: p.guid, role: name, ok: p.guid === want });
    if (p.guid !== want) {
      // R7. The old wording said, unconditionally, "ARM resolves a grant by the
      // id, not by the name, so every role assignment written from this value
      // is rejected." That is true only when the bound GUID names NO role.
      // Bind Contributor to Reader's real id and ARM ACCEPTS the PUT and grants
      // Reader — a silent under-privilege (or, reversed, a silent escalation),
      // and a materially harder failure to find than a rejected call, because
      // an engineer goes looking through deploy logs for an error that never
      // happened. This guard holds CANON_GUIDS and can tell the two cases
      // apart, so it must. Where its table is partial it says so instead of
      // asserting the outcome it happens to have seen most often.
      const other = [...BY_NAME.entries()].find(([, g]) => g === p.guid);
      const consequence = other
        ? `${p.guid} is the documented id of "${other[0]}". ARM resolves a grant by the id and not by the ` +
          `name, so it ACCEPTS this assignment and grants "${other[0]}" — silently, with no error to find ` +
          'in a deploy log. Depending on the direction that is an under-privilege or an escalation.'
        : `${p.guid} is not an id this guard's (deliberately partial) table carries, so it cannot establish ` +
          'which of two outcomes applies: if the value names no role definition ARM REJECTS every assignment ' +
          'written from it, and if it names a role this table does not list ARM ACCEPTS the assignment and ' +
          'grants THAT role instead. Resolve it with: az role definition list --custom-role-only false ' +
          `--query "[?name=='${p.guid}']".`;
      findings.push({
        check: 'C1',
        file: p.file,
        line: p.line,
        detail:
          `the ${label.from} "${label.text}" names the built-in role "${name}", whose role definition id is ` +
          `${want}, but the value bound here is ${p.guid}. ` +
          // The one thing that IS established in both branches, stated first so
          // it survives however the rest is skimmed.
          `Established either way: this binding does not grant "${name}". ${consequence}` +
          ' Azure built-in role ids are identical in Commercial, GCC, GCC-High and DoD, so this is wrong in ' +
          'every cloud. Source: learn.microsoft.com/azure/role-based-access-control/built-in-roles.',
      });
    }
  }

  // C3 — a foreign GUID that closely resembles exactly one canonical id.
  for (const p of pairs) {
    if (CANON_GUIDS.has(p.guid)) continue;
    const near = [...BY_NAME.entries()].filter(([, g]) => g.slice(0, NEAR_MISS_PREFIX) === p.guid.slice(0, NEAR_MISS_PREFIX));
    if (near.length !== 1) continue;
    const [name, guid] = near[0];
    if (findings.some((f) => f.check === 'C1' && f.file === p.file && f.line === p.line)) continue;
    findings.push({
      check: 'C3',
      file: p.file,
      line: p.line,
      detail:
        `${p.guid} is not any Azure built-in role id known to this guard, and it shares its first ` +
        `${NEAR_MISS_PREFIX} characters with "${name}" (${guid}). This guard does NOT establish that ` +
        `${name} was intended — only that the value matches no known role and closely resembles one, ` +
        'which is what a corrupted copy of a role id looks like. Confirm the value against ' +
        'learn.microsoft.com/azure/role-based-access-control/built-in-roles.',
    });
  }

  return { findings, resolved, judged, unresolved };
}

// ── F1: the reference table must itself be sound ─────────────────────────────

export function tableFaults() {
  const out = [];
  const names = new Set();
  const guids = new Map();
  for (const [name, guid] of CANONICAL) {
    if (!GUID_RE.test(guid)) out.push(`"${name}" has a malformed id: ${guid}`);
    if (names.has(name)) out.push(`"${name}" is listed twice`);
    names.add(name);
    const g = guid.toLowerCase();
    if (guids.has(g)) out.push(`${g} is listed for both "${guids.get(g)}" and "${name}"`);
    guids.set(g, name);
  }
  // C3 assumes a >= NEAR_MISS_PREFIX prefix identifies at most one role. If two
  // canonical ids ever collide on that prefix, C3's premise is gone and it must
  // say so rather than keep reporting.
  const byPrefix = new Map();
  for (const [name, guid] of CANONICAL) {
    const p = guid.toLowerCase().slice(0, NEAR_MISS_PREFIX);
    if (byPrefix.has(p)) out.push(`"${byPrefix.get(p)}" and "${name}" share a ${NEAR_MISS_PREFIX}-char id prefix; C3 cannot be trusted`);
    byPrefix.set(p, name);
  }
  for (const [alias, name] of ALIASES) {
    if (!BY_NAME.has(name)) out.push(`alias "${alias}" points at "${name}", which is not in CANONICAL`);
    if (normalise(alias) !== alias) out.push(`alias "${alias}" is not in normalised form`);
  }
  return out;
}

// ── F4: embedded controls, one per harvest shape ─────────────────────────────

/**
 * Synthetic inputs that exercise EVERY shape the harvester claims to read. A
 * population floor (`found >= 1`) is satisfied by the shapes that still work
 * while a broken one goes silent, so the controls are per-shape and each one
 * carries both a WRONG case that must be found and a RIGHT case that must not.
 *
 * The wrong cases are ADDITIVE — each fixture also contains a correct binding —
 * because a mutation that replaces the only entry trips the population floor
 * and reads as proven when nothing was proven.
 */
export const CONTROLS = [
  {
    id: 'object-literal',
    // The real pre-fix lz-rbac.ts shape, alongside its two correct siblings.
    source: [
      "export const R = [",
      "  { name: 'Contributor',",
      "    guid: 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e', why: 'x' },",
      "  { name: 'Storage Blob Data Contributor',",
      "    guid: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe', why: 'x' },",
      "  { name: 'Azure Event Hubs Data Owner',",
      "    guid: 'f526a384-b230-433a-b45c-95f59c4a2dec', why: 'x' },",
      "];",
    ].join('\n'),
    expect: { C1: 1, resolved: 3 },
  },
  {
    id: 'object-literal-one-line-close',
    // `guid: '…' },` — the object closes on the value's own line. An earlier
    // terminator set of only `, ;` refused this shape, so a wrong id written
    // this way would never have been seen.
    source: [
      "const R = [",
      "  { name: 'Contributor',",
      "    guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
      "  { name: 'Reader',",
      "    guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
      "];",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'one-line-close-with-intervening-line-WRONG',
    // THE rework case, must-fire half. An intervening `why:` sits between
    // `name:` and `guid:`, and the object closes on the guid line — so the NEXT
    // object's `name:` is one line nearer than this object's own. Measured on
    // the shipped guard: ZERO findings, a false negative in the exact
    // name/GUID-swap class the guard exists for. Contributor is bound to
    // Reader's real id, so this must be C1 and must name Contributor.
    source: [
      "const R = [",
      "  { name: 'Contributor',",
      "    why: 'the DLZ attach needs it',",
      "    guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
      "  { name: 'Reader',",
      "    guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
      "];",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'one-line-close-with-intervening-line-CORRECT',
    // Must-NOT-fire half of the same shape: identical layout, both bindings
    // correct. The shipped guard reported a FALSE C1 here, having labelled
    // Contributor's own (correct) id "Reader". Silence is the only right answer.
    source: [
      "const R = [",
      "  { name: 'Contributor',",
      "    why: 'the DLZ attach needs it',",
      "    guid: 'b24988ac-6180-42a0-ab88-20f7382dd24c' },",
      "  { name: 'Reader',",
      "    guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
      "];",
    ].join('\n'),
    expect: { C1: 0, C3: 0, resolved: 2 },
  },
  {
    id: 'one-line-object',
    // S2: the whole object on one line. The line-anchored keys cannot see a
    // `guid:` that is not at the start of the line, so without S2 the most
    // compact spelling of the defect is unreadable.
    source: [
      "  { name: 'Contributor', guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
      "  { name: 'Reader', guid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'name-keyed-map',
    // S6: THE shape the rework review reintroduced this story's own defect in
    // (azure-sql-client.ts SQL_DATABASE_ROLES, read at grantDatabaseRole to
    // choose the id that reaches ARM) and got exit 0, GREEN, with the
    // population unchanged. A name-keyed Record<string,string> is the most
    // explicit name-to-GUID form in the repo.
    source: [
      "export const SQL_DATABASE_ROLES: Record<string, string> = {",
      "  'Reader':             'acdd72a7-3385-48ef-bd42-f606fba81ae7',",
      "  'Contributor':        'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e',",
      "  'SQL DB Contributor': '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec',",
      "};",
    ].join('\n'),
    expect: { C1: 1, resolved: 3 },
  },
  {
    id: 'name-keyed-map-yaml',
    // The same shape with a bare key, as a YAML mapping writes it.
    source: [
      "roles:",
      "  Contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'",
      "  Reader: 'b24988ac-6180-42a0-ab88-20f7382dd24c'",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'array-member-comment',
    // S7: the Gov workflow shape (gov-workspace-identity.yml), which the
    // rework review found was pinned nowhere — a cloud-parity gap, not just a
    // coverage one.
    source: [
      "          roles: [",
      "            'ba92f5b4-2d11-453d-a403-e96b0029c9fe', // Storage Blob Data Contributor",
      "            'ba92f5b4-2d11-453d-a403-e96b0029c9fe', // Azure Event Hubs Data Sender",
      "          ]",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'inline-role-definition-id',
    // S8: the largest binding shape in platform/fiab/bicep. Usually unlabelled,
    // so the correct sibling must stay silent while the labelled one is judged.
    source: [
      "  // Contributor",
      "  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e')",
      "  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')",
    ].join('\n'),
    expect: { C1: 1, resolved: 1 },
  },
  {
    id: 'inline-role-definition-id-WRAPPED',
    // The dominant formatting in this repo: the bicep formatter splits the call
    // over three lines, so the id is nowhere near the `roleDefinitions` marker.
    // A single-line matcher reads the compact form above and is silently blind
    // to this one — measured on ai-search.bicep, where every wrapped grant sat
    // in the unread residue. Must-fire and must-not-fire, both wrapped.
    source: [
      "    // Search Service Contributor",
      "    roleDefinitionId: subscriptionResourceId(",
      "      'Microsoft.Authorization/roleDefinitions',",
      "      'acdd72a7-3385-48ef-bd42-f606fba81ae7')",
      "",
      "    // Reader",
      "    roleDefinitionId: subscriptionResourceId(",
      "      'Microsoft.Authorization/roleDefinitions',",
      "      'acdd72a7-3385-48ef-bd42-f606fba81ae7')",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'inline-role-definition-id-comment-not-stolen',
    // The label walk must not reach past another binding. Two consecutive
    // grants where only the FIRST is commented: the second must stay
    // unlabelled rather than inherit its neighbour's comment. The embedded
    // control caught this in the walk before it ever ran on the repo.
    source: [
      "  // Contributor",
      "  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')",
      "  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')",
    ].join('\n'),
    expect: { C1: 0, C3: 0, resolved: 1 },
  },
  {
    id: 'bicep-param-default',
    source: [
      "param contributorRoleId string = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'",
      "param readerRoleId string = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'object-literal-name-after-guid',
    // The real app-resources.ts shape: `roleGuid:` first, `roleName:` second,
    // and an unrelated `name:` (an ENV VAR) six lines up that must NOT be
    // mistaken for the role. Both halves of the bug found on 2026-08-17.
    source: [
      "  envVars: [",
      "    { name: 'LOOM_ADLS_ACCOUNT', value: env('LOOM_ADLS_ACCOUNT') },",
      "  ],",
      "  grantScope: armId(a, b, c),",
      "  roleGuid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7',",
      "  roleName: 'Storage Blob Data Contributor',",
    ].join('\n'),
    expect: { C1: 1, resolved: 1 },
  },
  {
    id: 'bare-name-decoy-not-paired',
    // Same decoy, but with NO roleName anywhere. The env var's `name:` sits in
    // a DIFFERENT object — the bracket test, not a distance window, is what
    // rejects it — so nothing is paired at all. Silence here is correct, and a
    // pair would be a fabricated one.
    source: [
      "  envVars: [",
      "    { name: 'Contributor', value: env('X') },",
      "  ],",
      "  grantScope: armId(a, b, c),",
      "  roleGuid: 'acdd72a7-3385-48ef-bd42-f606fba81ae7',",
    ].join('\n'),
    expect: { C1: 0, C3: 0, resolved: 0 },
  },
  {
    id: 'declaration',    source: [
      "var contributorRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'",
      "var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'env-assignment',
    source: [
      'CONTRIBUTOR_ROLE_ID="b24988ac-6180-42a0-ab88-20f7382dd24c"',
      'READER_ROLE_ID="b24988ac-6180-42a0-ab88-20f7382dd24c"',
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'trailing-comment-label',
    source: [
      "const A = '4633458b-17de-408a-b874-0445c86b69e6'; // Key Vault Secrets User",
      "const B = '00482a5a-887f-4fb3-b363-3b7fe8e74483'; // Key Vault Secrets User",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'next-line-value',
    source: [
      'var ownerRoleId =',
      "  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'",
      'var readerRoleId =',
      "  '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'near-miss-unlabelled',
    // No resolvable label at all, so C1 cannot speak — C3 must.
    source: "var frobnicatorRoleId = 'b24988ac-6180-42a0-9999-999999999999'",
    expect: { C3: 1, resolved: 0 },
  },
  {
    id: 'folded-shell-roledef-WRONG',
    // #3420, and MEASURED against the pre-adoption revision of this file: on
    // PHYSICAL lines this fixture yields ZERO pairs and ZERO findings. The
    // `roleDefinitions` marker sits on one physical line and the id on the
    // next, mid-line, where the bare-GUID lookahead cannot reach it — so the
    // grant is not harvested at all and the guard reports the tree clean. That
    // is the #3417 shape: a zero that gets read as evidence. `scripts/` and
    // `.github/` are scan roots and 196 of the 280 shell/YAML files under them
    // carry a backslash fold, so this is the ordinary way the shape is written,
    // not a contrived one. Additive: the correct sibling must stay silent.
    source: [
      'az role assignment create --assignee "$OID" \\',
      '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
      "  --id 'acdd72a7-3385-48ef-bd42-f606fba81ae7' --scope \"$SCOPE\"   # Contributor",
      'az role assignment create --assignee "$OID" \\',
      '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
      "  --id 'acdd72a7-3385-48ef-bd42-f606fba81ae7' --scope \"$SCOPE\"   # Reader",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'folded-shell-roledef-CORRECT',
    // Must-NOT-fire half of the same shape. Without it, a matcher that flagged
    // every folded line would look proven by the fixture above alone.
    source: [
      'az role assignment create --assignee "$OID" \\',
      '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
      "  --id 'b24988ac-6180-42a0-ab88-20f7382dd24c' --scope \"$SCOPE\"   # Contributor",
      'az role assignment create --assignee "$OID" \\',
      '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
      "  --id 'acdd72a7-3385-48ef-bd42-f606fba81ae7' --scope \"$SCOPE\"   # Reader",
    ].join('\n'),
    expect: { C1: 0, C3: 0, resolved: 2 },
  },
  {
    id: 'folded-shell-env-assignment',
    // The other half of the blindness, and a different failure mode: on
    // physical lines this DID harvest a pair — the quoted id on its own line
    // reads as an array member — but with the identifier stranded on the line
    // above it, so the pair was UNLABELLED and resolved to nothing. A binding
    // that is harvested and never judged is not covered by the verdict either;
    // it just fails quietly in the residue instead of loudly in a finding.
    source: [
      'export CONTRIBUTOR_ROLE_ID=\\',
      "  'acdd72a7-3385-48ef-bd42-f606fba81ae7'",
      'export READER_ROLE_ID=\\',
      "  'acdd72a7-3385-48ef-bd42-f606fba81ae7'",
    ].join('\n'),
    expect: { C1: 1, resolved: 2 },
  },
  {
    id: 'escaped-backslash-does-not-splice',
    // The folding must not over-reach. An EVEN run of trailing backslashes is
    // an escaped backslash and the command ends there. Splice it and the
    // declaration below is swallowed into the echo, `var …` is no longer at
    // the start of its logical line, DECL_RE stops matching, and a wrong id
    // goes UNJUDGED — the same going-quiet failure this whole change is about,
    // arrived at from the opposite direction.
    source: [
      'echo "a literal trailing pair" \\\\',
      "var contributorRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'",
    ].join('\n'),
    expect: { C1: 1, resolved: 1 },
  },
  {
    id: 'clean',
    source: [
      "var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'",
      "const RBAC_READER = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';",
      "EVENTHUBS_DATA_SENDER='2b629674-e913-4c01-ae53-ef4638d8f975'",
    ].join('\n'),
    expect: { C1: 0, C3: 0, resolved: 3 },
  },
  {
    id: 'not-a-role-is-not-judged',
    // A first-party app id and a Cosmos SQL data role: neither is judged.
    source: [
      "var dbxResource = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d'",
      "var cosmosDataContributorGuid = '00000000-0000-0000-0000-000000000002'",
    ].join('\n'),
    expect: { C1: 0, C3: 0, resolved: 0 },
  },
];

export function controlFaults() {
  const out = [];
  for (const c of CONTROLS) {
    const { pairs } = harvest(c.source, `<control:${c.id}>`);
    const { findings, resolved } = evaluate(pairs);
    for (const [key, want] of Object.entries(c.expect)) {
      const got = key === 'resolved' ? resolved : findings.filter((f) => f.check === key).length;
      if (got !== want) out.push(`control "${c.id}": expected ${key}=${want}, got ${got}`);
    }
  }
  return out;
}

// ── F6: the shapes are sampled from the REPO, not from the implementation ────

/**
 * Excerpts of real binding sites, each pinned to the file it was copied from —
 * but pinned by SHAPE, never by value.
 *
 * F4's controls can only exercise shapes the harvester already implements, so
 * as a COVERAGE claim they are circular: they prove the implemented shapes
 * still work and are silent about a shape that was never implemented. That is
 * exactly how the name-keyed map stayed unread while a test named "CONTROLS
 * covers every harvest shape the guard claims to read" passed.
 *
 * These run the other way round. The population is the repo: the excerpt's
 * SHAPE must still be present in `file`, and harvesting the lines AS THEY
 * ACTUALLY ARE in that file must still yield `pairs` bindings of which
 * `resolved` resolve. Delete the shape from the harvester and F6 goes red;
 * reformat or move the code and F6 goes red.
 *
 * Every GUID in an excerpt is matched as a WILDCARD, and the lines harvested
 * are read back out of the file rather than out of this array. Both of those
 * are deliberate, and the first cut of this floor got it wrong: pinning the
 * literal id meant that changing a role's GUID — i.e. THE defect this whole
 * guard exists for — tripped F6 with the message "re-anchor the sample" before
 * C1 could say "this binding does not grant Contributor". A floor whose failure
 * text sends the reader at the fixture instead of at the bug is an R7 violation
 * in the guard's own output. F6 now answers "is this shape still read?"; C1
 * answers "is this value right?"; neither one masks the other. And because the
 * harvested text comes from the file, this cannot degrade into a fixture that
 * models the code instead of running against it.
 */
export const REPO_SHAPES = [
  {
    id: 'S1 object literal — lz-rbac.ts, the site of #3608',
    file: 'apps/fiab-console/lib/setup/lz-rbac.ts',
    excerpt: [
      "    name: 'Contributor',",
      "    guid: 'b24988ac-6180-42a0-ab88-20f7382dd24c',",
    ],
    expect: { pairs: 1, resolved: 1 },
  },
  {
    id: 'S3 declaration — workspace-grants.ts',
    file: 'apps/fiab-console/lib/azure/workspace-grants.ts',
    excerpt: ["export const MONITORING_CONTRIBUTOR = '749f88d5-cbae-40b8-bcfc-e573ddc772fa';"],
    expect: { pairs: 1, resolved: 1 },
  },
  {
    id: 'S6 name-keyed map — azure-sql-client.ts SQL_DATABASE_ROLES (a live grant path)',
    file: 'apps/fiab-console/lib/azure/azure-sql-client.ts',
    excerpt: [
      "  'Reader':             'acdd72a7-3385-48ef-bd42-f606fba81ae7',",
      "  'Contributor':        'b24988ac-6180-42a0-ab88-20f7382dd24c',",
      "  'SQL DB Contributor': '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec',",
    ],
    expect: { pairs: 3, resolved: 3 },
  },
  {
    id: 'S6 name-keyed map — adls-client.ts BLOB_DATA_ROLES (grant value AND allow-list)',
    file: 'apps/fiab-console/lib/azure/adls-client.ts',
    excerpt: [
      "  'Storage Blob Data Reader':       '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',",
      "  'Storage Blob Data Contributor':  'ba92f5b4-2d11-453d-a403-e96b0029c9fe',",
      "  'Storage Blob Data Owner':        'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',",
    ],
    expect: { pairs: 3, resolved: 3 },
  },
  {
    id: 'S7 array member + comment — gov-workspace-identity.yml (the GOV lane)',
    file: '.github/workflows/gov-workspace-identity.yml',
    excerpt: [
      "            'ba92f5b4-2d11-453d-a403-e96b0029c9fe', // Storage Blob Data Contributor",
      "            'a638d3c7-ab3a-418d-83e6-5f17a39d4fde', // Event Hubs Data Receiver",
      "            '2b629674-e913-4c01-ae53-ef4638d8f975', // Event Hubs Data Sender",
    ],
    expect: { pairs: 3, resolved: 3 },
  },
  {
    id: 'S8 inline role-definition id — adx-cluster.bicep',
    file: 'platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep',
    excerpt: [
      "    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')",
    ],
    expect: { pairs: 1, resolved: 0 },
  },
  {
    id: 'S8 inline role-definition id, WRAPPED + commented — ai-search.bicep',
    file: 'platform/fiab/bicep/modules/admin-plane/ai-search.bicep',
    excerpt: [
      '    // Search Service Contributor',
      '    roleDefinitionId: subscriptionResourceId(',
      "      'Microsoft.Authorization/roleDefinitions',",
      "      '7ca78c08-252a-4471-8644-bb5ff32d4ba0')",
    ],
    expect: { pairs: 1, resolved: 1 },
  },
];

/** An excerpt line as a regex with every GUID wildcarded. */
function shapePattern(line) {
  const parts = line.split(new RegExp(`(${GUID_SRC})`));
  const src = parts
    .map((p, k) => (k % 2 === 1 ? GUID_SRC : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}$`);
}

export function repoShapeFaults(root = REPO_ROOT) {
  const out = [];
  for (const s of REPO_SHAPES) {
    const abs = path.join(root, s.file);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch {
      out.push(`repo shape "${s.id}": ${s.file} is unreadable, so this sample is no longer anchored to anything`);
      continue;
    }
    const hay = src.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
    const pats = s.excerpt.map(shapePattern);
    let start = -1;
    for (let i = 0; i + pats.length <= hay.length && start < 0; i += 1) {
      if (pats.every((p, k) => p.test(hay[i + k]))) start = i;
    }
    if (start < 0) {
      out.push(
        `repo shape "${s.id}": ${s.file} no longer contains this shape (the GUIDs are wildcards here, so ` +
          'this is NOT about a value being wrong — a wrong value is C1\'s job). First line looked for: ' +
          `\`${s.excerpt[0].trim()}\`. Re-anchor the sample to the code as it is now; do NOT relax the check.`,
      );
      continue;
    }
    // Harvest the lines AS THEY ARE in the file, not the copy stored above.
    const actual = hay.slice(start, start + s.excerpt.length);
    const { pairs } = harvest(actual.join('\n'), s.file);
    const { resolved } = evaluate(pairs);
    const got = { pairs: pairs.length, resolved };
    for (const [k, want] of Object.entries(s.expect)) {
      if (got[k] !== want) {
        out.push(
          `repo shape "${s.id}": expected ${k}=${want}, got ${got[k]} — the harvester has stopped reading a ` +
            'shape the repo still uses, so every binding written that way is now unchecked.',
        );
      }
    }
  }
  return out;
}

// ── driver ───────────────────────────────────────────────────────────────────

export function scan(root = REPO_ROOT, roots = SCAN_ROOTS) {
  const { pairs, unparsed, unharvested } = inventory(root, roots);
  return { pairs, unparsed, unharvested, ...evaluate(pairs) };
}

function main() {
  const faults = [...tableFaults(), ...controlFaults(), ...repoShapeFaults()];
  if (faults.length > 0) {
    process.stderr.write(
      'check-role-guid-consistency: the guard itself is not sound, so its verdict on the repo means ' +
        'nothing and is not reported:\n' + faults.map((f) => `  ${f}\n`).join(''),
    );
    process.exit(1);
  }

  const { pairs, unparsed, unharvested, findings, resolved, judged, unresolved } = scan();

  // F2 — nothing harvested at all.
  if (pairs.length === 0) {
    process.stderr.write(
      'check-role-guid-consistency: discovered ZERO role-name/GUID bindings under ' +
        `${SCAN_ROOTS.join(', ')} — the matcher has drifted off the code, which is not the same as a ` +
        'clean tree.\n',
    );
    process.exit(1);
  }
  // F3 — bindings found, none of them resolvable to a role. Every label being
  // unknown means the normalisation or the alias table drifted, and a scanner
  // that resolves nothing has no verdict to give.
  if (resolved === 0) {
    process.stderr.write(
      `check-role-guid-consistency: harvested ${pairs.length} binding(s) but resolved NONE of them to a ` +
        'known built-in role — label normalisation or the alias table has drifted. No verdict.\n',
    );
    process.exit(1);
  }
  // A declaration naming a known role whose value could not be read is UNKNOWN,
  // not safe, and is the one thing here that is never skipped.
  if (unparsed.length > 0) {
    for (const u of unparsed) {
      process.stdout.write(`F5  ${u.file}:${u.line}\n      \`${u.ident}\` names a known built-in role but ${u.why}; this guard cannot establish which role definition it binds.\n\n`);
    }
    process.stderr.write(`check-role-guid-consistency: ${unparsed.length} role binding(s) with an unreadable value.\n`);
    process.exit(1);
  }

  if (process.argv.includes('--list')) {
    process.stdout.write(`judged (label resolved to a known built-in role): ${judged.length}\n`);
    for (const j of judged) {
      process.stdout.write(`  ${j.ok ? 'ok  ' : 'BAD '} ${j.file}:${j.line}  ${j.labels.join(' | ')}  ${j.guid}  -> ${j.role}\n`);
    }
    process.stdout.write(`\nNOT judged (no label resolves to a known built-in role — no claim made): ${unresolved.length}\n`);
    for (const u of unresolved) process.stdout.write(`  ${u.file}:${u.line}  ${u.labels.join(' | ')}  ${u.guid}  — ${u.why}\n`);
    process.stdout.write(
      "\nNOT harvested — this guard's measured blind spot. A role-shaped id on a line no shape reads, so\n" +
        `this cannot even establish whether it is a binding, let alone judge it: ${unharvested.length}\n`,
    );
    for (const u of unharvested) process.stdout.write(`  ${u.file}:${u.line}  ${u.guid}\n`);
    process.stdout.write('\n');
  }

  for (const f of findings) process.stdout.write(`${f.check}  ${f.file}:${f.line}\n      ${f.detail}\n\n`);
  if (findings.length > 0) {
    process.stderr.write(
      `check-role-guid-consistency: ${findings.length} finding(s) across ${resolved} resolved role binding(s) ` +
        `(${pairs.length} harvested). See issue #3608 and cloud-parity.md — built-in role ids are global, so a ` +
        'wrong one is wrong in every cloud.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-role-guid-consistency: OK — ${resolved} of ${pairs.length} harvested role binding(s) resolve to a ` +
      `known built-in role and every one carries that role's documented id; ${unresolved.length} not judged. ` +
      `${CONTROLS.length} embedded controls and ${REPO_SHAPES.length} repo-anchored shape samples held. ` +
      `${unharvested.length} role-shaped id(s) sit on lines no shape reads and are NOT covered by this verdict ` +
      '(--list names them).\n',
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}
