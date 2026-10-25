// Test seams. MemoryCollection is the fake for the Collection (Cosmos) seam;
// mintToken + the exported public key are the fake for the JWKS seam. Product
// code never imports this file.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { compose } from '../src/compose.js';
import { StoreConflictError } from '../src/http/errors.js';
import type { Collection, Doc, Stores } from '../src/store/types.js';

export class MemoryCollection<T extends Doc> implements Collection<T> {
  readonly docs = new Map<string, T>();
  private etag = 0;
  failWith: Error | undefined;

  private stamp(doc: T): T {
    return { ...structuredClone(doc), _etag: `e${++this.etag}` };
  }
  async get(id: string): Promise<T | undefined> {
    if (this.failWith) throw this.failWith;
    const d = this.docs.get(id);
    return d ? structuredClone(d) : undefined;
  }
  async list(limit: number): Promise<T[]> {
    if (this.failWith) throw this.failWith;
    return [...this.docs.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map((d) => structuredClone(d));
  }
  async create(doc: T): Promise<T> {
    if (this.docs.has(doc.id)) throw new StoreConflictError('exists');
    const s = this.stamp(doc);
    this.docs.set(doc.id, s);
    return structuredClone(s);
  }
  async replace(doc: T): Promise<T> {
    const cur = this.docs.get(doc.id);
    if (!cur || cur._etag !== doc._etag) throw new StoreConflictError('stale');
    const s = this.stamp(doc); // whole-document replace, like Cosmos
    this.docs.set(doc.id, s);
    return structuredClone(s);
  }
  async upsert(doc: T): Promise<T> {
    const s = this.stamp(doc);
    this.docs.set(doc.id, s);
    return structuredClone(s);
  }
}

export function memoryStores(): Stores & { [K in keyof Stores]: MemoryCollection<never> } {
  return {
    stamps: new MemoryCollection(),
    tenants: new MemoryCollection(),
    routing: new MemoryCollection(),
    jobs: new MemoryCollection(),
    slo: new MemoryCollection(),
  } as never;
}

export const TENANT = '11111111-1111-1111-1111-111111111111';
export const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
export const AUDIENCE = 'api://loom-health-cp-test';
export const AUTHORITY = 'login.microsoftonline.us';
export const ADMIN_APP = 'aaaaaaaa-0000-0000-0000-000000000001';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
export const testKeyResolver: JWTVerifyGetKey = async () => publicKey;

export interface TokenOpts {
  roles?: string[];
  aud?: string;
  iss?: string;
  tid?: string;
  azp?: string;
  expiresIn?: string;
  signWithOtherKey?: boolean;
}

export async function mintToken(o: TokenOpts = {}): Promise<string> {
  const tid = o.tid ?? TENANT;
  return new SignJWT({ roles: o.roles ?? [], azp: o.azp ?? ADMIN_APP, oid: 'oid-test-caller', tid })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.iss ?? `https://${AUTHORITY}/${tid}/v2.0`)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '5m')
    .sign(o.signWithOtherKey ? other.privateKey : privateKey);
}

export const adminToken = () => mintToken({ roles: ['HealthCP.Admin'] });
export const readerToken = () => mintToken({ roles: ['HealthCP.Reader'] });
export const reporterToken = () => mintToken({ roles: ['HealthCP.StampReporter'] });

export interface Harness {
  url: string;
  stores: ReturnType<typeof memoryStores>;
  logs: string[];
  app: ReturnType<typeof compose>;
  close(): Promise<void>;
  call(method: string, path: string, opts?: { token?: string; body?: unknown; raw?: string; contentType?: string }): Promise<{ status: number; json: any; headers: Headers }>;
}

export async function startHarness(
  over: { allowedCallerAppIds?: string[]; now?: () => Date; stores?: ReturnType<typeof memoryStores> } = {},
): Promise<Harness> {
  const stores = over.stores ?? memoryStores();
  const logs: string[] = [];
  const app = compose({
    stores,
    auth: {
      authorityHost: AUTHORITY,
      entraTenantId: TENANT,
      audiences: [AUDIENCE],
      allowedCallerAppIds: over.allowedCallerAppIds ?? [],
      keyResolver: testKeyResolver,
    },
    sloAvailabilityTarget: 0.999,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    now: over.now,
  });
  const server: Server = createServer((req, res) => void app.handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    stores,
    logs,
    app,
    close: () => new Promise<void>((r) => server.close(() => r())),
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      let body: string | undefined;
      if (opts.raw !== undefined) body = opts.raw;
      else if (opts.body !== undefined) body = JSON.stringify(opts.body);
      if (body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json';
      const res = await fetch(url + path, { method, headers, body });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
    },
  };
}

export const stampBody = (id = 'stamp-a') => ({
  id,
  displayName: `Stamp ${id}`,
  cloud: 'gcc-high',
  region: 'usgovvirginia',
  class: 'M',
  baseUrl: `https://${id}.health.example.us`,
});

export const tenantBody = (id = 'visn-01', stampId = 'stamp-a') => ({
  id,
  displayName: `Tenant ${id}`,
  stampId,
  quotas: { maxRequestsPerMinute: 6000, maxStorageGiB: 500 },
});
