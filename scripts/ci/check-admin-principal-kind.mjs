#!/usr/bin/env node
/**
 * GUARDRAIL: the bootstrap tenant-admin binding cannot silently become a
 * service principal again (merge-blocker — refs #3109).
 *
 * WHY THIS EXISTS
 * ---------------
 * The live Commercial estate shipped with a bootstrap admin nobody could use.
 * Two independent mechanisms produced it, and each is one line:
 *
 *   1. admin-plane/main.bicep bound `deployer().objectId` whenever no explicit
 *      oid was passed. Every CI deploy authenticates as a SERVICE PRINCIPAL
 *      (Azure/login with secrets.AZURE_CLIENT_ID), so the "bootstrap admin" was
 *      the deploy SP — a workload identity that can never complete the
 *      interactive sign-in the console's gate is comparing against.
 *   2. A deploy lane can pass any string as `loomTenantAdminOid`. A group id, a
 *      comma list, an SP oid and a typo all render as a CONFIGURED binding and
 *      all match nobody, because feature-gate.ts compares
 *      `session.claims.oid === LOOM_TENANT_ADMIN_OID` exactly.
 *
 * The fixes for both are single expressions that a later edit undoes in
 * seconds — a `deployer().objectId` restored "to keep push-button working", a
 * new lane copying the `--parameters loomTenantAdminOid=` line without the
 * refusal. This file is what notices.
 *
 * THE INVARIANTS
 *
 *   B1  admin-plane/main.bicep's `effectiveTenantAdminOid` may only fall back
 *       to `deployer().objectId` behind a check on `userPrincipalName` — the
 *       one field ARM populates for an interactive user and leaves empty for a
 *       service principal / managed identity. Keyed to the MISMATCH (objectId
 *       present, UPN guard absent), never to the safe string alone: adopting
 *       the fix must not be what silences the rule.
 *   B2  The container-app env entry LOOM_TENANT_ADMIN_OID is fed from that
 *       guarded variable and never from a raw `deployer()` expression.
 *   W1  EVERY workflow that passes `--parameters loomTenantAdminOid=` also runs
 *       scripts/ci/bootstrap-admin-principal.mjs, unconditionally (no `if:`),
 *       BEFORE its first ARM-mutating step. A refusal after the apply is not a
 *       refusal.
 *   W2  Cloud parity is DERIVED, not assumed. Every lane that binds any admin
 *       parameter is enumerated and reported with what it binds and whether it
 *       classifies it. As of #3109 only the Commercial lane binds an OID; the
 *       sovereign lanes (gcch / il5 / gcc) bind the admin GROUP only, so there
 *       is no OID for them to classify — and the moment one of them adds an OID
 *       binding, W1 fails until it also runs the refusal. The SP-as-admin path
 *       itself is closed in every cloud by B1, which is ARM-side and needs no
 *       Graph call.
 *
 * FAILING CLOSED ON AN EMPTY POPULATION. If the bicep variable disappears, if
 * the env entry disappears, or if NO workflow passes an admin binding at all,
 * that is an ERROR — it means this file stopped watching the thing it claims to
 * watch, which is indistinguishable from a clean repo if you only count
 * violations.
 *
 * Usage: node scripts/ci/check-admin-principal-kind.mjs
 * Tests: node --test scripts/ci/__tests__/bootstrap-admin-principal.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseWorkflowSteps, REPO_ROOT, ADMIN_PLANE } from './check-reconcile-safety.mjs';

export const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');
/** The runtime refusal every OID-binding lane must run. */
export const REFUSAL_SCRIPT = 'scripts/ci/bootstrap-admin-principal.mjs';
/** Steps that reach ARM. The refusal must precede all of them. */
export const MUTATING_RUN = /az\s+deployment\s+(sub|group|tenant|mg)\s+(create|what-if)|azd\s+(provision|up)/;
/** The admin parameters a deploy lane can bind. */
export const ADMIN_PARAMS = ['loomTenantAdminOid', 'loomTenantAdminGroupId', 'adminEntraGroupId'];

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/**
 * A step's RAW `run:` body with whole-line `#` comments removed.
 *
 * Deliberately NOT the shared executableRun(): that blanks quoted strings, and
 * this repo's own compose step writes `add --parameters "loomTenantAdminOid=$X"`
 * — quoted. Blanking the quotes would erase the exact token being looked for
 * and the guard would report a clean repo while the binding sailed past.
 * Comments still do not count: a `# … loomTenantAdminOid …` line must not be
 * able to satisfy or trip this rule.
 */
