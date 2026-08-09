#!/usr/bin/env node
/**
 * GUARDRAIL: the data-plane roll registry must still describe what bicep
 * actually deploys — and apps that SHARE an image repository must all be in it.
 *
 * WHY THIS EXISTS
 *
 * scripts/ci/roll-plan.mjs rolls `loom-unity` and `iceberg-catalog` as one
 * atomic group because both Container Apps run the SAME `loom-unity` image
 * (admin-plane/main.bicep passes the loom-unity reference into
 * iceberg-catalog-aca.bicep). That grouping is derived from the registry's own
 * `repo` field, so the registry is internally consistent by construction — but
 * nothing yet proves the registry still matches BICEP.
 *
 * Two ways that silently breaks, both of which produce a roll that reports
 * success while leaving the estate inconsistent:
 *
 *   1. A THIRD app is deployed on the loom-unity image and nobody adds it to the
 *      registry. The roll then ships two of three. reconcile-policy.mjs
 *      `resolveRunningImageTags()` groups the live estate BY REPOSITORY and
 *      marks a repo running at two tags UNKNOWN — one `appImageTags` key cannot
 *      hold two values — and `decideDeployApps()` refuses to enable
 *      `deployAppsEnabled` while anything is unknown. So a forgotten third app
 *      does not merely lag: it freezes ENV/CONFIG reconciliation for the whole
 *      estate, and the next admin-plane deploy rewrites the pair back to the
 *      `?? 'v0.1'` default.
 *   2. A module is repointed at a different repository (or renamed) and the
 *      registry keeps the old value. The roll then updates an app to an image
 *      the next bicep deploy immediately overwrites — merged, deployed, and
 *      still not applied.
 *
 * HOW IT RESOLVES AN APP (measured, not assumed)
 *
 * The ground truth is the `resource … 'Microsoft.App/containerApps@…'` block
 * inside each module: its `name:` and its containers' `image:`. Both are either
 * a literal or an identifier, so each module call is resolved against a symbol
 * table built from the CALLER's literal `params:` (which wins — that is where
 * the surprise lives: iceberg-catalog-aca.bicep takes `param image string` and
 * main.bicep hands it the loom-unity reference) then the module's own
 * `param X string = '…'` defaults and `var X = '…'`.
 *
 * An earlier revision of this guard resolved names from `param name string`
 * defaults alone. Four modules (loom-maps-app, copilot/maf, integration/
 * dbt-runner, integration/transform-runner-aca) have no such param at all —
 * they name their app on the resource — so that strategy read them as
 * unresolvable. Resolving the resource block is what the repo actually does.
 *
 * WHAT THIS PROVES (and, as importantly, what it does not)
 *
 *   A. Every registry target exists in bicep as a Container App, with the app
 *      name and image repository the registry claims.
 *   B. Every Container App bicep deploys from a repository the registry targets
 *      is ITSELF in the registry — the anti-split ratchet. This covers both
 *      module-deployed apps and the inline `apps: [ … ]` array main.bicep hands
 *      to app-deployments.bicep's `[for app in apps]` loop.
 *   C. The registry's appImageTags key / env var agree with
 *      reconcile-policy.mjs, so a rolled tag is one the reconcile can preserve.
 *   D. The parser actually found container apps. A structural refactor that made
 *      this scan resolve nothing would let B pass vacuously, which is exactly
 *      the "green while measuring nothing" shape this program has found seven
 *      times. The floor is set from a real measurement.
 *
 * It does NOT claim to statically resolve every container app in the estate.
 * `app-deployments.bicep` builds each container from a loop variable
 * (`name: app.name`, `image: '${acrLoginServer}/${app.image}'`), which no line
 * scan can resolve — so that module's apps are read from the inline array at
 * the CALL SITE instead, and the block itself is reported UNRESOLVED. An
 * unresolved app whose IMAGE EXPRESSION mentions a repository the registry
 * targets FAILS, because "I could not parse it" must never be reported as "it
 * does not use that repository". That test is deliberately scoped to image
 * expressions: matching anywhere in the file failed loom-maps-app.bicep on a
 * prose comment that merely lists sibling image names.
 *
 * Usage: node scripts/ci/check-roll-atomicity.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { ROLL_TARGETS, groupsByRepo } from './roll-plan.mjs';
import { APP_IMAGE_TAGS } from './reconcile-policy.mjs';

const ROOT = process.cwd();
const ORCHESTRATOR = 'platform/fiab/bicep/modules/admin-plane/main.bicep';

/**
 * Minimum container apps this scan must resolve.
 *
 * MEASURED, not guessed. On 2026-08-08 the scan resolves 25 apps — 19 from
 * container-app modules and 6 from the inline `apps:` array. The floor sits
 * well below that so ordinary churn (a module retired, an app folded into
 * another) does not fail CI, while a structural change that blinds the parser
 * does: every parser regression measured while building this guard dropped the
 * count to single digits, not to 12.
 *
 * A scan that resolves far fewer than it used to is not "fewer apps" — it is a
 * broken parser, and a broken parser makes check B vacuous.
 */
