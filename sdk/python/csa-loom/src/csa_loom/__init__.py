"""``csa-loom`` — the official Python SDK for the CSA Loom API.

The client's route surface is **generated** from the same OpenAPI 3.1 document a
deployment serves at ``GET /api/openapi.json`` (``sdk/openapi.json`` in this
repository), so it cannot drift from the API: CI regenerates it and fails on any
diff, and ``tests/test_contract.py`` asserts the generated operation table and
the document agree in both directions.

Quick start::

    from csa_loom import LoomClient

    with LoomClient("https://loom.example.gov", token="loom_pat_...") as loom:
        who = loom.whoami()
        ws = loom.create_workspace(body={"name": "analytics"})
        item = loom.create_item(ws["id"], body={"itemType": "lakehouse", "displayName": "bronze"})

Design notes:

* **Zero runtime dependencies.** Only the standard library, so the package is
  safe to vendor into an air-gapped Government estate and its license posture is
  trivially clean.
* **No cloud is hard-coded.** ``base_url`` (or ``$LOOM_BASE_URL``) selects the
  deployment; Commercial and Government use identical code.
* **Failures raise.** A refused request never comes back as ``None`` or ``[]``;
  an honest infra gate surfaces as :class:`LoomGateError` with the deployment's
  own remediation ``hint``.
"""

from __future__ import annotations

from csa_loom._generated.contract import OPERATIONS, SPEC_SHA256, SPEC_VERSION, GeneratedOperation
from csa_loom._transport import Response, Transport, UrllibTransport
from csa_loom._version import __version__
from csa_loom.client import LoomClient
from csa_loom.errors import (
    LoomApiError,
    LoomAuthError,
    LoomError,
    LoomForbiddenError,
    LoomGateError,
    LoomNotFoundError,
    LoomRateLimitError,
    LoomTransportError,
)

#: The Loom API version the generated surface was built against.
LOOM_API_VERSION = SPEC_VERSION

__all__ = [
    "LOOM_API_VERSION",
    "OPERATIONS",
    "SPEC_SHA256",
    "SPEC_VERSION",
    "GeneratedOperation",
    "LoomApiError",
    "LoomAuthError",
    "LoomClient",
    "LoomError",
    "LoomForbiddenError",
    "LoomGateError",
    "LoomNotFoundError",
    "LoomRateLimitError",
    "LoomTransportError",
    "Response",
    "Transport",
    "UrllibTransport",
    "__version__",
]
