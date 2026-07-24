"""Minimal protobuf wire codec for the Arrow Flight SQL command messages (N3).

Arrow Flight SQL puts a `google.protobuf.Any`-wrapped command in the
`FlightDescriptor.cmd` bytes and in the `Ticket.ticket` bytes. `pyarrow.flight`
ships the transport but not the Flight SQL message types, and pulling the whole
`protobuf` runtime + generated stubs into an air-gapped IL5 image for two
messages with three scalar fields is not a trade worth making.

So this module implements exactly the slice of the protobuf binary format those
messages use — varints and length-delimited fields — with no dependencies:

    Any                  { 1: string type_url, 2: bytes value }
    CommandStatementQuery{ 1: string query,  2: bytes transaction_id }
    TicketStatementQuery { 1: bytes statement_handle }
    FlightSQL wire types are stable (Flight SQL is a released Arrow protocol),
    so this codec is not chasing a moving target.

Unknown fields are SKIPPED (protobuf forward-compatibility), so a newer client
that adds a field still parses. Malformed input raises `ProtoError` rather than
silently returning a partial message.
"""
from __future__ import annotations

ANY_PREFIX = "type.googleapis.com/arrow.flight.protocol.sql."

TYPE_STATEMENT_QUERY = ANY_PREFIX + "CommandStatementQuery"
TYPE_TICKET_STATEMENT_QUERY = ANY_PREFIX + "TicketStatementQuery"
TYPE_GET_SQL_INFO = ANY_PREFIX + "CommandGetSqlInfo"
TYPE_GET_TABLES = ANY_PREFIX + "CommandGetTables"
TYPE_PREPARED_STATEMENT_QUERY = ANY_PREFIX + "CommandPreparedStatementQuery"


class ProtoError(ValueError):
    """Malformed protobuf input."""


# ── primitives ──────────────────────────────────────────────────────────────
def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise ProtoError("truncated varint")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ProtoError("varint too long")


def write_varint(value: int) -> bytes:
    if value < 0:
        raise ProtoError("negative varint")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def write_bytes_field(field_no: int, payload: bytes) -> bytes:
    """Encode one length-delimited (wire type 2) field."""
    return write_varint((field_no << 3) | 2) + write_varint(len(payload)) + payload


def parse_fields(buf: bytes) -> dict[int, list[bytes | int]]:
    """Parse a message into {field_number: [values]} without a schema.

    Length-delimited fields yield `bytes`; varints yield `int`. 32/64-bit
    fixed fields are skipped (no Flight SQL command message here uses one).
    """
    out: dict[int, list[bytes | int]] = {}
    pos = 0
    while pos < len(buf):
        key, pos = read_varint(buf, pos)
        field_no, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = read_varint(buf, pos)
            out.setdefault(field_no, []).append(value)
        elif wire == 2:
            length, pos = read_varint(buf, pos)
            end = pos + length
            if end > len(buf):
                raise ProtoError("truncated length-delimited field")
            out.setdefault(field_no, []).append(buf[pos:end])
            pos = end
        elif wire == 5:
            pos += 4
        elif wire == 1:
            pos += 8
        else:
            raise ProtoError(f"unsupported wire type {wire}")
    return out


def _first_bytes(fields: dict[int, list[bytes | int]], field_no: int) -> bytes:
    values = fields.get(field_no) or []
    for value in values:
        if isinstance(value, bytes):
            return value
    return b""


# ── Any ─────────────────────────────────────────────────────────────────────
def unpack_any(payload: bytes) -> tuple[str, bytes]:
    """Return `(type_url, value)` for an `Any`-encoded command."""
    fields = parse_fields(payload)
    type_url = _first_bytes(fields, 1).decode("utf-8", "replace")
    return type_url, _first_bytes(fields, 2)


def pack_any(type_url: str, value: bytes) -> bytes:
    return write_bytes_field(1, type_url.encode("utf-8")) + write_bytes_field(2, value)


# ── Flight SQL commands ─────────────────────────────────────────────────────
def decode_statement_query(value: bytes) -> str:
    """`CommandStatementQuery.query` (field 1, string)."""
    return _first_bytes(parse_fields(value), 1).decode("utf-8", "replace")


def encode_ticket_statement_query(handle: bytes) -> bytes:
    """`TicketStatementQuery{ statement_handle }` wrapped in an `Any`."""
    return pack_any(TYPE_TICKET_STATEMENT_QUERY, write_bytes_field(1, handle))


def decode_ticket_statement_query(value: bytes) -> bytes:
    """`TicketStatementQuery.statement_handle` (field 1, bytes)."""
    return _first_bytes(parse_fields(value), 1)


def describe_command(payload: bytes) -> tuple[str, bytes]:
    """Classify an incoming descriptor/ticket payload.

    Returns `(type_url, inner_value)`. A payload that is not `Any`-wrapped (a
    bare SQL string, which some simple Flight clients send) is reported as
    `('', payload)` so the caller can decide — never guessed at silently.
    """
    try:
        type_url, value = unpack_any(payload)
    except ProtoError:
        return "", payload
    if not type_url.startswith(ANY_PREFIX):
        return "", payload
    return type_url, value
