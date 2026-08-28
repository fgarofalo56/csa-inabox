// Controls for the per-probe SUBSYSTEM SCOPING in the "Probe BFF routes with a
// minted session" step of .github/workflows/gov-bff-verify.yml (#3842).
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
// The step used to decide every probe with ONE cross-cutting regex,
//
//   /"gate"\s*:\s*(true|\{)|not configured|Set LOOM_(UNITY_URL|PURVIEW_ACCOUNT)/i
//
// applied to the whole response body. Measured against the three routes' real
// shapes — not inferred — that regex was wrong three separate ways:
//
//   1. OVER-BROAD. app/api/catalog/metastores/route.ts returns Unity, Purview,
//      OneLake, Cosmos and ARM fields in ONE envelope. Its line 219 emits
//      `purviewError: 'LOOM_PURVIEW_ACCOUNT not configured'`, which matches
//      `not configured` and fails the probe LABELLED "unity-catalog" — for a
//      Purview env var. Live vector, latent only because Purview IS configured
//      in Gov today.
//   2. INVERTED. `"gate"` cannot match `"gated"`. Against the two shapes
//      app/api/admin/domains/purview-status/route.ts actually produces, the
//      regex returns FALSE for the REAL gate (lines 61-72: provisioned, but the
//      Console UAMI lacks a Data Map data-plane role) and TRUE for the benign
//      "set LOOM_PURVIEW_ACCOUNT" hint (line 53). The probe was blind to the one
//      class it exists to catch, and fired on the other.
//   3. VACUOUS. app/api/governance/catalog/route.ts emits no gate marker on any
//      path, so that probe's gate assertion had ZERO population.
//
// ── WHAT IS ACTUALLY UNDER TEST ─────────────────────────────────────────────
// The REAL step body, extracted from the workflow YAML at run time — not a
// copy. Rename the step, delete it, or edit its logic and this suite sees the
// change. The estate is replaced by a node:http stub serving controlled bodies
// at the three probed paths, and BASE points at it.
//
// The fixtures are the routes' OWN output shapes, keys in the order the route
// assigns them, with the gate/hint prose copied verbatim from the route source.
// A fixture that models what the CHECKER expects rather than what the PRODUCER
// emits proves nothing — that is the recurring failure mode this repo has
// shipped past before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const WF = path.join(REPO, '.github', 'workflows', 'gov-bff-verify.yml');
const STEP_NAME = 'Probe BFF routes with a minted session';

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

// ── Extracting the shipped step ─────────────────────────────────────────────

/**
 * Pull the step's `run:` block out of the workflow as text, plus the keys of
 * its sibling `env:` block.
 *
 * Deliberately NOT a YAML library: the `guardrails` job that runs this suite
 * does `actions/setup-node` and no install, so a third-party import would make
 * the whole file throw — and a suite that cannot load is a suite that enforces
 * nothing. Same approach gov-unity-verify-gate.test.mjs takes.
 *
 * Every failure mode throws rather than returning something empty: an extractor
 * that silently yields `''` would make every case below "pass" by running no
 * script at all.
 */
