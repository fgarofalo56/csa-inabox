/**
 * LU-7 follow-ups — the three defects an independent security review of #3080
 * recorded as "tracked, NOT silently deferred", closed with regressions that
 * FAIL against the code as it shipped.
 *
 * Each one is the same underlying class: **an artifact asserting a state the
 * code never established** (`deploy-integrity.md` R7), reached not through the
 * compiler but through a CALL SITE that passed the wrong options. A pure test
 * over the builders cannot catch any of them, because it supplies both sides
 * the same options by construction — so every test here drives the real
 * `reconcilePolicyCode` / `publishTrinoEngineRules`.
 *
 *   1. The reconcile-path artifact warned that every group-keyed rule "will not
 *      match" even when a group file WAS published. `trinoGroupProvider` was
 *      observed and then handed only to `buildTrinoRulesDocument` /
 *      `buildTrinoRego`, neither of which reads it — never to `compileTrino`,
 *      the sole consumer and the sole producer of `artifact.warnings`.
 *      Fail-SAFE (it over-warns), but it teaches an operator to distrust a
 *      control that is actually in force.
 *   2. The STORED rego carried no catalog floor, making it strictly MORE
 *      PERMISSIVE than the file document it claims equivalence with: a caller
 *      naming an un-wired catalog fell through to the table rules.
 *   3. `additionalImpersonatedUsers` was honoured by the file document and
 *      silently dropped by the rego — the two artifacts would have disagreed
 *      about who may be impersonated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks: the Azure edges reconcile touches ────────────────────────────────
const upserted: any[] = [];
const store = new Map<string, any>();

vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => ({
    item: (id: string) => ({
      read: async () => ({ resource: store.get(id) }),
    }),
    items: {
      upsert: async (doc: any) => {
        upserted.push(doc);
        store.set(doc.id, doc);
        return { resource: doc };
      },
    },
  }),
  auditLogContainer: async () => ({ items: { upsert: async () => ({}) } }),
}));

vi.mock('@/lib/azure/uc-backend', () => ({
  resolveUcBackend: () => 'oss' as const,
  isOssUc: () => true,
  ossUcBase: () => 'https://loom-unity.internal',
}));

vi.mock('@/lib/azure/trino-client', () => ({
  trinoConfigGate: () => null,
  isTrinoSealed: () => false,
}));

// The group resolves to a real member, so a NON-EMPTY group file is published.
vi.mock('@/lib/azure/graph-identity-client', () => ({
  getGroupTransitiveMembers: async () => [
    { type: 'user', upn: 'analyst@contoso.com', mail: 'analyst@contoso.com' },
  ],
}));

import { reconcilePolicyCode } from '../reconcile';
import { normalizePolicyCodeSet } from '../dsl';
import { compileAll } from '../compile';
import { resolveCompileOptions } from '../compile-options';
import { buildTrinoRego, compileTrino } from '../compilers/trino';
import { publishTrinoEngineRules, trinoRulesDocId } from '../trino-engine-rules';

const TENANT = 'tenant-1';

/** A GROUP-keyed statement — the only shape that trips the group warning. */
const GROUP_SET = normalizePolicyCodeSet({
  apiVersion: 'loom.governance/v1',
  name: 'group-keyed',
  statements: [{
    id: 'g1',
    principals: [{ kind: 'group', id: 'grp-analysts', name: 'Analysts' }],
    resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
    actions: ['read'],
  }],
});

const GROUP_WARNING = 'no Trino group provider is published';

function publishedDoc() {
  return upserted.filter((d) => d.kind === 'trino-engine-rules').at(-1);
}

beforeEach(() => {
  upserted.length = 0;
  store.clear();
  delete process.env.LOOM_TRINO_ICEBERG_CATALOG;
  delete process.env.LOOM_TRINO_SESSION_USER;
});

afterEach(() => {
  delete process.env.LOOM_TRINO_ICEBERG_CATALOG;
  delete process.env.LOOM_TRINO_SESSION_USER;
});

