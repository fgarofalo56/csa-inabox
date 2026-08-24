/**
 * LOOM BRAIN — assemble the LIVE graph from a Resource Graph pull.
 *
 * ONE PULL, ONE GRAPH, ONE INSTANT. The Resource Graph rows carry both the
 * resource facts (scale, ingress, tags, provisioning state) and the live
 * container env, so `extractFromResourceGraph` and `extractFromContainerAppEnv`
 * are fed from the SAME read. Two pulls could observe an app mid-revision and
 * produce a graph whose scale and env disagree — a contradiction with no
 * signal.
 *
 * ── THE PROVENANCE THIS RUNTIME CANNOT COLLECT, AND WHY THAT MATTERS MORE
 *    THAN THE ONES IT CAN ────────────────────────────────────────────────────
 * The deployed console image is built from `apps/fiab-console` alone. It does
 * not contain `platform/fiab/bicep`, it does not contain the repo's TypeScript
 * sources, and it has no telemetry extractor. So at runtime:
 *
 *     configured   COLLECTED   live container env, from this ARG pull
 *     owns         COLLECTED   the `loom-estate-id` tag, from this ARG pull
 *     declared     NOT COLLECTED   bicep is not in the image
 *     imports      NOT COLLECTED   sources are not in the image
 *     observed     NOT COLLECTED   no telemetry extractor exists yet
 *
 * A NOT-COLLECTED provenance is the single most dangerous state in this system,
 * and it is dangerous in a way `Population.blind` does not catch.
 * `nodesWithNoInboundEdge(g, 'declared')` over a graph with zero `declared`
 * edges returns EVERY NODE — the node set was not empty, so `blind` is false,
 * and the result is a screen full of confident findings every one of which is
 * vacuously true. That is not a subtle risk; it is the default outcome of
 * writing the obvious query.
 *
 * So coverage is computed here, carried on the snapshot, rendered by the UI, and
 * consulted by every detector before it emits anything. `detect.ts` refuses to
 * produce findings for an uncollected provenance and says so.
 *
 * ── NOTHING HERE MUTATES ANYTHING ──────────────────────────────────────────
 * Pure function of the rows in. The only I/O in this module's dependency tree is
 * the read-only ARG query in `arg-collect.ts`.
 */

import {
  buildGraph,
  extractFromContainerAppEnv,
  extractFromResourceGraph,
  LOOM_ESTATE_TAG_KEY,
  azureResourceNodeId,
  type BrainGraph,
  type ContainerAppEnvEntry,
  type ContainerAppEnvInput,
  type EdgeProvenance,
  type NodeId,
  type ResourceGraphRow,
} from '@/lib/brain/graph';
import { BOUND_ENV_VAR_NAMES, WIRE_BINDINGS } from './wire-bindings';
import type { OwnershipCoverage, ProvenanceCoverage } from './wire';

const CONTAINER_APP_TYPE = 'microsoft.app/containerapps';
const CONTAINER_APP_JOB_TYPE = 'microsoft.app/jobs';
const MANAGED_ENV_TYPE = 'microsoft.app/managedenvironments';

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Read every container's env list off an ARG `properties` blob.
 *
 * Container Apps allows MULTIPLE containers per app. All of them are read and
 * concatenated: a wire declared on a sidecar is still a wire, and reading only
 * `containers[0]` would silently miss it. (Note that the substrate's scale
 * reader deliberately does read only the first container, for cost — and says
 * so. Different question, different answer.)
 */
export function readEnvEntries(properties: unknown): ContainerAppEnvEntry[] {
  const template = obj(obj(properties)?.template);
  const containers = Array.isArray(template?.containers) ? template.containers : [];
  const out: ContainerAppEnvEntry[] = [];
  for (const c of containers) {
    const env = obj(c)?.env;
    if (!Array.isArray(env)) continue;
    for (const e of env) {
      const entry = obj(e);
      const name = entry?.name;
      if (typeof name !== 'string' || name === '') continue;
      const value = entry?.value;
      const secretRef = entry?.secretRef;
      out.push({
        name,
        // `''` is preserved deliberately: an empty wire is a REAL state, and
        // coercing it to undefined would turn the founding finding's evidence
        // into "entry carries no value field".
        ...(typeof value === 'string' ? { value } : {}),
        ...(typeof secretRef === 'string' ? { secretRef } : {}),
      });
    }
  }
  return out;
}

