#!/usr/bin/env node
/**
 * GUARDRAIL: an `environment:` a workflow names must EXIST in the repository.
 *
 * WHY THIS EXISTS (#4114)
 * -----------------------
 * `.github/workflows/deploy-fiab-il5.yml` declared
 *
 *     environment: il5-deploy   # requires manual approval
 *
 * and `il5-deploy` was not among the repository's environments. GitHub
 * AUTO-CREATES an environment on first use, with NO protection rules — so the
 * first real IL5 run would have created it on the fly, unprotected, and walked
 * straight through an approval gate that existed only as a YAML comment. On a
 * lane that deploys into a DoD Impact Level 5 subscription.
 *
 * That is `presence != enforcement`: the control was in the source and not in
 * the repository, and nothing anywhere could tell the difference. It stayed
 * latent only because the lane has never run — which `deploy-integrity.md` R3
 * calls the LOUDEST form of drift, not a silent pass.
 *
 * THE RULE
 * --------
 * Every JOB-LEVEL `environment:` in `.github/workflows/**` must resolve against
 * the LIVE environment list. Keyed to the SHAPE — "every declared name resolves"
 * — and deliberately NOT to a list of known names: an enumeration is the trap
 * #4108 records, where the next name nobody thought of ships unguarded.
 *
 * WHAT IT DOES NOT JUDGE, STATED SO NOBODY READS MORE INTO A GREEN RUN
 * -------------------------------------------------------------------
 * It judges EXISTENCE, not PROTECTION. #4114's own ordering hazard is that
 * creating an environment WITHOUT required reviewers is worse than not having
 * it — it converts a latent gap into a live, permanently-unprotected gate that
 * now looks configured. Deciding WHICH lanes must carry reviewers is an
 * operator judgement over a list of lanes, i.e. exactly the enumeration this
 * guard refuses to become. So the protection-rule count of every named
 * environment is PRINTED on every run, judged by a human, and a `(0 rules)`
 * row is visible rather than silent. A green run means "every name resolves",
 * never "every gate is enforced".
 *
 * TEMPLATED VALUES ARE DISCLOSED, NEVER SILENTLY DROPPED
 * -----------------------------------------------------
 * `environment: ${{ inputs.environment }}` cannot be resolved statically. Those
 * are counted and listed as UNRESOLVED rather than skipped in silence — an
 * unmeasured thing rendered as a clean result is this repo's most repeated
 * reporting bug, and deploy-integrity R7 forbids asserting what was not
 * established.
 *
 * A STEP-LEVEL `with: environment:` IS NOT A JOB ENVIRONMENT. `azure/login`
 * takes an `environment:` input (`AzureUSGovernment`) and there are ~50 of them
 * in this repo. A line-oriented grep counts every one and this guard would then
 * report 50 phantom violations, so the structure is READ (`_workflow-yaml.mjs`)
 * rather than pattern-matched: only `jobs.<id>.environment` is a subject.
 *
 * FAILING CLOSED
 * --------------
 *   - The API is unreachable / `gh` fails  → FAIL, reported as UNREADABLE.
 *     Never "every environment exists".
 *   - Zero environments returned           → FAIL (a broken read, not a repo
 *     with no environments — and if it genuinely had none, every declared name
 *     would be a violation anyway).
 *   - Zero workflows parsed                → FAIL (vacuous pass).
 *   - Zero statically-resolvable names     → FAIL. A guard whose population is
 *     empty proves nothing about its matcher.
 *
 * THE EMBEDDED CONTROL
 * --------------------
 * {@link runEmbeddedControl} drives {@link analyze} over a KNOWN-TRUE synthetic
 * fixture on EVERY run, before the real population is judged: a workflow naming
 * an absent environment MUST be reported, and one naming a present environment
 * must NOT be. If the detector has stopped detecting, this guard fails even on
 * a repo where every name happens to resolve.
 *
 * PHYSICAL-LINES-OK: this guard never reads a shell body. Its only subject is
 * YAML BLOCK STRUCTURE (`jobs.<id>.environment`), and a node's parent is decided
 * by its indentation column — folding a trailing `\` would join two
 * differently-indented lines and corrupt the parse, which is the same decision
 * `_workflow-yaml.mjs` records for itself. The `line` numbers this file reports
 * come from that parser's scalars, so they name a real position; nothing here
 * requires two tokens to share a physical line. The `\r?\n` splits below are on
 * `gh --jq @tsv` output and on synthetic fixtures, neither of which is shell.
 *
 * MODES
 *   node scripts/ci/check-workflow-environments-exist.mjs              # CHECK
 *   node scripts/ci/check-workflow-environments-exist.mjs --self-test  # prove it can fail
 *   node scripts/ci/check-workflow-environments-exist.mjs --list       # print, judge nothing
 *
 * Env: GH_TOKEN (repository read), GITHUB_REPOSITORY (owner/repo).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseWorkflow } from './_workflow-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox';
const WORKFLOW_DIR = join(__dirname, '..', '..', '.github', 'workflows');

/**
 * At least this many job-level `environment:` values must resolve statically,
 * or the guard is measuring nothing. Two lanes carry a literal name today
 * (deploy-fiab-gcch -> gcc-high-deploy, deploy-fiab-il5 -> il5-deploy) plus
 * bicep-whatif -> dev and deploy-copilot-function -> copilot-function-prod, so
 * the floor is set below today's count and above zero.
 */
