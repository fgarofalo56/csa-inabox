"""Shared utilities for CSA-in-a-Box Azure Function Apps.

Import helpers from this package rather than duplicating them in each
function app:

    from csa_platform.functions.common.function_helpers import (
        build_health_response,
        build_error_response,
        MAX_BLOB_SIZE,
    )
"""
