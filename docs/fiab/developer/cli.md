# `loom` CLI

A file-system-inspired command line over the Loom REST API. Source:
[`apps/loom-cli`](https://github.com/fgarofalo56/csa-inabox/tree/main/apps/loom-cli).

## Authentication

```bash
loom auth login                 # interactive device-code sign-in
loom auth login --sp            # service-principal (CI): reads LOOM_SP_* env
```

The CLI mints and replays the same encrypted `loom_session` the browser uses.
For fully non-interactive automation, prefer a scoped **API token** (see
[Scoped API tokens](api-tokens.md)) sent as `Authorization: Bearer loom_pat_…`.

## Workspaces

```bash
loom workspace list
loom workspace create --name "Analytics" --description "Team space"
```

## Items

```bash
loom item types                                   # the full item taxonomy
loom item list <workspaceId>
loom item create <workspaceId> --type lakehouse --name "Bronze lake"
loom item show   lakehouse <id>
loom item update lakehouse <id> --name "Renamed"
loom item delete lakehouse <id>
```

## Output

`--output json|yaml|table` (default `table`), or set `LOOM_OUTPUT`.

Every item type is Azure-native — no Microsoft Fabric tenant is required.
