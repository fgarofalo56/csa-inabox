#!/usr/bin/env node
/**
 * GUARDRAIL: every image this repo BUILDS must be buildable for AZURE GOVERNMENT.
 *
 * WHY THIS EXISTS (#3416). `loom-transform-runner` — the dbt-core + SQLMesh
 * execution surface behind the `transformation-project` item — had exactly one
 * producer, `full-app-deploy-commercial.yml`, which authenticates with the
 * COMMERCIAL service principal and pushes into the Commercial registry. Nothing
 * built it for a sovereign boundary. Meanwhile `platform/fiab/bicep/main.bicep`
 * carries `dbtRunnerImageReady = true` — a CLOUD-BLIND boolean whose own comment
 * cites Commercial evidence ("acrloom….azurecr.io … Succeeded") and which
 * asserts "the runner images are published to this boundary's ACR" for EVERY
 * boundary at once. So an apps-enabled GCC-High / IL5 deploy would invoke
 * integration/transform-runner-aca.bicep against an image the Gov ACR has never
 * held, and the Container App PUT fails with MANIFEST_UNKNOWN.
 *
 * `.claude/rules/cloud-parity.md` is BLOCKING and names this exact shape: "a
 * capability that works in Commercial and not in Gov is INCOMPLETE, not
 * Commercial-first". This is the mechanical version of that sentence for the
 * image layer.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * For every subject (an `apps/<name>/Dockerfile`, plus the explicitly listed
 * out-of-tree contexts below), if ANY workflow builds it then at least one
 * GOV-CAPABLE workflow must build it too.
 *
 * "Gov-capable" is decided by the AZURE_GOV_CLIENT_ID credential, NOT by the
 * `gov-*` filename. #3416 measured the gap with
 * `grep -l <image> .github/workflows/gov-*.yml`, which is a filename test and
 * is wrong in both directions: `build-fiab-images-acr-tasks.yml` is a real Gov
 * producer (boundary=GCC-High → AZURE_GOV_* + `az cloud set` + server-side
 * `az acr build`) and is not named `gov-*`, while a `gov-*` file that merely
 * mentions an image proves nothing. The predicate lives in
 * _image-producer-scan.mjs and is shared with the sibling guard so the two
 * cannot drift.
 *
 * ── WHAT THIS DOES *NOT* OWN ───────────────────────────────────────────────
 * "This image has no producer at all" belongs to
 * check-image-producer-coverage.mjs (#2619) and its KNOWN_UNBUILT ledger. For
 * an `apps/` subject with zero producers this guard stays silent rather than
 * double-reporting. EXTRA_SUBJECTS are different: that sibling only walks
 * `apps/`, so nothing else would ever see them, and for those this guard
 * asserts BOTH halves.
 *
 * Usage: node scripts/ci/check-gov-image-producer-parity.mjs [--root <dir>]
 *
 * `--root` exists only so the self-test can aim the real checker at fixture
 * trees. CI never passes it.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPS_DIR, discoverApps, foldBuilder, isBuilder, loadBuilders, producersFor,
} from './_image-producer-scan.mjs';

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag >= 0 ? process.argv[rootFlag + 1] : process.cwd();
const FIXTURE_MODE = rootFlag >= 0;

/**
 * Images whose Dockerfile does NOT live under `apps/` and which a Gov deploy
 * still pulls. The sibling guard walks `apps/` only, so without this list these
 * are invisible to BOTH checks — which is precisely how `loom-copilot-evaluator`
 * reached #3416 with no producer in any cloud but Commercial.
 *
 * `context` is the string a build line must contain. For a repo-root build it
 * is the `--file <path>` argument, which is what actually distinguishes one of
 * these builds from another.
 */
