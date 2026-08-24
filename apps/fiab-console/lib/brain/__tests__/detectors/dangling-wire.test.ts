/**
 * LOOM BRAIN — `dangling-wire`: POSITIVE, NEGATIVE, and the scope decision.
 *
 * The scope decision is the interesting part. This detector deliberately reports
 * only `empty-value` and `missing-resource`, and excludes `unresolved-target` —
 * which on the real graph is 1,504 of 1,741 dangling edges. An exclusion that big
 * has to be VISIBLE, or the detector is quietly answering a narrower question
 * than its name implies. The last describe block is the one that holds it to that.
 */

import { describe, it, expect } from 'vitest';
import { DANGLING_WIRE, REPORTED_REASONS, danglingWire } from '../../detectors';
import {
  BICEP_PATH,
  BROKER_ID,
  CONSOLE_ID,
  DIRECTLAKE_ID,
  RG,
  SUB,
  buildEdgelessGraph,
  buildFixtureGraph,
} from './fixtures';

const GHOST_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-deleted`;

describe('dangling-wire — POSITIVE: the empty wire that is the founding receipt', () => {
  const graph = buildFixtureGraph();
  const result = danglingWire(graph);

  it('reports the empty wires, grouped by their source app', () => {
    expect(result.detector).toBe(DANGLING_WIRE);
    const f = result.findings.find((x) => x.subjects[0] === CONSOLE_ID);
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
    // Both halves: the bicep declaration and the live env var.
    const notes = f!.evidence.notes.join('\n');
    expect(notes).toContain(BICEP_PATH);
    expect(notes).toContain('LOOM_BROKER_URL');
    expect(notes).toContain('empty-value');
  });

  it('names the INTENDED target, so the finding attaches to the abandoned service', () => {
    const f = result.findings.find((x) => x.subjects[0] === CONSOLE_ID)!;
    // The broker is the point of the wire. Without `intendedTo` the finding would
    // be "an app has an empty env var" and the connection to a billing service
    // would be lost.
    expect(f.subjects).toContain(BROKER_ID);
    expect(f.evidence.notes.join('\n')).toContain('intended for');
  });

  it('every edge id in the evidence resolves back to a real edge in the graph', () => {
    for (const f of result.findings) {
      expect(f.evidence.edges.length).toBeGreaterThan(0);
      for (const id of f.evidence.edges) {
        expect(graph.edges.some((e) => e.id === id)).toBe(true);
      }
    }
  });

  it('the remediation names the file and line to change, and is a proposal', () => {
    const f = result.findings.find((x) => x.subjects[0] === CONSOLE_ID)!;
    expect(f.remediation.kind).toBe('proposal');
    expect(f.remediation.mutatesAzure).toBe(false);
    expect(f.remediation.requiresHumanApproval).toBe(true);
    expect(f.remediation.proposedChange).toContain(BICEP_PATH);
  });
});

describe('dangling-wire — NEGATIVE: a graph whose edges all resolve', () => {
  const graph = buildEdgelessGraph();
  const result = danglingWire(graph);

  it('reports nothing when there is nothing dangling', () => {
    expect(graph.report.edgesByResolution.dangling).toBe(0);
    expect(graph.report.edgesByResolution.resolved).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });

  it('and says its subject set was EMPTY rather than implying a clean sweep', () => {
    // Subject is edges here. Zero in-scope edges means `blind` — the honest
    // signal that the detector had nothing to examine, not that it examined
    // everything and found it healthy.
    expect(result.population.subject).toBe('edges');
    expect(result.population.blind).toBe(true);
  });
});

describe('dangling-wire — `missing-resource` is a different finding from `empty-value`', () => {
  const graph = buildFixtureGraph({
    extraConsoleEnv: [{ name: 'LOOM_GHOST_URL', value: GHOST_ARM }],
  });
  const result = danglingWire(graph);

  it('POSITIVE: a wire naming an ARM id that is not in the graph is reported', () => {
    const f = result.findings.find((x) => x.title.includes('not in the graph'));
    expect(f).toBeDefined();
    expect(f!.evidence.notes.join('\n')).toContain('LOOM_GHOST_URL');
  });

  it('at a LOWER severity, because it names what it wanted', () => {
    // An empty wire produced nothing at all; a missing resource at least states
    // its target and may simply be outside the discovery scope.
    const missing = result.findings.find((x) => x.title.includes('not in the graph'))!;
    const empty = result.findings.find((x) => x.title.includes('empty value'))!;
    expect(missing.severity).toBe('medium');
    expect(empty.severity).toBe('high');
  });

  it('and its remediation refuses to claim the resource was deleted', () => {
    const missing = result.findings.find((x) => x.title.includes('not in the graph'))!;
    // R7 — "not in this graph" and "does not exist in Azure" are different claims
    // and only the first was measured.
    expect(missing.remediation.proposedChange).toMatch(
      /not the same as a wire pointing at a resource that does not exist/,
    );
  });
});

describe('dangling-wire — the `unresolved-target` exclusion is VISIBLE, not silent', () => {
  const graph = buildFixtureGraph({
    // A value that looks like a target and matches nothing — the shape that
    // accounts for 1,504 of the 1,741 dangling edges on the real graph.
    extraConsoleEnv: [{ name: 'LOOM_SOMETHING_URL', value: 'some-unknown-service' }],
  });
  const result = danglingWire(graph);

  it('the excluded edges are NOT reported as findings', () => {
    expect(result.findings.every((f) => !f.evidence.notes.join('\n').includes('LOOM_SOMETHING_URL'))).toBe(true);
  });

  it('but the exclusion appears in `skipped` WITH ITS COUNT and its reason', () => {
    // An omission the operator cannot see is indistinguishable from a detector
    // that never looked.
    const s = result.skipped.find((x) => x.subject.includes("'unresolved-target'"));
    expect(s).toBeDefined();
    expect(s!.subject).toMatch(/^\d+ dangling edge\(s\)/);
    expect(s!.reason).toMatch(/EXCLUDED BY SCOPE, not unexamined/);
    // …and it tells the reader how to see them anyway.
    expect(s!.reason).toContain("danglingEdges(graph, 'unresolved-target')");
  });

  it('the population states the scope and the per-reason breakdown', () => {
    expect(result.population.scope).toContain('excluded');
    for (const r of REPORTED_REASONS) expect(result.population.scope).toContain(`${r}=`);
  });
});

describe('dangling-wire — the wired control never appears', () => {
  it('loom-direct-lake is resolved on both sides and is in no finding', () => {
    const graph = buildFixtureGraph();
    const result = danglingWire(graph);
    // Its edges resolve, so it must not be a subject of any dangling finding.
    for (const f of result.findings) {
      expect(f.subjects).not.toContain(DIRECTLAKE_ID);
    }
  });
});
