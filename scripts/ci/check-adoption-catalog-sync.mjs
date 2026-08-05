#!/usr/bin/env node
/**
 * check-adoption-catalog-sync — pins the adoption catalog to what actually
 * exists, so the drift that shipped six divergent service catalogs cannot
 * recur silently.
 *
 * ## What went wrong before, and why a test was not enough
 *
 * `apps/fiab-console/app/api/setup/__tests__/scan-services.test.ts` carries a
 * case titled "covers every flagged service the CLI knows (no drift)". It
 * asserts `expect(def.enabledFlag).toBeTruthy()`. It compares no flag name and
 * no env name against anything. So while it stayed green:
 *
 *   - `maps` carried `loomMapsEnabled` in `scripts/csa-loom/byo-wizard.sh` and
 *     `azureMapsEnabled` in TypeScript;
 *   - `foundry` carried `agentFoundryEnabled` in one and `aiFoundryEnabled` in
 *     the other — two DIFFERENT Azure accounts, so "reuse my AOAI" disabled
 *     different resources depending on which surface the operator used;
 *   - `EXISTING_MAPS`, `EXISTING_ADF`, `EXISTING_STORAGE`, `EXISTING_POSTGRES`
 *     and `EXISTING_KEYVAULT` had zero `.bicepparam` consumers at all.
 *
 * This guard compares NAMES against files on disk.
 *
 * ## What it asserts today (all blocking)
 *
 *   C1  every `enableFlag` is a parameter `platform/fiab/bicep/main.bicep`
 *       actually declares;
 *   C2  service keys and `provisionVar` names are unique;
 *   C3  every ARM type is lower-case (the ARG `type in~` literal is built
 *       from them verbatim, and `in~` is case-insensitive on the DATA, not on
 *       a malformed literal);
 *   C4  every `create-only` entry carries a substantive `createOnlyReason`,
 *       and every adoptable entry declares what Loom would CHANGE about it;
 *   C5  the scanner builds its ARM-type literal by CALLING `adoptionArmTypes()`
 *       — a hard-coded second list is the exact failure mode above;
 *   C6  the catalog is non-trivial, so none of the above can pass vacuously.
 *
 * ## What it does NOT yet assert, and why (stated, not hidden)
 *
 * The design also calls for asserting that each `provisionVar` exists in
 * `main.bicep` as `var <provisionVar> = <enableFlag> && adoptMode(adopt, '<key>')
 * == 'create'`, and that the module creating the service is gated on it. Those
 * vars land with the `adopt` param-bag change; they do not exist on `main`
 * today. Asserting them now would fail every build, and stubbing the assertion
 * to pass would be a guard that cannot fail.
 *
 * So the check is present but OPT-IN via `--require-provision-vars`, and the
 * guard PRINTS how many are still absent on every run. Turn the flag on in the
 * same PR that introduces the `adopt` bag. Until then this file honestly
 * measures C1–C6 and says so.
 *
 * Usage:
 *   node scripts/ci/check-adoption-catalog-sync.mjs
 *   node scripts/ci/check-adoption-catalog-sync.mjs --require-provision-vars
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const CATALOG = path.join(REPO, 'apps/fiab-console/lib/deploy/adoption-catalog.ts');
const MODEL = path.join(REPO, 'apps/fiab-console/lib/deploy/discovery-model.ts');
const MAIN_BICEP = path.join(REPO, 'platform/fiab/bicep/main.bicep');

const REQUIRE_PROVISION_VARS = process.argv.includes('--require-provision-vars');

const errors = [];
const notes = [];
function fail(msg) {
  errors.push(msg);
}

function read(p, label) {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    fail(`${label} could not be read at ${path.relative(REPO, p)}: ${e.message}`);
    return null;
  }
}

const catalogSrc = read(CATALOG, 'adoption-catalog.ts');
const modelSrc = read(MODEL, 'discovery-model.ts');
const bicepSrc = read(MAIN_BICEP, 'main.bicep');

if (!catalogSrc || !modelSrc || !bicepSrc) {
  console.error('[adoption-catalog-sync] FAIL — a required file is missing:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

// ---- parse the catalog -----------------------------------------------------
// A regex parse rather than importing TS: this guard must run under plain node
// in CI without a transform step, exactly like its sibling bicep guards.
function parseEntries(src) {
  const out = [];
  // Each entry begins at `key: '<k>',` inside the ADOPTION_CATALOG array.
  const re = /\{\s*\n\s*key:\s*'([^']+)',([\s\S]*?)\n\s*\},\n/g;
  for (const m of src.matchAll(re)) {
    const key = m[1];
    const body = m[2];
    const pick = (field) => {
      const mm = new RegExp(`\\n\\s*${field}:\\s*(?:'([^']*)'|(null))`).exec(body);
      if (!mm) return undefined;
      return mm[2] === 'null' ? null : mm[1];
    };
    const mutations = /mutations:\s*\[([\s\S]*?)\]/.exec(body);
    // createOnlyReason may be single- OR double-quoted: the Key Vault reason
    // contains an apostrophe ("Loom's Key Vault") so it is written with double
    // quotes. A single-quote-only pattern silently parsed it as absent and
    // reported a compliant entry as a violation — a parser bug reading as a
    // catalog bug, which is precisely the failure mode this guard warns about
    // elsewhere.
    const reason =
      /createOnlyReason:\s*\n?\s*'([\s\S]*?)',\n/.exec(body)?.[1] ??
      /createOnlyReason:\s*\n?\s*"([\s\S]*?)",\n/.exec(body)?.[1];
    out.push({
      key,
      armType: pick('armType'),
      cls: pick('cls'),
      enableFlag: pick('enableFlag'),
      provisionVar: pick('provisionVar'),
      createOnlyReason: reason,
      mutationCount: mutations ? (mutations[1].match(/'/g) || []).length / 2 : 0,
      raw: body,
    });
  }
  return out;
}

const entries = parseEntries(catalogSrc);

// C6 — the parse itself must be non-trivial, or every check below is vacuous.
if (entries.length < 15) {
  fail(
    `parsed only ${entries.length} catalog entries — the parser is broken or the catalog was ` +
      `gutted. Every check below would pass vacuously; refusing to report green.`,
  );
}
for (const e of entries) {
  if (!e.armType) fail(`${e.key}: no armType parsed`);
  if (!e.cls) fail(`${e.key}: no cls parsed`);
  if (e.provisionVar === undefined) fail(`${e.key}: no provisionVar parsed`);
  if (e.enableFlag === undefined) fail(`${e.key}: no enableFlag parsed`);
}

// ---- C1: every enableFlag is a real main.bicep parameter --------------------
const declaredParams = new Set(
  [...bicepSrc.matchAll(/^param\s+([A-Za-z0-9_]+)\s+/gm)].map((m) => m[1]),
);
if (declaredParams.size < 100) {
  fail(
    `main.bicep parse produced only ${declaredParams.size} parameters — the parser is wrong, so ` +
      `the flag check cannot be trusted.`,
  );
}
let flagged = 0;
for (const e of entries) {
  if (e.enableFlag === null) continue;
  flagged += 1;
  if (!declaredParams.has(e.enableFlag)) {
    fail(
      `${e.key}: enableFlag '${e.enableFlag}' is NOT a parameter declared in ` +
        `platform/fiab/bicep/main.bicep. Either the flag was renamed in bicep or invented here.`,
    );
  }
}
if (flagged < 10) {
  fail(`only ${flagged} entries carry an enableFlag — too few for C1 to mean anything.`);
}

// ---- C2: uniqueness --------------------------------------------------------
for (const [label, values] of [
  ['service key', entries.map((e) => e.key)],
  ['provisionVar', entries.map((e) => e.provisionVar)],
]) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) fail(`duplicate ${label}: '${v}'`);
    seen.add(v);
  }
}

// ---- C3: ARM types are lower-case ------------------------------------------
for (const e of entries) {
  if (e.armType !== e.armType.toLowerCase()) {
    fail(`${e.key}: armType '${e.armType}' must be lower-case (it is emitted into the ARG literal verbatim).`);
  }
}

// ---- C4: create-only explains itself; adoptable declares its mutations ------
for (const e of entries) {
  if (e.cls === 'create-only') {
    if (!e.createOnlyReason || e.createOnlyReason.length < 80) {
      fail(
        `${e.key}: cls 'create-only' requires a substantive createOnlyReason — "you can't" with no ` +
          `"because" is indistinguishable from "we didn't build it".`,
      );
    }
  } else if (e.cls === 'adoptable' || e.cls === 'adopt-required') {
    if (e.mutationCount < 1) {
      fail(
        `${e.key}: an adoptable service must declare what Loom CHANGES about an adopted instance ` +
          `(mutations[]); the operator sees this before confirming.`,
      );
    }
  }
}

// ---- C5: the scanner query is GENERATED, not a second hand-kept list --------
if (!/const types = adoptionArmTypes\(\)/.test(modelSrc)) {
  fail(
    `discovery-model.buildInventoryQuery no longer builds its type literal from ` +
      `adoptionArmTypes(). A hand-maintained second list is how 'maps', 'postgres' and 'storage' ` +
      `ended up offered by the wizard and absent from the deploy.`,
  );
}
for (const e of entries) {
  if (modelSrc.includes(`'${e.armType}'`)) {
    fail(`discovery-model.ts hard-codes the ARM type '${e.armType}' — it must come from the catalog.`);
  }
}

// ---- provisionVar wiring (opt-in until the adopt bag lands) -----------------
const declaredVars = new Set([...bicepSrc.matchAll(/^var\s+([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]));
const missingVars = entries.filter((e) => !declaredVars.has(e.provisionVar));
if (REQUIRE_PROVISION_VARS) {
  for (const e of missingVars) {
    fail(
      `${e.key}: provisionVar '${e.provisionVar}' is not declared in main.bicep. With ` +
        `--require-provision-vars every catalog entry must have its creation gated on it.`,
    );
  }
  for (const e of entries.filter((x) => declaredVars.has(x.provisionVar))) {
    const re = new RegExp(`var\\s+${e.provisionVar}\\s*=[^\\n]*adoptMode\\(\\s*adopt\\s*,\\s*'${e.key}'\\s*\\)`);
    if (!re.test(bicepSrc)) {
      fail(
        `${e.key}: var '${e.provisionVar}' exists but is not assigned from ` +
          `adoptMode(adopt, '${e.key}') — creation would not honour the operator's adopt choice.`,
      );
    }
  }
} else {
  notes.push(
    `provisionVar wiring NOT asserted (${missingVars.length}/${entries.length} vars absent from ` +
      `main.bicep). These land with the 'adopt' param bag; re-run with --require-provision-vars ` +
      `once it does. This run measured C1-C6 only.`,
  );
}

// ---- report ----------------------------------------------------------------
if (errors.length > 0) {
  console.error('[adoption-catalog-sync] FAIL');
  for (const e of errors) console.error(`  ✗ ${e}`);
  for (const n of notes) console.error(`  · ${n}`);
  process.exit(1);
}
console.log(
  `[adoption-catalog-sync] ok — ${entries.length} services, ${flagged} enable flags verified ` +
    `against main.bicep, ARG type literal generated from the catalog.`,
);
for (const n of notes) console.log(`  · ${n}`);