const EXTRA_SUBJECTS = [
  {
    name: 'loom-copilot-evaluator',
    context: 'azure-functions/copilot-evaluator/Dockerfile',
    why: 'Deployed on every Container Apps boundary by admin-plane/main.bicep -> copilot-evaluator-job.bicep (copilotEvaluatorActive = enabled && containerApps && deployAppsEnabled — no boundary gate), pulling <acr>/loom-copilot-evaluator:latest.',
  },
  {
    name: 'loom-lineage-extractor',
    context: 'azure-functions/lineage-extractor/Dockerfile',
    why: 'Deployed on every Container Apps boundary by admin-plane/main.bicep -> lineage-extractor-job.bicep (lineageExtractorActive, no boundary gate), pulling <acr>/loom-lineage-extractor:latest.',
  },
  {
    name: 'loom-report-subscriptions',
    context: 'azure-functions/report-subscriptions/Dockerfile',
    why: 'Deployed on every Container Apps boundary by admin-plane/main.bicep -> report-subscriptions-job.bicep (reportSubscriptionsActive, no boundary gate), pulling <acr>/loom-report-subscriptions:latest.',
  },
  {
    name: 'loom-secret-expiry-monitor',
    context: 'azure-functions/secret-expiry-monitor/Dockerfile',
    why: 'Deployed on every Container Apps boundary by admin-plane/main.bicep -> secret-expiry-monitor-job.bicep (secretExpiryActive, no boundary gate), pulling <acr>/loom-secret-expiry-monitor:latest.',
  },
  {
    name: 'loom-script-runner',
    context: 'platform/runners/script-runner',
    why: 'The report-designer script-visual executor. admin-plane/main.bicep gates it OFF in the sovereign boundaries explicitly: `scriptRunnerActive = … && boundary != \'GCC-High\' && boundary != \'IL5\'`.',
  },
];

/**
 * GOV-PARITY EXEMPT — a subject that is built for Commercial and NOT for Gov,
 * with the reason it is tolerated.
 *
 * An entry is a LOAN, not a fix, in exactly the sense the sibling guard's
 * KNOWN_UNBUILT ledger means it: it exists so the gap is NAMED and COUNTED
 * instead of silent. `.claude/rules/cloud-parity.md` forbids "Commercial-first,
 * Gov later ... with no dated owner", so every entry names what is missing and
 * where the fix is tracked. Do not add one to make this guard green.
 */
const GOV_EXEMPT = new Map([
  [
    'loom-script-runner',
    'NOT a Gov gap. admin-plane/main.bicep deliberately excludes it from GCC-High and IL5 (scriptRunnerActive carries `boundary != \'GCC-High\' && boundary != \'IL5\''
    + '`), and gcc-high/il5.bicepparam say so in prose. No sovereign deploy pulls this image, so there is nothing for a Gov producer to serve. Permanent, not pending.',
  ],
  [
    'loom-lineage-extractor',
    'SAME DEFECT AS #3416, NOT YET FIXED. Its only producer is scripts/csa-loom/deploy-lineage-extractor-job.sh, invoked by deploy-lineage-extractor.yml, which logs in with the COMMERCIAL SP. lineageExtractorActive has no boundary gate, so the ACA job IS deployed in Gov and its scheduled executions cannot pull an image. Needs a Gov producer of its own; recorded here rather than fixed in the #3416 PR so the two-image change stays reviewable.',
  ],
  [
    'loom-report-subscriptions',
    'SAME DEFECT AS #3416, NOT YET FIXED. Only producer: scripts/csa-loom/deploy-report-subscriptions-job.sh via deploy-report-subscriptions.yml (Commercial SP). reportSubscriptionsActive has no boundary gate. Needs a Gov producer of its own.',
  ],
  [
    'loom-secret-expiry-monitor',
    'SAME DEFECT AS #3416, NOT YET FIXED. Only producer: scripts/csa-loom/deploy-secret-expiry-job.sh via deploy-secret-expiry.yml (Commercial SP). secretExpiryActive has no boundary gate — and this is the job that watches for the expired-MSAL-secret outage class, so its absence in Gov removes a prevention control there. Needs a Gov producer of its own.',
  ],
]);

/**
 * The verdict for one subject. Pure, so the embedded controls below can drive it
 * with synthetic input and prove it still discriminates.
 */
function classify({ producers, govProducers, exempt, extra }) {
  if (producers.length === 0) {
    // An EXTRA subject is only here because a deploy pulls it, so "nobody builds
    // it at all" is a finding. An apps/ subject with no producer belongs to
    // check-image-producer-coverage.mjs; staying silent avoids double-reporting.
    return extra ? (exempt ? 'exempt' : 'no-producer-anywhere') : 'not-my-subject';
  }
  if (govProducers.length === 0) return exempt ? 'exempt' : 'gov-missing';
  return exempt ? 'stale-exempt' : 'ok';
}

