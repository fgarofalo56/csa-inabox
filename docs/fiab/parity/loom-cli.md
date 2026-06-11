# loom-cli — parity with the Microsoft Fabric CLI (`fab`)

Source UI / tool: Microsoft Fabric CLI (`fab`, package `ms-fabric-cli`), v1.5 —
<https://learn.microsoft.com/rest/api/fabric/articles/fabric-command-line-interface>
and <https://microsoft.github.io/fabric-cli/>.

The `loom` CLI (`@csa-loom/cli`, bin `loom`) provides the workspace + item
management surface of `fab`, targeting the **Loom REST API** (the Console BFF
routes) instead of `api.fabric.microsoft.com`. Per
`.claude/rules/no-fabric-dependency.md` it is **Azure-native by default**: no
Fabric capacity / OneLake / Power BI workspace is required.

## Fabric CLI feature inventory (grounded in Learn)

| `fab` capability | Description |
|---|---|
| `fab auth login` — interactive (web browser) | User sign-in via browser. |
| `fab auth login` — service principal w/ secret | Non-interactive SP secret auth. |
| `fab auth login` — service principal w/ certificate | SP cert auth. |
| `fab auth login` — managed identity | MI auth (Azure-hosted). |
| `fab auth logout` | Clear the session. |
| `fab auth status` / whoami | Show signed-in identity. |
| `fab create <ws>.Workspace` | Create a workspace. |
| `fab ls` (root) | List workspaces. |
| `fab ls <ws>.Workspace` | List items in a workspace. |
| `fab create <ws>.Workspace/<name>.<ItemType>` | Create an item of a given type. |
| `fab get` / `fab ls -l <item>` | Show item / workspace properties. |
| `fab set` / rename | Update item / workspace properties. |
| `fab rm <ws>.Workspace` / `<item>` | Delete a workspace / item. |
| `fab ls` item-type taxonomy | Lakehouse, Warehouse, Notebook, Eventstream, etc. |
| `-o json` / output formatting | Machine-readable output. |
| `fab config set` | Persisted CLI settings (default context, output). |

## Loom coverage

| Loom command | Maps to `fab` | Loom REST backend | Status |
|---|---|---|---|
| `loom auth login` (device code) | interactive login | `POST /api/auth/cli-session` (device-authorization grant, server-side MSAL) | built ✅ |
| `loom auth login --service-principal` | SP-with-secret login | `POST /api/auth/cli-session` (client-credentials) | built ✅ |
| `loom auth logout` | `fab auth logout` | local credential store | built ✅ |
| `loom auth status` | status / whoami | `GET /api/auth/me` | built ✅ |
| `loom workspace list [--count]` | `fab ls` (root) | `GET /api/workspaces` | built ✅ |
| `loom workspace show <id>` | `fab get <ws>` | `GET /api/workspaces/:id` | built ✅ |
| `loom workspace create <name>` | `fab create <ws>.Workspace` | `POST /api/workspaces` | built ✅ |
| `loom workspace update <id>` | `fab set <ws>` / rename | `PATCH /api/workspaces/:id` | built ✅ |
| `loom workspace delete <id>` | `fab rm <ws>.Workspace` | `DELETE /api/workspaces/:id` | built ✅ |
| `loom workspace bulk-delete <id…>` | (scripted `fab rm` loop) | `POST /api/workspaces/bulk-delete` | built ✅ |
| `loom item list <ws>` | `fab ls <ws>.Workspace` | `GET /api/workspaces/:id/items` | built ✅ |
| `loom item create <ws> --type --name` | `fab create <ws>.Workspace/<n>.<Type>` | `POST /api/workspaces/:id/items` | built ✅ |
| `loom item show <type> <id>` | `fab get <item>` | `GET /api/cosmos-items/:type/:id` | built ✅ |
| `loom item update <type> <id>` | `fab set <item>` | `PATCH /api/cosmos-items/:type/:id` | built ✅ |
| `loom item delete <type> <id>` | `fab rm <item>` | `DELETE /api/cosmos-items/:type/:id` | built ✅ |
| `loom item types` | `fab ls` type taxonomy | local taxonomy (`item-types.ts`, mirrors `/api/items/<type>`) | built ✅ |
| `--output table\|json\|yaml`, `LOOM_OUTPUT` | `-o json` | client-side formatting | built ✅ |
| stored default API URL / config | `fab config set` | `~/.loom/settings.json` | built ✅ |
| SP-with-**certificate** login | SP cert auth | — | honest-gate ⚠️ (use `--service-principal` secret; cert path tracked) |
| managed-identity login | MI auth | — | honest-gate ⚠️ (run inside Azure with `DefaultAzureCredential`; tracked) |

No `❌`: every workspace/item-management capability of `fab` is built. The two
`⚠️` rows are alternative SP auth *methods* (cert / MI) — the secret-based SP
path covers the same non-interactive use case and is fully functional.

## Backend per control

Every command calls a real Loom BFF route (no mocks; see
`.claude/rules/no-vaporware.md`). Auth is the encrypted `loom_session` cookie
minted by `POST /api/auth/cli-session` (reuses the deployment's existing Entra
app + `SESSION_SECRET` — no new Azure resource). Workspace/item routes are
Cosmos-backed and tenant-scoped by the caller's `oid`. The CLI never contacts
`api.fabric.microsoft.com` / `api.powerbi.com`.

## Per-cloud portability

A single npm artifact serves Commercial, GCC, GCC-High, and IL5. Token
acquisition (device-code / client-credentials) happens **server-side**, where
the BFF already switches the Entra authority + Graph audience on `AZURE_CLOUD`
(`lib/auth/msal.ts`). The CLI only needs the per-deployment API base URL
(`--api-url` / `LOOM_API_URL`).

## Verification

- `vitest run` in `apps/loom-cli` (28 tests): arg parsing, output/YAML
  emitter, item-type validation, client envelope normalization + error/`hint`
  surfacing, device-code NDJSON stream parsing, credential store round-trip +
  `0600` perms.
- Real-data E2E (operator, against a minted session): `loom auth login` →
  `loom workspace create` → `loom workspace list` → `loom item create … --type
  lakehouse` → `loom workspace delete`, all with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (Azure-native path).
