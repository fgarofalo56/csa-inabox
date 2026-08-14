#!/usr/bin/env node
/**
 * check-azd-provision-param-binding.mjs
 *
 * RULE. A workflow may invoke `azd provision` / `azd up` ONLY if the azd
 * project's Bicep module has a parameter-binding file beside it — either
 * `<module>.parameters.json` or `<module>.bicepparam`. If no azd project in the
 * repo can bind its parameters, NO workflow may run azd's provisioning
 * commands.
 *
 * WHY (#3415). `deploy-fiab-gcch.yml` and `deploy-fiab-gcc.yml` forked on
 * topology: `dlz-attach` ran `az deployment sub create` with the boundary's
 * `.bicepparam`, and EVERY OTHER TOPOLOGY — the default sovereign path — ran
 * `azd provision --no-prompt` against `platform/fiab/bicep/main.bicep`.
 *
 * Measured 2026-08-13:
 *   - `platform/fiab/azd/azure.yaml` sets `infra: {provider: bicep, path:
 *     ../bicep, module: main}`, so the template is platform/fiab/bicep/main.bicep.
 *   - `platform/fiab/bicep/` contains NO .json file at all and no
 *     `main.bicepparam`. The per-boundary params live in `params/<boundary>.bicepparam`,
 *     which is not a path azd looks at.
 *   - azd binds environment variables to Bicep parameters through
 *     `<module>.parameters.json` with `${VAR}` substitution (Learn: "Explore the
 *     azd up workflow", "Use environment secrets with the Azure Developer CLI").
 *   - `main.bicep` declares 22 parameters with NO default, and calls
 *     `readEnvironmentVariable` zero times — correctly, since that is a
 *     .bicepparam-only compile-time function. So the `azd env set CSA_LOOM_*`
 *     calls that branch made had no path into the template at all.
 *
 * Nothing could bind those 22 parameters, and the failure would have surfaced
 * far from its cause. Three earlier defects on the same code path (#3217 empty
 * azd env var, #3221 missing azd auth, #3137 missing subscription) each stopped
 * the run before it got here, so the missing file was never reached and never
 * reported. A file that is checked statically cannot hide behind the next
 * defect in front of it.
 *
 * SCOPE, stated so this is not read as broader than it is. This guard reads
 * GITHUB WORKFLOWS ONLY. It does NOT judge documentation: several docs still
 * tell a reader to `cd platform/fiab/azd && azd up`, and after #3415 that
 * instruction has the same missing binding. Those are tracked separately — the
 * fate of `platform/fiab/azd/` is an operator decision, not this guard's.
 *
 * SELF-DEFENCE (guard_with_zero_population_needs_embedded_control). #3415's fix
 * removes every `azd provision` from the workflows, so this guard's live
 * population is ZERO by design — and a rule whose population is zero proves
 * nothing about whether it can still see anything. `selfTest()` therefore runs
 * an embedded known-violating fixture on EVERY invocation, through the SAME
 * detector, plus the negative control that keeps it from flagging everything.
 * The guard also refuses to pass if it found no azure.yaml or scanned no
 * workflows.
 *
 * Run:  node scripts/ci/check-azd-provision-param-binding.mjs
 *       node scripts/ci/check-azd-provision-param-binding.mjs --self-test
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, relative, join, sep } from 'node:path';

const ROOT = process.cwd();

/** azd's documented defaults when `infra` omits them. */
const DEFAULT_INFRA_PATH = 'infra';
const DEFAULT_INFRA_MODULE = 'main';

/**
 * The commands that PROVISION. `azd deploy` pushes application code and does
 * not bind Bicep parameters, so it is deliberately not here — flagging it would
 * make the rule about the word "azd" rather than about parameter binding.
 */
const PROVISIONING_SUBCOMMANDS = ['provision', 'up'];

// ───────────────────────── detectors (PURE over text) ─────────────────────────

/**
 * Read `infra:` -> `provider` / `path` / `module` / `layers` out of an
 * azure.yaml. Deliberately not a YAML dependency: the guardrails lane runs with
 * nothing installed, and the shape read here is one level of plain mapping.
 *
 * @returns {{provider:string, path:string, module:string, layers:boolean, declared:boolean}}
 */
