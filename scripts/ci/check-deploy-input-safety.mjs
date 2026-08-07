#!/usr/bin/env node
/**
 * check-deploy-input-safety.mjs — deploy-fiab-commercial.yml's INPUTS must not
 * be able to tear down or mis-target the estate, and its what-if must preview
 * the template its apply will apply.
 *
 * WHY THIS EXISTS (refs #3028, #3029, #3022)
 * ------------------------------------------
 * Three defects, all found while preparing ONE authorised deploy, all of the
 * same shape — a control that reads as protective and is not:
 *
 *   #3028  `keep_resources` DEFAULTED TO FALSE, and the Teardown step fires on
 *          `run_mode == 'full' && !inputs.keep_resources`. Selecting `full` and
 *          changing nothing else — the single most natural action on this
 *          workflow — provisioned the estate, smoked it, and then ran
 *          fiab-teardown.sh, which deletes EVERY `rg-csa-loom-*` resource group
 *          in the subscription. The "USE WITH CAUTION" text was attached to the
 *          SAFE value and warned about spend.
 *
 *   #3029  `region` had no input default and `|| 'eastus2'` in `env:`. Omitting
 *          it silently targeted eastus2 while the estate is in centralus. The
 *          region is the estate's identity (rg-csa-loom-admin-<region>,
 *          vnet-csa-loom-hub-<region>, uami-loom-console-<region>), so a wrong
 *          region does not fail — it succeeds against a different, empty estate
 *          while every log line claims a reconcile.
 *
 *   #3022  the what-if ran BEFORE the step that resolves LOOM_MSAL_CLIENT_ID,
 *          which commercial.bicepparam reads at bicep-COMPILE time — so the
 *          preview compiled a different template than the apply. The two
 *          commands were also two hand-maintained copies of one argument list
 *          and had already drifted on `--subscription`.
 *
 * Each fix is a line of YAML that a later edit can undo in seconds. This file
 * is what notices. It is the static sibling of scripts/ci/deploy-input-safety.mjs
 * (the runtime refusal) — one holds the SHAPE, the other holds the RUN.
 *
 * THE INVARIANTS
 *
 *   S1  `keep_resources` defaults to TRUE. Destruction is never a default.
 *   S2  A `confirm_teardown_rg` input exists, and the Teardown step's `if:`
 *       requires it to EQUAL the resolved admin RG. A double-negative alone is
 *       not a confirmation.
 *   S3  `region` is `required: true` with NO `default:`, and no `env:` line
 *       supplies a fallback region. No region may ever be assumed.
 *   S4  The runtime input-safety gate runs, UNCONDITIONALLY, before every step
 *       that can change Azure. A gate behind an `if:` is a gate with an off
 *       switch, and a gate after the first mutation is not a gate.
 *   S5  What-if/apply parity: exactly one step composes the deployment
 *       arguments; the what-if and the provision step both expand THAT file and
 *       restate no `--template-file` / `--parameters` of their own.
 *   S6  The MSAL client-id resolution precedes the compose step and is not
 *       gated on the trigger, so both commands compile the paramfile with the
 *       same environment.
 *
 * FAILING CLOSED. Every discovery has a floor: if the parser stops finding the
 * workflow, the inputs block, or the steps, that is an ERROR. A guard that
 * reports "0 violations" because it matched nothing is the exact class this
 * repo keeps finding inside its own guards.
 *
 * Usage: node scripts/ci/check-deploy-input-safety.mjs
 * Tests: node --test scripts/ci/__tests__/deploy-input-safety.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowSteps, REPO_ROOT } from './check-reconcile-safety.mjs';

export const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-commercial.yml');

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** Steps whose `run:` can change Azure. The gate must precede all of them. */
export const MUTATING_RUN = /az\s+deployment\s+sub\s+(create|what-if)|az\s+provider\s+register|az\s+feature\s+register|fiab-teardown\.sh/;

/** The runtime gate. */
export const GATE_SCRIPT = 'scripts/ci/deploy-input-safety.mjs';
/** The one step allowed to build the argument list. */
export const COMPOSE_MARKER = 'deploy_args_file=';
/** How both commands must consume it. */
export const CONSUME_MARKER = '"${DEPLOY_ARGS[@]}"';

/**
 * The raw text of a `workflow_dispatch` input's block.
 * Returns null when the input is not declared at all (a violation, not silence).
 */
