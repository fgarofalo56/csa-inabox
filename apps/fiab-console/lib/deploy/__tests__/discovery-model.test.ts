/**
 * discovery-model tests.
 *
 * The row fixtures below are SHAPES CAPTURED FROM LIVE AZURE RESOURCE GRAPH on
 * 2026-08-05 (Commercial, api-version 2022-10-01), not shapes invented to match
 * this code. That distinction matters: a fixture that models the code rather
 * than the dependency will happily confirm a bug. Field spellings, the empty
 * string for an absent `sku.tier`, the string-typed `isHns`, and the numeric
 * `peCount` are all exactly what the query returned.
 */
import { describe, it, expect } from 'vitest';
import {
  buildInventoryQuery,
  COVERAGE_QUERY,
  posturefromRow,
  rowToCandidate,
  recommendFor,
  classifyNoCandidate,
  buildServiceDiscoveries,
  summariseCoverage,
  redactArmId,
  type InventoryRow,
  type SubscriptionScanResult,
} from '../discovery-model';
import { ADOPTION_CATALOG, adoptionArmTypes, getServiceDef } from '../adoption-catalog';

const SUB_A = '11111111-1111-1111-1111-111111111111';
const SUB_B = '22222222-2222-2222-2222-222222222222';

/** Verbatim shape of a real ARG row (values anonymised, structure untouched). */
function row(over: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Kusto/clusters/adx-demo`,
    name: 'adx-demo',
    type: 'microsoft.kusto/clusters',
    kind: '',
    location: 'centralus',
    resourceGroup: 'rg-demo',
    subscriptionId: SUB_A,
    subName: 'Demo Subscription',
    skuName: 'Dev(No SLA)_Standard_E2a_v4',
    skuTier: 'Basic',
    pna: 'Enabled',
    aclDefault: '',
    peCount: 0,
    isHns: '',
    tags: null,
    ...over,
  };
}

function ledger(over: Partial<SubscriptionScanResult> = {}): SubscriptionScanResult {
  return {
    subscriptionId: SUB_A,
    displayName: 'Demo Subscription',
    status: 'scanned',
    credentialTier: 'user',
    matchedResources: 1,
    established: 'test',
    ...over,
  };
}

describe('buildInventoryQuery', () => {
  it('generates the type list from the catalog, not a hand-maintained literal', () => {
    const q = buildInventoryQuery();
    for (const t of adoptionArmTypes()) {
      expect(q, `${t} missing from the generated query`).toContain(`'${t}'`);
    }
  });

  it('queries every catalog ARM type — adding a catalog entry cannot be forgotten', () => {
    const q = buildInventoryQuery();
    const inQuery = [...q.matchAll(/'(microsoft\.[a-z0-9./-]+)'/g)].map((m) => m[1]);
    const catalogTypes = new Set(ADOPTION_CATALOG.map((d) => d.armType));
    for (const t of catalogTypes) expect(inQuery).toContain(t);
  });

  it('orders by type first so a truncation lands inside one service, not alphabetically across all', () => {
    expect(buildInventoryQuery()).toContain('| order by type asc, name asc');
  });

  it('projects the fields the candidate mapper reads', () => {
    const q = buildInventoryQuery();
    for (const f of ['skuName', 'skuTier', 'pna', 'aclDefault', 'peCount', 'isHns', 'subName']) {
      expect(q).toContain(f);
    }
  });
});

describe('COVERAGE_QUERY', () => {
  it('reads ResourceContainers, which returns a row even for an EMPTY subscription', () => {
    // This is the only reason a greenfield subscription with zero resources can
    // be distinguished from one we could not read.
    expect(COVERAGE_QUERY).toContain('ResourceContainers');
    expect(COVERAGE_QUERY).toContain('microsoft.resources/subscriptions');
    expect(COVERAGE_QUERY).not.toContain('\nResources\n');
  });
});

describe('posturefromRow', () => {
  it('publicNetworkAccess Disabled → private-endpoint', () => {
    expect(posturefromRow(row({ pna: 'Disabled' }))).toBe('private-endpoint');
  });

  it('networkAcls defaultAction Deny → service-endpoint', () => {
    expect(posturefromRow(row({ pna: '', aclDefault: 'Deny' }))).toBe('service-endpoint');
  });

  it('publicNetworkAccess Enabled → public', () => {
    expect(posturefromRow(row({ pna: 'Enabled' }))).toBe('public');
  });

  it('neither field but private endpoints present → private-endpoint', () => {
    expect(posturefromRow(row({ pna: '', aclDefault: '', peCount: 3 }))).toBe('private-endpoint');
  });

  it('neither field and no evidence → unknown, NEVER assumed public', () => {
    // A resource whose RP exposes no posture field is unknown. Guessing
    // "public" here would let an unreachable resource be recommended for
    // adoption and fail at the first data-plane call instead of at planning.
    expect(posturefromRow(row({ pna: '', aclDefault: '', peCount: 0 }))).toBe('unknown');
  });
});

describe('rowToCandidate', () => {
  it('maps a real ADX row', () => {
    const c = rowToCandidate(row(), 'user', '2026-08-05T00:00:00.000Z');
    expect(c).not.toBeNull();
    expect(c!.serviceKey).toBe('adx');
    expect(c!.sku).toEqual({ name: 'Dev(No SLA)_Standard_E2a_v4', tier: 'Basic' });
    expect(c!.networkPosture).toBe('public');
    expect(c!.credentialTier).toBe('user');
  });

  it('returns null for an ARM type in the query but not an adoption target', () => {
    expect(
      rowToCandidate(
        row({ type: 'microsoft.cognitiveservices/accounts', kind: 'SpeechServices' }),
        'user',
        'now',
      ),
    ).toBeNull();
  });

  it('storage: isHnsEnabled "false" → false', () => {
    const c = rowToCandidate(
      row({ type: 'microsoft.storage/storageaccounts', isHns: 'false' }),
      'user',
      'now',
    );
    expect(c!.hierarchicalNamespace).toBe(false);
  });

  it('storage: ABSENT isHnsEnabled → undefined, not false', () => {
    // HNS is create-time-only. Reporting an unread field as `false` would
    // reject an account that may in fact be HNS-enabled — unknown as negative.
    const c = rowToCandidate(
      row({ type: 'microsoft.storage/storageaccounts', isHns: '' }),
      'user',
      'now',
    );
    expect(c!.hierarchicalNamespace).toBeUndefined();
  });

  it('non-storage rows carry no HNS verdict at all', () => {
    expect(rowToCandidate(row(), 'user', 'now')!.hierarchicalNamespace).toBeUndefined();
  });

  it('flags Loom-owned resources by resource-group convention', () => {
    const c = rowToCandidate(row({ resourceGroup: 'rg-csa-loom-admin-centralus' }), 'user', 'now');
    expect(c!.looksLoomOwned).toBe(true);
    expect(rowToCandidate(row({ resourceGroup: 'rg-customer-prod', name: 'adx-demo' }), 'user', 'now')!.looksLoomOwned).toBe(false);
  });

  it('drops non-scalar tag values rather than leaking objects into the payload', () => {
    const c = rowToCandidate(
      row({ tags: { env: 'prod', nested: { a: 1 } as any, count: 3 } }),
      'user',
      'now',
    );
    expect(c!.tags).toEqual({ env: 'prod', count: '3' });
  });
});

describe('redactArmId', () => {
  it('keeps only the last two segments — no subscription id survives', () => {
    const id = `/subscriptions/${SUB_A}/resourceGroups/rg-demo/providers/Microsoft.Kusto/clusters/adx-demo`;
    const out = redactArmId(id);
    expect(out).toBe('…/clusters/adx-demo');
    expect(out).not.toContain(SUB_A);
    expect(out).not.toContain('rg-demo');
  });
});

describe('recommendFor', () => {
  const ctx = { coverageIncomplete: false, hubRegion: 'centralus' };
  const adx = getServiceDef('adx')!;
  const purview = getServiceDef('purview')!;
  const kv = getServiceDef('keyvault')!;

  function cand(over: Partial<ReturnType<typeof rowToCandidate>> = {}) {
    return { ...rowToCandidate(row(), 'user', 'now')!, ...(over as any) };
  }

  it('one in-region candidate → adopt', () => {
    const r = recommendFor(adx, [cand()], ctx);
    expect(r.recommendation).toBe('adopt');
    expect(r.reason).toContain('adx-demo');
  });

  it('one OUT-of-region candidate → create, and says why', () => {
    const r = recommendFor(adx, [cand({ location: 'westeurope' })], ctx);
    expect(r.recommendation).toBe('create');
    expect(r.reason).toContain('westeurope');
    expect(r.reason).toContain('centralus');
  });

  it('several candidates → create rather than guessing in production', () => {
    const r = recommendFor(adx, [cand(), cand({ name: 'adx-two' })], ctx);
    expect(r.recommendation).toBe('create');
    expect(r.reason).toContain('2 existing');
  });

  it('a tenant singleton with a candidate → adopt-required, not merely adopt', () => {
    const r = recommendFor(purview, [cand({ serviceKey: 'purview', name: 'pv-corp' })], ctx);
    expect(r.recommendation).toBe('adopt-required');
    expect(r.reason).toContain('tenant singleton');
    expect(r.reason).toContain('pv-corp');
  });

  it('create-only surfaces the reason verbatim', () => {
    const r = recommendFor(kv, [], ctx);
    expect(r.recommendation).toBe('create');
    expect(r.reason).toBe(kv.createOnlyReason);
  });

  describe('reference-only', () => {
    const sql = getServiceDef('azure-sql')!;

    it('exactly one candidate → adopt, and NAMES it', () => {
      const r = recommendFor(sql, [cand({ serviceKey: 'azure-sql', name: 'sql-one' })], ctx);
      expect(r.recommendation).toBe('adopt');
      expect(r.reason).toContain('sql-one');
    });

    it('SEVERAL candidates → does not silently pick one', () => {
      // The live Commercial scan found 9 Azure SQL servers and the first draft
      // recommended "adopt" while naming none of them — a recommendation the
      // operator cannot act on.
      const many = [1, 2, 3].map((i) => cand({ serviceKey: 'azure-sql', name: `sql-${i}` }));
      const r = recommendFor(sql, many, ctx);
      expect(r.recommendation).not.toBe('adopt');
      expect(r.reason).toContain('3 existing');
      expect(r.reason).toContain('will not pick one for you');
    });
  });

  it('zero candidates with COMPLETE coverage states it as a conclusion', () => {
    const r = recommendFor(adx, [], { coverageIncomplete: false });
    expect(r.reason).toContain('in the subscriptions scanned');
    expect(r.reason).not.toContain('could not read');
  });

  it('zero candidates with INCOMPLETE coverage refuses to state it as a conclusion', () => {
    const r = recommendFor(adx, [], { coverageIncomplete: true });
    expect(r.reason).toContain('could not read every subscription');
  });
});

describe('classifyNoCandidate', () => {
  it('distinguishes none-exist from could-not-look', () => {
    const adx = getServiceDef('adx')!;
    expect(classifyNoCandidate(adx, false)).toBe('none-exist');
    expect(classifyNoCandidate(adx, true)).toBe('could-not-look');
  });

  it('create-only is not-adoptable regardless of coverage', () => {
    const kv = getServiceDef('keyvault')!;
    expect(classifyNoCandidate(kv, false)).toBe('not-adoptable');
    expect(classifyNoCandidate(kv, true)).toBe('not-adoptable');
  });
});

describe('buildServiceDiscoveries', () => {
  it('returns one entry per catalog service, even with zero candidates (greenfield)', () => {
    const out = buildServiceDiscoveries([], [ledger({ matchedResources: 0 })], {});
    expect(out.length).toBe(ADOPTION_CATALOG.length);
    expect(out.every((s) => s.candidates.length === 0)).toBe(true);
    expect(out.find((s) => s.serviceKey === 'adx')!.noCandidateOutcome).toBe('none-exist');
  });

  it('a no-access subscription makes every empty service UNCERTAIN', () => {
    const out = buildServiceDiscoveries(
      [],
      [ledger(), ledger({ subscriptionId: SUB_B, status: 'no-access', matchedResources: 0 })],
      {},
    );
    const adx = out.find((s) => s.serviceKey === 'adx')!;
    expect(adx.uncertain).toBe(true);
    expect(adx.noCandidateOutcome).toBe('could-not-look');
  });

  it('a truncated subscription also makes coverage incomplete', () => {
    const out = buildServiceDiscoveries([], [ledger({ status: 'truncated' })], {});
    expect(out.find((s) => s.serviceKey === 'adx')!.noCandidateOutcome).toBe('could-not-look');
  });

  it('create-only services are never offered a candidate even if instances exist', () => {
    const kvRow = row({
      type: 'microsoft.keyvault/vaults',
      name: 'kv-customer',
      id: `/subscriptions/${SUB_A}/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-customer`,
    });
    const c = rowToCandidate(kvRow, 'user', 'now')!;
    expect(c.serviceKey).toBe('keyvault'); // it IS discovered…
    const out = buildServiceDiscoveries([c], [ledger()], {});
    const kv = out.find((s) => s.serviceKey === 'keyvault')!;
    expect(kv.candidates).toEqual([]); // …but never offered as a choice
    expect(kv.noCandidateOutcome).toBe('not-adoptable');
    expect(kv.uncertain).toBe(false);
  });

  it('carries the mutation disclosure through to the service view', () => {
    const out = buildServiceDiscoveries([], [ledger()], {});
    const dbx = out.find((s) => s.serviceKey === 'databricks')!;
    expect(dbx.mutations.join(' ')).toContain('Unity Catalog metastore');
  });
});

describe('summariseCoverage — the sentence that replaced a false count', () => {
  it('never conflates scanned-with-zero and could-not-read', () => {
    const s = summariseCoverage([
      ledger({ matchedResources: 3 }),
      ledger({ subscriptionId: SUB_B, status: 'scanned', matchedResources: 0 }),
      ledger({ subscriptionId: '33333333-3333-3333-3333-333333333333', status: 'no-access', matchedResources: 0 }),
    ]);
    expect(s).toContain('Requested 3 subscriptions');
    expect(s).toContain('Read 2 of them');
    expect(s).toContain('1 containing something Loom could adopt');
    expect(s).toContain('could NOT be read');
    expect(s).toContain('unknown, not empty');
  });

  it('says coverage is complete only when every requested subscription was read', () => {
    expect(summariseCoverage([ledger(), ledger({ subscriptionId: SUB_B })])).toContain(
      'Coverage is complete.',
    );
    expect(
      summariseCoverage([ledger(), ledger({ subscriptionId: SUB_B, status: 'no-access' })]),
    ).not.toContain('Coverage is complete.');
  });

  it('reports truncation as incomplete inventory, not as absence', () => {
    const s = summariseCoverage([ledger({ status: 'truncated' })]);
    expect(s).toContain('cut short');
    expect(s).not.toContain('Coverage is complete.');
  });
});
