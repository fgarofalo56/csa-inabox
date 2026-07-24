"""Short-lived Flight ticket verification (N3, server half).

The Loom BFF mints a Flight ticket from a VERIFIED Entra session
(`lib/azure/flight-sql-client.ts`), audits the issuance, and hands the caller a
compact token that:

  * carries the Entra principal (oid / upn / tid) and the granted scope,
  * expires in minutes (default 5) — never a long-lived credential,
  * is HMAC-SHA256 signed with a Key-Vault-injected server key that never
    leaves the boundary, and
  * is single-audience (`loom-flightsql`), so it cannot be replayed anywhere
    else in the estate.

This module is the SERVER half: verify signature, audience and expiry, and
return the principal so `do_get` can authorize + log the access. It shares the
exact token grammar with the TypeScript minter, and both sides have unit tests
over the same vectors.

Grammar (URL-safe base64, no padding):

    v1.<base64url(payload_json)>.<base64url(hmac_sha256(key, "v1." + payload))>
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

TOKEN_VERSION = "v1"
AUDIENCE = "loom-flightsql"


class TicketInvalidError(ValueError):
    """The presented Flight ticket is missing, malformed, expired or unsigned."""


@dataclass(frozen=True)
class FlightPrincipal:
    """The verified caller behind a Flight ticket."""

    oid: str
    upn: str
    tenant_id: str
    #: Granted scope — the abfss:// prefixes / item ids this ticket may read.
    scope: tuple[str, ...]
    #: Ticket id (jti) — the correlation key shared with the BFF audit row.
    ticket_id: str
    expires_at: int
    #: True when the deployment has no signing key configured (in-VNet trust).
    unverified: bool = False


def _b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def signing_key() -> bytes:
    return (os.environ.get("LOOM_FLIGHT_TICKET_SECRET") or "").strip().encode("utf-8")


def verify_ticket(token: str, *, now: int | None = None) -> FlightPrincipal:
    """Verify a minted ticket and return its principal.

    When no signing key is configured the service is running on pure in-VNet
    trust (internal ingress + the Container Apps network is the perimeter). The
    ticket is then parsed but reported `unverified=True` so the access log says
    so honestly — it is never treated as a verified principal.
    """
    raw = (token or "").strip()
    if raw.lower().startswith("bearer "):
        raw = raw[7:].strip()
    if not raw:
        raise TicketInvalidError(
            "No Flight ticket presented. Mint one from the Loom console "
            "(Connect tab → Generate ticket) — it is valid for minutes, not forever."
        )

    parts = raw.split(".")
    if len(parts) != 3 or parts[0] != TOKEN_VERSION:
        raise TicketInvalidError("Flight ticket is malformed (expected v1.<payload>.<signature>).")

    _, payload_b64, signature_b64 = parts
    key = signing_key()
    if key:
        expected = hmac.new(key, f"{TOKEN_VERSION}.{payload_b64}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(signature_b64)):
            raise TicketInvalidError("Flight ticket signature does not verify.")

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception as exc:
        raise TicketInvalidError("Flight ticket payload is not readable JSON.") from exc

    if payload.get("aud") != AUDIENCE:
        raise TicketInvalidError("Flight ticket was minted for a different audience.")

    expires_at = int(payload.get("exp") or 0)
    current = int(now if now is not None else time.time())
    if expires_at <= current:
        raise TicketInvalidError(
            "Flight ticket expired. Tickets are deliberately short-lived — mint a fresh one."
        )

    scope = payload.get("scope") or []
    if isinstance(scope, str):
        scope = [scope]

    return FlightPrincipal(
        oid=str(payload.get("oid") or ""),
        upn=str(payload.get("upn") or ""),
        tenant_id=str(payload.get("tid") or ""),
        scope=tuple(str(s) for s in scope),
        ticket_id=str(payload.get("jti") or ""),
        expires_at=expires_at,
        unverified=not key,
    )