export function inputBlock(yaml, name) {
  const lines = yaml.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s{6}${name}:\\s*$`).test(l));
  if (i < 0) return null;
  const indent = lines[i].match(/^(\s*)/)[1].length;
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    if (lines[j].match(/^(\s*)/)[1].length <= indent) break;
    out.push(lines[j]);
  }
  return out.join('\n');
}

export function checkInputs(yaml) {
  const problems = [];

  // ---- S1 keep_resources -------------------------------------------------
  const keep = inputBlock(yaml, 'keep_resources');
  if (!keep) {
    problems.push(
      'the `keep_resources` input is GONE from deploy-fiab-commercial.yml. Either it was renamed ' +
      '(update this guard in the same commit) or the parser stopped matching — and a guard that ' +
      'cannot find the input it protects is measuring nothing.',
    );
  } else if (!/^\s*default:\s*true\s*$/m.test(keep)) {
    problems.push(
      '`keep_resources` does not default to TRUE. With a false default, selecting run_mode=full and ' +
      'changing nothing else provisions the estate and then runs fiab-teardown.sh, which deletes ' +
      'every rg-csa-loom-* resource group in the subscription (#3028). Destruction is never a default.',
    );
  }

  // ---- S2 confirm_teardown_rg -------------------------------------------
  const confirm = inputBlock(yaml, 'confirm_teardown_rg');
  if (!confirm) {
    problems.push(
      'there is no `confirm_teardown_rg` input. Teardown must require the operator to TYPE the ' +
      'resource group being destroyed — a double-negative (`!keep_resources`) guarding a destructive ' +
      'step is exactly how #3028 hid.',
    );
  } else {
    // Read the value out rather than pattern-matching "not empty": a `\s*`
    // before a negative lookahead BACKTRACKS, so the obvious regex reported a
    // violation against `default: ''`. Compare the parsed value instead.
    const m = /^[ \t]*default:[ \t]*(.*)$/m.exec(confirm);
    const value = (m?.[1] ?? '').trim();
    if (m && value !== "''" && value !== '""' && value !== '') {
      problems.push(
        `\`confirm_teardown_rg\` defaults to ${value}. A pre-filled destruction confirmation confirms nothing.`,
      );
    }
  }

  // ---- S3 region ---------------------------------------------------------
  const region = inputBlock(yaml, 'region');
  if (!region) {
    problems.push('the `region` input is GONE, or the parser stopped matching it.');
  } else {
    if (!/^\s*required:\s*true\s*$/m.test(region)) {
      problems.push(
        '`region` is not `required: true`. An omitted region is what let a "reconcile" target ' +
        'eastus2 while the estate was in centralus, succeeding against a different empty estate (#3029).',
      );
    }
    if (/^\s*default:/m.test(region)) {
      problems.push(
        '`region` declares a `default:`. There is no safe default region: the region IS the identity ' +
        'of the estate, so a default silently selects which estate is deployed to (#3029).',
      );
    }
  }

  const azureLocation = yaml.split('\n').find((l) => /^\s*AZURE_LOCATION:/.test(l)) || '';
  if (/\|\|\s*'[a-z0-9]+'/.test(azureLocation)) {
    problems.push(
      `the job env supplies a FALLBACK region: \`${azureLocation.trim()}\`. That fallback is #3029 ` +
      'itself — on a schedule (no inputs) and on a dispatch that left the field blank it silently ' +
      'chose the region, and therefore the estate. The region must be measured by ' +
      'reconcile-resolve.mjs or the run must refuse.',
    );
  }

  return problems;
}

