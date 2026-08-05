/**
 * Tests for the pure parts of the estate scan.
 *
 * The query builder and the posture derivation are where two live defects sat:
 *
 *  · `options: {top: 1000}` — the wrong key. The ARG REST API reads `$top`, so
 *    that option had been a NO-OP, and the query relied on the undocumented
 *    1000-row default while ordering by `name asc`. On a large tenant the cut
 *    was alphabetical and whole services silently showed zero candidates.
 *  · a missing posture signal was effectively treated as "public", which would
 *    let the fitness suite call an unreachable resource usable.
 */
import { describe, it, expect } from 'vitest';
import { buildEstateQuery, derivePosture } from '@/lib/setup/estate-scan';
import { adoptionArmTypes, armTypeToServiceKey, ADOPTION_CATALOG } from '@/lib/deploy/adoption-catalog';

describe('buildEstateQuery', () => {
  const q = buildEstateQuery();

  it('is generated from the catalog, not a hand-maintained type list', () => {
    for (const t of adoptionArmTypes()) {
      expect(q).toContain(`'${t}'`);
    }
  });

  it('orders by type first so a truncation is type-balanced, never alphabetical', () => {
    expect(q).toContain('order by type asc, name asc');
    expect(q).not.toMatch(/order by name asc\s*$/);
  });

  it('projects the columns the plan needs, including the posture signals', () => {
    for (const col of ['id', 'name', 'type', 'kind', 'location', 'resourceGroup', 'subscriptionId', 'peCount', 'publicAccess']) {
      expect(q).toContain(col);
    }
  });
});

describe('derivePosture', () => {
  it('reports private-endpoint when a PE connection exists', () => {
    expect(derivePosture({ peCount: 1 })).toBe('private-endpoint');
  });

  it('reports public-restricted when IP rules narrow public access', () => {
    expect(derivePosture({ publicAccess: 'Enabled', hasIpRules: 3 })).toBe('public-restricted');
  });

  it('reports public only when the row actually says public access is enabled', () => {
    expect(derivePosture({ publicAccess: 'Enabled' })).toBe('public');
  });

  it('reports UNKNOWN rather than guessing public when the row carries no signal', () => {
    // The critical negative: an absent signal is not evidence of reachability.
    expect(derivePosture({})).toBe('unknown');
    expect(derivePosture({ publicAccess: '' })).toBe('unknown');
  });
});

describe('adoption catalog', () => {
  it('splits Cognitive Services accounts by ARM kind so Maps is never filed as Foundry', () => {
    expect(armTypeToServiceKey('microsoft.cognitiveservices/accounts', 'AIServices')).toBe('foundry');
    expect(armTypeToServiceKey('microsoft.cognitiveservices/accounts', 'SpeechServices')).toBeNull();
    expect(armTypeToServiceKey('microsoft.maps/accounts')).toBe('maps');
  });

  it('returns null for a type Loom does not adopt', () => {
    expect(armTypeToServiceKey('microsoft.compute/virtualmachines')).toBeNull();
  });

  it('requires a reason on every create-only entry — the UI renders it verbatim', () => {
    for (const d of ADOPTION_CATALOG) {
      if (d.class === 'create-only') {
        expect(d.createOnlyReason, `${d.key} is create-only with no reason`).toBeTruthy();
        expect(d.createOnlyReason!.length).toBeGreaterThan(40);
      }
    }
  });

  it('declares what it mutates for every adoptable service', () => {
    for (const d of ADOPTION_CATALOG) {
      if (d.class === 'adoptable' || d.class === 'adopt-required' || d.class === 'attach-in-place') {
        expect(Array.isArray(d.mutations), `${d.key} has no mutations array`).toBe(true);
        expect(d.mutations.length, `${d.key} declares no mutations`).toBeGreaterThan(0);
      }
    }
  });

  it('has unique keys', () => {
    const keys = ADOPTION_CATALOG.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
