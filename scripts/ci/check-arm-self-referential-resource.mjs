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
 * ONE LEVEL OF `var` INDIRECTION DEFEATED THE FIRST VERSION (#3716)
 * ----------------------------------------------------------------
 * The literal-substring match above catches exactly ONE spelling of the defect.
 * Measured on a real `az bicep build` of the #3691 shape with the id hoisted
 * into a bicep `var` — an ordinary readability refactor, not an evasion:
 *
 *     var selfTagId = extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default')
 *     var existingAcrTags = reference(selfTagId, '2021-04-01', 'Full')
 *
 * bicep emits the id into the ARM `variables` section and the body becomes
 * `reference(variables('selfTagId'), '2021-04-01', 'Full')`. The v1 detector
 * scanned 2 resources and reported ZERO findings on a template ARM rejects with
 * the same `Circular dependency detected` it rejected #3691 with.
 *
 * So before matching, `variables('x')` is substituted from the SAME template's
 * `variables` map, on BOTH sides — the body blob and the self-id expressions.
 * Expanding both sides keeps them consistent, so a legitimate reference to a
 * DIFFERENT resource still does not match (there is a var-indirected NEGATIVE
 * control below that proves the expansion does not over-fire).
 *
 * KNOWN, DELIBERATE LIMITS — this guard does NOT claim to catch:
 *   - an id assembled by string concatenation (`concat(x, '/providers/...')`)
 *     rather than by resourceId()/extensionResourceId();
 *   - indirection where one side of the comparison is a template PARAMETER and
 *     the other is not. (The common bicep-module case is safe: inside a nested
 *     template BOTH sides read the same `parameters('x')`, so they match
 *     without any expansion — that is how the real #3691 module was caught.)
 *   - a SYMBOLIC `reference('someResource')`, which bicep emits only under the
 *     2.0 languageVersion codegen. The repo does not currently compile that way
 *     — the committed control fixture is real output and uses the resourceId
 *     form — but if it ever does, this detector needs a symbolic-name arm.
 * Naming these is the point: a guard that implies coverage it does not have is
 * the failure mode this whole file exists to avoid.
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

/**
 * Bicep entrypoints whose full compiled closure is scanned.
 *
 * BOTH deployed subscription-scope entrypoints are here (#3716). `main.bicep` is
 * what `deploy-fiab-commercial.yml` applies; `deploy/bicep/gov/main.bicep` is
 * what `deploy-gov.yml` applies. Leaving the Gov entrypoint out meant the Gov
 * deploy path had NO protection against this class at all, which is a
 * cloud-parity violation as well as a coverage gap.
 */
export const ENTRYPOINTS = ['platform/fiab/bicep/main.bicep', 'deploy/bicep/gov/main.bicep'];

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
 * The template's `variables` reduced to substitutable ARM expression text.
 *
 * Only STRING variables are usable: an object/array variable cannot appear
 * inside an id expression, and splicing its JSON into the body blob would be
 * meaningless. ARM's `copy` key inside `variables` is a loop declaration, not a
 * scalar, so it is skipped too.
 *
 * @param {Record<string, any>} tmpl a compiled ARM template (or nested template)
 * @returns {Record<string, string>} variable name → inner expression text
 */
export function variableExpansions(tmpl) {
  const vars = tmpl?.variables;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(vars)) {
    if (name === 'copy') continue;
    if (typeof value !== 'string') continue;
    const inner = armExprInner(value);
    if (inner != null) out[name] = inner;
  }
  return out;
}

const VARIABLE_REF = /variables\('([^']+)'\)/g;

/** Refuse to grow a blob without bound if a variable map is somehow cyclic. */
const EXPANSION_LENGTH_CAP = 8 * 1024 * 1024;

/**
 * Substitute `variables('x')` with x's expression text, repeatedly, so that a
 * hoisted id compares equal to the id built from the resource's own type/name.
 *
 * Bounded on both passes and length: an ARM template cannot legally contain a
 * variable cycle, but this must not hang if one is ever constructed.
 *
 * @param {string} text
 * @param {Record<string, string>} expansions
 * @param {number} [maxPasses]
 * @returns {string}
 */
