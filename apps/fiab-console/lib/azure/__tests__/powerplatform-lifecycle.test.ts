/**
 * Contract tests for the Power Platform environment lifecycle client surface
 * (createEnvironment / updateEnvironment / deleteEnvironment /
 * getEnvironmentLifecycleOperation). Each test stubs `fetch` and asserts the
 * exact BAP URL / method / body / async-op handling so a wire-format
 * regression is caught.
 *
 * Grounded in Microsoft Learn:
 *   - Host/path/api-version: power-platform/admin/list-environments
 *       https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments
 *   - Create params → properties: New-AdminPowerAppEnvironment
 *       (-DisplayName / -Location / -EnvironmentSku / -ProvisionDatabase /
 *        -CurrencyName / -LanguageName) → { properties: { displayName,
 *        environmentSku, linkedEnvironmentMetadata: { baseLanguage, currency } } }
 *   - Delete is async (202 + Location header): Remove-AdminPowerAppEnvironment
 *   - Poll terminal on Succeeded/Failed/Canceled; 404 on a delete op = removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two DISTINGUISHABLE credential classes (#3957). The UAMI chain and the
 * Dataverse confidential SP return different tokens, so a test can read the
 * bearer that actually went on the wire instead of trusting a label — the same
 * anti-drift shape `power-platform-auth-principal.test.ts` uses. Every existing
 * case here ignores the token value, so this is additive.
 */
const UAMI_TOKEN = 'token-from-managed-identity';
const DATAVERSE_SP_TOKEN = 'token-from-client-secret-credential';

vi.mock('@azure/identity', () => {
  class UamiCred { async getToken() { return { token: UAMI_TOKEN, expiresOnTimestamp: Date.now() + 3600_000 }; } }
  class SecretCred { async getToken() { return { token: DATAVERSE_SP_TOKEN, expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: UamiCred, ManagedIdentityCredential: UamiCred,
    ChainedTokenCredential: UamiCred, ClientSecretCredential: SecretCred,
  };
});

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env.LOOM_UAMI_CLIENT_ID = 'uami-1';
  delete process.env.LOOM_BAP_BASE;
  delete process.env.LOOM_POWER_PLATFORM_BAP_BASE;
  delete process.env.LOOM_BAP_LIFECYCLE_API_VERSION;
  // The principal the hint names is selected from the scope, and the Dataverse
  // credential is resolved from these at module load. Pinned so an ambient
  // value in CI cannot flip which principal a case is asserting about.
  delete process.env.LOOM_DATAVERSE_CLIENT_ID;
  delete process.env.LOOM_DATAVERSE_CLIENT_SECRET;
  delete process.env.LOOM_DATAVERSE_TENANT_ID;
  delete process.env.LOOM_MSAL_CLIENT_ID;
  delete process.env.LOOM_MSAL_CLIENT_SECRET;
  delete process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
  delete process.env.AZURE_TENANT_ID;
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
});

/** Configure a fully-formed Dataverse confidential SP (module-load read). */
function withDataverseSp() {
  process.env.LOOM_DATAVERSE_CLIENT_ID = 'dataverse-app-id';
  process.env.LOOM_DATAVERSE_CLIENT_SECRET = 'dataverse-secret';
  process.env.LOOM_DATAVERSE_TENANT_ID = 'tenant-id';
}

/** The bearer a captured call carried, e.g. `Bearer token-from-…`. */
function authOf(call: { init?: RequestInit }): string {
  const h = (call.init?.headers || {}) as Record<string, string>;
  return h.authorization || h.Authorization || '';
}

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string>; contentType?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json', ...(r.headers || {}) },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('createEnvironment', () => {
  it('POSTs the BAP admin environments endpoint with api-version + location and a { properties } body', async () => {
    const calls = captureFetch(() => ({ status: 202, body: { status: 'Running' }, headers: { 'operation-location': 'https://api.bap.microsoft.com/op/123' } }));
    const { createEnvironment } = await import('../powerplatform-client');
    const op = await createEnvironment({ displayName: 'HQ Apps', environmentSku: 'Sandbox', location: 'unitedstates' });

    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toContain('/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments');
    expect(calls[0].url).toContain('api-version=2021-04-01');
    expect(calls[0].url).toContain('location=unitedstates');

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.properties.displayName).toBe('HQ Apps');
    expect(sent.properties.environmentSku).toBe('Sandbox');
    // No Dataverse → no linkedEnvironmentMetadata in the body.
    expect(sent.properties.linkedEnvironmentMetadata).toBeUndefined();

    // Async op handle captured from the Operation-Location header.
    expect(op.operationUrl).toBe('https://api.bap.microsoft.com/op/123');
    expect(op.done).toBe(false);
    expect(op.status).toBe('Running');
  });

  it('includes linkedEnvironmentMetadata (baseLanguage + currency) when a Dataverse db is requested', async () => {
    const calls = captureFetch(() => ({ status: 202, body: {} }));
    const { createEnvironment } = await import('../powerplatform-client');
    await createEnvironment({
      displayName: 'Dev', environmentSku: 'Trial', location: 'europe',
      dataverse: { baseLanguage: 1033, currency: 'USD', templates: ['D365_Sales'], securityGroupId: 'sg-1' },
    });
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.properties.linkedEnvironmentMetadata).toEqual({
      baseLanguage: 1033,
      currency: { code: 'USD' },
      templates: ['D365_Sales'],
      securityGroupId: 'sg-1',
    });
  });

  it('reports a terminal Failed op when the body status is Failed', async () => {
    captureFetch(() => ({ body: { status: 'Failed', error: { code: 'x', message: 'no capacity' } } }));
    const { createEnvironment } = await import('../powerplatform-client');
    const op = await createEnvironment({ displayName: 'X', environmentSku: 'Sandbox', location: 'asia' });
    expect(op.done).toBe(true);
    expect(op.status).toBe('Failed');
    expect(op.error?.message).toBe('no capacity');
  });
});

