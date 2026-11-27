// Pinned trust for the CP's OWN stamp ingress (interim until #5495: Front Door + a publicly trusted cert).
//
// The stamp ingress serves the self-signed certificate this control plane issues into the stamp Key
// Vault (ingress-cert.ts, #5345). Node's default trust store rejects it (DEPTH_ZERO_SELF_SIGNED_CERT),
// so any CP -> stamp-ingress call (the AS patient picker's FHIR search) failed before a byte was sent.
//
// StampIngressTrust.fetch is a fetch for exactly ONE origin, `https://<stamp fqdn>`: requests to that
// origin go through a node:https Agent whose CA list is Node's default roots PLUS the PUBLIC certificate
// the CP read back from the vault; every other origin goes to the ordinary global fetch, so nothing else
// in the process trusts the stamp cert. Hostname verification stays ON (Node's default
// checkServerIdentity; the certificate's CN/SAN is the stamp FQDN). The pin refreshes whenever the
// ingress-cert timer reads a different certificate, and the previous one stays trusted alongside it so
// a gateway still serving the old version does not fail during the rotation. Until a certificate has
// been read, or when the vault returned one that cannot be used, the stamp origin falls back to the
// default trust and a distinct reason is logged.
//
// Only certificate METADATA is ever handled here (the base64 DER `cer` field); never a key or secret.

import { X509Certificate } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';

/** Response bodies over this size are refused: the picker reads at most a 20-entry Bundle. */
export const PINNED_MAX_BODY_BYTES = 8 * 1024 * 1024;

export type StampTrustState =
  | { pinned: true; fingerprints: string[] }
  | { pinned: false; reason: string };

export interface StampIngressTrustOptions {
  /** The stamp ingress FQDN: the certificate subject CN and SAN, and the only host pinned. */
  fqdn: string;
  log: (event: string, fields: Record<string, string | number>) => void;
  /** Port of the pinned origin; 443 in production. Tests use a local server's port. */
  port?: number;
  /** Every non-stamp origin, and the stamp origin while nothing is pinned. Default: the global fetch at call time. */
  fallback?: typeof fetch;
}

const NO_CERT_YET = 'the ingress certificate has not been read from the vault yet';

export class StampIngressTrust {
  readonly origin: string;
  private readonly fqdn: string;
  private readonly log: StampIngressTrustOptions['log'];
  private readonly fallback: StampIngressTrustOptions['fallback'];
  /** Newest first, at most two distinct PEMs. */
  private pems: string[] = [];
  private fingerprints: string[] = [];
  private agent: Agent | undefined;
  private unpinnedReason = NO_CERT_YET;

  constructor(o: StampIngressTrustOptions) {
    this.fqdn = o.fqdn.toLowerCase();
    this.origin = new URL(`https://${this.fqdn}${o.port && o.port !== 443 ? `:${o.port}` : ''}`).origin;
    this.log = o.log;
    this.fallback = o.fallback;
  }

  state(): StampTrustState {
    return this.agent ? { pinned: true, fingerprints: [...this.fingerprints] } : { pinned: false, reason: this.unpinnedReason };
  }

  /**
   * The vault's `cer` (base64 DER of the public certificate) from the read that found it valid. A
   * different certificate re-pins; the same one is a no-op. An unusable value keeps any existing pin
   * (the ingress is still serving it) and, with none, records the reason the default trust is in use.
   */
  setCertificate(cer: string | undefined): void {
    if (typeof cer !== 'string' || cer.trim() === '') return this.unusable('the vault returned no public certificate (cer)');
    let x: X509Certificate;
    try {
      x = new X509Certificate(Buffer.from(cer.trim(), 'base64'));
    } catch {
      return this.unusable('the vault certificate could not be parsed as X.509');
    }
    if (x.checkHost(this.fqdn) === undefined) return this.unusable('the vault certificate does not name the stamp FQDN');
    const fp = x.fingerprint256;
    if (this.fingerprints[0] === fp) return;
    const pem = x.toString();
    this.pems = [pem, ...this.pems.filter((p) => p !== pem)].slice(0, 2);
    this.fingerprints = [fp, ...this.fingerprints.filter((f) => f !== fp)].slice(0, 2);
    this.agent = pinnedAgent(this.pems);
    this.log('tls.stamp_trust_pinned', { origin: this.origin, certs: this.pems.length, fingerprint: fp });
  }

  private unusable(reason: string): void {
    if (this.agent) {
      this.log('tls.stamp_trust_kept', { origin: this.origin, reason });
      return;
    }
    this.unpinnedReason = reason;
    this.log('tls.stamp_trust_default', { origin: this.origin, reason });
  }

  /** fetch for the AS's FHIR calls: pinned for the stamp origin only, the ordinary fetch for everything else. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const fallback = this.fallback ?? globalThis.fetch;
    if (url.origin !== this.origin) return fallback(input, init);
    if (!this.agent) {
      this.log('tls.stamp_trust_default', { origin: this.origin, reason: this.unpinnedReason });
      return fallback(input, init);
    }
    return pinnedRequest(this.agent, url, init);
  };
}

/**
 * The Agent for the stamp origin: Node's default roots PLUS the pinned PEMs. Chain and hostname verification
 * are Node's defaults (never disabled here). keepAlive is off, so a rotated agent holds no pooled sockets and
 * dropping the reference is enough.
 */
export function pinnedAgent(pems: readonly string[]): Agent {
  return new Agent({ ca: [...rootCertificates, ...pems], keepAlive: false });
}

/** Same error shape as undici's fetch: TypeError('fetch failed') with the socket/TLS error as `cause`. */
const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause });

/**
 * A minimal fetch over node:https for one Agent. Redirects are never followed (a redirect off the pinned
 * origin would leave the pin's scope); a 3xx rejects unless redirect is 'manual'.
 */
export function pinnedRequest(agent: Agent, url: URL, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    return Promise.reject(new TypeError('pinnedRequest supports string bodies only'));
  }
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const done = (f: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      f();
    };
    const req = httpsRequest(url, { method: init.method ?? 'GET', headers, agent });
    function onAbort(): void {
      req.destroy();
      done(() => reject(signal?.reason));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => done(() => reject(fetchFailed(e))));
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && init.redirect !== 'manual') {
        res.resume();
        req.destroy();
        return done(() => reject(fetchFailed(new Error('redirect refused'))));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > PINNED_MAX_BODY_BYTES) {
          req.destroy();
          done(() => reject(fetchFailed(new Error('response body too large'))));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (e) => done(() => reject(fetchFailed(e))));
      res.on('end', () =>
        done(() => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
            else if (typeof v === 'string') h.set(k, v);
          }
          const noBody = status === 204 || status === 205 || status === 304;
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: h }));
        }),
      );
    });
    if (typeof body === 'string') req.write(body);
    req.end();
  });
}