const MIN_STATIC_REFERENCES = 2;

/** A value GitHub resolves at run time, which no static read can follow. */
const TEMPLATED = /\$\{\{/;

// ── pure analysis ───────────────────────────────────────────────────────────

/**
 * Judge declared environment references against the measured environment list.
 * PURE — no network, no fs. The self-test and the embedded control drive this
 * same function, so what CI proves is what CI runs.
 *
 * @param {object} input
 * @param {Array<{workflow:string, job:string, name:string, line:number}>} input.declared
 * @param {number} input.templated how many references could not be resolved statically
 * @param {Array<{name:string, protectionRules:number}>} input.environments measured population
 * @param {number} input.workflowsRead how many workflow files were parsed
 * @returns {{violations:Array<{kind:string,subject:string,why:string}>, resolved:number}}
 */
export function analyze({ declared, templated, environments, workflowsRead }) {
  const violations = [];
  const push = (kind, subject, why) => violations.push({ kind, subject, why });

  if (!Array.isArray(environments) || environments.length === 0) {
    push(
      'empty-environment-list',
      '(the whole repo)',
      'the environments API returned ZERO environments. Treated as a BROKEN READ rather than ' +
        'a repo with none: reporting "nothing to check" over an unread list is how a control ' +
        'goes quiet without going red.',
    );
    return { violations, resolved: 0 };
  }

  if (!Number.isFinite(workflowsRead) || workflowsRead === 0) {
    push(
      'no-workflows',
      '.github/workflows',
      'no workflow files were parsed, so NO environment reference was examined. ' +
        'A guard that read nothing has verified nothing.',
    );
    return { violations, resolved: 0 };
  }

  const refs = Array.isArray(declared) ? declared : [];
  if (refs.length < MIN_STATIC_REFERENCES) {
    push(
      'empty-population',
      '(static environment references)',
      `found ${refs.length} statically-resolvable job-level \`environment:\` value(s); at least ` +
        `${MIN_STATIC_REFERENCES} are expected in this repo. Either every deploy lane stopped ` +
        'declaring an environment — which would itself be the defect this guard exists for — or ' +
        'the structural reader stopped finding them. Both are red; neither is a clean repo. ' +
        `(${Number(templated) || 0} further reference(s) are templated and unresolvable.)`,
    );
  }

  const known = new Set(environments.map((e) => String(e.name)));
  for (const r of refs) {
    if (known.has(r.name)) continue;
    push(
      'missing-environment',
      `${r.workflow}:${r.line} (job \`${r.job}\`)`,
      `declares \`environment: ${r.name}\`, and no environment by that name exists in ${REPO}. ` +
        'GitHub AUTO-CREATES it on first use with NO protection rules, so an approval gate written ' +
        'here is enforced by nothing — the run proceeds and the environment then exists, looking ' +
        'configured. Create it in repository settings WITH its required reviewers BEFORE the lane ' +
        'runs; creating it without them is worse than the status quo (#4114). Existing: ' +
        `${[...known].sort().join(', ')}.`,
    );
  }

  return { violations, resolved: refs.length - violations.filter((v) => v.kind === 'missing-environment').length };
}

// ── structural read ─────────────────────────────────────────────────────────

/**
 * Every JOB-LEVEL `environment:` in one parsed workflow.
 *
 * Both spellings GitHub accepts are read: the scalar (`environment: prod`) and
 * the mapping (`environment:\n  name: prod\n  url: …`). A step's
 * `with: { environment: … }` is NEVER reached, because this only ever looks at
 * `jobs.<id>.environment` — which is the whole reason the structure is parsed
 * instead of grepped (see the header).
 *
 * PURE over an already-parsed document so the self-test can drive it.
 *
 * @returns {{refs:Array<{job:string,name:string,line:number}>, templated:number}}
 */
export function jobEnvironments(doc) {
  const refs = [];
  let templated = 0;
  const jobs = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.jobs : null;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs) || 'v' in jobs) return { refs, templated };

  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (!job || typeof job !== 'object' || Array.isArray(job) || 'v' in job) continue;
    const env = job.environment;
    if (env === undefined || env === null) continue;

    // Scalar form.
    if (typeof env === 'object' && !Array.isArray(env) && 'v' in env && 'line' in env) {
      const raw = String(env.v).trim();
      if (!raw) continue;
      if (TEMPLATED.test(raw)) { templated += 1; continue; }
      refs.push({ job: jobId, name: raw, line: env.line });
      continue;
    }
    // Mapping form — `name:` is the environment; `url:` is not.
    if (typeof env === 'object' && !Array.isArray(env) && env.name && 'v' in env.name) {
      const raw = String(env.name.v).trim();
      if (!raw) continue;
      if (TEMPLATED.test(raw)) { templated += 1; continue; }
      refs.push({ job: jobId, name: raw, line: env.name.line });
    }
  }
  return { refs, templated };
}

