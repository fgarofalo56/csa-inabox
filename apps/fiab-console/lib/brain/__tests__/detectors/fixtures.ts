/**
 * LOOM BRAIN — shared fixtures for the detector suites.
 *
 * ── EVERY FIXTURE CARRIES A CONTROL ────────────────────────────────────────
 * A detector that returned EVERY node would pass any test that only asserts "the
 * bad one is in the result". So each estate here contains, alongside the subject:
 *
 *   `loom-direct-lake`  always-on AND properly wired. Must be ABSENT from
 *                       unreachable-service, declared-but-dead and dangling-wire.
 *   `loom-scratch`      unreachable AND scale-to-zero (minReplicas 0). Must be
 *                       ABSENT from unreachable-service and always-on-unused —
 *                       this is the control that proves the ALWAYS-ON half of the
 *                       predicate is load-bearing, not decoration. Without it,
 *                       deleting `minReplicas > 0` from the predicate would not
 *                       change a single assertion.
 *   `loom-unmeasured`   a container app whose discovery row carried no
 *                       `template.scale`. Must appear in `skipped`, never in
 *                       findings and never in a "clean" count — NOT MEASURED is
 *                       not minReplicas 0.
 *
 * All subscription and resource ids below are obviously-fake placeholders. This
 * is a PUBLIC repo; no tenant, subscription, object or resource id from the real
 * estate appears in any file here.
 */

import {
  buildGraph,
  azureResourceNodeId,
  extractFromBicep,
  extractFromContainerAppEnv,
  extractFromResourceGraph,
  makePopulation,
  type BrainGraph,
  type ExtractionResult,
  type NodeId,
  type PendingEdge,
  type ResourceGraphRow,
} from '../../graph';

export const SUB = '11111111-1111-1111-1111-111111111111';
export const RG = 'rg-csa-loom-example';
export const ESTATE = 'loom-example-estate';
export const ENV_DOMAIN = 'examplegreenfield-00000000.centralus.azurecontainerapps.io';