// ── EMBEDDED CONTROLS ───────────────────────────────────────────────────────
// After the #3416 fix this guard's population on the real tree is ZERO
// unexempted findings, and a guard with nothing to find is indistinguishable
// from a guard that has stopped working (`guard_with_zero_population_needs_
// embedded_control`). These run on EVERY invocation, through the SAME scanner
// and the SAME classifier as the real tree, and the guard refuses to report a
// pass if any of them stops holding.
//
// The third control is the sharpest: it proves a Gov-credentialed workflow that
// merely NAMES the context — in a comment, an echo, or a ::notice:: — does NOT
// satisfy the rule. That is the cheap way this guard could be silently defeated.
//
// Controls 4 and 5 pin the LOGICAL-LINE behaviour (#3420 / #3427). They are the
// reason the fixtures below are raw workflow TEXT run through `foldBuilder` —
// the same function `loadBuilders` uses for the real tree — rather than
// pre-split line arrays. A control that folded differently from the real scan
// would prove nothing about the real scan.
const CTX = 'apps/ctl-subject';
const LOGIN_COMMERCIAL = [
  'jobs:', '  b:', '    steps:',
  '      - uses: azure/login@v2', '        with:', '          creds: ${{ secrets.AZURE_CLIENT_ID }}',
].join('\n');
const LOGIN_GOV = [
  'jobs:', '  b:', '    steps:',
  '      - uses: azure/login@v2', '        with:', '          creds: ${{ secrets.AZURE_GOV_CLIENT_ID }}',
  '      - run: az cloud set --name AzureUSGovernment',
].join('\n');

const COMMERCIAL_BUILD = `${LOGIN_COMMERCIAL}\n      - run: az acr build --registry "$ACR" --image x:1 ${CTX}\n`;
const GOV_BUILD = `${LOGIN_GOV}\n      - run: az acr build --registry "$ACR" --image x:1 ${CTX}\n`;
const GOV_MENTION_ONLY = `${LOGIN_GOV}
      # TODO: build ${CTX} here one day
      - run: echo "would build ${CTX}"
      - run: az acr build --registry "$ACR" --image other:1 apps/something-else
`;
// The false-clean this adoption exists to kill: a REAL build whose context sits
// on a continuation that ALSO carries the command's own failure message. On
// physical lines that second line reads `apps/ctl-subject || echo "…"` — prose,
// so the producer disappears. Folding makes it one command whose `echo` lands
// AFTER the match, which is why the prose test is scoped to the text before it.
// This control fails if EITHER half is reverted: unfold it and the line is
// prose; keep folding but test prose anywhere on the line and it is prose again.
const GOV_FOLDED_BUILD = `${LOGIN_GOV}
      - run: |
          az acr build --registry "$ACR" --image x:1 \\
            ${CTX} || echo "::error::${CTX} build failed"
`;
// The other direction: folding must not turn an echo that spans lines into a
// producer just because the context lands on a later physical line.
const GOV_FOLDED_ECHO = `${LOGIN_GOV}
      - run: |
          echo "nothing here builds \\
            ${CTX} yet"
          az acr build --registry "$ACR" --image other:1 apps/something-else
`;
// Folding's own hazard: a context argument COMMENTED OUT mid-command splices
// into a logical line that does not START with `#`, so the start-of-line comment
// test cannot see it. The shell reads that `#` as a comment too and the build
// runs with no context at all — so counting it would be a false clean for a
// command that cannot build anything.
const GOV_COMMENTED_BUILD = `${LOGIN_GOV}
      - run: |
          az acr build --registry "$ACR" \\
            --image x:1 \\
            # ${CTX}
`;

