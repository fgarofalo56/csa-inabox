"""Pytest bootstrap for the standalone ``ai_functions`` package.

Inserts ``apps/copilot`` onto ``sys.path`` so the tests import ``ai_functions``
as a top-level package — the same import name the built wheel exposes on the
Spark pool — independent of the monorepo's ``apps.copilot.ai_functions`` path.
"""

from __future__ import annotations

import pathlib
import sys

# apps/copilot/ai_functions/tests/conftest.py -> parents[2] == apps/copilot
_PKG_PARENT = pathlib.Path(__file__).resolve().parents[2]
if str(_PKG_PARENT) not in sys.path:
    sys.path.insert(0, str(_PKG_PARENT))
