"""Error taxonomy for the Loom notebook AI-functions bridge.

Every failure path raises one of these so a notebook cell gets a clear,
actionable message — never a silent empty DataFrame. The messages name the
exact env var to set, the role to grant, or the deployment to create, so an
analyst can self-remediate without leaving the notebook.
"""

from __future__ import annotations


class AoaiBridgeError(RuntimeError):
    """Base class for every AOAI-bridge failure."""


class AoaiBridgeConfigError(AoaiBridgeError):
    """A required setting (endpoint / deployment) is missing or empty."""


class AoaiBridgeAuthError(AoaiBridgeError):
    """Token acquisition failed — the Spark MSI/UAMI lacks the AOAI role."""


class AoaiBridgeDeploymentError(AoaiBridgeError):
    """The named AOAI deployment does not exist on the account."""


class AoaiBridgeRateLimitError(AoaiBridgeError):
    """AOAI returned 429 after the retry budget was exhausted."""
