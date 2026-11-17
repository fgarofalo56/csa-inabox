import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayConfig } from '../src/config.js';
import type { Pdp, PdpRequest } from '../src/pdp.js';
import type { AuditEvent } from '../src/audit.js';
import { createGateway } from '../src/server.js';

export interface ArchiveHit {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  bytes: number;
}

export interface StubArchive {
  server: Server;
  url: string;
  hits: ArchiveHit[];
  studies: Map<string, Buffer>;
  close(): Promise<void>;
}

const AET = 'DCM4CHEE';
const RS = `/dcm4chee-arc/aets/${AET}/rs`;

/** A stand-in for one tenant's dcm4chee: QIDO JSON, WADO bytes, STOW sink. */
export async function stubArchive(tenantLabel: string, studies: Record<string, Buffer>): Promise<StubArchive> {
  const hits: ArchiveHit[] = [];
  const store = new Map(Object.entries(studies));
  const server = createServer((req, res) => {
    const hit: ArchiveHit = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, bytes: 0 };
    hits.push(hit);
    req.on('data', (c: Buffer) => {
      hit.bytes += c.length;
    });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/dicom+json' });
        res.end(JSON.stringify({ '00081190': { vr: 'UR', Value: [`${url()}${RS}/studies/1.2.3`] }, tenantLabel }));
        return;
      }
      if (u.pathname === `${RS}/studies`) {
        const limit = Number(u.searchParams.get('limit') ?? '0');
        const rows = [...store.keys()].slice(0, limit).map((uid) => ({
          '0020000D': { vr: 'UI', Value: [uid] },
          '00081190': { vr: 'UR', Value: [`${url()}${RS}/studies/${uid}`] },
        }));
        if (rows.length === 0) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/dicom+json' });
        res.end(JSON.stringify(rows));
        return;
      }
      const m = /^\/dcm4chee-arc\/aets\/DCM4CHEE\/rs\/studies\/([0-9.]+)$/.exec(u.pathname);
      const body = m ? store.get(m[1]!) : undefined;
      if (body) {
        res.writeHead(200, { 'content-type': 'multipart/related; type="application/dicom"', 'content-length': body.length, 'set-cookie': 'archive=1', server: 'dcm4chee' });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port; // cached: address() is null after close
  const url = (): string => `http://127.0.0.1:${port}`;
  return {
    server,
    get url() {
      return url();
    },
    hits,
    studies: store,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Token grammar of the stub PDP: "<tenant>.<role>". It mirrors the real PDP's
 * observable rules for DICOM (roles only; exact tenant match; unknown token ->
 * token-invalid), so the gateway's handling of each reason is exercised.
 */
export function stubPdp(seen: PdpRequest[] = []): Pdp {
  return async (token, request) => {
    seen.push(request);
    const m = /^([a-z0-9-]+)\.(reader|writer|none)$/.exec(token);
    if (!m) return { kind: 'deny', reason: 'token-invalid', policyVersion: 'v1' };
    if (m[1] !== request.tenant) return { kind: 'deny', reason: 'tenant-mismatch', policyVersion: 'v1' };
    const ok = request.interaction === 'stow' ? m[2] === 'writer' : m[2] === 'reader' || m[2] === 'writer';
    return ok ? { kind: 'allow', reason: 'permit', policyVersion: 'v1' } : { kind: 'deny', reason: 'role-denied', policyVersion: 'v1' };
  };
}

export function baseConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: 0,
    pdpUrl: 'http://pdp.invalid',
    pdpTimeoutMs: 500,
    publicBase: 'https://stamp.health.example',
    archiveUrlTemplate: 'http://archive.invalid/{tenant}',
    archiveAet: AET,
    stowMaxBytes: 4 * 1024 ** 3,
    qidoMaxLimit: 200,
    qidoDefaultLimit: 100,
    rewriteMaxBytes: 16 * 1024 * 1024,
    archiveTimeoutMs: 5000,
    ...over,
  };
}

export interface Gateway {
  url: string;
  audit: AuditEvent[];
  close(): Promise<void>;
}

/** Start the gateway; `archives` maps tenant slug -> that tenant's stub archive. */
export async function startGateway(opts: { archives: Record<string, StubArchive>; pdp?: Pdp; auditThrows?: boolean; cfg?: Partial<GatewayConfig> }): Promise<Gateway> {
  const audit: AuditEvent[] = [];
  const server = createGateway({
    cfg: baseConfig(opts.cfg),
    pdp: opts.pdp ?? stubPdp(),
    resolveArchive: (t) => {
      const a = opts.archives[t];
      if (!a) throw new Error(`no stub archive for ${t}`);
      return a.url;
    },
    audit: (e) => {
      if (opts.auditThrows && e.phase === 'decision') throw new Error('audit sink down');
      audit.push(e);
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    audit,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface Res {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export function call(
  url: string,
  path: string,
  o: { method?: string; token?: string; headers?: Record<string, string>; body?: Buffer | NodeJS.ReadableStream; contentLength?: number } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, url);
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.contentLength !== undefined) headers['content-length'] = String(o.contentLength);
    const r = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (o.body === undefined) r.end();
    else if (Buffer.isBuffer(o.body)) r.end(o.body);
    else o.body.pipe(r);
  });
}
