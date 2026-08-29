#!/usr/bin/env node
/**
 * GUARDRAIL: a Dockerfile that hand-copies individual SOURCE files into its
 * build context must copy the TRANSITIVE CLOSURE of their relative imports.
 *
 * WHY THIS EXISTS (#3886)
 * -----------------------
 * On 2026-08-28 `gov-provision-runner-images` (run 33191237788, sha 5a219efc)
 * failed building `loom-copilot-evaluator` in the Gov ACR. The az stderr was a
 * POINTER and nothing else:
 *
 *     ERROR: The run with ID 'ha7w' finished with unsuccessful status
 *     'RunStatus.FAILED'. Show run logs by 'az acr task logs …'
 *
 * The real error only existed inside the ACR task, because the build runs with
 * `--no-logs`. Fetched (by the #3416 diagnose step), it was:
 *
 *     Step 11/20 : RUN npm run build && node scripts/stage-evals.mjs
 *     ../../apps/fiab-console/lib/azure/cloud-endpoints.ts(54,8): error TS2307:
 *       Cannot find module './cloud-boundary' or its corresponding type declarations.
 *     … three more TS2307 …
 *     The command '/bin/sh -c npm run build && …' returned a non-zero code: 2
 *
 * azure-functions/copilot-evaluator/Dockerfile hand-copied exactly the three
 * console modules `src/` imports DIRECTLY. But tsc does not stop at the direct
 * import: `cloud-endpoints.ts` re-exports from `./cloud-boundary` and
 * `./cloud-endpoints-graph`, and neither file was in the context. The copy list
 * was a list of direct imports where the compiler needs a closure.
 *
 * NOTHING WATCHED THAT LIST. It is a hand-maintained mirror of another app's
 * source tree, and the only thing that reads it is a build — of an image built
 * by one Gov lane that had run `apply=true` twice ever. So the drift was
 * invisible from the moment the import was added until the moment a Gov deploy
 * needed the image. That is the same shape as #2816 (a `npm ci` with no
 * lockfile, never noticed because the image had never been built) and this
 * guard is deliberately its sibling: it reuses that file's Dockerfile parser
 * rather than growing a second one that can drift from it.
 *
 * THE RULES
 * ---------
 *   R1  Every relative import of every SOURCE file delivered into a stage must
 *       resolve to a real file in the build context. An import that resolves
 *       nowhere is reported as such — it is not silently treated as external.
 *   R2  That resolved file must ALSO be delivered into the SAME stage, AT THE
 *       IMAGE PATH THE IMPORT IMPLIES. Copying it to some other location does
 *       not satisfy the compiler, so it does not satisfy this guard: the check
 *       is on the in-image layout, not on "the repo path appears somewhere in
 *       the Dockerfile".
 *   R3  It must not be excluded by a `.dockerignore` at the context root. A
 *       COPY of an ignored file succeeds and delivers nothing (the #2816 R4
 *       shape), so the exclusion is modelled here too, with that file's matcher.
 *   R4  Applied to the CLOSURE, at any depth. The walk is seeded with EVERY
 *       source file the stage delivers, not with the app's own entrypoints, and
 *       R2 then forces each link of a chain to be delivered too — so a delivered
 *       link is always itself walked and the seed IS the fixed point. That is
 *       what separates this from one more level of enumeration: the evaluator's
 *       real chain was src → cloud-endpoints → cloud-boundary, and a check that
 *       only read the app's own `src/` would have passed the broken tree.
 *
 * KEYED TO THE SHAPE, NOT TO TODAY'S FILES
 * ----------------------------------------
 * There is no list of the five console modules anywhere below, and there must
 * not be one: a guard keyed to a name list is defeated by the next file added,
 * which is exactly the defect it was written for. Scope is decided by the
 * SHAPE — a Dockerfile is in scope when it delivers a source file through a
 * COPY whose source is a single named file (not a directory, not the whole
 * context). That is the hand-maintained-mirror shape. Inside such a Dockerfile
 * EVERY delivered source file is walked, including the ones that arrive by a
 * directory COPY, because `COPY src ./src` + a new `../../apps/...` import in
 * `src/` breaks the build in precisely the same way.
 *
 * A stage that copies the WHOLE context (`COPY . .`) delivers everything by
 * construction and is skipped — there is no closure to violate. That is also
 * what keeps this off the console image, whose context is ~40k files.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK
 *   - Bare (non-relative) specifiers. Those are node_modules' problem and
 *     `npm ci` already fails loudly on a missing dependency.
 *   - Type-checking, tsconfig paths/baseUrl aliases, or whether the build would
 *     otherwise succeed. This answers one question — "is every file the copied
 *     sources reach actually in the context" — and says nothing else.
 *   - Full .dockerignore semantics; R3 reuses the same bounded matcher
 *     check-dockerfile-lockfiles.mjs uses, and inherits its limits.
 *
 * POPULATION FLOOR: if discovery finds no in-scope Dockerfile, or checks no
 * import edge, this FAILS. A guard that passes having measured nothing is the
 * defect class this repo keeps rediscovering (#2860, #2585, #2929).
 *
 * Run:  node scripts/ci/check-dockerfile-copy-closure.mjs [--root <dir>]
 * Test: node --test scripts/ci/__tests__/dockerfile-copy-closure.test.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseStages,
  copySources,
  copyDest,
  resolveWorkdir,
  globToRegExp,
  discoverDockerfiles,
  deriveContextRoot,
  dockerignoreExcludes,
} from './check-dockerfile-lockfiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Extensions treated as SOURCE — i.e. files whose relative imports matter. */
export const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Directories never walked when enumerating a directory COPY. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'temp', '.venv', 'venv', '__pycache__', '.claude']);

