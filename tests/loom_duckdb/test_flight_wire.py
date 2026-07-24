"""Flight SQL protobuf codec + short-lived ticket verification (N3)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest

from .conftest import load

pbcodec = load("pbcodec")
tickets = load("tickets")


# ── protobuf codec ──────────────────────────────────────────────────────────
def encode_statement_query(sql: str) -> bytes:
    """Build the Any-wrapped CommandStatementQuery an ADBC client would send."""
    inner = pbcodec.write_bytes_field(1, sql.encode("utf-8"))
    return pbcodec.pack_any(pbcodec.TYPE_STATEMENT_QUERY, inner)


class TestProtobufCodec:
    def test_varint_roundtrip_across_byte_boundaries(self):
        for value in (0, 1, 127, 128, 300, 16384, 2**31):
            assert pbcodec.read_varint(pbcodec.write_varint(value), 0) == (value, len(pbcodec.write_varint(value)))

    def test_statement_query_roundtrip(self):
        payload = encode_statement_query("SELECT 1")
        type_url, value = pbcodec.describe_command(payload)
        assert type_url == pbcodec.TYPE_STATEMENT_QUERY
        assert pbcodec.decode_statement_query(value) == "SELECT 1"

    def test_unicode_and_long_queries_survive(self):
        sql = "SELECT 'é中' AS s, " + ", ".join(f"{i} AS c{i}" for i in range(200))
        type_url, value = pbcodec.describe_command(encode_statement_query(sql))
        assert type_url == pbcodec.TYPE_STATEMENT_QUERY
        assert pbcodec.decode_statement_query(value) == sql

    def test_ticket_statement_query_roundtrip(self):
        ticket = pbcodec.encode_ticket_statement_query(b"handle-123")
        type_url, value = pbcodec.describe_command(ticket)
        assert type_url == pbcodec.TYPE_TICKET_STATEMENT_QUERY
        assert pbcodec.decode_ticket_statement_query(value) == b"handle-123"

    def test_unknown_fields_are_skipped_for_forward_compatibility(self):
        inner = pbcodec.write_bytes_field(1, b"SELECT 1") + pbcodec.write_bytes_field(7, b"future")
        payload = pbcodec.pack_any(pbcodec.TYPE_STATEMENT_QUERY, inner)
        _, value = pbcodec.describe_command(payload)
        assert pbcodec.decode_statement_query(value) == "SELECT 1"

    def test_bare_sql_payload_is_reported_as_unwrapped_not_guessed(self):
        type_url, value = pbcodec.describe_command(b"SELECT 1")
        assert type_url == ""
        assert value == b"SELECT 1"

    def test_truncated_length_delimited_field_raises(self):
        with pytest.raises(pbcodec.ProtoError):
            pbcodec.parse_fields(pbcodec.write_varint((1 << 3) | 2) + pbcodec.write_varint(50) + b"short")


# ── ticket verification ─────────────────────────────────────────────────────
def mint(payload: dict, secret: str | None) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii").rstrip("=")
    signed = f"v1.{body}"
    if secret:
        mac = hmac.new(secret.encode("utf-8"), signed.encode("utf-8"), hashlib.sha256).digest()
    else:
        mac = b""
    sig = base64.urlsafe_b64encode(mac).decode("ascii").rstrip("=")
    return f"{signed}.{sig}"


def valid_payload(**over) -> dict:
    payload = {
        "aud": "loom-flightsql",
        "oid": "oid-1",
        "upn": "analyst@contoso.com",
        "tid": "tenant-1",
        "scope": ["abfss://gold@acct.dfs.core.windows.net/sales"],
        "jti": "ticket-1",
        "exp": int(time.time()) + 300,
    }
    payload.update(over)
    return payload


class TestTicketVerification:
    def test_valid_signed_ticket_yields_the_entra_principal(self, monkeypatch):
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        principal = tickets.verify_ticket(mint(valid_payload(), "s3cret"))
        assert principal.oid == "oid-1"
        assert principal.upn == "analyst@contoso.com"
        assert principal.tenant_id == "tenant-1"
        assert principal.ticket_id == "ticket-1"
        assert principal.unverified is False
        assert principal.scope == ("abfss://gold@acct.dfs.core.windows.net/sales",)

    def test_bearer_prefix_is_accepted(self, monkeypatch):
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        assert tickets.verify_ticket("Bearer " + mint(valid_payload(), "s3cret")).oid == "oid-1"

    def test_tampered_payload_fails_signature(self, monkeypatch):
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        token = mint(valid_payload(), "s3cret")
        forged = mint(valid_payload(oid="attacker"), "wrong-key")
        assert forged != token
        with pytest.raises(tickets.TicketInvalidError) as err:
            tickets.verify_ticket(forged)
        assert "signature" in str(err.value)

    def test_expired_ticket_is_refused(self, monkeypatch):
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        with pytest.raises(tickets.TicketInvalidError) as err:
            tickets.verify_ticket(mint(valid_payload(exp=int(time.time()) - 1), "s3cret"))
        assert "expired" in str(err.value)

    def test_wrong_audience_is_refused(self, monkeypatch):
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        with pytest.raises(tickets.TicketInvalidError) as err:
            tickets.verify_ticket(mint(valid_payload(aud="something-else"), "s3cret"))
        assert "audience" in str(err.value)

    def test_missing_ticket_names_where_to_get_one(self, monkeypatch):
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        with pytest.raises(tickets.TicketInvalidError) as err:
            tickets.verify_ticket("")
        assert "Connect tab" in str(err.value)

    def test_unsigned_deployment_reports_unverified_rather_than_trusting_silently(self, monkeypatch):
        monkeypatch.delenv("LOOM_FLIGHT_TICKET_SECRET", raising=False)
        principal = tickets.verify_ticket(mint(valid_payload(), None))
        assert principal.unverified is True
