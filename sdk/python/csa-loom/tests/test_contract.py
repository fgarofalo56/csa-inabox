"""B-N19b contract tests — the SDK may not drift from the API.

Three layers, cheapest first:

1. **Hash tripwire** — the SHA-256 baked into the generated code equals the hash
   of ``sdk/openapi.json``. Catches "someone re-dumped the spec and forgot to
   regenerate" in a single comparison.
2. **Bidirectional operation coverage** — every generated operation exists in
   the document with the same verb, path, parameters and schemas; and every
   operation in the document has a generated Python method. Catches an added
   route (missing from the SDK) *and* a removed route (dead SDK method).
3. **Live check (opt-in)** — when ``LOOM_BASE_URL`` points at a real deployment,
   the same assertions run against that deployment's ``GET /api/openapi.json``.
   This is the receipt that a *running* Commercial or Government estate serves
   the contract this SDK was generated from.

Layers 1 and 2 run everywhere (including offline); layer 3 skips unless the env
var is set, so CI never silently passes by not testing anything.
"""

from __future__ import annotations

import hashlib
import inspect
import os
from pathlib import Path
from typing import Any

import pytest

from csa_loom import LoomClient
from csa_loom._generated.contract import OPERATIONS, SPEC_SHA256, SPEC_TITLE, SPEC_VERSION

#: sdk/openapi.json — the document both SDKs are generated from.
SPEC_PATH = Path(__file__).resolve().parents[3] / "openapi.json"

HTTP_VERBS = ("get", "post", "put", "patch", "delete", "head", "options")


def _document_operations(spec: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """``operationId`` -> a normalised view of the operation in the document."""
    found: dict[str, dict[str, Any]] = {}
    for path, item in spec["paths"].items():
        shared = item.get("parameters") or []
        for verb in HTTP_VERBS:
            op = item.get(verb)
            if not isinstance(op, dict) or "operationId" not in op:
                continue
            params = [*shared, *(op.get("parameters") or [])]
            found[op["operationId"]] = {
                "method": verb.upper(),
                "path": path,
                "path_params": tuple(p["name"] for p in params if p.get("in") == "path"),
                "query_params": tuple(p["name"] for p in params if p.get("in") == "query"),
            }
    return found


# --------------------------------------------------------------------------- #
# 1. hash tripwire
# --------------------------------------------------------------------------- #


def test_generated_code_matches_the_committed_spec_hash() -> None:
    # Normalised to LF so the tripwire measures the CONTRACT, not the checkout's
    # line endings (`.gitattributes` pins sdk/** to LF; this is belt and braces).
    text = SPEC_PATH.read_text(encoding="utf-8").replace("\r\n", "\n")
    actual = hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert actual == SPEC_SHA256, (
        "sdk/openapi.json changed but the client was not regenerated.\n"
        "Fix: python sdk/python/csa-loom/scripts/generate_client.py"
    )


def test_spec_identity_is_pinned(spec: dict[str, Any]) -> None:
    assert spec["openapi"].startswith("3.1")
    assert spec["info"]["title"] == SPEC_TITLE
    assert spec["info"]["version"] == SPEC_VERSION


def test_no_cloud_host_is_baked_into_the_snapshot(spec: dict[str, Any]) -> None:
    """The dumped server entry must stay deployment-independent.

    A hard-coded Commercial host would make the generated SDK wrong for a
    Government estate — the same defect class the cloud-endpoint-literal ratchet
    guards in the console.
    """
    servers = spec["servers"]
    assert servers[0]["url"] == "/", f"expected the relative server entry, got {servers[0]['url']!r}"


# --------------------------------------------------------------------------- #
# 2. bidirectional coverage
# --------------------------------------------------------------------------- #


def test_every_generated_operation_exists_in_the_document(spec: dict[str, Any]) -> None:
    document = _document_operations(spec)
    missing = [op.operation_id for op in OPERATIONS if op.operation_id not in document]
    assert not missing, f"generated operations that no longer exist in the API: {missing}"


def test_every_document_operation_has_a_generated_method(spec: dict[str, Any]) -> None:
    document = _document_operations(spec)
    generated = {op.operation_id for op in OPERATIONS}
    missing = sorted(set(document) - generated)
    assert not missing, (
        f"the API exposes operations the SDK does not: {missing}\n"
        "Fix: node sdk/scripts/dump-openapi.mjs && python sdk/python/csa-loom/scripts/generate_client.py"
    )


@pytest.mark.parametrize("op", OPERATIONS, ids=lambda o: o.operation_id)
def test_operation_shape_matches_the_document(op: Any, spec: dict[str, Any]) -> None:
    doc = _document_operations(spec)[op.operation_id]
    assert op.method == doc["method"]
    assert op.path == doc["path"]
    assert op.path_params == doc["path_params"]
    assert op.query_params == doc["query_params"]


@pytest.mark.parametrize("op", OPERATIONS, ids=lambda o: o.operation_id)
def test_every_operation_is_callable_on_the_client(op: Any) -> None:
    method = getattr(LoomClient, op.python_name, None)
    assert callable(method), f"LoomClient has no method {op.python_name!r} for {op.operation_id}"
    signature = inspect.signature(method)
    for name in op.path_params:
        assert any(p.startswith(_snake(name)) for p in signature.parameters), (
            f"{op.python_name} is missing a parameter for path param {name!r}"
        )


def test_referenced_schemas_exist(spec: dict[str, Any]) -> None:
    schemas = spec["components"]["schemas"]
    for op in OPERATIONS:
        if op.request_schema:
            assert op.request_schema in schemas, f"{op.operation_id}: unknown request schema {op.request_schema}"
        if op.response_schema:
            assert op.response_schema.removesuffix("[]") in schemas, (
                f"{op.operation_id}: unknown response schema {op.response_schema}"
            )


def test_operation_ids_are_unique() -> None:
    ids = [op.operation_id for op in OPERATIONS]
    assert len(ids) == len(set(ids))
    names = [op.python_name for op in OPERATIONS]
    assert len(names) == len(set(names)), "two operations generated the same Python method name"


def _snake(name: str) -> str:
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


# --------------------------------------------------------------------------- #
# 3. live deployment (opt-in)
# --------------------------------------------------------------------------- #

LIVE_BASE_URL = os.environ.get("LOOM_BASE_URL", "").strip()


@pytest.mark.live
@pytest.mark.skipif(not LIVE_BASE_URL, reason="set LOOM_BASE_URL to contract-test a live deployment")
def test_live_deployment_serves_the_same_contract() -> None:
    """Pull ``/api/openapi.json`` from a real estate and re-run the coverage check.

    The route is unauthenticated by design, so this needs no credential — which
    is what makes it usable as a post-roll receipt on both Commercial and
    Government.
    """
    live = dict(LoomClient(LIVE_BASE_URL).openapi())
    document = _document_operations(live)
    generated = {op.operation_id for op in OPERATIONS}
    assert live["info"]["title"] == SPEC_TITLE
    assert not (generated - set(document)), f"SDK has operations {LIVE_BASE_URL} does not serve"
    assert not (set(document) - generated), f"{LIVE_BASE_URL} serves operations the SDK does not implement"
