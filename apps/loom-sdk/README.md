# @csa-loom/sdk

Typed TypeScript client for the **CSA Loom** REST API — workspaces, items,
catalog, and lineage. Consistent with the OpenAPI 3.1 contract your Loom
deployment serves at `GET /api/openapi.json`.

Azure-native by design — no Microsoft Fabric tenant required.

## Install

```bash
npm install @csa-loom/sdk
```

Requires Node ≥ 20 (uses the global `fetch`).

## Authenticate

Two schemes, matching the API's OpenAPI security schemes:

- **Scoped API token (recommended for CI/automation)** — create one under
  **Settings → Developer → API tokens** and pass it as `token`.
- **Session cookie** — pass a `loom_session` cookie value as `cookie`, or mint
  one from a service principal with `loginServicePrincipal()`.

```ts
import { LoomClient } from '@csa-loom/sdk';

const loom = new LoomClient({
  baseUrl: 'https://csa-loom.limitlessdata.ai',
  token: process.env.LOOM_TOKEN, // loom_pat_<id>_<secret>
});

// Verify the token + see its scope
console.log(await loom.whoami());
```

## Usage

```ts
// Workspaces
const ws = await loom.workspaces.create({ name: 'Analytics', description: 'Team space' });
const all = await loom.workspaces.list({ count: true });

// Items (itemType is validated locally against the taxonomy)
const lake = await loom.items.create(ws.id, { itemType: 'lakehouse', displayName: 'Bronze' });
await loom.items.update('lakehouse', lake.id, { displayName: 'Bronze v2' });
const items = await loom.items.list(ws.id);

// Catalog search (federated Purview + Unity + OneLake)
const hits = await loom.catalog.search('sales', { source: ['purview'], limit: 20 });

// Lineage (Loom Thread / Weave edges)
const edges = await loom.thread.edges();

// API tokens (cookie-session only — a PAT cannot manage tokens)
const tokens = await loom.tokens.list();
```

## Errors

Every call rejects with `LoomApiError` on failure, carrying `status`, the
stable `code`, and (for honest infra gates) a remediation `hint`:

```ts
import { isLoomApiError } from '@csa-loom/sdk';

try {
  await loom.catalog.search('x');
} catch (e) {
  if (isLoomApiError(e)) console.error(e.status, e.code, e.hint);
}
```

## Service-principal login (CI)

```ts
await loom.loginServicePrincipal({
  clientId: process.env.LOOM_SP_CLIENT_ID!,
  clientSecret: process.env.LOOM_SP_CLIENT_SECRET!,
  tenantId: process.env.LOOM_TENANT_ID,
});
// subsequent calls reuse the minted session cookie
```

## Relationship to the CLI + OpenAPI

The SDK wraps the same BFF surface the [`loom` CLI](../loom-cli) drives and the
OpenAPI spec documents. Prefer a scoped token for headless use. For interactive
device-code sign-in, use the CLI (`loom auth login`).

## Roadmap

A first-party **Python** SDK (`csa-loom`) is planned; until then, generate a
Python client from the OpenAPI spec
(`openapi-generator-cli generate -i <host>/api/openapi.json -g python`). See the
[SDK + Terraform roadmap](../../docs/fiab/roadmap/loom-sdk-terraform.md).
