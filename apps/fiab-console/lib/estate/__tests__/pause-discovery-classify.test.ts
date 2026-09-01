/**
 * #4243 review round 1 — discovery-read classification: absent / throttled /
 * unreachable, and the partition that routes each class.
 *
 * Moved from pause-orchestrator.test.ts when the layer was extracted to
 * `../pause-discovery-classify` (monolith split, 2026-08-31) — the test sits
 * opposite the module it names, same as the pause-actuator extraction.
 *
 * THE MUTATION TARGET: fold the 404 arm of `classifyTagReadFailure` into
 * `unreachable` and the partition cases go red — a deterministically-absent
 * deploy-named id would land in `readFailures` and refuse EVERY live pause
 * with a retry a permanent 404 can never satisfy (the review's measured
 * blocker).
 */
import { describe, it, expect } from 'vitest';
import { classifyTagReadFailure, partitionDiscovery } from '../pause-discovery-classify';
import type { DiscoveredResource } from '../pause-inventory';

/** Minimal discovered-row builder (mirrors the orchestrator suite's `res`). */
function res(o: {
  name: string;
  type: string;
  tags?: Record<string, string> | null;
  tagsError?: string;
}): DiscoveredResource {
  return {
    resourceId: `/subscriptions/sub-x/resourceGroups/rg-a/providers/${o.type}/${o.name}`,
    resourceType: o.type,
    name: o.name,
    resourceGroup: 'rg-a',
    subscriptionId: 'sub-x',
    tags: o.tags === undefined ? {} : o.tags,
    ...(o.tagsError ? { tagsError: o.tagsError } : {}),
    discoverySource: 'deploy-manifest',
  };
}

describe('#4243 classifyTagReadFailure — absent / throttled / unreachable, anchored on OUR error shapes', () => {
  it('a 404 / NotFound-family answer is a POSITIVE absence, not a failed read (review round 1)', () => {
    expect(classifyTagReadFailure('ARM GET /x?api-version=1 failed 404: {"error":{"code":"ResourceNotFound"}}')).toBe('absent');
    expect(classifyTagReadFailure('code: ResourceGroupNotFound — Resource group rg-x could not be found')).toBe('absent');
    expect(classifyTagReadFailure('SubscriptionNotFound: The subscription sub-x could not be found')).toBe('absent');
    expect(classifyTagReadFailure('ParentResourceNotFound: parent workspace missing')).toBe('absent');
  });

  it('throttle is anchored on the message SHAPE, never a bare 429 substring', () => {
    expect(classifyTagReadFailure('ARM GET /x was throttled (429) and stayed throttled after 3 attempt(s).')).toBe('throttled');
    expect(classifyTagReadFailure('ARM GET /x failed 429: {"error":{"code":"TooManyRequests"}}')).toBe('throttled');
    // A resource whose NAME contains 429 must not read as a throttle — the
    // bare-substring misclassification is a recorded incident class here.
    expect(classifyTagReadFailure('ARM GET /clusters/adx-429-lab failed 403: forbidden')).toBe('unreachable');
  });

  it('everything else — timeouts, 5xx, auth — establishes nothing: unreachable', () => {
    expect(classifyTagReadFailure('ARM GET /x failed 403: forbidden')).toBe('unreachable');
    expect(classifyTagReadFailure('ARM GET /x failed 503: upstream unavailable')).toBe('unreachable');
    expect(classifyTagReadFailure('fetch timed out after 25000ms')).toBe('unreachable');
  });
});

describe('#4243 partitionDiscovery — absent EXCLUDED and surfaced, unreadable kept and refused', () => {
  const entryFor = (d: DiscoveredResource, fromEnv: string[]) => ({
    resourceId: d.resourceId,
    fromEnv,
  });

  const ok = res({ name: 'adx-ok', type: 'Microsoft.Kusto/clusters', tags: {} });
  const gone = res({ name: 'vmss-gone', type: 'Microsoft.Compute/virtualMachineScaleSets', tags: null,
    tagsError: 'ARM GET /x failed 404: {"error":{"code":"ResourceNotFound"}}' });
  const throttled = res({ name: 'adx-throttled', type: 'Microsoft.Kusto/clusters', tags: null,
    tagsError: 'ARM GET /x was throttled (429) and stayed throttled after 3 attempt(s).' });
  const entries = [
    entryFor(ok, ['LOOM_KUSTO_CLUSTER_NAME']),
    entryFor(gone, ['LOOM_DLZ_RG (or LOOM_ADMIN_RG)', 'LOOM_SHIR_VMSS_NAME']),
    entryFor(throttled, ['LOOM_KUSTO_CLUSTER_NAME']),
  ];

  it('the ABSENT row leaves the population entirely — and is surfaced with the env values to fix, never dropped', () => {
    const p = partitionDiscovery([ok, gone, throttled], entries);
    expect(p.present.map((d) => d.name)).toEqual(['adx-ok', 'adx-throttled']);
    expect(p.absent).toHaveLength(1);
    expect(p.absent[0].resourceId).toBe(gone.resourceId);
    expect(p.absent[0].fromEnv).toContain('LOOM_SHIR_VMSS_NAME');
    expect(p.absent[0].statement).toMatch(/EXCLUDED/);
    expect(p.absent[0].statement).toMatch(/LOOM_SHIR_VMSS_NAME/);
    expect(p.absent[0].statement).toMatch(/pause\s+proceeds without it/i);
    // …and the absent row is NOT a read failure.
    expect(p.readFailures.map((f) => f.name)).toEqual(['adx-throttled']);
    expect(p.readFailures[0].kind).toBe('throttled');
    expect(p.readFailures[0].throttled).toBe(true);
  });

  it('an UNREADABLE row STAYS in the population (indeterminate, fail-safe) — never silently excluded', () => {
    const p = partitionDiscovery([throttled], [entryFor(throttled, ['LOOM_KUSTO_CLUSTER_NAME'])]);
    expect(p.present).toHaveLength(1);
    expect(p.absent).toEqual([]);
    expect(p.readFailures).toHaveLength(1);
  });

  it('clean reads partition clean: everything present, nothing absent, nothing failed', () => {
    const p = partitionDiscovery([ok], [entryFor(ok, ['LOOM_KUSTO_CLUSTER_NAME'])]);
    expect(p.present).toEqual([ok]);
    expect(p.absent).toEqual([]);
    expect(p.readFailures).toEqual([]);
  });
});