export function parseInfra(text) {
  const lines = String(text).split(/\r?\n/);
  let inInfra = false;
  let declared = false;
  let provider = 'bicep';
  let path = DEFAULT_INFRA_PATH;
  let module = DEFAULT_INFRA_MODULE;
  let layers = false;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    if (/^infra:\s*$/.test(raw)) {
      inInfra = true;
      declared = true;
      continue;
    }
    if (inInfra && /^\S/.test(raw)) {
      inInfra = false;
      continue;
    }
    if (!inInfra) continue;
    const kv = /^\s{2}([A-Za-z]+):\s*['"]?([^'"#\s]*)['"]?\s*(?:#.*)?$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'provider' && value) provider = value;
    else if (key === 'path' && value) path = value;
    else if (key === 'module' && value) module = value;
    else if (key === 'layers') layers = true;
  }
  return { provider, path, module, layers, declared };
}

/**
 * Find `azd provision` / `azd up` invocations in a workflow.
 *
 * CONTINUATION LINES ARE JOINED FIRST (csa_loom_guard_blind_continuation_lines).
 * The defect this replaces was written as
 *
 *     node scripts/ci/deploy-retry.mjs \
 *       ... \
 *       -- azd provision --no-prompt
 *
 * and a line-at-a-time reader that anchored on the `node` line would miss it.
 * Joining means the invocation is seen however it is wrapped.
 *
 * FULL-LINE COMMENTS ARE SKIPPED. The workflows that carried this defect now
 * carry long comments EXPLAINING it, which name `azd provision` verbatim. A
 * detector that flagged those would be flagging its own fix and would be
 * silenced by the first person it annoyed. An INLINE trailing `#` is NOT
 * stripped — that direction errs toward flagging, which is the safe one.
 *
 * @returns {{line:number, text:string}[]}
 */
export function findAzdProvisionInvocations(text) {
  const rawLines = String(text).split(/\r?\n/);
  /** @type {{line:number, text:string}[]} */
  const joined = [];
  let buffer = '';
  let startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (buffer === '' && /^\s*#/.test(raw)) continue; // full-line comment
    if (buffer === '') startLine = i + 1;
    const continues = /\\\s*$/.test(raw);
    buffer += (buffer === '' ? '' : ' ') + raw.replace(/\\\s*$/, '').trim();
    if (continues) continue;
    joined.push({ line: startLine, text: buffer });
    buffer = '';
  }
  if (buffer !== '') joined.push({ line: startLine, text: buffer });

  const pattern = new RegExp(String.raw`(^|[\s;&|(])azd\s+(${PROVISIONING_SUBCOMMANDS.join('|')})(\s|$)`);
  return joined.filter((j) => pattern.test(j.text)).map((j) => ({ line: j.line, text: j.text.slice(0, 200) }));
}

/**
 * Does this azd project have a file azd can bind parameters through?
 *
 * @param {(p:string)=>boolean} fileExists injected so the self-test exercises
 *   the SAME function the live scan uses, without touching the filesystem.
 * @returns {{ok:boolean, checked:string[], found:string|null, reason:string}}
 */
export function bindingFileFor(infra, azureYamlDir, fileExists) {
  if (infra.layers) {
    return {
      ok: false,
      checked: [],
      found: null,
      reason:
        'azure.yaml uses `infra.layers`, a shape this reader does not resolve. Refusing to report a pass on a file it cannot read.',
    };
  }
  if (String(infra.provider).toLowerCase() !== 'bicep') {
    return { ok: true, checked: [], found: null, reason: `infra.provider is '${infra.provider}', not bicep — this rule is about Bicep parameter binding.` };
  }
  const moduleDir = resolve(azureYamlDir, infra.path);
  const candidates = [
    join(moduleDir, `${infra.module}.parameters.json`),
    join(moduleDir, `${infra.module}.bicepparam`),
  ];
  const found = candidates.find((c) => fileExists(c)) || null;
  return {
    ok: found !== null,
    checked: candidates,
    found,
    reason: found ? `binds through ${found}` : 'no parameter-binding file beside the module',
  };
}

// ───────────────────────────── embedded control ──────────────────────────────

