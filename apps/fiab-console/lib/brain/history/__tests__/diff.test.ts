/**
 * THE DIFF — #3935's acceptance case and the classification rules around it.
 *
 * Acceptance, verbatim: *"Two graph versions diff correctly, with a fixture
 * where exactly one edge is added and exactly one removed."* That is the first
 * describe block, and it asserts EXACTLY — not `toContain`. A diff that returned
 * everything would satisfy a containment assertion, and this repo has shipped
 * guards that pass by returning everything.
 *
 * The rest of the file is about classification, because a diff that finds the
 * right elements and files them under the wrong heading is still wrong:
 *
 *   an empty wire GAINING an endpoint    -> changed, NOT add + remove
 *   a wire moving to a different target  -> changed, NOT add + remove
 *   a private endpoint going public      -> a node change, surfaced by
 *                                           publicExposureGained
 *   a provenance one side never collected -> excluded and NAMED, never reported
 *                                            as a mass addition or removal
 */

import { describe, it, expect } from 'vitest';
import {
  diffVersions,
  edgeProvenanceChanged,
  isSemanticallyEmpty,
  publicExposureGained,
  wireKey,
} from '../diff';
import { GraphVersionIntegrityError } from '../model';
import {
  BASELINE,
  cloneVersion,
  fqdnOf,
  nodeIdOf,
  rebuildVersion,
  versionFrom,
  type EstateSpec,
} from './fixtures';

const T0 = '2026-08-24T09:00:00.000Z';
const T1 = '2026-08-24T11:00:00.000Z';

describe('acceptance — exactly one edge added, exactly one removed', () => {
  // Same four apps, same ownership, same scale. The ONLY change is that the
  // console stops wiring loom-direct-lake and starts wiring loom-scratch.
  const HEAD: EstateSpec = {
    ...BASELINE,
    wires: [
      { onApp: 'loom-console', envVar: 'LOOM_BROKER_URL', value: '', boundTo: 'loom-capacity-broker' },
      {
        onApp: 'loom-console',
        envVar: 'LOOM_SCRATCH_URL',
        value: `https://${fqdnOf('loom-scratch')}`,
        boundTo: 'loom-scratch',
      },
    ],
  };

  const base = versionFrom(BASELINE, T0);
  const head = versionFrom(HEAD, T1);
  const d = diffVersions(base, head);

  it('reports exactly one added edge, and it is the new wire', () => {
    expect(d.edgesAdded).toHaveLength(1);
    expect(d.edgesAdded[0].evidence.symbol).toBe('LOOM_SCRATCH_URL');
    expect(d.edgesAdded[0].to).toBe(nodeIdOf('loom-scratch'));
    expect(d.edgesAdded[0].resolution).toBe('resolved');
  });

  it('reports exactly one removed edge, and it is the retired wire', () => {
    expect(d.edgesRemoved).toHaveLength(1);
    expect(d.edgesRemoved[0].evidence.symbol).toBe('LOOM_DIRECTLAKE_URL');
    expect(d.edgesRemoved[0].to).toBe(nodeIdOf('loom-direct-lake'));
  });

  it('reports NOTHING else — the control estate is untouched', () => {
    expect(d.nodesAdded).toEqual([]);
    expect(d.nodesRemoved).toEqual([]);
    expect(d.nodesChanged).toEqual([]);
    expect(d.edgesChanged).toEqual([]);
    expect(d.identical).toBe(false);
    expect(isSemanticallyEmpty(d)).toBe(false);
  });

  it('the empty LOOM_BROKER_URL wire is carried across UNCHANGED', () => {
    // It exists in both versions and is in none of the six lists. That is what
    // makes "exactly one added, exactly one removed" a real measurement: the
    // dangling wire is a third edge that the diff had to correctly ignore.
    const ids = [
      ...d.edgesAdded.map((e) => e.id),
      ...d.edgesRemoved.map((e) => e.id),
      ...d.edgesChanged.map((c) => c.after.id),
    ];
    const brokerWire = head.content.edges.find((e) => e.evidence.symbol === 'LOOM_BROKER_URL');
    expect(brokerWire).toBeDefined();
    expect(brokerWire?.resolution).toBe('dangling');
    expect(ids).not.toContain(brokerWire?.id);
  });

  it('reports the population — versions retained, nodes and edges per version', () => {
    expect(d.population.versionsExamined).toBe(2);
    expect(d.population.blind).toBe(false);
    expect(d.population.nodesPerVersion).toEqual([base.counts.nodes, head.counts.nodes]);
    expect(d.population.edgesPerVersion).toEqual([base.counts.edges, head.counts.edges]);
    expect(d.population.nodesPerVersion.every((n) => n > 0)).toBe(true);
  });
});