export const MIN_RESOLVED = 12;

/** Does this module file declare a Container App (not a Container App JOB)? */
export function declaresContainerApp(text) {
  return /Microsoft\.App\/containerApps@/.test(text);
}

/** Is this line a bicep comment? */
function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Split `main.bicep` into top-level module calls.
 *
 * Top-level declarations start at column 0 (`module x 'path' = …`) and close on
 * a line that is exactly `}` at column 0 — the file's own formatting, verified
 * against its 80+ module declarations. PURE over text so the self-test drives it.
 *
 * @param {string} text
 * @returns {Array<{symbol:string, path:string, line:number, body:string}>}
 */
export function parseModuleCalls(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^module\s+([A-Za-z0-9_]+)\s+'([^']+)'\s*=/);
    if (!m) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\}\s*$/.test(lines[j])) { end = j; break; }
      if (/^module\s+/.test(lines[j]) || /^resource\s+/.test(lines[j])) { end = j - 1; break; }
      end = j;
    }
    out.push({ symbol: m[1], path: m[2], line: i + 1, body: lines.slice(i, end + 1).join('\n') });
  }
  return out;
}

/**
 * Extract the `params: { … }` sub-block of a module call body.
 * Returns '' when the call has none (some modules take no params).
 */
export function paramsBlock(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^\s+params:\s*\{\s*$/.test(l));
  if (start === -1) return '';
  const indent = lines[start].match(/^(\s*)/)[1];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === `${indent}}`) return lines.slice(start + 1, i).join('\n');
  }
  return lines.slice(start + 1).join('\n');
}

/**
 * Literal single-quoted assignments in a `params:` block, keyed by DOTTED PATH:
 * `name: 'x'` → `name`, and `catalogConfig: { image: 'y' }` → `catalogConfig.image`.
 *
 * The nesting is not incidental — it is where the load-bearing value lives.
 * main.bicep hands iceberg-catalog-aca.bicep a `catalogConfig` object and the
 * module reads `var image = catalogConfig.image`, so a top-level-only reader
 * sees no image at all and calls the app unresolved.
 *
 * Keys are taken only at each object's OWN indent, so a nested `name:` becomes
 * `someConfig.name` and can never masquerade as the module's `name` argument.
 * Values keep their `${…}` interpolation: the caller's
 * `'${registry.outputs.acrLoginServer}/loom-unity:${…}'` IS the repository fact.
 *
 * @returns {Map<string,string>} dotted path → literal (quotes stripped)
 */
