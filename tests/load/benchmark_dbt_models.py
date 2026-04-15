"""dbt model performance benchmark.

Runs ``dbt run --select <models>`` N times, records per-model wall-clock
time from ``target/run_results.json``, and emits a JSON report. When a
baseline is supplied, fails the process if any model slows down by more
than the configured percentage — suitable for a CI regression gate.

Example:

    python tests/load/benchmark_dbt_models.py \
        --target dev \
        --models tag:silver \
        --runs 3 \
        --output reports/dbt-bench-silver.json

    python tests/load/benchmark_dbt_models.py \
        --target dev \
        --models tag:silver \
        --baseline reports/dbt-bench-silver.baseline.json \
        --max-regression-pct 20
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

_VALID_SELECT_RE = re.compile(r"^[a-zA-Z0-9_.,+*/:@ -]+$")


@dataclass
class ModelTiming:
    unique_id: str
    mean_seconds: float
    min_seconds: float
    max_seconds: float
    stdev_seconds: float
    runs: int


def _run_dbt(
    target: str,
    select: str,
    project_dir: Path,
) -> dict[str, float]:
    """Run ``dbt run`` once and return a {unique_id -> elapsed_seconds} map."""
    if not _VALID_SELECT_RE.match(select):
        raise ValueError(f"Invalid --models selection: {select!r}")
    if not re.match(r"^[a-zA-Z0-9_-]+$", target):
        raise ValueError(f"Invalid --target name: {target!r}")

    cmd = [
        "dbt",
        "run",
        "--target", target,
        "--select", select,
        "--profiles-dir", str(project_dir),
        "--project-dir", str(project_dir),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)

    run_results_path = project_dir / "target" / "run_results.json"
    if not run_results_path.exists():
        raise RuntimeError(
            f"dbt did not produce {run_results_path} — is the project dir correct?",
        )

    with open(run_results_path) as f:
        run_results = json.load(f)

    timings: dict[str, float] = {}
    for r in run_results.get("results", []):
        unique_id = r.get("unique_id")
        if not unique_id:
            continue
        elapsed = r.get("execution_time")
        if elapsed is None:
            continue
        timings[unique_id] = float(elapsed)
    return timings


def benchmark(
    target: str,
    select: str,
    project_dir: Path,
    runs: int,
) -> dict[str, ModelTiming]:
    """Run ``dbt run`` ``runs`` times and aggregate per-model statistics."""
    all_timings: dict[str, list[float]] = {}
    for _ in range(runs):
        single = _run_dbt(target, select, project_dir)
        for unique_id, elapsed in single.items():
            all_timings.setdefault(unique_id, []).append(elapsed)

    return {
        unique_id: ModelTiming(
            unique_id=unique_id,
            mean_seconds=statistics.mean(elapsed_list),
            min_seconds=min(elapsed_list),
            max_seconds=max(elapsed_list),
            stdev_seconds=statistics.stdev(elapsed_list) if len(elapsed_list) > 1 else 0.0,
            runs=len(elapsed_list),
        )
        for unique_id, elapsed_list in all_timings.items()
    }


def _load_baseline(path: Path) -> dict[str, float]:
    with open(path) as f:
        raw = json.load(f)
    return {m["unique_id"]: float(m["mean_seconds"]) for m in raw.get("models", [])}


def _check_regression(
    current: dict[str, ModelTiming],
    baseline: dict[str, float],
    max_pct: float,
) -> list[tuple[str, float, float, float]]:
    regressions: list[tuple[str, float, float, float]] = []
    for unique_id, timing in current.items():
        if unique_id not in baseline:
            continue
        base = baseline[unique_id]
        if base <= 0:
            continue
        delta_pct = ((timing.mean_seconds - base) / base) * 100
        if delta_pct > max_pct:
            regressions.append((unique_id, base, timing.mean_seconds, delta_pct))
    return regressions


def main() -> int:
    parser = argparse.ArgumentParser(description="dbt model performance benchmark")
    parser.add_argument("--target", required=True, help="dbt target name")
    parser.add_argument("--models", required=True, help="dbt --select argument")
    parser.add_argument(
        "--project-dir",
        default=str(Path("domains/shared/dbt")),
        help="Path to the dbt project",
    )
    parser.add_argument("--runs", type=int, default=3, help="Number of runs to average")
    parser.add_argument("--output", help="Path to write the JSON report")
    parser.add_argument("--baseline", help="Path to a previously-captured baseline JSON")
    parser.add_argument(
        "--max-regression-pct",
        type=float,
        default=20.0,
        help="Fail if any model slows down by more than this percentage vs baseline",
    )
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()

    print(
        f"Benchmarking dbt select={args.models!r} target={args.target!r} "
        f"runs={args.runs} project_dir={project_dir}",
    )
    timings = benchmark(args.target, args.models, project_dir, args.runs)

    report: dict[str, Any] = {
        "target": args.target,
        "select": args.models,
        "runs": args.runs,
        "models": [asdict(t) for t in timings.values()],
    }

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2))
        print(f"Report written to {out_path}")

    if args.baseline:
        baseline = _load_baseline(Path(args.baseline))
        regressions = _check_regression(timings, baseline, args.max_regression_pct)
        if regressions:
            print(f"\n[FAIL] {len(regressions)} model(s) exceeded {args.max_regression_pct}% regression:")
            for unique_id, base, current, pct in regressions:
                print(f"  - {unique_id}: {base:.2f}s -> {current:.2f}s (+{pct:.1f}%)")
            return 1
        print(f"\n[OK] No regressions above {args.max_regression_pct}%")

    return 0


if __name__ == "__main__":
    sys.exit(main())
