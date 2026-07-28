#!/usr/bin/env python3
"""B-N19b — generate the ``csa_loom`` core client from the Loom OpenAPI document.

The generator is deliberately small, dependency-free (standard library only) and
**deterministic**: given ``sdk/openapi.json`` it always emits byte-identical
output, which is what makes the drift gate meaningful.

Inputs
------
``sdk/openapi.json`` — the committed dump of ``buildOpenApiSpec('')`` from
``apps/fiab-console/lib/openapi/spec.ts`` (the exact document the console serves
at ``GET /api/openapi.json``). Refresh it with
``node sdk/scripts/dump-openapi.mjs``.

Outputs (all under ``src/csa_loom/_generated/``, all committed)
--------------------------------------------------------------
``models.py``    — one ``TypedDict`` per ``components.schemas`` entry.
``api.py``       — ``_GeneratedOperations``: one typed method per ``operationId``.
``contract.py``  — the operation metadata table + the SHA-256 of the spec the
                   code was generated from. ``tests/test_contract.py`` asserts
                   this table still matches the spec (and, when ``LOOM_BASE_URL``
                   is set, the *live* ``/api/openapi.json`` of a deployment).

Usage
-----
    python scripts/generate_client.py            # write
    python scripts/generate_client.py --check     # fail on drift, write nothing

Nothing here talks to the network, and nothing is published — packaging + CI only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import keyword
import re
import sys
from pathlib import Path
from typing import Any

SDK_DIR = Path(__file__).resolve().parents[1]  # sdk/python/csa-loom
SDK_ROOT = SDK_DIR.parents[1]  # sdk
SPEC_PATH = SDK_ROOT / "openapi.json"
OUT_DIR = SDK_DIR / "src" / "csa_loom" / "_generated"

BANNER = (
    "# GENERATED FILE - DO NOT EDIT BY HAND.\n"
    "#\n"
    "# Regenerate with:\n"
    "#     node sdk/scripts/dump-openapi.mjs\n"
    "#     python sdk/python/csa-loom/scripts/generate_client.py\n"
    "#\n"
    "# Source of truth: apps/fiab-console/lib/openapi/spec.ts (served at\n"
    "# GET /api/openapi.json). The sdk-contract CI lane regenerates and fails on\n"
    "# any diff, so this file can never silently drift from the API.\n"
)

# Names we refuse to emit as parameters/attributes because they shadow a builtin
# (ruff flake8-builtins A002) or are a Python keyword.
SHADOWED = {
    "type",
    "id",
    "filter",
    "format",
    "object",
    "input",
    "list",
    "dict",
    "set",
    "str",
    "int",
    "float",
    "bytes",
    "next",
    "all",
    "any",
    "max",
    "min",
    "sum",
    "hash",
    "property",
    "vars",
    "bytearray",
}

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def snake(name: str) -> str:
    """``scimServiceProviderConfig`` -> ``scim_service_provider_config``."""
    out = _CAMEL_BOUNDARY.sub("_", name)
    out = re.sub(r"[^0-9a-zA-Z_]+", "_", out)
    return out.lower().strip("_")


def py_param(name: str) -> str:
    """A safe Python parameter name for an OpenAPI parameter name."""
    base = snake(name)
    if keyword.iskeyword(base) or base in SHADOWED or keyword.issoftkeyword(base):
        return f"{base}_"
    return base


def ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[-1]


def literal_of(values: list[Any]) -> str:
    return "Literal[" + ", ".join(json.dumps(v) for v in values) + "]"


def py_type(schema: dict[str, Any] | None) -> str:
    """Map an OpenAPI schema fragment to a Python type expression.

    Model references are emitted BARE (``Workspace``, not ``"Workspace"``): the
    generated modules import every model they name, and ``from __future__ import
    annotations`` makes definition order irrelevant, so the expression is valid
    both as an annotation and as a runtime argument to ``typing.cast``.
    """
    if not schema:
        return "Any"
    if "$ref" in schema:
        return ref_name(schema["$ref"])
    enum = schema.get("enum")
    if isinstance(enum, list) and enum and all(isinstance(v, str) for v in enum):
        return literal_of(enum)
    kind = schema.get("type")
    if kind == "string":
        return "str"
    if kind == "integer":
        return "int"
    if kind == "number":
        return "float"
    if kind == "boolean":
        return "bool"
    if kind == "array":
        return f"list[{py_type(schema.get('items'))}]"
    if kind == "object" or "properties" in schema or "additionalProperties" in schema:
        # Inline (anonymous) objects stay loosely typed on purpose: naming them
        # would invent a contract the API document does not actually pin.
        return "Mapping[str, Any]"
    return "Any"


def doc_line(text: str) -> str:
    """One-line, safely escaped docstring body."""
    flat = " ".join(str(text).split())
    return flat.replace("\\", "\\\\").replace('"""', "'''")