export function literalParams(paramsText, maxDepth = 3) {
  const out = new Map();
  const walk = (lines, prefix, depth) => {
    const meaningful = lines.filter((l) => l.trim() !== '' && !isComment(l));
    if (meaningful.length === 0) return;
    const top = Math.min(...meaningful.map((l) => l.match(/^(\s*)/)[1].length));
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '' || isComment(line)) continue;
      if (line.match(/^(\s*)/)[1].length !== top) continue;

      const lit = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'(.*)'\s*$/);
      if (lit) {
        const key = `${prefix}${lit[1]}`;
        if (!out.has(key)) out.set(key, lit[2]);
        continue;
      }
      const obj = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*$/);
      if (obj && depth > 0) {
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j] === `${obj[1]}}`) { end = j; break; }
        }
        walk(lines.slice(i + 1, end), `${prefix}${obj[2]}.`, depth - 1);
        i = end;
      }
    }
  };
  walk(paramsText.split('\n'), '', maxDepth);
  return out;
}

/**
 * A module's own symbols: `param X string = '…'` defaults and `var X = <rhs>`.
 * These are the fallback when the caller does not pass the argument.
 *
 * A `var` keeps its RAW right-hand side rather than only matching a quoted
 * literal, because the indirection is the norm here — `var image =
 * catalogConfig.image` and `var airflowImageRef = '${acrLoginServer}/${airflowImage}'`
 * are both a step on the way to the repository, not a dead end.
 * {@link expandExpr} does the resolving; this only records.
 *
 * @returns {Map<string,string>}
 */
export function moduleSymbols(moduleText) {
  const out = new Map();
  for (const raw of moduleText.split('\n')) {
    if (isComment(raw)) continue;
    const p = raw.match(/^param\s+([A-Za-z_][A-Za-z0-9_]*)\s+string\s*=\s*'(.*)'\s*$/);
    if (p) { if (!out.has(p[1])) out.set(p[1], p[2]); continue; }
    const v = raw.match(/^var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (v && !out.has(v[1])) out.set(v[1], v[2]);
  }
  return out;
}

/**
 * Every `resource … 'Microsoft.App/containerApps@…'` block in a module, with the
 * raw (unresolved) `name:` expression and every container `image:` expression.
 *
 * A block runs to the next line starting with `}` at column 0, which closes both
 * a plain `= { … }` and a `= [for … { … }]` loop.
 *
 * @returns {Array<{symbol:string, line:number, nameExpr:string|null, imageExprs:string[]}>}
 */
export function containerAppBlocks(moduleText) {
  const lines = moduleText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^resource\s+([A-Za-z0-9_]+)\s+'Microsoft\.App\/containerApps@/);
    if (!m) continue;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\}/.test(lines[j])) { end = j; break; }
    }
    let nameExpr = null;
    const imageExprs = [];
    for (const raw of lines.slice(i + 1, end + 1)) {
      if (isComment(raw)) continue;
      const n = raw.match(/^\s{2}name:\s*(.+?)\s*$/);
      if (n && nameExpr === null) nameExpr = n[1];
      const im = raw.match(/^\s*image:\s*(.+?)\s*$/);
      if (im) imageExprs.push(im[1]);
    }
    out.push({ symbol: m[1], line: i + 1, nameExpr, imageExprs });
  }
  return out;
}

/**
 * Resolve a bicep expression against a symbol table.
 *
 * Handles the four shapes the repo actually uses:
 *   bare/dotted  `image: dabImage`, `var image = catalogConfig.image`
 *   quoted       `'${acrLoginServer}/${airflowImage}'`
 *   coalesce     `string(cfg.?s3ProxyImage ?? 's3proxy:3.3.0')` — the module's
 *                own default, which applies EXACTLY WHEN the caller's object
 *                literal has no such key. That condition is checked against the
 *                table, not assumed: if the caller DID pass the key, the entry
 *                is present and wins on the previous branch.
 *   interpolation repeated `${ident}` substitution, because airflow chains one
 *                symbol into the next.
 *
 * Bounded, so a self-referential symbol terminates rather than hanging CI.
 *
 * Unknown identifiers are LEFT AS THEY ARE — `${app.image}` stays unresolved and
 * is reported as such, never guessed at.
 */
