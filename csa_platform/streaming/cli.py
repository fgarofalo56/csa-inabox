"""csa_platform.streaming CLI — contract validator (CSA-0137).

Usage::

    python -m csa_platform.streaming validate path/to/contract.yaml
    python -m csa_platform.streaming validate-schemas path/to/contract.yaml \\
        [--registry {noop,confluent,azure}] [--registry-url URL]

Exit codes (both subcommands):
    0 - contract parsed and cross-referenced successfully
    1 - YAML / Pydantic validation error or schema-registry issue
    2 - usage error (missing arg, file not found)
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import yaml
from pydantic import ValidationError

from csa_platform.streaming.models import StreamingContractBundle

if TYPE_CHECKING:  # pragma: no cover
    from csa_platform.streaming.schema_registry import SchemaRegistry


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m csa_platform.streaming",
        description="CSA-in-a-Box streaming contract CLI (CSA-0137).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser(
        "validate",
        help="Validate a streaming contract YAML file.",
    )
    validate.add_argument("path", type=Path, help="Path to the contract YAML file.")

    validate_schemas = sub.add_parser(
        "validate-schemas",
        help="Resolve every schema_ref against a registry and report issues.",
    )
    validate_schemas.add_argument(
        "path", type=Path, help="Path to the contract YAML file.",
    )
    validate_schemas.add_argument(
        "--registry",
        choices=("noop", "confluent", "azure"),
        default="noop",
        help="Registry backend (default: noop for offline CI).",
    )
    validate_schemas.add_argument(
        "--registry-url",
        default=None,
        help=(
            "Base URL (Confluent) or fully-qualified namespace (Azure). "
            "Not required when --registry=noop."
        ),
    )
    return parser


def _load_bundle(path: Path) -> StreamingContractBundle | int:
    """Parse ``path`` into a bundle or return an int exit code on error."""
    if not path.exists():
        print(f"error: file not found: {path}", file=sys.stderr)
        return 2
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        print(f"error: invalid YAML: {exc}", file=sys.stderr)
        return 1
    if not isinstance(raw, dict):
        print(
            "error: contract file must be a YAML mapping at the top level",
            file=sys.stderr,
        )
        return 1
    try:
        return StreamingContractBundle.model_validate(raw)
    except ValidationError as exc:
        errors = exc.errors()
        if errors:
            first = errors[0]
            loc = ".".join(str(p) for p in first.get("loc", ())) or "<root>"
            msg = first.get("msg", str(exc))
        else:
            loc = "<root>"
            msg = str(exc)
        print(f"error: {loc}: {msg}", file=sys.stderr)
        return 1


def _cmd_validate(path: Path) -> int:
    bundle = _load_bundle(path)
    if isinstance(bundle, int):
        return bundle
    print(
        "ok: "
        f"{len(bundle.sources)} source(s), "
        f"{len(bundle.bronze)} bronze, "
        f"{len(bundle.silver)} silver, "
        f"{len(bundle.gold)} gold — cross-references resolved.",
    )
    return 0


def _build_registry(kind: str, url: str | None) -> SchemaRegistry:
    """Construct a registry from the CLI flags.  Imports are lazy."""
    if kind == "noop":
        from csa_platform.streaming.schema_registry import NoopSchemaRegistry

        return NoopSchemaRegistry()
    if kind == "confluent":
        if not url:
            raise ValueError(
                "--registry-url is required when --registry=confluent",
            )
        from csa_platform.streaming.schema_registry import ConfluentCompatRegistry

        return ConfluentCompatRegistry(base_url=url)
    if kind == "azure":
        if not url:
            raise ValueError(
                "--registry-url is required when --registry=azure "
                "(use the fully-qualified namespace, e.g. "
                "my-eh.servicebus.windows.net)",
            )
        from csa_platform.streaming.schema_registry import AzureSchemaRegistry

        return AzureSchemaRegistry(fully_qualified_namespace=url)
    raise ValueError(f"unsupported registry kind: {kind!r}")  # pragma: no cover


def _cmd_validate_schemas(path: Path, *, kind: str, url: str | None) -> int:
    bundle = _load_bundle(path)
    if isinstance(bundle, int):
        return bundle
    try:
        registry = _build_registry(kind, url)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    issues = asyncio.run(bundle.validate_schemas(registry))
    if not issues:
        print(
            f"ok: all {len(bundle.sources)} schema_ref(s) resolved "
            f"against registry={kind}.",
        )
        return 0

    for issue in issues:
        marker = "error" if issue.severity == "error" else "warn"
        print(
            f"{marker}: source={issue.source_name!r} "
            f"ref={issue.ref!r}: {issue.message}",
            file=sys.stderr,
        )
    errors = [i for i in issues if i.severity == "error"]
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "validate":
        return _cmd_validate(args.path)
    if args.command == "validate-schemas":
        return _cmd_validate_schemas(
            args.path, kind=args.registry, url=args.registry_url,
        )
    parser.print_help(sys.stderr)  # pragma: no cover
    return 2  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
