/**
 * Microsoft Graph sovereign-boundary endpoint resolution (#3381).
 *
 * THE DEFECT, AS MEASURED (not as reported):
 *
 *   `lib/auth/msal.ts:graphBase()` was a two-branch switch on `AZURE_CLOUD`
 *   with no DoD case, so DoD fell through to the COMMERCIAL host and IL5 got
 *   the L4 host. That is the issue's headline — but the same shape was in TWO
 *   more places, and the second one was worse:
 *
 *   1. `cloud-endpoints.graphBase()` branched on `isGovCloud()`, which folds
 *      DoD into GCC-High. `LOOM_CLOUD=DoD` therefore produced
 *      `https://graph.microsoft.us/v1.0` — the L4 host — while
 *      `getGraphHost()` in the same file correctly said `dod-graph`.
 *   2. That same function returned `LOOM_GRAPH_BASE` VERBATIM, dropping the
 *      `/v1.0` segment. `platform/fiab/bicep/modules/admin-plane/main.bicep:5363`
 *      sets that variable on EVERY boundary to a bare root, so with the env a
 *      real deploy emits, every caller built an unversioned URL —
 *      `https://graph.microsoft.com/groups/{id}` — which Graph does not serve.
 *      That is a Commercial defect too, not only a Gov one.
 *   3. `getGraphHost()` read neither `LOOM_GRAPH_BASE` nor `LOOM_CLOUD_BOUNDARY`,
 *      and `main.bicep:4743` deliberately sets `LOOM_CLOUD='GCC-High'` when
 *      `boundary=='IL5'` (correct for ARM, which uses the ordinary Gov hosts).
 *      So an IL5 estate was INVISIBLE to the Graph resolver and answered L4.
 *
 * GROUNDING (Microsoft Learn, https://learn.microsoft.com/graph/deployments —
 * "Microsoft Graph and Graph Explorer service root endpoints"):
 *     global service (Commercial)      https://graph.microsoft.com
 *     US Government L4 (GCC High)      https://graph.microsoft.us
 *     US Government L5 (DOD)           https://dod-graph.microsoft.us
 * and, from the same page: "Access tokens acquired for a national cloud
 * deployment are not interchangeable with those acquired for the global service
 * or any other national cloud." GCC is called out explicitly as staying on the
 * worldwide endpoint.
 *
 * MUTATION LEDGER — every row below was RUN, not predicted. Baseline is 10
 * pass / 0 fail (exit 0). Each mutation was applied to cloud-endpoints.ts, the
 * suite re-run, and the file restored; the restore was re-run and came back
 * green, so no row is an artefact of a dirty tree.
 *
 *   M1  getGraphHost() drops its `DoD` case          exit 1, 5 pass / 5 fail
 *   M2  getGraphHost() ignores LOOM_CLOUD_BOUNDARY   exit 1, 7 pass / 3 fail
 *   M3  getGraphHost() returns LOOM_GRAPH_BASE raw   exit 1, 9 pass / 1 fail
 *   M4  graphBase() stops appending /v1.0            exit 1, 5 pass / 5 fail
 *   M5  getGraphHost() hard-coded to one constant    exit 1, 3 pass / 7 fail
 *   M6  graphScope() decoupled from getGraphHost()   exit 1, 9 pass / 1 fail
 *
 * M5 is the anti-vacuity control: a resolver that ignores its input and returns
 * the Commercial host — the shape a lazy "fix" takes — cannot pass. M3 and M6
 * each turn exactly ONE assertion red, which is the evidence those two are
 * measuring something specific rather than riding on the others.
 *
 * Two earlier mutation attempts did NOT apply (CRLF line endings defeated the
 * multi-line match) and the harness ABORTED on them rather than recording the
 * resulting green as proof. That is deliberate: a mutation harness whose
 * mutation silently no-ops is itself a gate that cannot fail.
 *
 * Run: node --test apps/fiab-console/tests/graph-endpoint-boundaries.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '..');

// Imported as SOURCE (node strips the types) so this asserts the real resolver
// the app ships, not a re-typed copy of its table. cloud-endpoints.ts has no
// imports of its own, which is what makes that possible.
const endpoints = await import('../lib/azure/cloud-endpoints.ts');
const { getGraphHost, getGraphScope, graphBase, graphScope, detectLoomCloud } = endpoints;

const ENV_KEYS = ['LOOM_CLOUD', 'AZURE_CLOUD', 'LOOM_CLOUD_BOUNDARY', 'LOOM_GRAPH_BASE'];

/** Run `fn` with exactly `env` set and every other cloud signal cleared. */
function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const COMMERCIAL = 'https://graph.microsoft.com';
const L4 = 'https://graph.microsoft.us';
const L5 = 'https://dod-graph.microsoft.us';

