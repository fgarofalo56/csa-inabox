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

The device-code flow needs NO change to the Loom Entra app registration. The
Console redeems the code server-side as a **confidential client**, with its own
client secret, and "Allow public client flows" must stay **off**: turning it on
makes Entra refuse the browser sign-in's secret. Whether Entra accepts the secret
on the device-code grant has not yet been verified with a live sign-in (#4805).
If sign-in fails, the CLI prints the Entra AADSTS code and a remediation.

Sessions from `loom auth login` (device code) are deliberately limited, as least
privilege for a non-interactive sign-in:

- they last **1 hour** and are not extended by refreshing;
- they are **refused on admin surfaces** (`/admin/*`, `/api/admin/*` and any
  tenant-admin or admin-tier capability), with 403
  `interactive_sign_in_required` — so admin-only commands such as
  `loom workspace bulk-delete` need the browser console, or a service-principal
  session whose principal holds tenant-admin standing;
- starting a sign-in is rate-limited per client IP (5 per 10 minutes, and at
  most 2 waiting at once), answered with 429 and `Retry-After`.

`--tenant` / `LOOM_TENANT` must be the deployment's own tenant id, or be omitted.

## Configuration

Precedence: flags > environment > stored default.

| Setting     | Flag         | Env           | Notes                                  |
|-------------|--------------|---------------|----------------------------------------|
| API base    | `--api-url`  | `LOOM_API_URL`| Front Door / Container App hostname.   |
| Output      | `--output`   | `LOOM_OUTPUT` | `table` (default) \| `json` \| `yaml`. |
| Tenant      | `--tenant`   | `LOOM_TENANT` | The deployment's own Entra tenant id; anything else is refused. Omit to use it. |
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
