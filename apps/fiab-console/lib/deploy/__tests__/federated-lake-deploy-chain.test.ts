/**
 * FEDERATED LAKE ACCESS — deploy-chain invariants (#2678, #2757).
 *
 * ## What was actually broken
 *
 * Two services made "federated lake access" a documented capability rather than
 * a working one, and both failures were invisible to every existing gate:
 *
 * 1. **The N1 Iceberg REST Catalog was invoked by NOTHING.**
 *    `data-plane/iceberg-catalog-aca.bicep` existed and was correct, but no
 *    orchestrator called it — it was orphan-allowlisted as an "out-of-band
 *    standalone entrypoint", and the only automated producer was a best-effort
 *    step in `csa-loom-post-deploy-bootstrap.yml`, a dispatch-only workflow that
 *    last ran 2026-07-19 (#2775). The terminal user-facing state was literally
 *    "Set LOOM_ICEBERG_CATALOG_URL", which `.claude/rules/auto-bind-by-default.md`
 *    §5 forbids. On the live Commercial estate the var instead held the
 *    placeholder `https://0.0.0.0:3000/api/catalog/iceberg`.
 *
 * 2. **The Trino engine was handed an EMPTY catalog URL by design.**
 *    A "Federated SQL" engine with no Iceberg catalog answers `SHOW CATALOGS`
 *    with `jmx` + `memory` and cannot see the lake at all — running, but not
 *    federating. The two services only deliver the capability together, so the
 *    binding BETWEEN them is the invariant that matters.
 *
 * ## Why this file asserts the COMPILED ARM and not only the bicep
 *
 * `scripts/ci/check-env-sync.mjs` collects every `LOOM_*` emitted ANYWHERE under
 * `platform/fiab/bicep` and never asks WHICH app receives it. Measured while
 * writing these tests: deleting the Console's `LOOM_ICEBERG_CATALOG_URL` line
 * entirely left that guard GREEN, because `loom-trino-aca.bicep` emits the same
 * name onto the Trino container. So env-sync cannot prove Console wiring, and a
 * test that only greps the bicep source inherits the same blind spot.
 *
 * `apps/fiab-console/deploy-templates/main.json` is the compiled artifact that
 * is COPY'd into the console image and submitted to ARM, held byte-identical to
 * a fresh build by `scripts/ci/check-deploy-template-sync.mjs`. Asserting the
 * CONSOLE's own env array inside it is app-scoped and is the thing that deploys
 * (#2945: the code merged, the artifact that deploys did not carry it).
 *
 * NOT a substitute for the live E2E receipt (rule G1) — see the PR body for what
 * a deploy does and does not prove.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// apps/fiab-console/lib/deploy/__tests__ -> repo root
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const ADMIN_PLANE = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
const ROOT_BICEP = 'platform/fiab/bicep/main.bicep';
const ARM_ARTIFACT = 'apps/fiab-console/deploy-templates/main.json';

/**
 * The CONSOLE's env array, as a single compiled ARM expression string.
 *
 * Identified by `LOOM_TRANSFORM_RUNNER_URL`, which only the Console receives —
 * this is what makes the assertions below APP-SCOPED rather than "the name
 * appears somewhere in a 3.5 MB template".
 */
function consoleEnvExpression(): string {
  const arm = JSON.parse(read(ARM_ARTIFACT));
  const hits: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.includes('LOOM_TRANSFORM_RUNNER_URL')) hits.push(node);
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { Object.values(node).forEach(walk); }
  };
  walk(arm);
  // Exactly one expression builds the Console env list. If this ever becomes 0
  // the locator itself is stale and every assertion below would vacuously pass,
  // so assert it rather than trusting it.
  expect(hits.length).toBeGreaterThan(0);
  return hits.join('\n');
}

