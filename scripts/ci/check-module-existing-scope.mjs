#!/usr/bin/env node
/**
 * check-module-existing-scope.mjs — teeth for the defect class that took the
 * Commercial estate down TWICE on 2026-08-13 (issue #3333, PR #3329).
 *
 * ── WHAT BROKE ──────────────────────────────────────────────────────────────
 *
 *   `integration/transform-runner-aca.bicep` declared the lake as
 *
 *       resource artifactsStorage 'Microsoft.Storage/storageAccounts@…' existing = if (…) {
 *         name: artifactsStorageAccountName          // <- no `scope:`
 *       }
 *
 *   An `existing` reference with no `scope:` resolves in the resource group the
 *   DEPLOYMENT is running in. That module deploys a Container App, so it is
 *   invoked at the APP's resource group. The lake is not there — it lives in the
 *   DLZ resource group, and on a dlz-attach estate in another SUBSCRIPTION.
 *   ARM answered, and failed the ENTIRE deployment:
 *
 *       transform-runner | DeploymentFailed
 *         -> ResourceNotFound: The Resource 'Microsoft.Storage/storageAccounts/
 *            saloomdefault…' under resource group 'rg-csa-loom-admin-…' was not
 *            found.
 *
 *   Six of the seven lake consumers already used the correct pattern — the
 *   dereference lives in a DEDICATED module invoked with an explicit
 *   `scope: resourceGroup(<lakeRg>)`. `data-plane/s3-gateway-lake-rbac.bicep`
 *   lines 7-16 describe this exact failure mode, name both topologies it hits,
 *   and prescribe the fix. THE LESSON WAS WRITTEN DOWN; THE GUARD WAS NOT. This
 *   is that guard.
 *
 * ── THE RULE, AND WHY IT IS SHAPED THIS WAY ─────────────────────────────────
 *
 *   "Unscoped `existing` inside a module" is NOT the rule. 62 of the 63
 *   `existing` declarations under modules/** are unscoped and the overwhelming
 *   majority are correct: a module invoked with `scope: resourceGroup(X)` is
 *   ALREADY at the right resource group, and an unscoped `existing` inside it is
 *   precisely how the six adopters work. A rule keyed to the token alone would
 *   flag all 62, be muted within a week, and protect nothing.
 *
 *   What actually distinguishes the defect is a CONTRADICTION the repo's own
 *   bicep states out loud, and it needs both halves to see it:
 *
 *     RESIDENCY  the orchestrator passes value V to a module invoked at
 *                `scope: S`, and that module uses V as the `name:` of an
 *                unscoped `existing`. The orchestrator has thereby ASSERTED
 *                "the resource named V lives in S".
 *                  e.g. `loomStorageAccount` -> `resourceGroup(loomDlzRg)`,
 *                  asserted by s3GatewayLakeRbac / labelRbacGrants /
 *                  azureConnectionsRbac / orgVisualsRbac / aasShim.
 *
 *     CONFLICT   the SAME orchestrator passes the SAME value V to another
 *                module invoked at a DIFFERENT scope T, and that module also
 *                dereferences it through an unscoped `existing`. That module
 *                will look for V in T. The orchestrator has already said V is
 *                in S. One of the two is wrong, and ARM resolves the argument
 *                by failing the deployment.
 *
 *   Both halves are read out of the same file, so the finding is proved by the
 *   source rather than inferred from naming. Nothing here consults Azure.
 *
 *   DELIBERATELY NOT CLAIMED: that a flagged dereference fails TODAY. Several
 *   are dormant because the only consumer of the `existing` symbol sits behind a
 *   condition the caller currently sets false (`assignLakeRole: false`). That is
 *   not a fix, it is a loaded gun — transform-runner was dormant for exactly as
 *   long as `dbtRunnerImageReady` stayed false, and flipping one boolean took
 *   the estate down twice. The finding is "this module looks for a resource in
 *   the wrong resource group", which is true whether or not a flag currently
 *   spares it.
 *
 * ── SELF-DEFENCE (this guard must not become what it guards against) ────────
 *
 *   1. EMBEDDED CONTROL. The analyzer is run first against an in-memory tree
 *      carrying the REAL pre-#3329 transform-runner code. If it cannot find
 *      that known-true defect, it EXITS NON-ZERO instead of reporting a pass.
 *      Once the live population reaches zero, "fail on an empty population"
 *      protects nothing — only a control does.
 *   2. EMBEDDED NEGATIVE CONTROL. The same tree carries the correct, adopted
 *      shape (the scoped `*-lake-rbac.bicep` module). If the analyzer flags THAT,
 *      the rule has become the token-keyed rule it was written to avoid, and the
 *      guard fails. A rule that flags the fix is worse than no rule.
 *   3. POPULATION FLOOR. If discovery finds no bicep, no modules, or no
 *      `existing` declarations at all, that is a broken scan, not a clean tree.
 *   4. UNKNOWN IS NOT NEGATIVE. A dereference whose name resolves only to a bare
 *      OBJECT parameter cannot be matched against any call site, so it is a hard
 *      error rather than a quiet pass. Missing bicep's `.?` operator hid
 *      loom-risingwave-aca.bicep exactly this way during development.
 *   5. THE REGISTER CANNOT ROT. `KNOWN_DORMANT` carries the pre-existing
 *      instances found when this guard first ran (#3357). An entry the analyzer
 *      no longer reproduces FAILS the build, so the register shrinks with the
 *      debt and can never outlive it — and every green run prints the carried
 *      items with the measured reason each is dormant.
 *   6. Nothing is wrapped in `|| true`; no stream is discarded; the exit status
 *      is the verdict.
 *
 * PROVEN BY MUTATION, not by assertion (2026-08-13, all four recorded in the PR):
 *   - revert #3329's module change              -> RED at transform-runner-aca.bicep:70
 *   - drop `scope:` from an ADOPTER's call site  -> RED at transform-runner-lake-rbac.bicep:50
 *   - drop `.?` support from resolveNameSource   -> RED (unresolved binding)
 *   - make pass 2 ignore the call-site scope     -> RED (negative control flagged the fix)
 *
 * USAGE
 *   node scripts/ci/check-module-existing-scope.mjs
 *   node scripts/ci/check-module-existing-scope.mjs --list   # full inventory
 *
 * Tests: node --test scripts/ci/__tests__/module-existing-scope.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const BICEP_ROOT = path.join(REPO_ROOT, 'platform', 'fiab', 'bicep');

/**
 * Resource types that can legitimately live in another resource group or
 * subscription from the app that consumes them, and that Loom actually places
 * outside the admin RG on at least one supported topology. The scope of the
 * guard, per issue #3333.
 *
 * Sub-resource types (`…/blobServices/containers`) are included because they
 * inherit the parent's residency exactly — org-visuals-rbac.bicep took a
 * ParentResourceNotFound on run 31435481880 for precisely that reason.
 */
