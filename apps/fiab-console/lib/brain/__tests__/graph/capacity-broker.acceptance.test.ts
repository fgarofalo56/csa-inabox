/**
 * LOOM BRAIN — THE ACCEPTANCE TEST.
 *
 * PRP §5: "`loom-capacity-broker` appears as an unreachable always-on node with
 * its evidence chain — that is the acceptance test, because it is the founding
 * measured example."
 *
 * ── THE MEASURED FACTS THIS FIXTURE REPRODUCES ─────────────────────────────
 * Verified against the repo at the time of writing:
 *
 *   platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep
 *     :124  external: false          — INTERNAL ingress. Addressable, not public.
 *     :154  cpu: json('0.5')
 *     :155  memory: '1Gi'
 *     :186  minReplicas: 2           — always-on, so 1 vCPU / 2 GiB billed 24/7
 *     :187  maxReplicas: 5
 *     :162/:173  liveness + readiness probes — it is HEALTHY
 *
 *   platform/fiab/bicep/modules/admin-plane/main.bicep
 *     :4730 { name: 'LOOM_BROKER_URL', value: '' }
 *           the ONLY name any bicep emits for the broker's URL
 *
 *   apps/fiab-console/lib/azure/capacity-broker-client.ts
 *     :95   process.env.LOOM_CAPACITY_BROKER_URL || process.env.LOOM_BROKER_URL
 *           both empty, so capacityBrokerConfigured() is false
 *
 * A billing service with no inbound edge. A liveness check finds NOTHING here —
 * the app is healthy, provisioned, and answering its probes. Only reachability
 * finds it.
 *
 * ── THE CONTROL IS THE POINT ───────────────────────────────────────────────
 * This fixture carries a SECOND always-on service, `loom-direct-lake`, that IS
 * properly wired: bicep declares a real value and the live app carries the
 * matching FQDN. Without it the test could not discriminate — a query that
 * returned "every container app is unreachable" would pass just as well, and
 * that is exactly the shape of a detector that is green and blind. The control
 * must be ABSENT from every unreachable result, and that assertion is what makes
 * the broker's presence mean something.
 *
 * All subscription/resource ids below are obviously-fake placeholders.
 */
import { describe, it, expect } from 'vitest';
import {
  alwaysOnNodes,
  azureResourceNodeId,
  buildGraph,
  extractFromBicep,
  extractFromContainerAppEnv,
  extractFromResourceGraph,
  nodesWithNoInboundEdge,
  type ResourceGraphRow,
} from '../../graph';

const SUB = '11111111-1111-1111-1111-111111111111';
const RG = 'rg-csa-loom-example';
const ESTATE = 'loom-example-estate';
const ENV_DOMAIN = 'examplegreenfield-00000000.centralus.azurecontainerapps.io';