export function expandVariables(text, expansions, maxPasses = 8) {
  if (typeof text !== 'string' || !text.includes("variables('")) return text;
  let current = text;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    const next = current.replace(VARIABLE_REF, (whole, name) => {
      const replacement = expansions[name];
      if (replacement === undefined) return whole;
      changed = true;
      return replacement;
    });
    if (!changed) return current;
    if (next.length > EXPANSION_LENGTH_CAP) return next;
    current = next;
  }
  return current;
}

/**
 * Does this resource's own body `reference()` its own id?
 *
 * The body is serialized and searched for the literal `reference(<selfId>`.
 * bicep emits ARM expressions without incidental whitespace, so an exact
 * substring match is both sufficient and precise; a looser match (e.g. "type
 * and name appear somewhere") would flag every legitimate sibling reference.
 *
 * The comparison runs twice: once on the literal codegen, and once with the
 * template's `variables` expanded on BOTH sides (#3716 — one `var` of
 * indirection defeated the literal-only form). Expanding both sides keeps a
 * legitimate cross-resource reference from matching.
 *
 * @param {Record<string, any>} r
 * @param {Record<string, string>} [expansions] the template's variable map
 * @returns {{selfId: string, via: 'literal'|'variable-expansion'}|null}
 */
export function selfReference(r, expansions = {}) {
  if (!r || typeof r !== 'object') return null;
  // `dependsOn` is excluded: bicep emits the parent's id there for a scoped
  // child, which is a normal ordering edge and not the defect. The cycle is
  // created by READING the value, i.e. `reference(...)`.
  const { dependsOn: _ignored, ...body } = r;
  const blob = JSON.stringify(body);
  const expandedBlob = expandVariables(blob, expansions);
  for (const selfId of selfIdExpressions(r)) {
    if (blob.includes(`reference(${selfId}`)) return { selfId, via: 'literal' };
    const expandedSelfId = expandVariables(selfId, expansions);
    if (expandedBlob.includes(`reference(${expandedSelfId}`)) {
      return { selfId: expandedSelfId, via: 'variable-expansion' };
    }
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
 * Each template level carries its OWN `variables` map, so the expansion used
 * for a nested resource is the nested template's — never the parent's.
 *
 * @param {Record<string, any>} tmpl
 * @param {string} where human-readable path, e.g. `main.json/adminPlane/registry`
 * @param {{resources: number, templates: number}} stats
 * @param {Array<{where: string, type: string, name: unknown, selfId: string, via: string}>} out
 */
export function walkTemplate(tmpl, where, stats, out) {
  if (!tmpl || typeof tmpl !== 'object') return;
  stats.templates += 1;
  const res = tmpl.resources;
  if (!res) return;
  const expansions = variableExpansions(tmpl);
  const entries = Array.isArray(res)
    ? res.map((r, i) => [String(i), r])
    : Object.entries(res);
  for (const [key, r] of entries) {
    if (!r || typeof r !== 'object') continue;
    stats.resources += 1;
    const hit = selfReference(r, expansions);
    if (hit) {
      out.push({ where: `${where}/${key}`, type: r.type, name: r.name, selfId: hit.selfId, via: hit.via });
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

/**
 * POSITIVE control for the #3716 evasion: the SAME defect written through a
 * bicep `var`. Copied byte-for-byte from a real `az bicep build` of
 *
 *     var selfTagId = extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default')
 *     var existingAcrTags = reference(selfTagId, '2021-04-01', 'Full')
 *
 * The v1 detector reported ZERO findings here. It is the array `resources`
 * shape on purpose — the classic form, so the two positive controls between
 * them cover both codegen shapes.
 */
export const VAR_INDIRECT_CONTROL_TEMPLATE = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  variables: {
    selfTagId:
      "[extensionResourceId(resourceId('Microsoft.ContainerRegistry/registries', parameters('acrName')), 'Microsoft.Resources/tags', 'default')]",
  },
  resources: [
    {
      type: 'Microsoft.ContainerRegistry/registries',
      apiVersion: '2025-04-01',
      name: "[parameters('acrName')]",
      location: "[resourceGroup().location]",
      sku: { name: 'Basic' },
    },
    {
      type: 'Microsoft.Resources/tags',
      apiVersion: '2021-04-01',
      scope: "[resourceId('Microsoft.ContainerRegistry/registries', parameters('acrName'))]",
      name: 'default',
      properties: {
        tags: "[union(coalesce(tryGet(tryGet(reference(variables('selfTagId'), '2021-04-01', 'Full'), 'properties'), 'tags'), createObject()), parameters('complianceTags'))]",
      },
      dependsOn: ["[resourceId('Microsoft.ContainerRegistry/registries', parameters('acrName'))]"],
    },
  ],
};

/**
 * NEGATIVE control for the #3716 expansion: the same var-indirected shape
 * reading a DIFFERENT resource's tags. Also real `az bicep build` output.
 *
 * This is the control that stops the fix from becoming a worse bug than the
 * gap: an expansion pass that made every hoisted id look like a self-id would
 * flag legitimate cross-resource reads and get the guard switched off.
 */
export const VAR_INDIRECT_NEGATIVE_CONTROL_TEMPLATE = {
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  variables: {
    otherTagId:
      "[extensionResourceId(resourceId('Microsoft.Storage/storageAccounts', parameters('saName')), 'Microsoft.Resources/tags', 'default')]",
  },
  resources: [
    {
      type: 'Microsoft.Resources/tags',
      apiVersion: '2021-04-01',
      scope: "[resourceId('Microsoft.ContainerRegistry/registries', parameters('acrName'))]",
      name: 'default',
      properties: {
        tags: "[coalesce(tryGet(tryGet(reference(variables('otherTagId'), '2021-04-01', 'Full'), 'properties'), 'tags'), createObject())]",
      },
      dependsOn: [
        "[resourceId('Microsoft.ContainerRegistry/registries', parameters('acrName'))]",
        "[resourceId('Microsoft.Storage/storageAccounts', parameters('saName'))]",
      ],
    },
  ],
};

/** @returns {string[]} failure messages from the embedded controls */
export function runEmbeddedControls() {
  const problems = [];

  /** @type {Array<[string, Record<string, any>, number, string]>} */
  const controls = [
    [
      'POSITIVE',
      CONTROL_TEMPLATE,
      1,
      'the #3691 fixture (literal extensionResourceId in the resource body)',
    ],
    [
      'POSITIVE (var-indirected, #3716)',
      VAR_INDIRECT_CONTROL_TEMPLATE,
      1,
      'the #3691 defect hoisted into a bicep `var` — the evasion the first version of this guard cleared',
    ],
    [
      'NEGATIVE',
      NEGATIVE_CONTROL_TEMPLATE,
      0,
      'a literal reference to a DIFFERENT resource',
    ],
    [
      'NEGATIVE (var-indirected, #3716)',
      VAR_INDIRECT_NEGATIVE_CONTROL_TEMPLATE,
      0,
      'a var-hoisted reference to a DIFFERENT resource',
    ],
  ];

  for (const [label, template, expected, described] of controls) {
    const out = [];
    walkTemplate(template, `embedded-${label}-control`, { resources: 0, templates: 0 }, out);
    if (out.length === expected) continue;
    problems.push(
      `EMBEDDED ${label} CONTROL FAILED: the detector found ${out.length} self-reference(s) in ${described}, expected exactly ${expected}.` +
        (expected === 0
          ? '\n  A detector that fires on legitimate cross-resource references would have to be switched off, which is how guards die.'
          : '\n  The detector is broken, so a green result on the real templates would mean nothing.'),
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
  log(
    'embedded controls OK — the #3691 fixture and its var-indirected form (#3716) are both detected; ' +
      'neither cross-resource fixture is.',
  );

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
          f.via === 'variable-expansion'
            ? '  found:   after expanding the template\'s `variables` — the id is hoisted into a bicep `var`,\n' +
              '           so the body reads `reference(variables(...))`. That is the same defect, not a different one.'
            : '  found:   in the literal compiled expression.',
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
