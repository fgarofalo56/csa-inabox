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
 * ── WHAT IT PRINTS EVEN WHEN IT PASSES ──────────────────────────────────────
 *
 * A row per tag — value, where the value came from, what is running, verdict —
 * to the log and to $GITHUB_STEP_SUMMARY. #3161 was invisible for the entire
 * life of both Gov lanes because nothing ever stated which tags a deploy was
 * about to write. A guard that only speaks when it refuses would have left that
 * unchanged.
 *
 * READ-ONLY. `az containerapp list` is the only Azure call it makes.
 *
 * Usage:
 *   node scripts/ci/assert-no-silent-image-tag-revert.mjs \
 *     --param-file platform/fiab/bicep/params/gcc-high.bicepparam \
 *     --rg rg-csa-loom-admin-usgovvirginia [--subscription <id>]
 *
 * Escape hatch: LOOM_ALLOW_IMAGE_TAG_REVERT=true downgrades a refusal to a loud
 * warning. It is deliberately an explicit, logged act — the FIRST remediation
 * offered is to set the repo variable to the tag you actually intend, because
 * stating the intent is the thing that was missing.
 *
 * Run: node --test scripts/ci/__tests__/silent-image-tag-revert.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { APP_IMAGE_TAGS } from './reconcile-policy.mjs';
import { resolveRunningImageTags } from './reconcile-policy.mjs';
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
 * The pure decision. No I/O, so every branch is testable without Azure.
 *
 * @param {object} a
 * @param {Map<string,string>} a.declared   envVar -> the param file's default
 * @param {Record<string,string|undefined>} a.env  the environment the deploy will run in
 * @param {ReturnType<typeof resolveRunningImageTags>} a.resolution
 * @param {boolean} [a.allowRevert]
 * @returns {{rows: Array, refusals: Array, decision:'proceed'|'refuse'}}
 */
export function decideTagWrites({ declared, env = {}, resolution, allowRevert = false } = {}) {
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
      rows.push({
        envVar, repo, value, source, running: 'UNKNOWN', verdict: source === 'pin' ? 'move' : 'REFUSE',
        why: unknownByKey.get(key),
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

  const { rows, refusals, decision } = decideTagWrites({ declared, env: process.env, resolution, allowRevert });

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
    console.log(
      `image-tag-revert OK — ${rows.length} tag(s) checked against what ${rg} is actually running; none would be ` +
        'silently moved off a tag nobody asked to change.',
    );
    return 0;
  }

  for (const r of refusals) {
    console.error(
      `::error::image-tag-revert: ${r.envVar} — ${r.why}. Set the repo variable ${r.envVar} to the tag you intend ` +
        `(currently resolving to '${r.value}' from the param file default).`,
    );
  }
  if (allowRevert) {
    console.log(
      `::warning::image-tag-revert: ${refusals.length} silent revert(s) ACKNOWLEDGED via LOOM_ALLOW_IMAGE_TAG_REVERT=true. ` +
        'Proceeding, and recording that this was an explicit choice rather than an unnoticed default.',
    );
    return 0;
  }
  console.error(
    `::error::image-tag-revert: REFUSING. ${refusals.length} image tag(s) would be written from the param file's own ` +
      'default over a live app running something else — the exact silent revert #3161 describes. Remediate by pinning ' +
      'the repo variable(s) above, or acknowledge explicitly with LOOM_ALLOW_IMAGE_TAG_REVERT=true.',
  );
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('assert-no-silent-image-tag-revert.mjs')) {
  process.exit(main());
}