function probeStep() {
  const lines = readFileSync(WF, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${STEP_NAME}`);
  assert.ok(start >= 0, `workflow step "${STEP_NAME}" not found in ${WF} — renamed or removed?`);

  let runAt = -1;
  const envKeys = [];
  let inEnv = false;
  let envIndent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*- name:/.test(l)) break; // next step — no run block
    if (/^\s*env:\s*$/.test(l)) { inEnv = true; envIndent = l.match(/^\s*/)[0].length; continue; }
    if (inEnv) {
      const indent = l.match(/^\s*/)[0].length;
      const kv = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (l.trim() !== '' && indent > envIndent && kv) { envKeys.push(kv[1]); continue; }
      inEnv = false;
    }
    if (/^\s*run:\s*\|\s*$/.test(l)) { runAt = i; break; }
  }
  assert.ok(runAt >= 0, `no "run: |" block under "${STEP_NAME}"`);

  const runIndent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const indent = l.match(/^\s*/)[0].length;
    if (indent <= runIndent) break;
    body.push(l.slice(runIndent + 2));
  }
  const script = body.join('\n');
  assert.ok(script.includes('loom_session='), 'extracted block does not look like the probe step');
  assert.ok(script.includes('const probes = ['), 'extracted block carries no probe table');
  // The split/join above normalises line endings on purpose. A Windows checkout
  // hands this file back CRLF; every mutation below matches on a plain-LF
  // needle, and a stray \r would make those `replace()` calls silently no-op —
  // the mutation then "passes" by having changed nothing at all.
  assert.ok(!script.includes('\r'), 'extracted script carries CR — the mutation needles below would no-op');
  return { script, envKeys };
}

/** Every `process.env.X` the shipped step reads. */
function scriptEnvReads(script) {
  return [...new Set([...script.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
}

// ── The stub estate ─────────────────────────────────────────────────────────
//
// Clean bodies for all three probed routes, in the shape and key order each
// route assigns. A test overrides only the route it is about; the other two
// stay clean so a non-zero exit can only have come from the route under test.

const METASTORES_CLEAN = {
  ok: true,
  unity: [{ metastore_id: 'meta-gov-1', name: 'loom-unity-gov', workspace_hostname: 'loom-unity.internal.usgovvirginia.azurecontainerapps.us' }],
  unityHosts: ['loom-unity.internal.usgovvirginia.azurecontainerapps.us'],
  registrations: [],
  accountApiConfigured: false,
  accountMetastores: [],
  // Present BY DESIGN on Gov's OSS Unity path — there is no Databricks account
  // API there. Classified `info`, so it must not fail the probe.
  accountApiHint: {
    missingEnvVar: 'LOOM_DATABRICKS_ACCOUNT_ID',
    detail:
      'Set LOOM_DATABRICKS_ACCOUNT_ID (the Databricks account GUID) on the Console Container App to enable one-click '
      + 'metastore attach. Registration + catalog listing work without it.',
    bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep (apps[].env)',
  },
  discoverableWorkspaces: [],
  onelake: [],
  purview: { account: 'purview-csa-loom-usgovvirginia', endpoint: 'https://purview-csa-loom-usgovvirginia.purview.azure.us', configured: true },
};

const GOV_CATALOG_CLEAN = {
  ok: true,
  total: 1,
  assets: [{ id: 'itm-1', displayName: 'bronze', itemType: 'lakehouse', workspaceId: 'ws-1', canOpen: true }],
  facets: { itemType: [{ value: 'lakehouse', count: 1 }] },
  workspaces: [{ id: 'ws-1', name: 'gov-ws' }],
  source: 'aisearch',
};

const PURVIEW_STATUS_CLEAN = {
  ok: true,
  purview: { configured: true, domains: [{ id: 'dom-1', name: 'Finance' }] },
};

// purview-status/route.ts lines 61-72 — the REAL gate, verbatim. The Purview
// account answered; the Console UAMI has no Data Map data-plane role on the
// root collection. `gated: true`.
const PURVIEW_STATUS_GATED = {
  ok: true,
  purview: {
    configured: false,
    gated: true,
    hint:
      'Purview is provisioned, but the Loom Console managed identity lacks a Microsoft Purview Data Map '
      + 'data-plane role on the root collection (it answered 403, "Not authorized to access account"). '
      + 'Grant the Console UAMI Data Curator (read/write) — or at minimum Data Reader (read-only) — on the ROOT '
      + 'collection via scripts/csa-loom/grant-purview-datamap-role.sh (run by the csa-loom-post-deploy-bootstrap '
      + 'workflow), then refresh. Classic Data Map roles are collection metadata-policy, NOT ARM RBAC, so they '
      + 'cannot be set in bicep. Domains continue to work from Loom’s Cosmos store in the meantime.',
  },
};

// purview-status/route.ts line 53 — PurviewNotConfiguredError, verbatim.
// `gated: false`, and this is the string the OLD regex fired on.
const PURVIEW_STATUS_NOT_CONFIGURED = {
  ok: true,
  purview: {
    configured: false,
    gated: false,
    hint:
      "Purview mirror inactive — domains live in Loom's Cosmos store and fully work. To also mirror them in "
      + 'Purview, set LOOM_PURVIEW_ACCOUNT (admin-plane/main.bicep apps[] env) and deploy with purviewEnabled=true. '
      + 'NOTE: classic Purview Data Map has no "business domains"; Loom maps domains to Atlas collections/assets instead.',
  },
};

// #4000, defect 1. The body the pre-fix step graded `OK (200)`: a 2xx from the
// purview-status route carrying NO `purview` key at all. The gate predicate's
// own first arm names this case — 'purview status missing from the envelope' —
// and could never reach it, because gates were invoked only for keys already
// present in the body. Not a hypothetical shape: `{ok:true}` is what the route
// would emit if its purview resolution were ever refactored to omit the field,
// and it is what a truncating proxy or a partial serializer produces.
const PURVIEW_STATUS_KEY_ABSENT = { ok: true };

// #4000, defect 2. `ok:false` on a 200 — an error envelope with a success
// status. `ok` was classified `info` on all three probes, so it was printed and
// never graded, while the governance-catalog comment asserted the contract.
const GOV_CATALOG_OK_FALSE = { ...GOV_CATALOG_CLEAN, ok: false };

const ROUTES = {
  '/api/catalog/metastores': METASTORES_CLEAN,
  '/api/governance/catalog': GOV_CATALOG_CLEAN,
  '/api/admin/domains/purview-status': PURVIEW_STATUS_CLEAN,
};

/**
 * Serve the three probed paths. `overrides` replaces the body for one path;
 * everything else stays clean, so a non-zero exit can only have come from the
 * route the case is about. Two harness-only controls may be mixed into an
 * override: `__status` (answer a non-2xx) and `__raw` (answer bytes that are
 * not the JSON of an object). An unrecognised path answers 404 loudly rather
 * than 200-with-nothing.
 */
function handler(overrides = {}) {
  return (req, res) => {
    const url = req.url.split('?')[0];
    const spec = Object.prototype.hasOwnProperty.call(overrides, url) ? overrides[url] : ROUTES[url];
    if (spec === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'stub: no fixture for this path' }));
      return;
    }
    // `__status` / `__raw` are harness controls, not part of any route's
    // contract — strip them so a fixture can never smuggle an extra top-level
    // key past the probe's classification.
    const { __status: status = 200, __raw: raw, ...body } = spec;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(raw !== undefined ? raw : JSON.stringify(body));
  };
}

async function withStub(overrides, fn) {
  const server = http.createServer(handler(overrides));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/**
 * Run the extracted step against the stub.
 *
 * ASYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE. spawnSync blocks this process's
 * event loop for the whole child run, so the stub server — which lives in THIS
 * process — could never accept a connection: every probe would fail with a
 * fetch error and each "must be red" case would pass for entirely the wrong
 * reason. Same trap cross-cloud-drift.test.mjs documents.
 *
 * The env the child gets is built by DELETING every key the script reads from
 * the inherited environment and then adding back only what is supplied here.
 * Ambient values must not be able to stand in for a key the harness forgot:
 * the step opens `set -euo pipefail`, so a missing one aborts with no output
 * from the probe loop at all and reads as a crashed runner rather than a gap
 * in this harness.
 */
function runStep(base, script, supplied) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bff-scope-'));
  const stepPath = path.join(dir, 'step.sh');
  writeFileSync(stepPath, script, 'utf8');
  const env = { ...process.env };
  for (const k of scriptEnvReads(script)) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [stepPath], {
      env: { ...env, SS: 'fixture-session-secret', BASE: base, OID: '00000000-0000-0000-0000-000000000000', ...supplied },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out: `${stdout}${stderr}` }));
  });
}

/** Run the shipped step (or a mutated copy) against `overrides`. */
async function probe(overrides = {}, { script = null, supplied = {} } = {}) {
  const src = script ?? probeStep().script;
  return withStub(overrides, (base) => runStep(base, src, supplied));
}

/** The `::error::` lines for one probe label. */
const errorsFor = (out, label) =>
  out.split('\n').filter((l) => l.startsWith('::error::') && l.includes(label));

// ── Harness integrity ───────────────────────────────────────────────────────

test('HARNESS DRIFT: every env key the shipped step needs is supplied EXPLICITLY', () => {
  const { script, envKeys } = probeStep();
  // The union of what the YAML declares next to the step and what the script
  // actually reads. `SS` and `BASE` come from job-level env / GITHUB_ENV, so
  // reading only the sibling `env:` block would miss them.
  const needed = [...new Set([...envKeys, ...scriptEnvReads(script)])].sort();
  assert.deepEqual(needed, ['BASE', 'OID', 'SS'],
    `the step's env surface changed to ${JSON.stringify(needed)} — teach runStep() to supply the new key(s), `
    + 'or every case below starts failing on a crashed runner instead of on its assertion');
});