/** Read + parse `.github/workflows/*.yml|*.yaml`. Errors are RETURNED. */
function readDeclared(dir = WORKFLOW_DIR) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  } catch (e) {
    return { error: `cannot read ${dir} — ${String(e?.message || e).slice(0, 200)}` };
  }
  const declared = [];
  const unparsed = [];
  let templated = 0;
  for (const n of names) {
    let doc;
    try {
      doc = parseWorkflow(readFileSync(join(dir, n), 'utf8'));
    } catch (e) {
      // `parseWorkflow` THROWS on a construct it cannot model rather than
      // half-reading it. A file we could not parse is a file whose environment
      // references are UNKNOWN, so it is reported, never counted as clean.
      unparsed.push(`${n} — ${String(e?.message || e).slice(0, 120)}`);
      continue;
    }
    const { refs, templated: t } = jobEnvironments(doc);
    templated += t;
    for (const r of refs) declared.push({ workflow: n, ...r });
  }
  return { declared, templated, unparsed, workflowsRead: names.length - unparsed.length };
}

// ── the embedded known-true control ─────────────────────────────────────────

const CONTROL_ENVIRONMENTS = [{ name: 'control-present', protectionRules: 1 }];
const CONTROL_DECLARED_BAD = [
  { workflow: 'control-a.yml', job: 'deploy', name: 'control-present', line: 3 },
  { workflow: 'control-b.yml', job: 'deploy', name: 'control-absent', line: 7 },
];
const CONTROL_DECLARED_GOOD = [
  { workflow: 'control-a.yml', job: 'deploy', name: 'control-present', line: 3 },
  { workflow: 'control-c.yml', job: 'deploy', name: 'control-present', line: 5 },
];

/**
 * Prove the detector still detects, on EVERY run. Two assertions, because
 * either alone is satisfiable by a broken guard: one that flags everything
 * passes the positive case, one that flags nothing passes the negative.
 */
export function runEmbeddedControl() {
  const positive = analyze({
    declared: CONTROL_DECLARED_BAD,
    templated: 0,
    environments: CONTROL_ENVIRONMENTS,
    workflowsRead: 2,
  });
  const caught = positive.violations.some(
    (v) => v.kind === 'missing-environment' && v.subject.startsWith('control-b.yml:7'),
  );
  const negative = analyze({
    declared: CONTROL_DECLARED_GOOD,
    templated: 0,
    environments: CONTROL_ENVIRONMENTS,
    workflowsRead: 2,
  });
  const quiet = negative.violations.length === 0;
  return { ok: caught && quiet, caught, quiet };
}