describe('N1 Iceberg REST Catalog — deployed BY the orchestrator, not asked of the operator', () => {
  it('is invoked as a module from admin-plane/main.bicep', () => {
    const src = read(ADMIN_PLANE);
    expect(src).toMatch(
      /module icebergCatalog '\.\.\/data-plane\/iceberg-catalog-aca\.bicep' = if \(icebergCatalogActive\)/,
    );
  });

  it('is DEFAULT-ON (opt-out), gated only on the Container Apps prerequisites', () => {
    const src = read(ADMIN_PLANE);
    // loom_default_on_opt_out: absence of the key must mean ENABLED.
    expect(src).toMatch(
      /var icebergCatalogEnabled = \(loomBackends\.\?icebergCatalog \?\? 'enabled'\) != 'disabled'/,
    );
    expect(src).toMatch(
      /var icebergCatalogActive = icebergCatalogEnabled && containerPlatform == 'containerApps' && deployAppsEnabled/,
    );
    // The root orchestrator passes the key through explicitly as enabled.
    expect(read(ROOT_BICEP)).toMatch(/icebergCatalog: 'enabled'/);
  });

  it('adds ZERO top-level params — it rides the config bag + loomBackends', () => {
    // platform/fiab/bicep/main.bicep is at 251/256 ARM params. A regression that
    // introduces a top-level param for this feature is a deploy blocker, not a
    // style nit, so the ceiling is asserted rather than remembered.
    const arm = JSON.parse(read(ARM_ARTIFACT));
    expect(Object.keys(arm.parameters ?? {}).length).toBeLessThanOrEqual(256);
    expect(read(ROOT_BICEP)).not.toMatch(/^param icebergCatalog/m);
    expect(read(ADMIN_PLANE)).not.toMatch(/^param icebergCatalog/m);
  });

  it('does NOT scale to zero — zero replicas DESTROYS the ephemeral catalog', () => {
    const src = read(ADMIN_PLANE);
    const block = src.slice(src.indexOf("module icebergCatalog '../data-plane/iceberg-catalog-aca.bicep'"));
    const body = block.slice(0, block.indexOf('\n}\n'));

    // THIS TEST USED TO ASSERT THE OPPOSITE — "scales to zero, so DEFAULT-ON is
    // also ~$0/mo at idle". That was a cost optimisation that silently ate data.
    //
    // iceberg-catalog runs the loom-unity image on an EPHEMERAL H2 store
    // (LOOM_UNITY_DB_LOCAL=1 -> /tmp/loom-unity-db), so scaling to zero destroys
    // the warehouse, its namespaces and every grant. Measured live 2026-08-09:
    // the app logged "seeding empty catalog DB dir" and re-ran WAREHOUSE-BIND on
    // every wake, while the sibling loom-unity — same image, same DB mode, but
    // minReplicas 1 — kept its state.
    //
    // iceberg-catalog-aca.bicep's own default is 1 and it documents why:
    // "the catalog is on the metadata hot path (never scale-to-zero)". The
    // orchestrator was overriding a correct default with a cheaper broken one.
    //
    // COST, stated rather than buried: that module also records
    // "~$100-200/mo/cloud always-on". This is a STOPGAP. The real fix is the
    // durable Postgres store (data-plane/loom-unity-postgres.bicep, #3110) —
    // with `catalogDbUrl` set, scale-to-zero becomes safe again and the cost
    // can come back off.
    expect(body).not.toMatch(/minReplicas: 0/);
    expect(body).toMatch(/minReplicas: 1/);
  });
});

