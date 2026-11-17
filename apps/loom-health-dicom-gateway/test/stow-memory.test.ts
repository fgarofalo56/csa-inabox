import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createGateway } from '../src/server.js';
import { baseConfig, stubPdp } from './helpers.js';

// TEST-STRATEGY section 3 / ADR-004: a large STOW must stream, never buffer.
// Acceptance: RSS < 2x request size (fails above 4 GB for a 2 GB request).
//
// The default size is 512 MiB so the suite stays fast; LOOM_DICOM_GW_BIG_STOW=1 runs
// the full 2 GiB. The assertion is deliberately much tighter than the acceptance
// bound: a gateway that buffers the body grows RSS by about the body size (512 MiB
// here), which exceeds the 128 MiB ceiling below by 4x. A streaming gateway grows by
// a few socket buffers. The 2x-size acceptance bound would NOT catch a buffering
// gateway at this size (512 MiB < 1 GiB), so it is not the assertion used.
const BIG = process.env.LOOM_DICOM_GW_BIG_STOW === '1';
const SIZE = (BIG ? 2048 : 512) * 1024 * 1024;
const CEILING = 128 * 1024 * 1024;
const CHUNK = Buffer.alloc(1024 * 1024, 0x5a);

describe('streaming STOW: bounded memory', () => {
  it(`a ${SIZE / 1024 / 1024} MiB STOW grows RSS by < ${CEILING / 1024 / 1024} MiB and every byte reaches the archive`, async () => {
    // Sink archive: counts bytes, retains none.
    let received = 0;
    const sink = createServer((req, res) => {
      req.on('data', (c: Buffer) => {
        received += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/dicom+json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;


    const gw = createGateway({ cfg: baseConfig({ stowMaxBytes: 8 * 1024 ** 3 }), pdp: stubPdp(), audit: () => {}, resolveArchive: () => sinkUrl });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    const gwPort = (gw.address() as AddressInfo).port;

    // Warm up (JIT, socket buffers) then take the baseline.
    globalThis.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);

    const body = Readable.from(
      (async function* () {
        for (let sent = 0; sent < SIZE; sent += CHUNK.length) yield CHUNK; // one shared chunk: the CLIENT holds no copy either
      })(),
      { objectMode: false },
    );
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(
        { hostname: '127.0.0.1', port: gwPort, path: '/acme/dicomweb/v1/studies', method: 'POST', headers: { authorization: 'Bearer acme.writer', 'content-type': 'multipart/related; boundary=b', 'content-length': String(SIZE) } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      r.on('error', reject);
      body.pipe(r);
    });
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);

    await new Promise((r) => gw.close(r));
    await new Promise((r) => sink.close(r));

    expect(status).toBe(200);
    expect(received, 'every byte of the request must arrive at the archive').toBe(SIZE);
    const growth = peak - baseline;
    expect(growth, `RSS grew ${(growth / 1024 / 1024).toFixed(0)} MiB for a ${SIZE / 1024 / 1024} MiB body (buffering would be >= ${SIZE / 1024 / 1024})`).toBeLessThan(CEILING);
  }, 300_000);
});
