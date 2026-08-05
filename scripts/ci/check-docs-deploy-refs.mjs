#!/usr/bin/env node
/**
 * check-docs-deploy-refs — every repo path a DEPLOYMENT doc tells a customer to
 * run must exist on disk, AND the constructs it publishes must be able to work.
 *
 * WHY THIS EXISTS
 * ---------------
 * `deploy-integrity.md` R8: "The wizard and the docs must agree. A wizard step
 * with no doc, or a doc step the wizard does not implement, is drift and is a
 * defect." The cheapest, most common form of that drift is a doc that tells the
 * operator to run a script or dispatch a workflow that does not exist. A 2026-08
 * survey of `docs/fiab/deployment/**` + `docs/fiab/runbooks/**` found EIGHT
 * such references, including the product's own honest-gate pointing at
 * `scripts/csa-loom/post-deploy-bootstrap.sh` (never existed) and four pipeline
 * pages pointing at `scripts/csa-loom/bootstrap-all.sh` (never existed).
 *
 * A customer following those pages hits a "No such file or directory" on a step
 * the docs present as required. That is R8 drift with teeth, and it is
 * mechanically detectable — so it is detected here rather than by the customer.
 *
 * WHAT IT CHECKS
 *   1. `scripts/...(.sh|.mjs|.py|.ts)`      — must exist
 *   2. `.github/workflows/<name>.yml`        — must exist
 *   3. `gh workflow run <name>[.yml]`        — must exist AND declare
 *                                              `workflow_dispatch`
 *   4. `platform/fiab/bicep/...`             — must exist (allowing *.generated.*
 *                                              which is an OUTPUT, not a source)
 *   5. `param <name> = …` in a published      — `<name>` must be DECLARED by the
 *      bicepparam snippet                      template that snippet binds to
 *
 * WHY 3 AND 5 EXIST — EXISTENCE IS NOT WORKINGNESS
 * ------------------------------------------------
 * Checks 1..4 were originally `existsSync` and nothing else, which is a weaker
 * property than R8 needs: a path can exist while the construct the doc
 * publishes cannot run.
 *
 *   - MEASURED 2026-08: `brownfield.md` published, for a `reuse` pick, the line
 *     `param existingPurviewAccount = '<name>'`, while a sibling change removed
 *     that parameter from the template. Every path on the page still resolved,
 *     so an existsSync-only guard stayed green — and a customer following the
 *     page produced, verbatim from `az bicep build-params`:
 *         Error BCP259: The parameter "existingPurviewAccount" is assigned in
 *         the params file without being declared in the Bicep file.
 *     i.e. the published walkthrough generated a template that cannot compile.
 *   - The same shape one level up: `gh workflow run x.yml` against a workflow
 *     with no `workflow_dispatch` trigger. The file exists; the command fails
 *     with "workflow does not have workflow_dispatch trigger".
 *
 * Both are decidable from the repo alone, so they are decided here rather than
 * by the customer. Check 5 needs no `az bicep`: BCP259 is precisely "assigned
 * but not declared", which is a set difference.
 *
 * STILL DELIBERATELY NOT CHECKED
 *   - parameter names appearing in PROSE rather than in a `param … =`
 *     assignment. A regex over English produces false positives on ordinary
 *     words; the assignment form is unambiguous and is where BCP259 comes from.
 *
 * MUTATION PROOF (run these; all must behave as stated):
 *   1. Append `bash scripts/csa-loom/does-not-exist.sh` to
 *      docs/fiab/deployment/greenfield.md   -> exits 1 naming it.
 *   2. Append a fenced `param definitelyNotAParam = 'x'` to a deployment doc
 *                                           -> exits 1 citing BCP259.
 *   3. Remove them                          -> exits 0.
 *
 * Tests: node --test scripts/ci/__tests__/docs-deploy-refs.test.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['docs/fiab/deployment', 'docs/fiab/runbooks'];

/**
 * The template a bicepparam snippet binds to when the doc does not say. Every
 * boundary params file in this repo `using`s it, and it is the template every
 * documented `az deployment sub create` passes to `-f`.
 */
const DEFAULT_TEMPLATE = 'platform/fiab/bicep/main.bicep';

/**
 * Paths a doc may legitimately reference that are BUILD OUTPUTS, not sources.
 * Each entry must carry the reason it is exempt — an unexplained exemption is
 * how a guard quietly stops guarding.
 */
