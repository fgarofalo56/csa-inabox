/**
 * OWNED / OBSERVED / INDETERMINATE — the ownership verdict as a first-class
 * distinction (#4255 W3).
 *
 * ── WHAT THE OPERATOR ACTUALLY SAW, AND WHAT THIS FIXES ────────────────────
 * `loom-risingwave` (Loom's) and `forzelite-dev-pgdb` (not Loom's) rendered
 * IDENTICALLY on the Brain surface, because the only thing the wire carried
 * was `ownershipConfirmed: boolean` and a boolean cannot hold three states. It
 * collapsed "the tag is absent — this is someone else's, visible but not ours
 * to touch" and "the tags could NOT be read" into one indistinguishable
 * `false`.
 *
 * ── WHAT THIS DOES *NOT* DO — the assertion that matters most ──────────────
 * It does NOT widen what ownership MEANS. The signal is still exactly one tag,
 * `loom-estate-id`, whose value names the estate. RG name is still never read.
 * `CSA_Loom` / `csa-loom` / `loom-next-level` / `loom-band` / `loom-item`
 * still confer NOTHING. The specs under "the verdict widens nothing" are the
 * enforcement of that, and they are written so that widening the key — the
 * obvious, tempting "fix" for a zero-owned estate — turns them red.
 *
 * ── THE COHERENCE SPEC IS THE ANTI-DRIFT CONTROL ───────────────────────────
 * A second implementation of "is this Loom's" is exactly how two answers about
 * one resource appear. So the suite asserts, ROW BY ROW, that
 * `classifyResourceOwnership` says `owned` for precisely the rows on which
 * `extractFromResourceGraph` emits an `owns` edge — over a fixture containing
 * owned, observed, foreign and indeterminate rows, so the equivalence is
 * tested in all four directions rather than asserted over a uniform set.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyResourceOwnership,
  extractFromResourceGraph,
  LOOM_ESTATE_TAG_KEY,
  readEstateTag,
  tallyOwnershipVerdicts,
  type ResourceGraphRow,
} from '@/lib/brain/graph';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import {
  appId,
  BLOG_ID,
  BROKER_ID,
  collection,
  containerAppRow,
  estateRows,
  SUB_A,
  SUB_B,
} from '../ui/estate-fixture';

const ESTATE = 'loom-estate-under-test';
const OTHER_ESTATE = 'someone-elses-loom';

/** A mixed estate: owned, observed, foreign-estate and indeterminate rows. */
function mixedRows(): ResourceGraphRow[] {
  return [
    ...estateRows({ ownershipTag: ESTATE }),
    // Another Loom estate's console, sharing a subscription. Tagged — but NOT
    // ours. This row is why the verdict is scoped by VALUE and not by presence.
    containerAppRow({
      name: 'other-loom-console',
      sub: SUB_B,
      rg: 'rg-other',
      minReplicas: 1,
      tags: { [LOOM_ESTATE_TAG_KEY]: OTHER_ESTATE },
    }),
    // The operator's own service. Untagged, readable — OBSERVED.
    containerAppRow({ name: 'forzelite-dev-pgdb', sub: SUB_B, rg: 'rg-forzelite', minReplicas: 1, tags: {} }),
    // Tags unreadable — INDETERMINATE, never "not Loom's".
    containerAppRow({ name: 'sentinel-api', sub: SUB_B, rg: 'rg-sentinel', minReplicas: 1, tags: null }),
  ];
}

// ---------------------------------------------------------------------------
// The verdict itself
// ---------------------------------------------------------------------------