/** Suffixes Node/tsc will append to a relative specifier, in resolution order. */
const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
];

export function isSourceFile(rel) {
  return SOURCE_EXT.some((e) => rel.endsWith(e)) && !rel.endsWith('.d.ts');
}

/**
 * Blank comments and string bodies in JS/TS source, PRESERVING LENGTH.
 *
 * A guard that a COMMENT can satisfy — or that a comment can send chasing a
 * module nobody imports — is the same defect in both directions, so this runs
 * before any import is read. Length preservation is load-bearing rather than
 * tidy: the matcher runs over this text and the specifier is then read back out
 * of the ORIGINAL at the same offsets, which is only valid while every input
 * character maps to exactly one output character. Blanking (rather than
 * deleting) is also what stops a URL like `'https://x'` being read as a `//`
 * comment, and stops a `from './x'` inside a comment being read as an import.
 */
export function stripJsComments(src) {
  const n = src.length;
  const out = new Array(n);
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = blank(src[i]);
        i += 1;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i] = quote;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out[i] = 'x';
          out[i + 1] = src[i + 1] === '\n' ? '\n' : 'x';
          i += 2;
          continue;
        }
        out[i] = src[i] === '\n' ? '\n' : 'x';
        i += 1;
      }
      if (i < n) out[i] = quote;
      i += 1;
      continue;
    }
    out[i] = c;
    i += 1;
  }
  for (let k = 0; k < n; k += 1) if (out[k] === undefined) out[k] = ' ';
  return out.join('');
}

/**
 * The RELATIVE specifiers a source file imports.
 *
 * Covers every form that reaches the module graph: `import … from`,
 * `export … from`, a bare side-effect `import 'x'`, dynamic `import('x')` and
 * `require('x')`. Comments are stripped first, and string CONTENTS are blanked
 * by stripJsComments, so the specifier is re-read from the original text at the
 * offsets the matcher found.
 */
