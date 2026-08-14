#!/usr/bin/env node
/**
 * assert-no-silent-image-tag-revert.mjs
 *
 * REFUSE a deploy that would move a LIVE Container App off the tag it is
 * running onto a tag NOBODY ASKED FOR.
 *
 * ── THE DEFECT THIS IS THE RUNTIME HALF OF (#3161) ──────────────────────────
 *
 * Every Gov `.bicepparam` resolves its image tags with
 *
 *     unity: readEnvironmentVariable('LOOM_UNITY_TAG', 'v0.1')
 *
 * and `readEnvironmentVariable` CANNOT FAIL — that is what the second argument
 * is for. So when the deploy step had no `env:` block, every full Gov deploy
 * SUCCEEDED while writing the mutable `v0.1` back onto loom-unity,
 * iceberg-catalog and loom-trino, reverting any SHA-pinned roll with nothing in
 * the log to say it had happened.
 *
 * check-bicepparam-env-reaches-deploy.mjs closes the static half: the variable
 * must be in scope where the template is deployed. That is necessary and NOT
 * sufficient. Being in scope with the value `v0.1` is exactly the state that
 * caused the harm — the guard passes, the deploy still flattens the estate.
 * The only thing that distinguishes "correctly deploying the default" from
 * "silently reverting a pin" is WHAT IS RUNNING RIGHT NOW, and only a live read
 * can tell you that.
 *
 * ── THE RULE, AND WHY IT IS THIS NARROW ─────────────────────────────────────
 *
 * REFUSE when a tag that came from the PARAM FILE'S OWN DEFAULT would overwrite
 * a live app running something else.
 *
 *   - It cannot fire on an intentional roll forward. If an operator set
 *     `vars.LOOM_UNITY_TAG` the value differs from the declared default, the
 *     source reads as an explicit PIN, and moving the app is what they asked
 *     for. The verdict says so and the run proceeds.
 *   - It cannot fire on a greenfield install. An app that is not running cannot
 *     be reverted; deploying it CREATES it.
 *   - It cannot fire on a no-op. Gov's interim mitigation
 *     (loom-dataplane-roll.yml) re-points `:v0.1` at the verified digest after
 *     each roll, so a rolled Gov app legitimately RUNS `:v0.1` — running tag
 *     equals tag-to-write, nothing to report.
 *
 * So the only state it refuses is the one nobody chose: the default about to
 * overwrite a pin.
 *
 * UNKNOWN IS NOT ABSENT. A digest-pinned container, two containers running one
 * repo at two tags, or a container-app query that FAILED all resolve to UNKNOWN,
 * and UNKNOWN + a default-sourced tag is refused too — not because a revert was
 * proven, but because it could not be RULED OUT, and spending "I could not look"
 * as "there is nothing there" is the exact collapse deploy-integrity.md R7
 * forbids. The digest case is not hypothetical: an ACA revision pins the digest
 * it was created with, so a rolled app frequently reports no tag at all.
 *
 * ── THE DIGEST CASE, RESOLVED RATHER THAN GUESSED (#3449) ───────────────────
 *
 * `gov-build-images.yml` sets Gov Container Apps to `<acr>/<app>@sha256:…`, so
 * on GCC-High `loom-unity` — the sovereign catalog, which has no Databricks
 * Unity Catalog to fall back to — runs by digest permanently, and this guard
 * refused every scheduled run because of it (#3449). "Set LOOM_UNITY_TAG to the
 * tag you intend" was not a remedy either: the operator does not know which tag
 * names that digest any more than this script did.
 *
 * So ASK THE REGISTRY — but ask the question that can actually be answered.
 * "Which tag names this digest?" has no unique answer (a digest may carry none,
 * one, or several tags). "Would writing THIS tag change what the app runs?" has
 * exactly one: resolve the candidate tag in ACR and compare its digest to the
 * one the app is running.
 *
 *   same digest      -> writing it CANNOT change the running image. no-op.
 *   different digest -> it WOULD change it, from a param default nobody set.
 *                       REFUSE — and this is a case the tag comparison alone
 *                       could never have caught.
 *   registry silent  -> still UNKNOWN, still refused. An unreadable registry is
 *                       not permission to proceed (R7); it is the reason the
 *                       roll lane's `2>/dev/null` printed a false verdict.
 *
 * Nothing here invents a tag. The candidate is the tag the deploy was already
 * going to write; the registry only says whether writing it is a content no-op.
 *
 * ── WHAT IT PRINTS EVEN WHEN IT PASSES ──────────────────────────────────────
 *
 * A row per tag — value, where the value came from, what is running, verdict —
 * to the log and to $GITHUB_STEP_SUMMARY. #3161 was invisible for the entire
 * life of both Gov lanes because nothing ever stated which tags a deploy was
 * about to write. A guard that only speaks when it refuses would have left that
 * unchanged.
 *
 * READ-ONLY, with one disclosed exception. `az containerapp list` is the only
 * call it makes UNLESS an app is digest-pinned; then it also reads the ACR data
 * plane, which on every Loom registry (publicNetworkAccess=Disabled at rest,
 * #2603) requires taking the shared firewall lease and releasing it on exit. A
 * lease it cannot verify re-locked FAILS the step rather than being shrugged
 * off — same contract as assert-acr-image-tags.sh.
 *
 * Usage:
 *   node scripts/ci/assert-no-silent-image-tag-revert.mjs \
 *     --param-file platform/fiab/bicep/params/gcc-high.bicepparam \
 *     --rg rg-csa-loom-admin-usgovvirginia [--subscription <id>] [--acr <name>]
 *
 * Escape hatch: LOOM_ALLOW_IMAGE_TAG_REVERT=true downgrades a refusal to a loud
 * warning. It is deliberately an explicit, logged act — and it is now the LAST
 * remedy offered rather than the first, because scripts/ci/adopt-image-tags.mjs
 * makes the ordinary case need no human input at all.
 *
 * Run: node --test scripts/ci/__tests__/silent-image-tag-revert.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_IMAGE_TAGS } from './reconcile-policy.mjs';
import { resolveRunningImageTags, parseImageRef } from './reconcile-policy.mjs';
import { classify } from './deploy-classify.mjs';

/** envVar -> declared default, parsed out of a `.bicepparam`. */
export function declaredTagDefaults(paramText) {
  const out = new Map();
  const text = String(paramText).replace(/\r\n/g, '\n');
  for (const m of text.matchAll(/readEnvironmentVariable\(\s*'(LOOM_[A-Z0-9_]*TAG)'\s*,\s*'([^']*)'/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/** envVar -> the appImageTags key it drives (from the shared table). */
export const KEY_BY_ENV_VAR = Object.freeze(
  Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.envVar, e.key])),
);
/** envVar -> the container repository it names. */
export const REPO_BY_ENV_VAR = Object.freeze(
  Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.envVar, e.repo])),
);

