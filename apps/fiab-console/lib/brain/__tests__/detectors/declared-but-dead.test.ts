/**
 * LOOM BRAIN — `declared-but-dead`: wired in the template, absent from the
 * deployment.
 *
 * Two things this suite has to establish that a single positive case would not:
 *
 *   1. THE BROKER IS NOT HERE. Its declared wire is EMPTY, so it has no resolved
 *      `declared` edge and does not meet this predicate. If it appeared, the two
 *      detectors would be double-reporting one defect under two names — and the
 *      operator would fix it twice or, worse, believe there are two.
 *   2. BOTH VACUITY ARMS. This predicate reads two provenances and so has two
 *      ways to be vacuous. The `configured`-side one is the dangerous half
 *      because it produces confident findings rather than silence.
 */

import { describe, it, expect } from 'vitest';
import { DECLARED_BUT_DEAD, declaredButDead } from '../../detectors';
import {
  BICEP_PATH,
  BROKER_ID,
  DIRECTLAKE_FQDN,
  DIRECTLAKE_ID,
  RG,
  SUB,
  appRow,
  azureIdOf,
  buildEdgelessGraph,
  buildFixtureGraph,
} from './fixtures';

const WAREHOUSE_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-warehouse`;
const WAREHOUSE_FQDN = 'loom-warehouse.internal.examplegreenfield-00000000.centralus.azurecontainerapps.io';

/** A graph where one service is declared in bicep and absent from the live env. */
function graphWithDeadDeclaration() {
  return buildFixtureGraph({
    extraRows: [
      appRow({
        armId: WAREHOUSE_ARM,
        name: 'loom-warehouse',
        minReplicas: 1,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: WAREHOUSE_FQDN,
      }),
    ],
    // Declared in the template …
    extraBicepLines: [
      "            { name: 'LOOM_WAREHOUSE_URL', value: 'https://${loomWarehouse!.outputs.fqdn}' }",
    ],
    extraModuleTargets: { loomWarehouse: WAREHOUSE_FQDN },
    // … and deliberately NOT added to the console's live env.
  });
}

describe('declared-but-dead — POSITIVE and NEGATIVE', () => {
  const graph = graphWithDeadDeclaration();
  const result = declaredButDead(graph);
  const ids = result.findings.map((f) => f.subjects[0]);

  it('POSITIVE: the service the template wires and the deployment does not is reported', () => {
    expect(result.detector).toBe(DECLARED_BUT_DEAD);
    expect(ids).toContain(azureIdOf(WAREHOUSE_ARM));
    const f = result.findings.find((x) => x.subjects[0] === azureIdOf(WAREHOUSE_ARM))!;
    expect(f.evidence.notes.join('\n')).toContain('LOOM_WAREHOUSE_URL');
    expect(f.evidence.notes.join('\n')).toContain('configured=0');
  });

  it('NEGATIVE: the service wired on BOTH sides is not reported', () => {
    // direct-lake has a resolved declared edge AND a resolved configured edge.
    expect(graph.inboundEdges(DIRECTLAKE_ID, 'declared').result.length).toBeGreaterThan(0);
    expect(graph.inboundEdges(DIRECTLAKE_ID, 'configured').result.length).toBeGreaterThan(0);
    expect(ids).not.toContain(DIRECTLAKE_ID);
  });

  it('the BROKER is absent — its declared wire is empty, so it has no resolved declared edge', () => {
    // The partition between this detector and `unreachable-service`. Reporting
    // the broker here would double-count one defect under two names.
    expect(graph.inboundEdges(BROKER_ID, 'declared').result).toHaveLength(0);
    expect(ids).not.toContain(BROKER_ID);
  });

  it('the remediation names the deploy-integrity rule, and the declaring file', () => {
    const f = result.findings.find((x) => x.subjects[0] === azureIdOf(WAREHOUSE_ARM))!;
    expect(f.remediation.proposedChange).toContain(BICEP_PATH);
    expect(f.remediation.proposedChange).toMatch(/merged is not deployed/);
    expect(f.remediation.mutatesAzure).toBe(false);
  });

  it('confidence is MEDIUM, because the absent side could be an extraction gap', () => {
    const f = result.findings.find((x) => x.subjects[0] === azureIdOf(WAREHOUSE_ARM))!;
    expect(f.confidence).toBe('medium');
    expect(f.evidence.notes.join('\n')).toMatch(/INDETERMINATE rather than absent/);
  });

  it('the population reports both resolved edge counts', () => {
    expect(result.population.scope).toMatch(/declared=[1-9]/);
    expect(result.population.scope).toMatch(/configured=[1-9]/);
    expect(result.population.blind).toBe(false);
  });
});

describe('declared-but-dead — VACUITY on the declared side', () => {
  it('a graph with no declared edges emits nothing and says why', () => {
    const graph = buildEdgelessGraph();
    expect(graph.report.edgesByProvenance.declared).toBe(0);
    const result = declaredButDead(graph);
    expect(result.findings).toEqual([]);
    const s = result.skipped.find((x) => x.subject === 'ALL NODES');
    expect(s).toBeDefined();
    expect(s!.reason).toMatch(/ZERO RESOLVED 'declared' edges/);
  });
});

describe('declared-but-dead — VACUITY on the configured side: the dangerous half', () => {
  it('a graph with declared edges but NO resolved configured edges reports nothing', () => {
    // Without this gate, every declared node passes "no inbound configured" and
    // the detector emits a full page of confident, worthless findings. This is
    // the arm that produces output rather than silence, which is why it needs its
    // own check rather than sharing one with the declared side.
    const graph = buildFixtureGraph({
      consoleEnvOverride: [{ name: 'LOOM_BROKER_URL', value: '' }],
    });
    expect(graph.report.edgesByProvenance.declared).toBeGreaterThan(0);
    expect(graph.edges.filter((e) => e.provenance === 'configured' && e.resolution === 'resolved')).toHaveLength(0);

    const result = declaredButDead(graph);
    expect(result.findings).toEqual([]);
    const s = result.skipped.find((x) => x.subject === 'ALL NODES');
    expect(s).toBeDefined();
    expect(s!.reason).toMatch(/ZERO RESOLVED 'configured' edges/);
  });

  it('and direct-lake WOULD have been reported without the gate — proving the gate does work', () => {
    // The control for the control. In that same graph direct-lake has a resolved
    // declared edge and no configured edge, so it meets the raw predicate exactly.
    // The only thing keeping it out of the output is the vacuity gate.
    const graph = buildFixtureGraph({ consoleEnvOverride: [{ name: 'LOOM_BROKER_URL', value: '' }] });
    expect(graph.inboundEdges(DIRECTLAKE_ID, 'declared').result.length).toBeGreaterThan(0);
    expect(graph.inboundEdges(DIRECTLAKE_ID, 'configured').result).toHaveLength(0);
    expect(DIRECTLAKE_FQDN).toBeTruthy();
  });
});
