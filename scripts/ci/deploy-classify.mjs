#!/usr/bin/env node
/**
 * deploy-classify.mjs — the Node consumer of THE deployment failure taxonomy.
 *
 * Reads `apps/fiab-console/lib/deploy/failure-taxonomy.json` — the same file
 * `apps/fiab-console/lib/deploy/failure-taxonomy.ts` imports. One table, two
 * consumers, no drift possible in the DATA.
 *
 * The matching ALGORITHM is necessarily written twice (a .mjs cannot import a
 * .ts, and the console cannot import from scripts/ because its image build
 * context is apps/fiab-console). So the two implementations are pinned to one
 * another by a shared corpus: `apps/fiab-console/lib/deploy/__fixtures__/
 * failure-corpus.json` carries the input AND the expected verdict, the vitest
 * suite runs the TS classifier over it, and this file's node:test suite runs
 * THIS classifier over it. Either implementation drifting turns its own suite
 * red. A byte-compare of two tables would not have caught an algorithm drift;
 * this does.
 *
 * WHAT IT IS FOR (deploy-integrity.md R6/R7)
 *
 *   Classify: transient | eventual-consistency | registration | permission |
 *             quota | config | defect | unknown
 *
 *   `unknown` is NOT `defect` and is NOT a pass. It exits non-zero saying it
 *   could not classify the failure and asserting nothing about its cause —
 *   R7. Silently treating unknown as retryable is how a retry-that-cannot-fail
 *   is born.
 *
 * USAGE
 *   az deployment sub create … 2>err.txt || \
 *     node scripts/ci/deploy-classify.mjs --file err.txt --step "provision"
 *
 *   node scripts/ci/deploy-classify.mjs --stdin --json --query   # data, exit 0
 *
 *   Exit code is the CLASS exit code (10..17) so a caller can branch without
 *   parsing stdout. `--query` forces exit 0 for callers that only want the data
 *   (used by deploy-retry.mjs's tests; never by a gate).
 *
 * Tests: node --test scripts/ci/__tests__/deploy-classify.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const TAXONOMY_PATH = path.join(
  REPO_ROOT,
  'apps',
  'fiab-console',
  'lib',
  'deploy',
  'failure-taxonomy.json',
);

/** Longest line quoted back as evidence — must match the TS EVIDENCE_LINE_CAP. */
export const EVIDENCE_LINE_CAP = 400;

function loadTaxonomy(file = TAXONOMY_PATH) {
  // No try/catch: a missing or malformed taxonomy is a hard failure, not a
  // silent fallback to "everything is unknown". A classifier that quietly
  // degrades to unknown-for-everything reads green while measuring nothing.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.classes?.unknown) {
    throw new Error(`failure-taxonomy.json has no "unknown" class — ${file}`);
  }
  if (!Array.isArray(parsed.signals) || parsed.signals.length === 0) {
    throw new Error(`failure-taxonomy.json has no signals — ${file}`);
  }
  if (!Array.isArray(parsed.classPrecedence) || parsed.classPrecedence.length === 0) {
    throw new Error(`failure-taxonomy.json has no classPrecedence — ${file}`);
  }
  return parsed;
}

export const TAXONOMY = loadTaxonomy();

export function isRetryableClass(cls, tax = TAXONOMY) {
  return tax.classes[cls]?.retryable === true;
}

export function classExitCode(cls, tax = TAXONOMY) {
  return tax.classes[cls]?.exitCode ?? tax.classes.unknown.exitCode;
}

function signalRank(sig, indexInFile, tax) {
  const idx = tax.classPrecedence.indexOf(sig.class);
  // Absent from classPrecedence would sort FIRST at -1 and outrank `defect`.
  // Sort it LAST instead; check-deploy-failure-handling.mjs fails the build for
  // the missing entry separately.
  const safe = idx === -1 ? tax.classPrecedence.length : idx;
  return safe * 10_000 + indexInFile;
}

function lineFor(lines, lowerLines, needle) {
  const i = lowerLines.findIndex((l) => l.includes(needle));
  const raw = i === -1 ? '' : lines[i].trim();
  return raw.length > EVIDENCE_LINE_CAP ? `${raw.slice(0, EVIDENCE_LINE_CAP)}…` : raw;
}

