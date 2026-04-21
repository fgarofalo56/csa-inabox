"""Copilot prompt registry — content-hashed, versioned prompt templates.

This sub-package ships the canonical set of prompts emitted to the
LLM.  Every template carries an ``id`` + ``version`` in its
frontmatter; the body is content-hashed (SHA-256) at load time and
the hash is:

* recorded in :mod:`apps.copilot.telemetry` spans + structlog events
  so production traces capture exactly which prompt drove a given
  response, and
* snapshot-verified against
  ``apps/copilot/prompts/_hashes.json`` — CI fails any PR that edits
  a template without bumping the version and updating the snapshot.

See :class:`PromptRegistry` for the runtime loader and
:class:`PromptSpec` for the DTO callers receive.
"""

from __future__ import annotations

from apps.copilot.prompts.errors import (
    PromptHashMismatchError,
    PromptNotFoundError,
    PromptRegistryError,
)
from apps.copilot.prompts.models import PromptSpec
from apps.copilot.prompts.registry import PromptRegistry, default_registry

__all__ = [
    "PromptHashMismatchError",
    "PromptNotFoundError",
    "PromptRegistry",
    "PromptRegistryError",
    "PromptSpec",
    "default_registry",
]
