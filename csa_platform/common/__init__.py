"""csa_platform.common — shared helpers for csa_platform service modules.

Thin, dependency-light utilities reused across the platform packages:

    * auth        — Azure AD JWT bearer validation with TTL-cached JWKS
                    and FastAPI ``Depends(...)`` helpers.
    * logging     — Structured JSON logging with trace / correlation IDs
                    (re-exports from governance.common.logging).

Keep this package minimal — only add code here when at least two
sub-packages need it.  Service-specific helpers belong in the owning
sub-package.
"""

__all__: list[str] = []