/**
 * The env each boundary ACTUALLY gets, transcribed from
 * platform/fiab/bicep/modules/admin-plane/main.bicep:
 *   :4739  AZURE_CLOUD          = AzureUSGovernment for GCC-High | IL5, else AzureCloud
 *   :4743  LOOM_CLOUD           = boundary == 'IL5' ? 'GCC-High' : boundary
 *   :5363  LOOM_GRAPH_BASE      = GCC-High ? graph.microsoft.us : IL5 ? dod-graph.microsoft.us : graph.microsoft.com
 *   :5393  LOOM_CLOUD_BOUNDARY  = boundary
 * These are the cases that decide whether a REAL estate works, so they are the
 * ones asserted — not a synthetic env no deploy produces.
 */
const BICEP_WIRED = [
  {
    boundary: 'Commercial',
    env: { AZURE_CLOUD: 'AzureCloud', LOOM_CLOUD: 'Commercial', LOOM_CLOUD_BOUNDARY: 'Commercial', LOOM_GRAPH_BASE: COMMERCIAL },
    host: COMMERCIAL,
  },
  {
    boundary: 'GCC',
    env: { AZURE_CLOUD: 'AzureCloud', LOOM_CLOUD: 'GCC', LOOM_CLOUD_BOUNDARY: 'GCC', LOOM_GRAPH_BASE: COMMERCIAL },
    host: COMMERCIAL,
  },
  {
    boundary: 'GCC-High',
    env: { AZURE_CLOUD: 'AzureUSGovernment', LOOM_CLOUD: 'GCC-High', LOOM_CLOUD_BOUNDARY: 'GCC-High', LOOM_GRAPH_BASE: L4 },
    host: L4,
  },
  {
    boundary: 'IL5',
    env: { AZURE_CLOUD: 'AzureUSGovernment', LOOM_CLOUD: 'GCC-High', LOOM_CLOUD_BOUNDARY: 'IL5', LOOM_GRAPH_BASE: L5 },
    host: L5,
  },
];

// ── the defect ─────────────────────────────────────────────────────────────

test('DoD/IL5 resolves to the L5 host, never the L4 host (the #3381 defect)', () => {
  // Signalled three different ways, because three different code paths used to
  // disagree about which of them meant "DoD".
  const dodSignals = [
    { label: 'LOOM_CLOUD=DoD', env: { LOOM_CLOUD: 'DoD' } },
    { label: 'AZURE_CLOUD=AzureDOD', env: { AZURE_CLOUD: 'AzureDOD' } },
    { label: 'LOOM_CLOUD_BOUNDARY=IL5 over a GCC-High LOOM_CLOUD (what bicep emits)', env: { LOOM_CLOUD: 'GCC-High', AZURE_CLOUD: 'AzureUSGovernment', LOOM_CLOUD_BOUNDARY: 'IL5' } },
  ];
  for (const { label, env } of dodSignals) {
    withEnv(env, () => {
      assert.equal(getGraphHost(), L5, `${label}: host`);
      assert.equal(graphBase(), `${L5}/v1.0`, `${label}: versioned base`);
      assert.equal(getGraphScope(), `${L5}/.default`, `${label}: scope`);
      assert.notEqual(getGraphHost(), L4, `${label}: must NOT be the GCC-High (L4) host`);
      assert.notEqual(getGraphHost(), COMMERCIAL, `${label}: must NOT be the worldwide host`);
    });
  }
});

