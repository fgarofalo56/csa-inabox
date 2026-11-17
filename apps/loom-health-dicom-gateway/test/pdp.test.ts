import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpPdp } from '../src/pdp.js';

const REQ = { service: 'dicom', interaction: 'qido', tenant: 'acme', base: 'https://s/acme/dicomweb' } as const;
let srv: Server | undefined;

async function opa(handler: (body: string) => { status?: number; body?: string; delayMs?: number }, seen: string[] = []): Promise<string> {
  srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${b}`);
      const r = handler(b);
      setTimeout(() => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(r.body ?? '{}');
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}
afterEach(async () => {
  if (srv) await new Promise((r) => srv!.close(r));
  srv = undefined;
});

describe('PDP client: only result.allow === true permits', () => {
  it('sends the frozen decision input and returns allow (positive control)', async () => {
    const seen: string[] = [];
    const url = await opa(() => ({ body: JSON.stringify({ result: { allow: true, reason: 'permit', policy_version: 'p1', obligations: [] } }) }), seen);
    const d = await httpPdp(url, 1000)('RAW.JWT.TOKEN', REQ);
    expect(d).toEqual({ kind: 'allow', reason: 'permit', policyVersion: 'p1' });
    expect(seen[0]).toBe(`POST /v1/data/lhds/authz/decision ${JSON.stringify({ input: { access_token: 'RAW.JWT.TOKEN', request: REQ } })}`);
  });

  it('allow:false is deny and keeps the reason', async () => {
    const url = await opa(() => ({ body: JSON.stringify({ result: { allow: false, reason: 'tenant-mismatch', policy_version: 'p1' } }) }));
    expect(await httpPdp(url, 1000)('t', REQ)).toEqual({ kind: 'deny', reason: 'tenant-mismatch', policyVersion: 'p1' });
  });

  // Each row is an input that returns `allow` if the client were fail-open or loosely typed.
  const unavailable: Array<[string, { status?: number; body?: string; delayMs?: number }, string]> = [
    ['OPA undefined result ({})', { body: '{}' }, 'pdp-no-result'],
    ['5xx carrying an allow body', { status: 500, body: JSON.stringify({ result: { allow: true } }) }, 'pdp-http-500'],
    ['allow as the STRING "true"', { body: JSON.stringify({ result: { allow: 'true' } }) }, 'pdp-allow-not-boolean'],
    ['allow as 1', { body: JSON.stringify({ result: { allow: 1 } }) }, 'pdp-allow-not-boolean'],
    ['result without allow', { body: JSON.stringify({ result: { reason: 'permit' } }) }, 'pdp-allow-not-boolean'],
    ['result is null', { body: JSON.stringify({ result: null }) }, 'pdp-no-result'],
    ['malformed JSON', { body: '{"result":{"allow":true' }, 'pdp-error'],
    ['timeout (reply after the deadline) carrying allow', { delayMs: 400, body: JSON.stringify({ result: { allow: true } }) }, 'pdp-timeout'],
  ];
  it.each(unavailable)('%s -> unavailable, never allow', async (_n, reply, cause) => {
    const url = await opa(() => reply);
    const d = await httpPdp(url, 100)('t', REQ);
    expect(d).toEqual({ kind: 'unavailable', cause });
  });

  it('connection refused -> unavailable', async () => {
    const d = await httpPdp('http://127.0.0.1:1', 500)('t', REQ);
    expect(d.kind).toBe('unavailable');
  });
});
