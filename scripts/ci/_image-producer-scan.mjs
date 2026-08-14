/**
 * _image-producer-scan — the shared line scanner behind the two image-producer
 * guards.
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT RE-ADD ONE. This module is `import`ed by
 * scripts/ci/__tests__/*.test.mjs; the note on _workflow-yaml.mjs explains why
 * a `#!` line breaks that.
 *
 * WHY THIS EXISTS. check-image-producer-coverage.mjs (#2619) answers "is this
 * image built AT ALL"; check-gov-image-producer-parity.mjs (#3416) answers "is
 * it built for AZURE GOVERNMENT too". Both questions are decided by the same
 * three predicates — is this workflow a builder, does this line reach a build,
 * and is this workflow authenticated to the sovereign cloud. Written twice they
 * would drift, and a drifted second copy is exactly the shape of
 * `csa_loom_guard_adoption_gap`: the correct helper existed and the sibling
 * never adopted it. One implementation, two callers.
 *
 * ── LOGICAL LINES (#3420 / #3427) ──────────────────────────────────────────
 * This module folds backslash continuations before judging anything, via the
 * shared `_logical-lines.mjs` primitive. Both callers therefore contain no
 * line-splitting of their own; check-guard-logical-lines.mjs classifies them
 * `out-of-scope` for that reason, so THIS file is where the decision lives and
 * this comment is where it is recorded.
 *
 * The decision matters because `isBuildReference` is NOT a pure presence test.
 * It excludes a line carrying `echo` or a `::warning::`-style annotation, and on
 * physical lines that exclusion misfires in both directions:
 *
 *   az acr build --registry "$ACR" apps/foo || echo "::error::apps/foo failed"
 *
 * is a REAL producer that a physical-line scan discards as prose — the exact
 * false-clean class #3420 documents, and an unusually bad one to ship inside a
 * guard whose job is finding missing Gov producers. Conversely, folding alone
 * would make an `echo` anywhere in a wrapped command suppress a genuine build
 * reference.
 *
 * Both are answered by the same rule: fold to logical lines, then judge the
 * prose markers ONLY against the text that precedes the match. A build argument
 * is never preceded on its own command by the echo that reports its failure.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

export const APPS_DIR = 'apps';
export const WORKFLOW_DIR = '.github/workflows';

/** A workflow that runs one of these actually produces an image. */
export const BUILD_INVOCATION = /(az\s+acr\s+build|docker\s+build|docker\/build-push-action)/;

/** Workflow-command markers. A line carrying one of these is OUTPUT, not a build. */
export const ANNOTATION = /::(?:warning|notice|error|debug)::/;

/**
 * The mechanical signal that a workflow can authenticate to Azure Government.
 *
 * WHY THE SECRET NAME AND NOT THE FILENAME. #3416 measured the gap with
 * `grep -l <image> .github/workflows/gov-*.yml`, which is a test of the
 * FILENAME PREFIX, not of the cloud. It is wrong in both directions:
 * build-fiab-images-acr-tasks.yml is a genuine Gov producer (boundary=GCC-High
 * → AZURE_GOV_* creds + `az cloud set --name AzureUSGovernment` + server-side
 * `az acr build`) and is not named `gov-*`; and a file named `gov-*` that
 * happens to mention an image proves nothing. AZURE_GOV_CLIENT_ID is the
 * credential every sovereign lane in this repo logs in with, so its presence is
 * the closest mechanical proxy for "this lane can reach the Gov ACR".
 */
export const GOV_CREDENTIAL = /AZURE_GOV_CLIENT_ID/;

