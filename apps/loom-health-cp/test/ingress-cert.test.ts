import { describe, expect, it } from 'vitest';
import {
  CERTIFICATES_OFFICER_ROLE,
  ensureIngressCertificate,
  IngressCertError,
  loadIngressCertConfig,
  type IngressCertConfig,
} from '../src/tls/ingress-cert.js';

const FQDN = 'lhds-dev-abc.eastus2.cloudapp.azure.com';
const NOW = new Date('2026-11-17T00:00:00Z');
const DAY = 86_400;
const nowSec = NOW.getTime() / 1000;

const cfg: IngressCertConfig = {
  cloud: 'commercial',
  vaultUrl: 'https://kv-lhds.vault.azure.net/',
  certName: 'lhds-ingress-selfsigned',
  fqdn: FQDN,
  renewBeforeDays: 30,
};

interface Call { method: string; url: string; body: string | undefined }

function certJson(over: { enabled?: boolean; exp?: number; subject?: string; dns?: string[] } = {}): unknown {
  return {
    attributes: { enabled: over.enabled ?? true, exp: over.exp ?? nowSec + 300 * DAY },
    policy: { x509_props: { subject: over.subject ?? `CN=${FQDN}`, sans: { dns_names: over.dns ?? [FQDN] } } },
  };
}

type Reply = { status: number; body?: unknown };

/** A vault fake: GETs answer from `gets` in order (last repeats); POST create answers `create`. */
function vault(gets: Reply[], create: Reply = { status: 202, body: {} }) {
  const calls: Call[] = [];
  let g = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(input), body: init?.body as string | undefined });
    const r = method === 'POST' ? create : gets[Math.min(g++, gets.length - 1)]!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const run = (v: ReturnType<typeof vault>, c: IngressCertConfig = cfg) =>
  ensureIngressCertificate({ cfg: c, getToken: async () => 't', fetchImpl: v.fetchImpl, now: () => NOW, sleep: async () => {}, pollAttempts: 3 });

