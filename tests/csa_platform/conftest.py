"""Platform test configuration.

The ``csa_platform/`` directory is not a regular Python package (it has
no ``__init__.py``).  We register it as a namespace package in
``sys.modules`` so that ``from csa_platform.ai_integration.rag.pipeline
import ...`` works in tests.

All sub-directories now use snake_case names and are directly importable.
We register them as sub-packages of the namespace so that
``unittest.mock.patch()`` can traverse dotted paths via ``getattr``.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

# Repo root is two levels up from tests/csa_platform/conftest.py
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PLATFORM_DIR = _REPO_ROOT / "csa_platform"

# Ensure csa_platform is importable as a namespace package.
if "csa_platform" not in sys.modules:
    _pkg = types.ModuleType("csa_platform")
    _pkg.__path__ = [str(_PLATFORM_DIR)]  # type: ignore[attr-defined]
    _pkg.__package__ = "csa_platform"
    sys.modules["csa_platform"] = _pkg
elif not hasattr(sys.modules["csa_platform"], "__path__"):
    sys.modules["csa_platform"].__path__ = [str(_PLATFORM_DIR)]  # type: ignore[attr-defined]

_csa_platform = sys.modules["csa_platform"]

# Register snake_case sub-packages so that unittest.mock.patch() can
# traverse the dotted path (it uses getattr on parent modules).
_SUB_PACKAGES = [
    "data_activator",
    "metadata_framework",
    "shared_services",
    "semantic_model",
    "multi_synapse",
    "unity_catalog_pattern",
    "oss_alternatives",
]

for _pyname in _SUB_PACKAGES:
    _dirpath = _PLATFORM_DIR / _pyname
    if _dirpath.exists():
        _full_name = f"csa_platform.{_pyname}"
        if _full_name not in sys.modules:
            _sub = types.ModuleType(_full_name)
            _sub.__path__ = [str(_dirpath)]  # type: ignore[attr-defined]
            _sub.__package__ = _full_name
            sys.modules[_full_name] = _sub
            setattr(_csa_platform, _pyname, _sub)