const OUTPUT_PATTERNS = [
  // byo-wizard.sh WRITES this; it is not in the repo by design.
  /^platform\/fiab\/bicep\/params\/.*\.generated\.bicepparam$/,
];

/** Collect every .md under a directory tree. */
export function mdFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...mdFiles(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

const EXTRACTORS = [
  {
    kind: 'script',
    re: /(?<![\w./-])((?:\.github\/)?scripts\/[A-Za-z0-9_./-]+\.(?:sh|mjs|py|ts))/g,
    resolve: (m) => m,
  },
  {
    kind: 'workflow-path',
    re: /(?<![\w./-])(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)/g,
    resolve: (m) => m,
  },
  {
    kind: 'workflow-dispatch',
    re: /gh\s+workflow\s+run\s+([A-Za-z0-9_-]+)(\.ya?ml)?/g,
    resolve: (_m, name) => `.github/workflows/${name}.yml`,
  },
  {
    // `bicepparam` MUST come first: regex alternation is leftmost-first, so
    // `(?:bicep|bicepparam)` would match only the `.bicep` prefix of a
    // `.bicepparam` path and then report the truncated name as missing.
    kind: 'bicep',
    re: /(?<![\w./-])(platform\/fiab\/bicep\/[A-Za-z0-9_./-]+\.(?:bicepparam|bicep))/g,
    resolve: (m) => m,
  },
];

/**
 * A doc line that tells the reader to CREATE a file in THEIR OWN repo is not a
 * reference to a file in this one. Narrow and reasoned — not a blanket skip.
 */
const AUTHORING_INSTRUCTION = /\b(?:save as|create(?: a)?(?: new)? file|add a file)\b/i;

// ── check 5: a published bicepparam assignment must bind to a declared param ──

/**
 * Parameters a bicep template DECLARES. Bicep declares as `param <name> <type>`
 * (optionally `= <default>`); a bicepparam ASSIGNS as `param <name> =`. That
 * type token is what makes check 5 a clean set difference rather than a
 * heuristic, and the discrimination lives in the ASSIGN pattern in
 * `undeclaredParamAssignments` — drop the `=` there and a declaration quoted in
 * a doc reads as an assignment.
 *
 * @param {string} templatePath repo-relative
 * @returns {Set<string>|null} null when the template cannot be read — NEVER an
 *   empty set, which would be "I could not read it" rendered as "it declares
 *   nothing" (deploy-integrity R7, one level down) and would flag every
 *   assignment in every doc.
 */
export function declaredParams(templatePath) {
  const p = templatePath.split('/').join(sep);
  if (!existsSync(p)) return null;
  const out = new Set();
  for (const m of readFileSync(p, 'utf8').matchAll(/^\s*param\s+([A-Za-z_][A-Za-z0-9_]*)\s+\S/gm)) {
    out.add(m[1]);
  }
  return out;
}

/** Follow a `.bicepparam`'s `using '<template>'` to the template it binds to. */
export function templateOfParamFile(paramPath) {
  const p = paramPath.split('/').join(sep);
  if (!existsSync(p)) return null;
  const m = /^\s*using\s+'([^']+)'/m.exec(readFileSync(p, 'utf8'));
  if (!m) return null;
  return posix.normalize(posix.join(posix.dirname(paramPath.split(sep).join('/')), m[1]));
}

/**
 * Walk a doc top-to-bottom, tracking the most recent statement of WHICH
 * template is in play, and check every `param <name> = …` against it.
 *
 * Resolution order, most specific first:
 *   1. a `using '<template>'` line in the doc itself (a doc showing a whole
 *      bicepparam file header);
 *   2. the most recent `platform/fiab/bicep/params/<x>.bicepparam` mentioned,
 *      followed through ITS `using`;
 *   3. the most recent `platform/fiab/bicep/**.bicep` mentioned;
 *   4. DEFAULT_TEMPLATE.
 *
 * @returns {{line:number, param:string, template:string, file:string}[]}
 */
