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
 *
 * PHYSICAL-LINES-OK: the `.split('\n')` calls here judge BICEP only — the A2/A3/A4
 * checks against platform/fiab/bicep/main.bicep. Bicep has no backslash line
 * continuation, so a physical line is a logical line there (the same reasoning
 * check-guard-logical-lines.mjs encodes in its own out-of-scope control). This
 * file entered that guard's scope only when it began READING .github/workflows
 * to derive its population — and that parsing never splits: submittedTemplates()
 * matches `--template-file` across the whole body, and the per-template checks
 * below match whole-source regexes that tolerate a wrapped module declaration.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
  govBicep: 'deploy/bicep/gov/main.bicep',
  dmlzGovernance: 'deploy/bicep/DMLZ/modules/governance/governance.bicep',
};

/**
 * Templates that CREATE adoptable services and must therefore honour an adopt
 * decision, keyed to the file the check reads.
 *
 * WHY THIS IS NOT THE WHOLE STORY — see assertPopulationIsComplete() below.
 * Listing orchestrators by hand is how this guard was wrong in the first place:
 * it read `platform/fiab/bicep/main.bicep` and nothing else while the repo had
 * THREE templates creating Purview accounts. `deploy/bicep/gov/main.bicep`
 * created one on `= if (deployDMLZ)` (#3577) and
 * `deploy/bicep/DMLZ/modules/governance/governance.bicep` created one on
 * `= if (deployModules.governance)` — with `params.USGov.dev.json` shipping
 * `governance: true` against the same Azure Government tenant, whose Purview cap
 * is 5 per region. Neither was in the guard's population, so it reported OK on
 * both.
 *
 * So the list below is the DEPTH of the check, and the derivation below is its
 * BREADTH: a template submitted by a workflow that this file does not know about
 * fails the guard rather than passing silently.
 */
const ADOPT_HONOURING_TEMPLATES = [
  { file: 'govBicep', enableFlag: 'deployDMLZ', keys: ['purview'] },
  { file: 'dmlzGovernance', enableFlag: 'bool(deployModules.governance)', keys: ['purview'] },
];

/** ARM types whose creation must be gated on an adopt decision. */
const ADOPTABLE_ARM_TYPES = ['Microsoft.Purview/accounts'];

/**
 * Every template path any workflow hands to `az deployment ... --template-file`.
 * DERIVED, never listed — this is the check that closes the class instead of the
 * instance.
 */