describe('updateEnvironment', () => {
  it('PATCHes the named environment with a { properties } body (rename)', async () => {
    const calls = captureFetch(() => ({ body: { status: 'Succeeded' } }));
    const { updateEnvironment } = await import('../powerplatform-client');
    await updateEnvironment('Env-X', { displayName: 'Renamed', description: 'updated' });
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toMatch(/\/scopes\/admin\/environments\/Env-X\?api-version=2021-04-01/);
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.properties.displayName).toBe('Renamed');
    expect(sent.properties.description).toBe('updated');
  });
});

describe('deleteEnvironment', () => {
  it('DELETEs the named environment and returns the async op handle from the Location header', async () => {
    const calls = captureFetch(() => ({ status: 202, body: {}, headers: { location: 'https://api.bap.microsoft.com/op/del-9' } }));
    const { deleteEnvironment } = await import('../powerplatform-client');
    const op = await deleteEnvironment('Env-Y');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toMatch(/\/scopes\/admin\/environments\/Env-Y\?api-version=2021-04-01/);
    expect(op.operationUrl).toBe('https://api.bap.microsoft.com/op/del-9');
    expect(op.status).toBe('Running'); // 202 with no body status → Running
    expect(op.done).toBe(false);
  });
});

describe('getEnvironmentLifecycleOperation', () => {
  it('GETs the operation url and is terminal on Succeeded', async () => {
    const calls = captureFetch(() => ({ body: { status: 'Succeeded' } }));
    const { getEnvironmentLifecycleOperation } = await import('../powerplatform-client');
    const op = await getEnvironmentLifecycleOperation('https://api.bap.microsoft.com/op/123');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].url).toBe('https://api.bap.microsoft.com/op/123');
    expect(op.done).toBe(true);
    expect(op.status).toBe('Succeeded');
  });

  it('treats a 404 on a delete-op url as a terminal Succeeded (environment fully removed)', async () => {
    captureFetch(() => ({ status: 404, body: { error: { message: 'not found' } } }));
    const { getEnvironmentLifecycleOperation } = await import('../powerplatform-client');
    const op = await getEnvironmentLifecycleOperation('https://api.bap.microsoft.com/op/del-9');
    expect(op.done).toBe(true);
    expect(op.status).toBe('Succeeded');
  });
});

describe('error handling', () => {
  it('surfaces a 403 from the BAP create with the SHARED helper\'s remediation copy', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const { createEnvironment } = await import('../powerplatform-client');
    const err: any = await createEnvironment({ displayName: 'X', environmentSku: 'Sandbox', location: 'asia' })
      .catch((e) => e);

    expect(err.status).toBe(403);
    // NOT `stringContaining('Power Platform')`, which is what this line used to
    // assert. The PRE-#3688 inline string it sits directly on contains the words
    // "Power Platform" THREE times, so that assertion could not discriminate the
    // broken copy from the fixed one — a reviewer reverted `bapCallWithHeaders`
    // to its byte-exact pre-fix state underneath this test and it stayed green.
    // These two substrings appear ONLY in the shared `ppAuthHint` copy.
    expect(err.hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(err.hint).toContain('New-PowerAppManagementApp');
    // …and the pre-fix directive must not come back.
    expect(err.hint).not.toContain('Confirm the Console UAMI SP is added to');
  });
});

