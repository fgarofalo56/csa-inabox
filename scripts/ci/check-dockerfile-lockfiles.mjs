#!/usr/bin/env node
/**
 * GUARDRAIL: a Dockerfile that installs from a lockfile must actually have that
 * lockfile in the build context it is built with.
 *
 * WHY THIS EXISTS (refs #2816)
 * ---------------------------
 * On 2026-08-03 the FIRST genuine execution of deploy-lineage-extractor.yml
 * (dry_run=false) failed in 12 seconds. ACR task run cj2du:
 *
 *     npm error The `npm ci` command can only install with an existing
 *     npm error package-lock.json or npm-shrinkwrap.json ...
 *     The command '/bin/sh -c npm ci' returned a non-zero code: 1
 *
 * azure-functions/lineage-extractor had NO package-lock.json. It never had one.
 * The Dockerfile had shipped with `RUN npm ci` since the app was written, and
 * nothing anywhere noticed, because the only thing that reads a Dockerfile is a
 * build and this image had never once been built. Its two siblings
 * (secret-expiry-monitor, copilot-evaluator) are the same shape and DO carry
 * lockfiles, so the defect was invisible by comparison too — three files that
 * look identical in review, one of which cannot build.
 *
 * The failure mode is quiet in a specific way worth naming, because it is what
 * makes review useless here:
 *
 *     COPY package*.json ./
 *
 * is a GLOB. Docker does not fail a COPY whose glob matches only some of what
 * you meant — `package*.json` happily matches `package.json` alone. So the
 * Dockerfile reads as though it brings the lockfile in, the COPY succeeds, and
 * the build dies one line later at `npm ci`. The instruction that is wrong is
 * not the instruction that fails.
 *
 * #2729 is the same lesson from the other direction: CVE floors were declared
 * in a file the builder's package manager never read, so they were inert in the
 * shipped image while CI read green. The rule both incidents teach is that a
 * claim about a build must be checked against **the context the build actually
 * sees**, not against the repo root and not against what the file says.
 * That is why this guard resolves every COPY against a derived context root,
 * and why "the file exists in the repo" is deliberately NOT the test.
 *
 * THE RULES
 * ---------
 *   R1  Every stage that runs a lockfile-strict install (`npm ci`,
 *       `pnpm install --frozen-lockfile`, `yarn install --immutable`) must have
 *       a COPY, EARLIER IN THAT SAME STAGE, that brings in the lockfile the
 *       install tool requires. Per-stage, because a multi-stage Dockerfile
 *       installs more than once and each stage has its own filesystem: in the
 *       lineage-extractor negative control it was the RUNTIME stage's
 *       `npm ci --omit=dev` that failed first, not the build stage's `npm ci`.
 *   R2  That lockfile must resolve to a real file under the build context root,
 *       with COPY globs expanded the way Docker expands them. This is the rule
 *       that catches `COPY package*.json ./` with no lockfile on disk.
 *   R3  The lockfile must be TRACKED IN GIT. Not merely present on disk.
 *       deploy-copilot-evaluator-job.sh stages its context with
 *       `git archive HEAD | tar -x`, so an untracked or gitignored lockfile is
 *       simply absent from the context that gets uploaded, however healthy the
 *       working tree looks. An existsSync() check would pass and the build
 *       would still fail.
 *   R4  No .dockerignore may exclude that lockfile from the context. A file
 *       that exists and is tracked is still not in the tarball if it is
 *       ignored — the same "declared somewhere the builder does not read"
 *       shape as #2729.
 *
 * THE CONTEXT ROOT IS DERIVED, NOT ASSUMED
 * ----------------------------------------
 * The build context differs per image and is set at the call site, not in the
 * Dockerfile, so it cannot be read off the file being checked. Parsing it out
 * of the shell that invokes `az acr build` would be guesswork over five
 * different scripts. Instead it is derived from the COPY sources themselves,
 * which are the Dockerfile's own statement of what its context looks like: of
 * the two candidates (the Dockerfile's own directory, and the repo root), the
 * one under which more COPY sources resolve wins; the Dockerfile's directory
 * breaks ties.
 *
 * That is decisive — not a coin flip — on every Dockerfile in this repo, and
 * each answer was confirmed against the actual invocation:
 *
 *   azure-functions/lineage-extractor      app dir    deploy-lineage-extractor-job.sh: cd "$APP_DIR" && az acr build … .
 *   azure-functions/secret-expiry-monitor  app dir    deploy-secret-expiry-job.sh:     cd "$APP_DIR" && az acr build … .
 *   azure-functions/copilot-evaluator      repo root  deploy-copilot-evaluator-job.sh: git archive HEAD → STAGE_DIR; cd "$STAGE_DIR"
 *   apps/fiab-console/Dockerfile.uat       app dir    deploy-loom-uat-job.sh:          cd "$APP_DIR" && az acr build --file Dockerfile.uat .
 *   portal/kubernetes/docker/frontend      repo root  COPY portal/react-webapp/… (repo-root-relative)
 *
 * If a future Dockerfile is built from a context that is neither, this
 * derivation is wrong and the guard will say so rather than quietly assume:
 * a Dockerfile whose COPY sources resolve under NEITHER candidate is a hard
 * failure (R0), not a skip.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK (stated so nobody reads more into a
 * green run than is there):
 *   - Whether the lockfile is in sync with package.json. `npm ci` already
 *     hard-fails EUSAGE on that, loudly, at build time — see the reasoning in
 *     check-npm-cve-floors.mjs. Re-checking what the tool already enforces
 *     would be duplicated effort at best and drift at worst.
 *   - Whether the resulting image is correct, or the pinned versions are safe.
 *     That is check-npm-cve-floors.mjs / check-pnpm-overrides.mjs / Trivy.
 *   - Full .dockerignore semantics. R4 models the shapes that actually occur
 *     (exact path, bare basename, `**\/name`, and negation with `!`), not
 *     Docker's complete matcher. It is a backstop against an obvious
 *     exclusion, not a reimplementation; a green R4 is not proof that Docker
 *     would include the file under an exotic pattern.
 *   - Dockerfiles that install WITHOUT a lockfile (`npm install`). Those build
 *     fine and fail differently — non-reproducibly — which is a different
 *     complaint and not this one.
 *
 * ESCAPE HATCH: add an EXEMPT entry with a reason. It is currently EMPTY and
 * should stay that way: committing the lockfile is nearly always cheaper than
 * justifying its absence, and "npm ci without a lockfile" has no correct form.
 *
 * Run: node scripts/ci/check-dockerfile-lockfiles.mjs
 * Test: node --test scripts/ci/__tests__/dockerfile-lockfiles.test.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Dockerfiles excused from the rule, with a reason. Keep EMPTY.
 * Shape: { 'path/to/Dockerfile': 'why' }
 */