export const CROSS_RG_TYPES = new Set([
  'Microsoft.Storage/storageAccounts',
  'Microsoft.Storage/storageAccounts/blobServices',
  'Microsoft.Storage/storageAccounts/blobServices/containers',
  'Microsoft.KeyVault/vaults',
  'Microsoft.ContainerRegistry/registries',
  'Microsoft.Synapse/workspaces',
  'Microsoft.Databricks/workspaces',
  'Microsoft.EventHub/namespaces',
  'Microsoft.Kusto/clusters',
  'Microsoft.DocumentDB/databaseAccounts',
  'Microsoft.Search/searchServices',
  'Microsoft.OperationalInsights/workspaces',
  'Microsoft.CognitiveServices/accounts',
  'Microsoft.DataFactory/factories',
  'Microsoft.Sql/servers',
]);

/**
 * PRE-EXISTING instances, registered on 2026-08-13 when this guard first ran.
 * Tracked in #3357.
 *
 * All three are the SAME defect as transform-runner and are NOT fixed here —
 * #3333 asks for the guard, and rewriting three unrelated data-plane modules in
 * the guard's own PR is how a mechanical change becomes an unreviewable one.
 * They are recorded item by item, with the MEASURED reason each is currently
 * dormant, and tracked separately.
 *
 * DORMANT IS NOT FIXED. In every case the only consumer of the `existing`
 * symbol is a role assignment gated on `assignLakeRole`, and every call site in
 * admin-plane/main.bicep passes `assignLakeRole: false`. That is one boolean
 * away from the outage: transform-runner was dormant in exactly this way until
 * `dbtRunnerImageReady` flipped to true, and it then failed two full Commercial
 * deploys. The correct fix for all three is the six-times-adopted one — move
 * the grant into a dedicated module invoked with `scope: resourceGroup(<lakeRg>)`,
 * as `risingwaveLakeRbac` already does for RisingWave's grant.
 *
 * THIS REGISTER CANNOT ROT. An entry that the analyzer no longer reproduces is
 * a HARD FAILURE, not a silent pass (see `staleRegistrations`) — so it shrinks
 * as the debt is paid and can never outlive it. It is keyed on
 * (module, symbol, binding), never on a line number, so it neither drifts with
 * an unrelated edit nor covers a DIFFERENT dereference added to the same file.
 */
