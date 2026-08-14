#!/usr/bin/env node
/**
 * adopt-image-tags.mjs — RESOLVE every `appImageTags` entry a `.bicepparam`
 * reads from the ESTATE THAT IS RUNNING, and export it into `$GITHUB_ENV`.
 *
 * ── THE DEFECT THIS REMOVES (#3449, the design half of #3161) ───────────────
 *
 * #3161 was fixed by putting the sixteen `LOOM_*_TAG` variables in scope where
 * the Gov lanes deploy:
 *
 *     LOOM_CONSOLE_TAG: ${{ vars.LOOM_CONSOLE_TAG || 'v0.1' }}
 *
 * That closed the "not in scope" half. It did NOT give the deploy a way to say
 * "keep what is running". With the repo variable unset — its normal state — the
 * expression still resolves to the param file's own default, so a SCHEDULED
 * reconcile of a live estate still proposes to flatten every SHA-pinned app to
 * `v0.1`. assert-no-silent-image-tag-revert.mjs correctly REFUSES that, which
 * is why `deploy-fiab-gcch` failed on every scheduled run: run 31793715708
 * refused three tags — loom-console (running `28de89fb`), loom-wrangler-host
 * (`7ba2ec0f`) and loom-unity (digest-pinned).
 *
 * The guard was right. The remedy it could name was wrong: "set the repo
 * variable LOOM_CONSOLE_TAG to the tag you intend" asks a HUMAN to type a value
 * the platform had already measured — the guard reads the running tag in order
 * to compare against it. `.claude/rules/auto-bind-by-default.md` §5 is explicit:
 * "'Set LOOM_X' as the terminal user-facing state is a violation — the value
 * must be produced by the deploy."
 *
 * ── THE SHAPE, AND WHERE IT COMES FROM ──────────────────────────────────────
 *
 * This is the internal-token single-writer fix (#3122, 36b765e4) applied to
 * image tags. `loomInternalToken` had the same defect with a different value:
 * bicep minted one with `newGuid()` on every deploy, so a redeploy invalidated a
 * working estate. The fix was not "make the operator supply the token" — it was
 * for every deploy path to RESOLVE the value already live on the estate and pass
 * it in, minting only when there is genuinely nothing to adopt.
 *
 * Same three rules here:
 *
 *   1. An EXPLICIT request wins. `REQUESTED_LOOM_<APP>_TAG` (the workflow's
 *      `${{ vars.LOOM_<APP>_TAG }}`, empty when unset) is an operator saying
 *      which tag they mean. Adoption is the DEFAULT, never an override of
 *      intent — a roll forward must not be silently undone by a reconcile any
 *      more than a pin may be silently reverted by one.
 *   2. Otherwise ADOPT what is running. Measured read-only from
 *      `az containerapp list`, matched back to the `appImageTags` key through
 *      the shared APP_IMAGE_TAGS table.
 *   3. Otherwise the param file's OWN declared default. That covers the two
 *      honest cases: nothing is running this repository (deploying it CREATES
 *      the app — there is no running image to preserve), and the estate does
 *      not exist yet.
 *
 * ── WHY IT EXPORTS A VALUE FOR *EVERY* DECLARED TAG ─────────────────────────
 *
 * reconcile-resolve.mjs emits a line only for a RUNNING app. That is right for
 * Commercial, where nothing else sets the variable. On the Gov lanes the
 * consumers run under `set -u`:
 *
 *     bash scripts/ci/assert-acr-image-tags.sh … "loom-unity:${LOOM_UNITY_TAG}"
 *
 * so a variable this script declined to export would abort the step rather than
 * fall through to the param default. Exporting the FINAL resolved value for
 * every declared tag — including the ones that resolve to the declared default
 * — makes this the SINGLE WRITER: what the log prints is exactly what bicep
 * will read, and there is no second expression anywhere that could disagree.
 * That is the property #3303 was reaching for with the job-level `env:` block
 * and could not have, because a literal cannot measure an estate.
 *
 * ── WHAT IT DOES *NOT* DO — AND WHY THAT IS THE POINT ───────────────────────
 *
 * It never invents a tag. An app running by DIGEST, two apps running one
 * repository at two tags, or a container-app query that FAILED all resolve to
 * UNRESOLVED: this script exports the param default and says, loudly, that it
 * did not establish what is running. Deciding whether writing that default is
 * safe is assert-no-silent-image-tag-revert.mjs's job, and it makes that call
 * from its OWN independent live read. Two measurements, not one measurement
 * trusted twice — this script cannot talk the guard out of a refusal.
 *
 * READ-ONLY. `az containerapp list` is the only Azure call it makes.
 *
 * Usage:
 *   node scripts/ci/adopt-image-tags.mjs \
 *     --param-file platform/fiab/bicep/params/gcc-high.bicepparam \
 *     --rg rg-csa-loom-admin-usgovvirginia [--subscription <id>]
 *
 * Run: node --test scripts/ci/__tests__/adopt-image-tags.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { APP_IMAGE_TAGS, resolveRunningImageTags } from './reconcile-policy.mjs';
import { declaredTagDefaults } from './assert-no-silent-image-tag-revert.mjs';
import { classify } from './deploy-classify.mjs';

/** envVar -> the appImageTags key / repository it drives (shared table). */
export const ENTRY_BY_ENV_VAR = Object.freeze(
  Object.fromEntries(APP_IMAGE_TAGS.map((e) => [e.envVar, e])),
);