export const BROKER_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-capacity-broker`;
export const CONSOLE_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-console`;
export const DIRECTLAKE_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-direct-lake`;
export const SCRATCH_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-scratch`;
export const UNMEASURED_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-unmeasured`;

export const BROKER_FQDN = `loom-capacity-broker.internal.${ENV_DOMAIN}`;
export const DIRECTLAKE_FQDN = `loom-direct-lake.internal.${ENV_DOMAIN}`;
export const SCRATCH_FQDN = `loom-scratch.internal.${ENV_DOMAIN}`;
export const CONSOLE_FQDN = `loom-console.${ENV_DOMAIN}`;

export const BROKER_ID = azureResourceNodeId(BROKER_ARM);
export const CONSOLE_ID = azureResourceNodeId(CONSOLE_ARM);
export const DIRECTLAKE_ID = azureResourceNodeId(DIRECTLAKE_ARM);
export const SCRATCH_ID = azureResourceNodeId(SCRATCH_ARM);
export const UNMEASURED_ID = azureResourceNodeId(UNMEASURED_ARM);

export const BICEP_PATH = 'platform/fiab/bicep/modules/admin-plane/main.bicep';

/** The canonical node id for an ARM id. Re-exported so suites use the sanctioned constructor. */
export const azureIdOf = azureResourceNodeId;

/** A container app as Resource Graph projects it. */
export function appRow(args: {
  armId: string;
  name: string;
  minReplicas?: number;
  maxReplicas?: number;
  cpu?: number;
  memory?: string;
  external?: boolean;
  fqdn?: string;
  location?: string;
  tags?: Readonly<Record<string, string>> | null;
  /** Omit `template.scale` entirely — the NOT MEASURED case. */
  noScale?: boolean;
}): ResourceGraphRow {
  const template = args.noScale
    ? { containers: [{ name: args.name }] }
    : {
        containers: [
          { name: args.name, resources: { cpu: args.cpu ?? 0.5, memory: args.memory ?? '1Gi' } },
        ],
        scale: { minReplicas: args.minReplicas ?? 0, maxReplicas: args.maxReplicas ?? 3 },
      };
  return {
    id: args.armId,
    type: 'Microsoft.App/containerApps',
    name: args.name,
    resourceGroup: RG,
    subscriptionId: SUB,
    location: args.location ?? 'centralus',
    tags: args.tags === undefined ? { 'loom-estate-id': ESTATE } : args.tags,
    properties: {
      provisioningState: 'Succeeded',
      configuration: args.fqdn
        ? { ingress: { external: args.external ?? false, fqdn: args.fqdn, targetPort: 8080 } }
        : {},
      template,
    },
  };
}

/**
 * `admin-plane/main.bicep`'s `env:` block. The LOOM_BROKER_URL line is verbatim
 * from :4730 and the DIRECTLAKE line from :4729.
 *
 * Written with explicit `\n` joins: this repo checks out `.ts` as CRLF
 * (`core.autocrlf=true`), and a fixture built from a template literal would carry
 * whichever ending the working tree has. The bicep extractor normalizes both, so
 * this is belt-and-braces — but a fixture whose content depends on a git config
 * is a fixture that behaves differently in CI than locally.
 */
export const ADMIN_PLANE_BICEP = [
  '        env: [',
  "            { name: 'LOOM_DIRECTLAKE_URL', value: directLakeSvcActive ? 'https://${loomDirectLake!.outputs.fqdn}' : '' }",
  "            { name: 'LOOM_BROKER_URL', value: '' }",
  '        ]',
].join('\n');

export interface FixtureOptions {
  /** Emit `observed` edges (a telemetry stand-in). Default: none, matching today's graph. */
  readonly observedCalls?: readonly { readonly from: NodeId; readonly to: string }[];
  /** Drop the ownership tag from every row, so no `owns` edge is produced. */
  readonly withoutOwnershipTag?: boolean;
  /** Extra Resource Graph rows. */
  readonly extraRows?: readonly ResourceGraphRow[];
  /** Extra live env entries on the console, appended to the defaults. */
  readonly extraConsoleEnv?: readonly { readonly name: string; readonly value?: string; readonly secretRef?: string }[];
  /** REPLACE the console's live env entirely, rather than appending. */
  readonly consoleEnvOverride?: readonly { readonly name: string; readonly value?: string; readonly secretRef?: string }[];
  /** Extra `envVarBindings` for the console's live env. */
  readonly extraConsoleBindings?: Readonly<Record<string, NodeId>>;
  /** Extra lines spliced into the bicep `env:` block. */
  readonly extraBicepLines?: readonly string[];
  /** Extra `envVarBindings` for the bicep extractor. */
  readonly extraBicepBindings?: Readonly<Record<string, NodeId>>;
  /** Extra bicep module symbol -> target ref mappings. */
  readonly extraModuleTargets?: Readonly<Record<string, string>>;
}

/**
 * An `observed` extraction, shaped exactly as a real telemetry extractor would
 * shape it.
 *
 * This is NOT a mock of the detector — the detector is untouched and reads the
 * graph as always. It is a stand-in for the ONE extractor that does not exist
 * yet, which is what lets `always-on-unused` be tested on both arms: with
 * telemetry (findings) and without (everything skipped). Without this, the
 * with-telemetry arm could never run and the detector's real behaviour would be
 * unproven.
 */
export function telemetryExtraction(
  calls: readonly { readonly from: NodeId; readonly to: string }[],
): ExtractionResult {
  const edges: PendingEdge[] = calls.map((c) => ({
    provenance: 'observed',
    from: c.from,
    targetRef: c.to,
    emptyValue: false,
    intendedTo: null,
    evidence: {
      artifact: 'telemetry:requests',
      symbol: 'inbound-request',
      rawValue: c.to,
      extractor: 'telemetry',
    },
  }));
  return {
    source: 'telemetry',
    nodes: [],
    edges,
    population: makePopulation({
      subject: 'edges',
      nodes: [],
      edges: [],
      scope: `${calls.length} observed call path(s) (test stand-in for the telemetry extractor)`,
    }),
    skipped: [],
  };
}

/**
 * The estate fixture: the broker (unreachable, always-on), direct-lake (wired,
 * always-on), scratch (unreachable, scale-to-zero), unmeasured (no scale facts),
 * and the console that consumes them.
 */
export function buildFixtureGraph(options: FixtureOptions = {}): BrainGraph {
  const tags = options.withoutOwnershipTag ? {} : undefined;

  const rg = extractFromResourceGraph(
    [
      appRow({ armId: BROKER_ARM, name: 'loom-capacity-broker', minReplicas: 2, maxReplicas: 5, cpu: 0.5, memory: '1Gi', fqdn: BROKER_FQDN, tags }),
      appRow({ armId: DIRECTLAKE_ARM, name: 'loom-direct-lake', minReplicas: 1, maxReplicas: 3, cpu: 0.5, memory: '1Gi', fqdn: DIRECTLAKE_FQDN, tags }),
      appRow({ armId: SCRATCH_ARM, name: 'loom-scratch', minReplicas: 0, maxReplicas: 3, cpu: 0.5, memory: '1Gi', fqdn: SCRATCH_FQDN, tags }),
      appRow({ armId: UNMEASURED_ARM, name: 'loom-unmeasured', fqdn: undefined, noScale: true, tags }),
      appRow({ armId: CONSOLE_ARM, name: 'loom-console', minReplicas: 2, maxReplicas: 10, cpu: 1, memory: '2Gi', external: true, fqdn: CONSOLE_FQDN, tags }),
      ...(options.extraRows ?? []),
    ],
    options.withoutOwnershipTag ? {} : { estateId: ESTATE },
  );

  const bicep = extractFromBicep([
    {
      path: BICEP_PATH,
      // The extra lines go INSIDE the env block, before its closing bracket, so
      // they are parsed the same way the real entries are.
      text: [
        ...ADMIN_PLANE_BICEP.split('\n').slice(0, -1),
        ...(options.extraBicepLines ?? []),
        '        ]',
      ].join('\n'),
      consumer: CONSOLE_ID,
      envVarBindings: {
        LOOM_BROKER_URL: BROKER_ID,
        LOOM_DIRECTLAKE_URL: DIRECTLAKE_ID,
        ...(options.extraBicepBindings ?? {}),
      },
      moduleTargets: { loomDirectLake: DIRECTLAKE_FQDN, ...(options.extraModuleTargets ?? {}) },
    },
  ]);

  const live = extractFromContainerAppEnv([
    {
      appResourceId: CONSOLE_ARM,
      envVarBindings: { LOOM_BROKER_URL: BROKER_ID, ...(options.extraConsoleBindings ?? {}) },
      env: options.consoleEnvOverride ?? [
        { name: 'LOOM_BROKER_URL', value: '' },
        { name: 'LOOM_DIRECTLAKE_URL', value: `https://${DIRECTLAKE_FQDN}` },
        ...(options.extraConsoleEnv ?? []),
      ],
    },
  ]);

  const extractions = [rg, bicep, live];
  if (options.observedCalls?.length) extractions.push(telemetryExtraction(options.observedCalls));
  return buildGraph(extractions);
}