/**
 * The digest each `appImageTags` key is running, for the keys that are pinned by
 * digest rather than by tag.
 *
 * Derived from the SAME `az containerapp list` projection resolveRunningImageTags
 * consumes, so the two can never disagree about which apps are digest-pinned.
 * When one repository is served by several containers they must all be on the
 * same digest for the question "would writing tag T change the image?" to have a
 * single answer; two digests is a genuine ambiguity and is left UNKNOWN.
 *
 * @param {Array<{name?:string, image?:string}>|null|undefined} containers
 * @returns {Map<string,{digest:string, apps:string[]}>} key -> running digest
 */
export function digestPinsByKey(containers) {
  const out = new Map();
  if (!Array.isArray(containers)) return out;
  const repoToKey = new Map(APP_IMAGE_TAGS.map((e) => [e.repo, e.key]));
  /** @type {Map<string, {digests:Set<string>, apps:string[]}>} */
  const byKey = new Map();
  for (const c of containers) {
    const ref = parseImageRef(String(c?.image ?? ''));
    if (!ref || !ref.digest) continue;
    const key = repoToKey.get(ref.repo);
    if (!key) continue;
    const acc = byKey.get(key) || { digests: new Set(), apps: [] };
    acc.digests.add(ref.digest);
    acc.apps.push(String(c?.name ?? ''));
    byKey.set(key, acc);
  }
  for (const [key, acc] of byKey) {
    if (acc.digests.size !== 1) continue; // ambiguous — stays UNKNOWN
    out.set(key, { digest: [...acc.digests][0], apps: acc.apps });
  }
  return out;
}

