#!/usr/bin/env node
/**
 * GUARDRAIL: the adoption catalog and the bicep that honours it must agree,
 * field for field. (merge-blocker)
 *
 * WHY THIS EXISTS
 * ---------------
 * Six catalogs answered "which services can Loom reuse" and they disagreed.
 * Measured on 2026-08-05:
 *
 *   maps    — CLI: loomMapsEnabled + EXISTING_AZURE_MAPS_ACCOUNT
 *             console: azureMapsEnabled + EXISTING_AZURE_MAPS
 *             …and only the first env name was read by any .bicepparam, so the
 *             console's BYO value was inert.
 *   foundry — CLI disabled agentFoundryEnabled, console disabled aiFoundryEnabled.
 *             main.bicep documents those as INDEPENDENT accounts, so the two
 *             surfaces suppressed different resources for the same answer.
 *
 * The vitest that claimed to pin them "in lockstep" asserted only
 * `expect(def.enabledFlag).toBeTruthy()` — it compared no name at all. That test
 * could not fail, which is exactly why the drift was live for months.
 *
 * This guard compares NAMES, byte for byte, and additionally proves the
 * SUPPRESSION is wired: a BYO value that rebinds the Console env while the
 * module still creates a second resource is the defect class the `adopt` bag
 * exists to close (Purview failing the whole deploy with
 * EnterpriseTenantAlreadyExists; Maps and Foundry silently duplicating).
 *
 * PARSE FAILURE IS A FAILURE, NOT A PASS
 * --------------------------------------
 * A guard that finds zero entries and reports OK is a guard that measures
 * nothing. If the catalog cannot be parsed, or fewer than MIN_ENTRIES entries
 * come out, this exits non-zero.
 *
 * Mutation-proven by scripts/ci/__tests__/adoption-catalog-sync.test.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

export const PATHS = {
  catalog: 'apps/fiab-console/lib/deploy/adoption-catalog.ts',
  rootBicep: 'platform/fiab/bicep/main.bicep',
  adminPlane: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
  attachKinds: 'apps/fiab-console/lib/azure/attached-service-kinds.ts',
  commercialParams: 'platform/fiab/bicep/params/commercial-full.bicepparam',
  discoveryModel: 'apps/fiab-console/lib/deploy/discovery-model.ts',
};

/**
 * The catalog must never silently shrink. This floor is the count of
 * adoptable + adopt-required entries at the time the guard was written; removing
 * a service is a deliberate act that has to move this number too.
 */
const MIN_ADOPTABLE = 13;
const MIN_ENTRIES = 20;

/**
 * Parse the catalog literal. Deliberately a strict, narrow reader rather than a
 * TS compile: it must be runnable from a bare `node scripts/ci/...` with no
 * build step, and anything it cannot parse must be loud.
 */