export function rawRun(body) {
  const i = body.findIndex((l) => /^\s*-?\s*run:/.test(l));
  if (i < 0) return '';
  const first = body[i];
  const indent = first.match(/^(\s*)/)[1].length;
  const out = [first.replace(/^\s*-?\s*run:\s*\|?-?\s*/, '')];
  for (let j = i + 1; j < body.length; j++) {
    if (body[j].trim() === '') continue;
    if (body[j].match(/^(\s*)/)[1].length <= indent) break;
    out.push(body[j]);
  }
  return out.filter((l) => !/^\s*#/.test(l)).join('\n');
}

/**
 * `--parameters <name>=` / `--parameters "<name>=` occurrences in a run body.
 * Quoting is UNWRAPPED before the name is read — judging the quote characters
 * instead of the value is how a guard ends up reporting a defect that is not
 * there.
 */
export function boundAdminParams(runText) {
  const found = new Set();
  const re = /--parameters\s+["']?([A-Za-z][A-Za-z0-9]*)=/g;
  let m;
  while ((m = re.exec(runText)) !== null) {
    if (ADMIN_PARAMS.includes(m[1])) found.add(m[1]);
  }
  return found;
}

/** The multi-line right-hand side of `var <name> = …` in a bicep file. */
export function bicepVarExpression(text, name) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s*var\\s+${name}\\s*=`).test(l));
  if (i < 0) return null;
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    // Continuation lines of a wrapped ternary are indented; a new declaration,
    // a comment or a blank line ends the expression.
    if (!/^\s+\S/.test(lines[j])) break;
    out.push(lines[j]);
  }
  return { text: out.join('\n'), line: i + 1 };
}

/** B1 + B2 — the ARM-side half. */
export function checkBicep(text = read(ADMIN_PLANE)) {
  const violations = [];
  const expr = bicepVarExpression(text, 'effectiveTenantAdminOid');
  if (!expr) {
    violations.push({
      code: 'bicep-var-missing',
      msg:
        'platform/fiab/bicep/modules/admin-plane/main.bicep no longer declares `var effectiveTenantAdminOid`. ' +
        'This guard cannot see the bootstrap-admin fallback any more, so it is reporting that it STOPPED WATCHING — ' +
        'not that the repo is clean. Re-point the rule at whatever replaced it.',
    });
    return { violations, found: 0 };
  }

  const usesDeployerObjectId = /deployer\(\)\s*\.\s*objectId/.test(expr.text);
  if (usesDeployerObjectId) {
    // Resolve one level of variable indirection: the UPN test may live in a
    // helper var (deployerIsInteractiveUser) rather than inline.
    const referenced = [...expr.text.matchAll(/\b([a-z][A-Za-z0-9]*)\b/g)].map((m) => m[1]);
    const guardText = [expr.text, ...referenced.map((n) => bicepVarExpression(text, n)?.text ?? '')].join('\n');
    if (!/userPrincipalName/.test(guardText)) {
      violations.push({
        code: 'deployer-oid-ungated',
        line: expr.line,
        msg:
          `platform/fiab/bicep/modules/admin-plane/main.bicep:${expr.line} binds \`deployer().objectId\` as the ` +
          'bootstrap tenant admin with no test on `deployer().userPrincipalName`. Every CI deploy runs as a service ' +
          'principal, whose objectId can never complete the interactive sign-in feature-gate.ts compares against — ' +
          'that binding is the #3109 defect, not a fallback. Gate the fallback on a non-empty userPrincipalName ' +
          '(the only field ARM populates for an interactive user).',
      });
    }
  }

  // EVERY emission, not the first one. Azure keeps the LAST env entry of a
  // duplicated name, so a second `LOOM_TENANT_ADMIN_OID` appended further down
  // the array silently wins — the exact ADDITIVE shape that a findIndex-based
  // check reports as clean while the defect ships.
  const lines = text.split('\n');
  const envLines = [];
  lines.forEach((l, i) => {
    if (/name:\s*'LOOM_TENANT_ADMIN_OID'/.test(l)) envLines.push(i);
  });
  if (envLines.length === 0) {
    violations.push({
      code: 'env-entry-missing',
      msg:
        'platform/fiab/bicep/modules/admin-plane/main.bicep no longer emits the LOOM_TENANT_ADMIN_OID container-app ' +
        'env entry. Either the console lost its bootstrap-admin binding entirely, or this guard is looking at the ' +
        'wrong shape. Both are failures.',
    });
  }
  if (envLines.length > 1) {
    violations.push({
      code: 'env-entry-duplicated',
      line: envLines[1] + 1,
      msg:
        `platform/fiab/bicep/modules/admin-plane/main.bicep emits LOOM_TENANT_ADMIN_OID ${envLines.length} times ` +
        `(lines ${envLines.map((i) => i + 1).join(', ')}). Azure keeps the LAST entry, so which binding reaches the ` +
        'console depends on array order — and the guarded one is not necessarily the winner. Emit it exactly once.',
    });
  }
  for (const i of envLines) {
    if (!/value:\s*effectiveTenantAdminOid/.test(lines[i])) {
      violations.push({
        code: 'env-entry-unguarded',
        line: i + 1,
        msg:
          `platform/fiab/bicep/modules/admin-plane/main.bicep:${i + 1} feeds LOOM_TENANT_ADMIN_OID from something ` +
          'other than `effectiveTenantAdminOid`, so the interactive-user gate above it can be bypassed without ' +
          'touching the guarded variable.',
      });
    }
  }
  return { violations, found: 1 + envLines.length };
}