export const KNOWN_DORMANT = [
  {
    module: 'modules/data-plane/duckdb-aca.bicep',
    symbol: 'lake',
    binding: 'duckdbConfig.lakeStorageAccountName',
    dormantBecause: "admin-plane/main.bicep:6244 passes assignLakeRole: false, so grantLakeRole is never true",
    issue: '#3357',
  },
  {
    module: 'modules/data-plane/iceberg-catalog-aca.bicep',
    symbol: 'lake',
    binding: 'catalogConfig.lakeStorageAccountName',
    dormantBecause:
      "admin-plane/main.bicep:6298 passes assignLakeRole: false; the `existing` itself is UNCONDITIONAL " +
      'and only its role assignment is gated, so this is the thinnest margin of the three',
    issue: '#3357',
  },
  {
    module: 'modules/data-plane/loom-risingwave-aca.bicep',
    symbol: 'lake',
    binding: 'risingwaveConfig.lakeStorageAccountName',
    dormantBecause:
      "admin-plane/main.bicep:6928 passes assignLakeRole: false and grants from risingwaveLakeRbac at " +
      'scope: resourceGroup(loomDlzRg) — the correct pattern is already in place, only the dead ' +
      'in-module dereference remains',
    issue: '#3357',
  },
];

const registrationKey = (f) => `${f.module}||${f.symbol}||${f.binding}`;

/** Split findings into NEW (must fail) and registered pre-existing debt. */
export function partitionFindings(findings, register = KNOWN_DORMANT) {
  const known = new Set(register.map(registrationKey));
  const fresh = [];
  const carried = [];
  for (const f of findings) (known.has(registrationKey(f)) ? carried : fresh).push(f);
  return { fresh, carried };
}

/**
 * Registered entries the analyzer no longer produces. Either the debt was paid
 * (delete the entry) or the matcher stopped seeing it (fix the matcher). Both
 * are failures: a register nobody prunes is how a ratchet becomes a mute button.
 */
export function staleRegistrations(findings, register = KNOWN_DORMANT) {
  const seen = new Set(findings.map(registrationKey));
  return register.filter((r) => !seen.has(registrationKey(r)));
}

// ── tiny bicep reader ───────────────────────────────────────────────────────

/** Strip `//` line comments while PRESERVING length, so line numbers stay true. */
export function blankComments(src) {
  return src.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** Net unclosed `{ [ (` in a line. */
function delta(text) {
  let n = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '[' || ch === '(') n += 1;
    else if (ch === '}' || ch === ']' || ch === ')') n -= 1;
  }
  return n;
}

/**
 * Brace-balanced body starting at `start`, returned as an array of
 * `{ line, text }`. Counting braces rather than a fixed line window is what
 * stops the reader running on into the NEXT declaration's `name:`.
 */
export function blockAt(lines, start) {
  let depth = 0;
  let opened = false;
  const body = [];
  for (let j = start; j < lines.length; j += 1) {
    body.push({ line: j + 1, text: lines[j] });
    depth += delta(lines[j]);
    if (!opened && lines[j].includes('{')) opened = true;
    if (opened && depth <= 0) break;
  }
  return body;
}

/**
 * The value of `key:` at `indent` spaces inside a block, joining continuation
 * lines until brackets balance. Depth-sensitive so a `name:` nested inside
 * `properties:` is never mistaken for the resource's own name.
 */
export function fieldAt(body, key, indent) {
  const re = new RegExp(`^ {${indent}}${key}\\s*:\\s*(.*)$`);
  for (let i = 0; i < body.length; i += 1) {
    const m = re.exec(body[i].text);
    if (!m) continue;
    let value = m[1].trim();
    let open = delta(value);
    for (let j = i + 1; j < body.length && open > 0; j += 1) {
      const t = body[j].text.trim();
      if (t === '') continue;
      value += ` ${t}`;
      open += delta(t);
    }
    return { value: value.trim(), line: body[i].line };
  }
  return null;
}

/** Whitespace- and quote-normalised, for comparison only. */
export const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/"/g, "'");

const RESOURCE_RE = /^resource\s+([A-Za-z_]\w*)\s+'([^'@]+)@[^']*'\s+(existing\s+)?=\s*(?:if\s*\((.*?)\)\s*)?\{/;
const MODULE_RE = /^module\s+([A-Za-z_]\w*)\s+'([^']+)'\s*=\s*(?:\[[^\]]*\]\s*)?(?:if\s*\((.*?)\)\s*)?\{/;
const PARAM_RE = /^param\s+([A-Za-z_]\w*)\s/;
const VAR_RE = /^var\s+([A-Za-z_]\w*)\s*=\s*(.*)$/;

