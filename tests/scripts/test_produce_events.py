"""Tests for scripts/streaming/produce_events.py — event generator."""

from __future__ import annotations

import json
from pathlib import Path

from tests.conftest import load_script_module

# Load module from scripts directory (not a package).
_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "streaming" / "produce_events.py"
_mod = load_script_module("produce_events", _SCRIPT_PATH)

generate_event = _mod.generate_event
EVENT_TYPES: list[str] = _mod.EVENT_TYPES
PAGES: list[str] = _mod.PAGES
DEVICES: list[str] = _mod.DEVICES
REGIONS: list[str] = _mod.REGIONS


class TestGenerateEvent:
    """Tests for the event generator function."""

    def test_returns_dict_with_required_fields(self) -> None:
        event = generate_event(0)
        assert "id" in event
        assert "source" in event
        assert "type" in event
        assert "timestamp" in event
        assert "data" in event

    def test_event_type_is_valid(self) -> None:
        for i in range(50):
            event = generate_event(i)
            assert event["type"] in EVENT_TYPES

    def test_event_number_matches_input(self) -> None:
        event = generate_event(42)
        assert event["data"]["event_number"] == 42

    def test_source_is_csa_producer(self) -> None:
        event = generate_event(0)
        assert event["source"] == "csa-inabox-producer"

    def test_event_is_json_serializable(self) -> None:
        event = generate_event(0)
        serialized = json.dumps(event)
        parsed = json.loads(serialized)
        assert parsed["source"] == "csa-inabox-producer"

    def test_session_id_format(self) -> None:
        event = generate_event(0)
        assert event["data"]["session_id"].startswith("sess-")

    def test_device_is_valid(self) -> None:
        for i in range(50):
            event = generate_event(i)
            assert event["data"]["device"] in DEVICES

    def test_region_is_valid(self) -> None:
        for i in range(50):
            event = generate_event(i)
            assert event["data"]["region"] in REGIONS

    def test_page_view_has_page_and_browser(self) -> None:
        """Generate enough events to get at least one page_view."""
        found_page_view = False
        for i in range(200):
            event = generate_event(i)
            if event["type"] == "page_view":
                assert event["data"]["page"] in PAGES
                assert "browser" in event["data"]
                assert "load_time_ms" in event["data"]
                found_page_view = True
                break
        assert found_page_view, "No page_view event generated in 200 tries"

    def test_sensor_reading_has_metrics(self) -> None:
        """Generate enough events to get at least one sensor_reading."""
        found = False
        for i in range(200):
            event = generate_event(i)
            if event["type"] == "sensor_reading":
                assert "sensor_id" in event["data"]
                assert "temperature" in event["data"]
                assert "humidity" in event["data"]
                found = True
                break
        assert found, "No sensor_reading event generated in 200 tries"

    def test_error_event_has_code_and_message(self) -> None:
        """Generate enough events to get at least one error event."""
        found = False
        for i in range(500):
            event = generate_event(i)
            if event["type"] == "error":
                assert "error_code" in event["data"]
                assert "error_message" in event["data"]
                assert isinstance(event["data"]["error_code"], int)
                found = True
                break
        assert found, "No error event generated in 500 tries"

    def test_unique_ids_across_events(self) -> None:
        ids = {generate_event(i)["id"] for i in range(100)}
        assert len(ids) == 100, "Event IDs should be unique"


class TestEventTypes:
    """Verify the static configuration is well-formed."""

    def test_event_types_not_empty(self) -> None:
        assert len(EVENT_TYPES) > 0

    def test_pages_not_empty(self) -> None:
        assert len(PAGES) > 0

    def test_devices_not_empty(self) -> None:
        assert len(DEVICES) > 0

    def test_regions_are_azure_regions(self) -> None:
        for region in REGIONS:
            # Basic sanity — Azure regions are lowercase with no spaces
            assert region == region.lower()
            assert " " not in region
