/**
 * LOOM BRAIN W9 — shared fixtures for the graph-history suites.
 *
 * ── NO GUID-SHAPED LITERAL APPEARS ANYWHERE IN THIS DIRECTORY ──────────────
 * This is a PUBLIC repository and #3935 states the constraint directly: no real
 * tenant, subscription, object or resource id may be persisted, because anything
 * persisted may end up in a fixture. The rule enforced here is stronger and
 * therefore checkable: `no-real-ids.test.ts` fails on ANY 8-4-4-4-12 hex string
 * under `lib/brain/history`, with no allowlist. So the placeholders below are
 * words, not GUIDs — `sub-alpha`, not `11111111-…`. A synthetic GUID would be
 * harmless and would also make the guard unenforceable, and an unenforceable
 * guard is the failure mode this repo has the most scar tissue about.
 *
 * ── EVERY ESTATE CARRIES A CONTROL ─────────────────────────────────────────
 * A diff that reported EVERYTHING would satisfy any test that only asserts "the
 * changed thing is in the result". So each estate contains, alongside whatever a
 * given test changes:
 *
 *   `loom-direct-lake`  wired and left alone in every mutation. It must NEVER
 *                       appear in an added/removed/changed list. This is the
 *                       control that makes "exactly one edge added, exactly one
 *                       removed" a real assertion rather than a coincidence.
 *   `loom-scratch`      unreachable from the very first version. It is what the
 *                       consecutive-version predicate is allowed to fire on.
 *   `loom-fresh`        appears LATE and is unreachable only in the newest
 *                       version — the NEGATIVE control that prevents
 *                       recommending deletion of a mid-deploy resource.
 */

import {
  azureResourceNodeId,
  buildGraph,
  deployArtifactNodeId,
  extractFromContainerAppEnv,
  extractFromResourceGraph,
  makePopulation,
  type BrainGraph,
  type BrainNode,
  type ContainerAppEnvEntry,
  type ExtractionResult,
  type NodeId,
  type PendingEdge,
  type ResourceGraphRow,
} from '../../graph';
import { buildVersionRecord } from '../capture';
import { computeContentDigest, computeCounts } from '../digest';
import type { EdgeProvenance } from '../../types';
import type { GraphVersion, GraphVersionContent } from '../model';

/** Deliberately NOT a GUID — see the header. */
export const SUB = 'sub-alpha';
export const RG = 'rg-loom-example';
export const ESTATE = 'estate-alpha';
export const ENV_DOMAIN = 'example-env.centralus.azurecontainerapps.io';

/**
 * #4020 R6 — THE ESTATE IDS PRODUCTION ACTUALLY EMITS.
 *
 * Every retention proof used to run on `ESTATE = 'estate-alpha'`, a value
 * `resolveEstateId()` can never return. That made an entire class of bypass
 * inert in the suite and live on the estate: a prune gated on
 * `estateId.startsWith('loom:')` disables the 50-version bound on EVERY real
 * deployment and in NO test, leaving only the 90-day TTL holding the container.
 * Same class as the cardinality-conditioned bypasses in #3963 — a filter whose
 * predicate is false for every fixture.
 *
 * `resolveEstateId()` (`lib/estate/pause-orchestrator.ts`) returns exactly two
 * shapes when `LOOM_ESTATE_ID` is unset:
 *
 *     `loom:${sub.slice(0, 8)}:${rg}`   both a subscription and an RG are known
 *     'loom:unbound'                    either is missing
 *
 * Both are reproduced here — as WORDS, never GUIDs, so `no-real-ids.test.ts`
 * stays enforceable (see the header). `sub-alph` is literally
 * `'sub-alpha'.slice(0, 8)`, i.e. the same truncation production performs, so
 * the shape is derived rather than typed out.
 */
export const PROD_ESTATE_BOUND = `loom:${SUB.slice(0, 8)}:${RG}`;
export const PROD_ESTATE_UNBOUND = 'loom:unbound';

/**
 * The estate ids every retention/capture proof is parameterised over: the
 * fixture-only one (kept, because the older specs read against it) plus both
 * production shapes. A bypass keyed to any one of them now fails at least one
 * arm.
 */
export const ESTATE_IDS: readonly string[] = [ESTATE, PROD_ESTATE_BOUND, PROD_ESTATE_UNBOUND];

export function armId(name: string): string {
  return `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${name}`;
}

export function nodeIdOf(name: string): NodeId {
  return azureResourceNodeId(armId(name));
}

export function fqdnOf(name: string, external = false): string {
  return external ? `${name}.${ENV_DOMAIN}` : `${name}.internal.${ENV_DOMAIN}`;
}

