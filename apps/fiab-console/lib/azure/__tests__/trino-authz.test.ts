/**
 * N7e — Trino ENGINE-LEVEL CATALOG AUTHORIZATION unit tests (the gap that kept
 * #2641 red for three rounds: authentication without authorization).
 *
 * The DENY path is the security-load-bearing assertion. Two mutation proofs are
 * embedded so a regression that reverts the check turns the deny test RED:
 *
 *   • "MUTATION PROOF (forbidden)" — an unauthorized caller querying a restricted
 *     catalog MUST be denied. If `authorizeTrinoCatalogs` were reverted to
 *     allow-all (the round-3 posture), this expectation flips to allow and fails.
 *   • "MUTATION PROOF (unresolved)" — a restricted caller submitting a
 *     non-catalog-qualified statement MUST be denied (fail-closed). If the
 *     conservative `resolvedFully` branch were removed, this flips and fails.
 */
import { describe, it, expect } from 'vitest';
import {
  authorizeTrinoCatalogs,
  builtinOpenCatalogs,
  configuredCatalogs,
  extractReferencedCatalogs,
  parseCatalogPolicy,
  principalMatchesRule,
  resolveAllowedCatalogs,
  type TrinoPrincipal,
} from '../trino-authz';

const HR_GROUP = 'grp-hr-0000';
const analyst: TrinoPrincipal = {
  oid: 'oid-analyst', upn: 'analyst@contoso.com', groups: ['grp-analysts'], tenantId: 't1', tenantAdmin: false,
};
const hrUser: TrinoPrincipal = {
  oid: 'oid-hr', upn: 'hruser@contoso.com', groups: [HR_GROUP], tenantId: 't1', tenantAdmin: false,
};
const admin: TrinoPrincipal = {
  oid: 'oid-admin', upn: 'admin@contoso.com', groups: [], tenantId: 't1', tenantAdmin: true,
};

// A deployment that has wired an external `hr` (Postgres) source restricted to the
// HR group, and an `sales` source open to everyone signed-in.
const POLICY = parseCatalogPolicy(JSON.stringify({
  sales: 'signed-in',
  hr: { groups: [HR_GROUP] },
}));
const BUILTINS = builtinOpenCatalogs('iceberg');
const CONFIGURED = configuredCatalogs(POLICY, BUILTINS);

function decide(principal: TrinoPrincipal, sql: string, defaultCatalog?: string) {
  const allowed = resolveAllowedCatalogs(principal, POLICY, BUILTINS);
  const referenced = extractReferencedCatalogs(sql, { defaultCatalog });
  return authorizeTrinoCatalogs({ referenced, allowed, configured: CONFIGURED });
}

describe('policy parsing + principal matching', () => {
  it('parses signed-in and principal-set rules, lower-cased', () => {
    expect(POLICY.catalogs.sales).toBe('signed-in');
    expect(POLICY.catalogs.hr).toEqual({ groups: [HR_GROUP], oids: [], upns: [] });
  });

  it('a malformed policy fails CLOSED (empty = deny-by-default)', () => {
    expect(parseCatalogPolicy('{not json').catalogs).toEqual({});
    expect(parseCatalogPolicy('').catalogs).toEqual({});
    // An unknown string rule locks the catalog (matches nobody), never opens it.
    const p = parseCatalogPolicy(JSON.stringify({ x: 'everyone' }));
    expect(principalMatchesRule(analyst, p.catalogs.x)).toBe(false);
  });

  it('matches by group / oid / upn, case-insensitively', () => {
    expect(principalMatchesRule(hrUser, POLICY.catalogs.hr)).toBe(true);
    expect(principalMatchesRule(analyst, POLICY.catalogs.hr)).toBe(false);
    expect(principalMatchesRule(analyst, 'signed-in')).toBe(true);
    expect(principalMatchesRule({ ...analyst, upn: 'CFO@contoso.com' },
      { upns: ['cfo@contoso.com'] })).toBe(true);
  });
});

describe('resolveAllowedCatalogs — deny-by-default + explicit grant', () => {
  it('a signed-in caller gets the built-ins + only the catalogs they are granted', () => {
    const a = resolveAllowedCatalogs(analyst, POLICY, BUILTINS);
    expect(a.has('iceberg')).toBe(true);       // built-in lake
    expect(a.has('memory')).toBe(true);        // built-in
    expect(a.has('sales')).toBe(true);         // signed-in grant
    expect(a.has('hr')).toBe(false);           // NOT granted -> denied
  });
  it('the HR group additionally reaches the hr catalog', () => {
    expect(resolveAllowedCatalogs(hrUser, POLICY, BUILTINS).has('hr')).toBe(true);
  });
  it('a tenant admin reaches every configured catalog', () => {
    const a = resolveAllowedCatalogs(admin, POLICY, BUILTINS);
    for (const c of CONFIGURED) expect(a.has(c)).toBe(true);
  });
});

