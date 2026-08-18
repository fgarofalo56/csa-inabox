#!/usr/bin/env node
/**
 * GUARDRAIL: no ARM resource may REFERENCE ITSELF. (merge-blocker — #3714)
 *
 * WHY THIS EXISTS (#3714)
 * -----------------------
 * #3691 added this to `platform/fiab/bicep/modules/admin-plane/registry.bicep`:
 *
 *     var existingAcrTags = reference(
 *       extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default'),
 *       '2021-04-01', 'Full')
 *     resource acrComplianceTags 'Microsoft.Resources/tags@2021-04-01' = {
 *       name: 'default'
 *       scope: acr
 *       properties: { tags: union(existingAcrTags.?properties.?tags ?? {}, complianceTags) }
 *     }
 *
 * `extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default')` is the
 * resource id OF THE RESOURCE BEING DECLARED. ARM reads that as the resource
 * depending on itself and refuses the ENTIRE template:
 *
 *     InvalidTemplate → Deployment template validation failed:
 *     'Circular dependency detected on resource:
 *      …/registries/<acr>/providers/Microsoft.Resources/tags/default'
 *
 * Every Commercial `az deployment sub create` failed from the moment it merged
 * until it was reverted. It never completed one successful deploy.
 *
 * WHY NOTHING ELSE CATCHES IT — the reason this guard is STATIC
 * -------------------------------------------------------------
 * Measured 2026-08-18 against the live Commercial estate, on the exact template:
 *
 *   az bicep build                        → exit 0     (compiles cleanly)
 *   az deployment sub what-if             → Succeeded  (run 32115429033)
 *   az deployment sub validate            → Succeeded, "error": null
 *   az deployment sub create              → InvalidTemplate, circular dependency
 *
 * bicep is blind because the cycle is an ARM RUNTIME expression, not a bicep
 * symbol cycle. And BOTH ARM preflights are blind because this module reaches
 * ARM inside the `admin-plane` nested deployment, which carries
 * `expressionEvaluationOptions: {scope: 'inner'}` — ARM does not expand an
 * inner-scoped nested template during preflight, only during the real apply.
 * Confirmed by isolating the same shape into a standalone template and running
 * `az deployment group validate` on it directly: THAT reports the circular
 * dependency, because the cycle is then in the template being validated rather
 * than in a nested body ARM has not opened yet.
 *
 * So "add a validate/what-if preflight" is NOT a fix for this class. A preflight
 * step would have been a gate that CANNOT FAIL — it was already there, it was
 * already green, and the deploy still died. Detection has to happen on the
 * compiled template, statically, which is what this does.
 *
 * WHAT IT FLAGS
 * -------------
 * For every resource in the compiled template AND in every nested template,
 * recursively: build the resource's OWN id expression, and fail if the
 * resource's own body contains `reference(<that same id expression>)`.
 *
 * Two id forms are built, matching bicep's codegen:
 *   - extension/scoped:  extensionResourceId(<scope>, '<type>', <name>)
 *   - plain:             resourceId('<type>', <name>)
 *
 * It is deliberately NARROW: referencing a DIFFERENT resource, or a different
 * extension resource on the same scope, is legitimate and common. Only an exact
 * self-id match fails.
 *
 * REFUSES TO PASS VACUOUSLY
 * -------------------------
 * A guard whose population is zero (which is the state right after #3714 is
 * fixed) proves nothing by returning green — see the repo's
 * `guard_with_zero_population_needs_embedded_control` lesson. So this carries an
 * EMBEDDED POSITIVE CONTROL: a fixture reproducing the #3691 codegen byte-for-
 * byte, which the same detector must flag on every run. If the control ever
 * stops being detected the guard FAILS, even when the repo itself is clean.
 * It also fails when: `az`/`az bicep build` is unavailable or non-zero, the
 * build produces no usable ARM template, or the walk visits zero resources.
 *
 * Usage: node scripts/ci/check-arm-self-referential-resource.mjs [repo-root]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bicep entrypoints whose full compiled closure is scanned. */
export const ENTRYPOINTS = ['platform/fiab/bicep/main.bicep'];

// ── detection (pure — exercised by the embedded control and the unit test) ────

