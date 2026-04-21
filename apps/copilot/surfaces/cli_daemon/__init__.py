"""Long-lived CLI daemon surface for the Copilot.

Running the daemon keeps the expensive :class:`CopilotAgent` warm so
every ``ask`` / ``chat`` call skips the startup cost.  Clients talk to
the daemon over a Unix domain socket (POSIX) or a localhost TCP socket
(Windows) using a lightweight JSON-RPC 2.0 dialect.
"""

from __future__ import annotations

__all__ = ["default_pidfile_path", "default_socket_path"]


def __getattr__(name: str) -> object:
    """Lazy exports — avoid pulling the daemon modules on package import."""
    if name == "default_socket_path":
        from apps.copilot.surfaces.cli_daemon.daemon import default_socket_path

        return default_socket_path
    if name == "default_pidfile_path":
        from apps.copilot.surfaces.cli_daemon.daemon import default_pidfile_path

        return default_pidfile_path
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