/** A graph with NO edges of any provenance except `owns`. For vacuity arms. */
export function buildEdgelessGraph(): BrainGraph {
  return buildGraph([
    extractFromResourceGraph(
      [
        appRow({ armId: BROKER_ARM, name: 'loom-capacity-broker', minReplicas: 2, cpu: 0.5, memory: '1Gi', fqdn: BROKER_FQDN }),
        appRow({ armId: DIRECTLAKE_ARM, name: 'loom-direct-lake', minReplicas: 1, cpu: 0.5, memory: '1Gi', fqdn: DIRECTLAKE_FQDN }),
      ],
      { estateId: ESTATE },
    ),
  ]);
}

// ---------------------------------------------------------------------------
// #4258 — THE MUTUALLY-REFERENCING ISLAND
// ---------------------------------------------------------------------------

export const PEER_A_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-peer-a`;
export const PEER_B_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-peer-b`;
export const PEER_A_FQDN = `loom-peer-a.internal.${ENV_DOMAIN}`;
export const PEER_B_FQDN = `loom-peer-b.internal.${ENV_DOMAIN}`;
export const PEER_A_ID = azureResourceNodeId(PEER_A_ARM);
export const PEER_B_ID = azureResourceNodeId(PEER_B_ARM);

/**
 * TWO ALWAYS-ON INTERNAL APPS THAT NAME EACH OTHER, AND NOTHING ELSE.
 *
 * The shape an inbound-edge COUNT cannot see (#4258). Each peer has exactly one
 * inbound resolved `configured` edge — from the other peer — so
 * `inboundEdges(id,'configured').length === 0` is FALSE for both and the old
 * predicate cleared them. Nothing outside the pair can reach either: the console
 * is the only externally-ingressed app here and it wires only `loom-direct-lake`.
 *
 * The island bills continuously and is unreachable, which is precisely the class
 * the founding finding exists to catch.
 *
 * `peerAExternal` is the CONTROL arm. Give A external ingress and A becomes a
 * root of the walk, so B is genuinely reachable from outside and must be
 * CLEARED — which proves the walk is doing the work, rather than the test
 * passing because every node in a small graph happens to be flagged.
 */