export function parseCatalog(source) {
  const start = source.indexOf('export const ADOPTION_CATALOG');
  if (start < 0) throw new Error('ADOPTION_CATALOG not found in the catalog source');
  const body = source.slice(start);

  const entries = [];
  // Each entry begins at a `key: '...'` at entry indentation (4 spaces).
  const keyRe = /^ {4}key: '([a-z0-9-]+)',$/gm;
  let m;
  const starts = [];
  while ((m = keyRe.exec(body)) !== null) starts.push({ key: m[1], at: m.index });
  if (starts.length === 0) throw new Error('no catalog entries parsed — the literal shape changed');

  for (let i = 0; i < starts.length; i++) {
    const chunk = body.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : body.length);
    const str = (field) => {
      const r = new RegExp(`^ {4}${field}: '([^']*)',$`, 'm').exec(chunk);
      return r ? r[1] : undefined;
    };
    const strList = (field) => {
      const r = new RegExp(`^ {4}${field}: \\[([^\\]]*)\\],$`, 'm').exec(chunk);
      if (!r) return [];
      return Array.from(r[1].matchAll(/'([^']*)'/g)).map((x) => x[1]);
    };
    const roleFromSpread = /\.\.\.role\('([a-z0-9-]+)'\)/.exec(chunk);
    const roleGuidLiteral = /^ {4}roleGuid: ([A-Z_]+|'[^']*'),$/m.exec(chunk);

    entries.push({
      key: starts[i].key,
      label: str('label'),
      armType: str('armType'),
      cls: str('cls'),
      enableFlag: str('enableFlag'),
      provisionVar: str('provisionVar'),
      provisionSink: str('provisionSink'),
      createOnlyReason: /^ {4}createOnlyReason:/m.test(chunk),
      // The reason TEXT, for the substance check. It is usually a wrapped
      // multi-line string literal, so read to the closing quote, not to EOL.
      // Both quote styles: a reason containing an apostrophe is written "…".
      createOnlyReasonText: (() => {
        const r = /^ {4}createOnlyReason:\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/m.exec(chunk);
        return r ? r[2] : '';
      })(),
      attachKind: roleFromSpread ? roleFromSpread[1] : undefined,
      roleGuidLiteral: roleGuidLiteral ? roleGuidLiteral[1] : undefined,
      consoleEnv: strList('consoleEnv'),
      legacyEnvNames: Array.from(chunk.matchAll(/(?:name|rg|sub): '(EXISTING_[A-Z0-9_]+)'/g)).map((x) => x[1]),
      mutationsPresent: /^ {4}mutations: \[/m.test(chunk),
    });
  }
  return entries;
}

