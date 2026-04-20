"""Entry-point so ``python -m csa_platform.streaming ...`` works."""

from __future__ import annotations

from csa_platform.streaming.cli import main

raise SystemExit(main())