test('HISTORICAL INVERSION: the regex this fix removed graded both purview-status shapes BACKWARDS', () => {
  // A hard-coded copy of a REMOVED literal, kept deliberately: there is nothing
  // left in the workflow for it to drift from, and it is the measurement that
  // makes the two controls below meaningful rather than arbitrary. It is the
  // reason `gated:true` had to be a new red and `gated:false` a re-classified
  // one — not a guess about what the old code did.
  const OLD = /"gate"\s*:\s*(true|\{)|not configured|Set LOOM_(UNITY_URL|PURVIEW_ACCOUNT)/i;
  assert.equal(OLD.test(JSON.stringify(PURVIEW_STATUS_GATED)), false,
    'the REAL gate must be one the old regex missed — otherwise the inversion control proves nothing');
  assert.equal(OLD.test(JSON.stringify(PURVIEW_STATUS_NOT_CONFIGURED)), true,
    'the benign hint must be one the old regex fired on');
  // And the over-broad vector, on the route that carries both subsystems.
  const purviewOnly = JSON.stringify({ ...METASTORES_CLEAN, purview: null, purviewError: 'LOOM_PURVIEW_ACCOUNT not configured' });
  assert.equal(OLD.test(purviewOnly), true,
    'a Purview-only finding must be one the old regex failed the UNITY probe on');
});

// ── The controls ────────────────────────────────────────────────────────────

test('all three routes clean -> exit 0', { skip: !bashAvailable }, async () => {
  const r = await probe();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::notice::unity-catalog \(OSS loom-unity\): OK \(200\)/);
  assert.match(r.out, /::notice::purview governance catalog: OK \(200\)/);
  assert.match(r.out, /::notice::purview wiring status: OK \(200\)/);
});

