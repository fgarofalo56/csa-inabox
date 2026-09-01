/**
 * ICEBERG / UNITY CATALOG — dedicated audience + durable metadata (#3339, #3110).
 *
 * ## The two defects these specs lock
 *
 * 1. **The catalog's Entra audience WAS the console's own sign-in app.**
 *    `admin-plane/main.bicep` passed `entraClientId: effectiveMsalClientId` to
 *    BOTH the `iceberg-catalog` and `loom-unity` module calls, and
 *    `apps/loom-unity/bin/loom-entrypoint.sh` derives the audiences a catalog
 *    accepts as `api://<clientId>,<clientId>`. The sign-in registration carries
 *    `appRoles: []` and `oauth2PermissionScopes: []`. So every interactive
 *    console sign-in token was ALSO a valid catalog subject token, and the
 *    catalog had no claim with which to express who may call it — a
 *    trust-boundary collapse, not a naming smell.
 *
 *    Compounding it, `LOOM_ICEBERG_CATALOG_AUDIENCE` was set by NOTHING on any
 *    estate (`scripts/ci/check-env-sync.mjs` allowlisted it as a "runtime-only
 *    knob" and no bicep emitted it), so `lib/azure/iceberg-catalog-client.ts`
 *    `resolveIcebergAuth` always took its documented fallback —
 *    `api://<LOOM_MSAL_CLIENT_ID>/.default`, i.e. the sign-in app again.
 *
 * 2. **The catalog's metadata store was per-replica and ephemeral.** Nothing
 *    passed `catalogDbUrl`, so `iceberg-catalog-aca.bicep` took its
 *    `LOOM_UNITY_DB_LOCAL=1` branch — an H2 file DB inside the replica. Every
 *    revision roll (not only a scale-to-zero) discarded the warehouse, every
 *    namespace and every grant. `minReplicas: 1` fixed the scale-to-zero half
 *    only; a roll fires on every deploy. #3110 §1 calls this the amnesiac
 *    catalog.
 *
 * ## Why these specs read the COMPILED ARM as well as the bicep
 *
 * Source-level intent is not deployment reality (#2945: the code merged, the
 * artifact that deploys did not carry it). `apps/fiab-console/deploy-templates/
 * main.json` is the artifact COPY'd into the console image and submitted to ARM,
 * held byte-identical to a fresh build by
 * `scripts/ci/check-deploy-template-sync.mjs`. The Console-scoped assertions
 * below are made against the Console's OWN env expression inside it, because
 * `check-env-sync.mjs` only asks whether a `LOOM_*` name appears ANYWHERE under
 * `platform/fiab/bicep` — never which app receives it.
 *
 * ## What these specs do NOT prove (stated, not implied)
 *
 * They prove the WIRING. They do not prove the live 403 in #3339 is fixed: the
 * measured trail shows `step=exchange outcome=minted status=200` followed by
 * `step=catalog-call outcome=denied status=403`, so the audience is validated
 * successfully before the denial. Fix 1 closes a real trust boundary; fix 2 is
 * the best-supported remaining candidate for the 403 AND independently removes
 * the amnesia. Neither is a substitute for the G1 in-browser receipt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// apps/fiab-console/lib/deploy/__tests__ -> repo root
const REPO = join(__dirname, '..', '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

const ADMIN_PLANE = 'platform/fiab/bicep/modules/admin-plane/main.bicep';
const ROOT_BICEP = 'platform/fiab/bicep/main.bicep';
const CATALOG_MODULE = 'platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep';
const ARM_ARTIFACT = 'apps/fiab-console/deploy-templates/main.json';
const MSAL_BOOTSTRAP = 'scripts/csa-loom/bootstrap-msal-app-reg.sh';
const CATALOG_BOOTSTRAP = 'scripts/csa-loom/bootstrap-catalog-app-reg.sh';

/**
 * The CONSOLE's env array, as a single compiled ARM expression string.
 *
 * Located by `LOOM_TRANSFORM_RUNNER_URL`, which only the Console receives — the
 * same locator `federated-lake-deploy-chain.test.ts` uses. This is what makes
 * the env assertions APP-SCOPED rather than "the name appears somewhere in a
 * 3.9 MB template".
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
  // If this ever becomes 0 the locator is stale and every assertion below would
  // pass vacuously, so assert it rather than trusting it.
  expect(hits.length).toBeGreaterThan(0);
  return hits.join('\n');
}

/** The body of a `module <name> '...' = ...` call in a bicep file. */
function moduleBody(src: string, header: string): string {
  const at = src.indexOf(header);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/** Executable (non-comment, non-echo) lines of a shell script. */
function shellCommands(src: string): string[] {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo\b/.test(l) && l.trim() !== '');
}

