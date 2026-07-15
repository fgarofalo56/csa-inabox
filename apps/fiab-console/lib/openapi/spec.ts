/**
 * BR-OPENAPI — the machine-readable contract for the Loom public API.
 *
 * `buildOpenApiSpec()` returns a real **OpenAPI 3.1** document describing the
 * STABLE BFF routes that non-interactive clients (the `loom` CLI, the Loom SDK,
 * Terraform, CI) already call. It is NOT a hand-waved stub: every path, verb,
 * parameter, request body, and response shape below mirrors the actual route
 * handler under `app/api/**` (workspaces, items, cosmos-items typed CRUD,
 * catalog search, thread edges, developer tokens, whoami, SCIM). When a route
 * changes shape, this document — and the `spec.test.ts` assertions that pin it
 * — must change with it.
 *
 * Auth: the whole surface accepts EITHER a browser `loom_session` cookie OR an
 * `Authorization: Bearer loom_pat_<id>_<secret>` scoped API token (BR-PAT, see
 * `lib/auth/api-session.ts`). The SCIM 2.0 provisioning surface is the one
 * exception — it authenticates with a separate provisioning bearer token
 * (`LOOM_SCIM_BEARER_TOKEN`), documented as its own security scheme.
 *
 * The document is served verbatim (unauthenticated) at `GET /api/openapi.json`
 * and rendered by the explorer at `/developer/api`.
 */

/** A minimal structural type for the pieces of an OpenAPI 3.1 doc we emit. */
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: Record<string, unknown>;
  servers: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, unknown>;
  security: Array<Record<string, string[]>>;
}

/** The stable public API version this document describes. */
export const LOOM_API_VERSION = '1.0.0';

/** The `{ ok: false, error }` envelope every route returns on failure. */
const ERROR_RESPONSE = {
  description: 'Error — the Loom `{ ok: false, error, code? }` envelope.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
};