test('SCOPE: a Purview-only finding on /api/catalog/metastores does NOT fail the UNITY probe', { skip: !bashAvailable }, async () => {
  // The defect the issue names. Unity fields are clean; the ONLY thing in the
  // envelope that the old regex could match is the Purview env-var error the
  // route emits at line 219. RED on the pre-fix step.
  const body = { ...METASTORES_CLEAN, purview: null, purviewError: 'LOOM_PURVIEW_ACCOUNT not configured' };
  const r = await probe({ '/api/catalog/metastores': body });
  assert.equal(r.status, 0, `a Purview env var must not fail a probe labelled unity-catalog\n${r.out}`);
  assert.deepEqual(errorsFor(r.out, 'unity-catalog'), []);
});

test('SCOPE MUTATION: un-classifying purviewError flips that same fixture red', { skip: !bashAvailable }, async () => {
  // Asserting green is only meaningful if a plausible change makes it red.
  // Drop the key from the unity probe's `info` list and the fail-closed arm
  // takes it — which also proves the fail-closed arm is live.
  const src = probeStep().script;
  const mutated = src.replace("'purview', 'purviewError',", "'purview',");
  assert.notEqual(mutated, src, "the unity probe's info list moved — this proof no longer targets it");
  const body = { ...METASTORES_CLEAN, purview: null, purviewError: 'LOOM_PURVIEW_ACCOUNT not configured' };
  const r = await probe({ '/api/catalog/metastores': body }, { script: mutated });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /UNCLASSIFIED top-level key "purviewError"/);
});

