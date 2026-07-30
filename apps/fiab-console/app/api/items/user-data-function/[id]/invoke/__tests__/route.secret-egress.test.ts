/**
 * POST /api/items/user-data-function/[id]/invoke — a Key Vault credential may
 * never be reachable from item state, and may never be sent to an endpoint that
 * executes item-supplied code.
 *
 * THE DEFECT THESE TESTS PIN
 *   `state.azureFunctionUrl` and `state.functionKeySecret` are arbitrary JSON any
 *   authenticated user can write through `PATCH /api/items/user-data-function/<id>`.
 *   The route read the named Key Vault secret with the Console's managed identity
 *   and sent it, as `x-functions-key`, to the named host.
 *
 *   PINNING THE HOST TO CONFIG ALONE IS NOT ENOUGH — and that is what the last
 *   attempt did. The deployment default for LOOM_UDF_FUNCTION_BASE is the
 *   `loom-udf-runtime` Container App, and that host EXECUTES this same item's
 *   `state.source` (it reads `x-udf-source-b64` per request). A credential
 *   delivered to the "approved" host therefore still lands inside code the caller
 *   wrote. Hence the invariant asserted below: the request that carries a
 *   credential and the request that carries source are never the same request.
 *
 * Hermetic: session, Cosmos item load, and Key Vault are mocked; the endpoint
 * policy runs for real and `fetch` is captured, so every assertion is on the
 * ACTUAL outbound destination and headers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'o1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }),
}));
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: async () => ({ token: 'FABRIC-UAMI-TOKEN' }) }),
}));

const kvRead = vi.fn(async () => 'SUPER-SECRET-VALUE');
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  getKeyVaultSecretValue: (...a: any[]) => kvRead(...(a as [])),
  vaultUrl: () => 'https://loomkv.vault.azure.net',
}));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

import { POST } from '../route';

/** The deployment default: the loom-udf-runtime Container App — a CODE-EXECUTION host. */
const RUNTIME = 'https://loom-udf-runtime.internal.example.io';
/** An Azure Function App an operator explicitly approved, with its own key secret. */
const APPROVED_FN = 'https://contoso-udf.azurewebsites.net';

const ctx = { params: Promise.resolve({ id: 'udf1' }) };
const req = (body: any) => ({ json: async () => body }) as any;

let fetchSpy: ReturnType<typeof vi.fn>;

/** Every header the route actually put on the wire, for call `i`. */
const sentHeaders = (i = 0): Record<string, string> =>
  ((fetchSpy.mock.calls[i]?.[1] as any)?.headers || {}) as Record<string, string>;
