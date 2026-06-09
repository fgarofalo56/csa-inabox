"""Honest reachability gate for the notebook AI-functions bridge.

Call :func:`check_reachable` as the FIRST cell of any notebook that uses
``ai_functions``. It verifies the endpoint is configured and that a real AOAI
round-trip succeeds with the current Spark/pandas identity. On failure it
raises a typed, actionable :class:`AoaiBridgeError` (or returns ``False`` when
``raise_on_fail=False``) — never a silent pass that would later surface as an
empty DataFrame.
"""

from __future__ import annotations

from ._client import call_chat
from ._config import get_deployment, get_endpoint
from ._errors import AoaiBridgeConfigError


def check_reachable(*, raise_on_fail: bool = True) -> bool:
    """Probe AOAI reachability from the current Spark/pandas context.

    Returns ``True`` on a successful probe. On failure either raises (default)
    or, when ``raise_on_fail=False``, prints a warning and returns ``False``.
    """
    endpoint = get_endpoint()
    if not endpoint:
        message = (
            "Azure OpenAI is not reachable: LOOM_AOAI_ENDPOINT is not set. "
            "Set it in the Spark pool environment (platform/fiab/bootstrap/"
            "ai-functions-pool-setup.sh) or, before importing ai_functions, run:\n"
            "    spark.conf.set('spark.loom.aoai.endpoint', 'https://<account>.openai.azure.com')\n"
            "On GCC-High / IL5 the host ends in .openai.azure.us."
        )
        if raise_on_fail:
            raise AoaiBridgeConfigError(message)
        print(f"[ai_functions] WARNING: {message}")
        return False

    deployment = get_deployment()
    try:
        call_chat("Respond with exactly the word PONG.", "PING", max_tokens=5)
    except Exception as exc:
        if raise_on_fail:
            raise
        print(f"[ai_functions] WARNING: Azure OpenAI probe failed — {exc}")
        return False

    print(f"[ai_functions] Azure OpenAI reachable: {endpoint} / {deployment}")
    return True