export function expandExpr(expr, table, depth = 6) {
  if (expr === null || expr === undefined) return null;
  const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
  const DOTTED = new RegExp(`^(${IDENT}(?:\\.${IDENT})*)$`);
  const COALESCE = new RegExp(`^(?:string\\()?(${IDENT})\\.\\?(${IDENT})\\s*\\?\\?\\s*'([^']*)'\\)?$`);

  let s = String(expr).trim();
  for (let i = 0; i < depth; i += 1) {
    const before = s;

    const dotted = s.match(DOTTED);
    if (dotted && table.has(dotted[1])) { s = table.get(dotted[1]); continue; }

    const q = s.match(/^'(.*)'$/s);
    if (q) { s = q[1]; continue; }

    const co = s.match(COALESCE);
    if (co) {
      const key = `${co[1]}.${co[2]}`;
      // Caller-supplied value wins; the module default applies only when absent.
      s = table.has(key) ? table.get(key) : co[3];
      continue;
    }

    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, id) => {
      if (!table.has(id)) return whole;
      // Recurse, because a substituted symbol is frequently itself an
      // expression rather than a literal — s3-gateway's `${s3ProxyImage}` is a
      // whole `?? 'default'` coalesce. Depth-bounded, so a self-referential
      // symbol terminates instead of hanging CI.
      const raw = String(table.get(id)).trim();
      const v = depth > 0 ? expandExpr(table.get(id), table, depth - 1) : table.get(id);
      // If it only resolved to ANOTHER unknown reference (`acrLoginServer` →
      // `s3GatewayConfig.acrLoginServer`, a caller value that is not a literal),
      // keep the `${…}` placeholder. Substituting it would silently convert a
      // marked unknown into text that reads like a resolved value — the exact
      // R7 shape this guard exists to avoid.
      //
      // `raw` is checked too, because the test is "did this symbol ever reach a
      // literal", not "does the result look dotted". A QUOTED literal that
      // happens to look like a dotted identifier is a hostname
      // (`var host = 'x.azurecr.io'`), and treating it as unknown would leave a
      // resolvable image unresolved — the opposite error, equally wrong.
      const unresolvedRef = DOTTED.test(raw) && DOTTED.test(String(v).trim()) && !table.has(String(v).trim());
      if (unresolvedRef) return whole;
      return v;
    });
    if (s === before) break;
  }
  return s;
}

/**
 * Classify a fully-expanded image string.
 *
 *   acr        `${someLoginServer}/loom-unity:tag`      → repo 'loom-unity'
 *   external   `mcr.microsoft.com/…/busybox:2.0@sha256` → not in our registry
 *   unresolved anything else (e.g. a repo still built from `${app.image}`)
 *
 * `external` is a real answer, not a failure: dab-runtime and udf-runtime pull
 * upstream images, and calling that "unresolved" would bury the genuine unknowns.
 */
export function classifyImage(expanded) {
  if (!expanded) return { kind: 'unresolved', repo: null };
  const s = String(expanded).trim();
  const acr = s.match(/^\$\{[^}]*\}\/([A-Za-z0-9][A-Za-z0-9._/-]*):/);
  if (acr && !acr[1].includes('$')) return { kind: 'acr', repo: acr[1] };
  // A LITERAL registry host — reachable now that expandExpr resolves a quoted
  // literal rather than treating it as an unresolved reference. This must run
  // BEFORE the generic host branch below, which would otherwise call our own
  // registry an "external" upstream image and stop counting the app.
  // BOTH boundaries: Commercial is *.azurecr.io, Azure Government is
  // *.azurecr.us. Omitting the .us form would blind checks A and B in exactly
  // the cloud cloud-parity.md says matters most.
  const acrLiteral = s.match(/^[A-Za-z0-9][A-Za-z0-9-]*\.azurecr\.(?:io|us)\/([A-Za-z0-9][A-Za-z0-9._/-]*):/);
  if (acrLiteral) return { kind: 'acr', repo: acrLiteral[1] };
  const ext = s.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/([A-Za-z0-9][A-Za-z0-9._/-]*)[:@]/);
  if (ext) return { kind: 'external', repo: `${ext[1]}/${ext[2]}` };
  return { kind: 'unresolved', repo: null };
}