test('LATE: a real Unity finding past character 260 is REPORTED WITH ITS TOKEN, not a head slice', { skip: !bashAvailable }, async () => {
  // The acceptance criterion from #3842. `unityWorkspaceErrors[].message` is
  // built by describeWorkspaceFailure() (unity-workspace-failure.ts arm 1); this
  // is that arm's exact sentence for the OSS-auth config gate. The long
  // unityHosts list ahead of it is what pushes the deciding text past 260 —
  // the same reason the real run's printed head contained no match.
  const SENTINEL = 'LOOM_UNITY_CLIENT_ID / LOOM_UNITY_AUDIENCE';
  const body = {
    ok: true,
    unity: [],
    unityHosts: [
      'adb-1111111111111111.11.azuredatabricks.us',
      'adb-2222222222222222.22.azuredatabricks.us',
      'adb-3333333333333333.33.azuredatabricks.us',
      'loom-unity.internal.usgovvirginia.azurecontainerapps.us',
    ],
    unityWorkspaceErrors: [{
      workspace_hostname: 'loom-unity.internal.usgovvirginia.azurecontainerapps.us',
      message:
        '(workspace loom-unity.internal.usgovvirginia.azurecontainerapps.us not configured — no request was '
        + 'attempted: Loom Unity OSS authorization is enabled but no client credentials are configured; deploy '
        + `platform/fiab/bicep/modules/admin-plane/unity.bicep; Set ${SENTINEL} on the Console Container App.)`,
      accountAdmin: false,
    }],
    registrations: [],
    accountApiConfigured: false,
    accountMetastores: [],
    discoverableWorkspaces: [],
    onelake: [],
    purview: METASTORES_CLEAN.purview,
  };
  const serialized = JSON.stringify(body);
  assert.ok(serialized.indexOf(SENTINEL) > 260,
    `the fixture must place the deciding text past the old 260-char head; it is at ${serialized.indexOf(SENTINEL)}`);

  const r = await probe({ '/api/catalog/metastores': body });
  assert.equal(r.status, 1, r.out);
  const [line, ...rest] = errorsFor(r.out, 'unity-catalog');
  assert.equal(rest.length, 0, `expected exactly one unity finding, got:\n${r.out}`);
  assert.ok(line.includes(SENTINEL),
    `the ::error:: line must CONTAIN the text that decided it, not a prefix taken from elsewhere:\n${line}`);
  assert.match(line, /field "unityWorkspaceErrors" at offset \d+ of \d+/);
});

test('LATE MUTATION: reverting the window to the fixed 260-char head drops the token', { skip: !bashAvailable }, async () => {
  // The regression #3842 filed, reintroduced verbatim. If this still passed,
  // the control above would be asserting nothing about where the excerpt comes
  // from.
  const src = probeStep().script;
  const mutated = src.replace(
    ': `field ${JSON.stringify(key)} at offset ${i} of ${t.length}: ${excerpt(t, i, 40, 660)}`;',
    ': `field ${JSON.stringify(key)} at offset ${i} of ${t.length}: ${flat(t.slice(0, 260))}`;',
  );
  assert.notEqual(mutated, src, 'the evidence window moved — this proof no longer targets it');
  const SENTINEL = 'LOOM_UNITY_CLIENT_ID / LOOM_UNITY_AUDIENCE';
  const body = {
    ok: true,
    unity: [],
    unityHosts: [
      'adb-1111111111111111.11.azuredatabricks.us',
      'adb-2222222222222222.22.azuredatabricks.us',
      'adb-3333333333333333.33.azuredatabricks.us',
      'loom-unity.internal.usgovvirginia.azurecontainerapps.us',
    ],
    unityWorkspaceErrors: [{
      workspace_hostname: 'loom-unity.internal.usgovvirginia.azurecontainerapps.us',
      message: `(workspace X not configured — no request was attempted: Set ${SENTINEL} on the Console Container App.)`,
      accountAdmin: false,
    }],
    registrations: [],
    accountApiConfigured: false,
    accountMetastores: [],
    discoverableWorkspaces: [],
    onelake: [],
    purview: METASTORES_CLEAN.purview,
  };
  const r = await probe({ '/api/catalog/metastores': body }, { script: mutated });
  assert.equal(r.status, 1, r.out);
  const [line] = errorsFor(r.out, 'unity-catalog');
  assert.ok(!line.includes(SENTINEL),
    `the head-slice mutation must LOSE the deciding text — if it keeps it, the fixture is not exercising the window:\n${line}`);
});

test('INVERSION: purview-status `gated:true` FAILS the probe', { skip: !bashAvailable }, async () => {
  // The class the probe exists to catch, and the one the old regex was blind
  // to. RED on the pre-fix step, where this body produced `OK (200)`.
  const r = await probe({ '/api/admin/domains/purview-status': PURVIEW_STATUS_GATED });
  assert.equal(r.status, 1, `a Data Map role gate must fail the purview probe\n${r.out}`);
  const [line, ...rest] = errorsFor(r.out, 'purview wiring status');
  assert.equal(rest.length, 0, r.out);
  assert.match(line, /purview\.gated=true/);
  assert.match(line, /Data Map data-plane role/);
  assert.match(line, /field "purview" at offset \d+ of \d+/);
});

