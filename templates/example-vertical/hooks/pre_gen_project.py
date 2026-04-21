#!/usr/bin/env python3
"""Pre-generation hook: validate cookiecutter inputs.

Exits non-zero on invalid inputs to abort generation before any files are
written. Keeps the generated tree consistent with repo conventions.
"""

from __future__ import annotations

import re
import sys

# cookiecutter renders this file with Jinja before executing it.
SLUG = "{{ cookiecutter.vertical_slug }}"
NAME = "{{ cookiecutter.vertical_name }}"
OWNER = "{{ cookiecutter.domain_owner }}"

SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,39}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _fail(msg: str) -> None:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(1)


def main() -> None:
    if not SLUG_RE.match(SLUG):
        _fail(
            f"vertical_slug={SLUG!r} is invalid. Use lowercase letters, digits "
            f"and hyphens only, starting with a letter, 2-40 chars "
            f"(pattern: {SLUG_RE.pattern}).",
        )
    if not NAME.strip():
        _fail("vertical_name must not be empty.")
    if not EMAIL_RE.match(OWNER):
        _fail(f"domain_owner={OWNER!r} does not look like an email address.")


if __name__ == "__main__":
    main()
