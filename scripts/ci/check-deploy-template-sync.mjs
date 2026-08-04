#!/usr/bin/env node
/**
 * GUARDRAIL: every COMPILED ARM TEMPLATE committed to this repo must be
 * byte-identical to a fresh `az bicep build` of the bicep source it claims to
 * be compiled from.  (merge-blocker — #2945)
 *
 * WHY THIS EXISTS (#2945)
 * -----------------------
 * `apps/fiab-console/deploy-templates/main.json` is not source. It is the
 * COMPILED output of `platform/fiab/bicep/main.bicep`, committed by hand, and
 * it is the artifact that actually deploys:
 *
 *   - `apps/fiab-console/Dockerfile` COPYs it into the production console image
 *   - `lib/setup/user-arm-deploy.ts` (`resolveDlzTemplateInline`) submits it
 *     INLINE in the `Microsoft.Resources/deployments` PUT body
 *
 * …and NOTHING regenerated or verified it. So it drifted from its own source,
 * silently, and the drift shipped. When #2940 finally recompiled it, the diff
 * was 38 insertions / 15 deletions, and it contained FOUR already-merged fixes
 * that had never reached the deploying artifact:
 *
 *   1. `swa-publish-rbac` shipped a role definition GUID that does not exist
 *      (…706ee; real Website Contributor is …84772) — a role assignment against
 *      a non-existent GUID fails at deploy.
 *   2. `airflow` still pulled `apache/airflow` DIRECTLY FROM DOCKER HUB — the
 *      whole of #2682's ACR-mirroring supply-chain fix was inert in the shipped
 *      template, defeating the no-public-egress posture in sovereign estates.
 *   3. the dbt runner used the console image tag.
 *   4. the DNS resolver still hard-coded a static IP.
 *
 * That is this repo's dominant defect class — the INERT FIX (#2729 CVE floors
 * that never reached the image, #2781, #2816). Code merges, every gate is
 * green, and the thing that deploys does not carry it. Re-syncing the file
 * fixed those four; only a gate stops the fifth.
 *
 * THE RULE
 * --------
 * For each entry in {@link ARTIFACTS}: compile `source` with the SAME bicep CLI
 * version the committed artifact was produced by, and require the result to be
 * BYTE-IDENTICAL to the committed bytes. Any difference fails.
 *
 * DETERMINISM — what varies, measured, and what is (not) normalized
 * ----------------------------------------------------------------
 * `az bicep build` output is NOT stable across bicep CLI versions. Measured on
 * 2026-08-04 by compiling `platform/fiab/bicep/main.bicep` with bicep 0.45.15
 * and again with 0.46.1 and diffing the two:
 *
 *     total changed lines: 840   non-`_generator` changed lines: 0
 *
 * i.e. every difference was a `metadata._generator.version` or
 * `metadata._generator.templateHash` line, across the 420 nested `_generator`
 * blocks. `templateHash` moves with the CLI version too — it is not only
 * content-derived — so a version-tolerant comparison would have to mask BOTH.
 *
 * This guard masks NEITHER. It does not normalize anything: the verdict is
 * `Buffer.equals`, over the raw bytes, with `templateHash` included. Instead of
 * loosening the comparison it PINS THE COMPILER: the required CLI version is
 * read out of the committed artifact's own `metadata._generator.version`
 * (`0.45.15.27210` → `v0.45.15`) and installed before compiling. That is:
 *
 *   - deterministic — the same input compiler produces the same output bytes;
 *   - free of false REDs — a new bicep release does not break the gate, and
 *     when someone regenerates with a newer bicep the stamp moves and the gate
 *     follows it;
 *   - impossible to launder a content change through — the source compiled is
 *     always the CURRENT source, so a stale artifact still fails no matter
 *     which compiler version it declares.
 *
 * A mask over `templateHash` would have been the tempting shortcut and is
 * exactly the over-normalization the issue warns about: `templateHash` is the
 * only field that would reveal a hand-edit to a nested module's emitted body if
 * a future comparison ever stopped being byte-exact.
 *
 * LINE ENDINGS are fixed at the SOURCE, not in the comparator. `az bicep build`
 * always writes LF; `.gitattributes` pins the committed artifact to
 * `text eol=lf` (same treatment as `sdk/**` and the apps-catalog fixture) so a
 * CRLF checkout cannot manufacture a diff. The comparator still refuses to pass
 * an EOL-only difference — it only CLASSIFIES it, so the message can say
 * "your checkout predates the pin" instead of dumping 60k changed lines. A
 * comparator that normalized EOLs to a PASS is the "and vice-versa" half of the
 * same bug: it would also swallow a real change that happened to alter only
 * whitespace.
 *
 * REFUSES TO PASS VACUOUSLY (2026-07-28 "gates that measure nothing"):
 *   - `az` missing / `az bicep build` non-zero  → FAIL, never skip.
 *   - build produced no file, an empty file, or something that is not an ARM
 *     template → FAIL. (`scripts/csa-loom/gov-verify-evidence.sh` already
 *     documents "bicep build did not produce" as a real observed failure mode.)
 *   - the pinned CLI version could not be made active → FAIL. Compiling with
 *     the wrong compiler would compare two things that were never comparable.
 *   - {@link ARTIFACTS} empty, or a `deploy-templates/*.json` found on disk
 *     that no entry covers → FAIL. A second unguarded compiled artifact is the
 *     same bug in a new costume.
 *
 * REGENERATE (this is the exact command the failure prints):
 *     az bicep build -f platform/fiab/bicep/main.bicep \
 *       --outfile apps/fiab-console/deploy-templates/main.json
 *
 * Usage: node scripts/ci/check-deploy-template-sync.mjs [repo-root]
 *   The optional argument exists for the self-test; CI passes nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Every committed compiled-ARM artifact, and the bicep it is compiled from.
 *
 * `discover()` cross-checks this table against what is on disk, so adding a
 * new `deploy-templates/*.json` without adding it here FAILS the guard.
 */