/** Shared 401 for the cookie-or-PAT surface. */
const UNAUTHORIZED = {
  description: 'Unauthenticated — send a browser session cookie or an `Authorization: Bearer loom_pat_…` header.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

/**
 * Build the OpenAPI document. `baseUrl` sets the primary server entry so the
 * "Try it" affordance + generated SDKs point at the caller's own deployment
 * (Commercial or Government) rather than a hard-coded host.
 */
export function buildOpenApiSpec(baseUrl?: string): OpenApiDocument {
  const server = (baseUrl && baseUrl.trim()) || '/';
  return {
    openapi: '3.1.0',
    info: {
      title: 'CSA Loom API',
      version: LOOM_API_VERSION,
      summary: 'The public REST API for CSA Loom — workspaces, items, catalog, lineage, tokens, and SCIM provisioning.',
      description: [
        'The Loom API is the console\'s own Backend-for-Frontend (BFF). Every capability in the',
        'product UI is reachable programmatically through these routes — the `loom` CLI, the Loom',
        'SDK, and the Terraform module all ride on this exact surface.',
        '',
        '## Authentication',
        'Two schemes cover the whole surface:',
        '- **cookieAuth** — the encrypted `loom_session` cookie a browser (or `loom auth login`) mints.',
        '- **bearerAuth** — a scoped API token, `Authorization: Bearer loom_pat_<id>_<secret>`, created',
        '  under Settings → Developer → API tokens. Scope `read-only` permits GET/HEAD/OPTIONS only;',
        '  `read-write` permits mutations; `admin` additionally reaches admin surfaces while the',
        '  creator remains a tenant admin.',
        '',
        'The SCIM 2.0 provisioning endpoints use a separate **scimAuth** bearer (the identity',
        'provider\'s provisioning secret, `LOOM_SCIM_BEARER_TOKEN`) — they are not part of the',
        'cookie/PAT surface.',
        '',
        '## Conventions',
        'Success bodies are either a bare resource / array (the item + workspace routes, kept for',
        'backwards compatibility with the browser) or an `{ ok: true, … }` envelope. Failures are',
        'uniformly `{ ok: false, error, code? }` with a matching HTTP status.',
        '',
        'Every item type is Azure-native by default — no Microsoft Fabric tenant is required',
        '(see the no-fabric-dependency rule).',
      ].join('\n'),
      contact: { name: 'CSA Loom', url: 'https://csa-loom.limitlessdata.ai' },
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: server, description: 'This Loom deployment' },
    ],
    tags: [
      { name: 'Identity', description: 'Who am I, and what can this token do.' },
      { name: 'Workspaces', description: 'Create and enumerate Loom workspaces.' },
      { name: 'Items', description: 'CRUD over the ~120 Azure-native item types in a workspace.' },
      { name: 'Catalog', description: 'Federated search across Purview, Unity Catalog, and OneLake.' },
      { name: 'Lineage', description: 'The Loom Thread edge graph (Weave integrations).' },
      { name: 'Tokens', description: 'Scoped API tokens for non-interactive access (cookie-only management).' },
      { name: 'SCIM', description: 'SCIM 2.0 user/group provisioning for an identity provider (Entra).' },
    ],
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    paths: {
      '/api/v1/whoami': {
        get: {
          tags: ['Identity'],
          operationId: 'whoami',
          summary: 'Echo the caller identity + token scope',
          description:
            'The canonical "is my token working / what can it do" probe. Accepts a cookie session or a PAT and returns only the caller\'s own identity — no cross-tenant data.',
          responses: {
            '200': {
              description: 'The caller identity.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WhoAmI' } } },
            },
            '401': UNAUTHORIZED,
          },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['Identity'],
          operationId: 'me',
          summary: 'Probe the current browser/CLI session',
          responses: {
            '200': {
              description: 'The session identity.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/WhoAmI' } } },
            },
            '401': UNAUTHORIZED,
          },
        },
      },
      '/api/workspaces': {
        get: {
          tags: ['Workspaces'],
          operationId: 'listWorkspaces',
          summary: 'List workspaces accessible to the caller',
          parameters: [
            {
              name: 'count',
              in: 'query',
              required: false,
              schema: { type: 'boolean' },
              description: 'When `true`, enrich each workspace with an `itemCount` (best-effort).',
            },
          ],
          responses: {
            '200': {
              description: 'The workspaces owned by or shared with the caller.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Workspace' } },
                },
              },
            },
            '401': UNAUTHORIZED,
          },
        },
        post: {
          tags: ['Workspaces'],
          operationId: 'createWorkspace',
          summary: 'Create a workspace',
          security: [{ cookieAuth: [] }, { bearerAuth: ['read-write'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateWorkspace' },
              },
            },
          },
          responses: {
            '201': {
              description: 'The created workspace.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Workspace' } } },
            },
            '400': ERROR_RESPONSE,
            '401': UNAUTHORIZED,
          },
        },
      },
      '/api/workspaces/{workspaceId}/items': {
        parameters: [
          { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string' }, description: 'Workspace id.' },
        ],
        get: {
          tags: ['Items'],
          operationId: 'listItems',
          summary: 'List items in a workspace',
          responses: {
            '200': {
              description: 'The items in the workspace.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
                },
              },
            },
            '401': UNAUTHORIZED,
            '404': ERROR_RESPONSE,
          },
        },
        post: {
          tags: ['Items'],
          operationId: 'createItem',
          summary: 'Create an item in a workspace',
          security: [{ cookieAuth: [] }, { bearerAuth: ['read-write'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateItem' } },
            },
          },
          responses: {
            '201': {
              description: 'The created item.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
            },
            '400': ERROR_RESPONSE,
            '401': UNAUTHORIZED,
          },
        },
      },
      '/api/cosmos-items/{type}/{id}': {
        parameters: [
          { name: 'type', in: 'path', required: true, schema: { type: 'string' }, description: 'Item type (e.g. `lakehouse`, `notebook`). See `GET /api/v1/whoami` docs / `loom item types`.' },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Item id.' },
        ],
        get: {
          tags: ['Items'],
          operationId: 'getItem',
          summary: 'Get an item by type + id',
          responses: {
            '200': {
              description: 'The item record.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
            },
            '401': UNAUTHORIZED,
            '404': ERROR_RESPONSE,
          },
        },
        patch: {
          tags: ['Items'],
          operationId: 'updateItem',
          summary: 'Update an item\'s name / description / state',
          security: [{ cookieAuth: [] }, { bearerAuth: ['read-write'] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/UpdateItem' } },
            },
          },
          responses: {
            '200': {
              description: 'The updated item.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
            },
            '401': UNAUTHORIZED,
            '403': ERROR_RESPONSE,
            '404': ERROR_RESPONSE,
          },
        },
        delete: {
          tags: ['Items'],
          operationId: 'deleteItem',
          summary: 'Delete an item',
          security: [{ cookieAuth: [] }, { bearerAuth: ['read-write'] }],
          responses: {
            '200': {
              description: 'Deletion acknowledgement.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } },
            },
            '401': UNAUTHORIZED,
            '403': ERROR_RESPONSE,
            '404': ERROR_RESPONSE,
          },
        },
      },
      '/api/catalog/search': {
        get: {
          tags: ['Catalog'],
          operationId: 'searchCatalog',
          summary: 'Federated catalog search',
          parameters: [
            { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'Search keywords. Empty returns a recent-items browse.' },
            { name: 'source', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated source filter: `purview,unity-catalog,onelake`.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 100, default: 30 }, description: 'Per-source cap.' },
          ],
          responses: {
            '200': {
              description: 'Federated hits + per-source status.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CatalogSearchResult' } } },
            },
            '401': UNAUTHORIZED,
          },
        },
      },
      '/api/thread/edges': {
        get: {
          tags: ['Lineage'],
          operationId: 'listThreadEdges',
          summary: 'The caller\'s Loom Thread (Weave) edge graph',
          responses: {
            '200': {
              description: 'The lineage edges, most recent first.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ThreadEdges' } } },
            },
            '401': UNAUTHORIZED,
          },
        },
      },
      '/api/developer/tokens': {
        get: {
          tags: ['Tokens'],
          operationId: 'listTokens',
          summary: 'List the caller\'s API tokens (safe view)',
          description: 'Cookie-only. A PAT can never manage tokens.',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'The caller\'s tokens (never the secret).',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenList' } } },
            },
            '401': UNAUTHORIZED,
          },
        },
        post: {
          tags: ['Tokens'],
          operationId: 'createToken',
          summary: 'Create an API token (returns the secret once)',
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateToken' } } },
          },
          responses: {
            '200': {
              description: 'The one-time full token string + its safe view.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTokenResult' } } },
            },
            '400': ERROR_RESPONSE,
            '401': UNAUTHORIZED,
            '403': ERROR_RESPONSE,
          },
        },
      },
      '/api/developer/tokens/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Token id.' }],
        delete: {
          tags: ['Tokens'],
          operationId: 'revokeToken',
          summary: 'Revoke one of the caller\'s tokens',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': { description: 'Revoked.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } },
            '401': UNAUTHORIZED,
            '403': ERROR_RESPONSE,
            '404': ERROR_RESPONSE,
          },
        },
      },
      // ── SCIM 2.0 provisioning surface (scimAuth bearer) ──────────────────────
      '/api/scim/v2/ServiceProviderConfig': {
        get: {
          tags: ['SCIM'],
          operationId: 'scimServiceProviderConfig',
          summary: 'SCIM service-provider capabilities (RFC 7643 §5)',
          security: [{ scimAuth: [] }],
          responses: {
            '200': { description: 'The SCIM ServiceProviderConfig.', content: { 'application/scim+json': { schema: { type: 'object' } } } },
            '501': { description: 'SCIM provisioning is not configured (set `LOOM_SCIM_BEARER_TOKEN`).', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimError' } } } },
          },
        },
      },
      '/api/scim/v2/Users': {
        get: {
          tags: ['SCIM'],
          operationId: 'scimListUsers',
          summary: 'List / filter SCIM users',
          security: [{ scimAuth: [] }],
          parameters: [
            { name: 'filter', in: 'query', required: false, schema: { type: 'string' }, description: 'SCIM filter, e.g. `userName eq "alice@contoso.com"`.' },
            { name: 'startIndex', in: 'query', required: false, schema: { type: 'integer', default: 1 } },
            { name: 'count', in: 'query', required: false, schema: { type: 'integer', default: 100 } },
          ],
          responses: {
            '200': { description: 'A SCIM ListResponse of users.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimListResponse' } } } },
            '401': { description: 'Missing/invalid provisioning bearer.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimError' } } } },
          },
        },
        post: {
          tags: ['SCIM'],
          operationId: 'scimCreateUser',
          summary: 'Provision a user',
          security: [{ scimAuth: [] }],
          requestBody: { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } },
          responses: {
            '201': { description: 'The created user.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } },
            '409': { description: 'A user with that userName already exists.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimError' } } } },
          },
        },
      },
      '/api/scim/v2/Users/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { tags: ['SCIM'], operationId: 'scimGetUser', summary: 'Get a user', security: [{ scimAuth: [] }], responses: { '200': { description: 'The user.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } }, '404': { description: 'Not found.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimError' } } } } } },
        put: { tags: ['SCIM'], operationId: 'scimReplaceUser', summary: 'Replace a user', security: [{ scimAuth: [] }], requestBody: { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } }, responses: { '200': { description: 'The replaced user.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } } } },
        patch: { tags: ['SCIM'], operationId: 'scimPatchUser', summary: 'Patch a user (e.g. deactivate)', security: [{ scimAuth: [] }], requestBody: { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimPatchOp' } } } }, responses: { '200': { description: 'The patched user.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimUser' } } } } } },
        delete: { tags: ['SCIM'], operationId: 'scimDeleteUser', summary: 'Deprovision a user', security: [{ scimAuth: [] }], responses: { '204': { description: 'Deleted.' } } },
      },
      '/api/scim/v2/Groups': {
        get: {
          tags: ['SCIM'],
          operationId: 'scimListGroups',
          summary: 'List / filter SCIM groups',
          security: [{ scimAuth: [] }],
          parameters: [
            { name: 'filter', in: 'query', required: false, schema: { type: 'string' }, description: 'SCIM filter, e.g. `displayName eq "Data Engineers"`.' },
            { name: 'startIndex', in: 'query', required: false, schema: { type: 'integer', default: 1 } },
            { name: 'count', in: 'query', required: false, schema: { type: 'integer', default: 100 } },
          ],
          responses: { '200': { description: 'A SCIM ListResponse of groups.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimListResponse' } } } } },
        },
        post: {
          tags: ['SCIM'],
          operationId: 'scimCreateGroup',
          summary: 'Provision a group',
          security: [{ scimAuth: [] }],
          requestBody: { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimGroup' } } } },
          responses: { '201': { description: 'The created group.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimGroup' } } } } },
        },
      },
      '/api/scim/v2/Groups/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { tags: ['SCIM'], operationId: 'scimGetGroup', summary: 'Get a group', security: [{ scimAuth: [] }], responses: { '200': { description: 'The group.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimGroup' } } } }, '404': { description: 'Not found.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimError' } } } } } },
        put: { tags: ['SCIM'], operationId: 'scimReplaceGroup', summary: 'Replace a group', security: [{ scimAuth: [] }], requestBody: { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimGroup' } } } }, responses: { '200': { description: 'The replaced group.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimGroup' } } } } } },
        patch: { tags: ['SCIM'], operationId: 'scimPatchGroup', summary: 'Patch a group\'s members', security: [{ scimAuth: [] }], requestBody: { required: true, content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimPatchOp' } } } }, responses: { '200': { description: 'The patched group.', content: { 'application/scim+json': { schema: { $ref: '#/components/schemas/ScimGroup' } } } } } },
        delete: { tags: ['SCIM'], operationId: 'scimDeleteGroup', summary: 'Delete a group', security: [{ scimAuth: [] }], responses: { '204': { description: 'Deleted.' } } },
      },
    },
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'loom_session', description: 'The encrypted browser/CLI session cookie.' },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'loom_pat_<id>_<secret>',
          description: 'A scoped API token (BR-PAT). Create under Settings → Developer → API tokens.',
        },
        scimAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'The SCIM provisioning secret (`LOOM_SCIM_BEARER_TOKEN`) configured on the deployment and in the IdP\'s provisioning connector.',
        },
      },
      schemas: {
        Ok: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean', const: true } }, additionalProperties: true },
        Error: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string', description: 'Human-readable error message.' },
            code: { type: 'string', description: 'Stable machine-readable error code.' },
            hint: { type: 'string', description: 'Optional remediation hint (honest infra gates).' },
          },
        },
        WhoAmI: {
          type: 'object',
          required: ['ok', 'oid', 'tenantId', 'auth'],
          properties: {
            ok: { type: 'boolean', const: true },
            auth: { type: 'string', enum: ['cookie', 'pat'] },
            oid: { type: 'string', description: 'Entra object id of the caller.' },
            upn: { type: 'string' },
            name: { type: 'string' },
            tenantId: { type: 'string' },
            scope: { type: 'string', enum: ['read-only', 'read-write', 'admin'], description: 'Present only for a PAT session.' },
            tokenId: { type: 'string', description: 'Present only for a PAT session.' },
          },
        },
        Workspace: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            capacity: { type: 'string' },
            domain: { type: 'string' },
            createdBy: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            itemCount: { type: 'integer', description: 'Present only when `?count=true`.' },
          },
        },
        CreateWorkspace: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            capacity: { type: 'string', description: 'Optional capacity binding.' },
            domain: { type: 'string', description: 'Governance domain id (defaults to `default`).' },
          },
        },
        Item: {
          type: 'object',
          required: ['id', 'workspaceId', 'itemType', 'displayName'],
          properties: {
            id: { type: 'string' },
            workspaceId: { type: 'string' },
            itemType: { type: 'string' },
            displayName: { type: 'string' },
            description: { type: 'string' },
            state: { type: 'object', additionalProperties: true, description: 'Per-item-type editor state.' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        CreateItem: {
          type: 'object',
          required: ['itemType', 'displayName'],
          properties: {
            itemType: { type: 'string', description: 'One of the ~120 Azure-native item types.' },
            displayName: { type: 'string' },
            description: { type: 'string' },
          },
        },
        UpdateItem: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
            description: { type: 'string' },
            state: { type: 'object', additionalProperties: true },
          },
        },
        CatalogSearchResult: {
          type: 'object',
          required: ['ok', 'hits'],
          properties: {
            ok: { type: 'boolean' },
            total: { type: 'integer' },
            hits: { type: 'array', items: { $ref: '#/components/schemas/CatalogHit' } },
            sources: { type: 'object', additionalProperties: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'integer' }, error: { type: 'string' }, hint: { type: 'string' } } } },
          },
        },
        CatalogHit: {
          type: 'object',
          required: ['source', 'id', 'display_name', 'type'],
          properties: {
            source: { type: 'string', enum: ['purview', 'unity-catalog', 'onelake'] },
            id: { type: 'string' },
            display_name: { type: 'string' },
            type: { type: 'string' },
            description: { type: 'string' },
            owner: { type: 'string' },
            workspace_name: { type: 'string' },
            workspace_id: { type: 'string' },
            domain: { type: 'string' },
          },
        },
        ThreadEdges: {
          type: 'object',
          required: ['ok', 'edges'],
          properties: {
            ok: { type: 'boolean' },
            edges: { type: 'array', items: { type: 'object', additionalProperties: true, description: 'A Weave edge (from → to).' } },
          },
        },
        TokenList: {
          type: 'object',
          required: ['ok', 'tokens'],
          properties: {
            ok: { type: 'boolean' },
            tokens: { type: 'array', items: { $ref: '#/components/schemas/TokenView' } },
            maxTtlDays: { type: 'integer' },
            defaultTtlDays: { type: 'integer' },
          },
        },
        TokenView: {
          type: 'object',
          required: ['id', 'name', 'scope', 'createdAt', 'expiresAt', 'revoked'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            scope: { type: 'string', enum: ['read-only', 'read-write', 'admin'] },
            createdByUpn: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' },
            lastUsedAt: { type: 'string', format: 'date-time' },
            revoked: { type: 'boolean' },
            expired: { type: 'boolean' },
          },
        },
        CreateToken: {
          type: 'object',
          required: ['name', 'scope'],
          properties: {
            name: { type: 'string' },
            scope: { type: 'string', enum: ['read-only', 'read-write', 'admin'] },
            ttlDays: { type: 'integer', maximum: 90, description: 'Token lifetime in days (default 30, max 90).' },
          },
        },
        CreateTokenResult: {
          type: 'object',
          required: ['ok', 'token', 'tokenInfo'],
          properties: {
            ok: { type: 'boolean' },
            token: { type: 'string', description: 'The full token string — shown ONCE, unrecoverable after.' },
            tokenInfo: { $ref: '#/components/schemas/TokenView' },
          },
        },
        // ── SCIM 2.0 schemas (RFC 7643) ──
        ScimUser: {
          type: 'object',
          required: ['schemas', 'userName'],
          properties: {
            schemas: { type: 'array', items: { type: 'string' }, example: ['urn:ietf:params:scim:schemas:core:2.0:User'] },
            id: { type: 'string' },
            externalId: { type: 'string' },
            userName: { type: 'string' },
            active: { type: 'boolean' },
            displayName: { type: 'string' },
            name: { type: 'object', properties: { formatted: { type: 'string' }, givenName: { type: 'string' }, familyName: { type: 'string' } } },
            emails: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, primary: { type: 'boolean' }, type: { type: 'string' } } } },
            groups: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, display: { type: 'string' } } } },
            meta: { $ref: '#/components/schemas/ScimMeta' },
          },
        },
        ScimGroup: {
          type: 'object',
          required: ['schemas', 'displayName'],
          properties: {
            schemas: { type: 'array', items: { type: 'string' }, example: ['urn:ietf:params:scim:schemas:core:2.0:Group'] },
            id: { type: 'string' },
            externalId: { type: 'string' },
            displayName: { type: 'string' },
            members: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, display: { type: 'string' } } } },
            meta: { $ref: '#/components/schemas/ScimMeta' },
          },
        },
        ScimMeta: {
          type: 'object',
          properties: {
            resourceType: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            lastModified: { type: 'string', format: 'date-time' },
            location: { type: 'string' },
            version: { type: 'string', description: 'Weak ETag.' },
          },
        },
        ScimListResponse: {
          type: 'object',
          required: ['schemas', 'totalResults', 'Resources'],
          properties: {
            schemas: { type: 'array', items: { type: 'string' }, example: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'] },
            totalResults: { type: 'integer' },
            startIndex: { type: 'integer' },
            itemsPerPage: { type: 'integer' },
            Resources: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        ScimPatchOp: {
          type: 'object',
          required: ['schemas', 'Operations'],
          properties: {
            schemas: { type: 'array', items: { type: 'string' }, example: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'] },
            Operations: {
              type: 'array',
              items: {
                type: 'object',
                required: ['op'],
                properties: { op: { type: 'string', enum: ['add', 'remove', 'replace', 'Add', 'Remove', 'Replace'] }, path: { type: 'string' }, value: {} },
              },
            },
          },
        },
        ScimError: {
          type: 'object',
          required: ['schemas', 'status'],
          properties: {
            schemas: { type: 'array', items: { type: 'string' }, example: ['urn:ietf:params:scim:api:messages:2.0:Error'] },
            status: { type: 'string' },
            scimType: { type: 'string' },
            detail: { type: 'string' },
          },
        },
      },
    },
  };
}
