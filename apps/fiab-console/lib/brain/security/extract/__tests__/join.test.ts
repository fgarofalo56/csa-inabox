/**
 * THE JOIN — and the proof that its duplicated canonicalization is EQUAL.
 *
 * `join.ts#codeModuleJoinKey` re-implements `lib/brain/graph/node-id.ts#codeModuleNodeId`
 * so the extract package has no value imports outside its own directory, which is
 * what keeps the build step a plain `tsc` invocation. Duplicating a rule is only
 * acceptable when the copies are PROVEN equal, so this spec imports the REAL
 * implementation and diffs them over the exact inputs `node-id.ts` says it exists
 * to normalise: Windows backslashes, mixed casing, leading `./`, trailing slash.
 *
 * If either side drifts, this fails — the duplication is measured, not assumed.
 */

import { describe, expect, it } from 'vitest';
import { codeModuleNodeId } from '../../../graph/node-id';
import type { SecurityNode } from '../../substrate';
import { assertJoinCoversGraph, buildJoin, codeModuleJoinKey, pathOfNodeId } from '../join';

const PATHS = [
  'apps/fiab-console/app/api/x/route.ts',
  'apps\\fiab-console\\app\\api\\x\\route.ts',
  'Apps/Fiab-Console/App/Api/X/Route.ts',
  './apps/fiab-console/lib/api/route-toolkit.ts',
  'scripts/ci/check-route-guards.mjs/',
  'scripts/ci/deploy-retry.mjs',
];

describe('codeModuleJoinKey is byte-identical to the real codeModuleNodeId', () => {
  for (const path of PATHS) {
    it(`agrees on ${JSON.stringify(path)}`, () => {
      expect(codeModuleJoinKey(path)).toBe(codeModuleNodeId(path));
    });
  }
});

function node(id: string): SecurityNode {
  return {
    id,
    kind: 'authorizer',
    provenance: 'declared',
    label: id,
    facet: {
      kind: 'authorizer',
      fnName: 'x',
      params: [],
      resourceScoped: false,
      callerNamedResourceInputs: [],
      allowPaths: [],
      reachesPrivilegedSink: false,
      privilegedSinkKinds: [],
    },
  };
}

describe('pathOfNodeId', () => {
  it('recovers the source path from a minted id', () => {
    expect(pathOfNodeId('sec:authorizer:apps/fiab-console/app/api/x/route.ts#GET')).toBe(
      'apps/fiab-console/app/api/x/route.ts',
    );
  });

  it('handles a symbol containing colons', () => {
    expect(pathOfNodeId('sec:verdict-call:scripts/ci/a.mjs#GET:enforceCapability:12')).toBe(
      'scripts/ci/a.mjs',
    );
  });
});

describe('buildJoin', () => {
  it('paints a console module onto loom-console', () => {
    const join = buildJoin([node('sec:authorizer:apps/fiab-console/app/api/x/route.ts#GET')]);
    expect(join.painted).toHaveLength(1);
    expect(join.painted[0].deployedAs).toBe('loom-console');
    expect(join.unjoined).toHaveLength(0);
  });

  it('leaves a CI script UNJOINED, with a reason that explains why', () => {
    const join = buildJoin([node('sec:publication:scripts/ci/deploy-retry.mjs#module')]);
    expect(join.painted).toHaveLength(0);
    expect(join.unjoined).toHaveLength(1);
    // Not "unknown" — the reason must say a CI script has no estate presence.
    expect(join.unjoined[0].reason).toContain('GitHub Actions runner');
  });

  it('is TOTAL — every node lands in exactly one bucket', () => {
    const nodes = [
      node('sec:authorizer:apps/fiab-console/app/api/a/route.ts#GET'),
      node('sec:publication:scripts/ci/b.mjs#module'),
      node('sec:authorizer:domains/whatever/c.ts#GET'),
    ];
    const join = buildJoin(nodes);
    expect(join.painted.length + join.unjoined.length).toBe(nodes.length);
    expect(() => assertJoinCoversGraph(join, nodes)).not.toThrow();
  });
});

describe('assertJoinCoversGraph refuses an incoherent join', () => {
  const nodes = [
    node('sec:authorizer:apps/fiab-console/app/api/a/route.ts#GET'),
    node('sec:authorizer:apps/fiab-console/app/api/b/route.ts#GET'),
  ];

  it('THROWS when a node is in neither bucket', () => {
    const join = buildJoin([nodes[0]]);
    expect(() => assertJoinCoversGraph(join, nodes)).toThrow(/neither the painted nor the unjoined/);
  });

  it('THROWS on a duplicate — a padded list restores the total while hiding a gap', () => {
    const join = buildJoin(nodes);
    const padded = { painted: [...join.painted, join.painted[0]], unjoined: join.unjoined };
    expect(() => assertJoinCoversGraph(padded, nodes)).toThrow(/appears twice/);
  });

  it('THROWS when a joined id is absent from the graph', () => {
    const join = buildJoin(nodes);
    expect(() => assertJoinCoversGraph(join, [nodes[0]])).toThrow(/absent from the graph/);
  });
});
