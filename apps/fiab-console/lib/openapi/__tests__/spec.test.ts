import { describe, it, expect } from 'vitest';
import { buildOpenApiSpec, LOOM_API_VERSION } from '../spec';

describe('buildOpenApiSpec', () => {
  const spec = buildOpenApiSpec('https://loom.example.com');

  it('is a valid OpenAPI 3.1 document envelope', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('CSA Loom API');
    expect(spec.info.version).toBe(LOOM_API_VERSION);
    expect(Array.isArray(spec.tags)).toBe(true);
    expect(spec.tags.length).toBeGreaterThan(0);
  });

  it('sets the server URL from the supplied base', () => {
    expect(spec.servers[0].url).toBe('https://loom.example.com');
  });

  it('falls back to "/" when no base is given', () => {
    expect(buildOpenApiSpec().servers[0].url).toBe('/');
  });

  it('declares the cookie + PAT + SCIM security schemes', () => {
    const schemes = (spec.components as any).securitySchemes;
    expect(schemes.cookieAuth.in).toBe('cookie');
    expect(schemes.bearerAuth.scheme).toBe('bearer');
    expect(schemes.scimAuth.scheme).toBe('bearer');
  });

  it('covers the stable public routes the CLI/SDK/Terraform call', () => {
    const paths = Object.keys(spec.paths);
    for (const p of [
      '/api/v1/whoami',
      '/api/workspaces',
      '/api/workspaces/{workspaceId}/items',
      '/api/cosmos-items/{type}/{id}',
      '/api/catalog/search',
      '/api/thread/edges',
      '/api/developer/tokens',
      '/api/scim/v2/Users',
      '/api/scim/v2/Groups',
    ]) {
      expect(paths, `missing path ${p}`).toContain(p);
    }
  });

  it('gives every operation a unique operationId', () => {
    const ids: string[] = [];
    for (const item of Object.values(spec.paths)) {
      for (const [verb, op] of Object.entries(item)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(verb)) {
          ids.push((op as any).operationId);
        }
      }
    }
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
  });

  it('every $ref resolves to a defined component schema', () => {
    const schemas = (spec.components as any).schemas as Record<string, unknown>;
    const refs: string[] = [];
    const collect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else collect(v);
      }
    };
    collect(spec.paths);
    collect(spec.components);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/'), `bad ref ${ref}`).toBe(true);
      const name = ref.replace('#/components/schemas/', '');
      expect(schemas[name], `unresolved $ref ${ref}`).toBeDefined();
    }
  });

  it('marks mutating operations with a read-write PAT scope requirement', () => {
    const createWs = (spec.paths['/api/workspaces'] as any).post;
    const scopes = createWs.security.flatMap((s: Record<string, string[]>) => Object.values(s).flat());
    expect(scopes).toContain('read-write');
  });
});
