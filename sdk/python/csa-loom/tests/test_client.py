"""Behavioural tests for the hand-written half of the SDK.

These exercise the generated methods through :class:`csa_loom.LoomClient` with a
stub transport, so every assertion is about REAL client code paths — URL
building, auth headers, query encoding, JSON bodies and error mapping — not
about a mock returning a canned object.
"""

from __future__ import annotations

import json

import pytest

from csa_loom import (
    LoomApiError,
    LoomAuthError,
    LoomClient,
    LoomForbiddenError,
    LoomGateError,
    LoomNotFoundError,
    LoomRateLimitError,
    LoomTransportError,
    UrllibTransport,
)
from csa_loom._paths import expand
from csa_loom.testing import StubTransport

# --------------------------------------------------------------------------- #
# construction
# --------------------------------------------------------------------------- #


def test_base_url_is_required_and_never_defaults_to_a_cloud(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOOM_BASE_URL", raising=False)
    with pytest.raises(ValueError, match="LOOM_BASE_URL"):
        LoomClient()


def test_base_url_and_credentials_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LOOM_BASE_URL", "https://loom.example.us/")
    monkeypatch.setenv("LOOM_API_TOKEN", "loom_pat_env_secret")
    transport = StubTransport(payload={"ok": True, "oid": "o", "tenantId": "t", "auth": "pat"})
    client = LoomClient(transport=transport)
    assert client.base_url == "https://loom.example.us"
    client.whoami()
    assert transport.last.headers["Authorization"] == "Bearer loom_pat_env_secret"


def test_repr_never_leaks_the_token() -> None:
    client = LoomClient("https://loom.example.gov", token="loom_pat_abc_supersecret")
    assert "supersecret" not in repr(client)
    assert "auth='pat'" in repr(client)


def test_cookie_auth_is_used_when_no_token_is_supplied() -> None:
    transport = StubTransport(payload={"ok": True, "oid": "o", "tenantId": "t", "auth": "cookie"})
    client = LoomClient("https://loom.example.gov", session_cookie="cookie-value", transport=transport)
    client.me()
    assert transport.last.headers["Cookie"] == "loom_session=cookie-value"
    assert "Authorization" not in transport.last.headers


def test_client_is_a_context_manager(transport: StubTransport) -> None:
    with LoomClient("https://loom.example.gov", transport=transport) as client:
        assert isinstance(client, LoomClient)


# --------------------------------------------------------------------------- #
# request shaping
# --------------------------------------------------------------------------- #


def test_path_params_are_percent_encoded() -> None:
    assert expand("/api/cosmos-items/{type}/{id}", {"type": "lakehouse", "id": "a/b?c"}) == (
        "/api/cosmos-items/lakehouse/a%2Fb%3Fc"
    )


def test_empty_path_param_is_refused() -> None:
    with pytest.raises(ValueError, match="must not be empty"):
        expand("/api/cosmos-items/{type}/{id}", {"type": "lakehouse", "id": ""})


def test_missing_path_param_is_refused() -> None:
    with pytest.raises(KeyError):
        expand("/api/cosmos-items/{type}/{id}", {"type": "lakehouse"})


def test_get_item_builds_the_documented_route(client: LoomClient, transport: StubTransport) -> None:
    transport.payload = {"id": "i1", "workspaceId": "w1", "itemType": "lakehouse", "displayName": "bronze"}
    item = client.get_item("lakehouse", "i1")
    assert transport.last.method == "GET"
    assert transport.last.url == "https://loom.example.gov/api/cosmos-items/lakehouse/i1"
    assert transport.last.body is None
    assert item["displayName"] == "bronze"


def test_boolean_query_params_serialise_as_the_bff_parses_them(
    client: LoomClient,
    transport: StubTransport,
) -> None:
    transport.payload = []
    client.list_workspaces(count=True)
    assert transport.last.url == "https://loom.example.gov/api/workspaces?count=true"


def test_omitted_query_params_are_not_sent(client: LoomClient, transport: StubTransport) -> None:
    transport.payload = {"ok": True, "hits": []}
    client.search_catalog(q="sales")
    assert transport.last.url == "https://loom.example.gov/api/catalog/search?q=sales"


def test_request_bodies_are_json_encoded(client: LoomClient, transport: StubTransport) -> None:
    transport.status = 201
    transport.payload = {"id": "w1", "name": "analytics"}
    workspace = client.create_workspace(body={"name": "analytics", "domain": "default"})
    assert transport.last.method == "POST"
    assert transport.last.headers["Content-Type"] == "application/json"
    assert transport.last.body is not None
    assert json.loads(transport.last.body) == {"name": "analytics", "domain": "default"}
    assert workspace["id"] == "w1"


def test_scim_operations_use_the_scim_media_type(client: LoomClient, transport: StubTransport) -> None:
    transport.status = 201
    transport.payload = {"schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"], "userName": "a@b.gov"}
    client.scim_create_user(body={"schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"], "userName": "a@b.gov"})
    assert transport.last.headers["Content-Type"] == "application/scim+json"
    assert transport.last.headers["Accept"] == "application/scim+json"


