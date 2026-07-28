"""Package version for ``csa-loom``.

Kept in its own module so ``pyproject.toml`` (``[tool.hatch.version]``) and the
client's User-Agent read the same literal, with no import of the whole package.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