test('INVERSION MUTATION: making the purview predicate blind again turns the gate green', { skip: !bashAvailable }, async () => {
  const src = probeStep().script;
  const mutated = src.replace('if (v.configured === true) return false;', 'return false;');
  assert.notEqual(mutated, src, 'the purview predicate moved — this proof no longer targets it');
  const r = await probe({ '/api/admin/domains/purview-status': PURVIEW_STATUS_GATED }, { script: mutated });
  assert.equal(r.status, 0,
    `the weakened predicate must pass — otherwise the red above was not caused by this check\n${r.out}`);
});

test('CLASSIFICATION: the `gated:false` env-unset hint still fails, but is NOT reported as "gated"', { skip: !bashAvailable }, async () => {
  // The other half of the inversion. This one DOES stay red — Purview is a
  // backend this repo wires, so `LOOM_PURVIEW_ACCOUNT` going unset on the
  // estate is a real regression and dropping it would be a coverage loss. What
  // changes is truthfulness (deploy-integrity.md R7): the old line asserted
  // "still gated" about a payload that says `gated:false`.
  const r = await probe({ '/api/admin/domains/purview-status': PURVIEW_STATUS_NOT_CONFIGURED });
  assert.equal(r.status, 1, r.out);
  const [line] = errorsFor(r.out, 'purview wiring status');
  assert.match(line, /purview\.configured=false/);
  assert.ok(!/purview\.gated=true/.test(line),
    `must not claim the gate class the payload denies:\n${line}`);
});

test('CLASSIFICATION MUTATION: swapping the two arms mis-labels the env-unset case', { skip: !bashAvailable }, async () => {
  // Both arms exit 1, so an exit-code assertion alone could not tell them
  // apart. Invert the discriminator and confirm the LABEL moves — that is what
  // makes the message assertion above a control rather than decoration.
  const src = probeStep().script;
  const mutated = src.replace('return v.gated === true', 'return v.gated !== true');
  assert.notEqual(mutated, src, 'the gated discriminator moved — this proof no longer targets it');
  const r = await probe({ '/api/admin/domains/purview-status': PURVIEW_STATUS_NOT_CONFIGURED }, { script: mutated });
  assert.equal(r.status, 1, r.out);
  const [line] = errorsFor(r.out, 'purview wiring status');
  assert.match(line, /purview\.gated=true/, `expected the mutated arm to mis-label:\n${line}`);
});

test('VACUITY CLOSED: a new gate field on /api/governance/catalog fails the probe', { skip: !bashAvailable }, async () => {
  // That route emits no gate marker today, which is why its old assertion had
  // zero population. Inclusion-scoping alone would keep it at zero forever, so
  // the step fails closed on an unclassified top-level key: the day the route
  // grows one, the probe goes red and demands it be classified.
  const body = { ...GOV_CATALOG_CLEAN, purviewGate: { title: 'Purview scan credential missing' } };
  const r = await probe({ '/api/governance/catalog': body });
  assert.equal(r.status, 1, `an unclassified key must not be silently ignored\n${r.out}`);
  const [line] = errorsFor(r.out, 'purview governance catalog');
  assert.match(line, /UNCLASSIFIED top-level key "purviewGate"/);
  assert.match(line, /field "purviewGate" at offset \d+ of \d+/);
});

test('VACUITY MUTATION: ignoring unknown keys makes that same body green', { skip: !bashAvailable }, async () => {
  const src = probeStep().script;
  const mutated = src.replace('} else if (!info.includes(k)) {', '} else if (false && !info.includes(k)) {');
  assert.notEqual(mutated, src, 'the fail-closed arm moved — this proof no longer targets it');
  const body = { ...GOV_CATALOG_CLEAN, purviewGate: { title: 'Purview scan credential missing' } };
  const r = await probe({ '/api/governance/catalog': body }, { script: mutated });
  assert.equal(r.status, 0,
    `with the fail-closed arm disabled the same body must pass — otherwise the red above came from elsewhere\n${r.out}`);
});

