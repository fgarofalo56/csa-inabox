import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ spawn: vi.fn(), getToken: vi.fn(), suffix: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: m.spawn }));
vi.mock('../aca-managed-identity', () => ({ loomServerCredential: { getToken: m.getToken } }));
vi.mock('../cloud-endpoints', () => ({ aasSuffix: m.suffix }));
import { probeAasServer } from '../aas-readiness';
const uri = 'asazure://eastus.asazure.windows.net/verified';
let child: EventEmitter & { stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }; stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  m.suffix.mockReturnValue('asazure.windows.net');
  m.getToken.mockResolvedValue({ token: 'SECRET', expiresOnTimestamp: Date.now() + 60000 });
  child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(), kill: vi.fn(),
  });
  m.spawn.mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());
async function start() {
  const pending = probeAasServer(uri, 'verified');
  await Promise.resolve();
  return { pending };
}
it.each([0, 3])('accepts %i catalogs without claiming query success', async (catalogCount) => {
  const { pending } = await start();
  child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, catalogCount })));
  child.emit('close', 0);
  const result = await pending;
  expect(result.servable).toBe(true);
  expect(result.detail).toContain('model-query readiness was not tested');
  expect(m.getToken).toHaveBeenCalledWith('https://*.asazure.windows.net/.default', expect.any(Object));
  expect(m.spawn.mock.calls[0][1]).toEqual([]);
  expect(JSON.stringify(m.spawn.mock.calls)).not.toContain('SECRET');
  expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toMatchObject({ ServerUri: uri, Token: 'SECRET' });
});
it.each(['https://eastus.asazure.windows.net/verified', 'asazure://evil.example/verified',
  'asazure://eastus.asazure.windows.net/wrong', 'asazure://eastus.asazure.windows.net/verified?x=1',
  'asazure://user@eastus.asazure.windows.net/verified'])('rejects unsafe target %s before authentication', async (target) => {
  expect((await probeAasServer(target, 'verified')).probed).toBe(false);
  expect(m.getToken).not.toHaveBeenCalled();
  expect(m.spawn).not.toHaveBeenCalled();
});
it('does not disclose authentication errors', async () => {
  m.getToken.mockRejectedValue(new Error('SECRET'));
  const result = await probeAasServer(uri, 'verified');
  expect(result).toMatchObject({ servable: false, probed: false });
  expect(result.detail).toContain('unverified');
  expect(result.detail).not.toContain('SECRET');
});
it('reports a missing executable as unprobed', async () => {
  const { pending } = await start();
  child.emit('error', new Error('SECRET'));
  expect(await pending).toMatchObject({ servable: false, probed: false });
});
it.each(['SECRET', '{"ok":true,"catalogCount":-1}', '{"ok":false}'])('rejects response %s without leaking output', async (output) => {
  const { pending } = await start();
  child.stdout.emit('data', Buffer.from(output));
  child.emit('close', 1);
  const result = await pending;
  expect(result.servable).toBe(false);
  expect(result.detail).toContain('unverified');
  expect(result.detail).not.toContain('SECRET');
});
it('bounds response size', async () => {
  const { pending } = await start();
  child.stdout.emit('data', Buffer.alloc(4097, 'x'));
  expect((await pending).servable).toBe(false);
  expect(child.kill).toHaveBeenCalled();
});
it('kills a hung probe after twenty seconds', async () => {
  vi.useFakeTimers();
  const { pending } = await start();
  await vi.advanceTimersByTimeAsync(20000);
  expect((await pending).detail).toContain('timed out');
  expect(child.kill).toHaveBeenCalled();
});
