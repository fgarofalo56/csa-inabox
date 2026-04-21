"""HTTP client for the CSA-in-a-Box backend API.

Wraps ``urllib.request`` so that the CLI has no extra third-party
dependencies beyond ``click``.  All requests are synchronous and
raise :class:`APIError` on non-2xx responses.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class APIError(Exception):
    """Raised when the backend returns a non-2xx status code."""

    def __init__(self, status: int, detail: str) -> None:
        self.status = status
        self.detail = detail
        super().__init__(f"HTTP {status}: {detail}")


class APIClient:
    """Thin HTTP client for the CSA Portal REST API.

    Parameters
    ----------
    base_url:
        Root URL including the version prefix, e.g.
        ``http://localhost:8000/api/v1``.
    token:
        Optional Bearer token for authenticated requests.
    timeout:
        Request timeout in seconds (default: 30).
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout: int = 30,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    # ── Private helpers ────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _url(self, path: str, params: dict[str, Any] | None = None) -> str:
        url = f"{self.base_url}/{path.lstrip('/')}"
        if params:
            filtered = {k: str(v) for k, v in params.items() if v is not None}
            if filtered:
                url = f"{url}?{urllib.parse.urlencode(filtered)}"
        return url

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        url = self._url(path, params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                detail = json.loads(raw).get("detail", raw)
            except (json.JSONDecodeError, AttributeError):
                detail = raw or exc.reason
            raise APIError(exc.code, detail) from exc
        except urllib.error.URLError as exc:
            raise APIError(0, f"Connection error: {exc.reason}") from exc

    # ── Public request methods ─────────────────────────────────────────────

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """Issue a GET request and return the decoded JSON response."""
        return self._request("GET", path, params=params)

    def post(self, path: str, body: Any = None) -> Any:
        """Issue a POST request and return the decoded JSON response."""
        return self._request("POST", path, body=body)

    def patch(self, path: str, body: Any = None) -> Any:
        """Issue a PATCH request and return the decoded JSON response."""
        return self._request("PATCH", path, body=body)

    # ── Sources ────────────────────────────────────────────────────────────

    def list_sources(
        self,
        domain: str | None = None,
        status: str | None = None,
        source_type: str | None = None,
        search: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict]:
        return self.get(
            "/sources",
            params={
                "domain": domain,
                "status": status,
                "source_type": source_type,
                "search": search,
                "limit": limit,
                "offset": offset,
            },
        )

    def get_source(self, source_id: str) -> dict:
        return self.get(f"/sources/{source_id}")

    def register_source(self, payload: dict) -> dict:
        return self.post("/sources", body=payload)

    def decommission_source(self, source_id: str) -> dict:
        return self.post(f"/sources/{source_id}/decommission")

    def provision_source(self, source_id: str) -> dict:
        return self.post(f"/sources/{source_id}/provision")

    # ── Pipelines ──────────────────────────────────────────────────────────

    def list_pipelines(
        self,
        source_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        return self.get(
            "/pipelines",
            params={"source_id": source_id, "status": status, "limit": limit},
        )

    def get_pipeline(self, pipeline_id: str) -> dict:
        return self.get(f"/pipelines/{pipeline_id}")

    def get_pipeline_runs(self, pipeline_id: str, limit: int = 20) -> list[dict]:
        return self.get(f"/pipelines/{pipeline_id}/runs", params={"limit": limit})

    def trigger_pipeline(self, pipeline_id: str) -> dict:
        return self.post(f"/pipelines/{pipeline_id}/trigger")

    # ── Marketplace ────────────────────────────────────────────────────────

    def list_products(
        self,
        domain: str | None = None,
        search: str | None = None,
        min_quality: float | None = None,
        limit: int = 50,
    ) -> list[dict]:
        return self.get(
            "/marketplace/products",
            params={
                "domain": domain,
                "search": search,
                "min_quality": min_quality,
                "limit": limit,
            },
        )

    def get_product(self, product_id: str) -> dict:
        return self.get(f"/marketplace/products/{product_id}")

    def get_product_quality(self, product_id: str, days: int = 30) -> list[dict]:
        return self.get(
            f"/marketplace/products/{product_id}/quality",
            params={"days": days},
        )

    def list_marketplace_domains(self) -> list[dict]:
        return self.get("/marketplace/domains")

    def marketplace_stats(self) -> dict:
        return self.get("/marketplace/stats")

    # ── Stats ──────────────────────────────────────────────────────────────

    def platform_stats(self) -> dict:
        return self.get("/stats")

    def domain_overview(self, domain: str) -> dict:
        return self.get(f"/stats/domains/{domain}")

    def all_domains(self) -> list[dict]:
        return self.get("/domains")