/**
 * The env var a workflow uses to REQUEST a specific tag.
 *
 * It is deliberately NOT `LOOM_<APP>_TAG` itself. A job-level
 * `LOOM_CONSOLE_TAG: ${{ vars.LOOM_CONSOLE_TAG }}` would defeat this whole
 * script twice over:
 *
 *   - a workflow/job/step `env:` key takes precedence over a `$GITHUB_ENV`
 *     write (GitHub docs, Variables: "If a variable with the same name exists
 *     at multiple levels, the variable at the lowest level takes precedence"),
 *     so the adopted value would be silently discarded by the very block that
 *     was supposed to carry it; and
 *   - with the repo variable unset the expression yields the EMPTY STRING, and
 *     `readEnvironmentVariable('LOOM_CONSOLE_TAG', 'v0.1')` returns that empty
 *     string rather than the default, producing the image reference
 *     `<acr>/loom-console:` — a worse failure than the one being fixed.
 *
 * A distinct name keeps the request and the resolution apart, so exactly one
 * name reaches bicep and exactly one thing writes it.
 */
export function requestVarFor(envVar) {
  return `REQUESTED_${envVar}`;
}

/**
 * The pure decision. No I/O, so every branch is testable without Azure.
 *
 * @param {object} a
 * @param {Map<string,string>} a.declared  envVar -> the param file's own default
 * @param {Record<string,string|undefined>} [a.env]  the process environment
 * @param {ReturnType<typeof resolveRunningImageTags>|null} [a.resolution]
 *        null = there is no estate to read (greenfield)
 * @param {boolean} [a.greenfield]
 * @returns {{rows: Array, envLines: string[], adopted: number, unresolved: Array}}
 */
