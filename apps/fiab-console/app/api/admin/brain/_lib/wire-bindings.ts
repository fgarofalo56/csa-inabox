/**
 * LOOM BRAIN — the WIRE BINDING TABLE.
 *
 * WHAT PROBLEM THIS SOLVES, in one sentence: an empty value destroys the
 * evidence of its own intent, so the intent has to be written down somewhere
 * else or it is lost.
 *
 * ── THE MECHANIC ───────────────────────────────────────────────────────────
 * A wired env var names its own target:
 *
 *     { name: 'LOOM_DIRECTLAKE_URL', value: 'https://${loomDirectLake!.outputs.fqdn}' }
 *
 * — read the value, resolve the FQDN, and you have the edge. An EMPTY one does
 * not:
 *
 *     { name: 'LOOM_BROKER_URL', value: '' }
 *       platform/fiab/bicep/modules/admin-plane/main.bicep:4730
 *
 * `''` names nothing. There is no string to resolve, so no amount of parsing
 * recovers the fact that this wire was meant to reach `loom-capacity-broker`.
 * Without that fact the dangling edge still EXISTS (which is what keeps the
 * broker out of the reachable set) but it is orphaned: it cannot be attached to
 * the abandoned service, so the finding loses its evidence chain and reads as
 * "some empty variable on the console" rather than "the billing service is
 * unreachable and HERE is the line that abandoned it".
 *
 * ── WHY A TABLE AND NOT A HEURISTIC ────────────────────────────────────────
 * The tempting shortcut is to infer the target from the variable's NAME —
 * strip `LOOM_`, strip `_URL`, kebab-case it, prefix `loom-`. On this exact
 * input that heuristic produces `loom-broker`, and there IS no app called
 * `loom-broker`; the app is `loom-capacity-broker`
 * (`platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep:54`,
 * `param name string = 'loom-capacity-broker'`). So the heuristic would emit an
 * `unresolved-target` dangling edge pointing at a service that does not exist,
 * and the real one would keep looking merely idle.
 *
 * It gets worse in the direction that matters. A heuristic that guesses WRONG
 * but plausibly — say `LOOM_ONELAKE_URL` → `loom-onelake` when the deployed app
 * is named something else — manufactures an inbound edge for the wrong node and
 * makes an unreachable service look reachable. That is the exact failure the
 * substrate's `resolveTarget` case-sensitivity bug produced in reverse, and it
 * is undetectable from the output.
 *
 * So the mapping is DATA, reviewable in a diff, each row carrying the line that
 * justifies it. `container-app-env.ts` and `bicep.ts` both take
 * `envVarBindings` as caller-supplied input for precisely this reason.
 *
 * ── SCOPE, STATED HONESTLY ─────────────────────────────────────────────────
 * This table covers the env vars that name a LOOM CONTAINER APP. It does not
 * cover wires to Synapse, ADLS, Cosmos, Event Hubs, Key Vault or ADX — those
 * carry non-empty values that resolve on their own, so they need no binding
 * row. An env var absent from this table is NOT asserted to be unbound; it is
 * simply not one this table speaks to, and `unboundEmptyWires()` reports those
 * separately rather than letting them vanish.
 */

/**
 * One binding: an env var name → the container app it is MEANT to reach.
 *
 * `evidence` is not decoration. It is the reason a reviewer can check the row
 * without re-deriving it, and it is what a finding cites.
 */
export interface WireBinding {
  /** The env var, exactly as bicep and the running app spell it. */
  readonly envVar: string;
  /** The Container App resource NAME. Resolved to a NodeId at graph-build time. */
  readonly targetAppName: string;
  /** Where this mapping is established. A row without one must not be added. */
  readonly evidence: string;
}

/**
 * THE TABLE.
 *
 * Every row is grounded in a bicep `param name string = '…'` default or a
 * literal `name:` on the Container App resource, plus the consumer that reads
 * the variable. Adding a row on a hunch is the one thing this file exists to
 * prevent.
 */