// ─────────────────────────────────────────────────────────────────────────────
describe('#3339 fix 1 — the catalog audience is a DEDICATED app registration', () => {
  it('derives unityAudienceClientId from a loomBackends pin, falling back to the sign-in app', () => {
    const src = read(ADMIN_PLANE);
    // The pin rides the EXISTING bag (admin-plane is at the ARM 256-param
    // ceiling), exactly like the N7e trinoAudienceClientId shape it mirrors.
    expect(src).toMatch(
      /var unityAudienceOverride = string\(loomBackends\.\?unityAudienceClientId \?\? ''\)/,
    );
    // UNPINNED must be byte-for-byte today's behaviour, or this change makes an
    // existing estate worse the moment it lands.
    expect(src).toMatch(
      /var unityAudienceClientId = !empty\(unityAudienceOverride\) \? unityAudienceOverride : effectiveMsalClientId/,
    );
  });

  it('hands BOTH catalog module calls the dedicated audience — neither takes the sign-in app', () => {
    const src = read(ADMIN_PLANE);
    const iceberg = moduleBody(src, "module icebergCatalog '../data-plane/iceberg-catalog-aca.bicep'");
    const unity = moduleBody(src, "module loomUnity '../compute/loom-unity-app.bicep'");

    // The regression this locks is the defect verbatim: `entraClientId:
    // effectiveMsalClientId` on either call re-collapses the trust boundary.
    expect(iceberg).toMatch(/entraClientId: unityAudienceClientId/);
    expect(iceberg).not.toMatch(/entraClientId: effectiveMsalClientId/);
    expect(unity).toMatch(/entraClientId: unityAudienceClientId/);
    expect(unity).not.toMatch(/entraClientId: effectiveMsalClientId/);
  });

  it('keeps the CONSOLE side in lockstep — it mints against the same id the catalog accepts', () => {
    const src = read(ADMIN_PLANE);
    // Audience-the-client-asks-for and audience-the-server-accepts must be the
    // same string BY CONSTRUCTION. Two independent expressions agreeing today
    // is a coincidence, not an invariant.
    expect(src).toMatch(
      /\{ name: 'LOOM_UNITY_CLIENT_ID', value: loomUnityActive \? unityAudienceClientId : '' \}/,
    );
    expect(src).toMatch(
      /\{ name: 'LOOM_UNITY_AUDIENCE', value: loomUnityActive && !empty\(unityAudienceClientId\) \? 'api:\/\/\$\{unityAudienceClientId\}\/\.default' : '' \}/,
    );
    expect(src).toMatch(
      /var icebergConsoleAudience = icebergCatalogActive && !empty\(unityAudienceClientId\) \? 'api:\/\/\$\{unityAudienceClientId\}\/\.default' : ''/,
    );
    expect(src).toMatch(
      /\{ name: 'LOOM_ICEBERG_CATALOG_AUDIENCE', value: icebergConsoleAudience \}/,
    );
  });

  it('the COMPILED ARM emits LOOM_ICEBERG_CATALOG_AUDIENCE onto the CONSOLE, derived from the pin', () => {
    // This is the var that was set by NOTHING, on any estate, ever — which is
    // why resolveIcebergAuth always fell back to api://<sign-in app>/.default.
    expect(consoleEnvExpression()).toContain(
      "createObject('name', 'LOOM_ICEBERG_CATALOG_AUDIENCE', 'value', "
      + "if(and(variables('icebergCatalogActive'), not(empty(if(not(empty("
      + "variables('unityAudienceOverride'))), variables('unityAudienceOverride'),",
    );
  });

  it('the COMPILED ARM reads the pin out of the loomBackends bag (zero new ARM params)', () => {
    const arm = read(ARM_ARTIFACT);
    expect(arm).toContain(
      `"unityAudienceOverride": "[string(coalesce(tryGet(parameters('loomBackends'), 'unityAudienceClientId'), ''))]"`,
    );
    // The 256-param ceiling is a deploy blocker, not a style nit.
    expect(Object.keys(JSON.parse(arm).parameters ?? {}).length).toBeLessThanOrEqual(256);
    expect(read(ROOT_BICEP)).not.toMatch(/^param unityAudienceClientId/m);
    expect(read(ADMIN_PLANE)).not.toMatch(/^param unityAudienceClientId/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#3339 fix 1 — the bootstrap creates a NEW app and NEVER writes the sign-in object', () => {
  it('is invoked by the MSAL bootstrap, default-ON with an explicit opt-out', () => {
    const src = read(MSAL_BOOTSTRAP);
    expect(src).toMatch(/CATALOG_SCRIPT="\$\(dirname "\$0"\)\/bootstrap-catalog-app-reg\.sh"/);
    expect(src).toMatch(/bash "\$\{CATALOG_SCRIPT\}"/);
    // loom_default_on_opt_out: absence of the knob must mean ENABLED.
    expect(src).toMatch(/CATALOG_APP_REG="\$\{LOOM_CATALOG_APP_REG:-1\}"/);
  });

  it('classifies a catalog-bootstrap failure instead of inheriting the caller’s sign-in error', () => {
    const src = read(MSAL_BOOTSTRAP);
    const at = src.indexOf('#3339 fix 1 — the DEDICATED catalog app registration.');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('# OPT-IN: grant admin consent', at));

    // csa-loom-post-deploy-bootstrap.yml answers ANY non-zero exit from this
    // script with a fixed "every sign-in returns AADSTS7000215" error. That
    // sentence is FALSE for a catalog-registration failure, and an error
    // asserting a cause the code did not establish is deploy-integrity R7.
    expect(block).not.toMatch(/^\s*exit\s+1\s*$/m);
    // The outcome is not discarded either — it is machine-readable on stdout.
    expect(block).toContain('LOOM_CATALOG_APP_REG=failed');
    expect(block).toContain('LOOM_CATALOG_APP_REG=skipped');
  });

  it('every Graph WRITE in the catalog bootstrap targets the catalog app, never the sign-in app', () => {
    const src = read(CATALOG_BOOTSTRAP);
    const writes = shellCommands(src).filter((l) =>
      /az\s+ad\s+app\s+(update|create)\b/.test(l) || /az\s+ad\s+sp\s+create\b/.test(l),
    );
    // A guard matching nothing measures nothing.
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).not.toContain('SIGN_IN_APP_ID');
      // `${APP_ID}` is the MSAL script's OWN variable — the sign-in app. This
      // script must never name it, only `${CATALOG_APP_ID}`.
      expect(w).not.toMatch(/\$\{APP_ID\}/);
      if (/--id\b/.test(w)) expect(w).toContain('${CATALOG_APP_ID}');
    }
    // And it never resets a credential on any object — the sign-in app's
    // credential lifecycle (#3335, the 2026-07-19 outage) is not this script's.
    expect(src).not.toMatch(/az\s+ad\s+app\s+credential\s+reset/);
  });

  it('ABORTS without writing anything if the resolved app IS the sign-in app', () => {
    const src = read(CATALOG_BOOTSTRAP);
    const guardAt = src.indexOf('if [ -n "${SIGN_IN_APP_ID}" ] && [ "$(trim "${SIGN_IN_APP_ID}")" = "${CATALOG_APP_ID}" ]; then');
    expect(guardAt).toBeGreaterThan(-1);
    // Structural, not textual: the refusal must precede EVERY write, or it is
    // a message printed after the damage.
    const firstWrite = src.search(/az\s+ad\s+app\s+update\b/);
    expect(firstWrite).toBeGreaterThan(guardAt);
    expect(src.slice(guardAt, guardAt + 1400)).toMatch(/exit 1/);
  });

  it('refuses to RECORD the client id unless the Console identity can actually use it', () => {
    const src = read(CATALOG_BOOTSTRAP);
    // Recording an id nothing is authorized to call records a trap: pinning it
    // takes the catalog from wrongly-reachable to unreachable, because Entra
    // issues a `.default` token only to a client holding an app-role
    // assignment on the resource.
    expect(src).toMatch(/if \[ "\$\{CATALOG_PINNABLE\}" -ne 1 \]; then/);
    const gateAt = src.indexOf('if [ "${CATALOG_PINNABLE}" -ne 1 ]; then');
    const kvWriteAt = src.indexOf('az rest --method PUT');
    expect(gateAt).toBeGreaterThan(-1);
    expect(kvWriteAt).toBeGreaterThan(gateAt);
    expect(src).toContain('LOOM_CATALOG_PINNABLE=0');
    expect(src).toContain('LOOM_CATALOG_PINNABLE=1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('#3339 fix 2 / #3110 §1 — the catalog metadata store is DURABLE', () => {
  it('threads the Postgres jdbcUrl, its role name and its client id into iceberg-catalog', () => {
    const body = moduleBody(
      read(ADMIN_PLANE),
      "module icebergCatalog '../data-plane/iceberg-catalog-aca.bicep'",
    );
    expect(body).toMatch(
      /catalogDbUrl: loomUnityPostgresActive \? loomUnityPostgres!\.outputs\.jdbcUrl : ''/,
    );
    // THREE values, not one. The entrypoint `die`s on a URL with no user
    // ("LOOM_UNITY_DB_URL is set but LOOM_UNITY_DB_USER is empty"), so passing
    // the URL alone would replace an amnesiac catalog with a crash-looping one.
    expect(body).toMatch(
      /catalogDbUser: loomUnityPostgresActive \? identity\.outputs\.uamiConsoleName : ''/,
    );
    expect(body).toMatch(
      /catalogDbClientId: loomUnityPostgresActive \? identity\.outputs\.uamiConsoleClientId : ''/,
    );
  });

  it('gives that identity an actual role on the server — Entra maps a token by principal NAME', () => {
    const body = moduleBody(
      read(ADMIN_PLANE),
      "module loomUnityPostgres '../data-plane/loom-unity-postgres.bicep'",
    );
    // iceberg-catalog runs as the CONSOLE UAMI (uamiId: identity.outputs.
    // uamiConsoleId), not uami-loom-unity, so the Console identity needs its own
    // administrator entry or the catalog authenticates as nobody.
    expect(body).toMatch(/additionalAdministrators: icebergCatalogActive \? \[/);
    expect(body).toMatch(/principalId: identity\.outputs\.uamiConsolePrincipalId/);
    // The role NAME and the username the app connects with must be the same
    // string, read from the same output — they cannot be allowed to drift.
    expect(body).toMatch(/principalName: identity\.outputs\.uamiConsoleName/);
    expect(body).toMatch(/principalType: 'ServicePrincipal'/);
  });

  it('the module treats url+user as ONE decision and keeps the working store when half-supplied', () => {
    const src = read(CATALOG_MODULE);
    expect(src).toMatch(/var catalogDbWired = !empty\(catalogDbUrl\) && !empty\(catalogDbUser\)/);
    expect(src).toMatch(/var catalogDbHalfWired = !empty\(catalogDbUrl\) && empty\(catalogDbUser\)/);
    // The env branch must be keyed to the PAIR, not to the URL alone — a URL
    // emitted without a user boots a container that exits and restarts forever.
    expect(src).toMatch(/catalogDbWired \? \[/);
    expect(src).not.toMatch(/empty\(catalogDbUrl\) \? \[\s*\n\s*\/\//);
    expect(src).toMatch(/\{ name: 'LOOM_UNITY_DB_USER', value: catalogDbUser \}/);
    expect(src).toMatch(/\{ name: 'LOOM_UNITY_DB_AUTH', value: catalogDbAuth \}/);
  });

  it('emits AZURE_CLIENT_ID only on the Postgres path, and reports durability honestly', () => {
    const src = read(CATALOG_MODULE);
    expect(src).toMatch(
      /\(catalogDbWired && !empty\(catalogDbClientId\)\) \? \[\s*\n\s*\{ name: 'AZURE_CLIENT_ID', value: catalogDbClientId \}/,
    );
    // metadataDurable must follow the PAIR. `!empty(catalogDbUrl)` would report
    // durable for the half-wired config that in fact crash-loops.
    expect(src).toMatch(/output metadataDurable bool = catalogDbWired/);
    expect(src).not.toMatch(/output metadataDurable bool = !empty\(catalogDbUrl\)/);
    // "Postgres asked for and refused" must be distinguishable from "no
    // Postgres" in a deploy receipt.
    expect(src).toMatch(/output metadataDurabilityBlocked bool = catalogDbHalfWired/);
  });

  it('the COMPILED ARM really wires the store — source intent is not deployment reality', () => {
    const arm = read(ARM_ARTIFACT);
    expect(arm).toContain(
      `"catalogDbUrl": "[if(variables('loomUnityPostgresActive'), `
      + `reference('loomUnityPostgres').outputs.jdbcUrl.value, '')]"`,
    );
    expect(arm).toContain(
      `"catalogDbUser": "[if(variables('loomUnityPostgresActive'), `
      + `reference('identity').outputs.uamiConsoleName.value, '')]"`,
    );
    expect(arm).toContain(
      `"catalogDbClientId": "[if(variables('loomUnityPostgresActive'), `
      + `reference('identity').outputs.uamiConsoleClientId.value, '')]"`,
    );
    expect(arm).toContain(
      `"additionalAdministrators": "[if(variables('icebergCatalogActive'), `
      + `createObject('value', createArray(createObject('principalId', `
      + `reference('identity').outputs.uamiConsolePrincipalId.value, 'principalName', `
      + `reference('identity').outputs.uamiConsoleName.value, 'principalType', 'ServicePrincipal'))), `,
    );
  });
});