function unknownDiagnosis(tax) {
  const meta = tax.classes.unknown;
  return {
    class: 'unknown',
    signalId: null,
    label: meta.label,
    summary: meta.summary,
    retryable: false,
    retryableAfterRemediation: false,
    evidence: [],
    remediationKind: null,
    remediation: null,
    exitCode: meta.exitCode,
    defaultMaxAttempts: meta.defaultMaxAttempts,
    defaultBackoffSeconds: meta.defaultBackoffSeconds,
  };
}

/**
 * Classify a failure from tool output. Never throws on input; an empty or
 * unreadable input is `unknown`, which fails closed.
 */
export function classify(text, tax = TAXONOMY) {
  const raw = typeof text === 'string' ? text : '';
  const lower = raw.toLowerCase();
  const lines = raw.split(/\r?\n/);
  const lowerLines = lines.map((l) => l.toLowerCase());

  const matches = [];
  tax.signals.forEach((sig, i) => {
    if (sig.not?.some((n) => lower.includes(n))) return;
    if (sig.allOf && !sig.allOf.every((a) => lower.includes(a))) return;
    const hitAny = (sig.anyOf ?? []).filter((a) => lower.includes(a));
    if ((sig.anyOf?.length ?? 0) > 0 && hitAny.length === 0) return;
    if (!sig.anyOf?.length && !sig.allOf?.length) return; // would match everything
    const hits = [...hitAny, ...(sig.allOf ?? [])];
    matches.push({
      sig,
      rank: signalRank(sig, i, tax),
      evidence: hits.map((h) => ({ signal: h, line: lineFor(lines, lowerLines, h) })),
    });
  });

  if (matches.length === 0) return unknownDiagnosis(tax);
  matches.sort((a, b) => a.rank - b.rank);
  const win = matches[0];
  const meta = tax.classes[win.sig.class];
  if (!meta) return unknownDiagnosis(tax);

  return {
    class: win.sig.class,
    signalId: win.sig.id,
    label: meta.label,
    summary: meta.summary,
    retryable: meta.retryable === true,
    retryableAfterRemediation: meta.retryableAfterRemediation === true,
    evidence: win.evidence,
    remediationKind: win.sig.remediationKind ?? null,
    remediation: win.sig.remediation ?? null,
    ...(win.sig.grantHint ? { grantHint: win.sig.grantHint } : {}),
    ...(win.sig.portalPath ? { portalPath: win.sig.portalPath } : {}),
    exitCode: meta.exitCode,
    defaultMaxAttempts: meta.defaultMaxAttempts,
    defaultBackoffSeconds: meta.defaultBackoffSeconds,
  };
}

/**
 * Classify EACH ARM leaf error separately (D6, run 31100384405).
 *
 * classify() over a concatenated multi-leaf input returns ONE winner by class
 * precedence — correct for a single stderr, wrong for a deployment that failed
 * for several INDEPENDENT reasons at once. On run 31100384405 a retryable
 * CapacityNotAvailable leaf (DuckLake Postgres, centralus zone) was never
 * retried because an unrelated InvalidTemplate leaf classed the whole run
 * `defect`. Per-leaf classification keeps each cause's own class, retryability
 * and remediation; deploy-retry.mjs decides from the SET.
 *
 * @param {Array<{code?:string|null, message?:string, resourceType?:string|null, resourceName?:string|null}>} leaves
 *        The `leaves` array from deploy-arm-errors.mjs collectArmLeafErrors().
 * @returns {Array<{leaf:object, diagnosis:object}>}
 */
export function classifyLeaves(leaves, tax = TAXONOMY) {
  return (Array.isArray(leaves) ? leaves : []).map((leaf) => {
    const where = leaf?.resourceType
      ? ` [${leaf.resourceType}${leaf.resourceName ? ` '${leaf.resourceName}'` : ''}]`
      : '';
    const text = `${leaf?.code ?? 'NoCode'}: ${leaf?.message ?? ''}${where}`;
    return { leaf: leaf ?? {}, diagnosis: classify(text, tax) };
  });
}

