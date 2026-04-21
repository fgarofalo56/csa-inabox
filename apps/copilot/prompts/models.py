"""Frozen DTOs for the prompt registry."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class PromptSpec(BaseModel):
    """A single prompt template with identity + version + content hash.

    ``body`` is the fully-rendered template body (post-frontmatter).
    ``content_hash`` is a SHA-256 digest of the *normalised* body
    (stripped + newline-normalised) — callers MUST reject any
    divergence from the snapshot.

    Instances are frozen so they can be safely embedded in span
    attributes + structured log events.
    """

    id: str = Field(min_length=1, description="Stable prompt identifier (e.g. 'ground_and_cite').")
    version: str = Field(
        min_length=1,
        description="Semantic version string (e.g. 'v1', '1.0', '2.1.0').",
    )
    body: str = Field(min_length=1, description="Rendered template body (post-frontmatter).")
    content_hash: str = Field(
        min_length=8,
        description="SHA-256 of the normalised body (hex).",
    )
    path: str = Field(description="Repo-relative path of the source template.")

    model_config = ConfigDict(frozen=True)

    def to_log_dict(self) -> dict[str, str]:
        """Return a small dict suitable for embedding in structlog events.

        Excludes the full body (too large for log lines) but keeps the
        id, version, and content hash so the event is traceable back
        to the exact template.
        """
        return {
            "prompt_id": self.id,
            "prompt_version": self.version,
            "prompt_content_hash": self.content_hash,
        }

    def ensure_path_exists(self) -> None:
        """Raise :class:`FileNotFoundError` when ``self.path`` has been removed.

        Used as a defensive check by callers who want to guard against
        templates being deleted out from under them at runtime.
        """
        if not Path(self.path).exists():
            raise FileNotFoundError(
                f"Prompt template path no longer exists: {self.path}",
            )


__all__ = ["PromptSpec"]
