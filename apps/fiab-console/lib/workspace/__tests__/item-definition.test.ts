/**
 * Pure unit tests for the item-definition serializer (P1.5). No Cosmos, no
 * network — the scrub / etag / re-attach logic in isolation.
 */
import { describe, it, expect } from 'vitest';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  buildItemDefinition,
  applyItemDefinition,
  computeDefinitionEtag,
  reattachScrubbed,
  LOOM_DEFINITION_SCHEMA,
} from '../item-definition';

const item = (over: Partial<WorkspaceItem> = {}): WorkspaceItem => ({
  id: 'i1',
  workspaceId: 'w1',
  itemType: 'notebook',
  displayName: 'NB',
  description: 'd',
  state: {
    lang: 'python',
    password: 'p@ss',
    connectionString: 'Server=x;Pwd=y',
    keyVaultSecretRef: 'kv/name',
    provisioning: { backend: 'adls' },
    nested: { apiKey: 'AK', keep: 'v', deep: { clientSecret: 'CS', keep2: 'w' } },
    list: [{ accessToken: 'T', label: 'a' }],
  },
  createdBy: 'u',
  createdAt: 't0',
  updatedAt: 't1',
  ...over,
});

describe('buildItemDefinition', () => {
  it('scrubs secret-keyed values, keeps …Ref names, excludes provisioning', () => {
    const { definition, scrubbedPaths, provisioningExcluded } = buildItemDefinition(item());
    const s = definition.state as any;
    expect(s.password).toBeUndefined();
    expect(s.connectionString).toBeUndefined();
    expect(s.nested.apiKey).toBeUndefined();
    expect(s.nested.deep.clientSecret).toBeUndefined();
    expect(s.list[0].accessToken).toBeUndefined();
    // non-secret siblings survive
    expect(s.lang).toBe('python');
    expect(s.nested.keep).toBe('v');
    expect(s.nested.deep.keep2).toBe('w');
    expect(s.list[0].label).toBe('a');
    // reference NAME survives (pointer, not value)
    expect(s.keyVaultSecretRef).toBe('kv/name');
    // provisioning excluded + reported
    expect(s.provisioning).toBeUndefined();
    expect(provisioningExcluded).toBe(true);
    expect(scrubbedPaths).toEqual(
      expect.arrayContaining([
        'state.password',
        'state.connectionString',
        'state.nested.apiKey',
        'state.nested.deep.clientSecret',
        'state.list.0.accessToken',
      ]),
    );
    expect(definition.schemaVersion).toBe(1);
  });
});

describe('computeDefinitionEtag', () => {
  it('is stable for identical content and changes when content or updatedAt changes', () => {
    const a = computeDefinitionEtag(item());
    const b = computeDefinitionEtag(item());
    expect(a).toBe(b);
    expect(a).toMatch(/^"[0-9a-f]{64}"$/);
    expect(computeDefinitionEtag(item({ updatedAt: 't2' }))).not.toBe(a);
    expect(computeDefinitionEtag(item({ state: { ...item().state, lang: 'scala' } }))).not.toBe(a);
  });

  it('ignores provisioning changes (excluded from the definition)', () => {
    const a = computeDefinitionEtag(item());
    const b = computeDefinitionEtag(item({ state: { ...item().state, provisioning: { backend: 'other' } } }));
    expect(a).toBe(b);
  });
});

describe('applyItemDefinition — round-trip integrity', () => {
  it('re-attaches scrubbed secrets + provisioning onto an edited definition', () => {
    const current = item();
    const { definition } = buildItemDefinition(current);
    // simulate a client edit of the scrubbed definition
    (definition.state as any).lang = 'sql';
    (definition.state as any).added = true;

    const res = applyItemDefinition(current, definition);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = res.state as any;
    // edits preserved
    expect(s.lang).toBe('sql');
    expect(s.added).toBe(true);
    // secrets restored verbatim
    expect(s.password).toBe('p@ss');
    expect(s.connectionString).toBe('Server=x;Pwd=y');
    expect(s.nested.apiKey).toBe('AK');
    expect(s.nested.deep.clientSecret).toBe('CS');
    expect(s.list[0].accessToken).toBe('T');
    expect(s.list[0].label).toBe('a');
    // provisioning restored
    expect(s.provisioning).toEqual({ backend: 'adls' });
  });

  it('rejects a schemaVersion newer than this build understands', () => {
    const res = applyItemDefinition(item(), { schemaVersion: LOOM_DEFINITION_SCHEMA + 1, state: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.code).toBe('schema_too_new');
  });

  it('rejects a non-object definition', () => {
    const res = applyItemDefinition(item(), 'not an object');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
  });
});

describe('reattachScrubbed', () => {
  it('does not invent keys the current item never had', () => {
    const merged = reattachScrubbed({ a: 1, secret: 's' }, { a: 2, b: 3 }) as any;
    expect(merged.a).toBe(2);
    expect(merged.b).toBe(3);
    expect(merged.secret).toBe('s');
  });
});
