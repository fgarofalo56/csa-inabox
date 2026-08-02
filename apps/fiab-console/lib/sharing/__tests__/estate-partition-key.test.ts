/**
 * #2620 — THE `sharing` CONTAINER'S PARTITION KEY IS AN ESTATE CONSTANT.
 *
 * `lib/azure/cosmos-client.ts` creates the `sharing` container on `/tenantId`,
 * and every function in `../store.ts` takes a `tenantId`. That reads like a
 * tenant boundary and is not one: BOTH callers — the external recipient
 * protocol path (`/api/delta-sharing/*`, which has no session at all) and the
 * admin path (`/api/marketplace/sharing/*`) — pass `sharingOwnerTenantId()`, an
 * env constant. The key is single-valued in any one deployment, so it
 * co-locates shares with recipients for the hot path and isolates nothing.
 *
 * That is correct for the shipped single-estate model — recipients are EXTERNAL,
 * so the owning tenant cannot be read off the caller's token — but the code used
 * to CLAIM isolation ("ONE tenant-partitioned container"), which is the actual
 * defect #2620 reports. Two things are pinned here:
 *
 *   1. DOCUMENTATION (§1). The container definition and the store no longer
 *      assert a tenant partition, and do state the single-estate assumption.
 *      This is the half that was red before the fix.
 *
 *   2. THE CHOKEPOINT (§2). No production sharing module derives the partition
 *      key from session claims — every store call is handed
 *      `sharingOwnerTenantId()`. Green today and green after the fix; it goes
 *      red the day someone half-migrates to a session-derived tenant (issue
 *      #2620 option (b)) without doing the rest of that work, which is the
 *      regression this file exists to catch.
 *
 *   3. BEHAVIOUR (§3, the CONTROL). Both call paths still resolve exactly ONE
 *      partition-key value and it is the env constant. These assertions hold
 *      identically before and after the fix — a change that altered the
 *      partition key would break them, so an over-broad "fix" cannot hide here.
 *
 * §2 masks comments and string literals before scanning (the lesson recorded in
 * scripts/ci/check-tid-boundary-chokepoint.mjs): a mention of `claims.tid` in a
 * doc comment must neither trip the guard nor satisfy it.
 *
 * ## PROVEN TO FAIL. Each mutation below was applied to the tree and the result
 * recorded. A guard nobody has tried to defeat is a comment.
 *
 *   M0  the #2620 doc fix reverted (`git stash` of the 3 sources)
 *                                            → 3 RED (all §1), §2/§3 green
 *   M1  `_loom-backend.loomListShares` takes the tenant from
 *       `tenantScopeId(session)` — the option-(b) half-migration
 *                                            → 2 RED (§2 claims scan + §3 control)
 *   M3  `const tenantId = body?.tenantId ?? sharingOwnerTenantId()` in
 *       `loomGetShare` — a CALLER-CONTROLLED partition key       → 1 RED (§2 args)
 *   M4  NEGATIVE CONTROL — a comment naming `session.claims.tid` and
 *       `tenantScopeId(`                                          → 0 RED (green)
 *   M5a a VALUE import of `tenantScopeId` from @/lib/auth/session → 1 RED (§2)
 *   M5b NEGATIVE CONTROL — `import type { SessionPayload }` from
 *       the same module (types erase, so it is harmless)          → 0 RED (green)
 *
 * M3 passed on the FIRST draft of this file, which collected "names assigned
 * from `sharingOwnerTenantId()` at least once". `_loom-backend.ts` makes that
 * binding in eight functions, so a ninth taking the tenant from the request body
 * inherited their good name and the guard stayed green on the one mutation that
 * is actually exploitable. That is why a name now qualifies only when EVERY
 * assignment to it is the estate constant.
 *
 * The import check had the same disease in reverse: the first draft tested it
 * against the MASKED text, where a module specifier — being a string literal —
 * has already been blanked, so the pattern could never match. It asserted
 * nothing while reading as a third control. It now runs against RAW (M5a/M5b).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONSOLE = resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(CONSOLE, rel), 'utf-8');

/** Blank out block comments, line comments and string/template literals so a
 *  scan sees CODE only. Replaces with spaces to keep offsets stable. */
function maskCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop); i = stop; continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * The FIRST argument of the call whose `(` sits at `open`, paren-balanced.
 *
 * A naive `\(([^,)]*)` stops at the `)` inside `sharingOwnerTenantId()` and
 * reports the argument as `sharingOwnerTenantId(` — which would make this guard
 * fail on correct code, and (worse) is the kind of near-miss that gets "fixed"
 * by loosening the assertion until it matches anything.
 */
function firstArgument(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i).replace(/\s+/g, '');
    } else if (ch === ',' && depth === 1) {
      return code.slice(open + 1, i).replace(/\s+/g, '');
    }
  }
  return code.slice(open + 1).replace(/\s+/g, '');
}

// ─── §1 documentation: the container no longer claims a tenant boundary ─────

describe('§1 the single-estate assumption is stated where the container is defined', () => {
  it('cosmos-client does not describe the sharing container as tenant-partitioned', () => {
    const src = read('lib/azure/cosmos-client.ts');
    const decl = src.indexOf("mk('sharing', '/tenantId')");
    expect(decl, "the sharing container declaration must exist").toBeGreaterThan(-1);
    // The comment block immediately above the declaration.
    const block = src.slice(Math.max(0, decl - 600), decl);
    const sharingComment = block.slice(block.lastIndexOf('// Loom Sharing'));
    expect(sharingComment, 'a Loom Sharing comment must precede the declaration').toBeTruthy();
    expect(
      sharingComment,
      'the sharing container must not be called "tenant-partitioned" — the key is single-valued (#2620)',
    ).not.toMatch(/tenant-\s*\/\/?\s*partitioned|tenant-partitioned/);
    expect(
      sharingComment,
      'the declaration must say what /tenantId actually is: a co-location key, not a boundary',
    ).toMatch(/NOT a tenant boundary/);
  });

  it('the store spells out the single-estate assumption and what would change it', () => {
    const src = read('lib/sharing/store.ts');
    expect(src).toMatch(/SINGLE-ESTATE ASSUMPTION/);
    expect(src).toMatch(/CO-LOCATES, IT DOES NOT ISOLATE/);
    // The false claim itself is gone.
    expect(src, 'the "ONE tenant-partitioned container" claim must be gone (#2620)')
      .not.toMatch(/ONE tenant-partitioned container/);
    // It names the constant, names the real boundary, and names the option-(b)
    // work — so a reader is not left to infer any of the three.
    expect(src).toMatch(/sharingOwnerTenantId\(\)/);
    expect(src).toMatch(/recipientCanAccessShare/);
    expect(src).toMatch(/session\.claims\.tid/);
  });

  it('sharingOwnerTenantId documents that it is the single source of the key', () => {
    const src = read('lib/sharing/recipient-auth.ts');
    const doc = src.slice(0, src.indexOf('export function sharingOwnerTenantId'));
    expect(doc.slice(doc.lastIndexOf('/**'))).toMatch(/SINGLE SOURCE/);
  });
});

// ─── §2 chokepoint: the key never comes from the session ────────────────────

/** Every production module that calls the sharing store. */
const CALL_SITES = [
  'lib/sharing/recipient-auth.ts',
  'app/api/delta-sharing/[...path]/route.ts',
  'app/api/marketplace/sharing/_loom-backend.ts',
] as const;

/** Store functions whose FIRST argument is the container's partition key. */
const PK_FIRST_ARG = [
  'listShares', 'getShare', 'deleteShare',
  'listRecipients', 'getRecipient', 'deleteRecipient',
] as const;