/**
 * Resolve one module call to the container apps it deploys.
 *
 * @param {{symbol:string, path:string, line:number, body:string}} call
 * @param {string} moduleText contents of the called .bicep
 * @returns {Array<{app:string|null, repos:string[], external:string[], imageExprs:string[], unresolvedImages:number, why:string|null, block:string}>}
 */
export function resolveCall(call, moduleText) {
  const table = new Map([...moduleSymbols(moduleText), ...literalParams(paramsBlock(call.body))]);
  return containerAppBlocks(moduleText).map((b) => {
    const nameVal = expandExpr(b.nameExpr, table);
    const app = nameVal && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(nameVal) ? nameVal : null;
    const repos = [];
    const external = [];
    let unresolvedImages = 0;
    for (const e of b.imageExprs) {
      const c = classifyImage(expandExpr(e, table));
      if (c.kind === 'acr') { if (!repos.includes(c.repo)) repos.push(c.repo); }
      else if (c.kind === 'external') { if (!external.includes(c.repo)) external.push(c.repo); }
      else unresolvedImages += 1;
    }
    let why = null;
    if (!app && unresolvedImages) why = 'neither the app name nor every image repository is a literal (both are built from a loop variable)';
    else if (!app) why = 'the container app name is not a literal';
    else if (unresolvedImages) why = `${unresolvedImages} image expression(s) do not resolve to a literal repository`;
    return { app, repos, external, imageExprs: b.imageExprs, unresolvedImages, why, block: b.symbol };
  });
}

/**
 * Container apps main.bicep declares INLINE, in the `apps: [ … ]` array it hands
 * to app-deployments.bicep's `[for app in apps]` loop. Those never appear in a
 * module's resource block, so without this they would be invisible to check B —
 * a silent hole exactly where six production apps live.
 *
 * The array's own formatting pairs the two keys on adjacent lines:
 *   name: 'loom-console'
 *   image: 'loom-console:${appImageTags.console}'
 * An `image:` whose preceding line is not a literal `name:` is returned with
 * app:null rather than paired by guesswork.
 *
 * @returns {Array<{app:string|null, repo:string, line:number}>}
 */
export function parseInlineApps(orchestratorText) {
  const lines = orchestratorText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isComment(lines[i])) continue;
    const im = lines[i].match(/^\s*image:\s*'([A-Za-z0-9][A-Za-z0-9._/-]*):[^']*'\s*$/);
    if (!im) continue;
    let prev = i - 1;
    while (prev >= 0 && (lines[prev].trim() === '' || isComment(lines[prev]))) prev -= 1;
    const nm = prev >= 0 ? lines[prev].match(/^\s*name:\s*'([A-Za-z0-9][A-Za-z0-9-]*)'\s*$/) : null;
    out.push({ app: nm ? nm[1] : null, repo: im[1], line: i + 1 });
  }
  return out;
}

/**
 * The whole verdict. PURE over already-read text so the self-test drives every
 * branch with fixtures — no fs, no bicep.
 *
 * @returns {{problems:string[], resolved:Array<object>, unresolved:Array<object>, skipped:number}}
 */
