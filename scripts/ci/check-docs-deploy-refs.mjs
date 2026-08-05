#!/usr/bin/env node
/**
 * check-docs-deploy-refs — every repo path a DEPLOYMENT doc tells a customer to
 * run must exist on disk.
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
 *   3. `gh workflow run <name>[.yml]`        — `<name>.yml` must exist
 *   4. `platform/fiab/bicep/...`             — must exist (allowing *.generated.*
 *                                              which is an OUTPUT, not a source)
 *
 * DELIBERATELY NOT CHECKED
 *   - bicep PARAMETER names. They are checked structurally elsewhere and a
 *     regex over prose produces false positives on English words. The
 *     parameter-name class (`existingPrivateDnsZones`, `loomAdminGroupObjectId`)
 *     is real but needs a different, name-listed guard.
 *
 * MUTATION PROOF (run these; both must behave as stated):
 *   1. Append a line `bash scripts/csa-loom/does-not-exist.sh` to
 *      docs/fiab/deployment/greenfield.md  ->  this guard exits 1 naming it.
 *   2. Remove it                            ->  this guard exits 0.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const ROOTS = ['docs/fiab/deployment', 'docs/fiab/runbooks'];

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
function mdFiles(dir) {
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

const failures = [];
let refCount = 0;
const files = ROOTS.flatMap(mdFiles).sort();

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const { kind, re, resolve } of EXTRACTORS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const target = resolve(m[1], m[1]).split('/').join(sep);
      const normalized = target.split(sep).join('/');
      refCount += 1;
      if (OUTPUT_PATTERNS.some((p) => p.test(normalized))) continue;
      if (existsSync(normalized)) continue;
      // 1-indexed line number of the match, for a clickable failure.
      const upto = text.slice(0, m.index).split(/\r?\n/).length;
      const src = lines[upto - 1] ?? '';
      if (AUTHORING_INSTRUCTION.test(src)) continue;
      failures.push({ file, line: upto, kind, ref: normalized, src: src.trim() });
    }
  }
}

console.log(`[docs-deploy-refs] scanned ${files.length} docs, ${refCount} repo references`);

if (failures.length > 0) {
  console.error(
    `\n[docs-deploy-refs] FAIL — ${failures.length} reference(s) in deployment/runbook docs do not exist on disk.\n` +
      'A customer following these pages hits "No such file or directory" on a step the doc presents as required.\n' +
      'Fix the doc to name what exists, or add the missing file. Do NOT add an exemption without a stated reason.\n',
  );
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}  [${f.kind}]  ${f.ref}`);
    if (f.src) console.error(`      > ${f.src.slice(0, 150)}`);
  }
  process.exit(1);
}

console.log('[docs-deploy-refs] OK — every script, workflow and bicep path referenced resolves.');