export function relativeImportsOf(src) {
  const text = String(src);
  const scrubbed = stripJsComments(text);
  const specs = new Set();
  const patterns = [
    /\bfrom\s*(['"`])([^'"`\n]+)\1/g,
    /\bimport\s*(['"`])([^'"`\n]+)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/g,
    /\brequire\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  ];
  for (const re of patterns) {
    let m;
    // The scrubbed text has blanked string bodies, so read the specifier back
    // out of the ORIGINAL at the same index — same length, same offsets.
    while ((m = re.exec(scrubbed)) !== null) {
      const start = m.index + m[0].length - m[2].length - 1;
      const spec = text.slice(start, start + m[2].length);
      if (spec.startsWith('./') || spec.startsWith('../')) specs.add(spec);
    }
  }
  return [...specs];
}

/**
 * Specifier variants to try. TypeScript's NodeNext resolution has a `.js`
 * specifier resolve to the `.ts` source next to it, so a literal-only check
 * would report a missing module that resolves perfectly well.
 */
export function specifierVariants(spec) {
  const out = [spec];
  const m = spec.match(/\.(js|mjs|cjs)$/);
  if (m) out.push(spec.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'));
  return out;
}

/**
 * Resolve a relative import to a context-relative file path.
 * @returns {{ctxRel:string, spec:string, suffix:string}|null}
 */
export function resolveRelativeImport(importerCtxRel, spec, ctxAbs) {
  const dir = path.posix.dirname(importerCtxRel);
  for (const variant of specifierVariants(spec)) {
    const base = path.posix.normalize(`${dir}/${variant}`);
    for (const suffix of RESOLVE_SUFFIXES) {
      const cand = `${base}${suffix}`;
      if (cand.startsWith('..')) continue; // escapes the context entirely
      const abs = path.join(ctxAbs, cand);
      try {
        if (existsSync(abs) && statSync(abs).isFile()) return { ctxRel: cand, spec: variant, suffix };
      } catch {
        /* unreadable — treated as absent */
      }
    }
  }
  return null;
}

/** Every file beneath `subdir` of the context, as context-relative paths. */
function filesUnder(ctxAbs, subdir) {
  const out = [];
  const walk = (relDir) => {
    let entries;
    try {
      entries = readdirSync(path.join(ctxAbs, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(subdir);
  return out;
}

/**
 * What a single COPY instruction delivers into a stage.
 *
 * @returns {{wholeContext:boolean, delivered:Array<{ctxRel:string, imagePath:string, handCopied:boolean}>}}
 */
export function copyDeliveries(instruction, ctxAbs, workdir) {
  const srcs = copySources(instruction);
  const dest = copyDest(instruction);
  if (!srcs || dest === null) return { wholeContext: false, delivered: [] };
  const destAbs = resolveWorkdir(workdir, dest);
  const destIsDirOperand = /\/$/.test(dest) || dest === '.' || dest === './' || srcs.length > 1;

  let wholeContext = false;
  const delivered = [];
  for (const s of srcs) {
    const pat = s.replace(/^\.\//, '').replace(/\/+$/, '');
    if (pat === '' || pat === '.') {
      wholeContext = true;
      continue;
    }
    const hasGlob = pat.includes('*') || pat.includes('?');
    /** @type {string[]} roots this operand expands to (files or directories) */
    let roots = [];
    if (hasGlob) {
      const dir = path.posix.dirname(pat);
      const rx = globToRegExp(path.posix.basename(pat));
      try {
        for (const e of readdirSync(path.join(ctxAbs, dir === '.' ? '' : dir), { withFileTypes: true })) {
          if (!rx.test(e.name)) continue;
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
          roots.push(dir === '.' ? e.name : `${dir}/${e.name}`);
        }
      } catch {
        roots = [];
      }
    } else {
      roots = [pat];
    }

    for (const root of roots) {
      let isDir = false;
      try {
        const st = statSync(path.join(ctxAbs, root));
        isDir = st.isDirectory();
      } catch {
        continue; // a COPY source that is not on disk delivers nothing here
      }
      if (isDir) {
        // A directory source copies its CONTENTS into dest.
        for (const f of filesUnder(ctxAbs, root)) {
          const leaf = f.slice(root.length + 1);
          delivered.push({ ctxRel: f, imagePath: path.posix.normalize(`${destAbs}/${leaf}`), handCopied: false });
        }
      } else {
        const asDir = destIsDirOperand || hasGlob;
        delivered.push({
          ctxRel: root,
          imagePath: asDir ? path.posix.normalize(`${destAbs}/${path.posix.basename(root)}`) : destAbs,
          // A single named file operand IS the hand-maintained-mirror shape.
          handCopied: !hasGlob,
        });
      }
    }
  }
  return { wholeContext, delivered };
}

/**
 * Evaluate one Dockerfile.
 * @returns {{problems:string[], edges:number, inScope:boolean, contextRoot:string|null}}
 */
export function evaluateDockerfile({ dockerfileRel, text, root = REPO_ROOT }) {
  const problems = [];
  const stages = parseStages(text);
  const ctx = deriveContextRoot(dockerfileRel, stages, root);
  const ctxAbs = path.join(root, ctx.root ?? '');
  const ignorePath = path.join(ctxAbs, '.dockerignore');
  const ignoreText = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const toRepo = (p) => (ctx.root ? `${ctx.root}/${p}` : p);

  let edges = 0;
  let inScope = false;

  for (const stage of stages) {
    let workdir = '/';
    let wholeContext = false;
    /** @type {Map<string,string>} imagePath -> ctxRel */
    const byImagePath = new Map();
    /** @type {Map<string,string>} ctxRel -> imagePath */
    const byCtxRel = new Map();
    let stageHandCopiesSource = false;

    for (const inst of stage.instructions) {
      const wd = inst.match(/^WORKDIR\s+(.*)$/i);
      if (wd) {
        workdir = resolveWorkdir(workdir, wd[1]);
        continue;
      }
      if (!/^(?:COPY|ADD)\s+/i.test(inst)) continue;
      const res = copyDeliveries(inst, ctxAbs, workdir);
      if (res.wholeContext) wholeContext = true;
      for (const d of res.delivered) {
        byImagePath.set(d.imagePath, d.ctxRel);
        if (!byCtxRel.has(d.ctxRel)) byCtxRel.set(d.ctxRel, d.imagePath);
        if (d.handCopied && isSourceFile(d.ctxRel)) stageHandCopiesSource = true;
      }
    }

    // A whole-context stage delivers everything; there is no closure to break.
    if (wholeContext || !stageHandCopiesSource) continue;
    inScope = true;

    // R4 — the closure, at any depth. Seeding with EVERY delivered source file
    // (not with the app's own entrypoints) is what makes this a fixed point by
    // construction: R2 requires each link of a chain to be delivered, and every
    // delivered link is in this list, so it is walked in the same pass.
    for (const importerCtxRel of [...byCtxRel.keys()].filter(isSourceFile)) {
      const importerImagePath = byCtxRel.get(importerCtxRel);
      let src;
      try {
        src = readFileSync(path.join(ctxAbs, importerCtxRel), 'utf8');
      } catch {
        continue;
      }
      for (const spec of relativeImportsOf(src)) {
        edges += 1;
        const hit = resolveRelativeImport(importerCtxRel, spec, ctxAbs);
        if (!hit) {
          // R1
          problems.push(
            `${dockerfileRel} [stage ${stage.name}]: ${toRepo(importerCtxRel)} imports "${spec}", which ` +
              `resolves to no file under the build context (${ctx.root || '<repo root>'}). Either the ` +
              `import is wrong or the file it names is outside the context entirely — a COPY cannot ` +
              `fix the second case, the import has to change.`,
          );
          continue;
        }
        const wantImagePath =
          path.posix.normalize(`${path.posix.dirname(importerImagePath)}/${hit.spec}`) + hit.suffix;
        const landedCtxRel = byImagePath.get(wantImagePath);
        if (landedCtxRel === hit.ctxRel) {
          if (dockerignoreExcludes(ignoreText, hit.ctxRel)) {
            // R3
            problems.push(
              `${dockerfileRel} [stage ${stage.name}]: ${toRepo(hit.ctxRel)} is COPY'd but is excluded by ` +
                `${ctx.root ? `${ctx.root}/` : ''}.dockerignore, so it is absent from the uploaded context ` +
                `and the COPY silently delivers nothing. Un-ignore it with a \`!\` negation line.`,
            );
          }
          continue;
        }
        // R2
        const where = landedCtxRel
          ? `${wantImagePath} holds ${toRepo(landedCtxRel)} instead`
          : `nothing is delivered to ${wantImagePath}`;
        problems.push(
          `${dockerfileRel} [stage ${stage.name}]: ${toRepo(importerCtxRel)} imports "${spec}" -> ` +
            `${toRepo(hit.ctxRel)}, which this stage does NOT deliver where the import looks for it ` +
            `(${where}). The copy list is a TRANSITIVE CLOSURE, not a list of direct imports: add\n` +
            `      COPY ${toRepo(hit.ctxRel)} ${wantImagePath}\n` +
            `    Nothing else reads this list, so a build is the only other thing that would ever ` +
            `notice — and for this image that is a Gov ACR task whose log stays inside the registry.`,
        );
      }
    }
  }

  return { problems, edges, inScope, contextRoot: ctx.root ?? null };
}

export function scanRepo(root = REPO_ROOT) {
  const dockerfiles = discoverDockerfiles(root);
  const problems = [];
  const rows = [];
  let edges = 0;
  let inScopeCount = 0;
  for (const rel of dockerfiles) {
    const text = readFileSync(path.join(root, rel), 'utf8');
    const res = evaluateDockerfile({ dockerfileRel: rel, text, root });
    edges += res.edges;
    if (res.inScope) {
      inScopeCount += 1;
      rows.push(
        `  ${res.problems.length ? 'FAIL' : 'ok  '}    ${rel} ` +
          `(${res.edges} relative import${res.edges === 1 ? '' : 's'}, ` +
          `context=${res.contextRoot || '<repo root>'})`,
      );
    }
    problems.push(...res.problems);
  }
  return { dockerfiles, problems, rows, edges, inScopeCount };
}

function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag === -1 ? REPO_ROOT : path.resolve(argv[rootFlag + 1]);

  const { dockerfiles, problems, rows, edges, inScopeCount } = scanRepo(root);

  console.log(`Dockerfiles scanned: ${dockerfiles.length}`);
  console.log(`Hand-copied-source Dockerfiles: ${inScopeCount} (${edges} relative imports walked)`);
  for (const r of rows) console.log(r);

  if (inScopeCount === 0 || edges === 0) {
    console.error(
      `\n::error::FAIL: discovery found ${dockerfiles.length} Dockerfile(s), ${inScopeCount} of which ` +
        `hand-copy a source file, and walked ${edges} relative import(s). This guard cannot pass on an ` +
        `empty population — that would be a green light measuring nothing. If the shape genuinely no ` +
        `longer exists in the repo, DELETE this guard in the same change that removes the last one; do ` +
        `not leave it green and inert.`,
    );
    process.exit(1);
  }

  if (problems.length) {
    console.error(`\n::error::FAIL: ${problems.length} unclosed Dockerfile copy list(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nWhy this blocks: tsc resolves what the copied files THEMSELVES import. A module reached only ` +
        `indirectly is as required as one named in src/, and the build that would catch it runs inside ` +
        `an ACR task with --no-logs — so the failure arrives as "RunStatus.FAILED" and nothing more ` +
        `(#3886, run 33191237788).`,
    );
    process.exit(1);
  }

  console.log('\nPASS: every hand-copied source file has its full import closure in its build context.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