/**
 * The pure decision. No I/O, so every branch is testable without Azure.
 *
 * @param {object} a
 * @param {Map<string,string>} a.declared   envVar -> the param file's default
 * @param {Record<string,string|undefined>} a.env  the environment the deploy will run in
 * @param {ReturnType<typeof resolveRunningImageTags>} a.resolution
 * @param {Record<string,{status:'same'|'different'|'unknown', running?:string, candidate?:string, detail?:string}>} [a.digestChecks]
 *        key -> what the REGISTRY said about writing the candidate tag over a
 *        digest-pinned app. Absent = the question was never asked, which is not
 *        the same as "unknown" and is reported the same way (refuse) either way.
 * @param {boolean} [a.allowRevert]
 * @returns {{rows: Array, refusals: Array, decision:'proceed'|'refuse'}}
 */
export function decideTagWrites({ declared, env = {}, resolution, digestChecks = {}, allowRevert = false } = {}) {
  const rows = [];
  const unknownByKey = new Map((resolution?.unknown || []).map((u) => [u.key, u.why]));
  const pinned = resolution?.pinned || {};
  const absent = new Set(resolution?.absent || []);
  const probed = resolution?.probed === true;

  for (const [envVar, dflt] of declared) {
    const key = KEY_BY_ENV_VAR[envVar];
    // A tag the shared APP_IMAGE_TAGS table does not know cannot be matched
    // back to a running container. Say so rather than scoring it safe.
    if (!key) {
      rows.push({
        envVar, repo: null, value: env[envVar] ?? dflt, source: 'fallback',
        running: 'unmappable', verdict: 'unmapped',
        why: `${envVar} is not in APP_IMAGE_TAGS, so no running container can be matched to it. ` +
             'Add it to scripts/ci/reconcile-policy.mjs.',
      });
      continue;
    }
    const raw = env[envVar];
    const value = raw === undefined || raw === '' ? dflt : raw;
    // The workflow renders `${{ vars.X || '<default>' }}`, so a value EQUAL to
    // the declared default is indistinguishable from — and semantically the
    // same as — nobody having asked for anything.
    const source = value === dflt ? 'fallback' : 'pin';
    const repo = REPO_BY_ENV_VAR[envVar];

    if (!probed) {
      rows.push({
        envVar, repo, value, source, running: 'UNKNOWN', verdict: source === 'pin' ? 'move' : 'REFUSE',
        why: 'the running images could not be read, so it is not established whether this write reverts a pin',
      });
      continue;
    }
    if (absent.has(key)) {
      rows.push({ envVar, repo, value, source, running: '(not deployed)', verdict: 'create', why: 'nothing is running this repository; deploying it creates the app' });
      continue;
    }
    if (unknownByKey.has(key)) {
      // The registry may already have settled this. `digestChecks` carries the
      // ONE answerable question — does the tag this deploy would write resolve,
      // right now, to the digest the app is running? — and nothing else. A
      // `same` verdict is not a guess about which tag "means" the digest; it is
      // a measurement that writing this one cannot change the image.
      const dc = digestChecks[key];
      if (dc && dc.status === 'same') {
        rows.push({
          envVar, repo, value, source, running: `digest ${String(dc.running).slice(0, 19)}…`, verdict: 'no-op',
          why: `${repo} runs a digest-pinned image, and '${value}' resolves in ACR to that SAME digest ` +
               `(${dc.running}), so writing it cannot change what the app runs`,
        });
        continue;
      }
      if (dc && dc.status === 'different') {
        rows.push({
          envVar, repo, value, source, running: `digest ${String(dc.running).slice(0, 19)}…`,
          verdict: source === 'pin' ? 'move' : 'REFUSE',
          why: source === 'pin'
            ? `an explicit pin moves ${repo} from digest ${dc.running} to '${value}' (${dc.candidate})`
            : `${repo} runs digest ${dc.running} and '${value}' resolves in ACR to a DIFFERENT digest ` +
              `(${dc.candidate}) — this deploy would change the running image from the param file's own ` +
              'default, which nobody asked for',
        });
        continue;
      }
      rows.push({
        envVar, repo, value, source, running: 'UNKNOWN', verdict: source === 'pin' ? 'move' : 'REFUSE',
        why: dc && dc.status === 'unknown'
          ? `${unknownByKey.get(key)}; and the registry could not be read to settle it — ${dc.detail}`
          : unknownByKey.get(key),
      });
      continue;
    }
    const running = pinned[key];
    if (running === value) {
      rows.push({ envVar, repo, value, source, running, verdict: 'no-op', why: 'the tag about to be written is the tag already running' });
      continue;
    }
    rows.push({
      envVar, repo, value, source, running,
      verdict: source === 'pin' ? 'move' : 'REFUSE',
      why: source === 'pin'
        ? `an explicit pin moves ${repo} from '${running}' to '${value}'`
        : `${repo} is running '${running}' and this deploy would write '${value}', which is only the param file's ` +
          'default — nobody asked for this change',
    });
  }

  const refusals = rows.filter((r) => r.verdict === 'REFUSE' || r.verdict === 'unmapped');
  return { rows, refusals, decision: refusals.length > 0 && !allowRevert ? 'refuse' : 'proceed' };
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

/**
 * `az containerapp list` for the admin RG.
 *
 * Three OUTCOMES, kept apart on purpose (deploy-integrity R7):
 *   { greenfield: true }        ARM ANSWERED ResourceGroupNotFound — nothing live
 *   { containers: [...] }       ARM ANSWERED with a list (possibly empty)
 *   { error: '<text>' }         the control plane could not be read — UNKNOWN
 *
 * The middle and the last are what the pre-#3090 Gov preflight collapsed with a
 * `2>/dev/null`, turning a permission denial into "nothing to adopt" and
 * skipping the gate on a LIVE sovereign estate.
 */
function listRunningContainers(rg, subscription) {
  const args = [
    'containerapp', 'list', '-g', rg,
    '--query', '[].{name:name, image:properties.template.containers[0].image}',
    '-o', 'json',
  ];
  if (subscription) args.push('--subscription', subscription);
  try {
    const out = execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const v = JSON.parse(out);
    return Array.isArray(v) ? { containers: v } : { error: `az returned non-array JSON: ${out.slice(0, 200)}` };
  } catch (e) {
    const text = String(e?.stderr || e?.message || e);
    if (classify(text).signalId === 'config.resource-group-not-found') return { greenfield: true };
    return { error: text.slice(0, 600) };
  }
}

function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  appendFileSync(f, `${lines.join('\n')}\n`);
}