test('a 2xx body that is not a JSON object is NOT assumed clean', { skip: !bashAvailable }, async () => {
  // A Front Door interstitial answering 200 has no top-level keys at all, so an
  // object scan would find nothing to fail on. Unparseable is UNKNOWN, and an
  // unknown reported as a pass is the failure mode this whole file is about.
  const r = await probe({ '/api/governance/catalog': { __raw: '<html>request is blocked</html>' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /purview governance catalog: 2xx body is not a JSON object/);
});

test('a non-2xx status is classified as a status, never as a subsystem gate', { skip: !bashAvailable }, async () => {
  // deploy-integrity.md R7: a 403 error page is not evidence about Purview
  // wiring, and the old ladder graded gate markers BEFORE it read the status.
  const r = await probe({
    '/api/admin/domains/purview-status': { __status: 403, ...PURVIEW_STATUS_NOT_CONFIGURED },
  });
  assert.equal(r.status, 1, r.out);
  const [line] = errorsFor(r.out, 'purview wiring status');
  assert.match(line, /HTTP 403 — expected 2xx/);
  assert.ok(!/purview\.configured=false/.test(line),
    `an error page must not be read as a subsystem verdict:\n${line}`);
});

// ── #4000 defect 1: a declared gate key ABSENT from the envelope ────────────

test('ABSENT KEY: a purview-status 2xx with no `purview` key FAILS the probe', { skip: !bashAvailable }, async () => {
  // The condition the probe announces it watches and did not. Measured on the
  // pre-fix step this body produced `::notice::purview wiring status: OK (200)`
  // and exit 0 — a probe named "purview wiring status" reporting OK over a body
  // carrying no purview status.
  const r = await probe({ '/api/admin/domains/purview-status': PURVIEW_STATUS_KEY_ABSENT });
  assert.equal(r.status, 1, `an absent required key must not be graded clean\n${r.out}`);
  const [line, ...rest] = errorsFor(r.out, 'purview wiring status');
  assert.equal(rest.length, 0, r.out);
  assert.match(line, /MISSING required top-level key "purview"/);
  // deploy-integrity.md R7: the line must say the key is not in the body, not
  // report a fabricated offset 0 as if it had located it.
  assert.match(line, /offset unknown — the key is not literally present in the raw body/);
});

test('ABSENT KEY MUTATION: dropping `purview` from that probe\'s `required` list makes the same body green', { skip: !bashAvailable }, async () => {
  // The counterfactual. If this still went red, the red above would not have
  // been caused by the required rule this change adds.
  const src = probeStep().script;
  const mutated = src.replace(
    /required: \['ok', 'purview'\],(\s*)gates: \{(\s*)ok: okTrue,(\s*)purview: \(v\)/,
    "required: ['ok'],$1gates: {$2ok: okTrue,$3purview: (v)",
  );
  assert.notEqual(mutated, src, "the purview-status probe's required list moved — this proof no longer targets it");
  const r = await probe({ '/api/admin/domains/purview-status': PURVIEW_STATUS_KEY_ABSENT }, { script: mutated });
  assert.equal(r.status, 0,
    `without the required entry the absent key must go unnoticed — that is the defect being fixed\n${r.out}`);
  assert.match(r.out, /::notice::purview wiring status: OK \(200\)/);
});

test('PRESENT KEY UNCHANGED: a present-but-null `purview` still fires the predicate, and is NOT called missing', { skip: !bashAvailable }, async () => {
  // The arm that WAS reachable before this change must keep working, and must
  // now be truthful about which case it is: the key is present, so claiming it
  // is "missing from the envelope" would be the R7 error in the other
  // direction. The required rule must NOT fire here — presence is
  // hasOwnProperty, not truthiness.
  const r = await probe({ '/api/admin/domains/purview-status': { ok: true, purview: null } });
  assert.equal(r.status, 1, r.out);
  const [line, ...rest] = errorsFor(r.out, 'purview wiring status');
  assert.equal(rest.length, 0, `a present-but-null value must produce exactly one finding, not a missing-key one too:\n${r.out}`);
  assert.match(line, /purview is present but is null, not a status object/);
  assert.ok(!/MISSING required top-level key/.test(line),
    `the key IS present — the finding must not claim absence:\n${line}`);
  assert.match(line, /field "purview" at offset \d+ of \d+/);
});

test('POPULATION FLOOR: a probe declaring no required keys aborts the job', { skip: !bashAvailable }, async () => {
  // An empty `required` list would grade `{}` as a clean envelope, which is the
  // exact shape this defect is about. A table that cannot detect it is a defect
  // in the step, so it must be loud rather than a quietly narrower probe — and
  // it must be loud even when every route answers perfectly.
  const src = probeStep().script;
  const mutated = src.replace("required: ['ok', 'total', 'assets', 'workspaces', 'source'],", 'required: [],');
  assert.notEqual(mutated, src, "the governance-catalog required list moved — this proof no longer targets it");
  const r = await probe({}, { script: mutated });
  assert.equal(r.status, 1, `an empty required list must fail even with all three routes clean\n${r.out}`);
  assert.match(r.out, /probe table defect: purview governance catalog declares no required top-level keys/);
});

test('POPULATION FLOOR: a required key classified in neither gates nor info aborts the job', { skip: !bashAvailable }, async () => {
  // Otherwise a typo in `required` would fail every run on the UNCLASSIFIED arm
  // — red for the wrong reason, which sends the reader at the wrong subsystem.
  const src = probeStep().script;
  const mutated = src.replace("required: ['ok', 'total', 'assets', 'workspaces', 'source'],", "required: ['ok', 'assetz'],");
  assert.notEqual(mutated, src, 'the governance-catalog required list moved — this proof no longer targets it');
  const r = await probe({}, { script: mutated });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /probe table defect: purview governance catalog requires "assetz" but classifies it in neither gates nor info/);
});

// ── #4000 defect 2: the `ok:true` contract the comment claimed and the code
//    did not grade ─────────────────────────────────────────────────────────

test('OK CONTRACT: `ok:false` on a 200 FAILS the governance-catalog probe', { skip: !bashAvailable }, async () => {
  // Measured on the pre-fix step: this body returned `OK (200)` and exit 0
  // while the step's own comment said "Its real contract is 2xx + `ok:true`".
  const r = await probe({ '/api/governance/catalog': GOV_CATALOG_OK_FALSE });
  assert.equal(r.status, 1, `a 2xx error envelope must not be graded clean\n${r.out}`);
  const [line, ...rest] = errorsFor(r.out, 'purview governance catalog');
  assert.equal(rest.length, 0, r.out);
  assert.match(line, /ok is not true on a 2xx — the route returned an error envelope \(ok=false\)/);
  assert.match(line, /field "ok" at offset \d+ of \d+/);
});

test('OK CONTRACT: the same is graded on the other two probes, not just one', { skip: !bashAvailable }, async () => {
  // The comment named one route; `ok:true` is the 2xx contract of all three
  // (metastores/route.ts:115, purview-status/route.ts:89). Grading it on one
  // probe only would leave the same hole open on the other two.
  const a = await probe({ '/api/catalog/metastores': { ...METASTORES_CLEAN, ok: false } });
  assert.equal(a.status, 1, a.out);
  assert.match(errorsFor(a.out, 'unity-catalog')[0], /ok is not true on a 2xx/);

  const b = await probe({ '/api/admin/domains/purview-status': { ...PURVIEW_STATUS_CLEAN, ok: false } });
  assert.equal(b.status, 1, b.out);
  assert.match(errorsFor(b.out, 'purview wiring status')[0], /ok is not true on a 2xx/);
});

test('OK CONTRACT MUTATION: re-classifying `ok` as info makes that same body green', { skip: !bashAvailable }, async () => {
  // The pre-fix state, reintroduced verbatim: `ok` back in `info`, out of
  // `gates`. If this still went red, the red above came from somewhere else.
  const src = probeStep().script;
  const mutated = src
    .replace(
      /ok: okTrue,(\s*)error: gate\('route returned an error envelope on a 2xx'\),/,
      "error: gate('route returned an error envelope on a 2xx'),",
    )
    .replace(
      "info: ['total', 'assets', 'facets', 'workspaces', 'source', 'code'],",
      "info: ['ok', 'total', 'assets', 'facets', 'workspaces', 'source', 'code'],",
    );
  assert.notEqual(mutated, src, "the governance-catalog probe's ok classification moved — this proof no longer targets it");
  const r = await probe({ '/api/governance/catalog': GOV_CATALOG_OK_FALSE }, { script: mutated });
  assert.equal(r.status, 0, `with ok back in info the same body must pass\n${r.out}`);
  assert.match(r.out, /::notice::purview governance catalog: OK \(200\)/);
});

test('EVERY probed path is graded — a route the stub does not serve goes red', { skip: !bashAvailable }, async () => {
  // Guards the harness itself: if the probe table were reduced to one entry,
  // or a path renamed, the cases above would still pass while covering less.
  const r = await probe({ '/api/catalog/metastores': undefined });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /unity-catalog \(OSS loom-unity\): HTTP 404 — expected 2xx/);
});
