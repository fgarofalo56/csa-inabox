"""
Tests for the access router — access request lifecycle management.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from portal.shared.api.services.auth import (
    DomainScope,
    get_current_user,
    get_domain_scope,
)


class TestListAccessRequests:
    """GET /api/v1/access"""

    def test_list_access_requests_returns_demo_data(self, client: TestClient):
        """Should return seeded demo access requests."""
        response = client.get("/api/v1/access")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) >= 4  # 4 demo requests

    def test_list_access_requests_filter_by_status(self, client: TestClient):
        """Should filter access requests by status."""
        client.get("/api/v1/access")  # seed
        response = client.get("/api/v1/access", params={"status": "pending"})
        assert response.status_code == 200
        data = response.json()
        assert all(r["status"] == "pending" for r in data)

    def test_list_access_requests_filter_by_product(self, client: TestClient):
        """Should filter access requests by data product ID."""
        client.get("/api/v1/access")  # seed
        response = client.get("/api/v1/access", params={"data_product_id": "dp-001"})
        assert response.status_code == 200
        data = response.json()
        assert all(r["data_product_id"] == "dp-001" for r in data)

    def test_list_access_requests_sorted_by_date(self, client: TestClient):
        """Should return requests sorted by requested_at descending."""
        response = client.get("/api/v1/access")
        data = response.json()
        dates = [r["requested_at"] for r in data]
        assert dates == sorted(dates, reverse=True)


class TestCreateAccessRequest:
    """POST /api/v1/access"""

    def test_create_access_request(self, client: TestClient):
        """Should create a new access request in pending status."""
        payload = {
            "data_product_id": "dp-001",
            "justification": "Need data for quarterly report.",
            "access_level": "read",
            "duration_days": 30,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["status"] == "pending"
        assert data["data_product_id"] == "dp-001"
        assert data["justification"] == "Need data for quarterly report."
        assert "id" in data

    def test_create_access_request_default_values(self, client: TestClient):
        """Should use default access_level and duration when not provided."""
        payload = {
            "data_product_id": "dp-002",
            "justification": "Analytics work.",
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["access_level"] == "read"
        assert data["duration_days"] == 90


class TestApproveAccessRequest:
    """POST /api/v1/access/{request_id}/approve"""

    def test_approve_pending_request(self, client: TestClient):
        """Should approve a pending request and set review fields."""
        client.get("/api/v1/access")  # seed
        response = client.post(
            "/api/v1/access/ar-002/approve",
            json={"notes": "Approved for ML training."},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "approved"
        assert data["reviewed_at"] is not None
        assert data["expires_at"] is not None

    def test_approve_non_pending_fails(self, client: TestClient):
        """Should reject approval of already processed requests."""
        client.get("/api/v1/access")  # seed
        response = client.post("/api/v1/access/ar-001/approve")
        assert response.status_code == 400

    def test_approve_not_found(self, client: TestClient):
        """Should return 404 for nonexistent request."""
        client.get("/api/v1/access")  # seed
        response = client.post("/api/v1/access/nonexistent/approve")
        assert response.status_code == 404


class TestDenyAccessRequest:
    """POST /api/v1/access/{request_id}/deny"""

    def test_deny_pending_request(self, client: TestClient):
        """Should deny a pending request."""
        client.get("/api/v1/access")  # seed
        response = client.post(
            "/api/v1/access/ar-003/deny",
            json={"notes": "Insufficient justification."},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "denied"
        assert data["reviewed_at"] is not None

    def test_deny_non_pending_fails(self, client: TestClient):
        """Should reject denial of already processed requests."""
        client.get("/api/v1/access")  # seed
        response = client.post("/api/v1/access/ar-004/deny")
        assert response.status_code == 400


# ── CSA-0017 hardening tests (create) ────────────────────────────────────


class TestCreateAccessRequestHardening:
    """CSA-0017: product validation + classification-aware duration caps."""

    def test_create_rejects_unknown_product_404(self, client: TestClient):
        """Requests against non-existent products must 404."""
        payload = {
            "data_product_id": "dp-does-not-exist",
            "justification": "Because.",
            "access_level": "read",
            "duration_days": 30,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 404
        assert "dp-does-not-exist" in response.json()["detail"]

    def test_create_rejects_excessive_duration_restricted_422(
        self, client: TestClient
    ):
        """dp-003 is RESTRICTED — cap is 30 days; 60 must 422."""
        payload = {
            "data_product_id": "dp-003",
            "justification": "Need longer.",
            "access_level": "read",
            "duration_days": 60,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "30" in detail
        assert "restricted" in detail.lower()

    def test_create_rejects_excessive_duration_confidential_422(
        self, client: TestClient
    ):
        """dp-001 is CONFIDENTIAL — cap is 90 days; 365 must 422."""
        payload = {
            "data_product_id": "dp-001",
            "justification": "Need a year.",
            "access_level": "read",
            "duration_days": 365,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 422
        assert "90" in response.json()["detail"]

    def test_create_allows_within_cap_confidential(self, client: TestClient):
        """CONFIDENTIAL duration at exactly the 90-day cap is accepted."""
        payload = {
            "data_product_id": "dp-001",
            "justification": "90 days please.",
            "access_level": "read",
            "duration_days": 90,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201

    def test_create_restricted_tags_elevated_note(self, client: TestClient):
        """RESTRICTED submissions land with an elevated review_notes hint."""
        payload = {
            "data_product_id": "dp-003",  # RESTRICTED
            "justification": "Quarterly audit.",
            "access_level": "read",
            "duration_days": 30,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["review_notes"] is not None
        assert "RESTRICTED" in data["review_notes"]
        assert "manager approval" in data["review_notes"].lower()

    def test_create_internal_does_not_tag_elevated_note(self, client: TestClient):
        """INTERNAL submissions do NOT get the elevated review note."""
        payload = {
            "data_product_id": "dp-002",  # INTERNAL
            "justification": "Standard request.",
            "access_level": "read",
            "duration_days": 90,
        }
        response = client.post("/api/v1/access", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["review_notes"] is None


# ── CSA-0002 hardening tests (approve/deny authorization) ────────────────


# dp-003 (RESTRICTED, domain=finance) + dp-004 (CONFIDENTIAL, domain=marketing)
# ar-002 → dp-004 (marketing), requester ml.team@contoso.com
# ar-003 → dp-003 (finance),  requester finance.analyst@contoso.com


def _user_with(
    *,
    roles: list[str],
    email: str,
    domain: str | None = None,
) -> dict[str, Any]:
    user: dict[str, Any] = {
        "sub": f"sub-{email}",
        "oid": f"oid-{email}",
        "name": email.split("@")[0],
        "preferred_username": email,
        "email": email,
        "roles": roles,
        "tid": "test-tenant",
    }
    if domain is not None:
        user["domain"] = domain
    return user


@pytest.fixture
def override_caller(app):
    """Override ``get_current_user`` + ``get_domain_scope`` for a single test.

    Yields a setter function; any overrides are removed on teardown.
    """
    original_get_user = app.dependency_overrides.get(get_current_user)
    original_get_scope = app.dependency_overrides.get(get_domain_scope)

    def _set(user: dict[str, Any]) -> None:
        async def _user_dep() -> dict[str, Any]:
            return user

        async def _scope_dep() -> DomainScope:
            return DomainScope(
                user_domain=user.get("domain") or user.get("team"),
                is_admin="Admin" in user.get("roles", []),
            )

        app.dependency_overrides[get_current_user] = _user_dep
        app.dependency_overrides[get_domain_scope] = _scope_dep

    yield _set

    # Restore
    if original_get_user is not None:
        app.dependency_overrides[get_current_user] = original_get_user
    else:
        app.dependency_overrides.pop(get_current_user, None)
    if original_get_scope is not None:
        app.dependency_overrides[get_domain_scope] = original_get_scope
    else:
        app.dependency_overrides.pop(get_domain_scope, None)


class TestReviewAuthorization:
    """CSA-0002: domain scoping + self-review prohibition on approve/deny."""

    def test_approve_cross_domain_contributor_403(
        self, client: TestClient, override_caller
    ):
        """Contributor in marketing cannot approve a finance-domain request."""
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="mktg.user@contoso.com",
                domain="marketing",
            )
        )
        # ar-003 → dp-003 (finance, RESTRICTED) pending
        response = client.post("/api/v1/access/ar-003/approve")
        assert response.status_code == 403
        assert "domain" in response.json()["detail"].lower()

    def test_deny_cross_domain_contributor_403(
        self, client: TestClient, override_caller
    ):
        """Contributor in marketing cannot deny a finance-domain request."""
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="mktg.user@contoso.com",
                domain="marketing",
            )
        )
        response = client.post("/api/v1/access/ar-003/deny")
        assert response.status_code == 403

    def test_approve_self_forbidden_even_for_contributor(
        self, client: TestClient, override_caller
    ):
        """A requester may not approve their own request — SoD violation."""
        # ar-003 requester = finance.analyst@contoso.com, product in finance.
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="finance.analyst@contoso.com",
                domain="finance",
            )
        )
        response = client.post("/api/v1/access/ar-003/approve")
        assert response.status_code == 403
        assert "segregation" in response.json()["detail"].lower() or (
            "own" in response.json()["detail"].lower()
        )

    def test_deny_self_forbidden_even_for_contributor(
        self, client: TestClient, override_caller
    ):
        """A requester may not deny their own request either."""
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="finance.analyst@contoso.com",
                domain="finance",
            )
        )
        response = client.post("/api/v1/access/ar-003/deny")
        assert response.status_code == 403

    def test_approve_self_forbidden_even_for_admin(
        self, client: TestClient, override_caller
    ):
        """Self-approval is forbidden regardless of role (Admin included)."""
        override_caller(
            _user_with(
                roles=["Admin"],
                email="finance.analyst@contoso.com",
                domain="finance",
            )
        )
        response = client.post("/api/v1/access/ar-003/approve")
        assert response.status_code == 403

    def test_approve_admin_cross_domain_allowed(
        self, client: TestClient, override_caller
    ):
        """Admins may approve cross-domain requests (not self)."""
        override_caller(
            _user_with(
                roles=["Admin"],
                email="platform.admin@contoso.com",
                domain="platform",
            )
        )
        response = client.post(
            "/api/v1/access/ar-003/approve",
            json={"notes": "Admin approval."},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "approved"

    def test_approve_same_domain_contributor_allowed(
        self, client: TestClient, override_caller
    ):
        """A same-domain non-Admin Contributor can approve."""
        # ar-002 → dp-004 (marketing), requester ml.team@contoso.com
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="mktg.manager@contoso.com",
                domain="marketing",
            )
        )
        response = client.post(
            "/api/v1/access/ar-002/approve",
            json={"notes": "OK from marketing."},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "approved"

    def test_deny_same_domain_contributor_allowed(
        self, client: TestClient, override_caller
    ):
        """A same-domain non-Admin Contributor can deny."""
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="mktg.manager@contoso.com",
                domain="marketing",
            )
        )
        response = client.post(
            "/api/v1/access/ar-002/deny",
            json={"notes": "Denied by marketing."},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "denied"

    def test_approve_contributor_no_domain_claim_403(
        self, client: TestClient, override_caller
    ):
        """A non-Admin with no domain claim cannot approve anything."""
        override_caller(
            _user_with(
                roles=["Contributor"],
                email="orphan@contoso.com",
                # no domain key
            )
        )
        response = client.post("/api/v1/access/ar-002/approve")
        assert response.status_code == 403
