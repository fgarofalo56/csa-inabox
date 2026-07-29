/**
 * POST /api/items/user-data-function/[id]/invoke — the invoke destination may
 * only be an operator-configured endpoint (issue #2652).
 *
 * THE BUG THIS PINS: `state.azureFunctionUrl` and `state.functionKeySecret` are
 * arbitrary JSON any authenticated user can write through
 * `PATCH /api/items/user-data-function/<id>`. Before the fix the route fetched
 * whatever host the item named AND attached `x-functions-key`, whose value is
 * ANY secret in the Loom Key Vault — a one-request exfiltration of the MSAL
 * client secret, git PATs, connection strings, to an attacker-controlled host.
 *
 * Hermetic: session, Cosmos item load, and Key Vault are mocked; the endpoint
 * policy (lib/azure/function-endpoint-policy.ts) runs for real, and `fetch` is
 * captured so the test asserts on the ACTUAL outbound destination + headers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'o1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }),
}));
vi.mock('@/lib/azure/arm-credential', () => ({
  uamiArmCredential: () => ({ getToken: async () => ({ token: 'FABRIC-TOKEN' }) }),
}));

const getKeyVaultSecretValueMock = vi.fn(async () => 'SUPER-SECRET-VALUE');
vi.mock('@/lib/azure/kv-secrets-client', () => ({
  getKeyVaultSecretValue: (...a: any[]) => getKeyVaultSecretValueMock(...(a as [])),
  vaultUrl: () => 'https://loomkv.vault.azure.net',
}));

const loadOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

import { POST } from '../route';

const APPROVED = 'https://loom-udf-runtime.internal.example.io';
const ctx = { params: Promise.resolve({ id: 'udf1' }) };
const req = (body: any) => ({ json: async () => body }) as any;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOOM_UDF_FUNCTION_BASE = APPROVED;
  delete process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES;
  delete process.env.LOOM_UDF_BACKEND;
  delete process.env.LOOM_UDF_HOST_KEY;
  fetchSpy = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOOM_UDF_FUNCTION_BASE;
});

describe('destination is taken from config, not from item state', () => {
  it('REFUSES an attacker-chosen host and never reads the Key Vault secret', async () => {
    loadOwnedItemMock.mockResolvedValue({
      state: {
        azureFunctionUrl: 'https://attacker.example',
        functionKeySecret: 'loom-msal-client-secret',
        source: 'def f():\n    return 1\n',
      },
    });

    const res = await POST(req({ functionName: 'f' }), ctx);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.gated).toBe(true);
    // No outbound request at all — not "a request with the secret stripped".
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the secret was never even fetched, so it cannot leak via an error path.
    expect(getKeyVaultSecretValueMock).not.toHaveBeenCalled();
  });

  it('REFUSES a look-alike host that merely starts with the approved base', async () => {
    loadOwnedItemMock.mockResolvedValue({
      state: { azureFunctionUrl: `${APPROVED}.attacker.example`, functionKeySecret: 'loom-msal-client-secret' },
    });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getKeyVaultSecretValueMock).not.toHaveBeenCalled();
  });

  it('REFUSES userinfo smuggling of the approved host', async () => {
    loadOwnedItemMock.mockResolvedValue({
      state: { azureFunctionUrl: `${APPROVED}@attacker.example`, functionKeySecret: 'kv-secret' },
    });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still invokes the CONFIGURED runtime when the item names no override', async () => {
    loadOwnedItemMock.mockResolvedValue({ state: { source: 'def f():\n    return 1\n' } });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${APPROVED}/api/f`);
  });

  it('accepts an override an operator explicitly approved, and sends the key there', async () => {
    process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES = 'https://my-fn.azurewebsites.net';
    loadOwnedItemMock.mockResolvedValue({
      state: { azureFunctionUrl: 'https://my-fn.azurewebsites.net', functionKeySecret: 'udf-fnapp-key' },
    });
    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://my-fn.azurewebsites.net/api/f');
    expect((fetchSpy.mock.calls[0][1] as any).headers['x-functions-key']).toBe('SUPER-SECRET-VALUE');
  });

  it('sends the UDF host key with pushed source so the runtime will execute it', async () => {
    process.env.LOOM_UDF_HOST_KEY = 'HOSTKEY123';
    loadOwnedItemMock.mockResolvedValue({ state: { source: 'def f():\n    return 1\n' } });
    await POST(req({ functionName: 'f' }), ctx);
    const headers = (fetchSpy.mock.calls[0][1] as any).headers;
    expect(headers['x-udf-source-b64']).toBeTruthy();
    expect(headers['x-loom-udf-key']).toBe('HOSTKEY123');
  });
});

describe('the opt-in Fabric branch obeys the same rule', () => {
  it('REFUSES an item-chosen Fabric endpoint and never mints a Fabric token for it', async () => {
    process.env.LOOM_UDF_BACKEND = 'fabric';
    delete process.env.LOOM_UDF_FUNCTION_BASE;
    loadOwnedItemMock.mockResolvedValue({ state: { fabricEndpoint: 'https://attacker.example/ws/item' } });

    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a Fabric endpoint under the configured host', async () => {
    process.env.LOOM_UDF_BACKEND = 'fabric';
    process.env.LOOM_FABRIC_UDF_HOST = 'https://fabric-udf.example.com';
    delete process.env.LOOM_UDF_FUNCTION_BASE;
    loadOwnedItemMock.mockResolvedValue({ state: { fabricEndpoint: 'https://fabric-udf.example.com/ws1/item1' } });

    const res = await POST(req({ functionName: 'f' }), ctx);
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://fabric-udf.example.com/ws1/item1/functions/f/invoke');
    delete process.env.LOOM_FABRIC_UDF_HOST;
  });
});
