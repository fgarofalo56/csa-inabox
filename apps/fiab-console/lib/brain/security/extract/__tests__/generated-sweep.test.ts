/**
 * THE HAND-OFF PATH — the committed artifact, through the real loader, into the
 * real sweep.
 *
 * ── WHY THIS SPEC IS SHAPED THIS WAY ─────────────────────────────────────
 *
 * It deliberately constructs NOTHING. It imports the artifact that is actually
 * committed, calls the loader the runtime actually calls, and runs the registry
 * the route actually runs. Every other spec in this package builds a fixture and
 * asserts a predicate over it; this one exists because those specs, however many
 * of them pass, cannot tell you the pipeline is connected.
 *
 * That is not a hypothetical. A review of the sibling synapses lane (#3992)
 * severed the risk overlay from every node and edge in `buildFlow` and the entire
 * 193-test suite stayed GREEN — because the canvas spec mounted the node
 * component directly with a hand-built `data.synapse` and never exercised the
 * code that decides whether the mark is handed over at all. A test that
 * CONSTRUCTS the thing it is meant to verify was PRODUCED proves nothing about
 * production.
 *
 * So: no fixture graph, no hand-built artifact, no injected findings. If the
 * generator stops emitting nodes, if the loader stops resolving the JSON, if the
 * artifact goes stale, or if a detector stops firing, this spec goes red.
 */

import { describe, expect, it } from 'vitest';
import {
  runSecuritySweep,
  securityFindingsOf,
  type Finding,
} from '../../index';
import { extractedArtifact, loadExtractedSecurityGraph } from '../runtime';

const artifact = extractedArtifact();

describe('extracted security graph — the committed artifact', () => {
  it('exists, and was produced by an extraction rather than hand-authored', () => {
    expect(artifact).not.toBeNull();
    expect(artifact?.graph.source).toBe('extracted');
  });

  it('carries a NON-TRIVIAL node population', () => {
    // A floor, not an equality: the tree changes and this must not become a
    // churn magnet. But it must be far enough above zero that an extractor which
    // silently stopped emitting cannot pass.
    expect(artifact!.graph.nodes.length).toBeGreaterThan(100);
  });

  it('accounts for EVERY node in the estate join, with both lanes populated', () => {
    const { painted, unjoined } = artifact!.join;
    expect(painted.length + unjoined.length).toBe(artifact!.graph.nodes.length);

    // Neither lane may be silently zero. `painted` zero would mean nothing
    // reaches the estate picture; `unjoined` zero would mean the extractor
    // claims every CI script maps to a deployed resource, which is false.
    expect(painted.length).toBeGreaterThan(0);
    expect(unjoined.length).toBeGreaterThan(0);
  });

  it('paints console routes onto loom-console and leaves CI scripts unjoined', () => {
    const consoleRoute = artifact!.join.painted.find((p) =>
      p.codeModuleId.startsWith('code:apps/fiab-console/app/api/'),
    );
    expect(consoleRoute?.deployedAs).toBe('loom-console');

    const ciScript = artifact!.join.unjoined.find((u) =>
      u.codeModuleId.startsWith('code:scripts/'),
    );
    expect(ciScript).toBeDefined();
    // The reason must be a reason, not a placeholder.
    expect(ciScript!.reason.length).toBeGreaterThan(40);
  });
});

describe('the loader hands a usable graph to the detectors', () => {
  it('resolves the committed artifact as AVAILABLE', () => {
    const source = loadExtractedSecurityGraph();
    expect(source.available).toBe(true);
  });

  it('runs the real registry over it and produces real findings', () => {
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);

    const sweep = runSecuritySweep(source.graph);

    // Every detector must report a coherent population — `detectorResult()`
    // throws otherwise, so reaching here already proves the graph satisfies the
    // population contract over 905+ nodes.
    expect(sweep.perDetector.length).toBe(9);

    const security = sweep.findings.filter((f) => f.findingClass !== 'POP-population-integrity');
    expect(security.length).toBeGreaterThan(0);
  });

  it('fires C1 on a withTenantAdmin-gated route that point-reads a caller-named id', () => {
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    const sweep = runSecuritySweep(source.graph);

    const c1 = sweep.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge');
    expect(c1.length).toBeGreaterThan(0);

    // The specific live instance the extractor was built to surface: this route
    // is `withTenantAdmin`-gated and performs `c.item(id, id).read()` against a
    // container with no tenant partition. `withTenantAdmin` does not contain the
    // token `isTenantAdmin(`, so the repo's tid-boundary guard cannot see it.
    const trace = c1.find((f) => f.evidence.nodeIds.some((n) => n.includes('copilot/sessions/[id]/trace')));
    expect(trace).toBeDefined();
  });

  it('reports the six unextracted node kinds as EMPTY POPULATIONS, not as clean', () => {
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    const sweep = runSecuritySweep(source.graph);

    const empties = sweep.findings.filter(
      (f) => f.findingClass === 'POP-population-integrity' && f.id.endsWith(':population:empty'),
    );

    // C2, C5, C6, C7, C8, C9 have no extractor yet. Each MUST say so out loud
    // rather than contributing a silent zero to the risk count.
    expect(empties.length).toBe(6);
    for (const finding of empties) {
      expect(finding.title).toContain('EMPTY population');
      expect(finding.severity).toBe('high');
    }
  });

  it('never emits a remediation that could execute — everything is DRAFT data', () => {
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    const sweep = runSecuritySweep(source.graph);

    for (const finding of sweep.findings as readonly Finding[]) {
      expect(finding.remediation.requiresHumanApproval).toBe(true);
      for (const value of Object.values(finding.remediation)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});

describe('what the sweep actually measured — recorded, not asserted away', () => {
  it('reports coverage of 1.0 with no incomplete detectors', () => {
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    const sweep = runSecuritySweep(source.graph);

    // ratio < 1 on ANY detector is a P0 signal per taxonomy §11.5.
    expect(sweep.coverage.incompleteDetectors).toEqual([]);
    expect(sweep.coverage.judged).toBe(sweep.coverage.candidates);
    expect(sweep.coverage.candidates).toBeGreaterThan(0);
  });

  it('every security finding names at least one node that exists in the graph', () => {
    const source = loadExtractedSecurityGraph();
    if (!source.available) throw new Error(`graph unavailable: ${source.reason}`);
    const sweep = runSecuritySweep(source.graph);
    const ids = new Set(source.graph.nodes.map((n) => n.id));

    for (const detector of sweep.perDetector) {
      for (const finding of securityFindingsOf(detector)) {
        expect(finding.evidence.nodeIds.length).toBeGreaterThan(0);
        for (const nodeId of finding.evidence.nodeIds) expect(ids.has(nodeId)).toBe(true);
      }
    }
  });
});
