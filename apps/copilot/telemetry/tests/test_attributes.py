"""Tests for :mod:`apps.copilot.telemetry.attributes`."""

from __future__ import annotations

import pytest

from apps.copilot.telemetry.attributes import (
    SpanAttribute,
    sanitize_attribute_value,
)


class TestSpanAttribute:
    def test_str_enum_values_are_wire_format(self) -> None:
        assert SpanAttribute.QUESTION_HASH.value == "copilot.question_hash"
        assert SpanAttribute.GROUNDEDNESS.value == "copilot.groundedness"
        assert SpanAttribute.PROMPT_CONTENT_HASH.value == "copilot.prompt_content_hash"

    def test_enum_is_subclass_of_str(self) -> None:
        assert issubclass(SpanAttribute, str)
        # Direct use as dict key producing the string value.
        attrs: dict[str, object] = {SpanAttribute.TOP_K: 6}
        # With str-Enum, using str() on the key yields 'SpanAttribute.TOP_K'
        # rather than the value — callers should either .value-stringify or
        # trust the helper that does str(key).
        # The important invariant is that set/lookup work consistently.
        assert attrs[SpanAttribute.TOP_K] == 6

    def test_all_attributes_prefixed_with_copilot(self) -> None:
        for attr in SpanAttribute:
            assert attr.value.startswith("copilot."), f"{attr.name} not prefixed"

    def test_every_attribute_is_unique(self) -> None:
        values = [attr.value for attr in SpanAttribute]
        assert len(values) == len(set(values))


class TestSanitizeAttributeValue:
    @pytest.mark.parametrize(
        "value",
        [
            "Bearer eyJraWQi...",
            "api-key=secret1234",
            "SOME_TOKEN=abc",
            "Authorization: Basic ZGVhZDpiZWVm",
            "password=hunter2",
        ],
    )
    def test_redacts_sensitive_strings(self, value: str) -> None:
        out = sanitize_attribute_value("copilot.anything", value)
        assert out == "<redacted>"

    @pytest.mark.parametrize(
        "value",
        ["safe question", "http://example.com/endpoint", ""],
    )
    def test_preserves_safe_strings(self, value: str) -> None:
        out = sanitize_attribute_value("copilot.anything", value)
        assert out == value

    def test_preserves_scalars(self) -> None:
        assert sanitize_attribute_value("copilot.top_k", 6) == 6
        assert sanitize_attribute_value("copilot.groundedness", 0.88) == 0.88
        assert sanitize_attribute_value("copilot.refused", True) is True

    def test_none_becomes_empty_string(self) -> None:
        assert sanitize_attribute_value("copilot.refusal_reason", None) == ""

    def test_list_values_are_recursively_sanitised(self) -> None:
        values = ["ok-value", "secret_token_leaks", 42]
        out = sanitize_attribute_value("copilot.missing_markers", values)
        assert out == ["ok-value", "<redacted>", 42]

    def test_unknown_types_coerced_to_str(self) -> None:
        class Custom:
            def __str__(self) -> str:
                return "custom-repr"

        out = sanitize_attribute_value("copilot.x", Custom())
        assert out == "custom-repr"
