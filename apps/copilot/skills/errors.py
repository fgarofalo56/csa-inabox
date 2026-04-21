"""Typed errors for the Copilot skill catalog (Phase 3).

Every public failure mode raises a subclass of :class:`SkillError` so
callers can narrow ``except`` clauses rather than catching the generic
``Exception``.  The hierarchy mirrors the lifecycle of a skill:

* :class:`SkillValidationError` — the YAML contract itself is broken
  (schema violation, missing required fields, unknown step id).
* :class:`SkillNotFoundError` — the catalog has no skill with the
  requested id; used by the dispatcher and the CLI.
* :class:`SkillInputError` — the caller-supplied input payload does
  not satisfy the skill's declared input contract.
* :class:`SkillExecutionError` — the skill ran but one or more of its
  steps failed in a way that cannot be represented on a step trace.
* :class:`SkillInterpolationError` — the ``{step_id}.output.field``
  interpolation engine encountered an unresolvable reference or a
  malformed expression.

All errors carry the failing ``skill_id`` (or ``None`` for loader-time
errors before an id has been parsed) so structured logs can pivot on
it without reparsing the message.
"""

from __future__ import annotations


class SkillError(Exception):
    """Base class for every skill-related failure.

    The ``skill_id`` attribute is set by callers that have already
    resolved the id.  Loader-time failures that happen *before* a
    ``skill_id`` can be extracted leave it as ``None`` — in that case
    the ``source`` attribute carries the originating YAML path.
    """

    def __init__(
        self,
        message: str,
        *,
        skill_id: str | None = None,
        source: str | None = None,
    ) -> None:
        super().__init__(message)
        self.skill_id = skill_id
        self.source = source


class SkillValidationError(SkillError):
    """Raised when a skill YAML fails schema or semantic validation.

    Schema validation covers the JSON-schema in ``skills/_schema.json``.
    Semantic validation goes further — it checks that every ``steps[].id``
    is unique, that step inputs referencing ``{prev}.output.*`` only
    reference prior steps, and that declared tools exist at load time
    when a registry is provided.
    """


class SkillNotFoundError(SkillError, KeyError):
    """Raised when :meth:`SkillCatalog.get` cannot resolve an id.

    Inherits from :class:`KeyError` for backward compatibility with
    callers that use ``try: catalog[id] except KeyError``.
    """


class SkillInputError(SkillError):
    """Raised when skill inputs do not satisfy the declared contract.

    The dispatcher raises this before any step runs, so a caller that
    forgot a required input gets a fast, structured failure rather
    than a partial trace.
    """


class SkillExecutionError(SkillError):
    """Raised when a skill run fails irrecoverably.

    Most step failures are captured in the structured
    :class:`~apps.copilot.skills.base.SkillResult` as non-``success``
    steps; this error is reserved for conditions where no meaningful
    result could be produced (for example, a broker hard refusal on
    an execute step with ``fallback_if_tool_missing=fail``).
    """


class SkillInterpolationError(SkillError):
    """Raised by the sandboxed interpolation engine on a bad expression.

    Bad expressions include: unknown step id, missing output field,
    malformed template syntax, attempts to use Python expressions
    (anything beyond the allowed ``{step_id}.output.field`` shape).
    """


__all__ = [
    "SkillError",
    "SkillExecutionError",
    "SkillInputError",
    "SkillInterpolationError",
    "SkillNotFoundError",
    "SkillValidationError",
]
