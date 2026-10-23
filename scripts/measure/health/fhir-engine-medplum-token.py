"""fhir-engine-medplum-token.py - LHDS W0-1: mint a Medplum bearer token IN-CLUSTER and write it to a file.

Usage (inside the fhir-client pod, so the base URL is the in-cluster service):
    MEDPLUM_BASE=http://medplum:8103 python -I fhir-engine-medplum-token.py /work/medplum.token

Medplum data is scoped to a PROJECT, and a token only sees its own project. So the project must be created ONCE and
re-entered on every later run; creating a new project per run (the first version of this script) hands the
measurement scripts an empty project and they fail with "no Patient resources found" while the data sits in the old
one (measured 2026-10-23, which cost a Medplum reload).
  First run (no <output>.cred file): /auth/newuser -> /auth/newproject -> /oauth2/token (PKCE "plain"). The throwaway
    user's random e-mail and password are written to <output>.cred (mode 600, inside the pod) so that later runs can
    sign in to the SAME project. They are never printed.
  Later runs (<output>.cred exists): /auth/login with those credentials -> (/auth/profile if the login does not
    auto-select its single membership) -> /oauth2/token.
Needs MEDPLUM_REGISTER_ENABLED=true on the server (fhir-engine-deploy.sh sets it). The token is written to the given
path with mode 600 and its VALUE is never printed: only its length. Access tokens expire (about an hour): re-run
before each long phase.

Exits non-zero (and leaves the previous token file untouched) if any call fails or the response carries no access_token.
"""

import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

if len(sys.argv) != 2:
    sys.exit("usage: fhir-engine-medplum-token.py <output-file>")
out_path = sys.argv[1]
cred_path = out_path + ".cred"
base = os.environ.get("MEDPLUM_BASE", "http://medplum:8103").rstrip("/")
verifier = secrets.token_urlsafe(48)


def post(path, body, form=False):
    data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    r = urllib.request.Request(base + path, data=data, method="POST")
    r.add_header("Content-Type", "application/x-www-form-urlencoded" if form else "application/json")
    try:
        with urllib.request.urlopen(r, timeout=60) as x:
            return json.loads(x.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"{path} -> HTTP {e.code}")  # body deliberately not echoed: it can carry a login or code


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(text)


if os.path.isfile(cred_path):
    with open(cred_path, encoding="utf-8") as fh_cred:
        cred = json.load(fh_cred)
    lg = post(
        "/auth/login",
        {
            "email": cred["email"],
            "password": cred["password"],
            "scope": "openid",
            "codeChallenge": verifier,
            "codeChallengeMethod": "plain",
        },
    )
    code = lg.get("code")
    if not code:
        mem = lg.get("memberships") or []
        if len(mem) != 1:
            sys.exit(f"login returned {len(mem)} memberships and no code; expected exactly 1")
        code = post("/auth/profile", {"login": lg["login"], "profile": mem[0]["id"]})["code"]
    mode = "re-entered existing project"
else:
    cred = {"email": f"w0-{secrets.token_hex(4)}@example.com", "password": secrets.token_urlsafe(18)}
    u = post(
        "/auth/newuser",
        {
            "firstName": "W0",
            "lastName": "Measure",
            "email": cred["email"],
            "password": cred["password"],
            "recaptchaToken": "x",
            "codeChallenge": verifier,
            "codeChallengeMethod": "plain",
        },
    )
    p = post("/auth/newproject", {"login": u["login"], "projectName": "w0-measure-" + secrets.token_hex(3)})
    code = p["code"]
    write_private(cred_path, json.dumps(cred))
    mode = "created new project"
t = post("/oauth2/token", {"grant_type": "authorization_code", "code": code, "code_verifier": verifier}, form=True)
tok = t.get("access_token", "")
if not tok:
    sys.exit("token endpoint returned no access_token")
write_private(out_path, tok)
print(f"{mode}; token written ({len(tok)} chars) to {out_path}")