export const EXEMPT = {};

/**
 * Lockfile-strict install commands → the lockfiles that satisfy them.
 *
 * Each `test` matches the RUN body; each `lockfiles` lists every filename the
 * tool accepts (npm takes either, and prefers npm-shrinkwrap.json when both
 * are present).
 */
export const INSTALL_KINDS = [
  {
    tool: 'npm',
    // `npm ci`, `npm clean-install`, and the documented aliases. Must not match
    // `npm cache clean`, which appears on the same RUN line in three of these
    // Dockerfiles (`npm ci --omit=dev && npm cache clean --force`).
    test: /\bnpm\s+(?:ci|clean-install|install-clean|isntall-clean|ic)\b/,
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
  },
  {
    tool: 'pnpm',
    test: /\bpnpm\s+(?:install|i)\b[^\n]*--frozen-lockfile/,
    lockfiles: ['pnpm-lock.yaml'],
  },
  {
    tool: 'yarn',
    test: /\byarn\s+install\b[^\n]*--immutable/,
    lockfiles: ['yarn.lock'],
  },
];

/** Directories never walked when discovering Dockerfiles. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'temp',
  '.venv',
  'venv',
  '__pycache__',
  '.claude',
]);

/**
 * Strip Dockerfile comments before any assertion is made about the file.
 *
 * Every claim this guard makes is a claim about what the build DOES, and a
 * comment can spell any instruction verbatim — this file's own header contains
 * the literal strings `RUN npm ci` and `COPY package*.json ./`. A guard that a
 * comment can satisfy is the defect it exists to catch. Only whole-line
 * comments are stripped: `#` is not a comment character mid-instruction.
 */
