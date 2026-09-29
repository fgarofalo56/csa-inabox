#!/usr/bin/env python3
"""Minimal OIDC issuer for the loom-unity authorization proof.

Serves an OIDC discovery document + JWKS, and mints RS256 JWTs on demand.
Stands in for Microsoft Entra: UC's JwksOperations does plain OIDC discovery
against `server.allowed-issuers`, so any conforming issuer exercises the same
code path Entra would.
"""
import base64
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ISSUER = os.environ.get("IDP_ISSUER", "http://idp:8000")
KID = "loom-test-key-1"

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUB = KEY.public_key()


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def int_b64u(i: int) -> str:
    return b64u(i.to_bytes((i.bit_length() + 7) // 8, "big"))


NUMBERS = PUB.public_numbers()
JWKS = {
    "keys": [
        {
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": KID,
            "n": int_b64u(NUMBERS.n),
            "e": int_b64u(NUMBERS.e),
        }
    ]
}

DISCOVERY = {
    "issuer": ISSUER,
    "jwks_uri": f"{ISSUER}/jwks",
    "authorization_endpoint": f"{ISSUER}/authorize",
    "token_endpoint": f"{ISSUER}/token",
    "response_types_supported": ["code"],
    "subject_types_supported": ["public"],
    "id_token_signing_alg_values_supported": ["RS256"],
}


def mint(sub: str, aud: str, email: str, iss: str, kid: str = KID) -> str:
    header = {"alg": "RS256", "typ": "JWT", "kid": kid}
    now = int(time.time())
    payload = {
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "iat": now,
        "nbf": now,
        "exp": now + 3600,
    }
    # An EMPTY `email` omits the claim entirely rather than minting `"email": ""`.
    #
    # This models a Microsoft Entra APP-ONLY (client-credentials) token — what
    # the Console's managed identity mints — which carries NO `email` claim, so
    # upstream AuthService.verifyPrincipal resolves the caller by `sub`, the
    # service principal's OBJECT ID. iceberg-e2e.sh mints with `email=` for that
    # reason.
    #
    # CORRECTED 2026-09-29 (#3339): an earlier revision of this comment claimed
    # iceberg-e2e.sh already exercised the Console's identity this way. It did
    # not. /mint parsed its query with parse_qs's default keep_blank_values=False,
    # which DROPS `email=` entirely, so the handler's default email applied and
    # every "console" case in that harness ran as a DIFFERENT principal, not
    # the Console's. That hid the real Console credential's 403 on the Iceberg
    # surface. The handler below now keeps blank values, so `email=` reaches
    # this function as "" and the claim is omitted as described.
    if email:
        payload["email"] = email
    signing_input = (
        b64u(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64u(json.dumps(payload, separators=(",", ":")).encode())
    ).encode()
    sig = KEY.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return signing_input.decode() + "." + b64u(sig)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/.well-known/openid-configuration":
            return self._send(200, json.dumps(DISCOVERY).encode())
        if u.path == "/jwks":
            return self._send(200, json.dumps(JWKS).encode())
        if u.path == "/mint":
            # keep_blank_values=True is load-bearing (#3339): without it `email=`
            # is dropped, the default below applies, and a caller asking for an
            # app-only token silently receives a different principal's token.
            q = parse_qs(u.query, keep_blank_values=True)
            tok = mint(
                sub=q.get("sub", ["loom-console"])[0],
                aud=q.get("aud", ["api://loom-unity"])[0],
                email=q.get("email", ["admin"])[0],
                iss=q.get("iss", [ISSUER])[0],
                kid=q.get("kid", [KID])[0],
            )
            return self._send(200, tok.encode(), "text/plain")
        return self._send(404, b"{}")

    def log_message(self, fmt, *args):  # keep the transcript readable
        print("[idp] " + fmt % args, flush=True)


if __name__ == "__main__":
    print(f"[idp] issuer={ISSUER}", flush=True)
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