/**
 * The `acrloom*` registry in the admin RG, or '' when there provably is none.
 *
 * Discovered here rather than handed in by an earlier step ON PURPOSE. A verdict
 * assembled from another step's output is a verdict that can be talked out of a
 * refusal by breaking that step; every input to this decision is read by this
 * script itself. Returns null when the read FAILED — which is not "no registry".
 */
function discoverAcr(rg, subscription) {
  const args = ['acr', 'list', '-g', rg, '--query', "[?starts_with(name,'acrloom')]|[0].name", '-o', 'tsv'];
  if (subscription) args.push('--subscription', subscription);
  try {
    // `az -o tsv` carries a trailing CR on some hosts; strip it or every later
    // string comparison silently fails (`az_tsv_carriage_return_breaks_loops`).
    const out = execFileSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const name = String(out).replace(/\r/g, '').trim();
    return name === 'None' ? '' : name;
  } catch {
    return null;
  }
}

/**
 * Ask the REGISTRY whether writing `repo:tag` would change a digest-pinned app.
 *
 * Delegates the lookup to scripts/ci/resolve-acr-digest.sh — the shared
 * three-state resolver the roll lane uses — rather than growing a second
 * dialect of "is this tag there?". Its exit codes ARE the contract:
 *   0 -> digest on stdout, 3 -> the registry ANSWERED absent, 4 -> UNREADABLE.
 * Anything else is an outcome this caller does not understand, and an
 * unrecognised verdict is never spent as a pass (#3090).
 *
 * @returns {Record<string,{status:'same'|'different'|'unknown', running:string, candidate?:string, detail?:string}>}
 */
