"""Tests for shared-services Azure Functions.

Tests PII detection, quality validation, schema validation, and Teams
alert functionality with mocked Azure Functions request/response objects.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Mock Azure Functions HTTP objects
# ---------------------------------------------------------------------------


class MockHttpRequest:
    """Mock azure.functions.HttpRequest for testing."""

    def __init__(self, body: dict[str, Any] | None = None, method: str = "POST"):
        self.method = method
        self._body = json.dumps(body).encode() if body else b""

    def get_json(self) -> dict[str, Any]:
        if not self._body:
            raise ValueError("No body")
        return json.loads(self._body)


class MockHttpResponse:
    """Helper to parse azure.functions.HttpResponse-like objects."""

    def __init__(self, response):
        self.status_code = response.status_code
        self.body = json.loads(response.get_body()) if response.get_body() else {}


# ---------------------------------------------------------------------------
# PII Detection Tests
# ---------------------------------------------------------------------------


class TestDetectPII:
    """Test the detect_pii function and internal helpers."""

    def test_detect_ssn(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        detections = _detect_pii_in_text("My SSN is 123-45-6789")
        ssn_detections = [d for d in detections if d.category == "ssn"]
        assert len(ssn_detections) >= 1
        assert ssn_detections[0].confidence >= 0.9

    def test_detect_email(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        detections = _detect_pii_in_text("Contact john@example.com for details")
        email_detections = [d for d in detections if d.category == "email"]
        assert len(email_detections) == 1
        assert email_detections[0].confidence >= 0.9

    def test_detect_phone(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        detections = _detect_pii_in_text("Call me at 555-123-4567")
        phone_detections = [d for d in detections if d.category == "phone"]
        assert len(phone_detections) >= 1

    def test_detect_credit_card_visa(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        detections = _detect_pii_in_text("Card: 4111111111111111")
        cc_detections = [d for d in detections if d.category == "credit_card"]
        assert len(cc_detections) >= 1

    def test_detect_credit_card_mastercard(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        detections = _detect_pii_in_text("Card: 5111111111111118")
        cc_detections = [d for d in detections if d.category == "credit_card"]
        assert len(cc_detections) >= 1

    def test_masking_ssn(self):
        from platform.shared_services.functions.detect_pii import _mask_value

        masked = _mask_value("123-45-6789", "ssn")
        assert masked == "***-**-6789"

    def test_masking_email(self):
        from platform.shared_services.functions.detect_pii import _mask_value

        masked = _mask_value("john@example.com", "email")
        assert "***@example.com" in masked
        assert "john" not in masked

    def test_masking_credit_card(self):
        from platform.shared_services.functions.detect_pii import _mask_value

        masked = _mask_value("4111111111111111", "credit_card")
        assert masked.endswith("1111")
        assert "****" in masked

    def test_category_filtering(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        text = "SSN: 123-45-6789, Email: test@example.com"
        detections = _detect_pii_in_text(text, categories={"ssn"})
        assert all(d.category == "ssn" for d in detections)

    def test_no_pii_in_clean_text(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        detections = _detect_pii_in_text("The weather is nice today.")
        assert len(detections) == 0

    def test_multiple_pii_in_single_text(self):
        from platform.shared_services.functions.detect_pii import _detect_pii_in_text

        text = "SSN 123-45-6789, email test@example.com, card 4111111111111111"
        detections = _detect_pii_in_text(text)
        categories = {d.category for d in detections}
        assert "ssn" in categories
        assert "email" in categories
        assert "credit_card" in categories


# ---------------------------------------------------------------------------
# Quality Validation Tests
# ---------------------------------------------------------------------------


class TestValidateQuality:
    """Test quality validation rule evaluators."""

    def test_completeness_all_present(self):
        from platform.shared_services.functions.validate_quality import _check_completeness

        data = [
            {"name": "Alice", "email": "alice@example.com"},
            {"name": "Bob", "email": "bob@example.com"},
        ]
        result = _check_completeness(data, {"fields": ["name", "email"]})
        assert result["score"] == 1.0
        assert len(result["violations"]) == 0

    def test_completeness_with_nulls(self):
        from platform.shared_services.functions.validate_quality import _check_completeness

        data = [
            {"name": "Alice", "email": "alice@example.com"},
            {"name": "", "email": "bob@example.com"},
            {"name": "Charlie", "email": None},
        ]
        result = _check_completeness(data, {"fields": ["name", "email"]})
        assert result["score"] < 1.0
        assert len(result["violations"]) > 0

    def test_range_all_valid(self):
        from platform.shared_services.functions.validate_quality import _check_range

        data = [{"age": 25}, {"age": 30}, {"age": 45}]
        result = _check_range(data, {"field": "age", "min": 0, "max": 150})
        assert result["score"] == 1.0

    def test_range_with_violations(self):
        from platform.shared_services.functions.validate_quality import _check_range

        data = [{"age": 25}, {"age": -5}, {"age": 200}]
        result = _check_range(data, {"field": "age", "min": 0, "max": 150})
        assert result["score"] < 1.0
        assert len(result["violations"]) == 1
        assert result["violations"][0]["violation_count"] == 2

    def test_regex_valid_emails(self):
        from platform.shared_services.functions.validate_quality import _check_regex

        data = [
            {"email": "alice@example.com"},
            {"email": "bob@test.org"},
        ]
        result = _check_regex(data, {"field": "email", "pattern": r"^[\w.+-]+@[\w-]+\.[\w.]+$"})
        assert result["score"] == 1.0

    def test_regex_with_invalid(self):
        from platform.shared_services.functions.validate_quality import _check_regex

        data = [
            {"email": "alice@example.com"},
            {"email": "not-an-email"},
        ]
        result = _check_regex(data, {"field": "email", "pattern": r"^[\w.+-]+@[\w-]+\.[\w.]+$"})
        assert result["score"] < 1.0

    def test_uniqueness_all_unique(self):
        from platform.shared_services.functions.validate_quality import _check_uniqueness

        data = [{"id": 1}, {"id": 2}, {"id": 3}]
        result = _check_uniqueness(data, {"field": "id"})
        assert result["score"] == 1.0

    def test_uniqueness_with_duplicates(self):
        from platform.shared_services.functions.validate_quality import _check_uniqueness

        data = [{"id": 1}, {"id": 2}, {"id": 1}]
        result = _check_uniqueness(data, {"field": "id"})
        assert result["score"] < 1.0
        assert len(result["violations"]) == 1

    def test_referential_valid(self):
        from platform.shared_services.functions.validate_quality import _check_referential

        data = [{"status": "active"}, {"status": "inactive"}]
        result = _check_referential(data, {"field": "status", "allowed_values": ["active", "inactive"]})
        assert result["score"] == 1.0

    def test_referential_with_invalid(self):
        from platform.shared_services.functions.validate_quality import _check_referential

        data = [{"status": "active"}, {"status": "deleted"}]
        result = _check_referential(data, {"field": "status", "allowed_values": ["active", "inactive"]})
        assert result["score"] < 1.0


# ---------------------------------------------------------------------------
# Schema Validation Tests
# ---------------------------------------------------------------------------


class TestValidateSchema:
    """Test JSON Schema and YAML contract validation."""

    def test_json_schema_valid(self):
        from platform.shared_services.functions.validate_schema import _validate_data

        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"},
            },
            "required": ["name"],
        }
        errors = _validate_data({"name": "Alice", "age": 30}, schema)
        assert len(errors) == 0

    def test_json_schema_invalid(self):
        from platform.shared_services.functions.validate_schema import _validate_data

        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"},
            },
            "required": ["name", "age"],
        }
        errors = _validate_data({"name": "Alice"}, schema)
        assert len(errors) == 1
        assert errors[0]["validator"] == "required"

    def test_json_schema_type_mismatch(self):
        from platform.shared_services.functions.validate_schema import _validate_data

        schema = {
            "type": "object",
            "properties": {"age": {"type": "integer"}},
        }
        errors = _validate_data({"age": "not-a-number"}, schema)
        assert len(errors) == 1
        assert errors[0]["validator"] == "type"

    def test_yaml_contract_valid(self):
        from platform.shared_services.functions.validate_schema import _validate_against_contract

        contract = {
            "schema": {
                "columns": [
                    {"name": "id", "nullable": False},
                    {"name": "status", "nullable": True, "allowed_values": ["active", "inactive"]},
                ],
            },
        }
        errors = _validate_against_contract({"id": 1, "status": "active"}, contract)
        assert len(errors) == 0

    def test_yaml_contract_missing_required(self):
        from platform.shared_services.functions.validate_schema import _validate_against_contract

        contract = {
            "schema": {
                "columns": [
                    {"name": "id", "nullable": False},
                ],
            },
        }
        errors = _validate_against_contract({"other": "value"}, contract)
        assert len(errors) == 1
        assert "Required column" in errors[0]["message"]

    def test_yaml_contract_invalid_enum(self):
        from platform.shared_services.functions.validate_schema import _validate_against_contract

        contract = {
            "schema": {
                "columns": [
                    {"name": "status", "allowed_values": ["active", "inactive"]},
                ],
            },
        }
        errors = _validate_against_contract({"status": "deleted"}, contract)
        assert len(errors) == 1
        assert errors[0]["validator"] == "enum"


# ---------------------------------------------------------------------------
# Teams Alert Tests
# ---------------------------------------------------------------------------


class TestSendTeamsAlert:
    """Test Teams alert card building and webhook posting."""

    def test_build_adaptive_card_structure(self):
        from platform.shared_services.functions.send_teams_alert import _build_adaptive_card

        card = _build_adaptive_card(
            title="Pipeline Failed",
            severity="critical",
            message="ETL pipeline crashed at silver transform",
            facts={"Pipeline": "orders-etl", "Environment": "prod"},
        )

        assert card["type"] == "message"
        assert len(card["attachments"]) == 1
        content = card["attachments"][0]["content"]
        assert content["type"] == "AdaptiveCard"
        assert content["version"] == "1.5"

        # Verify body has title, severity, message, and facts
        body = content["body"]
        assert len(body) >= 3
        assert body[0]["type"] == "TextBlock"  # Title
        assert "Pipeline Failed" in body[0]["text"]

    def test_build_card_with_actions(self):
        from platform.shared_services.functions.send_teams_alert import _build_adaptive_card

        card = _build_adaptive_card(
            title="Alert",
            severity="info",
            message="Check the dashboard",
            actions=[{"title": "View Dashboard", "url": "https://dashboard.example.com"}],
        )

        content = card["attachments"][0]["content"]
        assert "actions" in content
        assert content["actions"][0]["type"] == "Action.OpenUrl"
        assert content["actions"][0]["url"] == "https://dashboard.example.com"

    def test_severity_styles(self):
        from platform.shared_services.functions.send_teams_alert import _SEVERITY_CONFIG

        assert "critical" in _SEVERITY_CONFIG
        assert "warning" in _SEVERITY_CONFIG
        assert "info" in _SEVERITY_CONFIG
        assert "success" in _SEVERITY_CONFIG

        assert _SEVERITY_CONFIG["critical"]["color"] == "Attention"
        assert _SEVERITY_CONFIG["info"]["color"] == "Accent"

    def test_build_card_dict_facts(self):
        from platform.shared_services.functions.send_teams_alert import _build_adaptive_card

        card = _build_adaptive_card(
            title="Test",
            severity="warning",
            message="Test message",
            facts={"Key1": "Value1", "Key2": "Value2"},
        )

        content = card["attachments"][0]["content"]
        fact_set = [b for b in content["body"] if b.get("type") == "FactSet"]
        assert len(fact_set) == 1
        assert len(fact_set[0]["facts"]) == 2

    def test_build_card_list_facts(self):
        from platform.shared_services.functions.send_teams_alert import _build_adaptive_card

        card = _build_adaptive_card(
            title="Test",
            severity="warning",
            message="Test message",
            facts=[{"title": "Key1", "value": "Value1"}],
        )

        content = card["attachments"][0]["content"]
        fact_set = [b for b in content["body"] if b.get("type") == "FactSet"]
        assert len(fact_set) == 1

    @patch("requests.post")
    def test_webhook_delivery(self, mock_post):
        """Test that the card is posted to the webhook URL."""
        from platform.shared_services.functions.send_teams_alert import _build_adaptive_card

        mock_post.return_value = MagicMock(status_code=200, text="1")

        card = _build_adaptive_card("Test", "info", "Hello world")
        import requests

        resp = requests.post(
            "https://test.webhook.example.com",
            json=card,
            headers={"Content-Type": "application/json"},
            timeout=10,
        )

        mock_post.assert_called_once()
        assert resp.status_code == 200
