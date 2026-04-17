"""csa_platform.common — shared helpers for csa_platform service modules.

Thin, dependency-light utilities reused across the platform packages:

    * auth             — Azure AD JWT bearer validation with TTL-cached JWKS
                         and FastAPI ``Depends(...)`` helpers.
    * azure_clients    — Centralized Azure SDK client factory (BlobServiceClient,
                         SearchClient, PurviewCatalogClient, etc.) with consistent
                         credential management and government cloud support.
    * logging          — Structured JSON logging with trace / correlation IDs
                         (re-exports from governance.common.logging).
    * platform_settings — Convenience re-export of the platform-wide Pydantic
                          Settings singleton from ``csa_platform.config``.
                          Prefer importing from the canonical location
                          ``csa_platform.config`` in new code; this re-export
                          exists so that ``from csa_platform.common import
                          platform_settings`` also works for modules that already
                          import from ``csa_platform.common``.

Keep this package minimal — only add code here when at least two
sub-packages need it.  Service-specific helpers belong in the owning
sub-package.
"""

from csa_platform.common import azure_clients  # noqa: F401 — re-export
from csa_platform.config import platform_settings  # noqa: F401 — re-export

__all__: list[str] = ["azure_clients", "platform_settings"]
