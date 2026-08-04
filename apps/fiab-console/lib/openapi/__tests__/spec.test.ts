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
      '/api/items/{type}/{id}/definition',
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

  // ── The item-definition route (loom-vscode W6 / P1.5) ────────────────────
  // The VS Code `loom:` filesystem is generated from this contract, so the
  // optimistic-concurrency surface (ETag / If-Match / 412 / 428) and the
  // secret-scrub manifest are load-bearing, not decoration. These assert the
  // REAL exported spec object — not a re-serialization of it.
  describe('GET|PUT /api/items/{type}/{id}/definition', () => {
    const item = () => spec.paths['/api/items/{type}/{id}/definition'] as any;

    it('is declared with both path parameters', () => {
      const params = item().parameters;
      expect(params.map((p: any) => p.name)).toEqual(['type', 'id']);
      for (const p of params) {
        expect(p.in).toBe('path');
        expect(p.required).toBe(true);
        expect(p.schema.type).toBe('string');
      }
    });

    it('GET returns the definition + an ETag header for optimistic concurrency', () => {
      const get = item().get;
      expect(get.operationId).toBe('getItemDefinition');
      expect(get.tags).toContain('Items');
      // The ETag response header is what the client echoes as If-Match.
      expect(get.responses['200'].headers.ETag).toBeDefined();
      expect(get.responses['200'].content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ItemDefinitionResult',
      );
      // Owner-scoped: an unreachable item is 404, never a cross-item read.
      expect(get.responses['404']).toBeDefined();
      expect(get.responses['401']).toBeDefined();
    });

    it('PUT REQUIRES If-Match and is read-write scoped', () => {
      const put = item().put;
      expect(put.operationId).toBe('updateItemDefinition');
      const ifMatch = put.parameters.find((p: any) => p.name === 'If-Match');
      expect(ifMatch, 'If-Match parameter must be declared').toBeDefined();
      expect(ifMatch.in).toBe('header');
      expect(ifMatch.required, 'If-Match must be REQUIRED (428 without it)').toBe(true);
      const scopes = put.security.flatMap((s: Record<string, string[]>) => Object.values(s).flat());
      expect(scopes).toContain('read-write');
    });

    it('PUT documents the concurrency + schema-version failure modes', () => {
      const put = item().put;
      // 428 = no If-Match; 412 = stale tag (client opens a diff); 409 = a
      // definition whose schemaVersion this deployment cannot safely write.
      for (const status of ['401', '404', '409', '412', '428']) {
        expect(put.responses[status], `PUT must document ${status}`).toBeDefined();
      }
      expect(put.responses['200'].headers.ETag).toBeDefined();
      expect(put.requestBody.required).toBe(true);
      expect(put.requestBody.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/UpdateItemDefinition',
      );
    });

    it('the three definition schemas resolve and carry the scrub manifest', () => {
      const schemas = (spec.components as any).schemas;
      // ItemDefinition — the portable, secret-scrubbed document.
      expect(schemas.ItemDefinition.required).toEqual(
        expect.arrayContaining(['schemaVersion', 'itemType', 'displayName', 'state']),
      );
      // ItemDefinitionResult — definition + ETag + the exclusion manifest.
      const result = schemas.ItemDefinitionResult;
      expect(result.required).toEqual(
        expect.arrayContaining(['etag', 'scrubbedPaths', 'provisioningExcluded', 'definition']),
      );
      expect(result.properties.definition.$ref).toBe('#/components/schemas/ItemDefinition');
      expect(result.properties.scrubbedPaths.type).toBe('array');
      expect(result.properties.provisioningExcluded.type).toBe('boolean');
      // UpdateItemDefinition — the PUT body wrapper.
      expect(schemas.UpdateItemDefinition.required).toContain('definition');
      expect(schemas.UpdateItemDefinition.properties.definition.$ref).toBe(
        '#/components/schemas/ItemDefinition',
      );
    });
  });
});
