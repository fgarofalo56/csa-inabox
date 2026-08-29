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
import {
  assertJoinCoversGraph,
  buildJoin,
  codeModuleJoinKey,
  NO_ESTATE_PRESENCE,
  pathOfNodeId,
} from '../join';
import { extractedArtifact } from '../runtime';

/**
 * A path table covering everything `node-id.ts` normalises.
 *
 * #4057 — THE REAL FILENAMES ARE BACK, and that reversion is the acceptance test
 * for that issue. These entries used to be deliberately FICTIONAL because
 * `__tests__/spec-imported-scripts-have-no-shebang.test.ts` treated any quoted
 * `scripts/**.mjs` literal inside a spec as an IMPORT of that script, and both
 * `deploy-retry.mjs` and `check-route-guards.mjs` carry a `#!` line — so naming
 * them here pulled two long-standing, correct scripts into that guard's
 * population and failed the vitest suite (measured on PR #4022). The workaround
 * was correct in the moment and corrosive as a precedent: every future spec that
 * legitimately names a script would learn the same dodge.
 *
 * That guard now reads the IMPORT GRAPH, so a path appearing in a fixture table
 * is a mention and not a load. Canonicalization and join bucketing are decided
 * from the path SHAPE and never from whether the file exists, so these could
 * equally be fictional — they are real precisely so this file keeps proving the
 * guard is no longer keyed on string presence.
 */
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
    // #4057 — the real script name, for the reason given at PATHS above.
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

/**
 * NO DEAD ENTRY IN THE NO-ESTATE TABLE.
 *
 * `.github/workflows/` sat in `NO_ESTATE_PRESENCE` for the life of this PR and
 * could never match, because nothing under `.github/` was ever walked. To anyone
 * auditing the join it read as coverage of a scope the extractor did not have —
 * the same overstatement as the scope string it shipped alongside.
 *
 * A prefix that matches nothing in the COMMITTED artifact is therefore a red
 * test: either scan the root, or do not claim a reason for it.
 */
describe('every NO_ESTATE_PRESENCE prefix is live on the committed artifact', () => {
  const artifact = extractedArtifact()!;

  it('has a committed artifact to measure', () => {
    expect(artifact).not.toBeNull();
    expect(artifact.join.unjoined.length).toBeGreaterThan(0);
  });

  for (const [prefix] of NO_ESTATE_PRESENCE) {
    it(`'${prefix}' matches at least one unjoined node`, () => {
      const hits = artifact.join.unjoined.filter((u) =>
        u.codeModuleId.startsWith(`code:${prefix}`),
      );
      expect(hits.length).toBeGreaterThan(0);
    });
  }

  it('does NOT match a prefix that is genuinely absent (control)', () => {
    // Proves the assertions above are watching the PREFIX rather than merely the
    // bucket being non-empty.
    const hits = artifact.join.unjoined.filter((u) =>
      u.codeModuleId.startsWith('code:no/such/root/'),
    );
    expect(hits).toEqual([]);
  });
});
