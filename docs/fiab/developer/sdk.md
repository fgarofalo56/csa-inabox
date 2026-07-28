# SDKs

## `csa-loom` — the first-party Python SDK

Source: [`sdk/python/csa-loom`](https://github.com/fgarofalo56/csa-inabox/tree/main/sdk/python/csa-loom).

Its entire route surface is **generated from the OpenAPI 3.1 document your own
deployment serves** at `GET /api/openapi.json`, so it cannot drift from the API:
CI regenerates the client and fails on any diff, and contract tests assert the
generated operation table and the document agree in both directions.

!!! note "Not on PyPI (yet)"
    The package is built, typed and CI-gated, but this repository does **not**
    publish it. Install it from source; publishing is a separate operator
    decision.

```bash
pip install -e "sdk/python/csa-loom"
```

```python
from csa_loom import LoomClient

with LoomClient("https://<your-loom-host>", token="loom_pat_<id>_<secret>") as loom:
    me = loom.whoami()
    ws = loom.create_workspace(body={"name": "analytics"})
    item = loom.create_item(ws["id"], body={"itemType": "lakehouse", "displayName": "bronze"})
```

Characteristics:

- **Zero runtime dependencies** — the transport is `urllib` from the standard
  library, so the package installs cleanly in an air-gapped Government estate.
- **No cloud hard-coded** — `base_url` (or `$LOOM_BASE_URL`) selects the
  deployment; Commercial and Government run identical code.
- **Failures raise.** A refused request never returns `None` or `[]`. An honest
  infra gate surfaces as `LoomGateError` carrying the deployment's own
  remediation hint.
- **Fully typed** — `py.typed`, a `TypedDict` per API schema, `mypy --strict` clean.

## `@csa-loom/sdk` — the TypeScript client

Source: [`apps/loom-sdk`](https://github.com/fgarofalo56/csa-inabox/tree/main/apps/loom-sdk).
Typed `LoomClient` over workspaces / items / catalog / thread / tokens, with
cookie **or** scoped-token auth. Released by `publish-loom-sdk.yml`.

## Any other language: generate one from the spec

The Loom API publishes a complete **OpenAPI 3.1** document at
`GET /api/openapi.json`. Generate a typed client for any language:

```bash
# Go
openapi-generator-cli generate -i https://<host>/api/openapi.json -g go -o ./loom-go
# Java
openapi-generator-cli generate -i https://<host>/api/openapi.json -g java -o ./loom-java
```

Authenticate every request with a scoped API token
(`Authorization: Bearer loom_pat_…`). Because the spec's server URL is your
deployment, the generated client targets the correct cloud automatically.
