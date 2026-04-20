"""csa_platform.streaming CLI — contract validator (CSA-0137).

Usage::

    python -m csa_platform.streaming validate path/to/contract.yaml

Exit codes:
    0 - contract parsed and cross-referenced successfully
    1 - YAML / Pydantic validation error (first error printed)
    2 - usage error (missing arg, file not found)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml
from pydantic import ValidationError

from csa_platform.streaming.models import StreamingContractBundle


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
    return parser


def _cmd_validate(path: Path) -> int:
    if not path.exists():
        print(f"error: file not found: {path}", file=sys.stderr)
        return 2
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        print(f"error: invalid YAML: {exc}", file=sys.stderr)
        return 1
    if not isinstance(raw, dict):
        print("error: contract file must be a YAML mapping at the top level", file=sys.stderr)
        return 1
    try:
        bundle = StreamingContractBundle.model_validate(raw)
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
    print(
        "ok: "
        f"{len(bundle.sources)} source(s), "
        f"{len(bundle.bronze)} bronze, "
        f"{len(bundle.silver)} silver, "
        f"{len(bundle.gold)} gold — cross-references resolved.",
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "validate":
        return _cmd_validate(args.path)
    parser.print_help(sys.stderr)  # pragma: no cover - argparse handles this
    return 2  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