/** One container app, as Resource Graph projects it. */
export function appRow(args: {
  readonly name: string;
  readonly minReplicas?: number;
  readonly external?: boolean;
  readonly withFqdn?: boolean;
  readonly tags?: Readonly<Record<string, string>> | null;
  readonly provisioningState?: string;
  readonly location?: string;
}): ResourceGraphRow {
  const external = args.external ?? false;
  const withFqdn = args.withFqdn ?? true;
  return {
    id: armId(args.name),
    type: 'Microsoft.App/containerApps',
    name: args.name,
    resourceGroup: RG,
    subscriptionId: SUB,
    location: args.location ?? 'centralus',
    tags: args.tags === undefined ? { 'loom-estate-id': ESTATE } : args.tags,
    properties: {
      provisioningState: args.provisioningState ?? 'Succeeded',
      configuration: withFqdn
        ? { ingress: { external, fqdn: fqdnOf(args.name, external), targetPort: 8080 } }
        : {},
      template: {
        containers: [{ name: args.name, resources: { cpu: 0.5, memory: '1Gi' } }],
        scale: { minReplicas: args.minReplicas ?? 0, maxReplicas: 3 },
      },
    },
  };
}

/** A live `configured` wire: one env var on one app. */
export interface WireSpec {
  /** App the env var is set on. */
  readonly onApp: string;
  readonly envVar: string;
  /** The authored value. `''` is the founding empty-wire case. */
  readonly value: string;
  /** App the binding table says this env var is meant to reach. */
  readonly boundTo?: string;
}

/** A `declared` wire, as a bicep module would contribute it. */
export interface DeclaredWireSpec {
  readonly onApp: string;
  readonly toApp: string;
  readonly envVar: string;
  readonly artifact?: string;
  /**
   * The source line.
   *
   * Present so the RE-IDENTIFICATION case is reachable in a test: the live edge
   * id embeds the line, the stored projection does not, so moving a wire down a
   * file changes the digest while changing nothing the comparator can see. That
   * is the case `captureGraphVersion`'s second stage exists for.
   */
  readonly line?: number;
}

export interface EstateSpec {
  readonly apps: readonly {
    readonly name: string;
    readonly minReplicas?: number;
    readonly external?: boolean;
    readonly withFqdn?: boolean;
    readonly tags?: Readonly<Record<string, string>> | null;
    readonly provisioningState?: string;
  }[];
  readonly wires: readonly WireSpec[];
  /**
   * Template-level wires. Present so the `declared` vs `configured` distinction
   * — the one PRP §3.7 calls out for `edgeProvenanceChanged` — can be exercised
   * at all. The deployed console cannot collect these (bicep is not in the
   * image), which is exactly why a diff has to reason about COVERAGE and not
   * just about counts.
   */
  readonly declaredWires?: readonly DeclaredWireSpec[];
}

const DEFAULT_BICEP_ARTIFACT = 'platform/fiab/bicep/modules/admin-plane/main.bicep';

function declaredExtraction(specs: readonly DeclaredWireSpec[]): ExtractionResult {
  const artifacts = [...new Set(specs.map((s) => s.artifact ?? DEFAULT_BICEP_ARTIFACT))];
  const nodes: BrainNode[] = artifacts.map((path) => ({
    id: deployArtifactNodeId(path),
    kind: 'deploy-artifact',
    displayName: path.split('/').pop() ?? path,
    source: 'bicep',
    path,
    artifactKind: 'bicep-module',
  }));
  const edges: PendingEdge[] = specs.map((s) => ({
    provenance: 'declared',
    from: nodeIdOf(s.onApp),
    targetRef: armId(s.toApp),
    emptyValue: false,
    evidence: {
      artifact: s.artifact ?? DEFAULT_BICEP_ARTIFACT,
      ...(s.line === undefined ? {} : { line: s.line }),
      symbol: s.envVar,
      rawValue: armId(s.toApp),
      extractor: 'bicep',
    },
  }));
  return {
    source: 'bicep',
    nodes,
    edges,
    population: makePopulation({
      subject: 'edges',
      nodes,
      edges,
      scope: `${specs.length} declared wire(s) from a fixture bicep module`,
    }),
    skipped: [],
  };
}

/**
 * Build a graph the same way `app/api/admin/brain/_lib/live-graph.ts` does —
 * one Resource Graph pull feeding both extractors — so these fixtures exercise
 * the real assembly path rather than a hand-built object graph.
 */