describe('classification — a persisting wire that CHANGED is not add + remove', () => {
  it('an empty wire gaining an endpoint is reported as CHANGED', () => {
    const filled: EstateSpec = {
      ...BASELINE,
      wires: BASELINE.wires.map((w) =>
        w.envVar === 'LOOM_BROKER_URL'
          ? { ...w, value: `https://${fqdnOf('loom-capacity-broker')}` }
          : w,
      ),
    };
    const d = diffVersions(versionFrom(BASELINE, T0), versionFrom(filled, T1));

    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesChanged).toHaveLength(1);

    const c = d.edgesChanged[0];
    expect(c.before.resolution).toBe('dangling');
    expect(c.after.resolution).toBe('resolved');
    expect(c.after.to).toBe(nodeIdOf('loom-capacity-broker'));

    const fields = Object.fromEntries(c.changes.map((f) => [f.field, `${f.before} -> ${f.after}`]));
    expect(fields['resolution']).toBe('dangling -> resolved');
    expect(fields['value.class']).toBe('empty -> nonempty');
    // The id also changed (it embeds the target) — which is precisely why
    // pairing by id would have split this into an addition and a removal.
    expect(c.before.id).not.toBe(c.after.id);
    expect(wireKey(c.before)).toBe(wireKey(c.after));
  });

  it('a live wire being EMPTIED is reported as CHANGED, in the other direction', () => {
    const emptied: EstateSpec = {
      ...BASELINE,
      wires: BASELINE.wires.map((w) =>
        w.envVar === 'LOOM_DIRECTLAKE_URL' ? { ...w, value: '' } : w,
      ),
    };
    const d = diffVersions(versionFrom(BASELINE, T0), versionFrom(emptied, T1));
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesChanged).toHaveLength(1);
    const fields = d.edgesChanged[0].changes.map((f) => f.field);
    expect(fields).toContain('resolution');
    expect(fields).toContain('value.class');
  });

  it('a wire repointed at a different app is CHANGED, not add + remove', () => {
    const repointed: EstateSpec = {
      ...BASELINE,
      wires: BASELINE.wires.map((w) =>
        w.envVar === 'LOOM_DIRECTLAKE_URL'
          ? { ...w, value: `https://${fqdnOf('loom-scratch')}` }
          : w,
      ),
    };
    const d = diffVersions(versionFrom(BASELINE, T0), versionFrom(repointed, T1));
    expect(d.edgesAdded).toEqual([]);
    expect(d.edgesRemoved).toEqual([]);
    expect(d.edgesChanged).toHaveLength(1);
    expect(d.edgesChanged[0].after.to).toBe(nodeIdOf('loom-scratch'));
  });
});

describe('node changes', () => {
  it('a private endpoint going public is surfaced by publicExposureGained', () => {
    const exposed: EstateSpec = {
      ...BASELINE,
      apps: BASELINE.apps.map((a) =>
        a.name === 'loom-capacity-broker' ? { ...a, external: true } : a,
      ),
    };
    const d = diffVersions(versionFrom(BASELINE, T0), versionFrom(exposed, T1));
    const exposedNodes = publicExposureGained(d);
    expect(exposedNodes).toHaveLength(1);
    expect(exposedNodes[0].id).toBe(nodeIdOf('loom-capacity-broker'));

    // The control: the console was ALREADY external in both versions and must
    // not appear. Without it, a `publicExposureGained` that returned every
    // external node would pass.
    expect(exposedNodes.map((n) => n.id)).not.toContain(nodeIdOf('loom-console'));
  });

  it('scale becoming UNMEASURED is not reported as scaling to zero', () => {
    const base = versionFrom(BASELINE, T0);
    const head = cloneVersion(versionFrom(BASELINE, T1));
    const idx = head.content.nodes.findIndex((n) => n.id === nodeIdOf('loom-capacity-broker'));
    const patched = { ...head.content.nodes[idx], scale: null };
    const nodes = [...head.content.nodes];
    nodes[idx] = patched;
    // Rebuild the record so it verifies — an unverifiable version is refused,
    // which is a different test.
    const rebuilt = rebuildVersion(head, { ...head.content, nodes });

    const d = diffVersions(base, rebuilt);
    expect(d.nodesChanged).toHaveLength(1);
    const field = d.nodesChanged[0].changes.find((f) => f.field === 'scale.minReplicas');
    expect(field?.before).toBe('2');
    expect(field?.after).toBe('(not set)');
    expect(field?.after).not.toBe('0');
  });

  it('a node that disappears is reported as removed', () => {
    const shrunk: EstateSpec = {
      ...BASELINE,
      apps: BASELINE.apps.filter((a) => a.name !== 'loom-scratch'),
    };
    const d = diffVersions(versionFrom(BASELINE, T0), versionFrom(shrunk, T1));
    expect(d.nodesRemoved.map((n) => n.id)).toEqual([nodeIdOf('loom-scratch')]);
    expect(d.nodesAdded).toEqual([]);
  });
});