const FIXTURE_AZURE_YAML_UNBOUND = [
  'name: fixture',
  'infra:',
  '  provider: bicep',
  '  path: ../bicep',
  '  module: main',
  'services:',
  '  console:',
  '    project: ../../../apps/fiab-console',
].join('\n');

const FIXTURE_WORKFLOW_VIOLATING = [
  'jobs:',
  '  deploy:',
  '    steps:',
  '      - run: |',
  '          # azd provision is discussed here and must NOT be flagged',
  '          node scripts/ci/deploy-retry.mjs \\',
  '            --max-attempts 2 \\',
  '            -- azd provision --no-prompt',
].join('\n');

const FIXTURE_WORKFLOW_CLEAN = [
  'jobs:',
  '  deploy:',
  '    steps:',
  '      - run: |',
  '          # the azd provision branch was deleted in #3415',
  '          az deployment sub create --parameters params/gcc-high.bicepparam',
].join('\n');

/**
 * The embedded known-true control. Runs on EVERY invocation, because #3415's
 * fix drives the live population to zero and a zero-population rule that has
 * stopped matching is indistinguishable from a clean repo.
 */
export function selfTest({ quiet = false } = {}) {
  const cases = [];

  // 1. The detector must SEE the invocation, across a line continuation.
  const hits = findAzdProvisionInvocations(FIXTURE_WORKFLOW_VIOLATING);
  cases.push({
    name: 'detects `-- azd provision` across a backslash continuation',
    pass: hits.length === 1 && /azd provision/.test(hits[0].text),
    detail: `found ${hits.length} invocation(s)`,
  });

  // 2. NEGATIVE CONTROL: a full-line comment naming the command is not a hit.
  //    Without this the guard would flag the comments that document its own
  //    reason for existing.
  const cleanHits = findAzdProvisionInvocations(FIXTURE_WORKFLOW_CLEAN);
  cases.push({
    name: 'a full-line comment mentioning azd provision is NOT an invocation (CONTROL)',
    pass: cleanHits.length === 0,
    detail: `found ${cleanHits.length} invocation(s)`,
  });

  // 3. The unbound project must be judged unbound...
  const infra = parseInfra(FIXTURE_AZURE_YAML_UNBOUND);
  const unbound = bindingFileFor(infra, '/repo/platform/fiab/azd', () => false);
  cases.push({
    name: 'a module with no parameters.json / bicepparam beside it is UNBOUND',
    pass: infra.path === '../bicep' && infra.module === 'main' && unbound.ok === false,
    detail: `path=${infra.path} module=${infra.module} ok=${unbound.ok}`,
  });

  // 4. ...and the same project WITH the file must be judged bound. This is the
  //    half that keeps the rule from being "azd is banned": author
  //    main.parameters.json and azd provision becomes legal again.
  const bound = bindingFileFor(infra, '/repo/platform/fiab/azd', (p) => p.endsWith(`main.parameters.json`));
  cases.push({
    name: 'the same module WITH main.parameters.json beside it is BOUND (CONTROL)',
    pass: bound.ok === true,
    detail: `ok=${bound.ok} found=${bound.found}`,
  });

  // 5. A .bicepparam beside the module also binds.
  const boundByBicepparam = bindingFileFor(infra, '/repo/platform/fiab/azd', (p) => p.endsWith('main.bicepparam'));
  cases.push({
    name: 'a `<module>.bicepparam` beside the module also binds',
    pass: boundByBicepparam.ok === true,
    detail: `ok=${boundByBicepparam.ok}`,
  });

  // 6. `azd deploy` is not a provisioning command — the rule is about parameter
  //    binding, not about the word "azd".
  cases.push({
    name: '`azd deploy` is not flagged — this rule is about provisioning, not the word azd',
    pass: findAzdProvisionInvocations('      - run: azd deploy --all').length === 0,
    detail: 'ok',
  });

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) {
    if (!quiet || !c.pass) console[c.pass ? 'log' : 'error'](`  ${c.pass ? 'ok' : 'FAIL'}  ${c.name} — ${c.detail}`);
  }
  if (failed.length > 0) {
    console.error(
      `::error::check-azd-provision-param-binding self-test FAILED (${failed.length} case(s)). The detector cannot see its own known-violating fixture, so a clean scan proves NOTHING.`,
    );
    process.exit(2);
  }
  if (!quiet) console.log('check-azd-provision-param-binding self-test passed.');
  return true;
}