export const ARTIFACTS = [
  {
    artifact: 'apps/fiab-console/deploy-templates/main.json',
    source: 'platform/fiab/bicep/main.bicep',
    why: 'COPYd into the console image (Dockerfile) and submitted INLINE to ARM by lib/setup/user-arm-deploy.ts',
  },
];

/** Where compiled ARM artifacts are allowed to live, for the coverage cross-check. */
const DEPLOY_TEMPLATE_DIRS = ['apps'];
const DEPLOY_TEMPLATE_LEAF = 'deploy-templates';

// ── pure helpers (exported for scripts/ci/__tests__/deploy-template-sync.test.mjs) ──

/**
 * Read `metadata._generator.version` out of a compiled ARM template and derive
 * the bicep CLI version that produced it.
 *
 * bicep stamps a FOUR-part build number (`0.45.15.27210`); the CLI is released
 * and installed by its three-part version (`v0.45.15`). Measured against real
 * output from both 0.45.15 and 0.46.1.
 *
 * @param {Buffer|string} artifact raw bytes of the compiled template
 * @returns {{stamped: string, cli: string}}
 * @throws {Error} when the stamp is absent — an artifact with no provenance
 *   cannot be verified, and guessing a version would compare two things that
 *   were never comparable.
 */
export function parseGeneratorVersion(artifact) {
  const head = Buffer.isBuffer(artifact)
    ? artifact.subarray(0, 4096).toString('utf8')
    : String(artifact).slice(0, 4096);
  const m = head.match(/"_generator"\s*:\s*\{[\s\S]*?"version"\s*:\s*"(\d+\.\d+\.\d+)(?:\.\d+)?"/);
  if (!m) {
    throw new Error(
      'no metadata._generator.version in the committed artifact — cannot determine which bicep CLI produced it',
    );
  }
  return { stamped: m[0].match(/"version"\s*:\s*"([^"]+)"/)[1], cli: `v${m[1]}` };
}

/**
 * Parse `az bicep version` STDOUT.
 *
 * The literal captured on 2026-08-04 is
 * `'Bicep CLI version 0.45.15 (6a4a640fd8)\r\r\n\r\n'` — note the DOUBLE CR,
 * which a naive `split('\n')[0].trim()` handles but a `=== ` comparison against
 * a hand-written expectation does not. The upgrade-available WARNING goes to
 * STDERR, so it must not be parsed as the version.
 *
 * @param {string} stdout
 * @returns {string|null} e.g. `'0.45.15'`
 */
export function parseBicepCliVersion(stdout) {
  const m = String(stdout || '').match(/Bicep CLI version\s+(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** @param {Buffer} b @returns {Buffer} the same bytes with every CR removed */
function stripCr(b) {
  return Buffer.from(b.toString('binary').replace(/\r/g, ''), 'binary');
}

/**
 * Byte-compare a committed artifact against a freshly compiled one.
 *
 * THE VERDICT IS `Buffer.equals` OVER RAW BYTES. Nothing is normalized, folded
 * or reparsed before it. The CR-stripped comparison below runs only AFTER the
 * verdict is already "not equal", and only to label WHICH kind of difference it
 * is so the message is useful — it can never turn a failure into a pass.
 *
 * @param {Buffer} committed
 * @param {Buffer} fresh
 * @returns {{equal: boolean, reason: 'identical'|'eol'|'content', report: string[]}}
 */
export function compareArtifacts(committed, fresh) {
  if (committed.equals(fresh)) return { equal: true, reason: 'identical', report: [] };

  if (stripCr(committed).equals(stripCr(fresh))) {
    return {
      equal: false,
      reason: 'eol',
      report: [
        'The committed artifact differs from a fresh build ONLY in line endings.',
        `  committed: ${committed.length} bytes, ${(committed.toString('binary').match(/\r\n/g) || []).length} CRLF`,
        `  fresh:     ${fresh.length} bytes, ${(fresh.toString('binary').match(/\r\n/g) || []).length} CRLF`,
        'This is a CHECKOUT problem, not a content problem: `az bicep build` always',
        'writes LF and .gitattributes pins this file to `text eol=lf`. Your working',
        'tree predates that pin. Fix it WITHOUT touching content:',
        '    git add --renormalize apps/fiab-console/deploy-templates/main.json',
        'It is reported as a FAILURE and not silently normalized on purpose — a',
        'comparator loose enough to pass this is loose enough to hide a real change.',
      ],
    };
  }

  return { equal: false, reason: 'content', report: contentReport(committed, fresh) };
}

/**
 * A bounded, honest description of a content difference.
 *
 * Deliberately NOT a full LCS diff: the artifact is ~60k lines, and after the
 * first insertion an index-wise walk reports everything below it as changed,
 * which would be a misleading "60000 lines differ". So this reports two things
 * that are each true on their own terms and labelled as such:
 *   - the FIRST line index where the two files diverge, with a small window;
 *   - an order-insensitive multiset difference (lines only in one side), which
 *     is what "38 insertions / 15 deletions" in #2945 actually described.
 *
 * @param {Buffer} committed @param {Buffer} fresh @returns {string[]}
 */
function contentReport(committed, fresh) {
  const a = committed.toString('utf8').split('\n');
  const b = fresh.toString('utf8').split('\n');
  const out = [];

  let first = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      first = i;
      break;
    }
  }

  out.push(`Line counts: committed ${a.length}, fresh ${b.length}.`);
  if (first >= 0) {
    out.push(`First divergence at line ${first + 1}:`);
    for (let i = Math.max(0, first - 3); i <= Math.min(Math.max(a.length, b.length) - 1, first + 3); i++) {
      const mark = a[i] === b[i] ? ' ' : '!';
      out.push(`  ${mark} ${String(i + 1).padStart(6)} committed | ${trunc(a[i])}`);
      if (a[i] !== b[i]) out.push(`  ${mark} ${String(i + 1).padStart(6)} fresh     | ${trunc(b[i])}`);
    }
  }

  const countOf = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const ca = countOf(a);
  const cb = countOf(b);
  const onlyFresh = [];
  const onlyCommitted = [];
  for (const [l, n] of cb) {
    const d = n - (ca.get(l) || 0);
    for (let i = 0; i < d; i++) onlyFresh.push(l);
  }
  for (const [l, n] of ca) {
    const d = n - (cb.get(l) || 0);
    for (let i = 0; i < d; i++) onlyCommitted.push(l);
  }
  out.push(
    `Multiset difference: ${onlyFresh.length} line(s) the fresh build emits that the committed copy lacks, ` +
      `${onlyCommitted.length} the committed copy has that the fresh build does not.`,
  );
  const sample = (label, arr) => {
    for (const l of arr.slice(0, 12)) out.push(`  ${label} ${trunc(l)}`);
    if (arr.length > 12) out.push(`  ${label} … and ${arr.length - 12} more`);
  };
  sample('+', onlyFresh);
  sample('-', onlyCommitted);
  return out;
}

/** @param {string|undefined} s */
function trunc(s) {
  if (s === undefined) return '<no such line>';
  const t = s.replace(/\r/g, '\\r');
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

/**
 * Count JSON-escaped CRLF sequences (the four characters `\` `r` `\` `n`) inside
 * the template's string VALUES.
 *
 * FOUND BY THIS GUARD'S FIRST REAL CI RUN, 2026-08-04. bicep embeds the line
 * endings of its own source into emitted strings: a `'''…'''` multi-line literal
 * in a .bicep file, and every file pulled in by `loadTextContent()`, are copied
 * byte-for-byte. So the artifact committed on main — generated on a Windows
 * checkout — carried 1195 escaped CRLFs inside its embedded bash, PowerShell,
 * Python and KQL, including
 *
 *     "scriptContent": "set -euo pipefail\r\nGRAPH_RA='…"
 *
 * i.e. a CRLF bash script handed to an ARM deploymentScript, which is the exact
 * `$'\r': command not found` failure `.gitattributes` already pins .sh files
 * against. A Linux build of the same commit emitted LF. That is not cosmetic and
 * it is not a checkout artifact of the JSON file itself (which is LF on both).
 *
 * `platform/fiab/bicep/** text eol=lf` now makes the compile platform-independent.
 * This check exists so that if the pin is ever lost, or a new embedded source
 * lands outside it, the failure NAMES the cause instead of printing an opaque
 * 51-line diff.
 *
 * @param {Buffer} buf @returns {number}
 */
export function countEscapedCrlf(buf) {
  return buf.length ? buf.toString('binary').split('\\r\\n').length - 1 : 0;
}

/**
 * Refuse to compare against something that is not a compiled ARM template.
 *
 * `az bicep build` exiting 0 while producing nothing usable is a real, observed
 * failure mode in this repo (see the "bicep build did not produce" branch in
 * scripts/csa-loom/gov-verify-evidence.sh). Without this, that shape would make
 * the guard compare two empty buffers and report success.
 *
 * @param {Buffer} buf @param {string} label
 * @throws {Error}
 */
export function assertLooksLikeArmTemplate(buf, label) {
  if (!buf || buf.length === 0) throw new Error(`${label} is empty`);
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${e.message})`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${label} is not a JSON object`);
  // Both `deploymentTemplate.json#` (RG scope) and `subscriptionDeploymentTemplate.json#`
  // (this artifact's scope) — matched case-insensitively so the sub-scope form,
  // which capitalises the D, is not read as "not an ARM template".
  if (typeof parsed.$schema !== 'string' || !/deploymentTemplate\.json/i.test(parsed.$schema)) {
    throw new Error(`${label} has no ARM deploymentTemplate $schema (got ${JSON.stringify(parsed.$schema)})`);
  }
  if (parsed.resources === undefined) throw new Error(`${label} has no "resources"`);
}

/**
 * Every `deploy-templates/*.json` under a top-level app dir, repo-relative with
 * `/` separators.
 * @param {string} root @returns {string[]}
 */
export function discoverDeployTemplates(root) {
  const found = [];
  for (const top of DEPLOY_TEMPLATE_DIRS) {
    const base = path.join(root, top);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name, DEPLOY_TEMPLATE_LEAF);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) found.push(`${top}/${entry.name}/${DEPLOY_TEMPLATE_LEAF}/${f}`);
      }
    }
  }
  return found.sort();
}