describe('classifyResourceOwnership — three states, one signal', () => {
  it('the estate tag naming THIS estate is owned', () => {
    expect(classifyResourceOwnership({ tags: { [LOOM_ESTATE_TAG_KEY]: ESTATE } }, ESTATE)).toBe(
      'owned',
    );
  });

  it('an ABSENT tag is observed — visible, not ours to touch', () => {
    expect(classifyResourceOwnership({ tags: {} }, ESTATE)).toBe('observed');
    expect(classifyResourceOwnership({ tags: { env: 'prod', owner: 'someone' } }, ESTATE)).toBe(
      'observed',
    );
  });

  it("ANOTHER estate's tag is observed, never owned", () => {
    expect(
      classifyResourceOwnership({ tags: { [LOOM_ESTATE_TAG_KEY]: OTHER_ESTATE } }, ESTATE),
    ).toBe('observed');
  });

  it('UNREADABLE tags are indeterminate — NOT "no tags", NOT "not ours"', () => {
    expect(classifyResourceOwnership({ tags: null }, ESTATE)).toBe('indeterminate');
    expect(classifyResourceOwnership({ tags: undefined }, ESTATE)).toBe('indeterminate');
  });

  it('an EMPTY tag value confers nothing', () => {
    expect(classifyResourceOwnership({ tags: { [LOOM_ESTATE_TAG_KEY]: '   ' } }, ESTATE)).toBe(
      'observed',
    );
  });

  it('reads the key case-insensitively, as Azure does', () => {
    expect(classifyResourceOwnership({ tags: { 'LOOM-Estate-Id': ESTATE } }, ESTATE)).toBe('owned');
    expect(readEstateTag({ 'LOOM-ESTATE-ID': ESTATE })).toBe(ESTATE);
  });
});

describe('the verdict widens NOTHING — the tag is still the only signal', () => {
  it('CSA_Loom / csa-loom / loom-next-level / loom-band confer nothing', () => {
    for (const tags of [
      { CSA_Loom: 'true' },
      { 'csa-loom': 'true' },
      { 'loom-next-level': 'yes' },
      { 'loom-band': 'gold' },
    ]) {
      expect(classifyResourceOwnership({ tags }, ESTATE)).toBe('observed');
    }
  });

  it('loom-item confers nothing — it names an ITEM, never an ESTATE', () => {
    // Measured in `lib/estate/pause-inventory.ts`: one resource carrying
    // `loom-item` was claimed by two unrelated estates.
    expect(classifyResourceOwnership({ tags: { 'loom-item': 'lakehouse-42' } }, ESTATE)).toBe(
      'observed',
    );
  });

  it('RESOURCE-GROUP NAME is never read, in either direction', () => {
    // A real Loom component in an RG containing no "loom" is still OBSERVED
    // until the tag is stamped...
    expect(
      classifyResourceOwnership({ tags: {} }, ESTATE),
    ).toBe('observed');
    // ...and a customer called Loomis is never swept in. The classifier takes
    // NO resource-group argument at all, which is the structural form of this
    // guarantee: there is no parameter through which an RG name could reach it.
    expect(classifyResourceOwnership.length).toBe(2);
  });
});

describe('tallyOwnershipVerdicts', () => {
  it('zero-fills, so an empty input reports zeros rather than absence', () => {
    expect(tallyOwnershipVerdicts([])).toEqual({ owned: 0, observed: 0, indeterminate: 0 });
  });

  it('counts each verdict separately', () => {
    expect(
      tallyOwnershipVerdicts(['owned', 'observed', 'observed', 'indeterminate', 'owned']),
    ).toEqual({ owned: 2, observed: 2, indeterminate: 1 });
  });
});

// ---------------------------------------------------------------------------
// COHERENCE: the verdict and the `owns` edge are ONE answer
// ---------------------------------------------------------------------------

describe('the verdict and the owns edge cannot drift apart', () => {
  const rows = mixedRows();
  const result = extractFromResourceGraph(rows, { estateId: ESTATE });
  const ownedTargets = new Set(result.edges.map((e) => e.targetRef.toLowerCase()));

  it('POPULATION: the fixture contains all four states (otherwise this is blind)', () => {
    const verdicts = rows.map((r) => classifyResourceOwnership({ tags: r.tags }, ESTATE));
    const t = tallyOwnershipVerdicts(verdicts);
    expect(t.owned).toBeGreaterThan(0);
    expect(t.observed).toBeGreaterThan(0);
    expect(t.indeterminate).toBeGreaterThan(0);
    // And a foreign-estate row is present, distinct from a bare untagged one.
    expect(rows.some((r) => r.tags?.[LOOM_ESTATE_TAG_KEY] === OTHER_ESTATE)).toBe(true);
  });

  it('classify says `owned` for EXACTLY the rows that got an owns edge', () => {
    for (const row of rows) {
      const armId = (row.id ?? row.resourceId)!;
      const verdict = classifyResourceOwnership({ tags: row.tags }, ESTATE);
      const hasEdge = ownedTargets.has(armId.toLowerCase());
      expect(
        verdict === 'owned',
        `${armId}: verdict='${verdict}' but owns-edge=${hasEdge}`,
      ).toBe(hasEdge);
    }
  });
});

