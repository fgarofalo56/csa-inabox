"""Prompt registry implementation.

The registry:

1. **Loads** every ``*.md`` template from the ``templates/`` directory.
2. **Parses** optional YAML-style frontmatter (``---\\nkey: val\\n---``).
3. **Normalises** the body and computes a SHA-256 content hash.
4. **Enforces** that the computed hash matches an entry in
   ``_hashes.json`` — drift raises :class:`PromptHashMismatchError`.

The registry is deliberately dependency-light: YAML is parsed
with a tiny hand-rolled frontmatter parser so we don't add PyYAML
to the hot path (it is already an extras dep but the registry MUST
load during ``--help``).  All frontmatter values are treated as
strings — version comparisons / sort semantics happen elsewhere.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Final

from apps.copilot.prompts.errors import (
    PromptHashMismatchError,
    PromptNotFoundError,
    PromptRegistryError,
)
from apps.copilot.prompts.models import PromptSpec

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)

# Minimal YAML-ish key parser: each line is ``key: value``.  Values are
# stripped.  No nested structures are supported — the frontmatter is
# tiny by design (id + version + optional description).
_FM_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$")

DEFAULT_TEMPLATES_DIR: Final[Path] = Path(__file__).parent / "templates"
DEFAULT_HASHES_FILE: Final[Path] = Path(__file__).parent / "_hashes.json"


def _normalise_body(raw: str) -> str:
    """Normalise a template body for stable hashing.

    * CRLF → LF so Windows checkouts hash the same as Linux.
    * Strip leading/trailing whitespace so trivial trailing-newline
      edits do not invalidate the hash.
    """
    return raw.replace("\r\n", "\n").strip() + "\n"


def _compute_hash(body: str) -> str:
    """Return the SHA-256 hex digest of the normalised *body*."""
    normalised = _normalise_body(body)
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split a template string into ``(frontmatter_dict, body)``.

    Raises :class:`PromptRegistryError` when the frontmatter is
    missing or malformed — every template MUST carry at minimum an
    ``id`` and ``version``.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        raise PromptRegistryError(
            "Template missing YAML frontmatter. Expected a leading "
            "'---\\n<id/version>\\n---' block.",
        )
    fm_block, body = match.group(1), match.group(2)

    fm: dict[str, str] = {}
    for line in fm_block.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _FM_LINE_RE.match(stripped)
        if not m:
            raise PromptRegistryError(
                f"Malformed frontmatter line: {stripped!r}",
            )
        key, value = m.group(1), m.group(2).strip()
        # Strip optional surrounding quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        fm[key] = value

    for required in ("id", "version"):
        if required not in fm:
            raise PromptRegistryError(
                f"Frontmatter missing required field {required!r}.",
            )
    return fm, body


class PromptRegistry:
    """In-memory registry of :class:`PromptSpec` values.

    Typical use::

        registry = default_registry()
        spec = registry.get("ground_and_cite")
        prompt = spec.body  # feed to the LLM

    The registry is cheap to construct (all templates are <5KB) so
    callers are free to build one per process; the default factory
    :func:`default_registry` returns a cached singleton.
    """

    def __init__(
        self,
        *,
        templates_dir: Path | None = None,
        hashes_file: Path | None = None,
    ) -> None:
        self.templates_dir = templates_dir or DEFAULT_TEMPLATES_DIR
        self.hashes_file = hashes_file or DEFAULT_HASHES_FILE
        self._specs: dict[str, PromptSpec] = {}
        self._loaded = False

    # -- public API --------------------------------------------------------

    def load(self) -> None:
        """Load every template from ``templates_dir`` into the registry.

        Idempotent — calling twice has no effect.  Raises on malformed
        or duplicate-id templates.
        """
        if self._loaded:
            return

        if not self.templates_dir.exists():
            raise PromptRegistryError(
                f"Templates directory does not exist: {self.templates_dir}",
            )

        templates = sorted(self.templates_dir.glob("*.md"))
        if not templates:
            raise PromptRegistryError(
                f"No *.md templates found under {self.templates_dir}",
            )

        for template_path in templates:
            text = template_path.read_text(encoding="utf-8")
            fm, body = _parse_frontmatter(text)
            normalised = _normalise_body(body)
            content_hash = _compute_hash(body)

            spec = PromptSpec(
                id=fm["id"],
                version=fm["version"],
                body=normalised,
                content_hash=content_hash,
                path=str(template_path.as_posix()),
            )
            if spec.id in self._specs:
                raise PromptRegistryError(
                    f"Duplicate prompt id {spec.id!r} in templates "
                    f"(seen in {self._specs[spec.id].path} and {spec.path}).",
                )
            self._specs[spec.id] = spec

        self._loaded = True

    def get(self, prompt_id: str) -> PromptSpec:
        """Return the :class:`PromptSpec` for *prompt_id*.

        Raises :class:`PromptNotFoundError` on unknown ids.
        """
        if not self._loaded:
            self.load()
        spec = self._specs.get(prompt_id)
        if spec is None:
            raise PromptNotFoundError(prompt_id)
        return spec

    def all(self) -> list[PromptSpec]:
        """Return every registered :class:`PromptSpec`, sorted by id."""
        if not self._loaded:
            self.load()
        return sorted(self._specs.values(), key=lambda s: s.id)

    def verify_all_hashes(self) -> None:
        """Raise :class:`PromptHashMismatchError` on any snapshot drift.

        Reads ``_hashes.json`` and compares each recorded hash against
        the live registry.  The snapshot must contain an entry for
        every shipped template; missing entries raise as well so a
        developer cannot ship a new template without updating the
        snapshot.
        """
        if not self._loaded:
            self.load()

        snapshot = self._load_hashes_file()
        seen: set[str] = set()

        for spec in self._specs.values():
            expected = snapshot.get(spec.id)
            if expected is None:
                raise PromptHashMismatchError(
                    prompt_id=spec.id,
                    expected="<missing from _hashes.json>",
                    actual=spec.content_hash,
                )

            expected_version = expected.get("version")
            expected_hash = expected.get("content_hash")
            if expected_hash != spec.content_hash or expected_version != spec.version:
                raise PromptHashMismatchError(
                    prompt_id=spec.id,
                    expected=f"v={expected_version} h={expected_hash}",
                    actual=f"v={spec.version} h={spec.content_hash}",
                )
            seen.add(spec.id)

        # Extra entries in the snapshot (stale ids) are tolerated —
        # they typically indicate a template removed between versions
        # and the caller will notice via `all()` or `get()` anyway.

    def write_snapshot(self) -> None:
        """Regenerate ``_hashes.json`` from the currently loaded specs.

        Intended for use by the CLI's ``prompt snapshot`` sub-command
        (future work) and the test suite's fixture-gen helper.
        """
        if not self._loaded:
            self.load()
        payload = {
            spec.id: {"version": spec.version, "content_hash": spec.content_hash}
            for spec in sorted(self._specs.values(), key=lambda s: s.id)
        }
        self.hashes_file.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    # -- internals ---------------------------------------------------------

    def _load_hashes_file(self) -> dict[str, dict[str, str]]:
        if not self.hashes_file.exists():
            raise PromptRegistryError(
                f"Hash snapshot file missing: {self.hashes_file}. "
                "Run the registry's write_snapshot() helper to "
                "initialise it.",
            )
        try:
            raw = json.loads(self.hashes_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise PromptRegistryError(
                f"Malformed hash snapshot {self.hashes_file}: {exc}",
            ) from exc

        if not isinstance(raw, dict):
            raise PromptRegistryError(
                f"Hash snapshot {self.hashes_file} must be a JSON object, "
                f"got {type(raw).__name__}.",
            )
        result: dict[str, dict[str, str]] = {}
        for key, value in raw.items():
            if not isinstance(value, dict):
                raise PromptRegistryError(
                    f"Hash snapshot entry {key!r} must be an object.",
                )
            result[str(key)] = {str(k): str(v) for k, v in value.items()}
        return result


# -- singleton helper -----------------------------------------------------


_DEFAULT_REGISTRY: PromptRegistry | None = None


def default_registry() -> PromptRegistry:
    """Return a process-wide cached :class:`PromptRegistry`.

    The registry is lazy-loaded on first access so ``--help`` paths
    never pay the template-parse cost.  Tests that need a fresh
    instance should construct :class:`PromptRegistry` directly.
    """
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = PromptRegistry()
    return _DEFAULT_REGISTRY


__all__ = [
    "DEFAULT_HASHES_FILE",
    "DEFAULT_TEMPLATES_DIR",
    "PromptRegistry",
    "default_registry",
]