/** One workflow, reduced to what the lane rules reason about. */
export function laneFromYaml(file, yaml) {
  const steps = parseWorkflowSteps(yaml).map((s) => ({ ...s, raw: rawRun(s.body) }));
  const bound = new Set();
  for (const s of steps) for (const p of boundAdminParams(s.raw)) bound.add(p);
  const refusal = steps.find((s) => s.raw.includes(REFUSAL_SCRIPT));
  const firstMutating = steps.find((s) => MUTATING_RUN.test(s.raw));
  return { file, steps, bound, refusal, firstMutating };
}

/** Every workflow file, parsed once. */
export function readLanes(dir = WORKFLOW_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => laneFromYaml(f, read(path.join(dir, f))))
    .filter((l) => l.bound.size > 0 || l.refusal);
}

/** W1 + W2 — the lane-side half. */
export function checkLanes(lanes = readLanes()) {
  const violations = [];
  const oidLanes = lanes.filter((l) => l.bound.has('loomTenantAdminOid'));

  if (lanes.length === 0) {
    violations.push({
      code: 'no-lanes-found',
      msg:
        'NO workflow in .github/workflows passes any of ' + ADMIN_PARAMS.join(' / ') + '. The deploy lanes cannot ' +
        'have stopped binding an admin principal, so this matcher has drifted — an empty population is a broken ' +
        'guard, not a clean repo.',
    });
    return { violations, lanes };
  }
  if (oidLanes.length === 0) {
    violations.push({
      code: 'no-oid-lane-found',
      msg:
        'NO workflow passes `--parameters loomTenantAdminOid=`. deploy-fiab-commercial.yml has bound it since #3180, ' +
        'so either that binding was removed (the console loses its only working admin binding — the groups claim is ' +
        'never populated, #3175) or this matcher has drifted. Both are failures.',
    });
  }

  for (const lane of oidLanes) {
    if (!lane.refusal) {
      violations.push({
        code: 'oid-lane-without-refusal',
        msg:
          `.github/workflows/${lane.file} passes \`--parameters loomTenantAdminOid=\` but never runs ${REFUSAL_SCRIPT}. ` +
          'An unclassified oid renders as a configured binding and can match nobody (a service principal, a group id, ' +
          'or a comma list all do). Add the refusal step before the first ARM call.',
      });
      continue;
    }
    if (lane.refusal.if.trim() !== '') {
      violations.push({
        code: 'refusal-conditional',
        msg:
          `.github/workflows/${lane.file} runs ${REFUSAL_SCRIPT} behind an \`if:\` (${lane.refusal.if.trim().slice(0, 80)}). ` +
          'A refusal with an off switch is not a refusal.',
      });
    }
    if (lane.firstMutating && lane.firstMutating.startLine < lane.refusal.startLine) {
      violations.push({
        code: 'refusal-after-arm',
        msg:
          `.github/workflows/${lane.file} runs ${REFUSAL_SCRIPT} at line ${lane.refusal.startLine}, AFTER the ` +
          `ARM-reaching step "${lane.firstMutating.name}" at line ${lane.firstMutating.startLine}. The binding must be ` +
          'refused before anything is submitted, not after.',
      });
    }
  }
  return { violations, lanes };
}

export function run() {
  const bicep = checkBicep();
  const lanes = checkLanes();
  const violations = [...bicep.violations, ...lanes.violations];

  console.log('[admin-principal-kind] deploy lanes that bind an admin principal:');
  for (const l of lanes.lanes) {
    const oid = l.bound.has('loomTenantAdminOid');
    console.log(
      `  ${l.file}: binds ${[...l.bound].sort().join(', ') || '(none)'} — ` +
        `${oid ? (l.refusal ? `classified by ${REFUSAL_SCRIPT}` : 'NOT CLASSIFIED') : 'group-only, no OID to classify'}`,
    );
  }
  console.log(
    `[admin-principal-kind] ${lanes.lanes.length} lane(s); ${lanes.lanes.filter((l) => l.bound.has('loomTenantAdminOid')).length} bind an OID. ` +
      'Cloud parity: the ARM-side interactive-user gate (B1) applies in EVERY boundary; the Graph classification runs ' +
      'in whichever lanes bind an OID, and W1 fails the moment a sovereign lane starts binding one without it.',
  );

  for (const v of violations) console.log(`::error title=admin-principal-kind (${v.code})::${v.msg}`);
  if (violations.length > 0) {
    console.error(`\n[admin-principal-kind] FAILED — ${violations.length} violation(s).`);
    return 1;
  }
  console.log('[admin-principal-kind] OK — the deployer fallback is gated on an interactive user, and every OID-binding lane classifies what it binds.');
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-admin-principal-kind.mjs');
if (invokedDirectly) process.exit(run());