/**
 * Strip ARM's `[ … ]` expression wrapper. A non-expression string is returned
 * quoted as an ARM string literal, so both forms compose into an id expression.
 *
 * @param {unknown} v
 * @returns {string|null} the inner expression text, or null when `v` is absent
 */
export function armExprInner(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1);
  return `'${t}'`;
}

/**
 * The id expression(s) that denote THIS resource, as bicep would emit them.
 *
 * @param {Record<string, any>} r a resource node from a compiled ARM template
 * @returns {string[]} zero or more self-id expressions
 */
export function selfIdExpressions(r) {
  const nameExpr = armExprInner(r?.name);
  if (!nameExpr || typeof r?.type !== 'string') return [];
  const type = r.type;
  const out = [];
  const scopeExpr = armExprInner(r?.scope);
  if (scopeExpr) out.push(`extensionResourceId(${scopeExpr}, '${type}', ${nameExpr})`);
  out.push(`resourceId('${type}', ${nameExpr})`);
  return out;
}

/**
 * Does this resource's own body `reference()` its own id?
 *
 * The body is serialized and searched for the literal `reference(<selfId>`.
 * bicep emits ARM expressions without incidental whitespace, so an exact
 * substring match is both sufficient and precise; a looser match (e.g. "type
 * and name appear somewhere") would flag every legitimate sibling reference.
 *
 * @param {Record<string, any>} r
 * @returns {{selfId: string}|null}
 */
export function selfReference(r) {
  if (!r || typeof r !== 'object') return null;
  // `dependsOn` is excluded: bicep emits the parent's id there for a scoped
  // child, which is a normal ordering edge and not the defect. The cycle is
  // created by READING the value, i.e. `reference(...)`.
  const { dependsOn: _ignored, ...body } = r;
  const blob = JSON.stringify(body);
  for (const selfId of selfIdExpressions(r)) {
    if (blob.includes(`reference(${selfId}`)) return { selfId };
  }
  return null;
}

/**
 * Walk a compiled ARM template and every nested `Microsoft.Resources/deployments`
 * template, yielding findings.
 *
 * Handles both `resources` shapes bicep emits: the symbolic-name OBJECT
 * (languageVersion 2.0) and the classic ARRAY.
 *
 * @param {Record<string, any>} tmpl
 * @param {string} where human-readable path, e.g. `main.json/adminPlane/registry`
 * @param {{resources: number, templates: number}} stats
 * @param {Array<{where: string, type: string, name: unknown, selfId: string}>} out
 */
export function walkTemplate(tmpl, where, stats, out) {
  if (!tmpl || typeof tmpl !== 'object') return;
  stats.templates += 1;
  const res = tmpl.resources;
  if (!res) return;
  const entries = Array.isArray(res)
    ? res.map((r, i) => [String(i), r])
    : Object.entries(res);
  for (const [key, r] of entries) {
    if (!r || typeof r !== 'object') continue;
    stats.resources += 1;
    const hit = selfReference(r);
    if (hit) {
      out.push({ where: `${where}/${key}`, type: r.type, name: r.name, selfId: hit.selfId });
    }
    if (r.type === 'Microsoft.Resources/deployments') {
      const nested = r?.properties?.template;
      if (nested && typeof nested === 'object') {
        walkTemplate(nested, `${where}/${key}`, stats, out);
      }
    }
  }
}

/**
 * The EMBEDDED POSITIVE CONTROL — the #3691 defect exactly as bicep compiled it,
 * copied from the real `az bicep build` output of the reverted commit.
 *
 * This exists because after the fix the repo's own population is ZERO, and a
 * zero-population guard that returns green has not demonstrated anything. If a
 * refactor ever breaks the detector, this fails first and by name.
 */