const BROKER_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-capacity-broker`;
const CONSOLE_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-console`;
const DIRECTLAKE_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-direct-lake`;

const BROKER_FQDN = `loom-capacity-broker.internal.${ENV_DOMAIN}`;
const DIRECTLAKE_FQDN = `loom-direct-lake.internal.${ENV_DOMAIN}`;
const CONSOLE_FQDN = `loom-console.${ENV_DOMAIN}`;

const BROKER_ID = azureResourceNodeId(BROKER_ARM);
const CONSOLE_ID = azureResourceNodeId(CONSOLE_ARM);
const DIRECTLAKE_ID = azureResourceNodeId(DIRECTLAKE_ARM);

/** A container app as Resource Graph projects it. */
function appRow(args: {
  armId: string;
  name: string;
  minReplicas: number;
  maxReplicas: number;
  cpu: number;
  memory: string;
  external: boolean;
  fqdn: string;
}): ResourceGraphRow {
  return {
    id: args.armId,
    type: 'Microsoft.App/containerApps',
    name: args.name,
    resourceGroup: RG,
    subscriptionId: SUB,
    location: 'centralus',
    tags: { 'loom-estate-id': ESTATE },
    properties: {
      provisioningState: 'Succeeded',
      configuration: {
        ingress: { external: args.external, fqdn: args.fqdn, targetPort: 8080 },
      },
      template: {
        containers: [{ name: args.name, resources: { cpu: args.cpu, memory: args.memory } }],
        scale: { minReplicas: args.minReplicas, maxReplicas: args.maxReplicas },
      },
    },
  };
}

/**
 * The `env:` block as `admin-plane/main.bicep` actually writes it. The
 * LOOM_BROKER_URL line is verbatim from :4730; the DIRECTLAKE line is verbatim
 * from :4729 and is the wired control.
 */
const ADMIN_PLANE_BICEP = [
  "        env: [",
  "            { name: 'LOOM_ONELAKE_URL', value: '' }",
  "            { name: 'LOOM_DIRECTLAKE_URL', value: directLakeSvcActive ? 'https://${loomDirectLake!.outputs.fqdn}' : '' }",
  "            { name: 'LOOM_BROKER_URL', value: '' }",
  "            { name: 'LOOM_BROKER_REDIS', value: '' }",
  "        ]",
].join('\n');

const BICEP_PATH = 'platform/fiab/bicep/modules/admin-plane/main.bicep';

function buildEstateGraph() {
  const rg = extractFromResourceGraph(
    [
      appRow({
        armId: BROKER_ARM,
        name: 'loom-capacity-broker',
        minReplicas: 2,
        maxReplicas: 5,
        cpu: 0.5,
        memory: '1Gi',
        external: false,
        fqdn: BROKER_FQDN,
      }),
      appRow({
        armId: DIRECTLAKE_ARM,
        name: 'loom-direct-lake',
        minReplicas: 1,
        maxReplicas: 3,
        cpu: 0.5,
        memory: '1Gi',
        external: false,
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

  const bicep = extractFromBicep([
    {
      path: BICEP_PATH,
      text: ADMIN_PLANE_BICEP,
      consumer: CONSOLE_ID,
      // An empty value cannot name its own target, so the intent is supplied as
      // reviewable data rather than guessed from the variable name.
      envVarBindings: { LOOM_BROKER_URL: BROKER_ID, LOOM_DIRECTLAKE_URL: DIRECTLAKE_ID },
      moduleTargets: { loomDirectLake: DIRECTLAKE_FQDN },
    },
  ]);

  const live = extractFromContainerAppEnv([
    {
      appResourceId: CONSOLE_ARM,
      envVarBindings: { LOOM_BROKER_URL: BROKER_ID },
      env: [
        // The live console carries the bicep-emitted name with an empty value.
        { name: 'LOOM_BROKER_URL', value: '' },
        // …and direct-lake wired to its real internal FQDN. The control.
        { name: 'LOOM_DIRECTLAKE_URL', value: `https://${DIRECTLAKE_FQDN}` },
      ],
    },
  ]);

  return buildGraph([rg, bicep, live]);
}