export function decideAdoptions({ declared, env = {}, resolution = null, greenfield = false } = {}) {
  const rows = [];
  const unknownByKey = new Map((resolution?.unknown || []).map((u) => [u.key, u.why]));
  const pinned = resolution?.pinned || {};
  const absent = new Set(resolution?.absent || []);
  const probed = resolution?.probed === true;

  for (const [envVar, dflt] of declared) {
    const requested = String(env[requestVarFor(envVar)] ?? '').trim();
    const entry = ENTRY_BY_ENV_VAR[envVar];

    // 1. An operator named a tag. That is intent, and intent outranks the
    //    estate — this script exists to remove a CHORE, not to overrule a
    //    decision. Recorded even when it equals the declared default, because
    //    the two are genuinely indistinguishable downstream and pretending
    //    otherwise would be a claim nothing established.
    if (requested) {
      rows.push({
        envVar, key: entry?.key ?? null, repo: entry?.repo ?? null, value: requested,
        source: 'requested', running: null,
        why: `${requestVarFor(envVar)} is set, so this deploy writes the tag that was asked for`,
      });
      continue;
    }

    // A tag the shared table does not know cannot be matched back to a running
    // container, so it cannot be adopted. Say so; do not score it safe.
    if (!entry) {
      rows.push({
        envVar, key: null, repo: null, value: dflt, source: 'unmapped', running: null,
        why: `${envVar} is not in APP_IMAGE_TAGS, so no running container can be matched to it. ` +
             'Add it to scripts/ci/reconcile-policy.mjs.',
      });
      continue;
    }

    if (greenfield) {
      rows.push({
        envVar, key: entry.key, repo: entry.repo, value: dflt, source: 'default', running: '(no estate)',
        why: 'the admin resource group does not exist — this is a from-scratch install and there is no running image to adopt',
      });
      continue;
    }

    // 2b. The read FAILED. Not "nothing is running" (deploy-integrity R7). The
    //     param default is exported so the consuming steps have a value, and
    //     the row says plainly that nothing was established — the revert gate
    //     re-reads the estate itself and refuses on exactly this.
    if (!probed) {
      rows.push({
        envVar, key: entry.key, repo: entry.repo, value: dflt, source: 'unresolved', running: 'UNKNOWN',
        why: 'the container-app query failed, so it is NOT established what this app is running; ' +
             'falling back to the param file default WITHOUT claiming that is a no-op',
      });
      continue;
    }
    if (absent.has(entry.key)) {
      rows.push({
        envVar, key: entry.key, repo: entry.repo, value: dflt, source: 'default', running: '(not deployed)',
        why: `nothing is running ${entry.repo}; deploying it CREATES the app, so there is no image to preserve`,
      });
      continue;
    }
    if (unknownByKey.has(entry.key)) {
      rows.push({
        envVar, key: entry.key, repo: entry.repo, value: dflt, source: 'unresolved', running: 'UNKNOWN',
        why: unknownByKey.get(entry.key),
      });
      continue;
    }

    // 2a. ADOPT. The estate answered with exactly one tag for this repository.
    rows.push({
      envVar, key: entry.key, repo: entry.repo, value: pinned[entry.key], source: 'adopted',
      running: pinned[entry.key],
      why: `${entry.repo} is running this tag; re-asserting it makes the ARM PUT a no-op for the image`,
    });
  }

  return {
    rows,
    // EVERY declared tag gets a line. See the header: the Gov consumers run
    // under `set -u`, and a single source of truth is the whole point.
    envLines: rows.map((r) => `${r.envVar}=${r.value}`),
    adopted: rows.filter((r) => r.source === 'adopted').length,
    unresolved: rows.filter((r) => r.source === 'unresolved'),
  };
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
 * Three OUTCOMES, kept apart (deploy-integrity R7), the same three
 * assert-no-silent-image-tag-revert.mjs keeps apart:
 *   { greenfield: true }   ARM ANSWERED ResourceGroupNotFound — nothing live
 *   { containers: [...] }  ARM ANSWERED with a list (possibly empty)
 *   { error: '<text>' }    the control plane could not be read — UNKNOWN
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

function main() {
  const paramFile = arg('param-file');
  const rg = arg('rg');
  const subscription = arg('subscription');
  if (!paramFile || !rg) {
    console.error('::error::adopt-image-tags: --param-file and --rg are both required.');
    return 2;
  }

  const declared = declaredTagDefaults(readFileSync(paramFile, 'utf8'));
  if (declared.size === 0) {
    console.error(
      `::error::adopt-image-tags: ${paramFile} declares NO LOOM_*_TAG defaults. Every boundary param file does, so ` +
        'the parser has drifted off the file. Refusing to export an empty tag set and let the deploy resolve them ' +
        'from nothing — that is the #3161 state exactly.',
    );
    return 1;
  }

  const probe = listRunningContainers(rg, subscription);
  if (probe.error) {
    console.log(
      `::warning::adopt-image-tags: could not read the Container Apps in ${rg} — ${probe.error}. No tag can be ` +
        'adopted from an estate that did not answer; the param file defaults are exported and the image-tag revert ' +
        'gate will refuse rather than write them over something else.',
    );
  }
  const resolution = probe.greenfield ? null : resolveRunningImageTags(probe.error ? null : probe.containers);

  const { rows, envLines, adopted, unresolved } = decideAdoptions({
    declared, env: process.env, resolution, greenfield: probe.greenfield === true,
  });

  // Print repo:tag only. The registry host is a live-estate identifier and this
  // repository is public (docs-hygiene) — the same rule reconcile-resolve.mjs
  // and the revert gate follow.
  const md = [
    `### Image tags this deploy will write — \`${paramFile.split('/').pop()}\``,
    '',
    '| tag var | image | value | source | running |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    console.log(
      `[adopt-tag] ${r.envVar.padEnd(30)} ${String(r.value).padEnd(12)} ${r.source.padEnd(10)} ` +
        `running=${String(r.running ?? '-')}`,
    );
    md.push(`| \`${r.envVar}\` | \`${r.repo || '?'}\` | \`${r.value}\` | ${r.source} | \`${r.running ?? '-'}\` |`);
  }
  md.push('');

  const ghEnv = process.env.GITHUB_ENV;
  if (ghEnv) appendFileSync(ghEnv, `${envLines.join('\n')}\n`);
  else for (const line of envLines) console.log(`[dry] env ${line}`);

  for (const u of unresolved) {
    console.log(
      `::warning::adopt-image-tags: ${u.envVar} could NOT be adopted — ${u.why}. Exporting the param file default ` +
        `'${u.value}' and making NO claim that writing it preserves what is running.`,
    );
  }

  console.log(
    `adopt-image-tags: ${rows.length} tag(s) resolved for ${paramFile.split('/').pop()} — ${adopted} ADOPTED from the ` +
      `live estate, ${rows.filter((r) => r.source === 'requested').length} explicitly requested, ` +
      `${rows.filter((r) => r.source === 'default').length} at the param default (nothing running to preserve), ` +
      `${unresolved.length} UNRESOLVED. No repo variable is required for a reconcile to keep what is running.`,
  );

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${md.join('\n')}\n`);
  return 0;
}

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] && process.argv[1].endsWith('adopt-image-tags.mjs')) {
  process.exit(main());
}