export function buildMutualIslandGraph(
  options: { readonly peerAExternal?: boolean } = {},
): BrainGraph {
  const rg = extractFromResourceGraph(
    [
      appRow({
        armId: PEER_A_ARM,
        name: 'loom-peer-a',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        external: options.peerAExternal === true,
        fqdn: PEER_A_FQDN,
      }),
      appRow({
        armId: PEER_B_ARM,
        name: 'loom-peer-b',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: PEER_B_FQDN,
      }),
      // The CONTROL pair: an externally-ingressed console that wires
      // `loom-direct-lake`. `loom-direct-lake` must be CLEARED on both arms —
      // without it, a walk that reached nothing would look identical to a walk
      // that reached the right things.
      appRow({
        armId: DIRECTLAKE_ARM,
        name: 'loom-direct-lake',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: DIRECTLAKE_FQDN,
      }),
      appRow({
        armId: CONSOLE_ARM,
        name: 'loom-console',
        minReplicas: 2,
        maxReplicas: 10,
        cpu: 1,
        memory: '2Gi',
        external: true,
        fqdn: CONSOLE_FQDN,
      }),
    ],
    { estateId: ESTATE },
  );

  const live = extractFromContainerAppEnv([
    {
      appResourceId: PEER_A_ARM,
      envVarBindings: { LOOM_PEER_B_URL: PEER_B_ID },
      env: [{ name: 'LOOM_PEER_B_URL', value: `https://${PEER_B_FQDN}` }],
    },
    {
      appResourceId: PEER_B_ARM,
      envVarBindings: { LOOM_PEER_A_URL: PEER_A_ID },
      env: [{ name: 'LOOM_PEER_A_URL', value: `https://${PEER_A_FQDN}` }],
    },
    {
      appResourceId: CONSOLE_ARM,
      envVarBindings: { LOOM_DIRECTLAKE_URL: DIRECTLAKE_ID },
      env: [{ name: 'LOOM_DIRECTLAKE_URL', value: `https://${DIRECTLAKE_FQDN}` }],
    },
  ]);

  return buildGraph([rg, live]);
}

// ---------------------------------------------------------------------------
// TRANSITIVITY — the property that separates a WALK from a one-hop expansion
// ---------------------------------------------------------------------------

export const RELAY_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-relay`;
export const LEAF_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-leaf`;
export const RELAY_FQDN = `loom-relay.internal.${ENV_DOMAIN}`;
export const LEAF_FQDN = `loom-leaf.internal.${ENV_DOMAIN}`;
export const RELAY_ID = azureResourceNodeId(RELAY_ARM);
export const LEAF_ID = azureResourceNodeId(LEAF_ARM);

/**
 * A TWO-HOP INTERNAL CHAIN: external console → `loom-relay` → `loom-leaf`.
 *
 * ── WHY THIS FIXTURE EXISTS ────────────────────────────────────────────────
 * Every other arm in this file is ONE HOP from a root. The roots of
 * `nodesNotReachableFrom` are every externally-ingressed node plus every
 * non-Container-App node, so the only non-roots are internal container apps —
 * and in the island fixture the console wires `loom-direct-lake` directly, and
 * the `peerAExternal` arm makes A a root wiring B directly. Both clear at one
 * hop.
 *
 * That left the walk's DEFINING property unpinned. Deleting the single line
 * `queue.push(to)` from the BFS degrades it to a one-hop expansion of the root
 * set — measured: the whole suite still returned RC=0 at 206/206. Transitivity
 * is the entire difference between this function and the
 * `inbound(graph, id, 'configured').length === 0` proxy that #4258 replaced, so
 * a suite that cannot see the difference cannot defend the fix.
 *
 * `loom-leaf` has exactly ONE inbound resolved `configured` edge, from
 * `loom-relay`, and no other path in. It is therefore reachable ONLY via two
 * hops from the console. Under the degradation it is left unreached and the
 * detector emits a DELETION PROPOSAL against a live, genuinely-reachable
 * service — the expensive failure direction.
 *
 * `loom-relay` is the ONE-HOP CONTROL: it clears under the degradation too, so
 * asserting only on it would prove nothing. The mutual island is carried along
 * so the graph produces real findings — without it, "leaf is cleared" would be
 * satisfied by a detector that flagged nothing at all.
 */