const sentUrl = (i = 0): string => String(fetchSpy.mock.calls[i]?.[0] ?? '');
/** Did the secret value leave the process, in ANY header or the body? */
const secretOnTheWire = (): boolean =>
  fetchSpy.mock.calls.some(([, init]) => {
    const s = JSON.stringify((init as any) ?? {});
    return s.includes('SUPER-SECRET-VALUE');
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
  delete process.env.LOOM_UDF_FUNCTION_KEY_SECRET;
  delete process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES;
  delete process.env.LOOM_UDF_BACKEND;
  delete process.env.LOOM_FABRIC_UDF_HOST;
  delete process.env.LOOM_FABRIC_UDF_ALLOWED_HOSTS;
  fetchSpy = vi.fn(async () => new Response('{"result":1}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOOM_UDF_FUNCTION_BASE;
});

describe('ATTACK: item state names the destination', () => {
  it('refuses an attacker-chosen host and never reads the Key Vault secret', async () => {
    loadOwnedItemMock.mockResolvedValue({
      state: {
        azureFunctionUrl: 'https://collector.attacker.example',
        functionKeySecret: 'loom-msal-client-secret',
        source: 'def f():\n    return 1\n',
      },
    });

    const res = await POST(req({ functionName: 'f' }), ctx);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.gated).toBe(true);
    // No outbound request at all — not "a request with the credential stripped".
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the secret was never even resolved, so no error path can echo it.
    expect(kvRead).not.toHaveBeenCalled();
  });

  it.each([
    ['a look-alike host that prefixes the approved base', `${RUNTIME}.attacker.example`],
    ['userinfo smuggling of the approved host', `${RUNTIME}@attacker.example`],
    ['an http downgrade of the approved host', RUNTIME.replace('https://', 'http://')],
    ['a scheme-relative reference', '//attacker.example'],
    ['a base carrying a query that truncates the path', `${RUNTIME}?x=`],
    ['a file: URL', 'file:///etc/passwd'],
    ['the IMDS endpoint', 'http://169.254.169.254/metadata/identity/oauth2/token'],
  ])('refuses %s', async (_label, azureFunctionUrl) => {
    loadOwnedItemMock.mockResolvedValue({ state: { azureFunctionUrl, functionKeySecret: 'loom-msal-client-secret' } });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(kvRead).not.toHaveBeenCalled();
  });
});

describe('ATTACK: item state names the CREDENTIAL, destination left at the approved default', () => {
  // This is the case the previous attempt missed. The host is the deployment's
  // own LOOM_UDF_FUNCTION_BASE — fully "approved" — but it executes this item's
  // state.source, so a credential delivered there is delivered to the attacker.
  it('never sends a state-named Key Vault secret to the deployment runtime', async () => {
    loadOwnedItemMock.mockResolvedValue({
      state: {
        // no azureFunctionUrl at all: the approved default is used
        functionKeySecret: 'loom-msal-client-secret',
        source: 'import os\ndef f():\n    return dict(os.environ)\n',
      },
    });

    const res = await POST(req({ functionName: 'f' }), ctx);

    // Honest refusal: the deployment configured no function key for this endpoint.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ gated: true, missing: 'LOOM_UDF_FUNCTION_KEY_SECRET' });
    expect(kvRead).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a state-named secret cannot ride along even when the operator DID configure a key', async () => {
    // The operator configured `udf-fnapp-key` for the runtime. An item asking for
    // a DIFFERENT secret must not silently get either one.
    process.env.LOOM_UDF_FUNCTION_KEY_SECRET = 'udf-fnapp-key';
    loadOwnedItemMock.mockResolvedValue({
      state: { functionKeySecret: 'loom-msal-client-secret', source: 'def f():\n    return 1\n' },
    });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(kvRead).not.toHaveBeenCalled();
    expect(secretOnTheWire()).toBe(false);
  });
});

describe('INVARIANT: a credential and caller-authored code never share a request', () => {
  it('a keyed endpoint gets the key and NOT the pushed source', async () => {
    process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES = `${APPROVED_FN}=contoso-udf-key`;
    loadOwnedItemMock.mockResolvedValue({
      state: { azureFunctionUrl: APPROVED_FN, functionKeySecret: 'contoso-udf-key', source: 'def f():\n    return 1\n' },
    });

    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(sentUrl()).toBe(`${APPROVED_FN}/api/f`);
    expect(sentHeaders()['x-functions-key']).toBe('SUPER-SECRET-VALUE');
    // The credential went to a host that runs ITS OWN deployed code, never ours.
    expect(sentHeaders()['x-udf-source-b64']).toBeUndefined();
    // The purpose is declared so a platform secret could not be substituted.
    expect(kvRead).toHaveBeenCalledWith('contoso-udf-key', 'udf-function-key');
    // And the response says so rather than pretending the authored source ran.
    expect((await res.json()).note).toMatch(/deployed code/i);
  });

  it('a source-executing endpoint gets the source and NO credential', async () => {
    loadOwnedItemMock.mockResolvedValue({ state: { source: 'def f():\n    return 1\n' } });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(sentUrl()).toBe(`${RUNTIME}/api/f`);
    expect(sentHeaders()['x-udf-source-b64']).toBeTruthy();
    expect(sentHeaders()['x-functions-key']).toBeUndefined();
    expect(kvRead).not.toHaveBeenCalled();
    expect(secretOnTheWire()).toBe(false);
  });
});

describe('the legitimate default path still works unchanged', () => {
  it('invokes the configured runtime when the item names no override', async () => {
    loadOwnedItemMock.mockResolvedValue({ state: { source: 'def f():\n    return 2\n' } });
    const res = await POST(req({ functionName: 'f', parameters: { a: 1 } }), ctx);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentUrl()).toBe(`${RUNTIME}/api/f`);
    expect((fetchSpy.mock.calls[0][1] as any).body).toBe('{"a":1}');
  });

  it('an operator-approved override is selected by the item and used verbatim from config', async () => {
    process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES = APPROVED_FN;
    // Trailing slash / differing case in the item's value: it SELECTS, the config
    // string is what gets fetched.
    loadOwnedItemMock.mockResolvedValue({ state: { azureFunctionUrl: `${APPROVED_FN.toUpperCase()}/` } });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(sentUrl()).toBe(`${APPROVED_FN}/api/f`);
  });

  it('gates honestly when no endpoint is configured at all', async () => {
    delete process.env.LOOM_UDF_FUNCTION_BASE;
    loadOwnedItemMock.mockResolvedValue({ state: {} });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ gated: true, missing: 'LOOM_UDF_FUNCTION_BASE' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the opt-in Fabric branch obeys the same rule', () => {
  it('refuses an item-chosen Fabric endpoint and never mints a token for it', async () => {
    process.env.LOOM_UDF_BACKEND = 'fabric';
    delete process.env.LOOM_UDF_FUNCTION_BASE;
    loadOwnedItemMock.mockResolvedValue({ state: { fabricEndpoint: 'https://attacker.example/ws/item' } });

    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rebuilds an item path beneath the CONFIGURED Fabric host', async () => {
    process.env.LOOM_UDF_BACKEND = 'fabric';
    process.env.LOOM_FABRIC_UDF_HOST = 'https://fabric-udf.example.com';
    delete process.env.LOOM_UDF_FUNCTION_BASE;
    loadOwnedItemMock.mockResolvedValue({ state: { fabricWorkspaceId: 'ws1', fabricItemId: 'it1' } });

    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(sentUrl()).toBe('https://fabric-udf.example.com/ws1/it1/functions/f/invoke');
    expect(sentHeaders().authorization).toBe('Bearer FABRIC-UAMI-TOKEN');
  });

  it('a state-named path may not escape the configured Fabric host', async () => {
    process.env.LOOM_UDF_BACKEND = 'fabric';
    process.env.LOOM_FABRIC_UDF_HOST = 'https://fabric-udf.example.com';
    delete process.env.LOOM_UDF_FUNCTION_BASE;
    loadOwnedItemMock.mockResolvedValue({
      state: { fabricEndpoint: 'https://fabric-udf.example.com.attacker.example/ws/it' },
    });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