describe('ensureIngressCertificate', () => {
  it('is a NO-OP on a valid certificate: no create call is made', async () => {
    // Input that breaks it: any implementation that POSTs /create when the certificate is valid
    // (calls would then contain a POST and the outcome would be "issued").
    const v = vault([{ status: 200, body: certJson() }]);
    expect(await run(v)).toBe('valid');
    expect(v.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('issues when the certificate is missing (404), with issuer Self and subject and SAN = the FQDN', async () => {
    // Breaks if the policy issuer is not Self, or the subject/SAN is not the stamp FQDN.
    const v = vault([{ status: 404 }, { status: 200, body: certJson() }]);
    expect(await run(v)).toBe('issued');
    const post = v.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${cfg.vaultUrl}certificates/${cfg.certName}/create?api-version=7.5`);
    const pol = (JSON.parse(post.body!) as { policy: Record<string, any> }).policy;
    expect(pol.issuer).toEqual({ name: 'Self' });
    expect(pol.x509_props.subject).toBe(`CN=${FQDN}`);
    expect(pol.x509_props.sans).toEqual({ dns_names: [FQDN] });
    expect(pol.lifetime_actions[0].trigger.days_before_expiry).toBe(30);
  });

  it('re-issues an EXPIRED-but-present certificate', async () => {
    // Input that breaks it: exp = now - 1 day, present and enabled. A check that only tests existence returns "valid".
    const v = vault([{ status: 200, body: certJson({ exp: nowSec - DAY }) }, { status: 200, body: certJson() }]);
    expect(await run(v)).toBe('issued');
    expect(v.calls.some((c) => c.method === 'POST')).toBe(true);
  });

  it('re-issues a certificate expiring inside renewBeforeDays but keeps one just outside it', async () => {
    // 29 days left (< 30) must re-issue; 31 days left must not. Breaks if the comparison is off by the window.
    const inside = vault([{ status: 200, body: certJson({ exp: nowSec + 29 * DAY }) }, { status: 200, body: certJson() }]);
    expect(await run(inside)).toBe('issued');
    const outside = vault([{ status: 200, body: certJson({ exp: nowSec + 31 * DAY }) }]);
    expect(await run(outside)).toBe('valid');
    expect(outside.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('re-issues when the subject is not the current FQDN (stale cert after an FQDN change)', async () => {
    const v = vault([{ status: 200, body: certJson({ subject: 'CN=old.example.com', dns: ['old.example.com'] }) }, { status: 200, body: certJson() }]);
    expect(await run(v)).toBe('issued');
  });

  it('a 403 names the role and the vault scope, and does not create anything', async () => {
    // Input that breaks it: a 403 on GET. A generic "key vault returned 403" message lacks the role name.
    const v = vault([{ status: 403, body: { error: { code: 'Forbidden', innererror: { code: 'ForbiddenByRbac' } } } }]);
    const err = await run(v).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngressCertError);
    const msg = (err as Error).message;
    expect(msg).toContain(CERTIFICATES_OFFICER_ROLE);
    expect(msg).toContain(cfg.vaultUrl);
    expect(v.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a firewall 403 is reported as a network problem, not as a missing role', async () => {
    const v = vault([{ status: 403, body: { error: { innererror: { code: 'ForbiddenByFirewall' } } } }]);
    const msg = ((await run(v).catch((e: unknown) => e)) as Error).message;
    expect(msg).toContain('ForbiddenByFirewall');
    expect(msg).not.toContain(CERTIFICATES_OFFICER_ROLE);
  });

  it('fails closed when the new certificate never becomes valid', async () => {
    const v = vault([{ status: 404 }], { status: 202, body: {} });
    await expect(run(v)).rejects.toThrow(/not enabled and valid after 3 checks/);
  });

  it('an unreachable vault is reported as unreached, not as a missing certificate', async () => {
    const fetchImpl = (async () => { throw new TypeError('getaddrinfo ENOTFOUND'); }) as typeof fetch;
    const err = await ensureIngressCertificate({ cfg, getToken: async () => 't', fetchImpl, now: () => NOW }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('could not reach vault');
  });
});

describe('loadIngressCertConfig', () => {
  const env = { LOOM_HEALTH_CP_TLS_VAULT_URL: 'https://kv-x.vault.azure.net/', LOOM_HEALTH_CP_TLS_FQDN: 'A.example.com' };
  it('is off with neither variable, and lowercases the FQDN when on', () => {
    expect(loadIngressCertConfig('commercial', {})).toBeUndefined();
    expect(loadIngressCertConfig('commercial', env)?.fqdn).toBe('a.example.com');
  });
  it('rejects a half-set pair', () => {
    expect(() => loadIngressCertConfig('commercial', { LOOM_HEALTH_CP_TLS_FQDN: 'a.example.com' })).toThrow(/together/);
  });
  it('requires the cloud vault suffix: a commercial host in gcc-high is rejected, usgovcloudapi accepted', () => {
    // Breaks if the suffix check is dropped or hard-coded to vault.azure.net.
    expect(() => loadIngressCertConfig('gcc-high', env)).toThrow(/vault\.usgovcloudapi\.net/);
    const gov = loadIngressCertConfig('gcc-high', { ...env, LOOM_HEALTH_CP_TLS_VAULT_URL: 'https://kv-x.vault.usgovcloudapi.net/' });
    expect(gov?.vaultUrl).toBe('https://kv-x.vault.usgovcloudapi.net/');
  });
  it('bounds renewBeforeDays to 1..300', () => {
    expect(() => loadIngressCertConfig('commercial', { ...env, LOOM_HEALTH_CP_TLS_RENEW_BEFORE_DAYS: '301' })).toThrow(/1 to 300/);
    expect(loadIngressCertConfig('commercial', { ...env, LOOM_HEALTH_CP_TLS_RENEW_BEFORE_DAYS: '300' })?.renewBeforeDays).toBe(300);
  });
});