// ───────────────────────────────────────────────────────────────────────────
// 1. The group-provider observation must reach the COMPILER
//
// A correction to the tracked write-up, found by trying to write this test as
// stated: the follow-up said "the reconcile-path ARTIFACT permanently warns".
// It does — but `reconcilePolicyCode` never surfaces `artifact.warnings` on its
// receipt at all (it only forwards `resolveTrinoGroupMemberships` warnings), so
// that half was INVISIBLE rather than misleading. The operator-visible defect
// was one call site over: `/api/admin/policy-code` compiled with `compileAll(set)`
// — no options whatsoever — and that response DOES carry `artifacts[].warnings`.
// So the surface an admin reads to learn what is enforced was the least accurate
// of the three, and it warned about a control that was actually in force.
//
// The assertion is therefore an explicit A/B of the OLD and NEW expressions,
// which is falsifiable in both directions.
// ───────────────────────────────────────────────────────────────────────────
describe('the group-provider observation reaches the COMPILER', () => {
  async function publishGroupFile() {
    await reconcilePolicyCode(GROUP_SET, { apply: true, tenantId: TENANT, updatedBy: 'test' });
    const doc = store.get(trinoRulesDocId(TENANT));
    expect(doc.groupFile).toContain('analyst@contoso.com');
  }

  function warnsAboutGroupProvider(result: { warnings: string[] }) {
    return result.warnings.join(' ').includes(GROUP_WARNING);
  }

  it('warns when NO group file has been published — the honest direction', async () => {
    // Asserted first so the fix can never be mistaken for "silence the warning".
    const opts = await resolveCompileOptions(TENANT);
    expect(opts.trinoGroupProvider).toBe(false);
    expect(warnsAboutGroupProvider(compileAll(GROUP_SET, opts))).toBe(true);
  });

  it('STOPS warning once a group file with real members is published', async () => {
    await publishGroupFile();

    const opts = await resolveCompileOptions(TENANT);
    expect(opts.trinoGroupProvider).toBe(true);
    expect(warnsAboutGroupProvider(compileAll(GROUP_SET, opts))).toBe(false);
  });

  it('is the exact behaviour the admin preview used to get WRONG', async () => {
    await publishGroupFile();

    // What `/api/admin/policy-code` did before: no options at all.
    const shipped = compileAll(GROUP_SET);
    // What it does now.
    const fixed = compileAll(GROUP_SET, await resolveCompileOptions(TENANT));

    expect(warnsAboutGroupProvider(shipped)).toBe(true);
    expect(warnsAboutGroupProvider(fixed)).toBe(false);
  });

  it('keeps warning when the published group file is EMPTY (fails closed)', async () => {
    // An empty group file matches nobody, so the rule genuinely cannot match and
    // the warning must survive. This is what stops the fix from degrading into
    // "a document exists, therefore the control works".
    store.set(trinoRulesDocId(TENANT), {
      id: trinoRulesDocId(TENANT),
      tenantId: TENANT,
      kind: 'trino-engine-rules',
      groupFile: '   ',
      version: 'v0',
      rules: { catalogs: [], schemas: [], tables: [], impersonation: [] },
    });

    const opts = await resolveCompileOptions(TENANT);
    expect(opts.trinoGroupProvider).toBe(false);
    expect(warnsAboutGroupProvider(compileAll(GROUP_SET, opts))).toBe(true);
  });

  it('carries the deployment lake catalog, so all three call sites agree', async () => {
    // The other half of the shared reader: the admin preview used to resolve
    // 2-part refs against the hardcoded `iceberg` default while publish and
    // serve used LOOM_TRINO_ICEBERG_CATALOG.
    process.env.LOOM_TRINO_ICEBERG_CATALOG = 'lake';
    const opts = await resolveCompileOptions(TENANT);
    expect(opts.trinoDefaultCatalog).toBe('lake');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The STORED rego's catalog floor
// ───────────────────────────────────────────────────────────────────────────
describe('publishTrinoEngineRules: the stored rego carries the engine-observed catalog floor', () => {
  const artifact = () => compileTrino(GROUP_SET, { trinoGroupProvider: true });

  it('self-discloses when the engine has NEVER fetched (no observation to use)', async () => {
    // Honest absence — the module must not invent a catalog list.
    const doc = await publishTrinoEngineRules({
      set: GROUP_SET,
      artifact: artifact(),
      tenantId: TENANT,
      publishedBy: 'test',
      memberships: { 'grp-analysts': ['analyst@contoso.com'] },
      docOptions: {},
    });
    expect(doc.rego).toContain('carries NO catalog floor');
    expect(doc.rego).not.toContain('wired_catalogs');
  });

  it('renders the floor from the catalogs the ENGINE reported at its last fetch', async () => {
    // THE regression. Against the shipped code the stored rego ALWAYS took the
    // no-floor branch, so `catalog_ok` was `default true` and the module was
    // strictly more permissive than the file document.
    store.set(trinoRulesDocId(TENANT), {
      id: trinoRulesDocId(TENANT),
      tenantId: TENANT,
      kind: 'trino-engine-rules',
      groupFile: 'analysts:analyst@contoso.com',
      version: 'v0',
      rules: { catalogs: [], schemas: [], tables: [], impersonation: [] },
      lastFetch: {
        at: new Date().toISOString(),
        version: 'v0',
        catalogs: ['system', 'jmx', 'memory', 'iceberg'],
        catalogRules: [
          { name: 'system', allow: 'read-only' },
          { name: 'jmx', allow: 'read-only' },
          { name: 'memory', allow: 'all' },
          { name: 'iceberg', allow: 'read-only' },
        ],
        by: 'engine',
      },
    });

    const doc = await publishTrinoEngineRules({
      set: GROUP_SET,
      artifact: artifact(),
      tenantId: TENANT,
      publishedBy: 'test',
      memberships: { 'grp-analysts': ['analyst@contoso.com'] },
      docOptions: {},
    });

    expect(doc.rego).not.toContain('carries NO catalog floor');
    expect(doc.rego).toContain('wired_catalogs');
    expect(doc.rego).toContain('"iceberg"');
    // The floor must actually be able to DENY, not just be present.
    expect(doc.rego).toContain('catalog_ok := false if {');
  });

  it('falls back to the bare catalog NAMES on a pre-upgrade document', async () => {
    // Documents published before `catalogRules` existed carry only names. The
    // reader must treat that as an observation, not as "no catalogs".
    store.set(trinoRulesDocId(TENANT), {
      id: trinoRulesDocId(TENANT),
      tenantId: TENANT,
      kind: 'trino-engine-rules',
      groupFile: '',
      version: 'v0',
      rules: { catalogs: [], schemas: [], tables: [], impersonation: [] },
      lastFetch: { at: new Date().toISOString(), version: 'v0', catalogs: ['iceberg'], by: 'engine' },
    });

    const doc = await publishTrinoEngineRules({
      set: GROUP_SET,
      artifact: artifact(),
      tenantId: TENANT,
      publishedBy: 'test',
      memberships: {},
      docOptions: {},
    });
    expect(doc.rego).toContain('wired_catalogs');
    expect(doc.rego).toContain('"iceberg"');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. additionalImpersonatedUsers — the two artifacts must agree
// ───────────────────────────────────────────────────────────────────────────
describe('buildTrinoRego: additionalImpersonatedUsers is honoured, not silently dropped', () => {
  const SET = normalizePolicyCodeSet({
    apiVersion: 'loom.governance/v1',
    name: 'imp',
    statements: [{
      id: 's1',
      principals: [{ kind: 'user', id: 'u1', name: 'alice@contoso.com' }],
      resources: [{ backend: 'trino', object: 'iceberg.sales.orders' }],
      actions: ['read'],
    }],
  });

  it('includes the extra principal in the rego impersonation set', () => {
    // THE regression: the file document honoured this option and the rego
    // ignored it, so the two artifacts disagreed about who may be impersonated.
    const rego = buildTrinoRego(SET, { additionalImpersonatedUsers: ['breakglass@contoso.com'] });
    expect(rego).toContain('"alice@contoso.com"');
    expect(rego).toContain('"breakglass@contoso.com"');
  });

  it('still emits only policy-named principals when the option is absent', () => {
    const rego = buildTrinoRego(SET, {});
    expect(rego).toContain('"alice@contoso.com"');
    expect(rego).not.toContain('breakglass@contoso.com');
    // Never a wildcard — an empty set denies, a `.*` would grant everything.
    expect(rego).not.toContain('".*"');
  });

  it('ignores blank/whitespace entries rather than emitting an empty principal', () => {
    const rego = buildTrinoRego(SET, { additionalImpersonatedUsers: ['  ', ''] });
    expect(rego).not.toContain('""');
  });
});