describe('the CONSOLE actually receives the catalog + engine bindings', () => {
  it('binds LOOM_ICEBERG_CATALOG_URL to the icebergCatalog module output', () => {
    const env = consoleEnvExpression();
    // Not merely present, and not a literal: bound to the deployed app's FQDN.
    expect(env).toContain(
      "createObject('name', 'LOOM_ICEBERG_CATALOG_URL', 'value', "
      + "if(variables('icebergCatalogActive'), format('https://{0}', "
      + "reference('icebergCatalog').outputs.fqdn.value), ''))",
    );
  });

  it('binds LOOM_TRINO_URL to the trinoEngine module output', () => {
    expect(consoleEnvExpression()).toContain(
      "createObject('name', 'LOOM_TRINO_URL', 'value', "
      + "if(variables('trinoEngineActive'), reference('trinoEngine')"
      + ".outputs.trinoInternalEndpoint.value, ''))",
    );
  });

  it('tells the BFF the DEPLOYED auth posture (#2678 §2 — never fail open)', () => {
    // Without this the client cannot distinguish "enforced + reachable" from
    // "enforced + nobody can mint a token", and a SEALED engine would be sent a
    // query that returns an opaque 401 while the surface claimed it was fine.
    const env = consoleEnvExpression();
    expect(env).toContain("createObject('name', 'LOOM_TRINO_AUTH_MODE', 'value'");
    expect(env).toContain("createObject('name', 'LOOM_TRINO_AUDIENCE', 'value'");
    expect(env).toContain("createObject('name', 'LOOM_TRINO_CATALOG_POLICY', 'value'");
  });
});

describe('the federation loop closes — Trino can see the lake', () => {
  it('passes the catalog URL from the icebergCatalog module INTO the Trino engine', () => {
    const src = read(ADMIN_PLANE);
    // The regression this locks: `icebergCatalogUrl: ''`, which is what the
    // engine used to be handed. A hard-coded empty string here means SHOW
    // CATALOGS returns jmx + memory and the lake is invisible — a default-ON
    // "Federated SQL" engine that federates nothing.
    expect(src).not.toMatch(/icebergCatalogUrl: ''/);
    expect(src).toMatch(/icebergCatalogUrl: icebergCatalogUrl/);
    expect(src).toMatch(
      /var icebergCatalogUrl = icebergCatalogActive \? 'https:\/\/\$\{icebergCatalog!\.outputs\.fqdn\}' : ''/,
    );
  });

  it('the compiled ARM really wires that param from the catalog output', () => {
    // Source-level intent is not deployment reality (#2945). The nested Trino
    // deployment must receive the reference, not a literal.
    const arm = read(ARM_ARTIFACT);
    expect(arm).toContain(
      `"icebergCatalogUrl": "[if(variables('icebergCatalogActive'), createObject('value', `
      + `format('https://{0}', reference('icebergCatalog').outputs.fqdn.value)), `
      + `createObject('value', ''))]"`,
    );
  });
});

describe('N7e Trino engine — default-ON means default-SAFE', () => {
  it('is DEFAULT-ON (opt-out) and deployed from the orchestrator', () => {
    const src = read(ADMIN_PLANE);
    expect(src).toMatch(/var trinoEngineEnabled = \(loomBackends\.\?trino \?\? 'enabled'\) != 'disabled'/);
    expect(src).toMatch(/module trinoEngine '\.\.\/data-plane\/loom-trino-aca\.bicep' = if \(trinoEngineActive\)/);
    expect(read(ROOT_BICEP)).toMatch(/trino: 'enabled'/);
  });

  it('enforces Entra authorization unless an operator EXPLICITLY opts out', () => {
    const src = read(ADMIN_PLANE);
    // Anything other than a deliberate 'disabled' must normalize to enforced —
    // a typo in the params bag must not silently produce an anonymous engine.
    expect(src).toMatch(/authMode: trinoAuthMode == 'disabled' \? 'disabled' : 'entra'/);
    // With no pinnable audience the posture is SEALED, never anonymous.
    expect(src).toMatch(
      /var trinoAuthPosture = trinoAuthMode == 'disabled' \? 'disabled' : \(empty\(trinoAudienceClientId\) \? 'sealed' : 'entra'\)/,
    );
  });

  it('renders deny-by-default engine-level catalog access control', () => {
    expect(read(ADMIN_PLANE)).toMatch(
      /accessControl: string\(loomBackends\.\?trinoAccessControl \?\? 'file'\) == 'none' \? 'none' : 'file'/,
    );
  });
});