# --------------------------------------------------------------------------- #
# models.py
# --------------------------------------------------------------------------- #


def render_models(spec: dict[str, Any]) -> str:
    schemas: dict[str, Any] = spec["components"]["schemas"]

    body: list[str] = []
    for name, schema in schemas.items():
        props: dict[str, Any] = schema.get("properties", {}) or {}
        required = set(schema.get("required", []) or [])
        body.append("")
        body.append("")
        body.append(f"class {name}(TypedDict):")
        desc = schema.get("description")
        head = doc_line(desc) if desc else f"``{name}`` — ``components.schemas.{name}`` of the Loom OpenAPI document."
        if schema.get("additionalProperties") is True:
            body.append(f'    """{head}')
            body.append("")
            body.append("    The API may return additional keys beyond those listed.")
            body.append('    """')
        else:
            body.append(f'    """{head}"""')
        body.append("")
        if not props:
            body.append("    # No properties are pinned by the document for this schema.")
            continue
        for prop, pschema in props.items():
            t = py_type(pschema if isinstance(pschema, dict) else None)
            ann = t if prop in required else f"NotRequired[{t}]"
            pdesc = pschema.get("description") if isinstance(pschema, dict) else None
            if pdesc:
                body.append(f"    #: {doc_line(pdesc)}")
            body.append(f"    {prop}: {ann}")

    rendered_body = "\n".join(body)

    header: list[str] = [
        BANNER.rstrip("\n"),
        "",
        '"""Typed shapes for every schema in the Loom OpenAPI document.',
        "",
        "Each entry of ``components.schemas`` becomes a ``TypedDict``. Keys the",
        "document marks required are required; everything else is ``NotRequired``.",
        "Property names are kept EXACTLY as the API emits them (camelCase) so a",
        "response dict validates against the TypedDict without translation.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
    ]
    header.extend(_typing_imports(rendered_body))
    header.append("")
    header.append("__all__ = [")
    header.extend(f'    "{name}",' for name in sorted(schemas))
    header.append("]")

    return "\n".join(header) + "\n" + rendered_body + "\n"


def _typing_imports(body: str) -> list[str]:
    """Emit only the ``typing``/``collections.abc`` imports the body actually uses."""
    out: list[str] = []
    if re.search(r"\bMapping\[", body):
        out.append("from collections.abc import Mapping")
    names = [n for n in ("Any", "Literal", "NotRequired", "TypedDict") if re.search(rf"\b{n}\b", body)]
    if names:
        out.append(f"from typing import {', '.join(names)}")
    return out


# --------------------------------------------------------------------------- #
# operation model
# --------------------------------------------------------------------------- #

HTTP_VERBS = ("get", "post", "put", "patch", "delete", "head", "options")


