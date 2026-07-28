# `csa-loom` — Python SDK for the CSA Loom API

The official Python client for a CSA Loom deployment. Its entire route surface is
**generated from the OpenAPI 3.1 document the deployment itself serves** at
`GET /api/openapi.json`, so the SDK cannot quietly drift from the API: CI
regenerates it and fails on any diff, and the contract tests assert the generated
operation table and the document agree **in both directions**.

- **Zero runtime dependencies.** Only the Python standard library — safe to vendor
  into an air-gapped Government estate, and trivially clean for the LIC0 license gate.
- **No cloud is baked in.** `base_url` (or `$LOOM_BASE_URL`) selects the deployment;
  the same code targets Commercial and Government with no branching.
- **Failures raise.** A refused request never comes back as `None` or `[]`. An honest
  infra gate surfaces as `LoomGateError` carrying the deployment's own remediation hint.
- **Fully typed.** `py.typed`, `TypedDict` per API schema, `mypy --strict` clean.

> Packaging + CI only — this package is **not published to PyPI** by this repository.

## Install (from source)

```bash
pip install -e "sdk/python/csa-loom[dev]"
```

## Use

```python
from csa_loom import LoomClient

with LoomClient("https://csa-loom.example.gov", token="loom_pat_<id>_<secret>") as loom:
    me = loom.whoami()                       # GET  /api/v1/whoami
    ws = loom.create_workspace(body={"name": "analytics"})
    item = loom.create_item(ws["id"], body={"itemType": "lakehouse", "displayName": "bronze"})
    hits = loom.search_catalog(q="sales", source="purview,unity-catalog", limit=20)
    loom.update_item("lakehouse", item["id"], body={"description": "curated bronze zone"})
```

Credentials and target resolve from the environment when not passed:

| Variable | Meaning |
|---|---|
| `LOOM_BASE_URL` | Origin of the deployment. Required (no default host). |
| `LOOM_API_TOKEN` | A scoped PAT — sent as `Authorization: Bearer …`. |
| `LOOM_SESSION_COOKIE` | An encrypted `loom_session` cookie (used only when no token is set). |

### Errors

| Exception | Raised when |
|---|---|
| `LoomAuthError` | 401 — no usable credential |
| `LoomForbiddenError` | 403 — token scope or tenant does not allow it |
| `LoomNotFoundError` | 404 |
| `LoomRateLimitError` | 429 (`.retry_after`) |
| `LoomGateError` | the response carries a remediation `hint` — a configuration gate, not a bug |
| `LoomApiError` | any other non-2xx |
| `LoomTransportError` | no HTTP response at all (DNS/TLS/timeout), or a refused URL scheme |

### Testing your own integration

`csa_loom.testing.StubTransport` is a supported part of the package, so consumers can
test against the real client code path with no network:

```python
from csa_loom import LoomClient
from csa_loom.testing import StubTransport

transport = StubTransport(payload=[{"id": "w1", "name": "analytics"}])
loom = LoomClient("https://loom.example.gov", token="t", transport=transport)
assert loom.list_workspaces()[0]["name"] == "analytics"
assert transport.last.url.endswith("/api/workspaces")
```

## How the generation + drift gate works

```
apps/fiab-console/lib/openapi/spec.ts     <- the single source of truth
        |  node sdk/scripts/dump-openapi.mjs
        v
sdk/openapi.json                          <- committed snapshot (also read by the Terraform provider)
        |  python sdk/python/csa-loom/scripts/generate_client.py
        v
src/csa_loom/_generated/{models,api,contract}.py
```

Four independent gates make drift impossible to merge:

1. **Vitest** — `apps/fiab-console/lib/openapi/__tests__/sdk-snapshot.test.ts` asserts
   `sdk/openapi.json` is byte-identical to `buildOpenApiSpec('')`. Changing the API
   without re-dumping fails the console test suite.
2. **`node sdk/scripts/dump-openapi.mjs --check`** — same assertion, in the `sdk-contract`
   CI lane, independent of the console suite.
3. **`python scripts/generate_client.py --check`** (also run as `tests/test_generator.py`) —
   the committed generated files are exactly what the generator produces from the snapshot.
4. **`tests/test_contract.py`** — every generated operation exists in the document, every
   document operation has a generated method, and referenced schemas exist.

Plus an **opt-in live receipt**: set `LOOM_BASE_URL` to a running estate and
`pytest -m live` re-runs the coverage assertions against that deployment's own
`GET /api/openapi.json` (the route is unauthenticated by design, so no credential is
needed). This is the post-roll proof that Commercial and Government both serve the
contract this SDK was built from.

## Regenerating after an API change

```bash
node sdk/scripts/dump-openapi.mjs                       # refresh sdk/openapi.json
python sdk/python/csa-loom/scripts/generate_client.py   # regenerate the client
cd sdk/python/csa-loom && python -m ruff check . && python -m mypy && python -m pytest
```

Never hand-edit anything under `src/csa_loom/_generated/` — `tests/test_generator.py`
fails if you do.

## Local gates

```bash
cd sdk/python/csa-loom
python -m ruff check .        # ruff (this package carries its own config)
python -m mypy                # strict, incl. generated code + tests
python -m pytest              # 95 tests, no network
```
