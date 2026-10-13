/**
 * Structural advisory guard, NOT an exploit reproduction or security scan.
 * 1.1.1 / 2.1.1 or a missing mirror must fail the version test. Worker tests
 * measure compatibility of the deliberate Vitest 3 -> tinypool 2 override:
 * wrong export/channel/transferList, reversed operands, or retained isolated
 * state must fail. The APIs match Vitest 3.2.7's published createForksPool /
 * createThreadsPool (including named run, teardown, and recycleWorkers).
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const consoleRequire = createRequire(join(root, 'package.json'));
const vitestRequire = createRequire(consoleRequire.resolve('vitest/package.json'));
const tinypoolEntry = vitestRequire.resolve('tinypool');
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');

const workerSource = `
import { isMainThread } from 'node:worker_threads';
let calls = 0;
export async function run({ a, b, port }) {
  const count = ++calls;
  const reply = await new Promise((resolve) => {
    if (port) {
      port.once('message', resolve);
      port.postMessage('ready');
    } else {
      const listener = (message) => {
        if (message?.__tinypool_worker_message__) return;
        process.off('message', listener);
        resolve(message);
      };
      process.on('message', listener);
      process.send('ready');
    }
  });
  port?.close();
  return { result: a - b, reply, count,
    runtime: isMainThread ? 'child_process' : 'worker_threads' };
}
export function teardown() {}
`;

describe('tinypool minimum patched version and Vitest calling modes', () => {
  it('locks and actually resolves 2.1.2 from Vitest, with both pnpm mirrors', () => {
    const versions = [...lock.matchAll(/^ {2}tinypool@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]);
    // Exact positive set: deletion and adding a second vulnerable entry fail.
    expect(versions).toEqual(['2.1.2', '2.1.2']);
    expect(lock).toMatch(/^ {6}tinypool: 2\.1\.2$/m);
    expect(lock).toMatch(/^ {2}vitest>tinypool: 2\.1\.2$/m);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(manifest.pnpm.overrides['vitest>tinypool']).toBe('2.1.2');
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
      .toMatch(/^ {2}'vitest>tinypool': '2\.1\.2'$/m);
    const installed = JSON.parse(readFileSync(join(dirname(tinypoolEntry), '..', 'package.json'), 'utf8'));
    expect(installed.version).toBe('2.1.2');
  });

  for (const runtime of ['child_process', 'worker_threads'] as const) {
    for (const isolateWorkers of [true, false]) {
      it(`${runtime} supports named run, bidirectional RPC, isolation=${isolateWorkers}, recycle and destroy`, async () => {
        const { default: Tinypool } = await import(/* @vite-ignore */ pathToFileURL(tinypoolEntry).href);
        const tempRoot = join(root, '..', '..', 'temp');
        mkdirSync(tempRoot, { recursive: true });
        const temp = mkdtempSync(join(tempRoot, 'tinypool-worker-'));
        const filename = join(temp, 'worker.mjs');
        writeFileSync(filename, workerSource);
        const pool = new Tinypool({
          runtime, filename, teardown: 'teardown', isolateWorkers,
          minThreads: 1, maxThreads: 1, concurrentTasksPerWorker: 1,
          useAtomics: false, execArgv: [], terminateTimeout: 5_000,
        });
        const invoke = async (count: number) => {
          const { port1, port2 } = new MessageChannel();
          let send: ((message: unknown) => void) | undefined;
          let ready: unknown;
          try {
            const result = runtime === 'child_process'
              ? await pool.run({ a: 17, b: 5 }, {
                name: 'run',
                channel: {
                  onMessage(listener: (message: unknown) => void) { send = listener; },
                  postMessage(message: unknown) { ready = message; send?.('ack'); },
                },
              })
              : await (() => {
                port2.once('message', (message) => { ready = message; port2.postMessage('ack'); });
                return pool.run({ a: 17, b: 5, port: port1 }, {
                  name: 'run', transferList: [port1],
                  channel: { onClose() { port1.close(); port2.close(); } },
                });
              })();
            expect(ready).toBe('ready');
            expect(result).toEqual({ result: 12, reply: 'ack', count, runtime });
          } finally {
            port1.close();
            port2.close();
          }
        };
        try {
          await invoke(1);
          await invoke(isolateWorkers ? 1 : 2);
          await pool.recycleWorkers();
          await invoke(1);
        } finally {
          await pool.destroy();
          rmSync(temp, { recursive: true, force: true });
        }
        // Leaving even one worker behind makes this fail.
        expect(pool.threads).toHaveLength(0);
      });
    }
  }
});