const CONTROLS = [
  {
    label: 'commercial-only producer is FLAGGED',
    builders: [['commercial.yml', COMMERCIAL_BUILD]],
    expect: 'gov-missing',
  },
  {
    label: 'a Gov-credentialed producer SATISFIES the rule',
    builders: [['commercial.yml', COMMERCIAL_BUILD], ['sovereign.yml', GOV_BUILD]],
    expect: 'ok',
  },
  {
    label: 'a Gov workflow that only MENTIONS the context does NOT satisfy it',
    builders: [['commercial.yml', COMMERCIAL_BUILD], ['sovereign.yml', GOV_MENTION_ONLY]],
    expect: 'gov-missing',
  },
  {
    label: 'a FOLDED Gov build carrying its own `|| echo` fallback IS a producer (#3420)',
    builders: [['commercial.yml', COMMERCIAL_BUILD], ['sovereign.yml', GOV_FOLDED_BUILD]],
    expect: 'ok',
  },
  {
    label: 'a FOLDED echo is still prose, not a producer',
    builders: [['commercial.yml', COMMERCIAL_BUILD], ['sovereign.yml', GOV_FOLDED_ECHO]],
    expect: 'gov-missing',
  },
  {
    label: 'a context COMMENTED OUT mid-command is not a producer (folding hazard)',
    builders: [['commercial.yml', COMMERCIAL_BUILD], ['sovereign.yml', GOV_COMMENTED_BUILD]],
    expect: 'gov-missing',
  },
];

export function runControls() {
  const failures = [];
  for (const c of CONTROLS) {
    const builders = c.builders.map(([wf, text]) => foldBuilder(wf, text)).filter((b) => isBuilder(b.lines));
    const { producers, govProducers } = producersFor(builders, CTX);
    const got = classify({ producers, govProducers, exempt: false, extra: false });
    if (got !== c.expect) {
      failures.push(`${c.label}: expected '${c.expect}', got '${got}' (producers=[${producers}] gov=[${govProducers}])`);
    }
  }
  return failures;
}
/**
 * #3436 — everything below runs from `main()`, behind an entrypoint fence, so
 * importing this module does not execute a repo walk and `process.exit()` as a
 * side effect.
 */