// ===========================================================================
// #3957 — the hint must describe the scope the request was ISSUED under
// ===========================================================================
//
// WHY THIS BLOCK EXISTS. `bapCallWithHeaders` called `bapScope()` TWICE — once
// for the transport, once for `ppAuthHint` — with an `await` on the network in
// between. `ppCall` binds its scope once and reuses it; this site did not, so
// nothing forced the scope the remediation DESCRIBES to be the scope that went
// on the wire.
//
// The round-2 reviewer's `probe4.mjs` measured the consequence: feed the hint
// site eight different scopes and all eight produced a BYTE-IDENTICAL string,
// because `bapScope()` is never a Dataverse scope, and every non-Dataverse
// scope collapses to `console-uami` in `spCredentialFor`. The argument was
// inert AT THIS SITE and no test placed there could see a mutation to it.
//
// Two shapes had no fixture, and both are exercised below:
//   A. the env moves between the wire call and the hint (the binding itself);
//   B. `LOOM_BAP_BASE` points at a Dataverse-shaped host, which is the ONLY
//      input under which this site's two hint arms can differ at all.

describe('#3957 — the BAP lifecycle hint follows the WIRE scope, not a re-read', () => {
  it('COUNTERFACTUAL: env moving mid-call cannot repoint the hint at another principal', async () => {
    // `powerPlatformEndpoints()` is pure over `process.env` and deliberately
    // uncached ("so a runtime env change and unit tests both take effect"), so
    // two `bapScope()` calls straddling an await are two independent reads.
    // Here the request goes out on the CONTROL PLANE with the UAMI's token, and
    // the config changes before the denial is rendered.
    withDataverseSp();
    const calls = captureFetch(() => {
      process.env.LOOM_BAP_BASE = 'https://contoso.crm.dynamics.com';
      return { status: 403, body: { error: { message: 'forbidden' } } };
    });
    const { createEnvironment } = await import('../powerplatform-client');
    const err: any = await createEnvironment({ displayName: 'X', environmentSku: 'Sandbox', location: 'asia' })
      .catch((e) => e);

    // POPULATION + WIRE TRUTH: exactly one outbound call, on the control-plane
    // host, carrying the UAMI's distinguishable token. So the copy below is
    // checked against the credential that really minted, not an empty array.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.bap.microsoft.com');
    expect(authOf(calls[0])).toBe(`Bearer ${UAMI_TOKEN}`);

    expect(err.status).toBe(403);
    // With two independent reads the hint re-derives from the NEW env and says
    // "This Dataverse call was made by the Dataverse application registration
    // … NOT the Console UAMI" — a principal the code never used, on a host that
    // is not Dataverse. That is deploy-integrity R7: the message asserts as
    // fact something the code did not establish.
    expect(err.hint).toContain('LOOM_UAMI_CLIENT_ID');
    expect(err.hint).toContain('New-PowerAppManagementApp');
    expect(err.hint).not.toContain('LOOM_DATAVERSE_CLIENT_ID');
    expect(err.hint).not.toContain('NOT the Console UAMI');
  });

  it('a Dataverse-shaped LOOM_BAP_BASE names the Dataverse app — the arm that makes the argument observable', async () => {
    // NOT a counterfactual for the binding: with a stable env both reads agree,
    // so this passes before and after the fix. Its job is different — it is the
    // ONE fixture at this call site where the hint's two arms can differ, so a
    // hard-coded control-plane literal (#3688's exact defect, which shipped
    // HERE twice) now fails a test instead of passing every one.
    withDataverseSp();
    process.env.LOOM_BAP_BASE = 'https://contoso.crm.dynamics.com';
    const calls = captureFetch(() => ({ status: 403, body: { error: { message: 'forbidden' } } }));
    const { deleteEnvironment } = await import('../powerplatform-client');
    const err: any = await deleteEnvironment('Env-Z').catch((e) => e);

    expect(authOf(calls[0])).toBe(`Bearer ${DATAVERSE_SP_TOKEN}`);
    expect(err.status).toBe(403);
    expect(err.hint).toContain('LOOM_DATAVERSE_CLIENT_ID');
    expect(err.hint).toContain('NOT the Console UAMI');
    expect(err.hint).not.toContain('LOOM_UAMI_CLIENT_ID');
  });

  it('the third principal state is reachable here too: no Dataverse SP → granting the UAMI cannot help', async () => {
    // Same shape, Dataverse credential ABSENT. The wire falls through to the
    // UAMI, which Microsoft accepts as a Dataverse Application User under no
    // grant — so the copy must say so rather than ask for one. All three
    // `PpSpPrincipal` states are now exercised THROUGH `bapCallWithHeaders`.
    process.env.LOOM_BAP_BASE = 'https://contoso.crm.dynamics.com';
    const calls = captureFetch(() => ({ status: 401, body: { error: { message: 'unauthorized' } } }));
    const { updateEnvironment } = await import('../powerplatform-client');
    const err: any = await updateEnvironment('Env-Z', { displayName: 'r' }).catch((e) => e);

    expect(authOf(calls[0])).toBe(`Bearer ${UAMI_TOKEN}`);
    expect(err.status).toBe(401);
    expect(err.hint).toContain('No Dataverse service principal is configured');
    expect(err.hint).toContain('Granting the UAMI will not help');
  });
});