export function stripDockerComments(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

/**
 * Join Dockerfile line continuations so a single instruction is a single line.
 * Done after comment stripping, so a commented-out continuation cannot splice
 * two unrelated instructions together.
 */
export function joinContinuations(text) {
  return text.replace(/\\[ \t]*\r?\n/g, ' ');
}

/**
 * Split a Dockerfile into stages at each FROM.
 *
 * Instructions before the first FROM (ARGs, usually) belong to no stage and are
 * dropped: they cannot contain a COPY that lands in a stage's filesystem.
 */
export function parseStages(text) {
  const lines = joinContinuations(stripDockerComments(text)).split('\n');
  const stages = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^FROM\s+/i.test(line)) {
      const m = line.match(/\bAS\s+([A-Za-z0-9._-]+)\s*$/i);
      stages.push({ name: m ? m[1] : `stage${stages.length}`, instructions: [] });
      continue;
    }
    if (stages.length === 0) continue;
    stages[stages.length - 1].instructions.push(line);
  }
  return stages;
}

/**
 * Source paths of a COPY/ADD instruction, or null if it is not one that reads
 * from the build context.
 *
 * `COPY --from=<stage|image>` reads from another stage, not the context, so it
 * can never satisfy the rule and is excluded. Other flags (--chown, --chmod,
 * --link) are dropped. The final operand is the destination.
 */
export function copySources(instruction) {
  const m = instruction.match(/^(?:COPY|ADD)\s+(.*)$/i);
  if (!m) return null;
  let rest = m[1].trim();
  if (/^--from=/i.test(rest) || /\s--from=/i.test(rest)) return null;
  // JSON-array form: COPY ["src", "dest"]
  if (rest.startsWith('[')) {
    try {
      const arr = JSON.parse(rest);
      return Array.isArray(arr) && arr.length >= 2 ? arr.slice(0, -1) : null;
    } catch {
      return null;
    }
  }
  rest = rest.replace(/(^|\s)--[A-Za-z-]+(=\S+)?/g, ' ').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts.slice(0, -1) : null;
}

/** The destination operand of a COPY/ADD, or null if not one. */
export function copyDest(instruction) {
  const m = instruction.match(/^(?:COPY|ADD)\s+(.*)$/i);
  if (!m) return null;
  let rest = m[1].trim();
  if (rest.startsWith('[')) {
    try {
      const arr = JSON.parse(rest);
      return Array.isArray(arr) && arr.length >= 2 ? arr[arr.length - 1] : null;
    } catch {
      return null;
    }
  }
  rest = rest.replace(/(^|\s)--[A-Za-z-]+(=\S+)?/g, ' ').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

/** The install kind a RUN instruction performs, or null. */
export function installKind(instruction) {
  const m = instruction.match(/^RUN\s+(.*)$/i);
  if (!m) return null;
  return INSTALL_KINDS.find((k) => k.test.test(m[1])) || null;
}

/** Resolve a WORKDIR operand against the stage's current working directory. */
export function resolveWorkdir(current, arg) {
  const a = arg.trim().replace(/^["']|["']$/g, '');
  if (a.startsWith('/')) return path.posix.normalize(a).replace(/\/+$/, '') || '/';
  return path.posix.normalize(`${current}/${a}`).replace(/\/+$/, '') || '/';
}

/**
 * Docker COPY glob → RegExp. Go's filepath.Match semantics, which is what the
 * daemon uses: `*` and `?` do not cross a path separator.
 */
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Context-relative paths of every file named in `names` beneath `subdir`.
 * Bounded by SKIP_DIRS — a repo-root context contains node_modules trees whose
 * lockfiles are not the build's lockfile and whose depth exceeds MAX_PATH.
 */
export function findLockfilesUnder(ctxAbs, subdir, names) {
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
      } else if (names.includes(e.name)) {
        out.push(rel);
      }
    }
  };
  walk(subdir);
  return out;
}

/**
 * Context-relative lockfile paths that a single COPY source pattern delivers.
 *
 * This resolves the pattern against the REAL filesystem under the context root
 * rather than reasoning about the string, which is the whole point: the
 * lineage-extractor defect was a glob that reads as though it matches a
 * lockfile and, on disk, did not.
 */
