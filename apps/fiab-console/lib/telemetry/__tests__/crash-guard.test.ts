// @vitest-environment node
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { classifyUncaught, isClientAbort } from '../app-insights';

/** The error Node really emits when a client hangs up mid-request, captured from a live socket. */
async function realClientAbortError(): Promise<Error & { code?: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req) => {
      req.on('error', (e) => {
        server.close();
        resolve(e);
      });
      req.resume();
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      // Promise 100 bytes, send 5, then hang up: the server is mid-body when the socket dies.
      const c = request({ port, host: '127.0.0.1', method: 'POST', headers: { 'content-length': '100' } });
      c.on('error', () => undefined);
      c.write('hello');
      setTimeout(() => c.destroy(), 50);
    });
    setTimeout(() => reject(new Error('no abort error observed in 5s')), 5000).unref();
  });
}

describe('uncaughtException guard', () => {
  // Breaking value: a guard that rethrows this (the pre-fix behaviour) makes the replica exit 7.
  it('treats the error Node emits for a client hang-up as a client abort, not a process fault', async () => {
    const err = await realClientAbortError();
    // Precondition: the fixture is the real thing, so a Node change to the shape fails HERE, not silently below.
    expect(err.message).toBe('aborted');
    expect(err.code).toBe('ECONNRESET');
    expect(isClientAbort(err)).toBe(true);
    expect(classifyUncaught(err)).toBe('client-abort');
  });

  // Breaking value: widening the match to code alone (any ECONNRESET) swallows a real upstream fault.
  it('still rethrows an ECONNRESET from an OUTBOUND call and any other genuine fault', () => {
    const outbound = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyUncaught(outbound)).toBe('rethrow');
    // Same code and message but no http-server frame: not provably a client abort.
    const lookalike = Object.assign(new Error('aborted'), { code: 'ECONNRESET', stack: 'Error: aborted\n    at somewhere (app.js:1:1)' });
    expect(classifyUncaught(lookalike)).toBe('rethrow');
    expect(classifyUncaught(new TypeError('x is not a function'))).toBe('rethrow');
    expect(classifyUncaught(undefined)).toBe('rethrow');
  });

  // Breaking value: dropping the telemetry arm (the guard's original job).
  it('still swallows a telemetry-layer fault', () => {
    const t = Object.assign(new Error('boom'), { stack: 'Error: boom\n    at x (node_modules/@azure/monitor-opentelemetry/dist/a.js:1:1)' });
    expect(classifyUncaught(t)).toBe('telemetry');
  });
});