// ---------------------------------------------------------------------------
// The snapshot carries the verdict and the counts
// ---------------------------------------------------------------------------

describe('the snapshot ships owned/observed/indeterminate as DATA', () => {
  const snap = snapshotFromCollection(collection(mixedRows()), { estateId: ESTATE });

  it('every node carries a verdict', () => {
    expect(snap.nodes.length).toBeGreaterThan(0);
    for (const n of snap.nodes) {
      expect(['owned', 'observed', 'indeterminate']).toContain(n.ownership);
    }
  });

  it("`ownership === 'owned'` iff `ownershipConfirmed` — one answer, not two", () => {
    for (const n of snap.nodes) {
      expect(n.ownership === 'owned', `${n.id}`).toBe(n.ownershipConfirmed);
    }
  });

  it('THE OPERATOR BUG: a Loom app and a non-Loom app no longer read identically', () => {
    const broker = snap.nodes.find((n) => n.id === BROKER_ID)!;
    const blog = snap.nodes.find((n) => n.id === BLOG_ID)!;
    const forzelite = snap.nodes.find((n) => n.displayName === 'forzelite-dev-pgdb')!;
    expect(broker.ownership).toBe('owned');
    // `blog-app`'s tags are unreadable in the fixture — indeterminate, and that
    // is a DIFFERENT statement from forzelite's readable-and-untagged.
    expect(blog.ownership).toBe('indeterminate');
    expect(forzelite.ownership).toBe('observed');
    // The three are now distinguishable, which is the whole workstream.
    expect(new Set([broker.ownership, blog.ownership, forzelite.ownership]).size).toBe(3);
  });

  it("another Loom estate's console is OBSERVED, not owned", () => {
    const other = snap.nodes.find((n) => n.displayName === 'other-loom-console')!;
    expect(other.ownership).toBe('observed');
    expect(other.ownershipConfirmed).toBe(false);
  });

  it('the counts partition the examined population exactly', () => {
    const { byVerdict, examined } = snap.ownership;
    expect(byVerdict.owned + byVerdict.observed + byVerdict.indeterminate).toBe(examined);
    // POPULATION: all three buckets are non-empty, so the sum is not trivially
    // satisfied by one bucket holding everything.
    expect(byVerdict.owned).toBeGreaterThan(0);
    expect(byVerdict.observed).toBeGreaterThan(0);
    expect(byVerdict.indeterminate).toBeGreaterThan(0);
  });

  it('`byVerdict.owned` equals the owns-EDGE count — the tag and the edge agree', () => {
    expect(snap.ownership.byVerdict.owned).toBe(snap.ownership.confirmed);
  });

  it('the note names the observed split so a surface can quote it', () => {
    expect(snap.ownership.note).toContain('OBSERVED ONLY');
    expect(snap.ownership.blind).toBe(false);
  });
});

describe('the measured state of the estate TODAY: nothing carries the tag', () => {
  const snap = snapshotFromCollection(collection(estateRows()), { estateId: ESTATE });

  it('reports zero owned, and does NOT call the untagged resources indeterminate', () => {
    expect(snap.ownership.byVerdict.owned).toBe(0);
    expect(snap.ownership.blind).toBe(true);
    // The distinction survives the all-zero case: the readable-but-untagged
    // rows are OBSERVED, and only the genuinely unreadable one is
    // indeterminate. Collapsing them here is exactly the defect being fixed.
    expect(snap.ownership.byVerdict.observed).toBeGreaterThan(0);
    expect(snap.ownership.byVerdict.indeterminate).toBe(1);
  });

  it('an estate-wide report still includes every subscription', () => {
    // PRP §1 decision 4: reports cover all subscriptions; ownership only scopes
    // what may be RECOMMENDED. A verdict of `observed` must not remove a node.
    expect(snap.nodes.some((n) => n.subscriptionId === SUB_B)).toBe(true);
    expect(snap.nodes.some((n) => n.id === appId(SUB_A, 'loom-capacity-broker').toLowerCase() || n.id === BROKER_ID)).toBe(true);
  });
});