function typeOf(row: ResourceGraphRow): string {
  return (row.type ?? row.resourceType ?? '').toLowerCase();
}

function armIdOf(row: ResourceGraphRow): string {
  return row.id ?? row.resourceId ?? '';
}

/** What the live-env pass read, so its recall cost is visible rather than implied. */
export interface EnvReadStats {
  readonly appsWithEnv: number;
  readonly entriesRead: number;
  readonly entriesEmpty: number;
  readonly entriesSecretRef: number;
  /** Entries the `onlyNames` filter admitted — i.e. rows in the binding table. */
  readonly entriesConsidered: number;
}

export interface LiveGraphResult {
  readonly graph: BrainGraph;
  readonly coverage: Readonly<Record<EdgeProvenance, ProvenanceCoverage>>;
  readonly ownership: OwnershipCoverage;
  readonly env: EnvReadStats;
  readonly containerApps: number;
  readonly containerAppJobs: number;
  readonly managedEnvironments: number;
  /**
   * Binding rows whose target app was NOT found in the pull. Reported, never
   * dropped: a binding pointing at a non-existent app is either a stale table
   * row or a service that was never deployed, and both are worth knowing.
   */
  readonly unresolvedBindings: readonly string[];
}

/**
 * Build the graph from an ARG pull.
 *
 * `estateId` scopes ownership. Pass it when the result will drive a cleanup
 * recommendation: without it, ANY non-empty `loom-estate-id` counts as owned,
 * which cannot tell two Loom estates apart.
 */
