"""Integration tests for the Copilot FastAPI router."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from apps.copilot.broker.broker import compute_input_hash
from apps.copilot.tools.registry import ToolRegistry


def test_ask_returns_answer_envelope(client: TestClient) -> None:
    """``POST /copilot/ask`` returns the AskResponse JSON envelope."""
    resp = client.post("/copilot/ask", json={"question": "What is CSA?"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["answer"]["answer"].startswith("echo: What is CSA?")
    assert body["answer"]["groundedness"] == pytest.approx(0.9)
    assert body["answer"]["refused"] is False
    assert isinstance(body["answer"]["citations"], list)


def test_ask_hides_citations_when_requested(client: TestClient) -> None:
    """``show_citations=false`` strips citations from the envelope."""
    resp = client.post(
        "/copilot/ask",
        json={"question": "What is CSA?", "show_citations": False},
    )
    assert resp.status_code == 200
    assert resp.json()["answer"]["citations"] == []


def test_ask_rejects_empty_question(client: TestClient) -> None:
    """Validation rejects missing / empty question."""
    resp = client.post("/copilot/ask", json={"question": ""})
    assert resp.status_code == 422


def test_ask_stream_returns_event_stream(client: TestClient) -> None:
    """``POST /copilot/ask`` with ``stream=true`` returns SSE."""
    with client.stream(
        "POST",
        "/copilot/ask",
        json={"question": "What is CSA?", "stream": True},
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]
        chunks = b"".join(resp.iter_bytes())
    text = chunks.decode("utf-8")
    assert "event: status" in text
    assert "event: token" in text
    assert "event: done" in text


def test_chat_mints_new_conversation_id(client: TestClient) -> None:
    """``POST /copilot/chat`` creates a new conversation when none is supplied."""
    resp = client.post("/copilot/chat", json={"question": "hello"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation_id"]
    # Returned in the response header as well for streaming clients.
    assert resp.headers.get("x-copilot-conversation-id") == body["conversation_id"]


def test_chat_reuses_supplied_conversation_id(client: TestClient) -> None:
    """``conversation_id`` in the body is honoured on subsequent turns."""
    first = client.post("/copilot/chat", json={"question": "hello"}).json()
    conv_id = first["conversation_id"]
    second = client.post(
        "/copilot/chat",
        json={"question": "follow-up", "conversation_id": conv_id},
    ).json()
    assert second["conversation_id"] == conv_id


def test_tools_list_empty_registry(client: TestClient) -> None:
    """``GET /copilot/tools`` returns an empty list for an empty registry."""
    resp = client.get("/copilot/tools")
    assert resp.status_code == 200
    assert resp.json() == {"tools": []}


def test_tools_list_populated_registry(app: Any, client: TestClient) -> None:
    """When tools are registered, ``/tools`` returns their ToolSpec dumps."""
    from pydantic import BaseModel

    from apps.copilot.tools.base import ToolCategory

    class _In(BaseModel):
        q: str = "x"

    class _Out(BaseModel):
        a: str = ""

    class _T:
        name: str = "demo_tool"
        category: ToolCategory = "read"
        description: str = "demo"
        input_model: type[_In] = _In
        output_model: type[_Out] = _Out

        async def __call__(self, v: _In) -> _Out:
            return _Out(a=v.q)

    registry = ToolRegistry([_T()])  # type: ignore[list-item]
    from apps.copilot.surfaces.api.dependencies import get_registry

    app.dependency_overrides[get_registry] = lambda: registry

    resp = client.get("/copilot/tools")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["tools"]) == 1
    assert body["tools"][0]["name"] == "demo_tool"


def test_skills_endpoint_returns_list(client: TestClient) -> None:
    """``GET /copilot/skills`` always returns a list shape.

    When the shipped :mod:`apps.copilot.skills` package is present the
    list reflects the shipped catalog; when it is absent we get an empty
    list.  Either way the endpoint MUST not 500.
    """
    resp = client.get("/copilot/skills")
    assert resp.status_code == 200
    body = resp.json()
    assert "skills" in body
    assert isinstance(body["skills"], list)


def test_ingest_returns_broker_token_request_url(client: TestClient) -> None:
    """``POST /copilot/ingest`` routes through the broker."""
    resp = client.post("/copilot/ingest", json={"dry_run": True})
    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "pending_confirmation"
    assert body["token_request_url"] == "/copilot/broker/request"


def test_broker_request_roundtrip(client: TestClient) -> None:
    """Broker request → approve produces a signed token."""
    input_hash = compute_input_hash({"revision": "head"})
    req_resp = client.post(
        "/copilot/broker/request",
        json={
            "tool_name": "run_alembic_upgrade",
            "scope": "dev",
            "input_hash": input_hash,
            "justification": "test",
        },
    )
    assert req_resp.status_code == 200
    request_id = req_resp.json()["request_id"]

    approve_resp = client.post(
        "/copilot/broker/approve",
        json={
            "request_id": request_id,
            "approver_principal": "approver@example.com",
        },
    )
    assert approve_resp.status_code == 200
    token = approve_resp.json()
    assert token["tool_name"] == "run_alembic_upgrade"
    assert token["token"]  # non-empty opaque string
    assert token["token_id"]


def test_broker_approve_unknown_request_returns_404(client: TestClient) -> None:
    """Approving a non-existent request returns 404."""
    resp = client.post(
        "/copilot/broker/approve",
        json={
            "request_id": "does-not-exist",
            "approver_principal": "approver@example.com",
        },
    )
    assert resp.status_code == 404


def test_broker_deny_requires_reason(client: TestClient) -> None:
    """Deny validation — empty reason rejected by Pydantic."""
    resp = client.post(
        "/copilot/broker/deny",
        json={
            "request_id": "x",
            "approver_principal": "y",
            "reason": "",
        },
    )
    assert resp.status_code == 422


def test_broker_deny_roundtrip(client: TestClient) -> None:
    """Broker request → deny returns decision=denied."""
    input_hash = compute_input_hash({"k": "v"})
    req_resp = client.post(
        "/copilot/broker/request",
        json={
            "tool_name": "run_alembic_upgrade",
            "scope": "dev",
            "input_hash": input_hash,
        },
    )
    request_id = req_resp.json()["request_id"]

    deny_resp = client.post(
        "/copilot/broker/deny",
        json={
            "request_id": request_id,
            "approver_principal": "approver@example.com",
            "reason": "not yet",
        },
    )
    assert deny_resp.status_code == 200
    assert deny_resp.json()["decision"] == "denied"


def test_healthz_ok(client: TestClient) -> None:
    """Standalone launcher exposes /healthz."""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
