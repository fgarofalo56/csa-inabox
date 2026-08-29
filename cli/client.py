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


# ── Credential-safe opener (#3717) ────────────────────────────────────────────
#
# THE DEFECT THIS REPLACES. `urllib.request.urlopen()` uses the DEFAULT GLOBAL
# OPENER, and every request below carries `Authorization: Bearer <token>`. Two
# measured properties of that opener:
#
#   * `HTTPRedirectHandler.redirect_request` rebuilds the Request copying EVERY
#     header except content-length/content-type. urllib does NOT strip
#     `Authorization` across a host change the way `requests` does.
#   * `HTTPRedirectHandler.http_error_302` permits a `Location:` whose scheme is
#     in `('http', 'https', 'ftp', '')`, and the default opener installs
#     `FTPHandler` / `FileHandler` / `DataHandler` with NO proxy variable set.
#
# So a hostile or compromised upstream answering `302 -> http://attacker/loot`
# hands the caller's bearer token to whatever host `Location:` names — and the
# call SUCCEEDS, so nothing is raised and nothing is logged. Measured against the
# sibling `scripts/csa-loom/livy-session-census.py` before its fix:
#
#     ATTACKER RECEIVED auth : Bearer SUPER_SECRET_TOKEN
#
# The plain `http:` cross-host redirect is the variant that matters — it needs no
# proxy variable and no unusual scheme. `ftp:` is the lesser one.
#
# TWO REMEDIES THAT DO NOT WORK, both measured, recorded so nobody re-spends the
# time: `build_opener(HTTPHandler, HTTPSHandler, HTTPRedirectHandler)` only
# DE-DUPLICATES the default handler set (ftp/file/data stay installed), and an
# unscoped `ProxyHandler()` re-registers an `ftp` route from a single `ftp_proxy`
# env var and then fails OPEN through `proxy_open`.
#
# Canonical long-form argument, with the full measurement log:
# `scripts/csa-loom/livy-session-census.py`. It is duplicated rather than
# imported because `cli/` ships as its own distributable with no dependency on
# `scripts/`; the same is true of the other four sites this issue covers.
_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(url: str) -> tuple[str, str, int | None]:
    """The (scheme, host, port) triple two URLs must share to be same-origin."""
    parts = urllib.parse.urlsplit(url)
    scheme = (parts.scheme or "").lower()
    return (scheme, (parts.hostname or "").lower(), parts.port or _DEFAULT_PORTS.get(scheme))


def _origin_str(origin: tuple[str, str, int | None]) -> str:
    """Render an origin triple for an error message, omitting an unknown port."""
    scheme, host, port = origin
    return f"{scheme}://{host}" + (f":{port}" if port is not None else "")


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse any redirect that leaves the origin the request was aimed at.

    THIS is the guard that closes the exfiltration vector; the scheme scoping in
    :func:`_http_only_opener` is defence in depth, not the fix.

    It REFUSES rather than stripping the header: a request that silently lost its
    credentials would come back 401 from an unexpected host and send the reader
    somewhere else entirely. Refusing names the real cause. Same-origin redirects
    (path changes, trailing-slash normalisation) still work.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        target = urllib.parse.urljoin(req.full_url, newurl)
        if _origin(target) != _origin(req.full_url):
            raise urllib.error.HTTPError(
                target, code,
                f"refusing cross-origin redirect "
                f"{_origin_str(_origin(req.full_url))} -> "
                f"{_origin_str(_origin(target))} — urllib copies the "
                f"Authorization header across a host change, so following this "
                f"would hand the bearer token to that host",
                headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _http_only_opener() -> urllib.request.OpenerDirector:
    """An opener whose only URL schemes are http and https (defence in depth).

    The proxy dict is SCOPED on purpose. `ProxyHandler.__init__` does
    `setattr(self, '%s_open' % type, …)` for EVERY key in the dict, and the
    default `ProxyHandler()` reads `getproxies()` — so one `ftp_proxy` puts the
    ftp route straight back, and it fails OPEN (`proxy_open` re-dispatches to the
    proxy over HTTP with every header intact). Dropping the `'no'` key does not
    break `no_proxy`: `proxy_open` calls the module-level `proxy_bypass()`, which
    re-reads the environment itself.
    """
    proxies = {
        scheme: url
        for scheme, url in urllib.request.getproxies().items()
        if scheme in ("http", "https")
    }
    handlers: list[urllib.request.BaseHandler] = [
        urllib.request.ProxyHandler(proxies),
        urllib.request.HTTPHandler(),
        _SameOriginRedirectHandler(),
        urllib.request.HTTPErrorProcessor(),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.UnknownHandler(),
    ]
    # The stdlib defines HTTPSHandler only under
    # `hasattr(http.client, "HTTPSConnection")`; referencing it unconditionally
    # would turn an ssl-less interpreter into an ImportError at module load.
    https_handler = getattr(urllib.request, "HTTPSHandler", None)
    if https_handler is not None:
        handlers.insert(2, https_handler())

    opener = urllib.request.OpenerDirector()
    for handler in handlers:
        opener.add_handler(handler)
    return opener


_OPENER = _http_only_opener()


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
        # `base_url` is operator-supplied, so the scheme is checked STRUCTURALLY
        # (parse, not a substring test) right at the call site. THREE separate
        # guards, covering different things:
        #   this check                 — the URL WE build
        #   _SameOriginRedirectHandler — where the server tries to send us next,
        #                                for ANY scheme including plain http
        #   _http_only_opener          — which transports exist at all
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            raise APIError(0, f"refusing non-http(s) request URL: {url!r}")
        try:
            with _OPENER.open(req, timeout=self.timeout) as resp:
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
