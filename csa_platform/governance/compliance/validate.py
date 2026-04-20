#!/usr/bin/env python3
"""Validate compliance manifests for schema shape and evidence integrity.

Loads the YAML control manifests in this directory and enforces:

1.  Required top-level fields are present (framework, baseline, version,
    controls, ...).
2.  Every control has ``id``, ``title``, ``family``, ``status``.
3.  ``status`` is one of the allowed status codes.
4.  Any control marked ``IMPLEMENTED`` has at least one ``evidence`` entry.
5.  Every ``evidence`` entry references a ``path`` that exists on disk
    (resolved relative to the repository root).
6.  ``evidence.kind`` is one of the allowed evidence kinds.

Exit code 0 on clean validation; non-zero on any issue (with a detailed
report).  Emits aggregate stats on success.

Usage::

    python csa_platform/governance/compliance/validate.py
    python csa_platform/governance/compliance/validate.py --strict      # warnings → errors
    python csa_platform/governance/compliance/validate.py --manifests csa_platform/governance/compliance/*.yaml

This is deliberately dependency-light: it uses only the standard library
plus PyYAML, which is already a transitive dependency of the platform.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    print("ERROR: PyYAML is required. Install with: pip install pyyaml", file=sys.stderr)
    raise SystemExit(2) from exc

# Repository root is three levels above this file:
# .../csa_platform/governance/compliance/validate.py (CSA-0126 consolidation).
REPO_ROOT = Path(__file__).resolve().parents[3]

ALLOWED_STATUS = {
    "IMPLEMENTED",
    "PARTIALLY_IMPLEMENTED",
    "PLANNED",
    "NOT_APPLICABLE",
    "INHERITED",
}

ALLOWED_EVIDENCE_KINDS = {
    "bicep",
    "policy",
    "code",
    "script",
    "ci",
    "doc",
    "config",
}

REQUIRED_MANIFEST_FIELDS = {
    "framework",
    "baseline",
    "version",
    "last_reviewed",
    "reviewer",
    "source_of_truth_url",
    "controls",
}

DEFAULT_MANIFESTS = [
    "csa_platform/governance/compliance/nist-800-53-rev5.yaml",
    "csa_platform/governance/compliance/cmmc-2.0-l2.yaml",
    "csa_platform/governance/compliance/hipaa-security-rule.yaml",
]


@dataclass
class ValidationReport:
    """Accumulates errors, warnings, and stats for a validation run."""

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats_by_framework: dict[str, dict[str, Any]] = field(default_factory=dict)

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    @property
    def ok(self) -> bool:
        return not self.errors


def _load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top-level YAML is not a mapping")
    return data


def _validate_manifest_shape(
    manifest: dict[str, Any],
    source: Path,
    report: ValidationReport,
) -> None:
    """Check top-level required fields."""
    missing = REQUIRED_MANIFEST_FIELDS - set(manifest)
    for field_name in sorted(missing):
        report.error(f"{source.name}: missing required top-level field '{field_name}'")

    controls = manifest.get("controls")
    if not isinstance(controls, list) or not controls:
        report.error(f"{source.name}: 'controls' must be a non-empty list")


def _validate_control(
    control: dict[str, Any],
    source: Path,
    report: ValidationReport,
    evidence_counter: Counter,
) -> None:
    cid = control.get("id", "<unknown>")
    where = f"{source.name}:{cid}"

    for required in ("id", "title", "family", "status"):
        if not control.get(required):
            report.error(f"{where}: missing required field '{required}'")

    status = control.get("status")
    if status and status not in ALLOWED_STATUS:
        report.error(
            f"{where}: invalid status '{status}'. "
            f"Allowed: {sorted(ALLOWED_STATUS)}"
        )

    evidence = control.get("evidence") or []
    if not isinstance(evidence, list):
        report.error(f"{where}: 'evidence' must be a list")
        evidence = []

    # Rule: IMPLEMENTED controls MUST have evidence.
    if status == "IMPLEMENTED" and not evidence:
        report.error(
            f"{where}: status=IMPLEMENTED but has zero evidence entries "
            "(downgrade to PARTIALLY_IMPLEMENTED or INHERITED, or add evidence)"
        )

    # Rule: PARTIALLY_IMPLEMENTED controls SHOULD have evidence; warn if not.
    if status == "PARTIALLY_IMPLEMENTED" and not evidence:
        report.warn(
            f"{where}: status=PARTIALLY_IMPLEMENTED but has zero evidence entries"
        )

    # Rule: INHERITED controls SHOULD declare inheritance.
    if status == "INHERITED" and not control.get("inheritance"):
        report.warn(
            f"{where}: status=INHERITED but no 'inheritance:' block declared"
        )

    for idx, evid in enumerate(evidence):
        evid_where = f"{where}.evidence[{idx}]"
        if not isinstance(evid, dict):
            report.error(f"{evid_where}: evidence entry must be a mapping")
            continue

        kind = evid.get("kind")
        if kind not in ALLOWED_EVIDENCE_KINDS:
            report.error(
                f"{evid_where}: invalid kind '{kind}'. "
                f"Allowed: {sorted(ALLOWED_EVIDENCE_KINDS)}"
            )
        else:
            evidence_counter[kind] += 1

        rel_path = evid.get("path")
        if not rel_path:
            report.error(f"{evid_where}: missing 'path' field")
            continue

        abs_path = (REPO_ROOT / rel_path).resolve()
        if not abs_path.exists():
            report.error(
                f"{evid_where}: path '{rel_path}' does not exist on disk "
                f"(resolved: {abs_path})"
            )


def validate_manifest(path: Path, report: ValidationReport) -> None:
    """Run all validators against a single manifest file."""
    try:
        manifest = _load_manifest(path)
    except (yaml.YAMLError, ValueError) as exc:
        report.error(f"{path.name}: failed to load: {exc}")
        return

    _validate_manifest_shape(manifest, path, report)

    controls = manifest.get("controls") or []
    status_counts: Counter = Counter()
    family_counts: dict[str, Counter] = defaultdict(Counter)
    evidence_counter: Counter = Counter()

    for control in controls:
        if not isinstance(control, dict):
            report.error(f"{path.name}: a control entry is not a mapping")
            continue
        _validate_control(control, path, report, evidence_counter)
        status = control.get("status", "UNKNOWN")
        family = control.get("family", "UNKNOWN")
        status_counts[status] += 1
        family_counts[family][status] += 1

    report.stats_by_framework[manifest.get("framework", path.name)] = {
        "manifest_path": str(path.relative_to(REPO_ROOT)),
        "total_controls": len(controls),
        "status_breakdown": dict(status_counts),
        "family_breakdown": {f: dict(c) for f, c in sorted(family_counts.items())},
        "evidence_by_kind": dict(evidence_counter),
        "total_evidence_items": sum(evidence_counter.values()),
    }


def _render_report(report: ValidationReport) -> str:
    lines: list[str] = []
    lines.append("=" * 72)
    lines.append("CSA-in-a-Box Compliance Manifest Validation")
    lines.append("=" * 72)

    for framework, stats in report.stats_by_framework.items():
        lines.append("")
        lines.append(f"> {framework}  ({stats['manifest_path']})")
        lines.append(f"   Total controls:       {stats['total_controls']}")
        lines.append(f"   Total evidence items: {stats['total_evidence_items']}")
        lines.append("   Status breakdown:")
        for status in sorted(stats["status_breakdown"]):
            count = stats["status_breakdown"][status]
            lines.append(f"     {status:<25} {count:>4}")
        if stats.get("evidence_by_kind"):
            lines.append("   Evidence by kind:")
            for kind in sorted(stats["evidence_by_kind"]):
                lines.append(
                    f"     {kind:<25} {stats['evidence_by_kind'][kind]:>4}"
                )

    lines.append("")
    lines.append("-" * 72)
    if report.warnings:
        lines.append(f"WARNINGS ({len(report.warnings)}):")
        for w in report.warnings:
            lines.append(f"  [!] {w}")
        lines.append("")
    if report.errors:
        lines.append(f"ERRORS ({len(report.errors)}):")
        for e in report.errors:
            lines.append(f"  [X] {e}")
        lines.append("")

    if report.ok and not report.warnings:
        lines.append("[OK]  All manifests validated cleanly.")
    elif report.ok:
        lines.append(
            f"[OK]  Validation passed with {len(report.warnings)} warning(s)."
        )
    else:
        lines.append(
            f"[FAIL]  Validation FAILED: {len(report.errors)} error(s), "
            f"{len(report.warnings)} warning(s)."
        )
    lines.append("=" * 72)
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate CSA-in-a-Box compliance YAML manifests."
    )
    parser.add_argument(
        "--manifests",
        nargs="+",
        default=DEFAULT_MANIFESTS,
        help="YAML manifest paths (relative to repo root).",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors (non-zero exit if any warning).",
    )
    args = parser.parse_args(argv)

    report = ValidationReport()
    for rel in args.manifests:
        path = (REPO_ROOT / rel).resolve()
        if not path.exists():
            report.error(f"manifest file not found: {rel}")
            continue
        validate_manifest(path, report)

    print(_render_report(report))

    if not report.ok:
        return 1
    if args.strict and report.warnings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