export function buildEstate(spec: EstateSpec, opts?: { readonly estateId?: string }): BrainGraph {
  const rows = spec.apps.map((a) =>
    appRow({
      name: a.name,
      ...(a.minReplicas === undefined ? {} : { minReplicas: a.minReplicas }),
      ...(a.external === undefined ? {} : { external: a.external }),
      ...(a.withFqdn === undefined ? {} : { withFqdn: a.withFqdn }),
      ...(a.tags === undefined ? {} : { tags: a.tags }),
      ...(a.provisioningState === undefined ? {} : { provisioningState: a.provisioningState }),
    }),
  );

  const resourceExtraction = extractFromResourceGraph(rows, {
    estateId: opts?.estateId ?? ESTATE,
  });

  const byApp = new Map<string, ContainerAppEnvEntry[]>();
  const bindings: Record<string, NodeId> = {};
  const names: string[] = [];
  for (const w of spec.wires) {
    const list = byApp.get(w.onApp);
    const entry: ContainerAppEnvEntry = { name: w.envVar, value: w.value };
    if (list) list.push(entry);
    else byApp.set(w.onApp, [entry]);
    if (w.boundTo) bindings[w.envVar] = nodeIdOf(w.boundTo);
    if (!names.includes(w.envVar)) names.push(w.envVar);
  }

  const envExtraction = extractFromContainerAppEnv(
    [...byApp.entries()].map(([app, env]) => ({
      appResourceId: armId(app),
      env,
      envVarBindings: bindings,
      onlyNames: names,
    })),
  );

  const extractions = [resourceExtraction, envExtraction];
  if (spec.declaredWires && spec.declaredWires.length > 0) {
    extractions.push(declaredExtraction(spec.declaredWires));
  }
  return buildGraph(extractions);
}

/** The provenances a live console capture can actually collect. */
export const RUNTIME_PROVENANCES: readonly EdgeProvenance[] = ['configured', 'owns'];

/** Build a version record from a spec, at a chosen instant. */
export function versionFrom(
  spec: EstateSpec,
  capturedAt: string,
  opts?: {
    readonly estateId?: string;
    readonly collectedProvenances?: readonly EdgeProvenance[];
    readonly source?: string;
  },
): GraphVersion {
  return buildVersionRecord({
    graph: buildEstate(spec, { estateId: opts?.estateId ?? ESTATE }),
    estateId: opts?.estateId ?? ESTATE,
    capturedAt,
    collectedProvenances: opts?.collectedProvenances ?? RUNTIME_PROVENANCES,
    source: opts?.source ?? 'fixture',
  });
}

/**
 * THE BASELINE ESTATE.
 *
 * `loom-console` wires `LOOM_DIRECTLAKE_URL` to a real endpoint (the control)
 * and `LOOM_BROKER_URL` to `''` (the founding finding: the broker is always-on,
 * healthy, addressable and reachable by nothing). `loom-scratch` has no inbound
 * wire at all.
 */
export const BASELINE: EstateSpec = {
  apps: [
    { name: 'loom-console', minReplicas: 2, external: true },
    { name: 'loom-direct-lake', minReplicas: 1 },
    { name: 'loom-capacity-broker', minReplicas: 2 },
    { name: 'loom-scratch', minReplicas: 0 },
  ],
  wires: [
    {
      onApp: 'loom-console',
      envVar: 'LOOM_DIRECTLAKE_URL',
      value: `https://${fqdnOf('loom-direct-lake')}`,
      boundTo: 'loom-direct-lake',
    },
    { onApp: 'loom-console', envVar: 'LOOM_BROKER_URL', value: '', boundTo: 'loom-capacity-broker' },
  ],
};

/** Deep-clone a version so a test can corrupt one without touching the original. */
export function cloneVersion(v: GraphVersion): GraphVersion {
  return JSON.parse(JSON.stringify(v)) as GraphVersion;
}

/**
 * Re-derive a version's digest and counts around patched content.
 *
 * A test that wants to exercise the COMPARATOR on an edited graph must not
 * accidentally exercise the INTEGRITY CHECK instead — an edited version is
 * REFUSED, correctly, and the test would then be measuring the wrong thing. This
 * rebuilds the record so it verifies, using the same functions production uses.
 */
export function rebuildVersion(v: GraphVersion, content: GraphVersionContent): GraphVersion {
  return {
    ...v,
    formatVersion: content.formatVersion,
    digest: computeContentDigest(content),
    counts: computeCounts(content),
    content,
  };
}

/**
 * Fisher-Yates with a fixed seed.
 *
 * Used to prove the digest is order-invariant. A random shuffle would make a
 * failure irreproducible, and an unshuffled "shuffle" would make the test pass
 * while asserting nothing — so the permutation is deterministic AND the test
 * asserts it actually moved something.
 */
export function seededShuffle<T>(items: readonly T[], seed = 12345): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
