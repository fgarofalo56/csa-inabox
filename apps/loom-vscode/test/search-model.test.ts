/**
 * Estate-search mapping — merging + ranking `/api/catalog/find` hits across the
 * selected deployments, each hit tagged with the deployment it belongs to.
 *
 * Third MUTATION-PROOF: cross-deployment results are ranked by score DESC.
 * Revert the `b.score - a.score` comparator in search-model.ts and the
 * "highest score first across deployments" test goes RED.
 */
import { describe, it, expect } from 'vitest';
import { mapFindResponse, rankEstateHits, type EstateHit } from '../src/query/search-model';

const hit = (id: string, displayName: string, score: number) => ({
  id,
  workspaceId: 'ws1',
  workspaceName: 'Analytics',
  itemType: 'lakehouse',
  displayName,
  tags: [],
  score,
});

describe('mapFindResponse', () => {
  it('tags every hit with its deployment', () => {
    const out = mapFindResponse('commercial', 'Commercial', { hits: [hit('a', 'Bronze', 50)] }, true);
    expect(out).toHaveLength(1);
    expect(out[0].deploymentId).toBe('commercial');
    expect(out[0].deploymentName).toBe('Commercial');
    expect(out[0].multiDeployment).toBe(true);
  });

  it('drops a malformed row instead of fabricating one', () => {
    const out = mapFindResponse('d', 'D', { hits: [{ id: 'x' } as never, hit('ok', 'Real', 10)] }, false);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ok');
  });

  it('handles an empty / missing envelope', () => {
    expect(mapFindResponse('d', 'D', undefined, false)).toEqual([]);
    expect(mapFindResponse('d', 'D', { hits: [] }, false)).toEqual([]);
  });

  it('defaults a missing score to 0', () => {
    const out = mapFindResponse('d', 'D', { hits: [{ ...hit('a', 'A', 0), score: undefined as never }] }, false);
    expect(out[0].score).toBe(0);
  });
});

describe('rankEstateHits', () => {
  // ── MUTATION-PROOF ────────────────────────────────────────────────────────
  // Highest score first, ACROSS deployments. Revert the `b.score - a.score`
  // comparator → the lower-scored commercial hit sorts first and this fails.
  it('ranks highest score first across deployments', () => {
    const commercial = mapFindResponse('c', 'Commercial', { hits: [hit('c1', 'Low', 20)] }, true);
    const gov = mapFindResponse('g', 'Gov', { hits: [hit('g1', 'High', 90)] }, true);
    const ranked = rankEstateHits([commercial, gov]);
    expect(ranked.map((h) => h.id)).toEqual(['g1', 'c1']);
    expect(ranked[0].deploymentId).toBe('g');
  });

  it('breaks ties by display name (deterministic)', () => {
    const g: EstateHit[] = mapFindResponse('g', 'Gov', { hits: [hit('b', 'Beta', 50), hit('a', 'Alpha', 50)] }, false);
    const ranked = rankEstateHits([g]);
    expect(ranked.map((h) => h.displayName)).toEqual(['Alpha', 'Beta']);
  });

  it('applies the merge limit', () => {
    const many = mapFindResponse(
      'd',
      'D',
      { hits: Array.from({ length: 10 }, (_, i) => hit(`i${i}`, `Item ${i}`, 100 - i)) },
      false,
    );
    expect(rankEstateHits([many], 3)).toHaveLength(3);
  });
});
