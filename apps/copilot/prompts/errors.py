"""Typed exceptions raised by :mod:`apps.copilot.prompts`."""

from __future__ import annotations


class PromptRegistryError(RuntimeError):
    """Base class for any prompt-registry failure.

    Concrete subclasses carry machine-readable metadata so callers can
    surface meaningful error messages without string-parsing.
    """


class PromptNotFoundError(PromptRegistryError, KeyError):
    """Raised when :meth:`PromptRegistry.get` is called with an unknown id."""

    def __init__(self, prompt_id: str) -> None:
        self.prompt_id = prompt_id
        super().__init__(f"No prompt template registered with id={prompt_id!r}.")


class PromptHashMismatchError(PromptRegistryError):
    """Raised when a loaded template's content hash differs from the snapshot.

    This is the mechanism that catches "silent" prompt edits. CI
    invokes :meth:`PromptRegistry.verify_all_hashes` and fails on any
    mismatch — the author must either bump the template's version
    (and update the snapshot) or revert the edit.
    """

    def __init__(self, prompt_id: str, expected: str, actual: str) -> None:
        self.prompt_id = prompt_id
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"Content hash drift for prompt {prompt_id!r}: "
            f"expected={expected}, actual={actual}. "
            "Either bump the prompt's version + update _hashes.json, "
            "or revert the template edit.",
        )


__all__ = [
    "PromptHashMismatchError",
    "PromptNotFoundError",
    "PromptRegistryError",
]
