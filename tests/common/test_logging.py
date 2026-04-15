"""Tests for governance.common.logging.

These are lightweight behaviour tests — they do not assert on the JSON
serialisation details because structlog owns that, but they do pin the
public API so the Function apps and the quality runner can rely on it.
"""

from __future__ import annotations

import io
import json
import re
from collections.abc import Iterator
from typing import Any

import pytest
import structlog

from governance.common.logging import (
    bind_trace_context,
    configure_structlog,
    extract_trace_id_from_headers,
    get_logger,
    new_correlation_id,
    new_trace_id,
    reset_logging_state,
)


@pytest.fixture(autouse=True)
def _reset_between_tests() -> Iterator[None]:
    """Each test starts with a fresh structlog config and no bound context."""
    reset_logging_state()
    yield
    reset_logging_state()


def _capture_logs() -> io.StringIO:
    """Redirect structlog's PrintLogger output to a StringIO so we can assert on it."""
    buffer = io.StringIO()
    configure_structlog(service="test-service", json_output=True)
    # structlog's PrintLoggerFactory uses sys.stdout by default; patch it
    # here so the JSON payload lands in our buffer.
    structlog.configure(
        processors=structlog.get_config()["processors"],
        wrapper_class=structlog.get_config()["wrapper_class"],
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=buffer),
        cache_logger_on_first_use=False,
    )
    return buffer


def _parse_last_log(buffer: io.StringIO) -> dict[str, Any]:
    lines = [line for line in buffer.getvalue().splitlines() if line.strip()]
    assert lines, "expected at least one log line to be emitted"
    parsed: dict[str, Any] = json.loads(lines[-1])
    return parsed


def test_new_trace_id_returns_32_hex_chars() -> None:
    trace_id = new_trace_id()
    assert re.fullmatch(r"[0-9a-f]{32}", trace_id)


def test_new_correlation_id_returns_valid_uuid_string() -> None:
    corr_id = new_correlation_id()
    # UUID4 string is 36 chars with hyphens at fixed positions.
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        corr_id,
    )


def test_extract_trace_id_from_headers_parses_valid_traceparent() -> None:
    headers = {
        "Traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    }
    assert (
        extract_trace_id_from_headers(headers)
        == "0af7651916cd43dd8448eb211c80319c"
    )


def test_extract_trace_id_from_headers_case_insensitive() -> None:
    headers = {
        "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    }
    assert extract_trace_id_from_headers(headers) is not None


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "not-a-traceparent",
        "00-shortid-b7ad6b7169203331-01",
        "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-xx",  # non-hex flags
    ],
)
def test_extract_trace_id_from_headers_returns_none_for_garbage(value: str | None) -> None:
    headers = {"traceparent": value} if value is not None else {}
    assert extract_trace_id_from_headers(headers) is None


def test_configure_structlog_emits_service_on_every_line() -> None:
    buffer = _capture_logs()
    logger = get_logger("svc")
    logger.info("hello.world", foo="bar")
    payload = _parse_last_log(buffer)
    assert payload["service"] == "test-service"
    assert payload["event"] == "hello.world"
    assert payload["foo"] == "bar"
    assert payload["level"] == "info"
    assert "timestamp" in payload


def test_bind_trace_context_adds_trace_and_correlation_to_logs() -> None:
    buffer = _capture_logs()
    logger = get_logger("svc")
    with bind_trace_context(trace_id="abc" * 10 + "ab"):  # 32 hex chars not required here
        logger.info("inside.context")
    payload = _parse_last_log(buffer)
    assert payload["trace_id"] == "abc" * 10 + "ab"
    assert "correlation_id" in payload  # auto-generated
    assert payload["event"] == "inside.context"


def test_bind_trace_context_unbinds_on_exit() -> None:
    buffer = _capture_logs()
    logger = get_logger("svc")
    with bind_trace_context(trace_id="only-inside"):
        pass
    logger.info("outside.context")
    payload = _parse_last_log(buffer)
    assert "trace_id" not in payload


def test_bind_trace_context_accepts_extra_kwargs() -> None:
    buffer = _capture_logs()
    logger = get_logger("svc")
    with bind_trace_context(request_path="/api/enrich", request_method="POST"):
        logger.info("request.received")
    payload = _parse_last_log(buffer)
    assert payload["request_path"] == "/api/enrich"
    assert payload["request_method"] == "POST"


def test_configure_structlog_is_idempotent() -> None:
    configure_structlog(service="one")
    # Second call rebinds the service but does not blow up.
    configure_structlog(service="two")
    # Either value is acceptable; we only assert that the call succeeded.
    logger = get_logger()
    assert logger is not None