describe('extractReferencedCatalogs — conservative, deny-safe', () => {
  it('captures every catalog in a fully-qualified cross-source join', () => {
    const r = extractReferencedCatalogs(
      'SELECT * FROM iceberg.gold.orders o JOIN postgres.public.customers c ON o.id = c.id',
    );
    expect(r.catalogs.sort()).toEqual(['iceberg', 'postgres']);
    expect(r.resolvedFully).toBe(true);
  });
  it('flags a non-catalog-qualified table as unresolved', () => {
    const r = extractReferencedCatalogs('SELECT * FROM gold.orders');
    expect(r.resolvedFully).toBe(false);
  });
  it('captures USE and the request default catalog; ignores names inside literals', () => {
    const r = extractReferencedCatalogs("USE hr.public; SELECT 'iceberg.x.y' AS s FROM hr.public.t", { defaultCatalog: 'memory' });
    expect(r.catalogs).toContain('hr');
    expect(r.catalogs).toContain('memory');   // default catalog is referenced
    expect(r.catalogs).not.toContain('iceberg'); // string literal, not a reference
  });
  it('handles quoted identifiers', () => {
    const r = extractReferencedCatalogs('SELECT * FROM "postgres"."public"."t"');
    expect(r.catalogs).toContain('postgres');
    expect(r.resolvedFully).toBe(true);
  });
});

describe('authorizeTrinoCatalogs — the DENY path (security-load-bearing)', () => {
  it('allows a signed-in caller to query the built-in lake', () => {
    expect(decide(analyst, 'SELECT * FROM iceberg.gold.orders').effect).toBe('allow');
  });

  it('allows a granted (signed-in) external catalog', () => {
    expect(decide(analyst, 'SELECT * FROM sales.public.leads').effect).toBe('allow');
  });

  it('MUTATION PROOF (forbidden): DENIES a caller querying a catalog they lack', () => {
    // analyst is NOT in the HR group; hr is restricted to HR_GROUP.
    const d = decide(analyst, 'SELECT * FROM hr.public.salaries');
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') {
      expect(d.code).toBe('catalog_forbidden');
      expect(d.catalog).toBe('hr');
      expect(d.allowed).not.toContain('hr');
      expect(d.reason).toContain('hr');
    }
  });

  it('DENIES a federated join whose OTHER side is a forbidden catalog', () => {
    // The lake side is allowed, the hr side is not — the whole statement is refused.
    const d = decide(analyst, 'SELECT * FROM iceberg.gold.o JOIN hr.public.s ON o.p = s.p');
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.catalog).toBe('hr');
  });

  it('DENIES a catalog that exists at the engine but has NO grant (deny-by-default)', () => {
    // `mongo` is neither built-in nor in the policy — refused even to reach it.
    const d = decide(analyst, 'SELECT * FROM mongo.db.coll');
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.catalog).toBe('mongo');
  });

  it('the HR group CAN query the hr catalog it is granted', () => {
    expect(decide(hrUser, 'SELECT * FROM hr.public.salaries').effect).toBe('allow');
  });

  it('MUTATION PROOF (unresolved): DENIES a RESTRICTED caller who does not fully qualify', () => {
    // analyst cannot reach `hr`, so an unattributable bare `schema.table` could
    // resolve to hr via a session-catalog / USE — fail closed.
    const d = decide(analyst, 'SELECT * FROM public.orders', /* defaultCatalog */ undefined);
    expect(d.effect).toBe('deny');
    if (d.effect === 'deny') expect(d.code).toBe('catalog_unresolved');
  });

  it('an UNRESTRICTED caller (tenant admin) is NOT denied for an unresolved reference', () => {
    // admin reaches every configured catalog, so an unqualified table is safe —
    // the engine deny-by-default floor blocks anything unconfigured.
    expect(decide(admin, 'SELECT * FROM public.orders').effect).toBe('allow');
  });

  it('a caller with no restrictions (default deployment, no external catalogs) runs freely', () => {
    // No policy => only built-ins configured => every signed-in caller is unrestricted.
    const emptyPolicy = parseCatalogPolicy('');
    const builtins = builtinOpenCatalogs('iceberg');
    const configured = configuredCatalogs(emptyPolicy, builtins);
    const allowed = resolveAllowedCatalogs(analyst, emptyPolicy, builtins);
    const referenced = extractReferencedCatalogs('SELECT * FROM gold.orders'); // unqualified
    expect(authorizeTrinoCatalogs({ referenced, allowed, configured }).effect).toBe('allow');
  });
});