/** Parse one .bicep source into the facts this guard reasons over. */
export function parseBicep(source, file = '<memory>') {
  const lines = blankComments(source).split(/\r?\n/);
  const params = new Set();
  const paramTypes = new Map();
  const vars = new Map();
  const resources = [];
  const modules = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const text = raw.trimStart();

    const p = PARAM_RE.exec(text);
    if (p) {
      params.add(p[1]);
      paramTypes.set(p[1], (/^param\s+\w+\s+(\w+)/.exec(text) ?? [])[1] ?? 'unknown');
      continue;
    }

    const v = VAR_RE.exec(text);
    if (v) {
      let value = v[2].trim();
      let open = delta(value);
      for (let j = i + 1; j < lines.length && open > 0; j += 1) {
        const t = lines[j].trim();
        if (t === '') continue;
        value += ` ${t}`;
        open += delta(t);
      }
      vars.set(v[1], value.trim());
      continue;
    }

    const r = RESOURCE_RE.exec(text);
    if (r) {
      const body = blockAt(lines, i);
      resources.push({
        symbol: r[1],
        type: r[2],
        existing: Boolean(r[3]),
        condition: r[4] ? r[4].trim() : null,
        line: i + 1,
        name: fieldAt(body, 'name', 2)?.value ?? null,
        scope: fieldAt(body, 'scope', 2)?.value ?? null,
      });
      continue;
    }

    const m = MODULE_RE.exec(text);
    if (m) {
      const body = blockAt(lines, i);
      modules.push({
        symbol: m[1],
        target: m[2],
        condition: m[3] ? m[3].trim() : null,
        line: i + 1,
        scope: fieldAt(body, 'scope', 2)?.value ?? null,
        params: paramBindings(body),
      });
    }
  }

  return { file, params, paramTypes, vars, resources, modules };
}

/**
 * `params: { … }` flattened to `key` and `key.subkey` -> value expression.
 *
 * The one-level nesting is load-bearing, not gold-plating: duckdb / iceberg /
 * risingwave / trino all take a single object param (`duckdbConfig`) and the
 * lake account name arrives as a PROPERTY of it. A reader that only saw
 * top-level keys would report those four modules as unreachable and print a
 * clean tree.
 */