export function decide({
  calls,
  moduleTexts,
  inlineApps = [],
  targets = ROLL_TARGETS,
  imageTags = APP_IMAGE_TAGS,
  minResolved = MIN_RESOLVED,
}) {
  const problems = [];
  const resolved = [];
  const unresolved = [];
  let skipped = 0;

  const registryRepos = new Set(targets.map((t) => t.repo));

  /** An unresolved app may not be waved past if its IMAGE mentions a targeted repo. */
  const escalate = (where, why, imageExprs) => {
    for (const repo of registryRepos) {
      if (!imageExprs.some((e) => e.includes(repo))) continue;
      problems.push(
        `${where} could not be resolved (${why}) and its image expression mentions '${repo}', which the roll registry targets. `
        + 'Refusing to assume it is unrelated: an unparsed app is UNKNOWN, not absent. Make the image and name literals, or extend the parser.',
      );
    }
  };

  for (const call of calls) {
    const text = moduleTexts[call.path];
    if (text === undefined) {
      problems.push(`${ORCHESTRATOR}:${call.line} calls '${call.path}', which does not exist. A module call this scan cannot read is not something it may skip.`);
      continue;
    }
    if (!declaresContainerApp(text)) { skipped += 1; continue; }

    for (const r of resolveCall(call, text)) {
      const where = `${ORCHESTRATOR}:${call.line} module '${call.symbol}' (${call.path}) resource '${r.block}'`;
      if (r.app && !r.unresolvedImages) {
        resolved.push({ app: r.app, repos: r.repos, external: r.external, symbol: call.symbol, line: call.line, source: 'module' });
        continue;
      }
      unresolved.push({ symbol: call.symbol, path: call.path, line: call.line, block: r.block, why: r.why, app: r.app });
      escalate(where, r.why, r.imageExprs);
    }
  }

  for (const a of inlineApps) {
    if (a.app) {
      resolved.push({ app: a.app, repos: [a.repo], external: [], symbol: 'apps[]', line: a.line, source: 'inline' });
      continue;
    }
    unresolved.push({ symbol: 'apps[]', path: ORCHESTRATOR, line: a.line, block: 'inline', why: 'an inline app image has no adjacent literal name', app: null });
    escalate(`${ORCHESTRATOR}:${a.line} inline apps[] entry`, 'an inline app image has no adjacent literal name', [a.repo]);
  }

  // D — the parser must actually be working.
  if (resolved.length < minResolved) {
    problems.push(
      `only ${resolved.length} container app(s) resolved, below the measured floor of ${minResolved}. `
      + 'A scan that resolves almost nothing makes the group-completeness check vacuous — it would pass by finding no apps rather than by finding them consistent. '
      + 'Fix the parser (or, if apps were genuinely retired, lower MIN_RESOLVED in the same PR and say why).',
    );
  }

  // A — every registry target exists in bicep with the claimed name and repo.
  for (const t of targets) {
    const hits = resolved.filter((r) => r.app === t.app);
    if (hits.length === 0) {
      problems.push(
        `roll registry targets container app '${t.app}', which this scan did not find in ${ORCHESTRATOR}. `
        + 'A roll path aimed at an app bicep no longer deploys would fail on the estate, or worse, roll something that is about to be replaced.',
      );
      continue;
    }
    for (const h of hits) {
      if (!h.repos.includes(t.repo)) {
        problems.push(
          `roll registry says '${t.app}' runs repository '${t.repo}', but ${ORCHESTRATOR}:${h.line} deploys it from ${h.repos.length ? h.repos.map((x) => `'${x}'`).join(', ') : 'no ACR repository at all'}. `
          + 'Rolling the wrong repository updates an app the next bicep deploy immediately overwrites.',
        );
      }
    }
  }

  // B — the anti-split ratchet: no app on a registry repo may sit outside it.
  const registered = new Set(targets.map((t) => t.app));
  for (const r of resolved) {
    for (const repo of r.repos) {
      if (!registryRepos.has(repo)) continue;
      if (registered.has(r.app)) continue;
      const mates = targets.filter((t) => t.repo === repo).map((t) => t.app);
      problems.push(
        `${ORCHESTRATOR}:${r.line} deploys container app '${r.app}' from repository '${repo}', which the roll registry already carries for ${mates.join(', ')} — but '${r.app}' is NOT in the registry. `
        + 'Apps sharing an image repository must roll together: reconcile-policy.mjs cannot pin one appImageTags key to two different tags, so a partial roll marks that key UNKNOWN and freezes the estate-wide config reconcile. '
        + `Add '${r.app}' to ROLL_TARGETS in scripts/ci/roll-plan.mjs.`,
      );
    }
  }

  // C — the registry agrees with the reconcile's key table.
  for (const t of targets) {
    const entry = imageTags.find((e) => e.repo === t.repo);
    if (!entry) {
      problems.push(
        `roll registry targets repository '${t.repo}', which has no entry in APP_IMAGE_TAGS (scripts/ci/reconcile-policy.mjs). `
        + 'A tag rolled onto a repository the reconcile has no key for cannot be preserved — the next deploy resets it.',
      );
      continue;
    }
    if (entry.key !== t.tagKey) problems.push(`'${t.app}' claims appImageTags key '${t.tagKey}' but reconcile-policy.mjs maps repository '${t.repo}' to '${entry.key}'.`);
    if (entry.envVar !== t.envVar) problems.push(`'${t.app}' claims env var '${t.envVar}' but reconcile-policy.mjs maps repository '${t.repo}' to '${entry.envVar}'.`);
  }

  return { problems, resolved, unresolved, skipped };
}

