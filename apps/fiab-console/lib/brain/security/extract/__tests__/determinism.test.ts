/**
 * DETERMINISM — the artifact must not depend on the order files arrived in.
 *
 * ── WHY THIS SPEC EXISTS, MEASURED ───────────────────────────────────────
 *
 * The artifact is COMMITTED, and CI re-runs the extractor to prove the committed
 * bytes still describe the tree. That comparison is over the GRAPH, so node
 * ORDER is part of the artifact's identity.
 *
 * The CLI walks the filesystem, and `readdirSync` returns entries in an
 * OS-dependent order. Measured on PR #4022's first CI run: the artifact was
 * generated on Windows and the drift gate FAILED on ubuntu-latest with identical
 * file CONTENT, because the two platforms enumerated the same directories
 * differently — the first divergence being where a bracketed dynamic segment
 * (`reviews/[id]/…`) sorts relative to its sibling (`reviews/route.ts`).
 *
 * A drift gate that fails on every CI run for a correct artifact is worse than
 * no gate: it trains everyone to ignore it. So `buildSecurityGraphArtifact`
 * sorts its inputs, and this spec proves the sort is what makes the output
 * stable rather than the caller happening to hand them over in order.
 */

import { describe, expect, it } from 'vitest';
import { buildSecurityGraphArtifact } from '../build';
import type { SourceFile } from '../types';

const NOW = new Date('2026-08-24T12:00:00.000Z');

/** A small corpus that exercises every emitted node kind. */
const FILES: SourceFile[] = [
  {
    path: 'apps/fiab-console/app/api/alpha/[id]/route.ts',
    text: `import { withTenantAdmin } from '@/lib/api/route-toolkit';
export const GET = withTenantAdmin<{ id: string }>(async (req, { params }) => {
  const { id } = await params;
  const c = await container();
  const { resource } = await c.item(id, id).read<{ a?: string }>();
  return ok(resource);
});`,
  },
  {
    path: 'apps/fiab-console/app/api/beta/route.ts',
    text: `export const POST = async (req) => {
  const gate = await enforceCapability(s, 'x');
  if (gate) return gate;
  await c.items.upsert({ v: 1 });
  return ok();
};`,
  },
  {
    path: 'apps/fiab-console/app/api/gamma/[id]/nested/route.ts',
    text: `import { withTenantAdmin } from '@/lib/api/route-toolkit';
export const DELETE = withTenantAdmin(async (req, { params }) => {
  const { id } = await params;
  await c.item(id, id).delete();
  return ok();
});`,
  },
  {
    path: 'scripts/ci/alpha-guard.mjs',
    text: `import { spawnSync } from 'node:child_process';
spawnSync('az', ['account', 'show'], { stdio: ['inherit', 'inherit', 'pipe'] });
console.log('done');`,
  },
  {
    path: 'scripts/ci/beta-guard.mjs',
    text: `process.stdout.write(redact(payload));
process.stderr.write(String(process.env.SOME_TOKEN));`,
  },
];

function build(files: readonly SourceFile[]) {
  return buildSecurityGraphArtifact({
    files,
    // Declared because the artifact's scope string is DERIVED from this, not
    // written beside it — see `build.ts`. The fixture only carries `scripts/`
    // publication files, and a root that matched nothing throws, so naming
    // `.github/` here would (correctly) fail.
    publicationRoots: ['scripts/'],
    routeGuardSource: null,
    commit: null,
    now: NOW,
  });
}

/** Compare everything that is part of the artifact's identity. */
function identity(a: ReturnType<typeof build>): string {
  return JSON.stringify({ graph: a.graph, join: a.join });
}

describe('buildSecurityGraphArtifact is order-independent', () => {
  const canonical = build(FILES);

  it('produces the same graph and join from REVERSED input order', () => {
    const reversed = build([...FILES].reverse());
    expect(identity(reversed)).toBe(identity(canonical));
  });

  it('produces the same graph and join from a SHUFFLED input order', () => {
    // A fixed permutation rather than Math.random, so a failure is reproducible.
    const shuffled = [FILES[3], FILES[0], FILES[4], FILES[2], FILES[1]];
    expect(identity(build(shuffled))).toBe(identity(canonical));
  });

  it('produces the same inputs digest regardless of order', () => {
    expect(build([...FILES].reverse()).meta.inputsDigest).toBe(canonical.meta.inputsDigest);
  });

  it('is stable across repeated runs with the same input', () => {
    expect(identity(build(FILES))).toBe(identity(canonical));
  });

  it('treats a CRLF checkout and an LF checkout as the same inputs', () => {
    // Windows checkouts carry CRLF; ubuntu-latest carries LF. Without the
    // normalisation in `inputsDigest` the drift gate would report drift on every
    // CI run for byte-identical content.
    const crlf = FILES.map((f) => ({ ...f, text: f.text.replace(/\n/g, '\r\n') }));
    expect(build(crlf).meta.inputsDigest).toBe(canonical.meta.inputsDigest);
  });
});

describe('the fixture corpus actually exercises what it claims to', () => {
  const artifact = build(FILES);

  it('emits all three extracted node kinds', () => {
    const kinds = new Set(artifact.graph.nodes.map((n) => n.kind));
    expect(kinds.has('authorizer')).toBe(true);
    expect(kinds.has('verdict-call')).toBe(true);
    expect(kinds.has('publication')).toBe(true);
  });

  it('populates BOTH join lanes', () => {
    expect(artifact.join.painted.length).toBeGreaterThan(0);
    expect(artifact.join.unjoined.length).toBeGreaterThan(0);
  });

  it("marks the graph as 'extracted'", () => {
    expect(artifact.graph.source).toBe('extracted');
  });
});
