"""Module entry point — ``python -m apps.copilot.surfaces.web``."""

from __future__ import annotations

import sys

from apps.copilot.surfaces.web.app import main

if __name__ == "__main__":
    sys.exit(main())