export function checkSteps(yaml) {
  const problems = [];
  const steps = parseWorkflowSteps(yaml);

  // FLOOR: this workflow has ~20 steps. Finding a handful means the parser broke.
  if (steps.length < 12) {
    problems.push(
      `DISCOVERY FLOOR: parsed ${steps.length} step(s) from deploy-fiab-commercial.yml, expected >= 12. ` +
      'The parser stopped matching; every check below would otherwise pass by seeing nothing.',
    );
    return problems;
  }

  // The step's own YAML and shell, with COMMENT LINES REMOVED.
  //
  // Not `s.run` (executableRun blanks quoted strings, and every marker here
  // lives inside one: `echo "deploy_args_file=…"`, `CID="$(bash …)"`), and not
  // the raw body either — a step's body absorbs the comment block that
  // introduces the NEXT step, so `Resolve reconcile target` "contained"
  // scripts/ci/deploy-input-safety.mjs and matched ahead of the real gate. The
  // first draft of this guard passed on a workflow with the gate deleted for
  // exactly that reason.
  const code = (s) => s.body.filter((l) => !/^\s*#/.test(l)).join('\n');
  const idxOf = (pred) => steps.findIndex(pred);

  // ---- S4 the runtime gate ----------------------------------------------
  const gateIdx = idxOf((s) => code(s).includes(GATE_SCRIPT));
  if (gateIdx < 0) {
    problems.push(
      `no step runs \`node ${GATE_SCRIPT}\`. Nothing then refuses a run whose inputs would tear the ` +
      'estate down or aim at the wrong one — the teardown step merely being skipped is not a refusal, ' +
      'and the operator learns nothing until after the deploy.',
    );
  } else {
    if (steps[gateIdx].if.trim()) {
      problems.push(
        `the input-safety gate carries an \`if:\` (${steps[gateIdx].if.trim().slice(0, 80)}). A gate ` +
        'with a condition is a gate with an off switch; it must run on every trigger.',
      );
    }
    const firstMutating = idxOf((s) => MUTATING_RUN.test(s.run));
    if (firstMutating >= 0 && firstMutating < gateIdx) {
      problems.push(
        `step "${steps[firstMutating].name}" (line ${steps[firstMutating].startLine}) can change Azure ` +
        `and runs BEFORE the input-safety gate. A refusal after the first mutation is not a refusal.`,
      );
    }
  }

  // ---- S2 (workflow half) the teardown condition -------------------------
  const teardownIdx = idxOf((s) => /fiab-teardown\.sh/.test(s.run));
  if (teardownIdx < 0) {
    problems.push(
      'DISCOVERY FLOOR: no step invokes fiab-teardown.sh. Either teardown was removed (update this ' +
      'guard in the same commit) or the parser stopped matching it.',
    );
  } else {
    const cond = steps[teardownIdx].if;
    if (!cond.includes('inputs.confirm_teardown_rg')) {
      problems.push(
        `the Teardown step's \`if:\` does not require \`inputs.confirm_teardown_rg\`. Destruction must ` +
        'be authorised by typing the thing being destroyed, not by leaving a boolean at its default (#3028).',
      );
    } else if (!/confirm_teardown_rg\s*==\s*format\('rg-csa-loom-admin-\{0\}'/.test(cond)) {
      problems.push(
        'the Teardown step references confirm_teardown_rg but does not compare it, with `==`, to ' +
        "format('rg-csa-loom-admin-{0}', <resolved region>). A confirmation that is merely non-empty " +
        'authorises destroying any resource group.',
      );
    }
  }

  // ---- S5 what-if / apply parity ----------------------------------------
  const composeSteps = steps.filter((s) => code(s).includes(COMPOSE_MARKER));
  if (composeSteps.length !== 1) {
    problems.push(
      `expected exactly ONE step to compose the deployment arguments (emitting \`${COMPOSE_MARKER}\`), ` +
      `found ${composeSteps.length}. Two argument lists is how the what-if and the apply drifted apart ` +
      'on `--subscription` (#3022).',
    );
  }
  const composeIdx = idxOf((s) => code(s).includes(COMPOSE_MARKER));

  for (const [label, re] of [['what-if', /az deployment sub what-if/], ['apply', /az deployment sub create/]]) {
    const i = idxOf((s) => re.test(s.run));
    if (i < 0) {
      problems.push(`DISCOVERY FLOOR: no step runs \`az deployment sub ${label === 'what-if' ? 'what-if' : 'create'}\`.`);
      continue;
    }
    const body = code(steps[i]);
    if (!body.includes(CONSUME_MARKER)) {
      problems.push(
        `the ${label} step ("${steps[i].name}", line ${steps[i].startLine}) does not expand the shared ` +
        `argument list (\`${CONSUME_MARKER}\`). Restating the arguments is what let the preview and the ` +
        'apply diverge (#3022).',
      );
    }
    if (/--template-file|--parameters/.test(steps[i].run)) {
      problems.push(
        `the ${label} step restates \`--template-file\`/\`--parameters\` inline. There must be exactly ` +
        'one source of deployment arguments, or divergence is only ever one edit away (#3022).',
      );
    }
    if (composeIdx >= 0 && i < composeIdx) {
      problems.push(`the ${label} step runs before the arguments are composed.`);
    }
  }

  // ---- S6 MSAL resolution precedes composition ---------------------------
  // ---- S6 MSAL resolution precedes composition ---------------------------
  // Matched against the step CODE (comments stripped): the resolver is invoked
  // inside a command substitution (`CID="$(bash …)"`), and executableRun()
  // blanks quoted strings, so the reference is invisible in `s.run`.
  const msalIdx = idxOf((s) => /resolve-msal-client-id\.sh/.test(code(s)));
  if (msalIdx < 0) {
    problems.push(
      'no step runs scripts/csa-loom/resolve-msal-client-id.sh. commercial.bicepparam reads ' +
      'LOOM_MSAL_CLIENT_ID at bicep-compile time, so without it every deploy re-renders an EMPTY ' +
      'client id: sign-in goes dark and loom-unity re-seals (#2681).',
    );
  } else {
    if (composeIdx >= 0 && msalIdx > composeIdx) {
      problems.push(
        'the MSAL client-id resolution runs AFTER the deployment arguments are composed. ' +
        'LOOM_MSAL_CLIENT_ID is read when the paramfile is COMPILED, so the what-if would preview a ' +
        'different template than the apply applies — for the parameter family with the highest blast ' +
        'radius (#3022).',
      );
    }
    if (/inputs\.run_mode|event_name/.test(steps[msalIdx].if)) {
      problems.push(
        `the MSAL client-id resolution is gated on the trigger (\`${steps[msalIdx].if.trim().slice(0, 80)}\`). ` +
        'A whatif-only run then compiles the paramfile with the variable UNSET while the apply compiles ' +
        'it SET — the preview is of a different template (#3022). It is read-only; it must run always.',
      );
    }
  }

  // ---- S7 no bicep parameter is assembled outside the composition --------
  //
  // S5 catches a step that restates `--parameters`. This catches the shape that
  // slipped past it: #3067 assembled the dlz-attach hub coordinates into a
  // HUB_PARAMS *variable* inside BOTH the what-if and the apply — two
  // hand-maintained copies of a parameter list, which is precisely how
  // `--subscription` came to differ between preview and apply (#3022). Those
  // two copies happened to be identical. Nothing made them so.
  //
  // The name set is DERIVED from the composition step, so it cannot go stale:
  // add a parameter there and this guard starts watching it automatically.
  //
  // The search skips `echo`/`printf` lines. Several steps NAME a parameter in a
  // diagnostic — `::error::… (hubVnetId='…')`, `… For topology=dlz-attach that
  // is expected …` — and a mention is not an assembly. It cannot be done by
  // blanking quoted strings the way executableRun() does, because the shape
  // being hunted (`HUB_PARAMS="hubAdminSubscriptionId=… hubVnetId=…"`) lives
  // INSIDE quotes too; the honest discriminator is that an `echo` produces
  // output and assigns nothing.
  if (composeIdx >= 0) {
    const unique = [...new Set(
      [...code(steps[composeIdx]).matchAll(/--parameters\s+"([A-Za-z][A-Za-z0-9]*)=/g)].map((m) => m[1]),
    )];
    if (unique.length < 10) {
      problems.push(
        `DISCOVERY FLOOR: extracted ${unique.length} bicep parameter name(s) from the composition step, ` +
        'expected >= 10. The extraction regex stopped matching, so the "assembled nowhere else" check ' +
        'is measuring nothing.',
      );
    }
    const assembly = (s) => s.body
      .filter((l) => !/^\s*#/.test(l) && !/^\s*(echo|printf)\s/.test(l))
      .join('\n');
    for (let i = 0; i < steps.length; i++) {
      if (i === composeIdx) continue;
      const body = assembly(steps[i]);
      const leaked = unique.filter((n) => new RegExp(`\\b${n}=`).test(body));
      if (leaked.length) {
        problems.push(
          `step "${steps[i].name}" (line ${steps[i].startLine}) assembles bicep parameter(s) ` +
          `${leaked.join(', ')} outside the composition step. There must be exactly ONE place the ` +
          'deployment arguments are built — a second one is a copy that can drift from the set the ' +
          'what-if previewed, and the sha256 assertion cannot see it (#3022, #3067).',
        );
      }
    }
  }

  return problems;
}

export function run() {
  const yaml = read(WORKFLOW);
  if (yaml.length < 500) {
    return [`DISCOVERY FLOOR: ${path.relative(REPO_ROOT, WORKFLOW)} is ${yaml.length} bytes — it was not read.`];
  }
  return [...checkInputs(yaml), ...checkSteps(yaml)];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const problems = run();
  if (problems.length) {
    console.error('[deploy-input-safety] FAIL — the deploy inputs could tear down or mis-target the estate:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n${problems.length} violation(s). See the header of scripts/ci/check-deploy-input-safety.mjs.`);
    process.exit(1);
  }
  console.log(
    '[deploy-input-safety] OK — keep_resources defaults true, teardown requires a typed RG match, ' +
    'region is required with no default, the runtime gate precedes every Azure mutation, and the ' +
    'what-if and the apply expand ONE composed argument list with MSAL resolved before both.',
  );
}
