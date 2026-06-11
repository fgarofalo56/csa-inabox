# @csa-loom/cli — `loom`

One-command workspace + item management for **CSA Loom**, wrapping the Loom REST
API (the same BFF routes the Console UI uses). Parity target: Microsoft **Fabric
CLI (`fab`) v1.5** for the workspace + item surface.

**Azure-native by default.** No Microsoft Fabric capacity, OneLake, or Power BI
workspace is required for any command. Fabric is opt-in *server-side* only.

## Install

```bash
npm install -g @csa-loom/cli
# or run without installing
npx @csa-loom/cli --help
```

Requires Node.js >= 20.

## Authentication

The Loom API authenticates with the encrypted `loom_session` cookie — there is
no separate API-key scheme. `loom auth login` mints that session for you against
`POST /api/auth/cli-session` and stores it at `~/.loom/credentials.json` (mode
`0600`), keyed by API URL so one machine can target multiple clouds.

```bash
# Interactive (device code — like `fab auth login`)
loom auth login --api-url https://loom-console.example.azurefd.net
#   -> opens a code + URL; sign in with your browser

# Non-interactive (service principal / CI)
loom auth login --api-url https://loom... --service-principal \
  --client-id <appId> --client-secret <secret> --tenant-id <tid>
#   (or set LOOM_SP_CLIENT_ID / LOOM_SP_CLIENT_SECRET / LOOM_SP_TENANT_ID)

loom auth status      # show + verify the current session
loom auth logout      # clear the stored session
```

The device-code flow needs the Loom Entra app registration to allow public
client flows — see `docs/fiab/MSAL-handoff.md`.

## Configuration

Precedence: flags > environment > stored default.

| Setting     | Flag         | Env           | Notes                                  |
|-------------|--------------|---------------|----------------------------------------|
| API base    | `--api-url`  | `LOOM_API_URL`| Front Door / Container App hostname.   |
| Output      | `--output`   | `LOOM_OUTPUT` | `table` (default) \| `json` \| `yaml`. |
| Tenant      | `--tenant`   | `LOOM_TENANT` | Entra tenant override for sign-in.     |
| Config dir  | —            | `LOOM_CONFIG_DIR` | Default `~/.loom`.                 |

A single binary serves every sovereign cloud (Commercial, GCC, GCC-High, IL5):
device-code/SP token acquisition happens server-side, so only the API base URL
differs per deployment.

## Commands

```
loom workspace list [--count]
loom workspace show <id>
loom workspace create <name> [--description --capacity --domain]
loom workspace update <id> [--name --description --capacity --domain]
loom workspace delete <id>
loom workspace bulk-delete <id> [<id> ...]      # tenant-admin only

loom item list <workspaceId>
loom item create <workspaceId> --type <itemType> --name <displayName> [--description]
loom item show <type> <id>
loom item update <type> <id> [--name --description]
loom item delete <type> <id>
loom item types                                 # list valid item types
```

`--capacity` / `--domain` are optional. Omitting them creates an Azure-native
workspace (no Fabric capacity binding).

## Examples

```bash
loom workspace create "Analytics" --description "Team workspace" --output json
WS=$(loom workspace list --output json | jq -r '.[0].id')
loom item create "$WS" --type lakehouse --name "Bronze"
loom item list "$WS"
```

## REST mapping

| Command                     | Method + route                                  |
|-----------------------------|-------------------------------------------------|
| `workspace list`            | `GET /api/workspaces` (`?count=true`)           |
| `workspace show`            | `GET /api/workspaces/:id`                       |
| `workspace create`          | `POST /api/workspaces`                          |
| `workspace update`          | `PATCH /api/workspaces/:id`                     |
| `workspace delete`          | `DELETE /api/workspaces/:id`                    |
| `workspace bulk-delete`     | `POST /api/workspaces/bulk-delete`              |
| `item list`                 | `GET /api/workspaces/:id/items`                 |
| `item create`               | `POST /api/workspaces/:id/items`                |
| `item show/update/delete`   | `GET/PATCH/DELETE /api/cosmos-items/:type/:id`  |
| `auth login`                | `POST /api/auth/cli-session`                    |
| `auth status`               | `GET /api/auth/me`                              |

## Exit codes

`0` success · `1` API/usage error (message on stderr; `hint` echoed for infra
gates) · `2` unknown command.

## License

MIT.
