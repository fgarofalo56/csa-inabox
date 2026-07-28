"""Test doubles for code that talks to Loom.

Shipped as part of the package (not test-only) so *consumers* can unit-test
their own Loom integrations without a deployment or a network:

    from csa_loom import LoomClient
    from csa_loom.testing import StubTransport

    transport = StubTransport(payload=[{"id": "w1", "name": "analytics"}])
    loom = LoomClient("https://loom.example.gov", token="t", transport=transport)
    assert loom.list_workspaces()[0]["name"] == "analytics"
    assert transport.last.url.endswith("/api/workspaces")

The stub implements the same :class:`csa_loom.Transport` protocol the real
``urllib`` transport does, so every layer above it — URL building, auth headers,
JSON encoding, error mapping — is the production code path.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from csa_loom._transport import Response

__all__ = ["RecordedCall", "StubTransport"]


@dataclass(frozen=True)
class RecordedCall:
    """One request a client attempted."""

    method: str
    url: str
    headers: Mapping[str, str]
    body: bytes | None


@dataclass
class StubTransport:
    """Records every request and replays a canned response.

    Attributes:
        status: HTTP status to return.
        payload: Object to JSON-encode as the response body.
        headers: Response headers (lower-cased keys, as the real transport emits).
        raw_body: When set, returned verbatim instead of encoding ``payload`` —
            use it for empty 204 bodies or deliberately non-JSON error pages.
        calls: Every request made, in order.
    """

    status: int = 200
    payload: Any = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    raw_body: bytes | None = None
    calls: list[RecordedCall] = field(default_factory=list)

    def send(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> Response:
        del timeout
        self.calls.append(RecordedCall(method=method, url=url, headers=dict(headers), body=body))
        payload = self.raw_body if self.raw_body is not None else json.dumps(self.payload).encode("utf-8")
        return Response(status=self.status, body=payload, headers=self.headers)

    @property
    def last(self) -> RecordedCall:
        """The most recent request.

        Raises:
            LookupError: if no request has been made yet.
        """
        if not self.calls:
            msg = "no request has been made through this transport"
            raise LookupError(msg)
        return self.calls[-1]