// ─────────────────────────────── live scan ───────────────────────────────────

function tracked(patterns) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', ...patterns], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error(
      `::error::check-azd-provision-param-binding: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk, which would judge the untracked scratch checkouts under .claude/worktrees/.',
    );
    process.exit(2);
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => join(ROOT, l));
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');
const fileExists = (p) => existsSync(p) && statSync(p).isFile();

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  // The embedded control runs BEFORE the live scan, every time.
  selfTest({ quiet: true });

  const azureYamls = tracked(['*azure.yaml', '*azure.yml']);
  if (azureYamls.length === 0) {
    console.error(
      '::error::check-azd-provision-param-binding: git tracks NO azure.yaml. This rule is about azd projects; with none, it is checking nothing and must not report a pass.',
    );
    process.exit(2);
  }

  /** Projects whose Bicep module has NO way for azd to bind its parameters. */
  const unbound = [];
  for (const file of azureYamls) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`::error::check-azd-provision-param-binding: could not read ${rel(file)}: ${e && e.message}`);
      process.exit(2);
    }
    const infra = parseInfra(text);
    if (!infra.declared) continue; // no `infra:` block -> azd provisions nothing here
    const verdict = bindingFileFor(infra, dirname(file), fileExists);
    if (!verdict.ok) {
      unbound.push({ file: rel(file), infra, verdict });
    }
  }

  const workflows = tracked(['.github/workflows/*.yml', '.github/workflows/*.yaml']);
  if (workflows.length === 0) {
    console.error(
      '::error::check-azd-provision-param-binding: scanned 0 workflow files. An empty population cannot be clean.',
    );
    process.exit(2);
  }

  const invocations = [];
  for (const wf of workflows) {
    let text;
    try {
      text = readFileSync(wf, 'utf8');
    } catch (e) {
      console.error(`::error::check-azd-provision-param-binding: could not read ${rel(wf)}: ${e && e.message}`);
      process.exit(2);
    }
    for (const hit of findAzdProvisionInvocations(text)) {
      invocations.push({ file: rel(wf), ...hit });
    }
  }

  if (unbound.length === 0) {
    console.log(
      `check-azd-provision-param-binding OK — every azd project (${azureYamls.length}) has a parameter-binding file beside its module, ` +
        `so the ${invocations.length} azd provisioning invocation(s) across ${workflows.length} workflow(s) can bind. Embedded control green.`,
    );
    return;
  }

  if (invocations.length === 0) {
    console.log(
      `check-azd-provision-param-binding OK — ${unbound.length} azd project(s) cannot bind Bicep parameters ` +
        `(${unbound.map((u) => u.file).join(', ')}), and NO workflow invokes \`azd provision\`/\`azd up\` ` +
        `(${workflows.length} workflows scanned). Embedded control green. ` +
        'Scope: workflows only — documentation is not judged here.',
    );
    return;
  }

  console.error(
    `::error::check-azd-provision-param-binding: ${invocations.length} workflow invocation(s) of \`azd provision\`/\`azd up\` ` +
      `against ${unbound.length} azd project(s) that CANNOT bind their Bicep parameters (#3415). azd binds parameters through ` +
      '`<module>.parameters.json` with ${VAR} substitution; without it (or a `<module>.bicepparam`) the module\'s required ' +
      'parameters have no source, and `--no-prompt` turns that into a failure far from its cause.',
  );
  for (const u of unbound) {
    console.error(
      `::error file=${u.file}::infra.path=${u.infra.path} infra.module=${u.infra.module} — ${u.verdict.reason}. ` +
        `Looked for: ${u.verdict.checked.map(rel).join(' , ') || '(n/a)'}`,
    );
  }
  for (const i of invocations) {
    console.error(`::error file=${i.file},line=${i.line}::${i.text}`);
  }
  console.error(
    'Fix EITHER by authoring the parameter-binding file beside the module, OR by deploying with ' +
      '`az deployment sub create --parameters <boundary>.bicepparam` (what #3415 chose, and what the Commercial and IL5 lanes already do).',
  );
  process.exit(1);
}

main();