// ===========================================================================
// #3957 §2 — a STATIC backstop for the ppAuthHint population
// ===========================================================================
//
// The behavioural cases above cover the two call sites that exist. They cannot
// cover the one that does not exist yet: measured at filing time, `ppAuthHint`
// had 2 production call sites and **0** static guards preventing a third from
// passing a literal or a re-derived scope. A third site added tomorrow with a
// hard-coded scope would pass every test in this repo.
//
// So this reads the client's SOURCE and enforces the binding structurally: at
// every `ppAuthHint(...)` call site, the second argument must be a bare
// identifier, and it must be the SAME identifier handed to the transport in
// the same function. `ppAuthHint(triedUser, bapScope())` fails it (a call
// expression, i.e. a second read); `ppAuthHint(triedUser, BAP_SCOPE_LITERAL)`
// fails it; `ppAuthHint(triedUser, someOtherScope)` fails it.

const CLIENT_SRC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../powerplatform-client.ts');

/**
 * The comma-separated argument sources of the call whose `(` is at `open`.
 * Depth-aware and quote-aware; good enough for these call shapes and it fails
 * loudly (throws) rather than silently returning a wrong slice.
 */
function callArgs(src: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0; let start = open + 1; let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = ''; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { out.push(src.slice(start, i)); return out.map((s) => s.trim()); }
      continue;
    }
    if (c === ',' && depth === 1) { out.push(src.slice(start, i)); start = i + 1; }
  }
  throw new Error(`unbalanced call starting at offset ${open}`);
}

/** Every offset at which `name(` appears as a call (not a definition). */
function callSites(src: string, name: string): number[] {
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  const out: number[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m.index + m[0].length - 1);
  return out;
}

/** Split the module into top-level `function <name>` bodies. */
function functionChunks(src: string): Array<{ name: string; body: string }> {
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
  const marks: Array<{ name: string; at: number }> = [];
  for (let m = re.exec(src); m; m = re.exec(src)) marks.push({ name: m[1], at: m.index });
  return marks.map((mk, i) => ({
    name: mk.name,
    body: src.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : src.length),
  }));
}

describe('#3957 §2 — every ppAuthHint call site is BOUND to the scope it issued the request under', () => {
  const src = readFileSync(CLIENT_SRC_PATH, 'utf8');
  const chunks = functionChunks(src);

  it('the guard actually has a population to measure (a zero-site pass would be hollow)', () => {
    // The failure mode this repo has been bitten by: the matcher stops matching,
    // the loop below runs zero times, and the suite goes green having checked
    // nothing. Two sites were measured at filing time; the floor is 2.
    expect(callSites(src, 'ppAuthHint').length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.name)).toContain('ppCall');
    expect(chunks.map((c) => c.name)).toContain('bapCallWithHeaders');
  });

  it('the second argument is a bare identifier — never a re-read, never a literal', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const { name, body } of chunks) {
      for (const open of callSites(body, 'ppAuthHint')) {
        checked++;
        const args = callArgs(body, open);
        if (args.length !== 2) { bad.push(`${name}: ppAuthHint takes 2 args, saw ${args.length}`); continue; }
        if (!/^[A-Za-z_$][\w$]*$/.test(args[1])) {
          bad.push(`${name}: scope argument \`${args[1]}\` is not a bound identifier`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(bad).toEqual([]);
  });

  it('that identifier is the SAME one handed to the transport in the same function', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const { name, body } of chunks) {
      const hints = callSites(body, 'ppAuthHint');
      if (!hints.length) continue;
      const transports = callSites(body, 'ppFetch').concat(callSites(body, 'powerPlatformFetch'));
      if (!transports.length) {
        bad.push(`${name}: emits a hint but issues no transport call here — the binding cannot be checked`);
        continue;
      }
      const wire = transports.map((o) => callArgs(body, o)[1]);
      for (const open of hints) {
        checked++;
        const scopeArg = callArgs(body, open)[1];
        if (!wire.includes(scopeArg)) {
          bad.push(`${name}: hint scope \`${scopeArg}\` is not the wire scope (${wire.join(' | ')})`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(bad).toEqual([]);
  });
});