function resolveDigestChecks({ pins, candidates, acr, repoByKey }) {
  const checks = {};
  const lease = join(process.cwd(), 'scripts', 'csa-loom', 'acr-firewall-lease.sh');
  let held = false;
  try {
    const out = execFileSync('bash', [lease, 'acquire', '--acr', acr], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Never discard the lease's own words — that discarding is what turned a
    // permission denial into "the tag does not exist" (#3090, R7).
    if (out) console.log(String(out).trimEnd());
    held = true;
  } catch (e) {
    const detail = `${String(e?.stdout || '')}${String(e?.stderr || e?.message || e)}`.slice(0, 400);
    console.log(`::warning::image-tag-revert: ACR firewall lease acquire failed — ${detail}`);
    // No lease means the data plane is unreachable from a hosted runner, so
    // every lookup would fail for a reason that says NOTHING about the images.
    // Report that as UNKNOWN once instead of N times with a misleading cause.
    for (const [key, pin] of pins) {
      checks[key] = { status: 'unknown', running: pin.digest, detail: `the ACR firewall lease on '${acr}' could not be acquired: ${detail}` };
    }
    return checks;
  }
  try {
    for (const [key, pin] of pins) {
      const tag = candidates[key];
      const repo = repoByKey[key];
      if (!tag || !repo) continue;
      let out = '';
      let code = 0;
      try {
        // stderr INHERITED on purpose: resolve-acr-digest.sh writes the
        // registry's own answer and its attempt/backoff trace there, and that
        // trace is the evidence for whichever verdict this produces.
        out = execFileSync('bash', [join(process.cwd(), 'scripts', 'ci', 'resolve-acr-digest.sh'),
          '--acr', acr, '--image', `${repo}:${tag}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      } catch (e) {
        code = typeof e?.status === 'number' ? e.status : -1;
        out = String(e?.stdout || '');
      }
      if (code === 0) {
        const digest = String(out).replace(/\r/g, '').trim().split('\n').pop();
        checks[key] = digest === pin.digest
          ? { status: 'same', running: pin.digest, candidate: digest }
          : { status: 'different', running: pin.digest, candidate: digest };
        continue;
      }
      if (code === 3) {
        // The registry ANSWERED that the tag is not there. That is not "same"
        // and not "different" — it is a deploy about to reference an image that
        // does not exist, which the image preflight also refuses. UNKNOWN here,
        // with the registry's own answer recorded.
        checks[key] = { status: 'unknown', running: pin.digest, detail: `${repo}:${tag} is NOT in the registry, so it cannot be compared to the running digest` };
        continue;
      }
      checks[key] = {
        status: 'unknown', running: pin.digest,
        detail: code === 4
          ? `the registry could not be READ for ${repo}:${tag} (resolve-acr-digest exit 4) — this establishes nothing about the image`
          : `resolve-acr-digest exited ${code} for ${repo}:${tag}, which is not one of its documented outcomes (0/3/4); an unrecognised verdict is not a pass`,
      };
    }
  } finally {
    if (held) {
      // No `|| true`: a lease that cannot be verified re-locked means the
      // registry may be publicly reachable, and that must be loud (#3088/C24).
      try {
        const out = execFileSync('bash', [lease, 'release', '--acr', acr], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (out) console.log(String(out).trimEnd());
      } catch (e) {
        console.error(
          `::error::image-tag-revert: the ACR firewall lease on '${acr}' could NOT be verified re-locked after the ` +
            `digest lookups. The registry may be PUBLICLY REACHABLE. ` +
            `${String(e?.stdout || '')}${String(e?.stderr || e?.message || e)}`.slice(0, 500),
        );
        checks.__leaseReleaseFailed = true;
      }
    }
  }
  return checks;
}

function main() {
  const paramFile = arg('param-file');
  const rg = arg('rg');
  const subscription = arg('subscription');
  if (!paramFile || !rg) {
    console.error('::error::assert-no-silent-image-tag-revert: --param-file and --rg are both required.');
    return 2;
  }

  const declared = declaredTagDefaults(readFileSync(paramFile, 'utf8'));
  if (declared.size === 0) {
    console.error(
      `::error::assert-no-silent-image-tag-revert: ${paramFile} declares NO LOOM_*_TAG defaults. Every boundary param ` +
        'file does, so the parser has drifted off the file. Refusing to report a pass on an empty population.',
    );
    return 1;
  }

  const probe = listRunningContainers(rg, subscription);
  if (probe.greenfield) {
    console.log(
      `::notice::image-tag-revert: ARM answered ResourceGroupNotFound for ${rg} — this is a from-scratch install, ` +
        'there is no running app whose tag could be reverted. Nothing to check.',
    );
    return 0;
  }

  const allowRevert = String(process.env.LOOM_ALLOW_IMAGE_TAG_REVERT || '') === 'true';
  const resolution = resolveRunningImageTags(probe.error ? null : probe.containers);
  if (probe.error) {
    console.log(`::warning::image-tag-revert: could not read the Container Apps in ${rg} — ${probe.error}`);
  }

  // TWO PASSES, and the order matters. The first establishes WHICH TAG this
  // deploy would write for each key — the registry cannot be asked whether a
  // write is a no-op until the candidate is known. Only then, and only for the
  // apps that are digest-pinned (so the tag comparison has nothing to compare),
  // is the registry consulted. Every other key is decided without touching ACR.
  const firstPass = decideTagWrites({ declared, env: process.env, resolution, allowRevert });
  const pins = digestPinsByKey(probe.error ? null : probe.containers);
  let digestChecks = {};
  let leaseReleaseFailed = false;
  if (pins.size > 0) {
    const candidates = Object.fromEntries(
      firstPass.rows.filter((r) => r.repo && KEY_BY_ENV_VAR[r.envVar]).map((r) => [KEY_BY_ENV_VAR[r.envVar], r.value]),
    );
    const acr = arg('acr') || discoverAcr(rg, subscription);
    if (acr === null) {
      console.log(
        `::warning::image-tag-revert: ${pins.size} app(s) run digest-pinned images, and the registries in ${rg} ` +
          'could not be enumerated, so the registry could not be asked whether the tags this deploy would write ' +
          'name those same digests. Those keys stay UNKNOWN.',
      );
    } else if (!acr) {
      console.log(
        `::warning::image-tag-revert: ${pins.size} app(s) run digest-pinned images but ${rg} holds no acrloom* ` +
          'registry, so their digests cannot be resolved to a tag. Those keys stay UNKNOWN.',
      );
    } else {
      digestChecks = resolveDigestChecks({
        pins, candidates, acr, repoByKey: Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.key, e.repo])),
      });
      leaseReleaseFailed = digestChecks.__leaseReleaseFailed === true;
      delete digestChecks.__leaseReleaseFailed;
      for (const [key, c] of Object.entries(digestChecks)) {
        console.log(`[image-tag] digest ${key.padEnd(18)} ${c.status}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
  }

  const { rows, refusals, decision } = decideTagWrites({
    declared, env: process.env, resolution, digestChecks, allowRevert,
  });

  // Print repo:tag only. The registry host is a live-estate identifier and this
  // repository is public (docs-hygiene) — same rule reconcile-resolve.mjs follows.
  const md = [
    `### Image tags this deploy will write — \`${paramFile.split('/').pop()}\``,
    '',
    '| tag var | image | value | source | running | verdict |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    console.log(
      `[image-tag] ${r.envVar.padEnd(30)} ${String(r.value).padEnd(12)} ${r.source.padEnd(9)} ` +
        `running=${String(r.running).padEnd(14)} ${r.verdict}`,
    );
    md.push(`| \`${r.envVar}\` | \`${r.repo || '?'}\` | \`${r.value}\` | ${r.source} | \`${r.running}\` | ${r.verdict} |`);
  }
  md.push('');
  summary(md);

  if (refusals.length === 0) {
    if (leaseReleaseFailed) {
      console.error(
        '::error::image-tag-revert: no tag would be silently reverted, but the ACR firewall lease could not be ' +
          'verified re-locked. Failing the step: leaving a sovereign registry publicly reachable is not something ' +
          'a passing verdict may hide.',
      );
      return 1;
    }
    console.log(
      `image-tag-revert OK — ${rows.length} tag(s) checked against what ${rg} is actually running; none would be ` +
        'silently moved off a tag nobody asked to change.',
    );
    return 0;
  }

  for (const r of refusals) {
    console.error(
      `::error::image-tag-revert: ${r.envVar} — ${r.why}. This deploy resolves it to '${r.value}'. ` +
        'scripts/ci/adopt-image-tags.mjs is what normally makes this unnecessary by exporting the tag the estate ' +
        'is running; if it ran and this key is still unresolved, the estate did not answer for it — fix that, or ' +
        `set the repo variable ${r.envVar} to state the tag you intend.`,
    );
  }
  if (allowRevert) {
    console.log(
      `::warning::image-tag-revert: ${refusals.length} silent revert(s) ACKNOWLEDGED via LOOM_ALLOW_IMAGE_TAG_REVERT=true. ` +
        'Proceeding, and recording that this was an explicit choice rather than an unnoticed default.',
    );
    return leaseReleaseFailed ? 1 : 0;
  }
  console.error(
    `::error::image-tag-revert: REFUSING. ${refusals.length} image tag(s) would be written from the param file's own ` +
      'default over a live app running something else — the exact silent revert #3161 describes. The deploy is ' +
      'supposed to ADOPT what is running (scripts/ci/adopt-image-tags.mjs, #3449) so no human input is needed; a ' +
      'refusal here means adoption did not happen or could not establish what is live.',
  );
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('assert-no-silent-image-tag-revert.mjs')) {
  process.exit(main());
}
