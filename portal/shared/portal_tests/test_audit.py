"""
Tests for the tamper-evident audit log (CSA-0016).

Covers:
  * AuditEvent serialisation (stable, deterministic ordering).
  * Hash chain linkage across a sequence of emits.
  * Tamper detection by verify_chain.
  * audit_event_from_request helper with a mock Request.
  * Router integration — approve_access_request emits a chained audit
    event observable via a temp-file sink.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from csa_platform.common.audit import (
    ALLOWED_ACTIONS,
    AuditEvent,
    AuditLogger,
    _GENESIS_HASH,
    _reset_chain_for_testing,
    audit_event_from_request,
    audit_logger,
)


# ─────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clear_chain() -> None:
    """Reset the process-local hash chain before every test."""
    _reset_chain_for_testing()


def _actor() -> dict[str, Any]:
    return {
        "sub": "test-user-id",
        "oid": "00000000-0000-0000-0000-000000000001",
        "tid": "test-tenant",
        "roles": ["Admin"],
        "domain": "human-resources",
        "email": "test@csainabox.local",
    }


def _mock_request(
    *,
    host: str = "10.0.0.42",
    user_agent: str = "pytest/1.0",
    traceparent: str | None = None,
) -> SimpleNamespace:
    """Build a minimal Starlette/FastAPI-compatible request stand-in."""
    headers: dict[str, str] = {"user-agent": user_agent}
    if traceparent:
        headers["traceparent"] = traceparent
    return SimpleNamespace(
        client=SimpleNamespace(host=host),
        headers=headers,
    )


# ─────────────────────────────────────────────────────────────────────────
# AuditEvent serialisation
# ─────────────────────────────────────────────────────────────────────────


class TestAuditEventSerialisation:
    def test_event_serialises_to_stable_json(self) -> None:
        """canonical_json is deterministic and excludes chain_hash."""
        event = AuditEvent(
            actor=_actor(),
            action="access_request.create",
            resource={"type": "access_request", "id": "ar-123"},
            outcome="success",
        )
        # Two serialisations of the same event must match exactly.
        assert event.canonical_json() == event.canonical_json()
        assert "chain_hash" not in json.loads(event.canonical_json())

    def test_event_defaults_generate_ids_and_timestamps(self) -> None:
        event = AuditEvent(
            actor=_actor(),
            action="source.register",
            resource={"type": "source", "id": "src-1"},
            outcome="success",
        )
        assert event.event_id
        assert event.timestamp is not None

    def test_unknown_action_rejected_on_emit(self) -> None:
        """AuditLogger.emit refuses actions outside ALLOWED_ACTIONS."""
        event = AuditEvent(
            actor=_actor(),
            action="bogus.action",
            resource={"type": "source", "id": "src-1"},
            outcome="success",
        )
        with pytest.raises(ValueError, match="Unknown audit action"):
            audit_logger.emit(event)

    def test_allowed_actions_covers_expected_set(self) -> None:
        """The action set is the stable contract for CSA-0016 emit points."""
        for action in (
            "access_request.create",
            "access_request.approve",
            "access_request.deny",
            "source.register",
            "source.provision",
            "source.scan",
            "source.decommission",
            "pipeline.trigger",
        ):
            assert action in ALLOWED_ACTIONS

    def test_denied_outcome_requires_reason(self) -> None:
        event = AuditEvent(
            actor=_actor(),
            action="access_request.deny",
            resource={"type": "access_request", "id": "ar-1"},
            outcome="denied",
        )
        with pytest.raises(ValueError, match="must include a `reason`"):
            audit_logger.emit(event)

    def test_error_outcome_requires_reason(self) -> None:
        event = AuditEvent(
            actor=_actor(),
            action="source.provision",
            resource={"type": "source", "id": "src-1"},
            outcome="error",
        )
        with pytest.raises(ValueError, match="must include a `reason`"):
            audit_logger.emit(event)


# ─────────────────────────────────────────────────────────────────────────
# Hash-chain linkage + tamper detection
# ─────────────────────────────────────────────────────────────────────────


class TestHashChain:
    def test_emit_links_events_in_a_chain(self) -> None:
        """Five events in sequence — each chain_hash seeds the next."""
        events: list[AuditEvent] = []
        for i in range(5):
            e = AuditEvent(
                actor=_actor(),
                action="source.register",
                resource={"type": "source", "id": f"src-{i}"},
                outcome="success",
            )
            events.append(audit_logger.emit(e))

        assert all(e.chain_hash is not None for e in events)
        # Hashes must differ (distinct inputs produce distinct SHA-256s).
        assert len({e.chain_hash for e in events}) == 5
        assert AuditLogger.verify_chain(events) is True

    def test_verify_chain_detects_field_tampering(self) -> None:
        """Mutating a field on any event invalidates the chain."""
        emitted: list[AuditEvent] = []
        for i in range(3):
            e = AuditEvent(
                actor=_actor(),
                action="pipeline.trigger",
                resource={"type": "pipeline", "id": f"pl-{i}"},
                outcome="success",
            )
            emitted.append(audit_logger.emit(e))

        assert AuditLogger.verify_chain(emitted) is True

        # Tamper with the middle event's resource id.
        tampered_copy = emitted[1].model_copy(update={"resource": {"type": "pipeline", "id": "pl-HACKED"}})
        tampered_list = [emitted[0], tampered_copy, emitted[2]]
        assert AuditLogger.verify_chain(tampered_list) is False

    def test_verify_chain_detects_missing_chain_hash(self) -> None:
        events = [
            AuditEvent(
                actor=_actor(),
                action="source.register",
                resource={"type": "source", "id": "src-1"},
                outcome="success",
            )
        ]
        # No chain_hash set → verification fails.
        assert AuditLogger.verify_chain(events) is False

    def test_chain_seeded_from_genesis(self) -> None:
        """First emit links back to the module-level genesis constant."""
        e = AuditEvent(
            actor=_actor(),
            action="source.register",
            resource={"type": "source", "id": "src-g"},
            outcome="success",
        )
        emitted = audit_logger.emit(e)
        # Verifying against genesis must succeed.
        assert AuditLogger.verify_chain([emitted], previous_hash=_GENESIS_HASH) is True
        # Verifying against a wrong seed must fail.
        assert AuditLogger.verify_chain([emitted], previous_hash="0" * 64) is False


# ─────────────────────────────────────────────────────────────────────────
# audit_event_from_request helper
# ─────────────────────────────────────────────────────────────────────────


class TestAuditEventFromRequest:
    def test_pulls_source_ip_and_user_agent(self) -> None:
        req = _mock_request(host="192.168.1.5", user_agent="curl/8.0")
        event = audit_event_from_request(
            request=req,
            user=_actor(),
            action="access_request.create",
            resource={"type": "access_request", "id": "ar-1"},
            outcome="success",
        )
        assert event.source_ip == "192.168.1.5"
        assert event.user_agent == "curl/8.0"

    def test_extracts_traceparent_correlation_id(self) -> None:
        tp = "00-abcdef0123456789abcdef0123456789-0011223344556677-01"
        req = _mock_request(traceparent=tp)
        event = audit_event_from_request(
            request=req,
            user=_actor(),
            action="access_request.create",
            resource={"type": "access_request", "id": "ar-1"},
            outcome="success",
        )
        assert event.correlation_id == "abcdef0123456789abcdef0123456789"

    def test_malformed_traceparent_yields_none(self) -> None:
        req = _mock_request(traceparent="not-a-traceparent")
        event = audit_event_from_request(
            request=req,
            user=_actor(),
            action="access_request.create",
            resource={"type": "access_request", "id": "ar-1"},
            outcome="success",
        )
        assert event.correlation_id is None

    def test_none_request_supported(self) -> None:
        """Lifespan / batch callers may not have a request object."""
        event = audit_event_from_request(
            request=None,
            user=_actor(),
            action="source.register",
            resource={"type": "source", "id": "src-1"},
            outcome="success",
        )
        assert event.source_ip is None
        assert event.user_agent is None
        assert event.correlation_id is None

    def test_actor_projects_jwt_claims(self) -> None:
        req = _mock_request()
        event = audit_event_from_request(
            request=req,
            user=_actor(),
            action="source.register",
            resource={"type": "source", "id": "src-1"},
            outcome="success",
        )
        assert event.actor["sub"] == "test-user-id"
        assert event.actor["tid"] == "test-tenant"
        assert "Admin" in event.actor["roles"]


# ─────────────────────────────────────────────────────────────────────────
# File-sink integration
# ─────────────────────────────────────────────────────────────────────────


class TestFileSink:
    def test_file_sink_writes_dated_jsonl(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AUDIT_FILE_SINK_ENABLED", "true")
        monkeypatch.setenv("AUDIT_FILE_SINK_DIR", str(tmp_path))

        e = AuditEvent(
            actor=_actor(),
            action="source.register",
            resource={"type": "source", "id": "src-file-sink"},
            outcome="success",
        )
        emitted = audit_logger.emit(e)

        # Exactly one JSONL file should have been written under the year
        # directory.  Walk tmp_path for any file ending in .jsonl.
        written = list(tmp_path.rglob("audit-*.jsonl"))
        assert len(written) == 1
        with written[0].open(encoding="utf-8") as fh:
            line = fh.readline().strip()
        parsed = json.loads(line)
        assert parsed["chain_hash"] == emitted.chain_hash
        assert parsed["action"] == "source.register"


# ─────────────────────────────────────────────────────────────────────────
# Router integration — exercise the approve endpoint and capture emits
# ─────────────────────────────────────────────────────────────────────────


class TestRouterIntegration:
    def test_approve_access_request_emits_audit_event(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Approving an access request writes a verifiable audit entry."""
        monkeypatch.setenv("AUDIT_FILE_SINK_ENABLED", "true")
        monkeypatch.setenv("AUDIT_FILE_SINK_DIR", str(tmp_path))

        # Pick any pending demo request and approve it.
        listing = client.get("/api/v1/access").json()
        pending = [r for r in listing if r["status"] == "pending"]
        assert pending, "expected at least one pending demo request"
        request_id = pending[0]["id"]

        response = client.post(
            f"/api/v1/access/{request_id}/approve",
            json={"notes": "audit-integration-test"},
        )
        assert response.status_code == 200

        # Read every audit line written by the file sink.
        entries: list[dict[str, Any]] = []
        for jsonl_path in sorted(tmp_path.rglob("audit-*.jsonl")):
            for raw in jsonl_path.read_text(encoding="utf-8").splitlines():
                if raw.strip():
                    entries.append(json.loads(raw))

        approve_entries = [
            e for e in entries if e.get("action") == "access_request.approve"
        ]
        assert approve_entries, "expected an access_request.approve audit event"
        approved = approve_entries[-1]
        assert approved["outcome"] == "success"
        assert approved["resource"]["id"] == request_id
        assert approved["chain_hash"] is not None

    def test_create_access_request_emits_audit_event(
        self,
        client: TestClient,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Creating an access request writes an audit entry."""
        monkeypatch.setenv("AUDIT_FILE_SINK_ENABLED", "true")
        monkeypatch.setenv("AUDIT_FILE_SINK_DIR", str(tmp_path))

        payload = {
            "data_product_id": "dp-001",
            "justification": "audit integration test",
            "access_level": "read",
            "duration_days": 30,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201

        entries: list[dict[str, Any]] = []
        for jsonl_path in sorted(tmp_path.rglob("audit-*.jsonl")):
            for raw in jsonl_path.read_text(encoding="utf-8").splitlines():
                if raw.strip():
                    entries.append(json.loads(raw))

        create_entries = [
            e for e in entries if e.get("action") == "access_request.create"
        ]
        assert create_entries, "expected an access_request.create audit event"
        created = create_entries[-1]
        assert created["outcome"] == "success"
        assert created["resource"]["product_id"] == "dp-001"