/**
 * Does `line` reference `context` in a position that can reach a build?
 *
 * `line` is a LOGICAL line (continuations already folded by `loadBuilders`).
 *
 * Deliberately narrow, for the reason check-deploy-script-reachability.mjs is:
 * A MENTION IS NOT A BUILD. `gov-provision-dbx-sql-invnet.yml` names
 * `apps/loom-dbx-init` twice — once in a prose comment, once as the `az acr
 * build` context. A naive `grep -c` scores both; only the second makes an
 * artifact.
 *
 * The prose markers are tested ONLY against the text BEFORE the occurrence, and
 * EVERY occurrence gets a turn. An anywhere-on-the-line test silently drops real
 * call sites once lines are folded, because a build routinely carries its own
 * `|| echo "…failed"` on the same logical command (#3420 note). Conversely,
 * `echo "apps/foo would be built"` still fails: the only occurrence is preceded
 * by the `echo`.
 *
 * A word-initial `#` before the match is prose too, and folding is exactly why
 * it has to be checked HERE rather than only at the start of the line. Commenting
 * out a build's context argument mid-command:
 *
 *     az acr build --registry "$ACR" \
 *       --image x:1 \
 *       # apps/foo
 *
 * splices into one logical line that does not START with `#`, so the start-of-line
 * comment test cannot see it — and the shell would treat that `#` as a comment
 * too, leaving `az acr build` with no context at all. Without this the guard
 * reports a producer for a command that cannot build anything. `(^|\s)#` is
 * word-initial on purpose: `--image "loom#tag" apps/foo` has its `#` preceded by
 * a letter, so a tag containing a hash is not mistaken for a comment. Quoting is
 * not modelled beyond that (see _logical-lines.mjs KNOWN LIMITS).
 */
export function isBuildReference(line, context) {
  if (/^\s*#/.test(line)) return false;        // comment (whole logical line)
  for (let i = line.indexOf(context); i !== -1; i = line.indexOf(context, i + 1)) {
    const before = line.slice(0, i);
    if (ANNOTATION.test(before)) continue;     // ::warning:: etc. introduced it
    if (/\becho\b/.test(before)) continue;     // echoed, not built
    if (/(^|\s)#/.test(before)) continue;      // a comment opened earlier in the command
    return true;
  }
  return false;
}

/**
 * Fold one workflow's raw text into the `{ wf, lines, gov }` shape every caller
 * judges. THE ONLY place a workflow becomes lines — `loadBuilders` uses it for
 * the real tree and the Gov guard's embedded controls use it for their fixtures,
 * so a control cannot pass against a folding path the real scan does not take.
 */
export function foldBuilder(wf, text) {
  return {
    wf,
    lines: readLogicalLines(text).map((l) => l.text),
    gov: GOV_CREDENTIAL.test(text),
  };
}

/** Does this folded workflow contain a real (non-comment) build invocation? */
export function isBuilder(lines) {
  return lines.some((l) => !/^\s*#/.test(l) && BUILD_INVOCATION.test(l));
}

/**
 * Every workflow that contains a real build invocation, with its logical lines.
 * `lines` are the folded texts — callers judge those, never physical lines.
 */
export function loadBuilders(root) {
  const dir = join(root, WORKFLOW_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const builders = [];
  for (const wf of files) {
    const b = foldBuilder(wf, readFileSync(join(dir, wf), 'utf8'));
    if (isBuilder(b.lines)) builders.push(b);
  }
  return { builders, workflowCount: files.length };
}

/** Every `apps/<name>/` that ships a Dockerfile, sorted. */
export function discoverApps(root) {
  const appsRoot = join(root, APPS_DIR);
  if (!existsSync(appsRoot)) return [];
  return readdirSync(appsRoot)
    .filter((d) => {
      try {
        return statSync(join(appsRoot, d)).isDirectory() && existsSync(join(appsRoot, d, 'Dockerfile'));
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Split the builders that reach `context` into real producers and mere mentions.
 * `producers` is further split by cloud so a caller can ask the parity question.
 */
export function producersFor(builders, context) {
  const producers = builders.filter(({ lines }) => lines.some((l) => isBuildReference(l, context)));
  const mentions = builders
    .filter(({ wf, lines }) => !producers.some((p) => p.wf === wf) && lines.some((l) => l.includes(context)))
    .map(({ wf }) => wf);
  return {
    producers: producers.map(({ wf }) => wf),
    govProducers: producers.filter((p) => p.gov).map(({ wf }) => wf),
    mentions,
  };
}
