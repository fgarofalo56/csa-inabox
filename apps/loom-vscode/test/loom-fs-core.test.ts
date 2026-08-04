/**
 * LoomFsCore over a mocked route transport — read / write / stat, ETag caching,
 * If-Match echo, conflict propagation, and the signed-out gate.
 */
import { describe, it, expect } from 'vitest';
import { LoomFsCore, LoomFsError, type DefinitionTransport, type DefinitionPayload } from '../src/fs/loom-fs-core';
import type { LoomRef } from '../src/fs/definition-uri';

/** A tiny in-memory stand-in for `GET|PUT …/definition` with ETag/412 semantics. */
class FakeRoute implements DefinitionTransport {
  private definition: unknown;
  private version = 1;
  getCount = 0;
  putCount = 0;

  constructor(initial: unknown) {
    this.definition = initial;
  }

  private etag(): string {
    return `"v${this.version}"`;
  }

  async getDefinition(): Promise<DefinitionPayload> {
    this.getCount++;
    return { definition: this.definition, etag: this.etag(), schemaVersion: 1 };
  }

  async putDefinition(_type: string, _id: string, definition: unknown, ifMatch: string): Promise<DefinitionPayload> {
    this.putCount++;
    if (ifMatch !== '*' && ifMatch !== this.etag()) {
      const err = new Error('conflict') as Error & { status: number };
      err.status = 412;
      throw err;
    }
    this.definition = definition;
    this.version++;
    return { definition: this.definition, etag: this.etag(), schemaVersion: 1 };
  }

  /** Simulate a concurrent external write. */
  externalWrite(definition: unknown): void {
    this.definition = definition;
    this.version++;
  }
}

const ref: LoomRef = { deploymentId: 'dep-1', itemType: 'notebook', itemId: 'id-1', filename: 'nb.definition.json' };
const key = 'loom:/dep-1/notebook/id-1/nb.definition.json';
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));
const encode = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

function coreFor(route: FakeRoute): LoomFsCore {
  return new LoomFsCore(async (depId) => (depId === 'dep-1' ? route : undefined));
}

describe('LoomFsCore', () => {
  it('reads the definition as pretty JSON bytes', async () => {
    const route = new FakeRoute({ schemaVersion: 1, itemType: 'notebook', state: { lang: 'python' } });
    const core = coreFor(route);
    const bytes = await core.readFile(key, ref);
    expect(decode(bytes).state.lang).toBe('python');
    expect(core.etagFor(key)).toBe('"v1"');
  });

  it('stat reports the byte length and caches for the following read (1 GET)', async () => {
    const route = new FakeRoute({ schemaVersion: 1, itemType: 'notebook', state: {} });
    const core = coreFor(route);
    const s = await core.stat(key, ref);
    const bytes = await core.readFile(key, ref);
    expect(s.size).toBe(bytes.length);
    expect(route.getCount).toBe(1); // stat cached; read reused it
  });

  it('writeFile echoes the cached ETag as If-Match and updates the cache', async () => {
    const route = new FakeRoute({ schemaVersion: 1, itemType: 'notebook', state: { lang: 'python' } });
    const core = coreFor(route);
    await core.readFile(key, ref); // caches "v1"
    const edited = encode({ schemaVersion: 1, itemType: 'notebook', state: { lang: 'scala' } });
    const { etag } = await core.writeFile(key, ref, edited);
    expect(etag).toBe('"v2"');
    expect(core.etagFor(key)).toBe('"v2"');
    // a subsequent read reflects the write
    const bytes = await core.readFile(key, ref);
    expect(decode(bytes).state.lang).toBe('scala');
  });

  it('propagates a 412 conflict when the cached ETag is stale', async () => {
    const route = new FakeRoute({ schemaVersion: 1, itemType: 'notebook', state: { lang: 'python' } });
    const core = coreFor(route);
    await core.readFile(key, ref); // caches "v1"
    route.externalWrite({ schemaVersion: 1, itemType: 'notebook', state: { lang: 'r' } }); // now "v2"
    const edited = encode({ schemaVersion: 1, itemType: 'notebook', state: { lang: 'scala' } });
    await expect(core.writeFile(key, ref, edited)).rejects.toMatchObject({ status: 412 });
  });

  it('rejects invalid JSON on write with a typed bad_json error', async () => {
    const route = new FakeRoute({});
    const core = coreFor(route);
    await core.readFile(key, ref);
    await expect(core.writeFile(key, ref, new TextEncoder().encode('{not json'))).rejects.toBeInstanceOf(LoomFsError);
  });

  it('throws not_signed_in when the deployment has no transport', async () => {
    const core = new LoomFsCore(async () => undefined);
    await expect(core.readFile(key, ref)).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('invalidate forces a fresh GET', async () => {
    const route = new FakeRoute({ schemaVersion: 1, itemType: 'notebook', state: {} });
    const core = coreFor(route);
    await core.readFile(key, ref);
    core.invalidate(key);
    await core.readFile(key, ref);
    expect(route.getCount).toBe(2);
  });
});