export const CONTROL_TEMPLATE = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  resources: {
    acr: {
      type: 'Microsoft.ContainerRegistry/registries',
      apiVersion: '2025-04-01',
      name: "[variables('acrName')]",
    },
    acrComplianceTags: {
      type: 'Microsoft.Resources/tags',
      apiVersion: '2021-04-01',
      scope: "[resourceId('Microsoft.ContainerRegistry/registries', variables('acrName'))]",
      name: 'default',
      properties: {
        tags: "[union(coalesce(tryGet(tryGet(reference(extensionResourceId(resourceId('Microsoft.ContainerRegistry/registries', variables('acrName')), 'Microsoft.Resources/tags', 'default'), '2021-04-01', 'Full'), 'properties'), 'tags'), createObject()), parameters('complianceTags'))]",
      },
      dependsOn: ["[resourceId('Microsoft.ContainerRegistry/registries', variables('acrName'))]"],
    },
  },
};

/**
 * A NEGATIVE control: the same shape reading a DIFFERENT resource's tags. This
 * must NOT be flagged — a detector that fires on it would be unusable, and
 * "fails closed on everything" is not a working guard.
 */
export const NEGATIVE_CONTROL_TEMPLATE = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  resources: {
    otherTags: {
      type: 'Microsoft.Resources/tags',
      apiVersion: '2021-04-01',
      scope: "[resourceId('Microsoft.ContainerRegistry/registries', variables('acrName'))]",
      name: 'default',
      properties: {
        tags: "[reference(extensionResourceId(resourceId('Microsoft.Storage/storageAccounts', variables('saName')), 'Microsoft.Resources/tags', 'default'), '2021-04-01', 'Full')]",
      },
    },
  },
};

/** @returns {string[]} failure messages from the embedded controls */
export function runEmbeddedControls() {
  const problems = [];

  const posOut = [];
  walkTemplate(CONTROL_TEMPLATE, 'embedded-positive-control', { resources: 0, templates: 0 }, posOut);
  if (posOut.length !== 1) {
    problems.push(
      `EMBEDDED POSITIVE CONTROL FAILED: the detector found ${posOut.length} self-reference(s) in the #3691 fixture, expected exactly 1. ` +
        'The detector is broken, so a green result on the real templates would mean nothing.',
    );
  }

  const negOut = [];
  walkTemplate(NEGATIVE_CONTROL_TEMPLATE, 'embedded-negative-control', { resources: 0, templates: 0 }, negOut);
  if (negOut.length !== 0) {
    problems.push(
      `EMBEDDED NEGATIVE CONTROL FAILED: the detector flagged ${negOut.length} self-reference(s) in a fixture that references a DIFFERENT resource. ` +
        'A detector that fires on legitimate cross-resource references would have to be switched off, which is how guards die.',
    );
  }

  return problems;
}

// ── az plumbing ──────────────────────────────────────────────────────────────