test('every boundary resolves its Learn-documented Graph root', () => {
  const table = [
    { env: { LOOM_CLOUD: 'Commercial' }, host: COMMERCIAL },
    { env: { LOOM_CLOUD: 'GCC' }, host: COMMERCIAL },
    { env: { LOOM_CLOUD: 'GCC-High' }, host: L4 },
    { env: { LOOM_CLOUD: 'DoD' }, host: L5 },
    // No signal at all — a resolver must never crash, and Commercial is the
    // only safe default (it is the one boundary a mis-detect cannot leak into
    // a sovereign tenant, because the tenant simply is not there).
    { env: {}, host: COMMERCIAL },
  ];
  for (const { env, host } of table) {
    withEnv(env, () => {
      assert.equal(getGraphHost(), host, `LOOM_CLOUD=${env.LOOM_CLOUD ?? '(unset)'}`);
    });
  }
});

test('graphBase() ALWAYS carries /v1.0 — including when LOOM_GRAPH_BASE is set', () => {
  // The regression this pins: the old body returned the override verbatim, and
  // bicep sets the override to a BARE ROOT on every boundary, so callers doing
  // `${graphBase()}/groups/x` produced an unversioned URL Graph does not serve.
  for (const { boundary, env, host } of BICEP_WIRED) {
    withEnv(env, () => {
      assert.equal(graphBase(), `${host}/v1.0`, `${boundary}: base`);
      assert.match(graphBase(), /\/v1\.0$/, `${boundary}: ends in the version segment`);
      assert.equal(
        `${graphBase()}/groups/g1/transitiveMembers/u1`,
        `${host}/v1.0/groups/g1/transitiveMembers/u1`,
        `${boundary}: the URL the membership fallback actually builds`,
      );
    });
  }
});

test('LOOM_GRAPH_BASE is honoured and normalised to a root, in either shape', () => {
  // An operator (or a future bicep edit) may supply the value with or without
  // the version segment; both must land on the same pair of strings, and the
  // scope must never carry /v1.0.
  for (const supplied of [L5, `${L5}/`, `${L5}/v1.0`, `${L5}/v1.0/`]) {
    withEnv({ LOOM_CLOUD: 'Commercial', LOOM_GRAPH_BASE: supplied }, () => {
      assert.equal(getGraphHost(), L5, `supplied=${supplied}: root`);
      assert.equal(graphBase(), `${L5}/v1.0`, `supplied=${supplied}: exactly one version segment`);
      assert.equal(getGraphScope(), `${L5}/.default`, `supplied=${supplied}: scope has no version segment`);
      assert.doesNotMatch(getGraphScope(), /v1\.0/, `supplied=${supplied}: scope must not carry /v1.0`);
    });
  }
});

test('an IL5 estate is correct even without LOOM_GRAPH_BASE', () => {
  // platform/fiab/bicep/modules/copilot/maf.bicep wires LOOM_CLOUD_BOUNDARY
  // (:105) but NOT LOOM_GRAPH_BASE, so that app has only the boundary signal —
  // and LOOM_CLOUD is 'GCC-High' there by design. Without the boundary read
  // this case silently answers L4.
  withEnv({ AZURE_CLOUD: 'AzureUSGovernment', LOOM_CLOUD: 'GCC-High', LOOM_CLOUD_BOUNDARY: 'IL5' }, () => {
    assert.equal(getGraphHost(), L5);
    assert.equal(graphBase(), `${L5}/v1.0`);
  });
});

// ── CONTROLS — these must stay GREEN under every fix, and go RED if the
//    resolver is made vacuous. A mapping test that a constant could satisfy
//    measures nothing.

test('CONTROL: the three Graph roots are pairwise distinct', () => {
  const hosts = [
    withEnv({ LOOM_CLOUD: 'Commercial' }, getGraphHost),
    withEnv({ LOOM_CLOUD: 'GCC-High' }, getGraphHost),
    withEnv({ LOOM_CLOUD: 'DoD' }, getGraphHost),
  ];
  assert.equal(new Set(hosts).size, 3, `a resolver that returns one constant cannot pass: ${hosts.join(', ')}`);
});