export function buildLiveGraph(
  rows: readonly ResourceGraphRow[],
  opts?: { readonly estateId?: string },
): LiveGraphResult {
  // ── ownership-tagged nodes + `owns` edges ────────────────────────────────
  const resourceExtraction = extractFromResourceGraph(rows, {
    ...(opts?.estateId ? { estateId: opts.estateId } : {}),
  });

  // ── resolve the binding table against what was actually discovered ───────
  // The table names container apps; a NodeId is an ARM id. The join happens
  // here, on measured data, so a binding row that names a service which is not
  // deployed resolves to NOTHING rather than to a fabricated node.
  const appIdByName = new Map<string, string>();
  for (const row of rows) {
    if (typeOf(row) !== CONTAINER_APP_TYPE) continue;
    const armId = armIdOf(row);
    const name = row.name ?? armId.split('/').filter(Boolean).pop() ?? '';
    if (armId && name) appIdByName.set(name.toLowerCase(), armId);
  }

  const bindings: Record<string, NodeId> = {};
  const unresolvedBindings: string[] = [];
  for (const b of WIRE_BINDINGS) {
    const armId = appIdByName.get(b.targetAppName.toLowerCase());
    if (armId) bindings[b.envVar] = azureResourceNodeId(armId);
    else
      unresolvedBindings.push(
        `${b.envVar} -> '${b.targetAppName}': no Container App with that name was found in ` +
          'this pull. The wire cannot be attributed to a node; the binding row is either ' +
          'stale or the service is not deployed here.',
      );
  }

  // ── live `configured` wires ──────────────────────────────────────────────
  const envInputs: ContainerAppEnvInput[] = [];
  let entriesRead = 0;
  let entriesEmpty = 0;
  let entriesSecretRef = 0;
  let entriesConsidered = 0;
  const boundNames = new Set(BOUND_ENV_VAR_NAMES);

  for (const row of rows) {
    if (typeOf(row) !== CONTAINER_APP_TYPE) continue;
    const armId = armIdOf(row);
    if (!armId) continue;
    const env = readEnvEntries(row.properties);
    if (env.length === 0) continue;

    entriesRead += env.length;
    for (const e of env) {
      if (e.secretRef !== undefined) entriesSecretRef += 1;
      else if (typeof e.value === 'string' && e.value.trim() === '') entriesEmpty += 1;
      if (boundNames.has(e.name)) entriesConsidered += 1;
    }

    envInputs.push({
      appResourceId: armId,
      env,
      envVarBindings: bindings,
      // Without this filter every `LOOM_ENABLE_X=false` becomes an
      // `unresolved-target` dangling edge and buries the wires that matter.
      // Its effect on recall is reported in `EnvReadStats`, not hidden.
      onlyNames: BOUND_ENV_VAR_NAMES,
    });
  }

  const envExtraction = extractFromContainerAppEnv(envInputs);
  const graph = buildGraph([resourceExtraction, envExtraction]);

  // ── coverage ─────────────────────────────────────────────────────────────
  const byProv = graph.report.edgesByProvenance;
  const coverage: Record<EdgeProvenance, ProvenanceCoverage> = {
    configured: {
      collected: true,
      edgeCount: byProv.configured,
      note:
        `live container env read from the same Azure Resource Graph pull, filtered to the ` +
        `${BOUND_ENV_VAR_NAMES.length} env var(s) in the wire-binding table.`,
    },
    owns: {
      // The extractor RAN, so the provenance is collected. Whether it FOUND
      // anything is a separate fact, reported in `ownership` — conflating "the
      // check ran" with "the check passed" is the failure this split prevents.
      collected: true,
      edgeCount: byProv.owns,
      note:
        `ownership read from the '${LOOM_ESTATE_TAG_KEY}' tag on every resource in the pull` +
        (byProv.owns === 0
          ? '. ZERO resources carry it — see the ownership report; every ownership-scoped ' +
            'verdict is therefore blind, and no cleanup proposal is offered.'
          : '.'),
    },
    declared: {
      collected: false,
      edgeCount: byProv.declared,
      note:
        'NOT COLLECTED at runtime: the console image is built from apps/fiab-console and does ' +
        'not contain platform/fiab/bicep. Any "declared but not configured" query would be ' +
        'vacuously true of every node, so detectors depending on it emit nothing.',
    },
    imports: {
      collected: false,
      edgeCount: byProv.imports,
      note:
        'NOT COLLECTED at runtime: the repository sources are not present in the deployed ' +
        'image. The extractor exists and is unit-tested; it has no runtime input here.',
    },
    observed: {
      collected: false,
      edgeCount: byProv.observed,
      note:
        'NOT COLLECTED: no telemetry extractor exists yet (PRP §3.1). Without it, "reachable ' +
        'and UNUSED" cannot be distinguished from "reachable and busy", so that finding class ' +
        'is not produced rather than guessed.',
    },
  };

  // ── ownership ────────────────────────────────────────────────────────────
  const azureNodes = graph.nodes.filter((n) => n.kind === 'azure-resource');
  const owned = new Set<string>();
  for (const e of graph.edges) {
    if (e.provenance === 'owns' && e.resolution === 'resolved') owned.add(e.to);
  }
  const indeterminate = azureNodes.filter(
    (n) => n.kind === 'azure-resource' && n.tags === null,
  ).length;

  const ownership: OwnershipCoverage = {
    confirmed: owned.size,
    examined: azureNodes.length,
    indeterminate,
    blind: owned.size === 0,
    note:
      owned.size === 0
        ? `ZERO of ${azureNodes.length} resource(s) carry the '${LOOM_ESTATE_TAG_KEY}' tag. ` +
          'Ownership is therefore UNESTABLISHED for the whole estate, and every cleanup ' +
          'proposal is withheld. Do NOT widen the ownership key to match the tags that ARE ' +
          "present (CSA_Loom, csa-loom, loom-band, loom-item) — none is estate-scoped, so " +
          'none can tell two Loom estates apart, and a wrong ownership inference on this ' +
          'estate reaches non-Loom Container App environments. The fix is the deploy ' +
          'stamping the tag.'
        : `${owned.size} of ${azureNodes.length} resource(s) carry '${LOOM_ESTATE_TAG_KEY}'` +
          (indeterminate > 0
            ? `; ${indeterminate} had UNREADABLE tags (indeterminate, not unowned).`
            : '.'),
  };

  const count = (t: string) => rows.filter((r) => typeOf(r) === t).length;

  return {
    graph,
    coverage,
    ownership,
    env: {
      appsWithEnv: envInputs.length,
      entriesRead,
      entriesEmpty,
      entriesSecretRef,
      entriesConsidered,
    },
    containerApps: count(CONTAINER_APP_TYPE),
    containerAppJobs: count(CONTAINER_APP_JOB_TYPE),
    managedEnvironments: count(MANAGED_ENV_TYPE),
    unresolvedBindings,
  };
}
