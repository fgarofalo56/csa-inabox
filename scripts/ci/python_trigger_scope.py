#!/usr/bin/env python3
"""ONE definition of "does this change need the Python suite?" (#3862).

Why this exists
---------------
``.github/workflows/test.yml`` publishes THREE required contexts - Python Tests
(3.10), (3.11), (3.12). It decided whether to execute them from TWO independent
lists that had to agree and did not:

* ``on.push.paths`` - the push-side filter, eight entries;
* a ``grep -qE '^(...)'`` alternation inside the ``Detect Python-relevant
  changes`` step - the PR-side detector, eight entries, a DIFFERENT eight.

Measured on 87d8d42 (the tip this was written against), the two disagreed in
both directions:

* ``apps/fiab-setup-orchestrator/**`` was in ``push.paths`` - with a comment
  saying the ``app-fresh-resolve`` job is that app's ONLY automated signal -
  and ABSENT from the PR detector. 7 tracked ``.py``.
* ``tools/`` was in the PR detector and ABSENT from ``push.paths``.

and BOTH lists omitted directories the job demonstrably READS:

* ``portal/shared/portal_tests`` is in ``pyproject.toml``'s ``testpaths``. The
  workflow's own comment counts 271 tests there. 58 tracked ``.py`` under
  ``portal/shared`` - and ``portal`` appeared in no filter at all.
* ``dev-loop``, ``governance``, ``tools`` are in ``python_lint_scope.SCOPE_DIRS``,
  i.e. the exact set the ruff step lints.
* ``requirements/ci-constraints.txt`` is this job's ``PIP_CONSTRAINT``. It
  decides what every one of the ~22 pip resolutions is allowed to resolve to,
  and a change to it reached no lane.
* ``apps/copilot`` - 137 tracked ``.py``, the instance #3862 was filed for.

A PR touching only an omitted path took the ``run=false`` branch, and three
REQUIRED contexts reported SUCCESS having executed nothing. That is not weaker
evidence than a real run; it is no evidence wearing the costume of one.

The fix, and why it is not another list
---------------------------------------
Two things changed, and the second is the one that matters.

1. The predicate is keyed to the SHAPE of a path, not to a SPELLING. The head
   of the filter is ``**.py`` / ``**.ipynb``: *any* Python file, anywhere,
   including directories nobody has created yet. A directory can no longer be
   forgotten, because no directory is named. (Directory prefixes remain BELOW
   that head, because the jobs also read NON-Python inputs under them - dbt's
   ``.sql``/``.yml`` models under ``domains/``, pytest fixtures under
   ``tests/``, ``requirements*.txt`` anywhere.)

2. There is now exactly ONE list. This module parses ``on.push.paths`` out of
   the workflow file and evaluates it; the PR detector calls this module instead
   of carrying a second copy. The two cannot drift because there is no longer a
   "the two". ``tests/repo/test_python_trigger_scope.py`` asserts that - it
   fails if a hard-coded prefix list reappears inside the detect step.

Self-defence
------------
* An empty pattern list is EXIT_CANNOT_RUN, never ``run=false``. A filter that
  parsed nothing must not be reported as "nothing matched".
* A pattern using filter syntax this module does not implement (``?``, ``+``,
  ``[]``, leading ``!``) is EXIT_CANNOT_RUN, never silently mis-evaluated. The
  caller fails open to running the suite.
* The workflow's SELF-reference is asserted here but enforced in the workflow
  OUTSIDE the parsed list - see the comment on the detect step. If it were
  merely an entry in this list, a PR that deleted the entry would be judged by
  the list it had just deleted from, skip the suite, and carry the guard that
  would have caught it out of the run.

Usage::

    python3 scripts/ci/python_trigger_scope.py --print-patterns
    python3 scripts/ci/python_trigger_scope.py --changed-file /tmp/changed.txt
    python3 scripts/ci/python_trigger_scope.py --match some/file.py

Exit codes follow the dev-loop gate convention:
    0 - answered (verdict is on stdout as ``run=true`` / ``run=false``)
    2 - COULD NOT RUN. Never a verdict. Callers fail OPEN.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

EXIT_OK = 0
EXIT_CANNOT_RUN = 2

#: The single source of truth, by location. This module does not re-declare the
#: population; it READS the one the workflow already publishes to GitHub.
WORKFLOW_REL_PATH = ".github/workflows/test.yml"

#: Filter-pattern characters this module deliberately refuses. GitHub's
#: filter-pattern syntax gives ``?`` and ``+`` quantifier meanings and supports
#: ``[]`` classes and a leading ``!`` negation. None are used today. Guessing at
#: them is how a filter starts answering ``run=false`` for a path it should have
#: matched, so an unimplemented construct is reported as CANNOT RUN instead.
UNSUPPORTED_PATTERN_CHARS = "?+[]!"


class TriggerScopeError(RuntimeError):
    """The population could not be established. Never a ``run=false``."""


def workflow_path(repo_root: str | None = None) -> str:
    root = repo_root if repo_root is not None else os.getcwd()
    return os.path.join(root, *WORKFLOW_REL_PATH.split("/"))


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _strip_scalar(raw: str) -> str:
    """Unquote one YAML sequence item, tolerating a trailing comment."""
    text = raw.strip()
    if text[:1] in ("'", '"'):
        quote = text[0]
        end = text.find(quote, 1)
        if end == -1:
            raise TriggerScopeError(f"unterminated quote in path entry: {raw!r}")
        return text[1:end]
    # Bare scalar: a ` #` begins a comment, a bare `#` inside a word does not.
    cut = text.find(" #")
    if cut != -1:
        text = text[:cut]
    return text.strip()


def load_patterns(workflow_text: str) -> list[str]:
    """Extract ``on.push.paths`` from the workflow source.

    Hand-rolled rather than PyYAML on purpose: this runs in the workflow's
    FIRST step, before ``actions/setup-python`` and before any ``pip install``,
    so the only thing guaranteed present is the runner image's stdlib python3.
    A dependency here would make the filter unavailable exactly when it is
    needed and push every PR onto the fail-open path, silently.
    """
    lines = workflow_text.splitlines()

    def find_child(start: int, parent_indent: int, key: str) -> tuple[int, int]:
        """Index and indent of ``key:`` directly under the block at ``start``."""
        child_indent: int | None = None
        for i in range(start, len(lines)):
            line = lines[i]
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            indent = _indent_of(line)
            if indent <= parent_indent:
                break
            if child_indent is None:
                child_indent = indent
            if indent != child_indent:
                continue
            if line.strip().split(":", 1)[0].strip() == key:
                return i, indent
        raise TriggerScopeError(
            f"'{key}:' not found under the block starting at line {start + 1} "
            f"of {WORKFLOW_REL_PATH}"
        )

    on_index: int | None = None
    for i, line in enumerate(lines):
        if _indent_of(line) == 0 and line.split(":", 1)[0].strip() in ("on", "'on'", '"on"'):
            on_index = i
            break
    if on_index is None:
        raise TriggerScopeError(f"no top-level 'on:' key in {WORKFLOW_REL_PATH}")

    push_index, push_indent = find_child(on_index + 1, 0, "push")
    paths_index, paths_indent = find_child(push_index + 1, push_indent, "paths")

    patterns: list[str] = []
    for line in lines[paths_index + 1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if _indent_of(line) <= paths_indent:
            break
        stripped = line.lstrip()
        if not stripped.startswith("- "):
            raise TriggerScopeError(
                f"unexpected non-sequence line inside on.push.paths: {line!r}"
            )
        patterns.append(_strip_scalar(stripped[2:]))

    if not patterns:
        raise TriggerScopeError(
            "on.push.paths parsed to ZERO patterns. An empty filter is reported "
            "as CANNOT RUN, never as 'nothing matched'."
        )
    return patterns


def pattern_to_regex(pattern: str) -> re.Pattern[str]:
    """Compile one GitHub filter pattern.

    Implemented: literal text, ``*`` (any run of non-``/``), ``**`` (any run of
    anything). Everything else in :data:`UNSUPPORTED_PATTERN_CHARS` raises.
    """
    if not pattern:
        raise TriggerScopeError("empty path pattern")
    for ch in UNSUPPORTED_PATTERN_CHARS:
        if ch in pattern:
            raise TriggerScopeError(
                f"path pattern {pattern!r} uses filter syntax {ch!r} that "
                f"{os.path.basename(__file__)} does not implement. Refusing to "
                "guess - a mis-evaluated pattern is how a required check goes "
                "green over code nothing read."
            )
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def matches(path: str, patterns: list[str]) -> bool:
    """True when ``path`` is matched by any pattern. Empty list is a hard error."""
    if not patterns:
        raise TriggerScopeError("cannot match against an empty pattern list")
    normalised = path.strip().replace("\\", "/").lstrip("./")
    if not normalised:
        return False
    return any(pattern_to_regex(p).fullmatch(normalised) for p in patterns)


def matching_paths(paths: list[str], patterns: list[str]) -> list[str]:
    return [p for p in paths if p.strip() and matches(p, patterns)]


def _read_workflow(repo_root: str | None) -> str:
    path = workflow_path(repo_root)
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError as exc:
        raise TriggerScopeError(f"cannot read {path}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", default=None)
    parser.add_argument(
        "--print-patterns",
        action="store_true",
        help="print the parsed on.push.paths list, one per line",
    )
    parser.add_argument(
        "--changed-file",
        default=None,
        help="file holding the changed paths, one per line",
    )
    parser.add_argument("--match", nargs="*", default=None, help="paths to classify")
    parser.add_argument(
        "--explain",
        action="store_true",
        help="also print which paths matched (max 20)",
    )
    args = parser.parse_args(argv)

    try:
        patterns = load_patterns(_read_workflow(args.repo_root))
    except TriggerScopeError as exc:
        print(f"python-trigger-scope: CANNOT RUN: {exc}", file=sys.stderr)
        return EXIT_CANNOT_RUN

    if args.print_patterns:
        for pattern in patterns:
            print(pattern)
        return EXIT_OK

    changed: list[str] = []
    if args.changed_file:
        try:
            with open(args.changed_file, encoding="utf-8") as handle:
                changed.extend(handle.read().splitlines())
        except OSError as exc:
            print(
                f"python-trigger-scope: CANNOT RUN: cannot read "
                f"{args.changed_file}: {exc}",
                file=sys.stderr,
            )
            return EXIT_CANNOT_RUN
    if args.match:
        changed.extend(args.match)

    changed = [c for c in changed if c.strip()]
    if not changed:
        print(
            "python-trigger-scope: CANNOT RUN: the changed-path list is EMPTY. "
            "An empty input is 'I was given nothing', not 'nothing matched'.",
            file=sys.stderr,
        )
        return EXIT_CANNOT_RUN

    try:
        hits = matching_paths(changed, patterns)
    except TriggerScopeError as exc:
        print(f"python-trigger-scope: CANNOT RUN: {exc}", file=sys.stderr)
        return EXIT_CANNOT_RUN

    if args.explain and hits:
        for hit in hits[:20]:
            print(f"python-trigger-scope: matched {hit}", file=sys.stderr)
    print("run=true" if hits else "run=false")
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    sys.exit(main())