function main() {
  const controlFailures = runControls();
  if (controlFailures.length) {
    console.error('[gov-image-producer-parity] FAIL — the EMBEDDED CONTROLS no longer hold.');
    console.error('  This guard cannot be trusted about the real tree while its own controls are broken:');
    for (const f of controlFailures) console.error(`    ${f}`);
    console.error('\n  Fix the scanner/classifier, not the control. A control that is edited to match');
    console.error('  new behaviour stops being a control.');
    process.exit(1);
  }

  // ── REAL TREE ─────────────────────────────────────────────────────────────
  const apps = discoverApps(ROOT);
  // An EXTRA subject is only a subject where its build context actually exists —
  // in the real tree that is always, and in a fixture tree it is whatever the test
  // chose to create. Do NOT special-case FIXTURE_MODE into "include them all":
  // that would make every fixture fail on repo-specific subjects it never had.
  const extras = EXTRA_SUBJECTS.filter((s) => existsSync(join(ROOT, s.context)) || existsSync(join(ROOT, s.context, 'Dockerfile')));

  if (apps.length === 0) {
    console.error('[gov-image-producer-parity] FAIL — no apps/<name>/Dockerfile found. Wrong root, or the tree moved.');
    process.exit(1);
  }

  const { builders, workflowCount } = loadBuilders(ROOT);
  if (builders.length === 0) {
    console.error(`[gov-image-producer-parity] FAIL — no workflow contains an image-build invocation at all (${workflowCount} scanned).`);
    process.exit(1);
  }
  const govBuilderCount = builders.filter((b) => b.gov).length;
  if (govBuilderCount === 0 && !FIXTURE_MODE) {
    console.error('[gov-image-producer-parity] FAIL — not ONE building workflow references AZURE_GOV_CLIENT_ID.');
    console.error('  Either every sovereign image producer was deleted, or the credential moved and this');
    console.error('  guard is now measuring nothing. Both are findings; neither is a pass.');
    process.exit(1);
  }

  const subjects = [
    ...apps.map((a) => ({ name: a, context: `${APPS_DIR}/${a}`, extra: false })),
    ...extras.map((s) => ({ name: s.name, context: s.context, extra: true, why: s.why })),
  ];

  const rows = [];
  const failures = [];

  for (const s of subjects) {
    const { producers, govProducers, mentions } = producersFor(builders, s.context);
    const exempt = GOV_EXEMPT.has(s.name);
    const verdict = classify({ producers, govProducers, exempt, extra: s.extra });

    if (verdict === 'not-my-subject') {
      rows.push({ status: 'unbuilt(*)', name: s.name, via: mentions.length ? `mentioned in ${mentions.join(', ')}` : 'owned by image-producer-coverage' });
      continue;
    }
    if (verdict === 'ok') {
      rows.push({ status: 'ok', name: s.name, via: govProducers.join(', ') });
      continue;
    }
    if (verdict === 'exempt') {
      rows.push({ status: 'EXEMPT', name: s.name, via: producers.join(', ') || 'no producer in any cloud' });
      continue;
    }
    if (verdict === 'stale-exempt') {
      failures.push({
        name: s.name,
        detail: `is in GOV_EXEMPT but IS now built for Gov by ${govProducers.join(', ')} — remove the entry. An exemption that outlives its gap stops being a record and starts being cover.`,
      });
      rows.push({ status: 'STALE-EXEMPT', name: s.name, via: govProducers.join(', ') });
      continue;
    }
    if (verdict === 'no-producer-anywhere') {
      failures.push({
        name: s.name,
        detail: `${s.why || ''} — but NO workflow builds it in ANY cloud. ${mentions.length ? `Named in ${mentions.join(', ')} only as text.` : ''}`.trim(),
      });
      rows.push({ status: 'UNBUILT', name: s.name, via: mentions.join(', ') || '-' });
      continue;
    }
    failures.push({
      name: s.name,
      detail: `is built by ${producers.join(', ')} — none of which can authenticate to Azure Government (no AZURE_GOV_CLIENT_ID). ${s.why || ''}`.trim(),
    });
    rows.push({ status: 'GOV-MISSING', name: s.name, via: producers.join(', ') });
  }

  for (const name of GOV_EXEMPT.keys()) {
    if (!FIXTURE_MODE && !subjects.some((s) => s.name === name)) {
      failures.push({ name, detail: 'is in GOV_EXEMPT but is not a subject of this guard — remove the entry.' });
    }
    if (!String(GOV_EXEMPT.get(name) || '').trim()) {
      failures.push({ name, detail: 'has an empty reason. An exemption without a reason is a mute, not a record.' });
    }
  }

  console.log(`[gov-image-producer-parity] ${subjects.length} subject(s), ${builders.length} building workflow(s), ${govBuilderCount} of them Gov-capable:`);
  for (const r of rows) console.log(`  ${r.status.padEnd(13)} ${r.name.padEnd(28)} ${r.via}`);
  console.log(`\n  ${CONTROLS.length} embedded control(s) held. (*) = no producer in any cloud; owned by check-image-producer-coverage.mjs.`);

  if (failures.length === 0) {
    console.log('\n[gov-image-producer-parity] OK — every built image has a Gov producer, or a recorded, reasoned exemption.');
    process.exit(0);
  }

  console.error(`\n[gov-image-producer-parity] FAIL — ${failures.length} problem(s).\n`);
  for (const f of failures) {
    console.error(`  ${f.name}`);
    console.error(`    ${f.detail}`);
  }
  console.error('\n  An image with no Gov producer is a capability that works in Commercial and cannot');
  console.error('  work in Azure Government. .claude/rules/cloud-parity.md calls that INCOMPLETE, not');
  console.error('  "Commercial-first". Where the consumer is a Container APP the deploy fails outright');
  console.error('  (MANIFEST_UNKNOWN); where it is a Container App JOB the deploy survives and the');
  console.error('  scheduled executions silently never run, which is worse to detect.');
  console.error('  Fix: add the build to a Gov-capable lane — .github/workflows/gov-provision-runner-images.yml');
  console.error('  and gov-provision-dataplane-images.yml are the templates (server-side `az acr build`');
  console.error('  is the ONLY mechanism that reaches a Gov ACR behind its private endpoint) — or, if a');
  console.error('  sovereign deploy genuinely never pulls it, add a GOV_EXEMPT entry WITH the reason.\n');
  process.exit(1);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) main();
