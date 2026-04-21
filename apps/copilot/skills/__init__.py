"""Copilot skill catalog (Phase 3).

A *skill* is a declarative, YAML-authored workflow that composes one
or more :mod:`apps.copilot.tools` tools to accomplish a higher-level
task.  The skill catalog discovers these YAML files, validates them
against the bundled JSON-schema, and exposes them to the agent loop
through the :class:`~apps.copilot.skills.catalog.SkillCatalog` +
:class:`~apps.copilot.skills.dispatcher.SkillDispatcher` pair.

Importing this module is side-effect-free: no YAML is read, no
broker is contacted, no tool is invoked until the caller constructs
a catalog and calls ``dispatch``.
"""

from __future__ import annotations

from apps.copilot.skills.base import (
    SkillContext,
    SkillInputField,
    SkillOutputSpec,
    SkillResult,
    SkillSpec,
    SkillStep,
    SkillStepSpec,
)
from apps.copilot.skills.catalog import SHIPPED_SKILLS_DIR, SkillCatalog
from apps.copilot.skills.dispatcher import (
    ApprovalCallback,
    SkillDispatcher,
    auto_approve_callback,
    interpolate_value,
)
from apps.copilot.skills.errors import (
    SkillError,
    SkillExecutionError,
    SkillInputError,
    SkillInterpolationError,
    SkillNotFoundError,
    SkillValidationError,
)
from apps.copilot.skills.loader import (
    SCHEMA_PATH,
    load_skill_catalog_dir,
    load_skill_spec,
)

__all__ = [
    "SCHEMA_PATH",
    "SHIPPED_SKILLS_DIR",
    "ApprovalCallback",
    "SkillCatalog",
    "SkillContext",
    "SkillDispatcher",
    "SkillError",
    "SkillExecutionError",
    "SkillInputError",
    "SkillInputField",
    "SkillInterpolationError",
    "SkillNotFoundError",
    "SkillOutputSpec",
    "SkillResult",
    "SkillSpec",
    "SkillStep",
    "SkillStepSpec",
    "SkillValidationError",
    "auto_approve_callback",
    "interpolate_value",
    "load_skill_catalog_dir",
    "load_skill_spec",
]