def test_204_operations_return_none(client: LoomClient, transport: StubTransport) -> None:
    transport.status = 204
    transport.raw_body = b""
    client.scim_delete_user("u1")
    assert transport.last.method == "DELETE"
    assert transport.last.url == "https://loom.example.gov/api/scim/v2/Users/u1"
    assert transport.last.body is None


def test_user_agent_identifies_the_sdk(client: LoomClient, transport: StubTransport) -> None:
    transport.payload = {"ok": True, "edges": []}
    client.list_thread_edges()
    assert transport.last.headers["User-Agent"].startswith("csa-loom/")


# --------------------------------------------------------------------------- #
# error mapping — a refused request must never look like "no data"
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, LoomAuthError),
        (403, LoomForbiddenError),
        (404, LoomNotFoundError),
        (429, LoomRateLimitError),
        (500, LoomApiError),
    ],
)
def test_status_codes_map_to_typed_exceptions(
    client: LoomClient,
    transport: StubTransport,
    status: int,
    expected: type[LoomApiError],
) -> None:
    transport.status = status
    transport.payload = {"ok": False, "error": "nope", "code": "E_TEST"}
    with pytest.raises(expected) as caught:
        client.list_workspaces()
    assert caught.value.status == status
    assert caught.value.message == "nope"
    assert caught.value.code == "E_TEST"
    assert caught.value.path == "/api/workspaces"


def test_retry_after_is_captured(client: LoomClient, transport: StubTransport) -> None:
    transport.status = 429
    transport.headers = {"retry-after": "12"}
    transport.payload = {"ok": False, "error": "slow down"}
    with pytest.raises(LoomRateLimitError) as caught:
        client.list_workspaces()
    assert caught.value.retry_after == 12.0


def test_an_honest_infra_gate_raises_loom_gate_error(client: LoomClient, transport: StubTransport) -> None:
    """A response carrying a remediation ``hint`` is a config gate, not a bug."""
    transport.status = 503
    transport.payload = {
        "ok": False,
        "error": "AI Search is not provisioned in this deployment",
        "code": "E_AI_SEARCH_UNCONFIGURED",
        "hint": "set LOOM_AI_SEARCH_SERVICE",
    }
    with pytest.raises(LoomGateError) as caught:
        client.search_catalog(q="x")
    assert caught.value.hint == "set LOOM_AI_SEARCH_SERVICE"
    assert "set LOOM_AI_SEARCH_SERVICE" in str(caught.value)


def test_a_non_json_error_body_still_produces_a_useful_message(
    client: LoomClient,
    transport: StubTransport,
) -> None:
    transport.status = 502
    transport.raw_body = b"<html>bad gateway</html>"
    with pytest.raises(LoomApiError) as caught:
        client.list_workspaces()
    assert "bad gateway" in caught.value.message


# --------------------------------------------------------------------------- #
# transport safety
# --------------------------------------------------------------------------- #


def test_non_http_schemes_are_refused() -> None:
    transport = UrllibTransport()
    with pytest.raises(LoomTransportError, match="refusing to open"):
        transport.send("GET", "file:///etc/passwd", headers={}, body=None, timeout=1.0)