function read(rel) {
  const p = resolve(REPO, rel);
  if (!existsSync(p)) throw new Error(`missing required file: ${rel}`);
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

export function runChecks(files) {
  const problems = [];
  const catalog = parseCatalog(files.catalog);

  if (catalog.length < MIN_ENTRIES) {
    problems.push(
      `the catalog parsed only ${catalog.length} entries but at least ${MIN_ENTRIES} are expected — ` +
        `either services were removed (update MIN_ENTRIES deliberately) or the parse broke.`,
    );
  }

  const adoptable = catalog.filter((d) => d.cls === 'adoptable' || d.cls === 'adopt-required');
  if (adoptable.length < MIN_ADOPTABLE) {
    problems.push(
      `only ${adoptable.length} adoptable services parsed, expected at least ${MIN_ADOPTABLE}. ` +
        `A shrinking adoptable set means brownfield support regressed.`,
    );
  }

  // A0 — the bag itself.
  if (!/^param adopt object = \{\}$/m.test(files.rootBicep)) {
    problems.push(
      `${PATHS.rootBicep} does not declare \`param adopt object = {}\`. The whole adopt-or-create ` +
        `transport depends on it, and re-introducing per-service scalars would breach the 256-param ARM cap.`,
    );
  }

  // C2 — uniqueness. A duplicated key silently shadows an entry in BY_KEY; a
  // duplicated provisionVar means two services share one suppression gate, so
  // adopting one would suppress the other.
  for (const [label, values] of [
    ['service key', catalog.map((d) => d.key)],
    ['provisionVar', catalog.map((d) => d.provisionVar).filter(Boolean)],
  ]) {
    const seen = new Set();
    for (const v of values) {
      if (seen.has(v)) problems.push(`duplicate ${label}: '${v}'`);
      seen.add(v);
    }
  }

  // C3 — ARM types are lower-case. They are emitted into the ARG
  // `type in~ (...)` literal verbatim, and a mixed-case entry silently matches
  // nothing rather than erroring.
  for (const d of catalog) {
    if (d.armType && d.armType !== d.armType.toLowerCase()) {
      problems.push(
        `${d.key}: armType '${d.armType}' must be lower-case (it is emitted into the ARG literal verbatim).`,
      );
    }
  }

  // C5 — the scanner query is GENERATED from this catalog, not a second
  // hand-kept list. A hand-maintained second list is how 'maps', 'postgres' and
  // 'storage' ended up offered by the wizard and absent from the deploy.
  if (!/const types = adoptionArmTypes\(\)/.test(files.discoveryModel)) {
    problems.push(
      `${PATHS.discoveryModel}: buildInventoryQuery no longer builds its type literal from ` +
        `adoptionArmTypes(). A second hand-kept type list is how the wizard and the deploy drifted apart.`,
    );
  }
  for (const d of catalog) {
    if (d.armType && files.discoveryModel.includes(`'${d.armType}'`)) {
      problems.push(
        `${PATHS.discoveryModel} hard-codes the ARM type '${d.armType}' — it must come from the catalog.`,
      );
    }
  }

  for (const def of catalog) {
    // C4 — a locked row's reason must be SUBSTANTIVE. "you can't" with no
    // "because" is indistinguishable from "we didn't build it".
    if (
      ['create-only', 'attach-in-place', 'reference-only'].includes(def.cls) &&
      def.createOnlyReason &&
      def.createOnlyReasonText.length < 80
    ) {
      problems.push(
        `${def.key}: createOnlyReason is ${def.createOnlyReasonText.length} chars — a locked row needs a ` +
          `substantive reason, not a label. The operator is being told they may not do something.`,
      );
    }

    // A8 — a locked row must always carry its reason.
    if (['create-only', 'attach-in-place', 'reference-only'].includes(def.cls) && !def.createOnlyReason) {
      problems.push(
        `${def.key}: cls='${def.cls}' but no createOnlyReason. A locked row with no reason is a ` +
          `disabled control the operator cannot act on.`,
      );
    }

    if (!def.mutationsPresent) {
      problems.push(
        `${def.key}: no \`mutations\` array. What Loom CHANGES about an adopted resource is rendered ` +
          `verbatim on the review step; omitting it means the operator finds out afterwards.`,
      );
    }

    // A6 — every Console env var the catalog advertises must exist in the
    // admin-plane app env. Checked for EVERY class, not just the adoptable ones:
    // an invented env name on a locked row is fiction in a customer-facing
    // reason string. The first draft of the catalog carried four names that do
    // not exist and this check is what found them.
    for (const env of def.consoleEnv) {
      if (!files.adminPlane.includes(`'${env}'`)) {
        problems.push(
          `${def.key}: consoleEnv '${env}' does not appear in ${PATHS.adminPlane}, so it names a ` +
            `binding that does not exist.`,
        );
      }
    }

    if (def.cls !== 'adoptable' && def.cls !== 'adopt-required') continue;

    // A9 — adoptable entries must be fully specified.
    if (!def.enableFlag) { problems.push(`${def.key}: adoptable but no enableFlag`); continue; }
    if (!def.provisionVar) { problems.push(`${def.key}: adoptable but no provisionVar`); continue; }

    // A1 — the enable flag is a real bicep param.
    if (!new RegExp(`^param ${def.enableFlag} bool`, 'm').test(files.rootBicep)) {
      problems.push(
        `${def.key}: enableFlag '${def.enableFlag}' is not declared as a bool param in ${PATHS.rootBicep}.`,
      );
    }

    // A2 — the provision var is EXACTLY the suppression expression, byte-compared.
    const expected = `var ${def.provisionVar} = ${def.enableFlag} && adoptMode(adopt, '${def.key}') == 'create'`;
    if (!files.rootBicep.split('\n').includes(expected)) {
      problems.push(
        `${def.key}: ${PATHS.rootBicep} must contain exactly this line and does not:\n      ${expected}`,
      );
      continue;
    }

    // A3 — the provision var must actually be USED. A declared-but-unreferenced
    // suppression var is a gate that gates nothing.
    const uses = files.rootBicep
      .split('\n')
      .filter((l) => l.includes(def.provisionVar) && !l.startsWith(`var ${def.provisionVar} =`)).length;
    if (uses === 0) {
      problems.push(
        `${def.key}: '${def.provisionVar}' is declared but never used, so choosing "adopt" would still ` +
          `deploy a new ${def.label} beside the operator's.`,
      );
    }

    // A4 — the provision var must reach the module parameter the RESOURCE-CREATING
    // module actually reads, and that parameter must no longer receive the raw
    // enable flag. Naming the sink in the catalog keeps this precise: a broad
    // "the flag is passed nowhere" rule would false-positive on `deSynapse:
    // loomSynapseEnabled` (an env-blanking mirror) and on
    // `loomStreamAnalyticsEnabled: loomStreamAnalyticsEnabled` (an RBAC grant the
    // Console still needs when the job is ADOPTED, not created).
    if (!def.provisionSink) {
      problems.push(
        `${def.key}: adoptable but no provisionSink — the guard cannot tell which module parameter ` +
          `carries the adopt decision, so a revert of the gate would go unnoticed.`,
      );
    } else if (def.provisionSink === 'if') {
      const gated = files.rootBicep
        .split('\n')
        .some((l) => /=\s*if\s*\(/.test(l) && l.includes(def.provisionVar));
      if (!gated) {
        problems.push(
          `${def.key}: provisionSink is 'if' but no module in ${PATHS.rootBicep} is gated ` +
            `\`= if (… ${def.provisionVar} …)\`, so choosing "adopt" would still deploy a new ${def.label}.`,
        );
      }
    } else {
      const lines = files.rootBicep.split('\n');
      const sinkLines = lines.filter((l) => new RegExp(`^\\s+${def.provisionSink}: `).test(l));
      if (sinkLines.length === 0) {
        problems.push(
          `${def.key}: no line passes '${def.provisionSink}' in ${PATHS.rootBicep}. Either the module ` +
            `parameter was renamed or the pass-down was removed.`,
        );
      } else if (!sinkLines.some((l) => l.includes(def.provisionVar))) {
        problems.push(
          `${def.key}: '${def.provisionSink}' is passed as ${sinkLines.map((l) => l.trim()).join(', ')} ` +
            `— it must carry '${def.provisionVar}' so an adopt decision suppresses the new ${def.label}. ` +
            `Passing the raw enable flag here is the exact revert this guard exists to catch.`,
        );
      }
    }

    // A7 — the granted role must come from the day-2 attach catalog, so day-0
    // adoption and day-2 attach can never grant different roles.
    if (def.attachKind) {
      if (!new RegExp(`kind: '${def.attachKind}'`).test(files.attachKinds)) {
        problems.push(
          `${def.key}: attach kind '${def.attachKind}' is not in ${PATHS.attachKinds}.`,
        );
      }
    } else if (!def.roleGuidLiteral) {
      problems.push(
        `${def.key}: adoptable but names no role — the deploy would not know what to grant on an ` +
          `adopted instance.`,
      );
    }

    // A10 — the legacy env names the catalog advertises must be honoured by the
    // bicepparam adopt block, or an operator setting them gets silence.
    for (const env of def.legacyEnvNames) {
      if (!files.commercialParams.includes(`'${env}'`)) {
        problems.push(
          `${def.key}: legacy env '${env}' is advertised by the catalog but no longer read by ` +
            `${PATHS.commercialParams}, so setting it would do nothing.`,
        );
      }
    }
  }

  return { problems, catalog, adoptable };
}

export function loadFiles() {
  return {
    catalog: read(PATHS.catalog),
    rootBicep: read(PATHS.rootBicep),
    adminPlane: read(PATHS.adminPlane),
    attachKinds: read(PATHS.attachKinds),
    commercialParams: read(PATHS.commercialParams),
    discoveryModel: read(PATHS.discoveryModel),
  };
}

function main() {
  let result;
  try {
    result = runChecks(loadFiles());
  } catch (err) {
    console.error(`[adoption-catalog-sync] FAILED to run: ${err.message}`);
    console.error('  A guard that cannot parse its subject is a guard that measures nothing.');
    process.exit(1);
  }
  const { problems, catalog, adoptable } = result;
  if (problems.length > 0) {
    console.error(`[adoption-catalog-sync] ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ✗ ${p}\n`);
    console.error('Fix the catalog or the bicep so they agree. See the header of this file for why.');
    process.exit(1);
  }
  console.log(
    `[adoption-catalog-sync] ok — ${catalog.length} services, ${adoptable.length} adoptable, ` +
      `every provision var declared, used, and gating its module.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-adoption-catalog-sync.mjs')) {
  main();
}