export function paramBindings(body) {
  const out = new Map();
  const start = body.findIndex((b) => /^ {2}params\s*:\s*\{/.test(b.text));
  if (start < 0) return out;

  let depth = 0;
  let prefix = null;
  for (let i = start; i < body.length; i += 1) {
    const text = body[i].text;
    if (i > start) {
      const kv = /^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(text);
      if (kv) {
        const key = kv[1];
        let value = kv[2].trim();
        if (value === '{') {
          if (depth === 1) prefix = key;
        } else {
          let open = delta(value);
          for (let j = i + 1; j < body.length && open > 0; j += 1) {
            const t = body[j].text.trim();
            if (t === '') continue;
            value += ` ${t}`;
            open += delta(t);
          }
          const full = depth === 1 ? key : prefix ? `${prefix}.${key}` : key;
          if (depth <= 2) out.set(full, value.trim());
        }
      }
    }
    depth += delta(text);
    if (depth <= 1 && i > start) prefix = null;
    if (depth <= 0) break;
  }
  return out;
}

/**
 * Which module PARAM (and, for an object param, which property) supplies the
 * `name:` of a declaration — following `var` indirection.
 *
 * Returns `{ param, property }` or null when the name is not caller-supplied
 * (a literal, or derived from a locally-declared resource). A name the module
 * computes itself carries no cross-RG risk: the caller cannot point it at a
 * foreign resource.
 *
 * The property regex MUST accept bicep's safe-dereference `.?`. It did not in
 * the first cut, and the consequence is the exact failure mode this repo keeps
 * paying for: `var lakeStorageAccountName = string(risingwaveConfig.?lakeStorageAccountName ?? '')`
 * fell through to the bare-identifier branch, resolved to the OBJECT param
 * `risingwaveConfig`, found no call-site binding under that key, and the module
 * silently read as clean. An unresolvable binding is now a hard error (see
 * `UNRESOLVED_OBJECT_PARAM`) rather than a quiet pass.
 */
export function resolveNameSource(nameExpr, { params, vars }, depth = 0) {
  if (!nameExpr || depth > 6) return null;

  // `someObjectParam.someProperty` and `someObjectParam.?someProperty`
  for (const m of nameExpr.matchAll(/\b([A-Za-z_]\w*)\s*\.\??\s*([A-Za-z_]\w*)/g)) {
    if (params.has(m[1])) return { param: m[1], property: m[2] };
  }
  for (const m of nameExpr.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const id = m[1];
    if (params.has(id)) return { param: id, property: null };
  }
  for (const m of nameExpr.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const id = m[1];
    if (vars.has(id)) {
      const hit = resolveNameSource(vars.get(id), { params, vars }, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The unscoped, caller-named, cross-RG-capable `existing` decls of one module. */
export function derefsOf(parsed) {
  const out = [];
  for (const r of parsed.resources) {
    if (!r.existing) continue;
    if (!CROSS_RG_TYPES.has(r.type)) continue;
    if (r.scope) continue; // explicitly scoped — the module said where it lives
    const src = resolveNameSource(r.name, parsed);
    if (!src) continue; // name is not caller-supplied
    // A binding that resolves to a bare OBJECT param means the reader could not
    // work out WHICH property carries the name. Call sites pass object params as
    // literals, so the lookup would silently miss and the module would read as
    // clean. Record it as unresolved; the driver fails on it rather than
    // reporting an absence it never established.
    const unresolved = src.property === null && parsed.paramTypes?.get(src.param) === 'object';
    out.push({
      symbol: r.symbol,
      type: r.type,
      line: r.line,
      condition: r.condition,
      binding: src.property ? `${src.param}.${src.property}` : src.param,
      unresolved,
    });
  }
  return out;
}

// ── the tree ────────────────────────────────────────────────────────────────

/** Every .bicep under `root`, as relPath -> source. Used for the real scan. */
export function loadTree(root = BICEP_ROOT) {
  const tree = new Map();
  if (!fs.existsSync(root)) return tree;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.bicep')) {
        tree.set(path.relative(root, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8'));
      }
    }
  };
  walk(root);
  return tree;
}

/** Resolve a module `target` path relative to the calling file. */
export function resolveTarget(fromRel, target) {
  if (!target.endsWith('.bicep')) return null; // registry ref (br:/ts:) — not ours
  const dir = path.posix.dirname(fromRel);
  return path.posix.normalize(path.posix.join(dir, target));
}

/** A module call with no `scope:` deploys at the caller's own scope. */
const LOCAL_SCOPE = '<caller-scope>';
const scopeKey = (s) => (s ? norm(s) : LOCAL_SCOPE);

/**
 * The whole analysis. Pure over a `Map<relPath, source>` so the embedded
 * control runs through the IDENTICAL code path as the repository scan — a
 * control that exercised a different matcher would prove nothing.
 */
export function analyze(tree, { moduleRoot = 'modules/' } = {}) {
  const parsed = new Map();
  for (const [rel, src] of tree) parsed.set(rel, parseBicep(src, rel));

  const derefs = new Map(); // relPath -> deref[]
  const unresolved = [];
  for (const [rel, p] of parsed) {
    if (!rel.startsWith(moduleRoot)) continue;
    const d = derefsOf(p);
    if (d.length > 0) derefs.set(rel, d);
    for (const x of d) if (x.unresolved) unresolved.push({ module: rel, ...x });
  }

  // Pass 1 — RESIDENCY, per orchestrator file. A value passed at an explicit
  // scope to a module that uses it as an unscoped `existing` name is the
  // orchestrator asserting where that resource lives.
  const residency = new Map(); // callerRel -> Map(normValue -> { scope, evidence[] })
  const calls = [];
  for (const [rel, p] of parsed) {
    for (const call of p.modules) {
      const targetRel = resolveTarget(rel, call.target);
      if (!targetRel || !parsed.has(targetRel)) continue;
      const targetDerefs = derefs.get(targetRel) ?? [];
      if (targetDerefs.length === 0) continue;
      calls.push({ caller: rel, call, targetRel, targetDerefs });

      if (!call.scope) continue; // caller-scope calls assert nothing
      for (const d of targetDerefs) {
        const value = call.params.get(d.binding);
        if (!value) continue;
        if (/^''$/.test(value.trim())) continue; // an empty string names nothing
        if (!residency.has(rel)) residency.set(rel, new Map());
        const bag = residency.get(rel);
        const k = norm(value);
        if (!bag.has(k)) bag.set(k, { scope: scopeKey(call.scope), value, evidence: new Set() });
        bag.get(k).evidence.add(`${rel}:${call.line} ${call.symbol} -> ${targetRel} (${d.binding})`);
      }
    }
  }

  // Pass 2 — CONFLICT.
  const findings = [];
  for (const { caller, call, targetRel, targetDerefs } of calls) {
    const bag = residency.get(caller);
    if (!bag) continue;
    for (const d of targetDerefs) {
      const value = call.params.get(d.binding);
      if (!value) continue;
      const known = bag.get(norm(value));
      if (!known) continue;
      const here = scopeKey(call.scope);
      if (here === known.scope) continue;
      findings.push({
        module: targetRel,
        moduleLine: d.line,
        symbol: d.symbol,
        type: d.type,
        binding: d.binding,
        condition: d.condition,
        caller,
        callerLine: call.line,
        callSymbol: call.symbol,
        value: known.value,
        declaredScope: known.scope,
        usedScope: here,
        evidence: [...known.evidence],
      });
    }
  }

  return { parsed, derefs, residency, calls, findings, unresolved };
}

// ── embedded controls ───────────────────────────────────────────────────────
//
// POSITIVE: the real pre-#3329 shape, reduced to what the rule reads. If the
// analyzer stops finding this, it has drifted off the language it judges and a
// pass would mean nothing.
// NEGATIVE: the adopted fix, in the same tree. If the analyzer flags THAT, the
// rule has collapsed into "unscoped existing == bad", which would flag the six
// modules that are already correct.

export const CONTROL_TREE = new Map([
  [
    'modules/admin-plane/main.bicep',
    [
      "param loomDlzRg string",
      "param loomStorageAccount string",
      "",
      "module s3GatewayLakeRbac '../data-plane/s3-gateway-lake-rbac.bicep' = if (loomStorageGrantable) {",
      "  name: 's3-gateway-lake-rbac'",
      "  scope: resourceGroup(loomDlzRg)",
      "  params: {",
      "    storageAccountName: loomStorageAccount",
      "    principalId: identity.outputs.uamiConsolePrincipalId",
      "  }",
      "}",
      "",
      "module transformRunner '../integration/transform-runner-aca.bicep' = if (transformRunnerActive) {",
      "  name: 'transform-runner'",
      "  params: {",
      "    location: location",
      "    uamiPrincipalId: identity.outputs.uamiConsolePrincipalId",
      "    artifactsStorageAccountName: loomStorageAccount",
      "  }",
      "}",
      "",
      "module transformRunnerLakeRbac '../data-plane/transform-runner-lake-rbac.bicep' = if (loomStorageGrantable) {",
      "  name: 'loom-transform-runner-lake-rbac'",
      "  scope: resourceGroup(loomDlzRg)",
      "  params: {",
      "    storageAccountName: loomStorageAccount",
      "    principalId: identity.outputs.uamiConsolePrincipalId",
      "  }",
      "}",
      "",
    ].join('\n'),
  ],
  [
    // NEGATIVE control — the adopted, correct shape (s3-gateway-lake-rbac.bicep).
    'modules/data-plane/s3-gateway-lake-rbac.bicep',
    [
      "targetScope = 'resourceGroup'",
      "param storageAccountName string",
      "param principalId string",
      "",
      "resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {",
      "  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName",
      "}",
      "",
      "resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {",
      "  name: guid(lake.id, principalId, '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')",
      "  scope: lake",
      "  properties: {",
      "    principalId: principalId",
      "  }",
      "}",
      "",
    ].join('\n'),
  ],
  [
    // NEGATIVE control — the module #3329 created, same shape as the six adopters.
    'modules/data-plane/transform-runner-lake-rbac.bicep',
    [
      "targetScope = 'resourceGroup'",
      "param storageAccountName string",
      "param principalId string",
      "",
      "resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {",
      "  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName",
      "}",
      "",
      "resource lakeWriteRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {",
      "  name: guid(lake.id, principalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')",
      "  scope: lake",
      "  properties: {",
      "    principalId: principalId",
      "  }",
      "}",
      "",
    ].join('\n'),
  ],
  [
    // POSITIVE control — the real pre-#3329 transform-runner-aca.bicep.
    'modules/integration/transform-runner-aca.bicep',
    [
      "param location string",
      "param uamiPrincipalId string = ''",
      "param artifactsStorageAccountName string = ''",
      "",
      "var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'",
      "var grantArtifactsAccess = !empty(artifactsStorageAccountName) && !empty(uamiPrincipalId)",
      "",
      "resource artifactsStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (grantArtifactsAccess) {",
      "  name: empty(artifactsStorageAccountName) ? 'placeholderaccount' : artifactsStorageAccountName",
      "}",
      "",
      "resource artifactsRbac 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantArtifactsAccess) {",
      "  name: guid(artifactsStorage.id, uamiPrincipalId, storageBlobDataContributorRoleId)",
      "  scope: artifactsStorage",
      "  properties: {",
      "    principalId: uamiPrincipalId",
      "  }",
      "}",
      "",
      "resource transformRunner 'Microsoft.App/containerApps@2025-02-02-preview' = {",
      "  name: 'loom-transform-runner'",
      "  location: location",
      "}",
      "",
    ].join('\n'),
  ],
]);

export const CONTROL_EXPECT = {
  module: 'modules/integration/transform-runner-aca.bicep',
  binding: 'artifactsStorageAccountName',
};

/** Run both controls. Returns a failure message, or null when both hold. */
export function verifyControls() {
  const { findings, derefs } = analyze(CONTROL_TREE);

  if (findings.length !== 1) {
    return (
      `the embedded POSITIVE control expected exactly 1 finding, got ${findings.length}` +
      `${findings.length ? ` (${findings.map((f) => `${f.module}:${f.moduleLine}`).join(', ')})` : ''}. ` +
      'The matcher no longer recognises the real pre-#3329 transform-runner defect, so a pass on the ' +
      'repository would mean nothing.'
    );
  }
  const f = findings[0];
  if (f.module !== CONTROL_EXPECT.module || f.binding !== CONTROL_EXPECT.binding) {
    return (
      `the embedded POSITIVE control matched the WRONG declaration: ${f.module}:${f.moduleLine} ` +
      `(${f.binding}), expected ${CONTROL_EXPECT.module} (${CONTROL_EXPECT.binding}).`
    );
  }
  // The negative controls must still be SEEN (they carry unscoped `existing`
  // declarations) and must NOT be flagged. "Not seen" and "seen and cleared"
  // are different verdicts, and only the second one proves anything.
  for (const adopter of [
    'modules/data-plane/s3-gateway-lake-rbac.bicep',
    'modules/data-plane/transform-runner-lake-rbac.bicep',
  ]) {
    if (!derefs.has(adopter)) {
      return (
        `the embedded NEGATIVE control ${adopter} was not even inspected — the reader stopped seeing ` +
        'the adopted shape, so it can no longer prove the rule discriminates fix from defect.'
      );
    }
    if (findings.some((x) => x.module === adopter)) {
      return (
        `the embedded NEGATIVE control ${adopter} was FLAGGED. That module is the adopted fix; a rule ` +
        'that flags it has collapsed into "unscoped existing == bad" and would condemn the six modules ' +
        'that are already correct.'
      );
    }
  }
  return null;
}

// ── driver ──────────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const controlFailure = verifyControls();
  if (controlFailure) {
    process.stderr.write(`::error::module-existing-scope: ${controlFailure}\n`);
    process.stderr.write(
      'Refusing to report a pass on a matcher that cannot find a known-true defect (#3333).\n',
    );
    process.exit(1);
  }

  const tree = loadTree();
  if (tree.size === 0) {
    process.stderr.write(
      `::error::module-existing-scope: discovered ZERO .bicep files under ${path.relative(REPO_ROOT, BICEP_ROOT)}. ` +
        'Discovery is broken, not clean.\n',
    );
    process.exit(1);
  }

  const { parsed, derefs, residency, calls, findings, unresolved } = analyze(tree);

  const existingCount = [...parsed.values()].reduce(
    (n, p) => n + p.resources.filter((r) => r.existing).length,
    0,
  );
  if (existingCount === 0) {
    process.stderr.write(
      '::error::module-existing-scope: parsed 0 `existing` declarations across ' +
        `${tree.size} .bicep file(s). The reader has drifted off bicep syntax.\n`,
    );
    process.exit(1);
  }
  if (calls.length === 0) {
    process.stderr.write(
      '::error::module-existing-scope: resolved 0 module calls into a module that dereferences an ' +
        'existing cross-RG resource. Call-site resolution is broken, not clean.\n',
    );
    process.exit(1);
  }
  if (unresolved.length > 0) {
    // UNKNOWN must never be reported as NEGATIVE. A binding that resolves only
    // to a bare object param cannot be matched against any call site, so this
    // guard would return "no conflict" without having looked at one.
    process.stderr.write(
      `::error::module-existing-scope: ${unresolved.length} dereference(s) name an \`existing\` from a ` +
        'bare OBJECT parameter — the reader could not determine which property carries the name, so it ' +
        'cannot match them against a call site. That is UNKNOWN, not clean. Extend resolveNameSource() ' +
        'to cover the expression shape rather than letting it read as a pass.\n',
    );
    for (const u of unresolved) {
      process.stderr.write(
        `::error file=platform/fiab/bicep/${u.module},line=${u.line}::` +
          `\`${u.symbol}\` resolves only to object param \`${u.binding}\`\n`,
      );
    }
    process.exit(1);
  }

  if (process.argv.includes('--list')) {
    process.stdout.write(`# unscoped, caller-named, cross-RG-capable \`existing\` declarations\n`);
    for (const [rel, ds] of [...derefs].sort()) {
      for (const d of ds) {
        process.stdout.write(
          `  ${rel}:${d.line}  ${d.symbol} ${d.type}  <- ${d.binding}` +
            `${d.condition ? `  if (${d.condition})` : ''}\n`,
        );
      }
    }
    process.stdout.write('\n# residency asserted by the orchestrators\n');
    for (const [rel, bag] of [...residency].sort()) {
      for (const [, v] of bag) {
        process.stdout.write(`  ${rel}: ${v.value} lives in ${v.scope}\n`);
        for (const e of v.evidence) process.stdout.write(`      ${e}\n`);
      }
    }
    process.stdout.write('\n');
  }

  const { fresh, carried } = partitionFindings(findings);
  const stale = staleRegistrations(findings);

  const describe = (f) =>
    `\nplatform/fiab/bicep/${f.module}:${f.moduleLine}\n` +
    `  symbol      ${f.symbol}  (${f.type})\n` +
    `  named from  ${f.binding}${f.condition ? `   [gated on: ${f.condition}]` : ''}\n` +
    `  call site   ${f.caller}:${f.callerLine}  module ${f.callSymbol}  scope=${f.usedScope}\n` +
    `  value       ${f.value}\n` +
    `  residency   ${f.declaredScope}   asserted by:\n` +
    f.evidence.map((e) => `                ${e}\n`).join('');

  if (stale.length > 0) {
    // A register that outlives its debt is a mute button. Either the module was
    // fixed (delete the entry) or the matcher stopped seeing it (fix the
    // matcher); both must be resolved by a human, not absorbed silently.
    process.stderr.write(
      `::error::module-existing-scope: ${stale.length} KNOWN_DORMANT entr(y/ies) no longer reproduce. ` +
        'Either the dereference was fixed — delete the entry, the register must shrink with the debt — ' +
        'or the matcher stopped seeing it, which is the failure this guard exists to prevent. Not a pass ' +
        'either way.\n',
    );
    for (const s of stale) {
      process.stderr.write(`::error::  stale registration: ${s.module}  ${s.symbol}  <- ${s.binding}\n`);
    }
    process.exit(1);
  }

  if (fresh.length > 0) {
    process.stderr.write(
      `::error::module-existing-scope: ${fresh.length} NEW module dereference(s) look for a resource in a ` +
        'resource group the same orchestrator says it does not live in. This is the defect that failed two ' +
        'full Commercial deploys on 2026-08-13 (#3333, fixed for transform-runner by #3329). Move the ' +
        'dereference into a dedicated module invoked with an explicit `scope: resourceGroup(<rg>)`, as ' +
        'data-plane/s3-gateway-lake-rbac.bicep and data-plane/transform-runner-lake-rbac.bicep do.\n',
    );
    for (const f of fresh) {
      process.stderr.write(
        `::error file=platform/fiab/bicep/${f.module},line=${f.moduleLine}::` +
          `\`${f.symbol}\` (${f.type}) is an unscoped \`existing\` named from \`${f.binding}\`, ` +
          `so it resolves in the deployment's own resource group. ` +
          `${f.caller}:${f.callerLine} invokes this module as \`${f.callSymbol}\` at ${f.usedScope} ` +
          `while passing \`${f.value}\`, which that same file declares to live in ${f.declaredScope}.\n`,
      );
      process.stdout.write(describe(f));
    }
    process.stdout.write('\n');
    process.exit(1);
  }

  const derefCount = [...derefs.values()].reduce((n, d) => n + d.length, 0);
  process.stdout.write(
    'module-existing-scope OK — both embedded controls held; ' +
      `${tree.size} .bicep file(s), ${existingCount} \`existing\` declaration(s), ` +
      `${derefCount} unscoped caller-named cross-RG dereference(s) across ${derefs.size} module(s), ` +
      `${calls.length} resolved call site(s); no NEW module looks for a resource in a resource group its ` +
      'orchestrator says it does not live in.\n',
  );
  // A green run still states the outstanding debt out loud. Carried findings are
  // dormant, NOT fixed — printing them on every pass is what stops the register
  // becoming invisible.
  if (carried.length > 0) {
    process.stdout.write(
      `\nCARRIED (registered pre-existing, dormant NOT fixed) — ${carried.length}:\n`,
    );
    for (const f of carried) {
      const reg = KNOWN_DORMANT.find((r) => registrationKey(r) === registrationKey(f));
      process.stdout.write(
        `  platform/fiab/bicep/${f.module}:${f.moduleLine}  ${f.symbol} <- ${f.binding}  ${reg?.issue ?? ''}\n` +
          `      dormant because ${reg?.dormantBecause ?? 'unrecorded'}\n`,
      );
    }
    process.stdout.write('');
  }
}
