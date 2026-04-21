"""FastAPI dependency providers for the Copilot API surface.

These functions return cached instances of the expensive core objects
(``CopilotAgent``, ``ConfirmationBroker``, ``ToolRegistry``) so routes
don't rebuild them on every request.  The cache is per-application, not
per-process: the ``build_*`` factories accept a fresh settings instance
so tests can construct an isolated dependency graph.

Each dependency is also exposed through ``app.dependency_overrides`` in
the standalone launcher so tests can swap any component with a stub.
"""

from __future__ import annotations

from functools import lru_cache

from apps.copilot.agent import CopilotAgent
from apps.copilot.broker.broker import ConfirmationBroker
from apps.copilot.config import CopilotSettings
from apps.copilot.surfaces.config import SurfacesSettings
from apps.copilot.tools.registry import ToolRegistry


@lru_cache(maxsize=1)
def _default_copilot_settings() -> CopilotSettings:
    """Cached singleton :class:`CopilotSettings` for the API surface."""
    return CopilotSettings()


@lru_cache(maxsize=1)
def _default_surface_settings() -> SurfacesSettings:
    """Cached singleton :class:`SurfacesSettings` for the API surface."""
    return SurfacesSettings()


def get_copilot_settings() -> CopilotSettings:
    """FastAPI dependency — returns the cached :class:`CopilotSettings`."""
    return _default_copilot_settings()


def get_surface_settings() -> SurfacesSettings:
    """FastAPI dependency — returns the cached :class:`SurfacesSettings`."""
    return _default_surface_settings()


@lru_cache(maxsize=1)
def _default_agent() -> CopilotAgent:
    """Cached :class:`CopilotAgent` built from the default settings.

    Kept lazy so tests that override ``get_agent`` never trigger Azure
    client construction.
    """
    return CopilotAgent.from_settings(_default_copilot_settings())


def get_agent() -> CopilotAgent:
    """FastAPI dependency — returns the singleton :class:`CopilotAgent`."""
    return _default_agent()


@lru_cache(maxsize=1)
def _default_broker() -> ConfirmationBroker:
    """Cached :class:`ConfirmationBroker` tied to the default settings."""
    return ConfirmationBroker(_default_copilot_settings())


def get_broker() -> ConfirmationBroker:
    """FastAPI dependency — returns the singleton :class:`ConfirmationBroker`."""
    return _default_broker()


def _empty_registry() -> ToolRegistry:
    """Return an empty registry — routes that need tools override this."""
    return ToolRegistry()


@lru_cache(maxsize=1)
def _default_registry() -> ToolRegistry:
    """Cached :class:`ToolRegistry`.

    Routes that need the full catalogue (``/tools``) substitute a
    registry populated via :func:`build_default_registry` in
    :mod:`apps.copilot.surfaces.api.router`.
    """
    return _empty_registry()


def get_registry() -> ToolRegistry:
    """FastAPI dependency — returns the :class:`ToolRegistry` singleton."""
    return _default_registry()


def reset_dependency_caches() -> None:
    """Clear every ``@lru_cache`` in this module — used by tests."""
    _default_copilot_settings.cache_clear()
    _default_surface_settings.cache_clear()
    _default_agent.cache_clear()
    _default_broker.cache_clear()
    _default_registry.cache_clear()


__all__ = [
    "get_agent",
    "get_broker",
    "get_copilot_settings",
    "get_registry",
    "get_surface_settings",
    "reset_dependency_caches",
]