export function undeclaredParamAssignments(text, fileForMsg = '') {
  const lines = text.split(/\r?\n/);
  const out = [];
  let template = DEFAULT_TEMPLATE;
  const cache = new Map();
  const declFor = (t) => {
    if (!cache.has(t)) cache.set(t, declaredParams(t));
    return cache.get(t);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const usingHere = /^\s*using\s+'([^']+)'/.exec(line);
    if (usingHere) {
      const raw = usingHere[1];
      template = raw.startsWith('platform/')
        ? raw
        : posix.normalize(posix.join('platform/fiab/bicep/params', raw));
      continue;
    }
    const paramFile = /(?<![\w./-])(platform\/fiab\/bicep\/params\/[A-Za-z0-9_.-]+\.bicepparam)/.exec(line);
    if (paramFile && !/\.generated\.bicepparam$/.test(paramFile[1])) {
      template = templateOfParamFile(paramFile[1]) ?? template;
      continue;
    }
    const tmpl = /(?<![\w./-])(platform\/fiab\/bicep\/[A-Za-z0-9_./-]+\.bicep)(?![a-z])/.exec(line);
    if (tmpl) {
      template = tmpl[1];
      continue;
    }

    const assign = /^\s*param\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!assign) continue;
    const declared = declFor(template);
    // The template itself being missing is reported by the `bicep` extractor;
    // saying it twice adds no information.
    if (declared === null) continue;
    if (!declared.has(assign[1])) {
      out.push({ line: i + 1, param: assign[1], template, file: fileForMsg });
    }
  }
  return out;
}

/** Does a workflow accept `gh workflow run`? null when it cannot be read. */
export function acceptsDispatch(workflowPath) {
  const p = workflowPath.split('/').join(sep);
  if (!existsSync(p)) return null;
  return /^\s{2,}workflow_dispatch:/m.test(readFileSync(p, 'utf8'));
}

// ── driver ───────────────────────────────────────────────────────────────────
//
// Guarded by an isMain check so the exported helpers above can be imported by
// the self-test without the scan running (and possibly process.exit-ing) as a
// side effect of the import.

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const failures = [];
  let refCount = 0;
  let paramCount = 0;
  const files = ROOTS.flatMap(mdFiles).sort();

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const { kind, re, resolve: res } of EXTRACTORS) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
        const target = res(m[1], m[1]).split('/').join(sep);
        const normalized = target.split(sep).join('/');
        refCount += 1;
        if (OUTPUT_PATTERNS.some((p) => p.test(normalized))) continue;
        // 1-indexed line number of the match, for a clickable failure.
        const upto = text.slice(0, m.index).split(/\r?\n/).length;
        const src = lines[upto - 1] ?? '';
        if (!existsSync(normalized)) {
          if (AUTHORING_INSTRUCTION.test(src)) continue;
          failures.push({ file, line: upto, kind, ref: normalized, src: src.trim(), why: 'does not exist on disk' });
          continue;
        }
        if (kind === 'workflow-dispatch' && acceptsDispatch(normalized) === false) {
          failures.push({
            file,
            line: upto,
            kind,
            ref: normalized,
            src: src.trim(),
            why: 'exists but declares no `workflow_dispatch` trigger — `gh workflow run` on it fails',
          });
        }
      }
    }

    paramCount += [...text.matchAll(/^\s*param\s+[A-Za-z_][A-Za-z0-9_]*\s*=/gm)].length;
    for (const hit of undeclaredParamAssignments(text, file)) {
      failures.push({
        file,
        line: hit.line,
        kind: 'bicepparam-decl',
        ref: hit.param,
        src: (lines[hit.line - 1] ?? '').trim(),
        why:
          `is assigned in a published bicepparam snippet but is NOT declared in ${hit.template} — ` +
          'a customer pasting this gets BCP259 and a template that cannot compile',
      });
    }
  }

  console.log(
    `[docs-deploy-refs] scanned ${files.length} docs, ${refCount} repo references, ` +
      `${paramCount} published param assignment(s)`,
  );

  if (failures.length > 0) {
    console.error(
      `\n[docs-deploy-refs] FAIL — ${failures.length} reference(s) in deployment/runbook docs are broken.\n` +
        'A customer following these pages hits a missing file, a workflow that will not dispatch, or a\n' +
        'template that cannot compile — on a step the doc presents as required.\n' +
        'Fix the doc to name what exists and compiles. Do NOT add an exemption without a stated reason.\n',
    );
    for (const f of failures) {
      console.error(`  ${f.file}:${f.line}  [${f.kind}]  ${f.ref} — ${f.why}`);
      if (f.src) console.error(`      > ${f.src.slice(0, 150)}`);
    }
    process.exit(1);
  }

  console.log(
    '[docs-deploy-refs] OK — every script, workflow and bicep path resolves, every documented dispatch is\n' +
      '                   dispatchable, and every published param assignment binds to a declared parameter.',
  );
}