// ── self-test: mutation-prove every branch that can fail ────────────────────

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  console.log('[workflow-environments-exist] self-test — the guard must FAIL on each defect it exists for');

  const kinds = (v) => v.map((x) => x.kind).sort().join(',') || '(none)';
  const run = (over = {}) =>
    analyze({
      declared: CONTROL_DECLARED_GOOD,
      templated: 0,
      environments: CONTROL_ENVIRONMENTS,
      workflowsRead: 2,
      ...over,
    }).violations;

  const control = runEmbeddedControl();
  say(control.ok, `embedded control is known-true (caught=${control.caught}, quiet-on-clean=${control.quiet})`);

  say(kinds(run()) === '(none)', `a fully-resolving population is SILENT — got [${kinds(run())}]`);
  say(
    kinds(run({ declared: CONTROL_DECLARED_BAD })) === 'missing-environment',
    'an environment that does not exist is caught — THE #4114 defect',
  );
  say(
    kinds(run({ environments: [] })) === 'empty-environment-list',
    'a zero-environment read FAILS rather than reading as "nothing to check"',
  );
  say(
    kinds(run({ workflowsRead: 0 })) === 'no-workflows',
    'parsing zero workflows FAILS rather than passing vacuously',
  );
  say(
    kinds(run({ declared: [CONTROL_DECLARED_GOOD[0]] })) === 'empty-population',
    'a population below the floor FAILS — a matcher that stopped matching must not read as clean',
  );
  say(
    kinds(run({ declared: [] })) === 'empty-population',
    'zero static references FAILS',
  );

  // ── the structural reader: a step input must NOT be mistaken for a job env ──
  const WF_STEP_INPUT = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: azure/login@v2',
    '        with:',
    '          environment: AzureUSGovernment',
    '',
  ].join('\n');
  const stepOnly = jobEnvironments(parseWorkflow(WF_STEP_INPUT));
  say(
    stepOnly.refs.length === 0,
    `a step's \`with: environment:\` is NOT a job environment — got ${JSON.stringify(stepOnly.refs)}`,
  );

  const WF_SCALAR = [
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    environment: il5-deploy   # requires manual approval',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n');
  const scalar = jobEnvironments(parseWorkflow(WF_SCALAR));
  say(
    scalar.refs.length === 1 && scalar.refs[0].name === 'il5-deploy' && scalar.refs[0].line === 4,
    `the scalar form is read, trailing comment stripped — got ${JSON.stringify(scalar.refs)}`,
  );

  const WF_MAPPING = [
    'jobs:',
    '  pages:',
    '    environment:',
    '      name: github-pages',
    '      url: https://example.invalid',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n');
  const mapping = jobEnvironments(parseWorkflow(WF_MAPPING));
  say(
    mapping.refs.length === 1 && mapping.refs[0].name === 'github-pages',
    `the mapping form reads \`name:\` and ignores \`url:\` — got ${JSON.stringify(mapping.refs)}`,
  );

  const WF_TEMPLATED = [
    'jobs:',
    '  deploy:',
    '    environment: ${{ inputs.environment }}',
    '    steps:',
    '      - run: echo hi',
    '',
  ].join('\n');
  const tmpl = jobEnvironments(parseWorkflow(WF_TEMPLATED));
  say(
    tmpl.refs.length === 0 && tmpl.templated === 1,
    `a templated value is DISCLOSED as unresolved, not silently dropped — got ${JSON.stringify(tmpl)}`,
  );

  // The wiring as it actually stands in this checkout — the one non-synthetic
  // assertion here, because "the reader works" and "the repo has references to
  // read" are different claims and only the second keeps the guard alive.
  const real = readDeclared();
  if (real.error) {
    say(false, `the real .github/workflows is readable — ${real.error}`);
  } else {
    say(
      real.declared.length >= MIN_STATIC_REFERENCES,
      `this checkout declares ${real.declared.length} static job environment(s) ` +
        `[${[...new Set(real.declared.map((d) => d.name))].sort().join(', ')}] — needs >= ${MIN_STATIC_REFERENCES}`,
    );
    say(
      real.unparsed.length === 0,
      `every workflow parsed — ${real.unparsed.length} unparseable: ${real.unparsed.join(' | ') || 'none'}`,
    );
  }

  console.log(ok ? '[workflow-environments-exist] self-test OK' : '[workflow-environments-exist] self-test FAILED');
  return ok ? 0 : 1;
}

// ── IO ──────────────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
}

/**
 * The measured environment population, with each one's protection-rule COUNT so
 * a `(0 rules)` row is visible in the output (see the header: this guard prints
 * protection, it does not judge it).
 *
 * Errors are RETURNED, never swallowed. A guard that cannot read its subject
 * must say so in those words.
 */
