/**
 * #3501 — data-product marketplace attribution followed whoever LAST WROTE.
 *
 * `docForDataProduct(item, tenantId)` stamps `tenantId` onto the
 * `loom-data-products` AI Search document, and `searchDataProducts` ALWAYS
 * injects `tenantId eq '<caller oid>'` as a mandatory, non-overridable filter.
 * That field is therefore the DISCOVERY BOUNDARY, not a label.
 *
 * MEASURED on this tree before the fix: 10 of the 11 sites that build such a
 * doc passed `session.claims.oid` — the CALLER — across 6 route files, and the
 * 11th (`item-crud.ts:150`) took a `tenantId` parameter every caller populated
 * from `session.claims.oid`. So a shared-workspace collaborator pressing
 * Publish / Certify / Deprecate / a health action rewrote the doc's tenant to
 * THEIR oid, which simultaneously dropped the product out of the owner's
 * marketplace and surfaced it in the collaborator's. `updateOwnedItem` gates on
 * workspace WRITE access, which a collaborator satisfies — no privilege needed.
 *
 * These tests are written against the SHARED resolver rather than one route, so
 * a fix applied to only the reported site cannot pass them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queries: any[] = [];
let workspaces: Array<{ id: string; tenantId?: string }> = [];
let throwOnQuery = false;

vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(async () => ({
    items: {
      query: (spec: any) => {
        queries.push(spec);
        return {
          fetchAll: async () => {
            if (throwOnQuery) throw new Error('cosmos down');
            const id = (spec?.parameters || []).find((p: any) => p.name === '@id')?.value;
            return { resources: workspaces.filter((w) => w.id === id) };
          },
        };
      },
    },
  })),
}));

import { resolveDataProductDocTenant, resolveOwnerTenantId } from '../owner-tenant';

const OWNER = 'tenant-owner';
const COLLABORATOR = 'tenant-collaborator';

beforeEach(() => {
  queries.length = 0;
  workspaces = [{ id: 'ws-1', tenantId: OWNER }];
  throwOnQuery = false;
  vi.clearAllMocks();
});

describe('#3501 — a data-product doc is stamped with the OWNER, not the caller', () => {
  it('resolves the owning workspace tenant, independent of who is calling', async () => {
    // The resolver takes the ITEM. There is no parameter through which a
    // caller's oid could reach it — which is the structural point of the fix.
    const tid = await resolveDataProductDocTenant({ workspaceId: 'ws-1' });

    expect(tid).toBe(OWNER);
    expect(tid).not.toBe(COLLABORATOR);
  });

  it('returns null — never the caller — when the workspace is unknown', async () => {
    // "Unknown" must not degrade to "the caller": the caller's oid is precisely
    // the wrong answer, and falling back to it IS the defect. Callers skip the
    // mirror instead (deploy-integrity R7).
    workspaces = [];

    expect(await resolveDataProductDocTenant({ workspaceId: 'ws-missing' })).toBeNull();
  });

  it('returns null when the owning workspace carries no tenantId', async () => {
    workspaces = [{ id: 'ws-1' }];

    expect(await resolveDataProductDocTenant({ workspaceId: 'ws-1' })).toBeNull();
  });

  it('returns null when Cosmos fails, rather than guessing', async () => {
    throwOnQuery = true;

    expect(await resolveDataProductDocTenant({ workspaceId: 'ws-1' })).toBeNull();
  });

  it('returns null for an item with no workspace, without querying', async () => {
    expect(await resolveDataProductDocTenant({})).toBeNull();
    expect(await resolveDataProductDocTenant(null)).toBeNull();
    expect(await resolveDataProductDocTenant(undefined)).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('looks the workspace up by id, parameterised (never string-concatenated)', async () => {
    await resolveDataProductDocTenant({ workspaceId: "ws-1' OR 1=1--" });

    expect(queries).toHaveLength(1);
    expect(queries[0].query).toContain('@id');
    expect(queries[0].query).not.toContain('OR 1=1');
    expect(queries[0].parameters).toEqual([{ name: '@id', value: "ws-1' OR 1=1--" }]);
  });

  it('is the same resolution the pre-existing owner helper performs', async () => {
    // Pins that the new entry point did not fork the semantics of the helper
    // `owner-tenant.ts` already exported for the #3499 DQ-rules fix.
    expect(await resolveDataProductDocTenant({ workspaceId: 'ws-1' }))
      .toBe(await resolveOwnerTenantId('ws-1'));
  });
});

describe('#3501 — every doc-building call site is converted', () => {
  it('no data-product doc is built from session.claims.oid anywhere', async () => {
    // The population this asserts over is every `docForDataProduct(` call site
    // under app/ and lib/. A fix applied to only the reported site leaves the
    // other 10 matching and fails here — the narrow-bypass guard for #3501.
    //
    // Enumerated by walking the tree, NOT by shelling to git: CI checks out at
    // depth 1 and a git-dependent assertion can silently degrade into one that
    // proves nothing. No ambient repo state is read.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const consoleRoot = join(__dirname, '..', '..', '..');
    const SKIP = new Set(['node_modules', '.next', 'dist', '__tests__', 'e2e', 'test-results']);

    function walk(dir: string, out: string[]): string[] {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
      }
      return out;
    }

    const files = [...walk(join(consoleRoot, 'app'), []), ...walk(join(consoleRoot, 'lib'), [])];
    // A guard that matches nothing is green and blind — assert the population
    // of files that actually BUILD a doc, and that it is what we measured.
    const building = files.filter((f) => {
      if (f.endsWith('loom-data-products-search.ts')) return false; // the definition
      return readFileSync(f, 'utf8').includes('docForDataProduct(');
    });
    expect(building.length).toBeGreaterThanOrEqual(7);

    const offenders: string[] = [];
    let callSites = 0;
    for (const f of building) {
      const text = readFileSync(f, 'utf8');
      // CRLF-safe: match the CALL, not a whole line — a needle written against
      // LF would match zero times here and read exactly like a passing test.
      //
      // KNOWN BOUND, stated so it is not mistaken for total coverage: this keys
      // on the LITERAL `session.claims.oid` appearing between the call's parens.
      // A regression laundered through an intermediate binding —
      // `const oid = session.claims.oid; … docForDataProduct(oid, …)` — passes
      // this guard. It catches the shape #3501 actually shipped (the caller oid
      // inlined at the call site, 11 times), not every possible reintroduction.
      // Closing that would need the argument to be checked against an allow-set
      // of resolver expressions rather than a deny-string; until then, treat a
      // green here as "the inlined shape is gone", not "attribution is proven".
      for (const m of text.matchAll(/docForDataProduct\(\s*[^)]*\)/g)) {
        callSites += 1;
        if (m[0].includes('session.claims.oid')) {
          offenders.push(`${f.slice(consoleRoot.length + 1)}: ${m[0]}`);
        }
      }
    }
    // Second population assertion: the regex must actually be matching calls.
    expect(callSites).toBeGreaterThanOrEqual(11);
    expect(offenders).toEqual([]);
  });
});