export const WIRE_BINDINGS: readonly WireBinding[] = [
  // ── THE FOUNDING CASE ───────────────────────────────────────────────────
  {
    envVar: 'LOOM_BROKER_URL',
    targetAppName: 'loom-capacity-broker',
    evidence:
      "compute/loom-capacity-broker-app.bicep:54 `param name string = 'loom-capacity-broker'`; " +
      'consumed by lib/azure/capacity-broker-client.ts as ' +
      '`LOOM_CAPACITY_BROKER_URL || LOOM_BROKER_URL`. admin-plane/main.bicep:4730 ' +
      "emits `{ name: 'LOOM_BROKER_URL', value: '' }` — the ONLY name any bicep " +
      'emits for this service.',
  },
  {
    envVar: 'LOOM_CAPACITY_BROKER_URL',
    targetAppName: 'loom-capacity-broker',
    evidence:
      'the first half of the same `LOOM_CAPACITY_BROKER_URL || LOOM_BROKER_URL` read in ' +
      'lib/azure/capacity-broker-client.ts. Listed so the edge is found whichever ' +
      'of the two names a deployment happens to set.',
  },

  // ── THE WIRED CONTROL ───────────────────────────────────────────────────
  // Kept deliberately. A table containing ONLY broken wires cannot show that the
  // detector discriminates: "every app is unreachable" would pass identically.
  // This row's target is wired to a real fqdn in the same bicep block
  // (admin-plane/main.bicep, `'https://${loomDirectLake!.outputs.fqdn}'`), so it
  // must come out RESOLVED and must NOT appear in any unreachable result.
  {
    envVar: 'LOOM_DIRECTLAKE_URL',
    targetAppName: 'loom-directlake',
    evidence:
      "compute/loom-directlake-app.bicep:74 `param name string = 'loom-directlake'`; " +
      "admin-plane/main.bicep wires it to `'https://${loomDirectLake!.outputs.fqdn}'` " +
      'when directLakeSvcActive. THE CONTROL — this one is genuinely wired.',
  },

  // ── the rest of the Loom container-app fleet ────────────────────────────
  {
    envVar: 'LOOM_DUCKDB_URL',
    targetAppName: 'loom-duckdb',
    evidence: "data-plane/duckdb-aca.bicep:64 `param name string = 'loom-duckdb'`",
  },
  {
    envVar: 'LOOM_TRINO_URL',
    targetAppName: 'loom-trino',
    evidence: "data-plane/loom-trino-aca.bicep:66 `param name string = 'loom-trino'`",
  },
  {
    envVar: 'LOOM_ICEBERG_CATALOG_URL',
    targetAppName: 'iceberg-catalog',
    evidence:
      "data-plane/iceberg-catalog-aca.bicep:67 `param name string = 'iceberg-catalog'` " +
      '— note the app name has NO `loom-` prefix, which is exactly the kind of ' +
      'thing a name-shaped heuristic gets wrong.',
  },
  {
    envVar: 'LOOM_S3_GATEWAY_URL',
    targetAppName: 'loom-s3-gateway',
    evidence: "data-plane/s3-gateway-aca.bicep:121 `param name string = 'loom-s3-gateway'`",
  },
  {
    envVar: 'LOOM_MIGRATE_URL',
    targetAppName: 'loom-migrate',
    evidence: "data-plane/loom-migrate-aca.bicep:59 `param name string = 'loom-migrate'`",
  },
  {
    envVar: 'LOOM_ONELAKE_URL',
    targetAppName: 'loom-onelake',
    evidence:
      "compute/loom-onelake-app.bicep `resource app 'Microsoft.App/containerApps'` " +
      "named by its `name` param. admin-plane/main.bicep emits `value: ''` for this " +
      'variable too — a SECOND instance of the founding shape, which is the ' +
      'argument for a graph query over a hand-written rule.',
  },
  {
    envVar: 'LOOM_UNITY_URL',
    targetAppName: 'loom-unity',
    evidence: "compute/loom-unity-app.bicep:85 `param name string = 'loom-unity'`",
  },
  {
    envVar: 'LOOM_SHARING_URL',
    targetAppName: 'loom-sharing',
    evidence: "compute/loom-sharing-app.bicep:53 `param name string = 'loom-sharing'`",
  },
  {
    envVar: 'LOOM_DBT_RUNNER_URL',
    targetAppName: 'loom-dbt-runner',
    evidence: "integration/dbt-runner.bicep:45 `name: 'loom-dbt-runner'`",
  },
  {
    envVar: 'LOOM_MAPS_TILE_URL',
    targetAppName: 'loom-maps-tiles',
    evidence: "compute/loom-maps-app.bicep:50 `name: 'loom-maps-tiles'`",
  },
  {
    envVar: 'LOOM_PAGINATED_RENDER_URL',
    targetAppName: 'loom-prpt-renderer',
    evidence: "integration/prpt-renderer.bicep:20 `param name string = 'loom-prpt-renderer'`",
  },
  {
    envVar: 'LOOM_DAB_PREVIEW_URL',
    targetAppName: 'loom-dab-preview',
    evidence: "admin-plane/dab-runtime.bicep:82 `name: 'loom-dab-preview'`",
  },
  {
    envVar: 'LOOM_AIRFLOW_ENDPOINT',
    targetAppName: 'loom-airflow',
    evidence: "admin-plane/airflow.bicep:273 `name: 'loom-airflow'`",
  },
  {
    envVar: 'LOOM_MAF_ENDPOINT',
    targetAppName: 'loom-copilot-maf',
    evidence: "copilot/maf.bicep:59 `name: 'loom-copilot-maf'`",
  },
  {
    envVar: 'LOOM_SCRIPT_RUNNER_URL',
    targetAppName: 'loom-script-runner',
    evidence:
      "admin-plane/script-runner-app.bicep, invoked as `module scriptRunner` and wired " +
      "to `'https://${scriptRunner!.outputs.fqdn}'` when scriptRunnerActive.",
  },
  {
    envVar: 'LOOM_WRANGLER_ENDPOINT',
    targetAppName: 'loom-wrangler-host',
    evidence: "integration/wrangler.bicep:28 `param name string = 'loom-wrangler-host'`",
  },
  {
    envVar: 'LOOM_TRANSFORM_RUNNER_URL',
    targetAppName: 'loom-transform-runner',
    evidence: "integration/transform-runner-aca.bicep:78 `name: 'loom-transform-runner'`",
  },
] as const;

/**
 * Env var names this table speaks to. Passed as `onlyNames` so the extractor
 * considers these entries and skips the rest.
 *
 * WHY THE FILTER IS NOT OPTIONAL HERE: a Loom container app carries well over a
 * hundred env vars, most of them feature flags and tuning knobs. Without the
 * filter every `LOOM_ENABLE_X=false` becomes an `unresolved-target` dangling
 * edge and the handful that matter are buried in the noise — a real finding
 * rendered invisible by true-but-irrelevant ones. The filter's effect is
 * reported in the population, so its cost to recall is visible rather than
 * hidden (see `liveGraph()`'s `wiresConsidered`).
 */
export const BOUND_ENV_VAR_NAMES: readonly string[] = WIRE_BINDINGS.map((b) => b.envVar);

/** Lowercased app name → the env vars that are meant to reach it. */
export function bindingsByTargetApp(): Map<string, WireBinding[]> {
  const m = new Map<string, WireBinding[]>();
  for (const b of WIRE_BINDINGS) {
    const key = b.targetAppName.toLowerCase();
    const list = m.get(key);
    if (list) list.push(b);
    else m.set(key, [b]);
  }
  return m;
}