class Op:
    """One generated operation, resolved from the OpenAPI document."""

    def __init__(self, path: str, verb: str, op: dict[str, Any], shared: list[dict[str, Any]]) -> None:
        self.path = path
        self.verb = verb.upper()
        self.operation_id: str = op["operationId"]
        self.method_name = snake(self.operation_id)
        self.summary: str = op.get("summary", "") or ""
        self.description: str = op.get("description", "") or ""

        params = [*shared, *(op.get("parameters") or [])]
        self.path_params = [p for p in params if p.get("in") == "path"]
        self.query_params = [p for p in params if p.get("in") == "query"]

        body = op.get("requestBody") or {}
        content = body.get("content") or {}
        self.body_media: str | None = next(iter(content), None)
        self.body_schema: dict[str, Any] | None = (
            content[self.body_media].get("schema") if self.body_media else None
        )
        self.body_required = bool(body.get("required"))

        self.status, self.response_media, self.response_schema = self._pick_response(op)

    @staticmethod
    def _pick_response(op: dict[str, Any]) -> tuple[str, str | None, dict[str, Any] | None]:
        responses: dict[str, Any] = op.get("responses") or {}
        ok = sorted(c for c in responses if c.startswith("2"))
        if not ok:
            return "200", None, None
        code = ok[0]
        content = (responses[code] or {}).get("content") or {}
        media = next(iter(content), None)
        schema = content[media].get("schema") if media else None
        return code, media, schema

    @property
    def return_type(self) -> str:
        if self.response_schema is None:
            return "None"
        return py_type(self.response_schema)

    @property
    def body_type(self) -> str:
        return py_type(self.body_schema)


def collect_ops(spec: dict[str, Any]) -> list[Op]:
    ops: list[Op] = []
    for path, item in spec["paths"].items():
        shared = item.get("parameters") or []
        for verb in HTTP_VERBS:
            op = item.get(verb)
            if isinstance(op, dict) and "operationId" in op:
                ops.append(Op(path, verb, op, shared))
    return ops


# --------------------------------------------------------------------------- #
# api.py
# --------------------------------------------------------------------------- #


def render_api(spec: dict[str, Any], ops: list[Op]) -> str:
    model_names = set(spec["components"]["schemas"])

    body: list[str] = [
        "",
        "",
        "class _GeneratedOperations:",
        '    """Generated API surface. Mixed into :class:`csa_loom.LoomClient`."""',
        "",
        "    def _request(",
        "        self,",
        "        method: str,",
        "        path: str,",
        "        *,",
        "        query: Mapping[str, Any] | None = None,",
        "        body: Any = None,",
        "        content_type: str | None = None,",
        "        accept: str | None = None,",
        "    ) -> Any:",
        '        """Perform one HTTP call. Implemented by :class:`csa_loom.LoomClient`."""',
        "        raise NotImplementedError  # pragma: no cover - overridden by LoomClient",
    ]
    for op in ops:
        body.append("")
        body.extend(render_method(op))
    rendered_body = "\n".join(body)

    used_models = sorted(n for n in model_names if re.search(rf"\b{n}\b", rendered_body))
    uses_expand = "expand(" in rendered_body

    header: list[str] = [
        BANNER.rstrip("\n"),
        "",
        '"""One typed method per ``operationId`` in the Loom OpenAPI document.',
        "",
        "``_GeneratedOperations`` is a mixin: it owns NO transport. ``LoomClient``",
        "supplies ``_request``; every method below is a thin, fully-typed shim over",
        "it, so the hand-written transport and the generated surface can never",
        "disagree about a route.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from collections.abc import Mapping",
    ]
    typing_names = [n for n in ("Any", "Literal", "cast") if re.search(rf"\b{n}\b", rendered_body)]
    header.append(f"from typing import {', '.join(typing_names)}")
    header.append("")
    if uses_expand:
        header.append("from csa_loom._paths import expand")
        header.append("")
    if used_models:
        header.append("from .models import (")
        header.extend(f"    {name}," for name in used_models)
        header.append(")")
        header.append("")
    header.append('__all__ = ["_GeneratedOperations"]')

    return "\n".join(header) + "\n" + rendered_body + "\n"