/** @see scripts/ci/check-deploy-template-sync.mjs — same reasoning, same shape. */
const INTERPRETER_SAFE_ARG = /^[A-Za-z0-9 _.,:@+=\\/()[\]{}~'-]*$/;

/** @param {string[]} args */
function assertInterpreterSafeArgs(args) {
  for (const a of args) {
    if (typeof a !== 'string' || !INTERPRETER_SAFE_ARG.test(a)) {
      throw new Error(
        `refusing to run \`az\` through cmd.exe with an argument it would re-parse: ${JSON.stringify(a)}. ` +
          'On Windows `az` is a .cmd and Node cannot spawn it directly, so the argument list is re-parsed by cmd.exe.',
      );
    }
  }
}

/** @param {Record<string,string|undefined>} env @returns {string} */
function resolveWindowsInterpreter(env = process.env) {
  const w = path.win32;
  const candidates = [
    env.SystemRoot ? w.join(env.SystemRoot, 'System32', 'cmd.exe') : null,
    env.windir ? w.join(env.windir, 'System32', 'cmd.exe') : null,
    env.ComSpec || null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (w.basename(c).toLowerCase() === 'cmd.exe' && w.isAbsolute(c) && fs.existsSync(c)) return c;
  }
  throw new Error('could not resolve a Windows cmd.exe to run `az` through');
}

/** @param {string[]} args */
function runAz(args) {
  const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  if (process.platform === 'win32') {
    const interpreter = resolveWindowsInterpreter();
    assertInterpreterSafeArgs(['az', ...args]);
    const res = spawnSync(interpreter, ['/d', '/c', 'az', ...args], opts);
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
  }
  const res = spawnSync('az', args, opts);
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
}

/**
 * Compile `srcAbs` and return the parsed ARM template.
 * Never returns something unusable: a 0 exit with no/garbage output FAILS.
 * @param {string} srcAbs @returns {Record<string, any>}
 */
function compile(srcAbs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-selfref-'));
  const out = path.join(dir, 'compiled.json');
  try {
    const res = runAz(['bicep', 'build', '-f', srcAbs, '--outfile', out]);
    if (res.error) throw new Error(`could not run \`az bicep build\`: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`\`az bicep build\` failed (exit ${res.status}).\n${res.stderr.trim().slice(-4000)}`);
    }
    if (!fs.existsSync(out)) throw new Error('`az bicep build` exited 0 but produced no output file');
    const raw = fs.readFileSync(out, 'utf8');
    if (!raw.trim()) throw new Error('`az bicep build` produced an empty file');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.resources === undefined) {
      throw new Error('`az bicep build` output is not an ARM template with resources');
    }
    return parsed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(root = process.cwd()) {
  const log = (m) => console.log(`[arm-self-ref] ${m}`);
  const fail = [];

  // The controls run FIRST and unconditionally. If the detector is broken there
  // is no point reporting on the repo, and a green repo result would be a lie.
  const controlProblems = runEmbeddedControls();
  if (controlProblems.length) {
    console.error('\n::error::arm-self-ref — the guard failed its OWN embedded controls.');
    for (const p of controlProblems) console.error(`\n${p}`);
    process.exit(1);
  }
  log('embedded controls OK — the #3691 fixture is detected, the cross-resource fixture is not.');

  if (ENTRYPOINTS.length === 0) {
    console.error('[arm-self-ref] FAIL — ENTRYPOINTS is empty; this guard would check nothing.');
    process.exit(1);
  }

  let totalResources = 0;
  for (const entry of ENTRYPOINTS) {
    const srcAbs = path.join(root, entry);
    if (!fs.existsSync(srcAbs)) {
      fail.push(`${entry} is missing (declared in ENTRYPOINTS).`);
      continue;
    }
    let tmpl;
    try {
      log(`compiling ${entry} …`);
      tmpl = compile(srcAbs);
    } catch (e) {
      fail.push(`${entry}: ${e.message}`);
      continue;
    }

    const stats = { resources: 0, templates: 0 };
    const found = [];
    walkTemplate(tmpl, entry, stats, found);
    totalResources += stats.resources;

    // A walk that visited nothing is not a pass.
    if (stats.resources === 0) {
      fail.push(`${entry}: the walk visited ZERO resources — this guard checked nothing.`);
      continue;
    }
    log(`${entry}: ${stats.resources} resource(s) across ${stats.templates} template(s) scanned.`);

    for (const f of found) {
      fail.push(
        [
          `${f.where} REFERENCES ITSELF.`,
          `  type:    ${f.type}`,
          `  name:    ${JSON.stringify(f.name)}`,
          `  self id: ${f.selfId}`,
          '',
          '  ARM reads this as the resource depending on itself and rejects the WHOLE template:',
          '    InvalidTemplate → Circular dependency detected on resource: …',
          '',
          '  A template cannot read and write the same resource in one deployment. Renaming symbols,',
          '  splitting modules or adding dependsOn does NOT break the cycle — stop reading the resource',
          '  you are declaring. If you need its current server-side state, do it out-of-band after the',
          '  apply (see scripts/csa-loom/apply-acr-compliance-tags.sh, the #3714 fix).',
          '',
          '  NOTE: `az bicep build`, `az deployment sub what-if` and `az deployment sub validate` all',
          '  return SUCCESS on this — ARM does not expand inner-scoped nested templates during',
          '  preflight. This static check is the only thing that catches it before the apply.',
        ].join('\n'),
      );
    }
  }

  if (fail.length) {
    console.error('\n::error::arm-self-ref — an ARM resource references itself; every deploy using this template will fail with InvalidTemplate.');
    for (const f of fail) console.error(`\n${f}`);
    process.exit(1);
  }

  log(`PASS — no self-referential resource in ${ENTRYPOINTS.length} entrypoint(s), ${totalResources} resource(s) scanned.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(
    process.argv[2]
      ? path.resolve(process.argv[2])
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  );
}
