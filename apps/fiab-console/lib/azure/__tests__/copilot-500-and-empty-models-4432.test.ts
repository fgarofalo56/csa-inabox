/**
 * Regression tests for #4432 — "AI copilot not working": every chat turn
 * answered `Error: HTTP 500`, and the tenant AI-model pickers rendered empty.
 *
 * Both symptoms were measured on the live Commercial estate on 2026-09-10 from
 * inside the `loom-console` container, and each has its own root cause. These
 * tests reproduce BOTH at the unit level and fail against the pre-fix code.
 *
 * ── Symptom 1: HTTP 500 on every chat turn ────────────────────────────────
 * `LOOM_CONTENT_SAFETY_ENDPOINT` is set on the console, so `isSafetyConfigured()`
 * is true and every turn screens the prompt. The endpoint's host does NOT resolve
 * from inside the container (measured: `ENOTFOUND`; positive controls
 * `aifndry-loom-centralus.openai.azure.com` and `management.azure.com` resolve).
 * `shieldPrompt` / `moderateContent` documented "fail-open on a transient Content
 * Safety error" but only implemented it for a non-2xx response — a THROWN fetch
 * escaped, propagated out of the un-wrapped orchestrate route, and became a bare
 * Next.js 500 with a non-JSON body, which the chat pane rendered as the literal
 * causeless string "Error: HTTP 500".
 *
 * ── Symptom 2: empty AI-model pickers ─────────────────────────────────────
 * `Accounts_List` is RBAC-filtered PER PAGE. Measured with the console UAMI:
 * `GET /subscriptions/{sub}/providers/Microsoft.CognitiveServices/accounts`
 * returned HTTP 200 with `value: []` AND a `nextLink` — while that subscription
 * holds three Cognitive Services accounts. The client read `body.value` only and
 * dropped `nextLink`, so it reported an empty list as a SUCCESS. No error was
 * raised anywhere, so no gate rendered: a claim of absence the code never
 * established (deploy-integrity.md R7).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

// ---------------------------------------------------------------------------
// Symptom 1 — content safety must fail OPEN on an unreachable endpoint
// ---------------------------------------------------------------------------

describe('#4432 / content safety fails open when the endpoint is unreachable', () => {
  const EP = 'https://cog-contentsafety-loom.cognitiveservices.azure.com';

  beforeEach(() => { process.env.LOOM_CONTENT_SAFETY_ENDPOINT = EP; });
  afterEach(() => { delete process.env.LOOM_CONTENT_SAFETY_ENDPOINT; });

  /** The exact shape Node's undici raises for an unresolvable host. */
  function dnsFailureFetch() {
    return vi.fn(async () => {
      const e: any = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      throw e;
    });
  }

  it('shieldPrompt returns blocked:false instead of throwing (ENOTFOUND)', async () => {
    vi.stubGlobal('fetch', dnsFailureFetch());
    const m = await import('../foundry-client');
    // Pre-fix this REJECTED, which is what became the bare 500.
    const v = await m.shieldPrompt('how do I build a lakehouse?');
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe('');
  });

  it('moderateContent returns blocked:false instead of throwing (ENOTFOUND)', async () => {
    vi.stubGlobal('fetch', dnsFailureFetch());
    const m = await import('../foundry-client');
    const v = await m.moderateContent('how do I build a lakehouse?');
    expect(v.blocked).toBe(false);
    expect(v.reason).toBe('');
  });

  it('Promise.all of both — the exact orchestrate pre-flight — resolves', async () => {
    vi.stubGlobal('fetch', dnsFailureFetch());
    const m = await import('../foundry-client');
    await expect(
      Promise.all([m.shieldPrompt('hi'), m.moderateContent('hi')]),
    ).resolves.toHaveLength(2);
  });

  it('warns with the REAL cause rather than silently swallowing it (R7)', async () => {
    vi.stubGlobal('fetch', dnsFailureFetch());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await import('../foundry-client');
    await m.shieldPrompt('hi');
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/ENOTFOUND/);
    // Failing open means the prompt was NOT screened — say so, don't imply a pass.
    expect(said).toMatch(/NOT screened/i);
  });

  it('still fails open on a timeout, not just a DNS failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e: any = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }));
    const m = await import('../foundry-client');
    await expect(m.moderateContent('hi')).resolves.toMatchObject({ blocked: false });
  });

  it('contentSafetyHealth reports NOT reachable when the host does not resolve', async () => {
    vi.stubGlobal('fetch', dnsFailureFetch());
    const m = await import('../foundry-client');
    const h = await m.contentSafetyHealth();
    // The old `isSafetyConfigured()` env read said `true` here — a claim of
    // "prompts are filtered" that nothing established (R7).
    expect(m.isSafetyConfigured()).toBe(true);
    expect(h.configured).toBe(true);
    expect(h.reachable).toBe(false);
    expect(String(h.error)).toMatch(/ENOTFOUND/);
    expect(String(h.error)).toMatch(/NOT being screened/i);
  });

  it('contentSafetyHealth reports reachable when the endpoint answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ categoriesAnalysis: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const m = await import('../foundry-client');
    await expect(m.contentSafetyHealth()).resolves.toMatchObject({ configured: true, reachable: true });
  });

  it('contentSafetyHealth reports neither configured nor reachable when unset', async () => {
    delete process.env.LOOM_CONTENT_SAFETY_ENDPOINT;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const m = await import('../foundry-client');
    await expect(m.contentSafetyHealth()).resolves.toMatchObject({ configured: false, reachable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a real block verdict still blocks — fail-open did not disable screening', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ categoriesAnalysis: [{ category: 'Violence', severity: 6 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    const m = await import('../foundry-client');
    const v = await m.moderateContent('violent text');
    expect(v.blocked).toBe(true);
    expect(v.category).toBe('Violence');
  });
});