def render_method(op: Op) -> list[str]:
    out: list[str] = []
    sig: list[str] = ["self"]
    for p in op.path_params:
        sig.append(f"{py_param(p['name'])}: {py_type(p.get('schema'))}")
    kwonly: list[str] = []
    if op.body_schema is not None:
        kwonly.append(f"body: {op.body_type}" + ("" if op.body_required else " | None = None"))
    for p in op.query_params:
        kwonly.append(f"{py_param(p['name'])}: {py_type(p.get('schema'))} | None = None")
    if kwonly:
        sig.append("*")
        sig.extend(kwonly)

    if len(sig) == 1:
        out.append(f"    def {op.method_name}(self) -> {op.return_type}:")
    else:
        out.append(f"    def {op.method_name}(")
        out.extend(f"        {part}," for part in sig)
        out.append(f"    ) -> {op.return_type}:")

    # Docstring — summary, then the exact route + operationId, then the API's own prose.
    head = doc_line(op.summary) or f"{op.verb} {op.path}"
    if not head.endswith("."):
        head += "."
    out.append(f'        """{head}')
    out.append("")
    out.append(f"        ``{op.verb} {op.path}`` (operationId ``{op.operation_id}``).")
    if op.description:
        out.append("")
        for chunk in _wrap(doc_line(op.description), width=88, indent="        "):
            out.append(chunk)
    out.append('        """')

    # Path expansion
    if op.path_params:
        pairs = ", ".join(f'"{p["name"]}": {py_param(p["name"])}' for p in op.path_params)
        out.append(f'        path = expand("{op.path}", {{{pairs}}})')
    else:
        out.append(f'        path = "{op.path}"')

    # Query string
    if op.query_params:
        out.append("        query: dict[str, Any] = {}")
        for p in op.query_params:
            var = py_param(p["name"])
            out.append(f"        if {var} is not None:")
            out.append(f'            query["{p["name"]}"] = {var}')
    else:
        out.append("        query: dict[str, Any] | None = None")

    returns = op.return_type != "None"
    call = [
        f"        {'result = ' if returns else ''}self._request(",
        f'            "{op.verb}",',
        "            path,",
        "            query=query,",
        f"            body={'body' if op.body_schema is not None else 'None'},",
    ]
    if op.body_media:
        call.append(f'            content_type="{op.body_media}",')
    if op.response_media:
        call.append(f'            accept="{op.response_media}",')
    call.append("        )")
    out.extend(call)

    if returns:
        out.append(f"        return cast({op.return_type}, result)")
    return out


def _wrap(text: str, *, width: int, indent: str) -> list[str]:
    """Deterministic greedy word-wrap (no textwrap heuristics to drift on)."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if current and len(indent) + len(candidate) > width:
            lines.append(indent + current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(indent + current)
    return lines


# --------------------------------------------------------------------------- #
# contract.py
# --------------------------------------------------------------------------- #


def _lit(value: str | None) -> str:
    """A double-quoted Python string literal (or ``None``) — repr() would emit single quotes."""
    return "None" if value is None else json.dumps(value)


def _tuple_lit(values: tuple[str, ...]) -> str:
    if not values:
        return "()"
    if len(values) == 1:
        return f"({json.dumps(values[0])},)"
    return "(" + ", ".join(json.dumps(v) for v in values) + ")"


def render_contract(spec: dict[str, Any], ops: list[Op], spec_sha: str) -> str:
    lines: list[str] = [
        BANNER.rstrip("\n"),
        "",
        '"""The machine-checkable contract between this SDK and the Loom API.',
        "",
        "``tests/test_contract.py`` asserts, in both directions, that every entry",
        "here still exists in ``sdk/openapi.json`` and that every operation in the",
        "document has a generated method — so an API change that is not",
        "regenerated fails CI instead of failing a user at runtime.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Final, NamedTuple",
        "",
        '__all__ = ["OPERATIONS", "SPEC_SHA256", "SPEC_TITLE", "SPEC_VERSION", "GeneratedOperation"]',
        "",
        "",
        "class GeneratedOperation(NamedTuple):",
        '    """One row of the generated API surface."""',
        "",
        "    operation_id: str",
        "    method: str",
        "    path: str",
        "    python_name: str",
        "    path_params: tuple[str, ...]",
        "    query_params: tuple[str, ...]",
        "    request_schema: str | None",
        "    response_schema: str | None",
        "",
        "",
        f"SPEC_TITLE: Final[str] = {_lit(spec['info']['title'])}",
        f"SPEC_VERSION: Final[str] = {_lit(spec['info']['version'])}",
        "#: SHA-256 of sdk/openapi.json at generation time (drift tripwire).",
        f"SPEC_SHA256: Final[str] = {_lit(spec_sha)}",
        "",
        "OPERATIONS: Final[tuple[GeneratedOperation, ...]] = (",
    ]
    for op in ops:
        req = ref_name(op.body_schema["$ref"]) if op.body_schema and "$ref" in op.body_schema else None
        resp = _response_schema_name(op)
        path_params = tuple(p["name"] for p in op.path_params)
        query_params = tuple(p["name"] for p in op.query_params)
        lines.append("    GeneratedOperation(")
        lines.append(f"        operation_id={_lit(op.operation_id)},")
        lines.append(f"        method={_lit(op.verb)},")
        lines.append(f"        path={_lit(op.path)},")
        lines.append(f"        python_name={_lit(op.method_name)},")
        lines.append(f"        path_params={_tuple_lit(path_params)},")
        lines.append(f"        query_params={_tuple_lit(query_params)},")
        lines.append(f"        request_schema={_lit(req)},")
        lines.append(f"        response_schema={_lit(resp)},")
        lines.append("    ),")
    lines.append(")")
    return "\n".join(lines).rstrip("\n") + "\n"