describe('coverage — a provenance one side never collected is EXCLUDED and named', () => {
  const WITH_DECLARED: EstateSpec = {
    ...BASELINE,
    declaredWires: [
      { onApp: 'loom-console', toApp: 'loom-capacity-broker', envVar: 'LOOM_BROKER_URL' },
    ],
  };

  it('does not report a whole uncollected provenance as added', () => {
    const base = versionFrom(BASELINE, T0, { collectedProvenances: ['configured', 'owns'] });
    const head = versionFrom(WITH_DECLARED, T1, {
      collectedProvenances: ['configured', 'owns', 'declared'],
    });
    const d = diffVersions(base, head);

    expect(d.comparedProvenances).toEqual(['configured', 'owns']);
    expect(d.provenancesNotComparable).toEqual(['declared']);
    expect(d.edgesAdded.filter((e) => e.provenance === 'declared')).toEqual([]);
    expect(d.notes.join(' ')).toContain('EXCLUDED from this comparison');
  });

  it('does not report a whole uncollected provenance as REMOVED in reverse either', () => {
    const base = versionFrom(WITH_DECLARED, T0, {
      collectedProvenances: ['configured', 'owns', 'declared'],
    });
    const head = versionFrom(BASELINE, T1, { collectedProvenances: ['configured', 'owns'] });
    const d = diffVersions(base, head);
    expect(d.edgesRemoved.filter((e) => e.provenance === 'declared')).toEqual([]);
    expect(d.provenancesNotComparable).toEqual(['declared']);
  });

  it('when BOTH collected it, a declared wire IS compared', () => {
    const base = versionFrom(BASELINE, T0, {
      collectedProvenances: ['configured', 'owns', 'declared'],
    });
    const head = versionFrom(WITH_DECLARED, T1, {
      collectedProvenances: ['configured', 'owns', 'declared'],
    });
    const d = diffVersions(base, head);
    expect(d.provenancesNotComparable).toEqual([]);
    // The declared wire is genuinely new here, and it is reported.
    expect(d.edgesAdded.filter((e) => e.provenance === 'declared')).toHaveLength(1);
  });
});

describe('edgeProvenanceChanged — a declared wire becoming a live one', () => {
  it('reports the relation that gained `configured`', () => {
    const DECLARED_ONLY: EstateSpec = {
      apps: BASELINE.apps,
      wires: [
        {
          onApp: 'loom-console',
          envVar: 'LOOM_DIRECTLAKE_URL',
          value: `https://${fqdnOf('loom-direct-lake')}`,
          boundTo: 'loom-direct-lake',
        },
      ],
      declaredWires: [
        { onApp: 'loom-console', toApp: 'loom-capacity-broker', envVar: 'LOOM_BROKER_URL' },
      ],
    };
    const NOW_CONFIGURED: EstateSpec = {
      ...DECLARED_ONLY,
      wires: [
        ...DECLARED_ONLY.wires,
        {
          onApp: 'loom-console',
          envVar: 'LOOM_BROKER_URL',
          value: `https://${fqdnOf('loom-capacity-broker')}`,
          boundTo: 'loom-capacity-broker',
        },
      ],
    };
    const provs = ['configured', 'owns', 'declared'] as const;
    const base = versionFrom(DECLARED_ONLY, T0, { collectedProvenances: provs });
    const head = versionFrom(NOW_CONFIGURED, T1, { collectedProvenances: provs });

    const changes = edgeProvenanceChanged(base, head);
    const brokerRelation = changes.find(
      (c) => c.from === nodeIdOf('loom-console') && c.to === nodeIdOf('loom-capacity-broker'),
    );
    expect(brokerRelation).toBeDefined();
    expect(brokerRelation?.gained).toEqual(['configured']);
    expect(brokerRelation?.lost).toEqual([]);

    // The control: the direct-lake relation was configured in BOTH versions and
    // must not appear at all.
    expect(
      changes.find(
        (c) => c.from === nodeIdOf('loom-console') && c.to === nodeIdOf('loom-direct-lake'),
      ),
    ).toBeUndefined();
  });
});

describe('fail closed — a corrupt version is REFUSED, never diffed', () => {
  it('a TRUNCATED base throws instead of reporting mass deletion', () => {
    const base = cloneVersion(versionFrom(BASELINE, T0));
    const head = versionFrom(BASELINE, T1);
    const truncated = {
      ...base,
      content: { ...base.content, nodes: base.content.nodes.slice(0, 1) },
    };

    let threw: unknown = null;
    try {
      diffVersions(truncated, head);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(GraphVersionIntegrityError);
    expect((threw as GraphVersionIntegrityError).check).toBe('node-count');
    expect((threw as Error).message).toContain('REFUSED');
  });

  it('a truncated HEAD throws too — the check is not one-sided', () => {
    const base = versionFrom(BASELINE, T0);
    const head = cloneVersion(versionFrom(BASELINE, T1));
    const truncated = {
      ...head,
      content: { ...head.content, edges: head.content.edges.slice(0, 1) },
    };
    expect(() => diffVersions(base, truncated)).toThrow(GraphVersionIntegrityError);
  });
});

describe('a version diffed against ITSELF is blind, not clean', () => {
  it('reports blind so an empty result is not read as a clean estate', () => {
    const v = versionFrom(BASELINE, T0);
    const d = diffVersions(v, v);
    expect(isSemanticallyEmpty(d)).toBe(true);
    expect(d.population.blind).toBe(true);
    expect(d.population.versionsExamined).toBe(1);
    expect(d.population.scope).toContain('ITSELF');
  });
});