test('CONTROL: scope and versioned base are derived from the SAME root', () => {
  // Guards the split-brain that produced this bug: two functions in one file
  // that each derived the host independently and disagreed for DoD.
  for (const cloud of ['Commercial', 'GCC', 'GCC-High', 'DoD']) {
    withEnv({ LOOM_CLOUD: cloud }, () => {
      const root = getGraphHost();
      assert.equal(graphBase(), `${root}/v1.0`, `${cloud}: base root`);
      assert.equal(graphScope(), `${root}/.default`, `${cloud}: scope root`);
      assert.equal(graphScope(), getGraphScope(), `${cloud}: the two scope helpers agree`);
    });
  }
});

test('CONTROL: the ARM fold that makes IL5 invisible to detectLoomCloud is INTACT', () => {
  // This is deliberate and must NOT be "fixed" by widening detectLoomCloud():
  // an IL5 estate runs on the ordinary Azure Government ARM/Cosmos/SQL hosts,
  // and main.bicep:4743 encodes exactly that fold. Graph is the one service
  // where L4 and L5 diverge, which is why the boundary read lives in the Graph
  // resolver alone. If this assertion ever flips, re-check armBase() before
  // celebrating — AzureDOD maps ARM to management.azure.microsoft.scloud.
  withEnv({ LOOM_CLOUD: 'IL5' }, () => {
    assert.equal(detectLoomCloud(), 'GCC-High');
  });
  withEnv({ LOOM_CLOUD: 'IL5', LOOM_CLOUD_BOUNDARY: 'IL5' }, () => {
    assert.equal(detectLoomCloud(), 'GCC-High', 'the boundary signal must not leak into the ARM detector');
    assert.equal(getGraphHost(), L5, 'but it MUST reach the Graph resolver');
  });
});

// ── DRIFT CONTROL — a source assertion, and labelled as one.
//
// The functional tests above cannot reach lib/auth/msal.ts (it pulls
// @azure/msal-node and the `@/` alias, neither of which resolves under
// node:test without the app's toolchain). So this checks the ONE property that
// made msal.ts's copy wrong for four years: that it re-derived the mapping
// instead of delegating. It asserts a shape, not behaviour, and is worth
// exactly that much.

test('DRIFT: lib/auth/msal.ts delegates to getGraphHost() instead of re-deriving', () => {
  const src = fs.readFileSync(path.join(CONSOLE_ROOT, 'lib', 'auth', 'msal.ts'), 'utf8');
  const fn = src.match(/export function graphBase\(\)[\s\S]*?\n}/);
  assert.ok(fn, 'graphBase() not found in lib/auth/msal.ts — did it move?');
  const body = fn[0];
  assert.match(body, /return getGraphHost\(\);/, 'must delegate to the one resolver');
  assert.doesNotMatch(body, /graph\.microsoft\./, 'must not hard-code any Graph host literal');
  assert.doesNotMatch(body, /AZURE_CLOUD/, 'must not re-read the cloud env directly');
  assert.match(src, /getGraphHost/, 'must import getGraphHost from cloud-endpoints');
});

test('DRIFT: no console source re-derives a Graph host outside cloud-endpoints.ts', () => {
  // Mechanical sibling sweep — the "seventh consumer" class. Any NEW file that
  // pairs a Graph host literal with a cloud/env branch is a fresh copy of this
  // bug, so it must be listed here deliberately rather than discovered in Gov.
  const roots = ['lib', 'app'].map((d) => path.join(CONSOLE_ROOT, d));
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__' || e.name === '.next') continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name)) continue;
      const rel = path.relative(CONSOLE_ROOT, p).split(path.sep).join('/');
      if (rel === 'lib/azure/cloud-endpoints.ts') continue; // DEFINES the map
      const src = fs.readFileSync(p, 'utf8');
      for (const line of src.split('\n')) {
        // A host literal on the same line as a cloud/env discriminator is the
        // signature of a re-derived mapping. Comments are ignored — they
        // document the map, they do not build a URL from it.
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
        if (!/https:\/\/(dod-)?graph\.microsoft\.(com|us)/.test(line)) continue;
        if (!/AZURE_CLOUD|LOOM_CLOUD|isGovCloud|detectLoomCloud|LOOM_GRAPH_BASE/.test(line)) continue;
        offenders.push(`${rel}: ${t.slice(0, 140)}`);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(
    offenders,
    [],
    `these files re-derive a Graph host instead of calling getGraphHost():\n  ${offenders.join('\n  ')}`,
  );
});
