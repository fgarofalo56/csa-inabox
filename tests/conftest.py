"""Shared test utilities and fixtures.

This module provides helpers used across multiple test sub-packages.
"""

from __future__ import annotations

import importlib.util
import types
from pathlib import Path


def load_script_module(module_name: str, script_path: Path) -> types.ModuleType:
    """Load a standalone Python script as a module via importlib.

    Many scripts in the ``scripts/`` directory are not installable packages,
    so they cannot be imported directly.  This helper uses
    ``importlib.util.spec_from_file_location`` to load them as proper modules
    so tests can reference their functions and constants.

    Args:
        module_name: The name to assign to the loaded module (e.g. ``"produce_events"``).
        script_path: Absolute path to the ``.py`` file to load.

    Returns:
        The loaded module object with all top-level symbols accessible.

    Raises:
        FileNotFoundError: If *script_path* does not exist.
        ImportError: If the module spec could not be created.

    Example::

        mod = load_script_module(
            "produce_events",
            Path(__file__).resolve().parents[1] / "scripts" / "streaming" / "produce_events.py",
        )
        generate_event = mod.generate_event
    """
    if not script_path.exists():
        raise FileNotFoundError(f"Script not found: {script_path}")

    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not create module spec for {script_path}")

    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
