"""Module entry point so ``python -m apps.copilot.evals`` works."""

from __future__ import annotations

from apps.copilot.evals.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
