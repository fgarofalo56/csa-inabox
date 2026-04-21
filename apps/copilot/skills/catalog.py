"""Skill catalog — name-keyed, append-only registry of loaded skills.

The catalog is to :class:`~apps.copilot.skills.base.SkillSpec` what
:class:`~apps.copilot.tools.registry.ToolRegistry` is to
:class:`~apps.copilot.tools.base.Tool`: a small, deterministic
container that enforces uniqueness of ids and preserves registration
order.

Two construction helpers are provided:

* :meth:`SkillCatalog.from_directory` — loads every ``*.yaml`` under a
  directory, validating each with :func:`apps.copilot.skills.loader.load_skill_spec`.
* :meth:`SkillCatalog.from_shipped` — convenience that points at the
  bundled ``apps/copilot/skills/skills/`` directory.

Catalog instances are safe to share across coroutines — they never
mutate after construction.
"""

from __future__ import annotations

import builtins
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

from apps.copilot.skills.base import SkillResult, SkillSpec
from apps.copilot.skills.dispatcher import (
    ApprovalCallback,
    SkillDispatcher,
    auto_approve_callback,
)
from apps.copilot.skills.errors import SkillNotFoundError
from apps.copilot.skills.loader import load_skill_catalog_dir
from apps.copilot.tools.registry import ToolRegistry

SHIPPED_SKILLS_DIR: Path = Path(__file__).resolve().parent / "skills"
"""Directory where the shipped seed skills live (kebab-case YAML files)."""


class SkillCatalog:
    """Append-only, name-keyed catalog of :class:`SkillSpec` objects.

    The catalog is *not* a mutable bag — the only way to add skills
    is through :meth:`register`, and duplicate ids raise.  Callers
    who want to swap a skill must build a new catalog from a new
    directory snapshot.
    """

    def __init__(self, skills: Iterable[SkillSpec] | None = None) -> None:
        self._skills: dict[str, SkillSpec] = {}
        if skills is not None:
            for spec in skills:
                self.register(spec)

    # -- construction --------------------------------------------------------

    @classmethod
    def from_directory(
        cls,
        directory: Path,
        *,
        registry: ToolRegistry | None = None,
    ) -> SkillCatalog:
        """Load every skill YAML under *directory* and return a catalog.

        Passing *registry* engages tool-registry cross-checks at load
        time — any skill that references an unknown tool fails fast.
        """
        specs = load_skill_catalog_dir(directory, registry=registry)
        return cls(specs)

    @classmethod
    def from_shipped(cls, *, registry: ToolRegistry | None = None) -> SkillCatalog:
        """Convenience: load the catalog bundled inside this package."""
        return cls.from_directory(SHIPPED_SKILLS_DIR, registry=registry)

    # -- registry ops --------------------------------------------------------

    def register(self, spec: SkillSpec) -> None:
        """Add *spec* to the catalog, enforcing id uniqueness."""
        if spec.id in self._skills:
            raise ValueError(
                f"Skill id {spec.id!r} is already registered in this catalog. "
                "Build a new SkillCatalog to replace a skill.",
            )
        self._skills[spec.id] = spec

    def get(self, skill_id: str) -> SkillSpec:
        """Return the :class:`SkillSpec` registered under *skill_id*.

        Raises :class:`SkillNotFoundError` (subclass of ``KeyError``)
        on a miss so callers can handle it with either ``except``
        clause.
        """
        if skill_id not in self._skills:
            raise SkillNotFoundError(
                f"No skill registered under id {skill_id!r}.",
                skill_id=skill_id,
            )
        return self._skills[skill_id]

    def list(self) -> builtins.list[SkillSpec]:
        """Return every registered spec, in registration order."""
        return [*self._skills.values()]

    def ids(self) -> builtins.list[str]:
        """Return every registered id, in registration order."""
        return [*self._skills.keys()]

    def __contains__(self, skill_id: object) -> bool:
        return isinstance(skill_id, str) and skill_id in self._skills

    def __len__(self) -> int:
        return len(self._skills)

    def __iter__(self) -> Iterator[SkillSpec]:
        return iter(self._skills.values())

    # -- dispatch ------------------------------------------------------------

    async def dispatch(
        self,
        skill_id: str,
        inputs: dict[str, Any],
        *,
        registry: ToolRegistry,
        broker: Any = None,
        approval_callback: ApprovalCallback | None = None,
        dispatcher: SkillDispatcher | None = None,
    ) -> SkillResult:
        """Resolve *skill_id* and run it through a :class:`SkillDispatcher`.

        Convenience wrapper so callers with a catalog don't have to
        construct a dispatcher themselves.  When *broker* is provided
        but *approval_callback* is not, an
        :func:`auto_approve_callback` is used — fine for read-class
        skills and test harnesses, but production execute flows
        should supply their own callback that routes through a real
        approval surface.
        """
        spec = self.get(skill_id)
        dispatcher = dispatcher or SkillDispatcher()

        if broker is not None and approval_callback is None:
            async def _wrapped(
                skill: SkillSpec,
                step: Any,
                resolved_input: dict[str, Any],
            ) -> Any:
                return await auto_approve_callback(
                    skill,
                    step,
                    resolved_input,
                    broker=broker,
                )

            approval_callback = _wrapped

        return await dispatcher.dispatch(
            spec,
            inputs,
            registry=registry,
            broker=broker,
            approval_callback=approval_callback,
        )


__all__ = [
    "SHIPPED_SKILLS_DIR",
    "SkillCatalog",
]
