"""Module entry point — ``python -m apps.copilot.surfaces.api``."""

from __future__ import annotations

import sys

from apps.copilot.surfaces.api.app import main

if __name__ == "__main__":
    sys.exit(main())