/**
 * The single WORST diagnosis of a leaf set, by the same classPrecedence rule a
 * concatenated classify() would use — so the headline the operator sees stays
 * the fail-fast one even when the retry decision is made per leaf. `unknown`
 * (absent from classPrecedence) deliberately sorts LAST here and wins only
 * when every leaf is unknown — an unknown among knowns must not bury a named
 * cause, while an all-unknown set must still fail closed as unknown.
 */
export function worstLeafDiagnosis(leafDiagnoses, tax = TAXONOMY) {
  const list = Array.isArray(leafDiagnoses) ? leafDiagnoses.filter((l) => l?.diagnosis) : [];
  if (list.length === 0) return null;
  const rank = (cls) => {
    const i = tax.classPrecedence.indexOf(cls);
    return i === -1 ? tax.classPrecedence.length : i;
  };
  return [...list].sort((a, b) => rank(a.diagnosis.class) - rank(b.diagnosis.class))[0].diagnosis;
}

/**
 * The operator-facing message. It may state as fact ONLY what is in
 * `evidence[]`. `unknown` says it does not know and names no cause (R7).
 */
export function render(d, step) {
  const where = step ? ` in ${step}` : '';
  if (d.class === 'unknown') {
    return (
      `Could not classify this failure${where}. No cause is asserted: nothing in the ` +
      'output matched a known Azure failure signal. This is a gap in the CSA Loom ' +
      'failure taxonomy (apps/fiab-console/lib/deploy/failure-taxonomy.json). Attach ' +
      'this run to a new issue labelled deploy-integrity so the signal can be added.'
    );
  }
  const observed = d.evidence.length
    ? `Established from the output: ${d.evidence.map((e) => `"${e.signal}"`).join(', ')}.`
    : 'No evidence recorded.';
  const parts = [`${d.label}${where}. ${d.summary}`, observed];
  if (d.remediation) parts.push(`Remediation: ${d.remediation}`);
  if (d.grantHint) parts.push(`Command: ${d.grantHint}`);
  if (d.portalPath) parts.push(`Portal: ${d.portalPath}`);
  return parts.join(' ');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    file: null,
    stdin: false,
    json: false,
    query: false,
    step: null,
    text: null,
    assertSignal: null,
    assertClass: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--stdin') out.stdin = true;
    else if (a === '--json') out.json = true;
    else if (a === '--query') out.query = true;
    else if (a === '--step') out.step = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--assert-signal') out.assertSignal = argv[++i];
    else if (a === '--assert-class') out.assertClass = argv[++i];
  }
  return out;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  let text = args.text ?? '';
  if (args.file) {
    // A missing file is NOT an empty file. Say which it is rather than
    // classifying "" and reporting `unknown` about a file we never read.
    if (!fs.existsSync(args.file)) {
      process.stderr.write(
        `deploy-classify: cannot read '${args.file}' — the file does not exist. ` +
          'Nothing classified; no cause asserted.\n',
      );
      process.exit(2);
    }
    text = fs.readFileSync(args.file, 'utf8');
  } else if (args.stdin) {
    text = readStdin();
  }

  const d = classify(text);

  // --assert-signal / --assert-class turn this into a THREE-STATE probe for a
  // shell caller: exit 0 only when the taxonomy POSITIVELY establishes the
  // named outcome. Anything else — a different signal, or `unknown` — exits
  // non-zero, so a caller can never render "could not read" as "does not
  // exist". This is the shell-side of deploy-integrity.md R7.
  if (args.assertSignal || args.assertClass) {
    const want = args.assertSignal ?? args.assertClass;
    const got = args.assertSignal ? d.signalId : d.class;
    if (got === want) {
      process.stdout.write(args.json ? `${JSON.stringify(d, null, 2)}\n` : `${render(d, args.step)}\n`);
      process.exit(0);
    }
    process.stderr.write(
      `deploy-classify: expected ${args.assertSignal ? 'signal' : 'class'} "${want}" but established ` +
        `"${got ?? 'nothing'}". ${render(d, args.step)}\n`,
    );
    process.exit(d.exitCode);
  }

  process.stdout.write(args.json ? `${JSON.stringify(d, null, 2)}\n` : `${render(d, args.step)}\n`);
  process.exit(args.query ? 0 : d.exitCode);
}
