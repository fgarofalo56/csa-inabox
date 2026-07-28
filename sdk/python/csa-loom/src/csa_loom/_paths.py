"""URL path templating for the generated client.

Kept hand-written (and tiny) so the generated methods never build a URL by
string concatenation: every path parameter is percent-encoded with an empty
``safe`` set, so an item id containing ``/``, ``?`` or ``#`` cannot escape its
path segment and reach a different route.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import quote

_PLACEHOLDER = re.compile(r"\{([^{}]+)\}")

__all__ = ["expand"]


def expand(template: str, params: Mapping[str, object]) -> str:
    """Substitute ``{name}`` placeholders in ``template`` with encoded values.

    >>> expand("/api/cosmos-items/{type}/{id}", {"type": "lakehouse", "id": "a/b"})
    '/api/cosmos-items/lakehouse/a%2Fb'

    Raises:
        KeyError: if the template names a parameter that was not supplied.
        ValueError: if a supplied value is empty (an empty segment would
            silently address a different route).
    """

    def sub(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in params:
            msg = f"missing path parameter {name!r} for template {template!r}"
            raise KeyError(msg)
        value = str(params[name])
        if not value:
            msg = f"path parameter {name!r} must not be empty (template {template!r})"
            raise ValueError(msg)
        return quote(value, safe="")

    return _PLACEHOLDER.sub(sub, template)