// ---------------------------------------------------------------------------
// Symptom 2 — ARM list paging
// ---------------------------------------------------------------------------

describe('#4432 / ARM list paging behind the empty AI-model pickers', () => {
  beforeEach(() => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
    delete process.env.LOOM_AOAI_ACCOUNT;
    delete process.env.LOOM_AOAI_RG;
    delete process.env.LOOM_AOAI_SUB;
    delete process.env.LOOM_FOUNDRY_SUB;
    delete process.env.LOOM_EXTRA_SUBSCRIPTIONS;
  });

  const ACCOUNT = {
    id: '/subscriptions/sub-1/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/aifndry-loom',
    name: 'aifndry-loom',
    kind: 'AIServices',
    location: 'centralus',
    properties: { endpoint: 'https://aifndry-loom.openai.azure.com/' },
  };

  /**
   * Reproduces the MEASURED live shape: page 1 of the RBAC-filtered account list
   * is empty but carries a $skiptoken; the accounts arrive on page 2.
   */
  function pagedFetch() {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      seen.push(u);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

      if (u.includes('/subscriptions?') || u.endsWith('/subscriptions')) {
        return json({ value: [{ subscriptionId: 'sub-1', state: 'Enabled' }] });
      }
      if (u.includes('/providers/Microsoft.CognitiveServices/accounts')) {
        if (u.includes('$skiptoken=page2')) return json({ value: [ACCOUNT] });
        return json({
          value: [],
          nextLink:
            'https://management.azure.com/subscriptions/sub-1/providers/Microsoft.CognitiveServices/accounts' +
            '?api-version=2024-10-01&$skiptoken=page2',
        });
      }
      return json({ value: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    return seen;
  }

  it('listAccounts follows nextLink — an empty first page is NOT "no accounts"', async () => {
    const seen = pagedFetch();
    const { listAccounts } = await import('../foundry-cs-client');
    const out = await listAccounts();
    // Pre-fix this was [] because only page 1 was read.
    expect(out.map((a) => a.name)).toEqual(['aifndry-loom']);
    expect(seen.some((u) => u.includes('$skiptoken=page2'))).toBe(true);
  });

  it('listModelDeployments follows nextLink across pages', async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/deployments')) {
        if (u.includes('$skiptoken=d2')) {
          return json({ value: [{ name: 'strong', properties: { model: { name: 'gpt-4.1' } } }] });
        }
        return json({
          value: [{ name: 'chat', properties: { model: { name: 'gpt-4o' } } }],
          nextLink: 'https://management.azure.com/deployments?api-version=2024-10-01&$skiptoken=d2',
        });
      }
      // resolveAccount(selector) — the single-account GET.
      return json(ACCOUNT);
    }));
    const { listModelDeployments } = await import('../foundry-cs-client');
    const { deployments } = await listModelDeployments({ name: 'aifndry-loom', rg: 'rg-foundry', sub: 'sub-1' });
    expect(deployments.map((d) => d.name)).toEqual(['chat', 'strong']);
  });

  it('listAccountsDetailed REPORTS a swallowed per-subscription failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/subscriptions?') || u.endsWith('/subscriptions')) {
        return new Response(JSON.stringify({ value: [{ subscriptionId: 'sub-1', state: 'Enabled' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { message: 'Authorization failed' } }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }));
    const { listAccountsDetailed } = await import('../foundry-cs-client');
    const { accounts, failures } = await listAccountsDetailed();
    expect(accounts).toEqual([]);
    // Pre-fix the 403 was swallowed and indistinguishable from "no accounts".
    expect(failures).toHaveLength(1);
    expect(failures[0].status).toBe(403);
    expect(failures[0].subscriptionId).toBe('sub-1');
  });

  it('a 404 on the first page still means absent (readJson contract preserved)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/subscriptions?') || u.endsWith('/subscriptions')) {
        return new Response(JSON.stringify({ value: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    }));
    const { resolveAccount, CsNotConfiguredError } = await import('../foundry-cs-client');
    await expect(resolveAccount(true, { name: 'nope', rg: 'rg-foundry', sub: 'sub-1' }))
      .rejects.toBeInstanceOf(CsNotConfiguredError);
  });

  it('bounds paging so a self-referential nextLink cannot hang the request', async () => {
    let pages = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('/subscriptions?') || u.endsWith('/subscriptions')) {
        return json({ value: [{ subscriptionId: 'sub-1', state: 'Enabled' }] });
      }
      pages++;
      return json({
        value: [],
        nextLink: 'https://management.azure.com/loop?api-version=2024-10-01&$skiptoken=forever',
      });
    }));
    const { listAccounts } = await import('../foundry-cs-client');
    await expect(listAccounts()).resolves.toEqual([]);
    expect(pages).toBeLessThanOrEqual(50);
  });
});