export function buildTransitiveChainGraph(): BrainGraph {
  const rg = extractFromResourceGraph(
    [
      appRow({
        armId: CONSOLE_ARM,
        name: 'loom-console',
        minReplicas: 2,
        maxReplicas: 10,
        cpu: 1,
        memory: '2Gi',
        external: true,
        fqdn: CONSOLE_FQDN,
      }),
      appRow({
        armId: RELAY_ARM,
        name: 'loom-relay',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: RELAY_FQDN,
      }),
      appRow({
        armId: LEAF_ARM,
        name: 'loom-leaf',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: LEAF_FQDN,
      }),
      // The POSITIVE population: an always-on island nothing can reach. Its
      // findings prove the detector ran and is willing to flag, so the leaf's
      // clearance is a verdict rather than an empty result.
      appRow({
        armId: PEER_A_ARM,
        name: 'loom-peer-a',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: PEER_A_FQDN,
      }),
      appRow({
        armId: PEER_B_ARM,
        name: 'loom-peer-b',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: PEER_B_FQDN,
      }),
    ],
    { estateId: ESTATE },
  );

  const live = extractFromContainerAppEnv([
    // HOP 1 — from the only root in the graph.
    {
      appResourceId: CONSOLE_ARM,
      envVarBindings: { LOOM_RELAY_URL: RELAY_ID },
      env: [{ name: 'LOOM_RELAY_URL', value: `https://${RELAY_FQDN}` }],
    },
    // HOP 2 — the ONLY inbound edge the leaf has. Nothing else names it.
    {
      appResourceId: RELAY_ARM,
      envVarBindings: { LOOM_LEAF_URL: LEAF_ID },
      env: [{ name: 'LOOM_LEAF_URL', value: `https://${LEAF_FQDN}` }],
    },
    {
      appResourceId: PEER_A_ARM,
      envVarBindings: { LOOM_PEER_B_URL: PEER_B_ID },
      env: [{ name: 'LOOM_PEER_B_URL', value: `https://${PEER_B_FQDN}` }],
    },
    {
      appResourceId: PEER_B_ARM,
      envVarBindings: { LOOM_PEER_A_URL: PEER_A_ID },
      env: [{ name: 'LOOM_PEER_A_URL', value: `https://${PEER_A_FQDN}` }],
    },
  ]);

  return buildGraph([rg, live]);
}

/**
 * THE ESTATE-SCALE GRAPH — 63 container apps and NO ownership tag.
 *
 * ── WHY THIS FIXTURE EXISTS ────────────────────────────────────────────────
 * Every other fixture here is 7-9 nodes. The measured estate is 63 container
 * apps across six subscriptions, of which 19 never scale to zero, and ZERO
 * resources carry `loom-estate-id`. That gap is not cosmetic: it is the reason
 * ten separate bypasses keyed to `graph.nodes.length > 20` passed the entire
 * suite at 261/261 during review of this PR. A guard that only ever runs against
 * nine nodes cannot see a filter that switches on at twenty.
 *
 * So this graph exists to make the PRODUCTION VALUE reachable by the suite. Every
 * cross-detector invariant in `contract.test.ts` runs against it, which means a
 * predicate bypass, a lost verdict or an ownership inference that only fires at
 * estate cardinality now fails here rather than on the operator's estate.
 *
 * The shape is deliberately the measured one, not a convenient one:
 *   - NO `loom-estate-id` anywhere, so the graph holds zero `owns` edges and
 *     `ownership()` must return `not-established` for all 63. This is the branch
 *     an `'owned'` bypass would hide in.
 *   - a spread of always-on / scale-to-zero / scale-not-measured / externally
 *     ingressed apps, so each disposition branch has a real population.
 */
export function buildEstateScaleGraph(): BrainGraph {
  const filler: ResourceGraphRow[] = [];
  // 58 filler apps + the 5 named ones above = 63, the measured container-app count.
  for (let i = 0; i < 58; i += 1) {
    const name = `loom-app-${String(i).padStart(2, '0')}`;
    const armId = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${name}`;
    const mode = i % 4;
    filler.push(
      appRow({
        armId,
        name,
        // 0 -> always-on and unwired (the population this program exists for)
        // 1 -> scales to zero          2 -> externally ingressed
        // 3 -> scale NOT MEASURED
        noScale: mode === 3,
        minReplicas: mode === 0 || mode === 2 ? 1 : 0,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        external: mode === 2,
        fqdn: mode === 3 ? undefined : `${name}.internal.${ENV_DOMAIN}`,
        tags: {},
      }),
    );
  }
  return buildFixtureGraph({ withoutOwnershipTag: true, extraRows: filler });
}