function main() {
  const orch = join(ROOT, ORCHESTRATOR);
  if (!existsSync(orch)) {
    console.error(`[roll-atomicity] FAIL — ${ORCHESTRATOR} not found. A guard that finds nothing to check is the failure mode it exists to prevent.`);
    return 1;
  }
  const text = readFileSync(orch, 'utf8');
  const calls = parseModuleCalls(text);
  if (calls.length === 0) {
    console.error(`[roll-atomicity] FAIL — parsed ZERO module calls out of ${ORCHESTRATOR}. The parser is broken, not the file.`);
    return 1;
  }

  const base = dirname(orch);
  /** @type {Record<string,string>} */
  const moduleTexts = {};
  for (const c of calls) {
    const p = resolve(base, c.path);
    // Stay inside the repo: a module path that escapes it is a defect in itself.
    if (relative(ROOT, p).startsWith(`..${sep}`)) {
      console.error(`[roll-atomicity] FAIL — module call '${c.path}' resolves outside the repository.`);
      return 1;
    }
    if (existsSync(p)) moduleTexts[c.path] = readFileSync(p, 'utf8');
  }

  const inlineApps = parseInlineApps(text);
  const { problems, resolved, unresolved, skipped } = decide({ calls, moduleTexts, inlineApps });

  const fromModules = resolved.filter((r) => r.source === 'module').length;
  console.log(
    `[roll-atomicity] ${calls.length} module call(s); ${resolved.length} container app(s) resolved `
    + `(${fromModules} from modules, ${resolved.length - fromModules} inline), ${unresolved.length} unresolved, ${skipped} module(s) deploy no container app.`,
  );
  for (const [repo, members] of groupsByRepo()) {
    const live = resolved.filter((r) => r.repos.includes(repo)).map((r) => r.app).sort();
    console.log(`  repo ${repo.padEnd(14)} registry=[${members.map((m) => m.app).join(', ')}]  bicep=[${live.join(', ')}]`);
  }
  if (unresolved.length) {
    console.log('  unresolved (reported, never counted as absent):');
    for (const u of unresolved) console.log(`    ${u.path}:${u.line} ${u.symbol}/${u.block} — ${u.why}`);
  }

  if (!problems.length) {
    console.log('[roll-atomicity] OK — the roll registry matches bicep, and every app sharing a targeted repository is in it.');
    return 0;
  }
  console.error(`\n[roll-atomicity] FAIL — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  return 1;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-roll-atomicity.mjs');
if (invokedDirectly) process.exit(main());
