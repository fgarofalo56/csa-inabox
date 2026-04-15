"""Platform test configuration.

The ``platform/`` directory name shadows Python's built-in ``platform``
module.  We solve this by using ``importlib`` to register each platform
sub-package individually (e.g., ``platform.ai_integration``) without
replacing the stdlib ``platform`` module itself.

This lets both ``import platform; platform.python_version()`` (stdlib)
and ``from platform.ai_integration.rag.pipeline import ...`` (local)
work simultaneously.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

# Repo root is two levels up from tests/platform/conftest.py
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PLATFORM_DIR = _REPO_ROOT / "platform"

# Get the stdlib platform module (should already be cached).
_stdlib_platform = sys.modules.get("platform")
if _stdlib_platform is None:
    _stdlib_platform = importlib.import_module("platform")

# Make the stdlib platform module act as a package too by giving it a
# __path__ that includes our local directory.  This allows Python to
# resolve sub-package imports like ``platform.ai_integration`` from our
# local dir while keeping stdlib attributes (python_version, etc.).
if not hasattr(_stdlib_platform, "__path__"):
    _stdlib_platform.__path__ = [str(_PLATFORM_DIR)]  # type: ignore[attr-defined]
elif str(_PLATFORM_DIR) not in _stdlib_platform.__path__:  # type: ignore[attr-defined]
    _stdlib_platform.__path__.insert(0, str(_PLATFORM_DIR))  # type: ignore[attr-defined]

# Register sub-packages that have hyphenated directory names.
# Python import resolution doesn't handle hyphens, so we register the
# underscore-named versions manually.
_HYPHEN_DIRS = {
    "data-activator": "data_activator",
    "metadata-framework": "metadata_framework",
    "shared-services": "shared_services",
    "direct-lake": "direct_lake",
    "multi-synapse": "multi_synapse",
    "onelake-pattern": "onelake_pattern",
    "oss-alternatives": "oss_alternatives",
}

for _dirname, _pyname in _HYPHEN_DIRS.items():
    _dirpath = _PLATFORM_DIR / _dirname
    if _dirpath.exists():
        _full_name = f"platform.{_pyname}"
        if _full_name not in sys.modules:
            _sub = types.ModuleType(_full_name)
            _sub.__path__ = [str(_dirpath)]  # type: ignore[attr-defined]
            _sub.__package__ = _full_name
            sys.modules[_full_name] = _sub
            # Also set as attribute on the stdlib platform module so that
            # unittest.mock.patch() can traverse the dotted path (it uses
            # getattr on parent modules, not sys.modules lookup).
            setattr(_stdlib_platform, _pyname, _sub)