describe('ACCEPTANCE — loom-capacity-broker is an unreachable always-on node', () => {
  const graph = buildEstateGraph();

  it('the broker is ALWAYS ON: minReplicas 2, 0.5 vCPU, 1 GiB, internal FQDN, Succeeded', () => {
    const broker = graph.node(BROKER_ID);
    expect(broker).toBeDefined();
    expect(broker!.kind).toBe('azure-resource');
    if (broker!.kind !== 'azure-resource') throw new Error('unreachable');
    expect(broker!.scale?.minReplicas).toBe(2);
    expect(broker!.scale?.cpu).toBe(0.5);
    expect(broker!.scale?.memory).toBe('1Gi');
    expect(broker!.ingress?.external).toBe(false);
    expect(broker!.ingress?.fqdn).toBe(BROKER_FQDN);
    // Healthy and provisioned — which is precisely why a liveness check finds
    // nothing and this test has to exist.
    expect(broker!.provisioningState).toBe('Succeeded');
  });

  it('THE FINDING: the broker has ZERO inbound `configured` edges', () => {
    const inbound = graph.inboundEdges(BROKER_ID, 'configured');
    expect(inbound.result).toHaveLength(0);
    // P3 — the verdict is not readable without the population, and this
    // population is NOT blind: there are edges in the graph to examine.
    expect(inbound.population.blind).toBe(false);
    expect(inbound.population.edgesExamined).toBeGreaterThan(0);
  });

  it('THE FINDING: nor any inbound `declared` edge — the bicep wire is dangling', () => {
    expect(graph.inboundEdges(BROKER_ID, 'declared').result).toHaveLength(0);
  });

  it('THE CONTROL: loom-direct-lake IS reachable, so the query discriminates', () => {
    const inbound = graph.inboundEdges(DIRECTLAKE_ID, 'configured');
    expect(inbound.result).toHaveLength(1);
    expect(inbound.result[0]!.from).toBe(CONSOLE_ID);
    expect(inbound.result[0]!.evidence.symbol).toBe('LOOM_DIRECTLAKE_URL');
  });

  it('the reachability QUERY returns the broker and NOT the wired control', () => {
    const unreachable = nodesWithNoInboundEdge(graph, 'configured', {
      resourceType: 'Microsoft.App/containerApps',
      describe: 'container apps',
    });
    const ids = unreachable.result.map((n) => n.id);

    expect(ids).toContain(BROKER_ID);
    // The whole discrimination. A query that returned everything would pass the
    // assertion above and fail this one.
    expect(ids).not.toContain(DIRECTLAKE_ID);

    // …and the population is reported, not assumed. `byProvenance.configured`
    // is the vacuous-truth check: were it 0, "no inbound configured edge" would
    // be true of every node for an uninteresting reason.
    expect(unreachable.population.blind).toBe(false);
    expect(unreachable.population.examined).toBe(3);
    expect(unreachable.population.byProvenance.configured).toBeGreaterThan(0);
  });

  it('THE EVIDENCE CHAIN survives: the main.bicep line, the symbol, and the empty-string value', () => {
    const dangling = graph.danglingEdgesIntendedFor(BROKER_ID);
    const declared = dangling.result.find((e) => e.provenance === 'declared');

    expect(declared).toBeDefined();
    expect(declared!.evidence.artifact).toBe(BICEP_PATH);
    expect(declared!.evidence.symbol).toBe('LOOM_BROKER_URL');
    // The receipt. Not "no value found" — the wire is there and it is ''.
    expect(declared!.evidence.rawValue).toBe("''");
    expect(declared!.danglingReason).toBe('empty-value');
    // P2 — a dangling edge's target is null, which is what keeps it out of
    // reachability while leaving the evidence intact.
    expect(declared!.to).toBeNull();
    expect(declared!.intendedTo).toBe(BROKER_ID);

    // The live side agrees: the running console also carries the empty wire.
    const live = dangling.result.find((e) => e.provenance === 'configured');
    expect(live).toBeDefined();
    expect(live!.evidence.artifact).toBe(CONSOLE_ARM);
    expect(live!.evidence.symbol).toBe('LOOM_BROKER_URL');
    expect(live!.danglingReason).toBe('empty-value');
  });

  it('the broker is in BOTH sets — always-on AND unreachable. That is the finding.', () => {
    const filter = { resourceType: 'Microsoft.App/containerApps', describe: 'container apps' };
    const alwaysOn = alwaysOnNodes(graph, filter).result.map((n) => n.id);
    const unreachable = nodesWithNoInboundEdge(graph, 'configured', filter).result.map((n) => n.id);
    const both = alwaysOn.filter((id) => unreachable.includes(id));

    expect(both).toContain(BROKER_ID);
    expect(both).not.toContain(DIRECTLAKE_ID);
  });

  it('the graph build report states the population, including edges by provenance', () => {
    const r = graph.report;
    // A graph with zero `declared` edges would make every declared-vs-configured
    // detector return clean and be wrong. Assert the counts exist.
    expect(r.edgesByProvenance.declared).toBeGreaterThan(0);
    expect(r.edgesByProvenance.configured).toBeGreaterThan(0);
    expect(r.edgesByProvenance.owns).toBeGreaterThan(0);
    expect(r.edgesByResolution.dangling).toBeGreaterThan(0);
    expect(r.edgesByResolution.resolved).toBeGreaterThan(0);
    expect(r.extractorsRun).toEqual(
      expect.arrayContaining(['resource-graph', 'bicep', 'container-app-env']),
    );
    // Every node an edge referenced was defined. A non-empty list here means an
    // extractor minted an id that disagrees with the one that defined the node.
    expect(r.danglingNodeRefs).toEqual([]);
  });
});
