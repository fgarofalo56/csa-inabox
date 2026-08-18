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
 *   S8  No step TRUSTS the raw `region` input: a step reading `inputs.region`
 *       must also hold the MEASURED region — it must run reconcile-resolve.mjs,
 *       or carry `steps.reconcile.outputs.region`, or compare the input against
 *       `$AZURE_LOCATION` on one line. A bare MENTION of `$AZURE_LOCATION` does
 *       NOT exempt it: thirteen steps interpolate it to build a resource-group
 *       name, and treating that as evidence of reconciliation would have let the
 *       defect back in unseen. The input is
 *       EMPTY on a `schedule` event, so a step that trusts it runs with no
 *       region every night — which is #3701: the DLZ adopt step did, discovered
 *       nothing, and the deploy silently REMOVED the seven lake LOOM_* env vars
 *       from the running console while reporting success.
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
 * S8. Reading the raw `region` input is only safe when the step ALSO holds the
 * MEASURED region, because then it is reconciling the two rather than trusting
 * the input. Two steps legitimately do:
 *
 *   - `Resolve reconcile target` RUNS reconcile-resolve.mjs, which turns an
 *     absent region into a measured one (or refuses). It produces the answer.
 *   - `Deploy input safety gate` passes `steps.reconcile.outputs.region`
 *     alongside it and REFUSES when a supplied region contradicts the resolved
 *     one (#3029). It consumes the answer.
 *
 * The DLZ adopt step held neither: it took `inputs.region` as the truth, and on
 * a schedule that truth was the empty string (#3701).
 */
export const REGION_RECONCILIATION_MARKERS = [
  'scripts/ci/reconcile-resolve.mjs',
  'steps.reconcile.outputs.region',
];

/**
 * The MEASURED region, as `Resolve reconcile target` writes it to $GITHUB_ENV.
 *
 * This is deliberately NOT in the list above. Thirteen steps interpolate
 * `${AZURE_LOCATION}` to build a resource-group name; as a bare substring
 * marker it exempted any step that merely MENTIONED it. A step could therefore
 * carry `REGION: ${{ inputs.region }}` in its `env:`, consume `$REGION`, and be
 * waved through because an unrelated line said `RG="rg-…-${AZURE_LOCATION}"` —
 * i.e. the exact #3701 shape, still invisible. Using the measured region for
 * something ELSE does not license trusting the input.
 *
 * It exempts only when PAIRED: some wiring line must name both AZURE_LOCATION
 * and the variable the raw input was bound to, which is what an actual
 * reconciliation looks like (`[ "$INPUT_REGION" != "$AZURE_LOCATION" ]`).
 * No step in the workflow takes that branch today, so its control is embedded
 * in the tests rather than in the live population.
 */
export const REGION_MEASUREMENT_VAR = 'AZURE_LOCATION';

/**
 * `INPUT_REGION: ${{ inputs.region }}` — an `env:` entry binding the RAW input.
 * Optional quoting and a trailing YAML comment are tolerated so that ordinary
 * reformatting does not trip the extraction floor below; anything MORE than a
 * bare binding (`${{ inputs.region || '' }}`, a nested expression) deliberately
 * does not match, because it is no longer a shape this guard has reasoned about.
 */
export const ENV_BINDS_REGION_INPUT =
  /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(['"]?)\$\{\{\s*inputs\.region\s*\}\}\2\s*(?:#.*)?$/;

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

  // ---- S8 no step may read `inputs.region` except the one that MEASURES it --
  //
  // THE DEFECT THIS EXISTS FOR (#3701). `inputs.region` is EMPTY on a `schedule`
  // event — there are no inputs — which is the same trap #2775 documents for
  // `allow_existing_hub`. S3 above already forbids a FALLBACK region in the job
  // `env:`, but nothing watched a STEP that reaches for `inputs.region` directly.
  //
  // The `Adopt the DLZ` step did exactly that: `REGION: ${ inputs.region }` in
  // its `env:`. Every nightly therefore ran resolve-dlz-coordinates.mjs with
  // `--region ""`, which exits USAGE(2), and the step's `|| echo` rendered that
  // as "found no unambiguous DLZ". The adopt plan came out `{}`,
  // `loomStorageAccount` composed to '', and because the lake env block in
  // modules/admin-plane/main.bicep is `!empty(loomStorageAccount) ? [ … ] : []`,
  // the deploy REMOVED seven LOOM_* variables from the running console and
  // reported success. Measured: runs 31870181337 / 31932209496 / 32004118361 all
  // green with `adopting: (none)`, against 31898068403 (a dispatch, same code)
  // which adopted `databricks,eventhubs,storage-adls,synapse`.
  //
  // Two sibling steps had already learned this — the MSAL resolve and the
  // internal-token adopt both read `$AZURE_LOCATION` from the SHELL, with a
  // comment saying why. The adopt step was added later and did not adopt the
  // pattern: the guard-adoption gap, again.
  //
  // THE ONE THING THAT MAKES SUCH A READ SAFE is holding the MEASURED region
  // too — then the step is RECONCILING the input rather than trusting it. Two
  // steps legitimately do (see REGION_RECONCILIATION_MARKERS): the reconcile
  // step produces the measurement, and the input-safety gate refuses when a
  // supplied region contradicts it (#3029). The adopt step held neither.
  //
  // Comment lines are stripped first: the fix's own explanation names
  // `inputs.region`, and a step's body absorbs the comment block introducing the
  // NEXT step, so a prose mention would otherwise be indistinguishable from a use.
  {
    const readers = steps.filter((s) => /\binputs\.region\b/.test(code(s)));
    // The markers are hunted with `echo`/`printf` lines ALSO removed, on S7's
    // reasoning: an echo produces output and assigns nothing. Several steps name
    // AZURE_LOCATION inside an ::error:: string — including this fix's own
    // refusal message — and a step that merely PRINTS the measured region has
    // not consumed it. Without this, adding one diagnostic would silently exempt
    // a step from S8.
    const live = (s) => s.body.filter((l) => !/^\s*#/.test(l));
    const wiringLines = (s) => live(s).filter((l) => !/^\s*(echo|printf)\s/.test(l));
    const wiring = (s) => wiringLines(s).join('\n');
    /** The `env:` variable names this step binds the RAW input to. */
    const boundVars = (s) => live(s).map((l) => ENV_BINDS_REGION_INPUT.exec(l)?.[1]).filter(Boolean);
    /**
     * Safe iff the step PRODUCES or CONSUMES the measurement — or pairs the
     * measured region with the variable carrying the raw input on one line,
     * which is what a real reconciliation looks like. A bare mention of
     * AZURE_LOCATION elsewhere in the step does NOT count; that leniency is
     * what would have let the #3701 shape back in behind an unrelated
     * `rg-…-${AZURE_LOCATION}` interpolation.
     *
     * TWO WAYS THE PAIRING TEST WAS ITSELF DEFEATED (measured, PR #3703 review):
     *
     *  1. `l.includes(v)` is a SUBSTRING test, and `AZURE_LOCATION` contains
     *     `LOCATION`. So `LOCATION: ${{ inputs.region }}` was exempted by ANY of
     *     the thirteen ordinary `rg-…-${AZURE_LOCATION}` lines. Short names were
     *     worse still — `R` and `A` matched almost any line.
     *  2. The `env:` binding line itself contains both tokens when the bound
     *     name IS `AZURE_LOCATION`, so `AZURE_LOCATION: ${{ inputs.region }}`
     *     self-satisfied the exemption with no other line present at all — and
     *     that is the WORST case, because a step-level `env:` entry overrides
     *     the measured `$GITHUB_ENV` value for that step. #3701 exactly, guard
     *     silent.
     *
     * So: the binding lines are excluded from the candidate set, and the bound
     * name must appear as a real shell REFERENCE (`$VAR` / `${VAR}`), not as a
     * substring of some longer identifier.
     */
    const reconciles = (s) => {
      if (REGION_RECONCILIATION_MARKERS.some((m) => wiring(s).includes(m))) return true;
      const vars = boundVars(s);
      if (vars.length === 0) return false;
      const refs = vars.map((v) => new RegExp(`\\$\\{?${v}\\b`));
      return wiringLines(s).some(
        (l) => !ENV_BINDS_REGION_INPUT.test(l)
          && l.includes(REGION_MEASUREMENT_VAR)
          && refs.some((re) => re.test(l)),
      );
    };
    if (readers.length === 0) {
      problems.push(
        'DISCOVERY FLOOR: no step reads `inputs.region` at all. The region is this workflow\'s ' +
        'target-selection input, so finding zero readers means the parser stopped matching and every ' +
        'S8 check below would pass by seeing nothing.',
      );
    }
    if (!readers.some((s) => wiring(s).includes(REGION_RECONCILIATION_MARKERS[0]))) {
      problems.push(
        `DISCOVERY FLOOR: no step both reads \`inputs.region\` and runs ${REGION_RECONCILIATION_MARKERS[0]}. ` +
        'One step must — it is what turns an absent region into a measured one, or refuses.',
      );
    }
    // The `env:`-binding regex is the other thing that can silently stop
    // matching: if it did, `boundVars` would be empty everywhere, the pairing
    // branch would be unreachable, and S8 would quietly narrow to the strong
    // markers alone. Both legitimate readers bind `INPUT_REGION`, so a zero here
    // means the extraction broke, not that the workflow changed shape.
    if (readers.length > 0 && !readers.some((s) => boundVars(s).length > 0)) {
      problems.push(
        'DISCOVERY FLOOR: `inputs.region` is read by ' + readers.length + ' step(s) but ENV_BINDS_REGION_INPUT ' +
        'extracted ZERO bound variable names. The extraction stopped matching, so the pairing exemption ' +
        'below can no longer be reached and S8 is measuring less than it reports.',
      );
    }
    for (const s of readers) {
      // SHADOWING THE MEASUREMENT is unconditionally unsafe, and no amount of
      // pairing can redeem it. `AZURE_LOCATION: ${{ inputs.region }}` in a step
      // `env:` OVERRIDES the value `Resolve reconcile target` wrote to
      // $GITHUB_ENV — for that step only — so every ordinary
      // `rg-…-${AZURE_LOCATION}` in the body silently becomes the EMPTY input
      // on a schedule. It also defeats the pairing test by construction: the
      // bound name and the measurement token are then the same string, so any
      // interpolation of the measured region reads as a reference to the bound
      // variable. Caught by name, before pairing is consulted.
      if (boundVars(s).includes(REGION_MEASUREMENT_VAR)) {
        problems.push(
          `step "${s.name}" (line ${s.startLine}) binds \`inputs.region\` to \`${REGION_MEASUREMENT_VAR}\` in its ` +
          '`env:`, which SHADOWS the measured region for the whole step. A step-level `env:` entry overrides ' +
          'what `Resolve reconcile target` wrote to $GITHUB_ENV, so every `${' + REGION_MEASUREMENT_VAR + '}` in ' +
          'the body silently becomes the raw input — the empty string on a `schedule` event. Never bind the ' +
          'input to the measurement variable\'s own name; read `$' + REGION_MEASUREMENT_VAR + '` from the shell ' +
          'instead (#3701).',
        );
        continue;
      }
      if (reconciles(s)) continue;
      problems.push(
        `step "${s.name}" (line ${s.startLine}) reads \`inputs.region\` without holding the MEASURED ` +
        'region, so it TRUSTS the input. That input is EMPTY on a `schedule` event, meaning the nightly ' +
        'reconcile runs this step with no region at all. Consume the measured `$AZURE_LOCATION` from the ' +
        'shell (as the MSAL and internal-token steps do), or pass `steps.reconcile.outputs.region` ' +
        'alongside it and reconcile the two. This is #3701: the DLZ adopt step trusted it, discovered ' +
        'nothing, and the deploy silently DELETED the seven lake LOOM_* env vars from the running ' +
        'console while reporting success.',
      );
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