export function submittedTemplates(workflowFiles) {
  const found = new Map();
  for (const [name, body] of Object.entries(workflowFiles)) {
    // `--template-file "path"` / `--template-file path`, possibly after a
    // backslash continuation. Quotes optional, as both styles are in the tree.
    for (const m of body.matchAll(/--template-file\s+"?([^\s"\\]+\.bicep)"?/g)) {
      // Workspace-rooted forms are the SAME template as their repo-relative
      // spelling — deploy-fiab-gcc/gcch/il5 all submit
      // `$GITHUB_WORKSPACE/platform/fiab/bicep/main.bicep`. Without this the
      // guard reports the Commercial orchestrator as an unreadable unknown,
      // which is a false alarm that would train people to ignore it.
      const tpl = m[1]
        .replace(/^\$\{?GITHUB_WORKSPACE\}?\//, '')
        .replace(/^\$\{\{\s*github\.workspace\s*\}\}\//, '')
        .replace(/^\.\//, '');
      if (!found.has(tpl)) found.set(tpl, []);
      if (!found.get(tpl).includes(name)) found.get(tpl).push(name);
    }
  }
  return found;
}

/**
 * A submitted template that creates an adoptable ARM type must be under this
 * guard. Anything submitted but unreadable is UNKNOWN, which is not a pass.
 */
export function assertPopulationIsComplete(workflowFiles, templateBodies) {
  const problems = [];
  const known = new Set(Object.values(PATHS));

  for (const [tpl, workflows] of submittedTemplates(workflowFiles)) {
    if (known.has(tpl)) continue;
    const body = templateBodies[tpl];
    if (body === undefined) {
      problems.push(
        `${tpl} is submitted by ${workflows.join(', ')} but could not be read, so whether it creates an ` +
          `adoptable service is UNKNOWN. A guard that cannot see a template must not report OK on it.`,
      );
      continue;
    }
    for (const armType of ADOPTABLE_ARM_TYPES) {
      if (new RegExp(`'${armType}@`, 'i').test(body)) {
        problems.push(
          `${tpl} (submitted by ${workflows.join(', ')}) declares '${armType}' but is not in PATHS, so this ` +
            `guard does not check that it honours an adopt decision. Add it to PATHS + ` +
            `ADOPT_HONOURING_TEMPLATES, or stop submitting it. This is exactly how the Gov and DMLZ ` +
            `Purview creators went unnoticed (#3577).`,
        );
      }
    }
  }
  return problems;
}

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

  // ---------------------------------------------------------------------------
  // G1..G4 — every NON-COMMERCIAL template that creates an adoptable service.
  //
  // cloud-parity.md: a capability that works in Commercial and not in Gov is
  // incomplete, not "Commercial-first". Adoption is exactly such a capability —
  // and the boundary where it matters MOST, because the Purview cap is per
  // tenant per region and a sovereign tenant that already runs Purview is the
  // normal case, not the exception.
  //
  // These checks are keyed on the SHAPE of the gate rather than byte-comparing
  // the Commercial line, because each orchestrator's enable flag differs
  // (`deployDMLZ`, `bool(deployModules.governance)`). Requiring an identical
  // line would force a redundant flag whose only purpose is to satisfy a guard.
  // ---------------------------------------------------------------------------
  for (const tpl of ADOPT_HONOURING_TEMPLATES) {
    const src = files[tpl.file];
    const label = PATHS[tpl.file];

    // G1 — the transport exists. Without the bag there is nothing to carry a
    // decision, and every service silently reverts to create-always.
    if (!/^\s*param adopt object = \{\}$/m.test(src)) {
      problems.push(
        `${label} does not declare \`param adopt object = {}\`. Without it this template cannot receive ` +
          `an adopt decision at all, and every service it deploys is create-always — which is how the Gov ` +
          `Purview deploy hit the per-tenant cap (#3577).`,
      );
    }

    for (const key of tpl.keys) {
      const def = catalog.find((d) => d.key === key);
      if (!def) {
        problems.push(
          `${label} is expected to honour the '${key}' adopt decision, but '${key}' is not in the adoption ` +
            `catalog. Remove it from ADOPT_HONOURING_TEMPLATES deliberately, or restore the entry.`,
        );
        continue;
      }

      // G2 — the suppression var exists and is derived from the SAME plan key
      // the catalog and the console use. A template-local key would mean a plan
      // the wizard emits is silently ignored here.
      const gateRe = new RegExp(`^var ${def.provisionVar} = .*adoptMode\\(adopt, '${key}'\\) == 'create'`, 'm');
      if (!gateRe.test(src)) {
        problems.push(
          `${label} must declare \`var ${def.provisionVar} = <enable flag> && adoptMode(adopt, '${key}') == 'create'\` ` +
            `and does not. Without it, choosing "adopt" still deploys a new ${def.label}.`,
        );
        continue;
      }

      // G3 — the module that CREATES the service is gated on that var, not on
      // the landing-zone toggle alone. This is the exact revert that reopens
      // #3577.
      //
      // Matched against the WHOLE SOURCE, not line by line. A bicep module
      // declaration may legally wrap:
      //     module purview 'modules/purview.bicep' =
      //       if (deployDMLZ) {
      // and a physical-line test would see neither the path nor the condition
      // together, then report clean — the same blindness #3417 recorded for
      // shell continuations. The condition is captured and inspected instead.
      // Matched case-insensitively because the trees disagree on casing and
      // depth ('modules/purview.bicep' vs '../Purview/purview.bicep').
      const creatorRe = new RegExp(
        `module\\s+\\w+\\s+'[^']*${key}\\.bicep'\\s*=\\s*if\\s*\\(([\\s\\S]*?)\\)\\s*\\{`,
        'gi',
      );
      const conditions = [...src.matchAll(creatorRe)].map((m) => m[1].trim());
      if (conditions.length === 0) {
        problems.push(
          `${label}: no module invocation matching '<path>/${key}.bicep' is gated \`= if (…)\`. Either the ` +
            `creator moved (update this guard) or its condition was removed.`,
        );
      } else if (!conditions.some((c) => c.includes(def.provisionVar))) {
        problems.push(
          `${label}: the module that creates ${def.label} is gated on ` +
            `${conditions.map((c) => `if (${c})`).join(', ')} — it must carry '${def.provisionVar}', or it ` +
            `deploys a new one even when the plan says adopt (#3577).`,
        );
      }

      // G4 — an adopt decision must actually BIND something. A suppression that
      // creates nothing and binds nothing is not adoption, it is a silent skip,
      // and the catalog reserves that meaning for mode 'skip'.
      //
      // The binding must be an `existing` RESOURCE, never a module scoped to the
      // adopted resource group: a cross-scope module compiles to a
      // Microsoft.Resources/deployments resource THERE and needs
      // `Microsoft.Resources/deployments/write`, which Reader does not carry —
      // the AuthorizationFailed P0 that failed two Commercial deploys on
      // 2026-08-13 (#3333). An `existing` resource needs only read.
      const bindsExisting = new RegExp(`resource\\s+\\w+\\s+'${def.armType}@[^']+'\\s+existing`, 'i').test(src);
      if (!bindsExisting) {
        problems.push(
          `${label}: declares no \`resource … '${def.armType}@…' existing\`, so an 'adopt' decision would ` +
            `suppress the new ${def.label} and bind nothing — a silent skip wearing adoption's name.`,
        );
      }
      const bindsViaModule = new RegExp(`module\\s+\\w+\\s+'[^']*${key}-existing\\.bicep'`, 'i').test(src);
      if (bindsViaModule) {
        problems.push(
          `${label}: binds the adopted ${def.label} through a MODULE. A module scoped to the adopted ` +
            `resource group compiles to a nested deployment there and requires ` +
            `Microsoft.Resources/deployments/write — Reader is not enough, and the whole deployment fails ` +
            `with AuthorizationFailed (#3333). Use \`resource … existing\`, which needs only read.`,
        );
      }
    }
  }

  // G0 — is this guard even LOOKING at everything it should? Derived from the
  // workflows, so a template added tomorrow is covered the day it lands.
  problems.push(...assertPopulationIsComplete(files.workflows ?? {}, files.templateBodies ?? {}));

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
    govBicep: read(PATHS.govBicep),
    dmlzGovernance: read(PATHS.dmlzGovernance),
    // The DERIVED half. Read from disk, not listed: the whole point is that a
    // template nobody remembered to register still gets noticed.
    workflows: readWorkflows(),
    templateBodies: readSubmittedTemplateBodies(),
  };
}

/** Every workflow body, keyed by file name. */
function readWorkflows() {
  const dir = resolve(REPO, '.github', 'workflows');
  const out = {};
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    out[f] = readFileSync(resolve(dir, f), 'utf8').replace(/\r\n/g, '\n');
  }
  return out;
}

/**
 * Body of every template a workflow submits, so the population check can ask
 * what each one actually declares. A path that does not exist is recorded as
 * `undefined` — deliberately distinct from an empty body, so "I could not read
 * it" cannot be mistaken for "it declares nothing".
 */
function readSubmittedTemplateBodies() {
  const out = {};
  for (const tpl of submittedTemplates(readWorkflows()).keys()) {
    const p = resolve(REPO, tpl);
    out[tpl] = existsSync(p) ? readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : undefined;
  }
  return out;
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