export function deliveredLockfiles(pattern, ctxAbs, names) {
  const pat = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  if (pat === '' || pat === '.') return findLockfilesUnder(ctxAbs, '', names);

  if (!pat.includes('*') && !pat.includes('?')) {
    const abs = path.join(ctxAbs, pat);
    if (!existsSync(abs)) return [];
    try {
      if (statSync(abs).isDirectory()) return findLockfilesUnder(ctxAbs, pat, names);
    } catch {
      return [];
    }
    return names.includes(path.posix.basename(pat)) ? [pat] : [];
  }

  const dir = path.posix.dirname(pat);
  const rx = globToRegExp(path.posix.basename(pat));
  let entries;
  try {
    entries = readdirSync(path.join(ctxAbs, dir === '.' ? '' : dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!rx.test(e.name)) continue;
    const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...findLockfilesUnder(ctxAbs, rel, names));
    } else if (names.includes(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Absolute in-image paths a COPY instruction lands its lockfiles at.
 *
 * Docker requires the destination to be a directory whenever more than one
 * source file is delivered, which is every real case in this repo (`./`). The
 * single-source rename form (`COPY a.json /app/b.json`) is modelled as a
 * rename, so a lockfile copied to a different name correctly does NOT satisfy
 * the install.
 */
export function landedLockfiles(instruction, ctxAbs, workdir, names) {
  const srcs = copySources(instruction);
  const dest = copyDest(instruction);
  if (!srcs || dest === null) return [];
  const destAbs = resolveWorkdir(workdir, dest);

  const landed = [];
  for (const s of srcs) {
    const delivered = deliveredLockfiles(s, ctxAbs, names);
    if (delivered.length === 0) continue;
    const srcPat = s.replace(/^\.\//, '').replace(/\/+$/, '');

    // A DIRECTORY source always copies its CONTENTS into dest, so dest is a
    // directory regardless of whether it ends in `/`. Likewise a glob, or more
    // than one source operand: Docker requires a directory destination
    // whenever more than one file is delivered. Only the single-file form can
    // rename, and modelling that correctly is what makes
    // `COPY package-lock.json /app/other.json` fail as it should.
    const isDirSource =
      srcPat === '' ||
      srcPat === '.' ||
      (() => {
        try {
          return statSync(path.join(ctxAbs, srcPat)).isDirectory();
        } catch {
          return false;
        }
      })();
    const destIsDir =
      /\/$/.test(dest) ||
      dest === '.' ||
      dest === './' ||
      srcs.length > 1 ||
      srcPat.includes('*') ||
      srcPat.includes('?') ||
      isDirSource;

    for (const rel of delivered) {
      let leaf = path.posix.basename(rel);
      if (srcPat && srcPat !== '.' && rel !== srcPat && !srcPat.includes('*') && !srcPat.includes('?')) {
        // `COPY src ./src` — preserve the path beneath the copied directory.
        leaf = rel.slice(srcPat.length + 1);
      }
      landed.push({
        ctxRel: rel,
        imagePath: destIsDir ? path.posix.normalize(`${destAbs}/${leaf}`) : destAbs,
      });
    }
  }
  return landed;
}

/**
 * Would a .dockerignore at the context root exclude `rel` from the tarball?
 *
 * Models exact path, bare basename, `**\/name`, directory prefixes, and `!`
 * negation (last match wins, as Docker does). Not a full reimplementation —
 * see the header.
 */
export function dockerignoreExcludes(ignoreText, rel) {
  if (!ignoreText) return false;
  let excluded = false;
  const base = rel.split('/').pop();
  for (const raw of ignoreText.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pat = (negated ? line.slice(1) : line).trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pat) continue;
    const stripped = pat.startsWith('**/') ? pat.slice(3) : pat;
    const hit =
      globToRegExp(pat).test(rel) ||
      rel.startsWith(`${pat}/`) ||
      (!stripped.includes('/') && globToRegExp(stripped).test(base));
    if (hit) excluded = !negated;
  }
  return excluded;
}

/** Files tracked in git, as a Set of repo-relative POSIX paths. */
export function gitTrackedFiles(root = REPO_ROOT) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null; // git unavailable — R3 degrades to "cannot verify", reported.
  }
}

/** Every Dockerfile in the repo, as repo-relative POSIX paths. */
export function discoverDockerfiles(root = REPO_ROOT) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (/^Dockerfile(\.|$)/.test(e.name)) {
        found.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Derive the build context root for a Dockerfile: whichever of (its own
 * directory, the repo root) resolves more of its COPY sources. See header.
 * Returns { root, score, tried } with `root` repo-relative ('' = repo root).
 */
export function deriveContextRoot(dockerfileRel, stages, root = REPO_ROOT) {
  const dfDir = path.posix.dirname(dockerfileRel);
  const candidates = dfDir === '.' ? [''] : [dfDir, ''];
  const sources = [];
  for (const stage of stages) {
    for (const inst of stage.instructions) {
      const srcs = copySources(inst);
      if (srcs) sources.push(...srcs);
    }
  }
  // `.` resolves under every candidate, so it cannot discriminate between them.
  const discriminating = sources.filter((s) => s.replace(/^\.\//, '').replace(/\/+$/, '') !== '');

  // A Dockerfile whose only COPY is `.` offers no evidence either way. That is
  // not a failure — it is the ordinary self-contained shape — so it defaults to
  // the Dockerfile's own directory, the convention every such image in this
  // repo uses. `undiscriminated` is reported so a reader can tell a derived
  // answer from a defaulted one; R0 fires only when there IS evidence and none
  // of it resolves, which is the case where guessing would be wrong.
  if (discriminating.length === 0) {
    return { root: candidates[0], score: sources.length, undiscriminated: true, tried: [] };
  }

  const scored = candidates.map((cand) => {
    let score = 0;
    for (const src of discriminating) {
      const pat = src.replace(/^\.\//, '');
      const abs = path.join(root, cand, pat);
      if (pat.includes('*') || pat.includes('?')) {
        const dir = path.dirname(abs);
        const rx = globToRegExp(path.basename(pat));
        try {
          if (readdirSync(dir).some((f) => rx.test(f))) score += 1;
        } catch {
          /* unresolvable under this candidate */
        }
      } else if (existsSync(abs)) {
        score += 1;
      }
    }
    return { root: cand, score };
  });
  scored.sort((a, b) => b.score - a.score); // stable: candidates[0] wins ties
  return { ...scored[0], tried: scored };
}

/**
 * Evaluate one Dockerfile. Returns { problems, checks } — `checks` counts the
 * install sites actually examined, so the caller can refuse to pass vacuously.
 */
export function evaluateDockerfile({ dockerfileRel, text, tracked, root = REPO_ROOT }) {
  const problems = [];
  const stages = parseStages(text);
  let checks = 0;

  const hasInstall = stages.some((s) => s.instructions.some((i) => installKind(i)));
  if (!hasInstall) return { problems, checks, contextRoot: null };

  const ctx = deriveContextRoot(dockerfileRel, stages, root);
  if (ctx.score === 0) {
    problems.push(
      `${dockerfileRel}: R0 cannot derive a build context — no COPY source resolves under ` +
        `either the Dockerfile's directory or the repo root. The guard refuses to guess; ` +
        `if this image is built from some third context, that context is undiscoverable here.`
    );
    return { problems, checks, contextRoot: null };
  }

  const ctxAbs = path.join(root, ctx.root);
  const ignorePath = path.join(ctxAbs, '.dockerignore');
  const ignoreText = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const ctxRelToRepo = (p) => (ctx.root ? `${ctx.root}/${p}` : p);

  for (const stage of stages) {
    let workdir = '/';
    let landed = []; // lockfiles delivered into THIS stage, with in-image paths
    for (const inst of stage.instructions) {
      const wd = inst.match(/^WORKDIR\s+(.*)$/i);
      if (wd) {
        workdir = resolveWorkdir(workdir, wd[1]);
        continue;
      }

      if (/^(?:COPY|ADD)\s+/i.test(inst)) {
        const names = [...new Set(INSTALL_KINDS.flatMap((k) => k.lockfiles))];
        landed.push(...landedLockfiles(inst, ctxAbs, workdir, names));
        continue;
      }

      const kind = installKind(inst);
      if (!kind) continue;
      checks += 1;

      // `npm ci` reads the lockfile from the directory it runs in.
      const wanted = kind.lockfiles.map((lf) => path.posix.normalize(`${workdir}/${lf}`));
      const hit = landed.find((l) => wanted.includes(l.imagePath));

      if (!hit) {
        // Does a suitable lockfile exist ANYWHERE in the context? That tells
        // "you forgot to COPY it" apart from "it does not exist".
        const anywhere = findLockfilesUnder(ctxAbs, '', kind.lockfiles);
        const gen =
          kind.tool === 'npm'
            ? 'npm install --package-lock-only'
            : kind.tool === 'pnpm'
              ? 'pnpm install --lockfile-only'
              : 'yarn install';
        if (anywhere.length === 0) {
          problems.push(
            `${dockerfileRel} [stage ${stage.name}]: R2 runs a ${kind.tool} lockfile-strict ` +
              `install in ${workdir} but NO ${kind.lockfiles.join('/')} exists anywhere in its ` +
              `build context (${ctx.root || '<repo root>'}). Generate and COMMIT one ` +
              `(\`${gen}\`) — do NOT relax the install command, reproducibility is the ` +
              `point of \`${kind.tool === 'npm' ? 'npm ci' : '--frozen-lockfile'}\`.`
          );
        } else {
          problems.push(
            `${dockerfileRel} [stage ${stage.name}]: R1 runs a ${kind.tool} lockfile-strict ` +
              `install in ${workdir}, but no COPY earlier in THIS stage lands a lockfile there. ` +
              `Candidates present in the context: ${anywhere.slice(0, 4).map(ctxRelToRepo).join(', ')}. ` +
              `Each stage has its own filesystem, so an earlier stage's COPY does not count; ` +
              `and note \`COPY package*.json ./\` SUCCEEDS while matching only package.json.`
          );
        }
        continue;
      }

      // R3 / R4 — it lands in the right place; is it really in the context?
      const repoRel = ctxRelToRepo(hit.ctxRel);
      if (tracked && !tracked.has(repoRel)) {
        problems.push(
          `${dockerfileRel} [stage ${stage.name}]: R3 ${repoRel} exists on disk but is NOT ` +
            `tracked in git. A context staged with \`git archive HEAD | tar -x\` ` +
            `(deploy-copilot-evaluator-job.sh) would not contain it, and CI would never see ` +
            `it at all. \`git add\` it.`
        );
      }
      if (dockerignoreExcludes(ignoreText, hit.ctxRel)) {
        problems.push(
          `${dockerfileRel} [stage ${stage.name}]: R4 ${repoRel} is excluded by ` +
            `${ctx.root ? `${ctx.root}/` : ''}.dockerignore, so it is absent from the uploaded ` +
            `context even though it is committed — the COPY silently delivers nothing. ` +
            `Un-ignore it with a \`!\` negation line.`
        );
      }
    }
  }

  return { problems, checks, contextRoot: ctx.root };
}

function main() {
  const dockerfiles = discoverDockerfiles();
  const tracked = gitTrackedFiles();
  const problems = [];
  let totalChecks = 0;
  let withInstalls = 0;
  const rows = [];

  for (const rel of dockerfiles) {
    if (EXEMPT[rel]) {
      rows.push(`  EXEMPT  ${rel} — ${EXEMPT[rel]}`);
      continue;
    }
    const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const res = evaluateDockerfile({ dockerfileRel: rel, text, tracked });
    totalChecks += res.checks;
    if (res.checks > 0) {
      withInstalls += 1;
      rows.push(
        `  ${res.problems.length ? 'FAIL' : 'ok  '}    ${rel} ` +
          `(${res.checks} install site${res.checks === 1 ? '' : 's'}, ` +
          `context=${res.contextRoot || '<repo root>'})`
      );
    }
    problems.push(...res.problems);
  }

  console.log(`Dockerfiles scanned: ${dockerfiles.length}`);
  console.log(`Lockfile-strict Dockerfiles: ${withInstalls} (${totalChecks} install sites)`);
  for (const r of rows) console.log(r);

  if (tracked === null) {
    console.log('NOTE: git unavailable — R3 (lockfile is tracked) could not be evaluated.');
  }

  // Refuse to pass vacuously. A run that finds nothing to check is not a pass;
  // it is a broken discovery walk reporting success — the exact class this
  // repo keeps rediscovering (#2860, #2585).
  if (dockerfiles.length === 0 || totalChecks === 0) {
    console.error(
      `\nFAIL: discovery found ${dockerfiles.length} Dockerfile(s) and ${totalChecks} ` +
        `lockfile-strict install site(s). This guard cannot pass on an empty population — ` +
        `that would be a green light measuring nothing. Fix the walk (SKIP_DIRS?) or ` +
        `INSTALL_KINDS.`
    );
    process.exit(1);
  }

  if (problems.length) {
    console.error(`\nFAIL: ${problems.length} lockfile/build-context problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nWhy this blocks: \`npm ci\` / \`--frozen-lockfile\` exist to make the image ` +
        `reproducible. The fix is to commit the lockfile, never to downgrade the install ` +
        `command. Note that \`COPY package*.json ./\` SUCCEEDS while matching only ` +
        `package.json — the COPY is not what fails, the install one line later is.`
    );
    process.exit(1);
  }

  console.log('\nPASS: every lockfile-strict install has its lockfile in its build context.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