describe('§2 the partition key is never derived from session claims', () => {
  it.each(CALL_SITES)('%s reads no tenant from the session', (rel) => {
    const raw = read(rel);
    const code = maskCommentsAndStrings(raw);
    // The two shapes a session-derived tenant takes in this codebase.
    expect(code, `${rel} must not read claims.tid for the sharing partition key (#2620)`)
      .not.toMatch(/\bclaims\s*\.\s*tid\b/);
    expect(code, `${rel} must not use tenantScopeId() for the sharing partition key (#2620)`)
      .not.toMatch(/\btenantScopeId\s*\(/);
    // Checked against RAW, not `code`: a module specifier IS a string literal,
    // so the mask has already blanked it. The first draft asserted this against
    // the masked text, where the pattern can never match — a check that could
    // not fail, which is worse than no check. Type-only imports are fine (they
    // erase); a VALUE import of the session helpers is what must not appear.
    expect(raw, `${rel} must not value-import the session/tenant-scope helpers (#2620)`)
      .not.toMatch(/import\s+(?!type\b)[^;]*from\s*['"]@\/lib\/auth\/session['"]/);
  });

  it.each(CALL_SITES)('%s passes sharingOwnerTenantId() to every store read/write', (rel) => {
    const raw = read(rel);
    const code = maskCommentsAndStrings(raw);

    // Resolve `import { listShares as listLoomShares, … } from './store'` (or
    // from '@/lib/sharing/store') to real store names. Read from RAW: the module
    // specifier is a string literal, which the mask has already blanked out.
    const localToStoreFn = new Map<string, string>();
    const importRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](\.\/store|[^'"]*lib\/sharing\/store)['"]/g;
    for (const m of raw.matchAll(importRe)) {
      for (const spec of m[1].split(',')) {
        const [orig, alias] = spec.split(/\s+as\s+/).map((s) => s.trim());
        if (!orig) continue;
        if ((PK_FIRST_ARG as readonly string[]).includes(orig)) localToStoreFn.set(alias || orig, orig);
      }
    }
    expect(localToStoreFn.size, `${rel} must import at least one partition-keyed store function`)
      .toBeGreaterThan(0);

    // Identifiers bound to the estate constant in this file.
    //
    // A name qualifies only when EVERY assignment to it is exactly
    // `sharingOwnerTenantId()`. Collecting "names assigned from the constant
    // at least once" is NOT enough and was the first draft of this guard:
    // _loom-backend.ts binds `const tenantId = sharingOwnerTenantId()` in eight
    // separate functions, so a NINTH function writing
    // `const tenantId = body?.tenantId ?? sharingOwnerTenantId()` — a
    // caller-controlled partition key, the genuinely exploitable shape — rode in
    // on its siblings' good binding and the guard stayed green (M3 below).
    const assignments = new Map<string, string[]>();
    const record = (name: string, rhs: string) => {
      const list = assignments.get(name) ?? [];
      list.push(rhs.replace(/\s+/g, ''));
      assignments.set(name, list);
    };
    for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*([^;]+);/g)) record(m[1], m[2]);
    for (const m of code.matchAll(/^[ \t]*(\w+)\s*=\s*([^;]+);/gm)) record(m[1], m[2]);

    const estateBound = new Set<string>(['sharingOwnerTenantId()']);
    for (const [name, rhsList] of assignments) {
      if (rhsList.every((r) => r === 'sharingOwnerTenantId()')) estateBound.add(name);
    }

    const names = [...localToStoreFn.keys()].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const callRe = new RegExp(String.raw`\b(${names.join('|')})\s*\(`, 'g');
    let seen = 0;
    for (const c of code.matchAll(callRe)) {
      seen++;
      const open = c.index! + c[0].length - 1;
      const firstArg = firstArgument(code, open);
      expect(
        estateBound.has(firstArg),
        `${rel}: ${c[1]}(${firstArg}, …) — the sharing partition key must be the estate `
        + 'constant sharingOwnerTenantId(), never a session-derived tenant (#2620). '
        + `Seen: "${firstArg}"; allowed: ${[...estateBound].join(', ')}`,
      ).toBe(true);
    }
    expect(seen, `${rel} must actually call the store`).toBeGreaterThan(0);
  });
});

// ─── §3 CONTROL: behaviour is unchanged — one partition, the env constant ───

const TENANT = '11111111-2222-3333-4444-555555555555';
const OID = '99999999-8888-7777-6666-555555555555';

/** Fake Cosmos that RECORDS every partition key it is handed. */
const docs = new Map<string, any>();
const partitionKeysSeen: string[] = [];

vi.mock('@/lib/azure/cosmos-client', () => ({
  sharingContainer: vi.fn(async () => ({
    items: {
      query: (spec: { query: string; parameters: Array<{ name: string; value: string }> }) => ({
        fetchAll: async () => {
          const tenant = spec.parameters.find((p) => p.name === '@t')?.value ?? '';
          partitionKeysSeen.push(tenant);
          const kind = spec.query.includes("'share'") ? 'share' : 'recipient';
          return { resources: [...docs.values()].filter((d) => d.tenantId === tenant && d.kind === kind) };
        },
      }),
      upsert: async (doc: any) => {
        partitionKeysSeen.push(doc.tenantId ?? '');
        docs.set(doc.id, JSON.parse(JSON.stringify(doc)));
        return { resource: doc };
      },
    },
    item: (id: string, pk: string) => {
      partitionKeysSeen.push(pk);
      return {
        read: async () => ({ resource: docs.get(id) }),
        delete: async () => { docs.delete(id); },
      };
    },
  })),
}));

// The recipient path needs a verified bearer to reach listRecipients; only the
// token verifier is faked, so the tenant resolution under test is the real one.
vi.mock('@/lib/azure/entra-bearer-verify', () => ({
  verifyEntraBearer: vi.fn(async () => ({ ok: true, claims: { objectId: OID, appId: undefined } })),
}));

const SAVED = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID',
  'LOOM_SHARING_URL', 'LOOM_SHARING_SCOPE', 'LOOM_SHARING_ENABLED'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  docs.clear();
  partitionKeysSeen.length = 0;
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_SHARING_URL = 'https://loom-sharing.internal';
  // Pins the recipient credential so authenticateRecipient does not 503 early.
  process.env.LOOM_SHARING_SCOPE = 'Sharing.Read';
});
afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('§3 CONTROL — behaviour is unchanged by the documentation fix', () => {
  it('sharingOwnerTenantId resolves the estate env chain, in order', async () => {
    const { sharingOwnerTenantId } = await import('../recipient-auth');
    expect(sharingOwnerTenantId()).toBe(TENANT);

    delete process.env.LOOM_ENTRA_TENANT_ID;
    process.env.LOOM_MSAL_TENANT_ID = 'msal-tid';
    expect(sharingOwnerTenantId()).toBe('msal-tid');

    delete process.env.LOOM_MSAL_TENANT_ID;
    process.env.AZURE_TENANT_ID = 'azure-tid';
    expect(sharingOwnerTenantId()).toBe('azure-tid');

    delete process.env.AZURE_TENANT_ID;
    expect(sharingOwnerTenantId()).toBe('');
  });

  it('the ADMIN path writes and reads exactly one partition — the env constant', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    expect((await be.loomCreateShare({ name: 'share-a' }, 'admin@estate.gov')).status).toBe(200);
    expect((await be.loomCreateRecipient({ name: 'agency-a', principalIds: [OID] }, 'admin@estate.gov')).status).toBe(200);
    const listed = await (await be.loomListShares({ full: true })).json();
    expect(listed.shares.map((s: any) => s.name)).toEqual(['share-a']);

    expect(partitionKeysSeen.length).toBeGreaterThan(0);
    expect([...new Set(partitionKeysSeen)]).toEqual([TENANT]);
  });

  it('the RECIPIENT path resolves the SAME single partition, with no session involved', async () => {
    const be = await import('@/app/api/marketplace/sharing/_loom-backend');
    await be.loomCreateRecipient({ name: 'agency-a', principalIds: [OID] }, 'admin@estate.gov');
    partitionKeysSeen.length = 0;

    const { authenticateRecipient } = await import('../recipient-auth');
    const result = await authenticateRecipient('Bearer opaque-test-token');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.recipient.id).toBe('agency-a');

    // The external recipient has no Loom session at all, so this value can only
    // have come from the estate env — which is exactly the finding in #2620.
    expect([...new Set(partitionKeysSeen)]).toEqual([TENANT]);
  });
});