def _response_schema_name(op: Op) -> str | None:
    schema = op.response_schema
    if not schema:
        return None
    if "$ref" in schema:
        return ref_name(schema["$ref"])
    items = schema.get("items") if schema.get("type") == "array" else None
    if isinstance(items, dict) and "$ref" in items:
        return f"{ref_name(items['$ref'])}[]"
    return None


# --------------------------------------------------------------------------- #
# driver
# --------------------------------------------------------------------------- #


def render_init() -> str:
    return (
        BANNER
        + "\n"
        + '"""Generated modules. Import from :mod:`csa_loom`, not from here."""\n'
        "\n"
        "from __future__ import annotations\n"
    )


def spec_digest(text: str) -> str:
    """SHA-256 of the spec, normalised to LF.

    Hashing raw bytes would make the tripwire fire on a CRLF checkout even
    though the document is identical. `.gitattributes` pins `sdk/**` to LF; this
    is the second line of defence.
    """
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def build() -> dict[Path, str]:
    raw = SPEC_PATH.read_text(encoding="utf-8")
    spec: dict[str, Any] = json.loads(raw)
    spec_sha = spec_digest(raw)
    ops = collect_ops(spec)
    return {
        OUT_DIR / "__init__.py": render_init(),
        OUT_DIR / "models.py": render_models(spec),
        OUT_DIR / "api.py": render_api(spec, ops),
        OUT_DIR / "contract.py": render_contract(spec, ops, spec_sha),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail on drift instead of writing")
    args = parser.parse_args(argv)

    if not SPEC_PATH.exists():
        print(f"[csa-loom] missing {SPEC_PATH} - run: node sdk/scripts/dump-openapi.mjs", file=sys.stderr)
        return 1

    files = build()
    if args.check:
        drifted = [p for p, text in files.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
        if drifted:
            for p in drifted:
                print(f"[csa-loom] DRIFT: {p.relative_to(SDK_DIR)}", file=sys.stderr)
            print(
                "[csa-loom] the generated client no longer matches sdk/openapi.json.\n"
                "           Fix: python sdk/python/csa-loom/scripts/generate_client.py",
                file=sys.stderr,
            )
            return 1
        print(f"[csa-loom] OK - {len(files)} generated files match sdk/openapi.json")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for p, text in files.items():
        p.write_text(text, encoding="utf-8", newline="\n")
    print(f"[csa-loom] wrote {len(files)} files to {OUT_DIR.relative_to(SDK_DIR)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