function fetchEnvironments() {
  try {
    const tsv = gh([
      'api',
      `repos/${REPO}/environments?per_page=100`,
      '--paginate',
      '--jq',
      '.environments[] | [.name, (.protection_rules | length)] | @tsv',
    ]);
    const rows = tsv
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name, rules] = l.split('\t');
        return { name: String(name).trim(), protectionRules: Number(rules) || 0 };
      });
    return { rows };
  } catch (e) {
    return { error: `environments listing failed — ${String(e?.stderr || e?.message || e).trim().slice(0, 400)}` };
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  // The control runs BEFORE the real population is judged, and its failure is
  // terminal: on a repo where every name happens to resolve, this is the only
  // thing that executes the detector.
  const control = runEmbeddedControl();
  if (!control.ok) {
    console.error(
      '[workflow-environments-exist] REFUSING TO RUN: the embedded known-true control did not behave.\n' +
        `  detects a workflow naming an absent environment: ${control.caught}\n` +
        `  silent on an all-resolving population:           ${control.quiet}\n` +
        '  analyze() has stopped measuring what this guard claims to measure. Fix the analyser;\n' +
        '  do not ship a green check whose detector is dead.',
    );
    return 1;
  }

  const read = readDeclared();
  if (read.error) {
    console.error(
      `[workflow-environments-exist] UNREADABLE — ${read.error}\n\n` +
        '  The workflow directory could not be read, so which environments are declared is UNKNOWN.\n' +
        '  Unknown fails closed. (Is the repo checked out in this job?)\n',
    );
    return 1;
  }
  if (read.unparsed.length > 0) {
    console.error('[workflow-environments-exist] FAIL — workflow file(s) could not be parsed, so their');
    console.error('  environment references are UNKNOWN and cannot be reported as resolving:');
    for (const u of read.unparsed) console.error(`    ${u}`);
    return 1;
  }

  const listed = fetchEnvironments();
  if (listed.error) {
    console.error(
      `[workflow-environments-exist] UNREADABLE — ${listed.error}\n\n` +
        '  This is NOT "every environment exists". The environments API could not be read, so\n' +
        `  whether ${REPO}'s declared environments resolve is UNKNOWN, and unknown fails closed.\n` +
        '  Most likely: GH_TOKEN is unset on the step, or the job lacks repository read.\n',
    );
    return 1;
  }

  if (argv.includes('--list')) {
    for (const e of [...listed.rows].sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`${e.protectionRules} rule(s)\t${e.name}`);
    }
    for (const d of read.declared) console.log(`declared\t${d.workflow}:${d.line}\t${d.name}`);
    console.log(`\n${read.templated} templated reference(s) are unresolvable statically.`);
    return 0;
  }

  const { violations } = analyze({
    declared: read.declared,
    templated: read.templated,
    environments: listed.rows,
    workflowsRead: read.workflowsRead,
  });

  if (violations.length > 0) {
    console.error(`\n[workflow-environments-exist] ${violations.length} finding(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.subject}  [${v.kind}]`);
      console.error(`      ${v.why}`);
    }
    console.error(
      '\n  An environment named but not created is auto-created UNPROTECTED on first use, so an\n' +
        '  approval gate written in YAML is enforced by nothing. Create it in repository settings\n' +
        '  WITH its required reviewers — never without, which converts a latent gap into a live\n' +
        '  gate that looks configured (#4114).\n',
    );
    return 1;
  }

  const byRules = [...listed.rows].sort((a, b) => a.name.localeCompare(b.name));
  const declaredNames = [...new Set(read.declared.map((d) => d.name))].sort();
  console.log(
    `[workflow-environments-exist] OK — ${read.declared.length} job-level \`environment:\` reference(s) ` +
      `across ${read.workflowsRead} workflow(s) all resolve against ${listed.rows.length} live environment(s); ` +
      `${read.templated} further reference(s) are templated and were NOT resolved; ` +
      'embedded control detected its known-true fixture.',
  );
  console.log('    EXISTENCE is what passed here — protection is PRINTED, not judged (see this file\'s header):');
  for (const e of byRules) {
    const used = declaredNames.includes(e.name) ? ' <- declared by a workflow' : '';
    console.log(`      ${String(e.protectionRules).padStart(2)} protection rule(s)  ${e.name}${used}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
