"""Command-line interface for the eval harness.

Usage::

    python -m apps.copilot.evals run --goldens <path> --output <out>
    python -m apps.copilot.evals baseline --from <report> --tag <tag>
    python -m apps.copilot.evals gate --current <report> --baseline <path>
    python -m apps.copilot.evals diff --a <report_a> --b <report_b>

Exit codes:

* 0 — success (run completed OR gate passed OR diff produced)
* 1 — gate failed (regressions detected)
* 2 — runtime error (bad args, missing files, etc.)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from apps.copilot.evals.goldens_schema import GoldenSchemaError
from apps.copilot.evals.harness import EvalHarness
from apps.copilot.evals.models import EvalReport
from apps.copilot.evals.regression import RegressionGate


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m apps.copilot.evals",
        description="CSA Copilot eval harness + regression gate.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # run
    p_run = sub.add_parser("run", help="Run the harness against a golden set.")
    p_run.add_argument(
        "--goldens",
        type=Path,
        required=True,
        help="Path to a YAML goldens file (or directory of YAML files).",
    )
    p_run.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Write the EvalReport JSON to this path.",
    )
    p_run.add_argument(
        "--concurrency",
        type=int,
        default=4,
        help="Max parallel cases (default: 4).",
    )
    p_run.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Run with the deterministic DryRunAgent — no Azure / LLM calls. "
            "Used by CI."
        ),
    )
    p_run.add_argument(
        "--tag",
        default=None,
        help="Optional tag recorded in the report (e.g. 'v0.1.0').",
    )

    # baseline
    p_base = sub.add_parser(
        "baseline",
        help="Write a baseline file from an existing report.",
    )
    p_base.add_argument("--from", dest="source", type=Path, required=True)
    p_base.add_argument("--tag", required=True)
    p_base.add_argument(
        "--output",
        type=Path,
        default=None,
        help=(
            "Output path (default: apps/copilot/evals/baselines/baseline_<tag>.json)."
        ),
    )

    # gate
    p_gate = sub.add_parser(
        "gate",
        help="Compare current report vs baseline and exit non-zero on regression.",
    )
    p_gate.add_argument("--current", type=Path, required=True)
    p_gate.add_argument("--baseline", type=Path, required=True)
    p_gate.add_argument(
        "--max-score-regression",
        type=float,
        default=0.02,
        help="Max tolerated drop in mean score per rubric (default 0.02).",
    )
    p_gate.add_argument(
        "--max-latency-p95-regression-pct",
        type=float,
        default=10.0,
        help="Max tolerated P95 latency increase in percent (default 10.0).",
    )

    # diff
    p_diff = sub.add_parser("diff", help="Print per-case deltas between two reports.")
    p_diff.add_argument("--a", type=Path, required=True)
    p_diff.add_argument("--b", type=Path, required=True)

    return parser


def _load_report(path: Path) -> EvalReport:
    data = json.loads(path.read_text(encoding="utf-8"))
    return EvalReport.from_json_dict(data)


async def _cmd_run(args: argparse.Namespace) -> int:
    goldens_path: Path = args.goldens
    try:
        goldens = EvalHarness.load_goldens(goldens_path)
    except GoldenSchemaError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2

    if args.dry_run:
        harness = EvalHarness.dry_run_from_goldens(
            goldens,
            concurrency=args.concurrency,
        )
    else:
        # Non-dry runs require a live agent — we don't provide one from
        # the CLI directly (that would couple the CLI to Azure). Callers
        # running live evals must build a harness in Python and invoke
        # its ``run`` method programmatically. The CLI remains a
        # CI-first surface.
        sys.stderr.write(
            "Non-dry-run mode requires programmatic invocation. "
            "Use --dry-run for CI or build a harness in Python for live evals.\n",
        )
        return 2

    # Always use forward slashes in the recorded source path so
    # baselines captured on Windows match those captured on Linux.
    report = await harness.run(
        goldens,
        goldens_source=str(goldens_path).replace("\\", "/"),
        tag=args.tag,
    )
    payload = report.model_dump(mode="json")
    text = json.dumps(payload, indent=2, default=str)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
        print(f"Wrote report: {args.output}")
    else:
        print(text)

    _print_summary(report)
    # Non-zero exit on any failed/errored case so CI surfaces problems
    # even before the gate comparison.
    if report.error_cases > 0:
        return 2
    return 0


async def _cmd_baseline(args: argparse.Namespace) -> int:
    report = _load_report(args.source)
    output = args.output
    if output is None:
        output = (
            Path(__file__).parent / "baselines" / f"baseline_{args.tag}.json"
        )
    tagged = report.model_copy(update={"tag": args.tag})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(tagged.model_dump(mode="json"), indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote baseline: {output} (tag={args.tag})")
    return 0


async def _cmd_gate(args: argparse.Namespace) -> int:
    current = _load_report(args.current)
    baseline = _load_report(args.baseline)
    gate = RegressionGate(
        max_score_regression=args.max_score_regression,
        max_latency_p95_regression_pct=args.max_latency_p95_regression_pct,
    )
    decision = gate.compare(baseline=baseline, current=current)
    print(decision.message)
    if not decision.passed:
        return 1
    return 0


async def _cmd_diff(args: argparse.Namespace) -> int:
    a = _load_report(args.a)
    b = _load_report(args.b)

    by_id_a = {r.case_id: r for r in a.results}
    by_id_b = {r.case_id: r for r in b.results}
    all_ids = sorted(set(by_id_a) | set(by_id_b))

    print(f"Report A: {args.a} (run_id={a.run_id})")
    print(f"Report B: {args.b} (run_id={b.run_id})")
    print()

    for cid in all_ids:
        ra = by_id_a.get(cid)
        rb = by_id_b.get(cid)
        if ra is None:
            print(f"[NEW]  {cid}: present in B only (passed={rb.passed if rb else 'n/a'})")
            continue
        if rb is None:
            print(f"[GONE] {cid}: present in A only")
            continue
        delta_latency = rb.latency_ms - ra.latency_ms
        ga = ra.groundedness
        gb = rb.groundedness
        print(
            f"[DIFF] {cid}: groundedness {ga:.3f} -> {gb:.3f}, "
            f"latency {ra.latency_ms:.0f}ms -> {rb.latency_ms:.0f}ms "
            f"(delta {delta_latency:+.0f}ms), passed {ra.passed} -> {rb.passed}",
        )
    return 0


def _print_summary(report: EvalReport) -> None:
    print()
    print(f"Run {report.run_id}")
    print(f"  Deterministic: {report.deterministic}")
    print(f"  Cases: total={report.total_cases} "
          f"passed={report.passed_cases} "
          f"failed={report.failed_cases} "
          f"errors={report.error_cases}")
    for agg in report.aggregates:
        print(
            f"  {agg.rubric}: mean={agg.mean:.3f} p50={agg.p50:.3f} "
            f"p95={agg.p95:.3f} p99={agg.p99:.3f} "
            f"(passed={agg.passed}, failed={agg.failed})",
        )


async def _dispatch(args: argparse.Namespace) -> int:
    if args.command == "run":
        return await _cmd_run(args)
    if args.command == "baseline":
        return await _cmd_baseline(args)
    if args.command == "gate":
        return await _cmd_gate(args)
    if args.command == "diff":
        return await _cmd_diff(args)
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_dispatch(args))
    except FileNotFoundError as exc:
        sys.stderr.write(f"File not found: {exc}\n")
        return 2
    except GoldenSchemaError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    except Exception as exc:  # pragma: no cover - defensive
        sys.stderr.write(f"Harness error: {type(exc).__name__}: {exc}\n")
        return 2


# JSON helper so model_dump(mode="json") handles datetimes + non-serialisables.
def _default_serialiser(obj: Any) -> Any:
    from datetime import datetime

    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serialisable")


if __name__ == "__main__":
    raise SystemExit(main())