// ── az plumbing ──────────────────────────────────────────────────────────────

/**
 * Run `az` with args. NO output is discarded: stderr is captured and surfaced
 * on failure. (`2>/dev/null` on a mutating command is how #2836/#2855 stayed
 * invisible; it does not appear anywhere in this guard.)
 *
 * @param {string[]} args @returns {{status: number|null, stdout: string, stderr: string, error?: Error}}
 */
function runAz(args) {
  const opts = { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 };
  // On Windows `az` is a .cmd, which Node refuses to spawn without a shell; pass
  // ONE pre-quoted command string rather than an args array so this does not trip
  // DEP0190 (args + shell:true are concatenated unescaped).
  const res =
    process.platform === 'win32'
      ? spawnSync(['az', ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), {
          ...opts,
          shell: true,
        })
      : spawnSync('az', args, opts);
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

/**
 * Make `wantCli` (e.g. `v0.45.15`) the active bicep CLI, installing it if the
 * active one differs. Throws if it cannot be made active — compiling with a
 * different compiler would compare two artifacts that were never comparable,
 * which is worse than not checking at all because it reads as a verdict.
 *
 * @param {string} wantCli @param {(m: string) => void} log
 */
function ensureBicepVersion(wantCli, log) {
  const want = wantCli.replace(/^v/, '');
  const probe = runAz(['bicep', 'version']);
  if (probe.error) {
    throw new Error(
      `could not run \`az\` (${probe.error.message}). This guard COMPILES the template; it cannot verify without the Azure CLI, and it will not pass without verifying.`,
    );
  }
  const active = parseBicepCliVersion(probe.stdout);
  if (active === want) {
    log(`bicep CLI ${active} already active (pinned by the artifact's own _generator stamp)`);
    return;
  }
  log(`bicep CLI is ${active ?? 'not installed'}; installing the pinned ${wantCli}`);
  const inst = runAz(['bicep', 'install', '--version', wantCli]);
  if (inst.status !== 0) {
    throw new Error(
      `\`az bicep install --version ${wantCli}\` failed (exit ${inst.status}).\n${inst.stderr.trim()}\n` +
        `The committed artifact declares it was built by bicep ${want}. If that release is gone, regenerate the artifact with a currently installable bicep and commit the result.`,
    );
  }
  const after = parseBicepCliVersion(runAz(['bicep', 'version']).stdout);
  if (after !== want) {
    throw new Error(`installed bicep ${wantCli} but \`az bicep version\` still reports ${after ?? 'nothing'}`);
  }
}

/**
 * Compile `srcAbs` into a fresh temp dir and return the bytes.
 *
 * mkdtemp (not a fixed name under a shared temp root) — see
 * scripts/ci/check-temp-artifact-safety.mjs.
 *
 * @param {string} srcAbs @returns {Buffer}
 */
function compile(srcAbs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tmplsync-'));
  const out = path.join(dir, 'compiled.json');
  try {
    const res = runAz(['bicep', 'build', '-f', srcAbs, '--outfile', out]);
    if (res.error) throw new Error(`could not run \`az bicep build\`: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`\`az bicep build\` failed (exit ${res.status}).\n${res.stderr.trim().slice(-4000)}`);
    }
    if (!fs.existsSync(out)) {
      throw new Error('`az bicep build` exited 0 but produced no output file');
    }
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(root = process.cwd()) {
  const fail = [];
  const log = (m) => console.log(`[deploy-template-sync] ${m}`);

  if (ARTIFACTS.length === 0) {
    console.error('[deploy-template-sync] FAIL — ARTIFACTS is empty; this guard would check nothing.');
    process.exit(1);
  }

  // Coverage: a compiled artifact on disk that no entry claims is unguarded.
  const declared = new Set(ARTIFACTS.map((a) => a.artifact));
  const onDisk = discoverDeployTemplates(root);
  for (const f of onDisk) {
    if (!declared.has(f)) {
      fail.push(
        `${f} is a committed compiled template that no ARTIFACTS entry covers. Add it (with its bicep source) to scripts/ci/check-deploy-template-sync.mjs — an unguarded compiled artifact is the #2945 bug in a new costume.`,
      );
    }
  }

  for (const entry of ARTIFACTS) {
    const artAbs = path.join(root, entry.artifact);
    const srcAbs = path.join(root, entry.source);
    if (!fs.existsSync(artAbs)) {
      fail.push(`${entry.artifact} is missing (declared in ARTIFACTS).`);
      continue;
    }
    if (!fs.existsSync(srcAbs)) {
      fail.push(`${entry.source} is missing — ${entry.artifact} cannot be verified against its source.`);
      continue;
    }

    let committed;
    try {
      committed = fs.readFileSync(artAbs);
      assertLooksLikeArmTemplate(committed, entry.artifact);
    } catch (e) {
      fail.push(`${entry.artifact}: ${e.message}`);
      continue;
    }

    let pinned;
    try {
      pinned = parseGeneratorVersion(committed);
      ensureBicepVersion(pinned.cli, log);
    } catch (e) {
      fail.push(`${entry.artifact}: ${e.message}`);
      continue;
    }

    let fresh;
    try {
      log(`compiling ${entry.source} with bicep ${pinned.cli} …`);
      fresh = compile(srcAbs);
      assertLooksLikeArmTemplate(fresh, `fresh build of ${entry.source}`);
    } catch (e) {
      fail.push(`${entry.artifact}: ${e.message}`);
      continue;
    }

    const cmp = compareArtifacts(committed, fresh);

    // Name the CRLF-embedded-source cause before reporting an opaque byte diff.
    // Order matters: if the FRESH build has them, the compiling checkout's bicep
    // sources are CRLF (the developer's environment); if only the COMMITTED copy
    // has them, the artifact was generated from such a checkout and shipped.
    const freshCrlf = countEscapedCrlf(fresh);
    const committedCrlf = countEscapedCrlf(committed);
    if (freshCrlf > 0) {
      fail.push(
        `A fresh build of ${entry.source} embeds ${freshCrlf} CRLF sequence(s) inside its string values.\n` +
          '  bicep copies the line endings of its own source into emitted strings, so your bicep\n' +
          '  checkout is CRLF. `.gitattributes` pins `platform/fiab/bicep/** text eol=lf`; refresh it:\n' +
          '    git ls-files platform/fiab/bicep | xargs rm -f && git checkout -- platform/fiab/bicep\n' +
          '  Shipping this would hand ARM deploymentScripts CRLF bash ("$\'\\r\': command not found").',
      );
      continue;
    }
    if (committedCrlf > 0) {
      fail.push(
        `${entry.artifact} embeds ${committedCrlf} CRLF sequence(s) inside its string values — it was\n` +
          '  generated from a CRLF bicep checkout. Regenerate it from an LF checkout (see the command\n' +
          `  below); a fresh build of the same source here embeds none.\n` +
          `    az bicep build -f ${entry.source} --outfile ${entry.artifact}`,
      );
      continue;
    }

    if (cmp.equal) {
      log(`OK — ${entry.artifact} is byte-identical to a fresh build (${committed.length} bytes, bicep ${pinned.stamped}).`);
      continue;
    }
    fail.push(
      [
        `${entry.artifact} is STALE (${cmp.reason} difference).`,
        `  source:  ${entry.source}`,
        `  ships as: ${entry.why}`,
        ...cmp.report.map((l) => `  ${l}`),
        '',
        '  REGENERATE AND COMMIT:',
        `    az bicep build -f ${entry.source} --outfile ${entry.artifact}`,
      ].join('\n'),
    );
  }

  if (fail.length) {
    console.error('\n::error::deploy-template-sync — a compiled ARM template that SHIPS does not match its bicep source.');
    for (const f of fail) console.error(`\n${f}`);
    console.error(
      '\nThis is the #2945 class: the code merged, the artifact that deploys did not carry it.\n',
    );
    process.exit(1);
  }

  log(`PASS — ${ARTIFACTS.length} compiled template(s) verified, ${onDisk.length} found on disk.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
}
