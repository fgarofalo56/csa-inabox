#!/usr/bin/env python3
"""CSA Loom -- Loom Unity catalog migration: legacy H2 store -> Postgres store (LU-1).

WHY THIS EXISTS
---------------
Before LU-1, a Loom Unity deployment persisted its metastore in an H2 file DB on
an SMB-mounted Azure Files share (or, on Azure Government, in an *ephemeral*
EmptyDir because the CIFS mount crash-looped the container). LU-1 moves the
default to an Entra-only PostgreSQL Flexible Server. Existing deployments need a
way to carry their catalog across.

There is no honest offline path: the H2 file is a JVM-specific binary written by
Hibernate, and hand-translating its dialect into PostgreSQL DDL is exactly the
kind of "probably works" migration that silently loses objects. Instead this
copies the catalog through the SERVER'S OWN REST API -- the same
/api/2.1/unity-catalog surface the Loom Console speaks -- from the still-running
H2-backed instance into the new Postgres-backed one. Whatever the source server
can list is what gets recreated; anything it cannot is reported, not guessed.

WHAT IT COPIES
--------------
catalogs -> schemas -> tables, volumes, functions, registered models, in that
order (UC enforces parent-before-child). Existing objects on the target are left
alone, so the script is idempotent and safe to re-run after a partial failure.

WHAT IT DOES NOT COPY
---------------------
* DATA. Only metadata moves; tables and volumes keep pointing at the same
  storage locations on the same ADLS account.
* Grants/permissions -- the permissions API on OSS Unity Catalog v0.5.0 returns
  HTTP 500 on GET when server-side authorization is enabled (fixed upstream in
  v0.5.1, which is not published as a container image yet). Re-apply grants from
  the Loom Console after the cutover; the script prints a reminder.

USAGE
-----
  # 1. Deploy the Postgres-backed instance ALONGSIDE the old one (different app
  #    name), so both are reachable at once.
  # 2. Run this from inside the VNet (both are internal-ingress):
  export LOOM_UNITY_SOURCE_URL=https://loom-unity.internal...
  export LOOM_UNITY_TARGET_URL=https://loom-unity-pg.internal...
  export LOOM_UNITY_SOURCE_TOKEN=...   # optional, if the source enforces auth
  export LOOM_UNITY_TARGET_TOKEN=...   # optional, if the target enforces auth
  python3 scripts/csa-loom/loom-unity-migrate-catalog.py --dry-run
  python3 scripts/csa-loom/loom-unity-migrate-catalog.py
  # 3. Repoint the Console (LOOM_UNITY_URL) at the new app and retire the old one.

Stdlib only -- this runs on the in-VNet runner and in an ACA exec session.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "/api/2.1/unity-catalog"
TIMEOUT = 60


class UnityClient:
    def __init__(self, base_url: str, token: str | None, label: str) -> None:
        # Scheme allow-list (bandit B310). Both base URLs come from CLI args, so
        # without this a `file:///etc/passwd` (or a custom scheme) would be
        # happily opened by urlopen and read as if it were a catalog response.
        # Validate ONCE here rather than at every call site.
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(
                f"{label}: refusing base URL with scheme "
                f"{parsed.scheme!r} -- only http/https are permitted (got {base_url!r})"
            )
        if not parsed.netloc:
            raise ValueError(f"{label}: base URL has no host (got {base_url!r})")
        self.base = base_url.rstrip("/")
        self.token = token
        self.label = label

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.base}{API}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        # Re-assert at the call site: `path` is composed internally, but this
        # keeps the scheme guarantee local to the urlopen bandit flags rather
        # than relying on a reader tracing back to __init__.
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            raise ValueError(f"refusing non-http(s) request URL: {url!r}")
        # nosec B310 - the URL scheme is allow-listed to http/https on the two
        # lines above AND in __init__; B310's concern (file:/ + custom schemes)
        # cannot be reached. Suppressed HERE rather than added to the global
        # pyproject skips, so any FUTURE urlopen elsewhere is still flagged.
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # nosec B310
            raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else {}

    def list_all(self, path: str, key: str, params: dict | None = None) -> list[dict]:
        """Follow next_page_token to the end. Returns [] when the server has no
        such surface (404/501) -- an honest 'this server does not do that'."""
        out: list[dict] = []
        page: str | None = None
        while True:
            query = dict(params or {})
            if page:
                query["page_token"] = page
            suffix = f"?{urllib.parse.urlencode(query)}" if query else ""
            try:
                payload = self._request("GET", f"{path}{suffix}")
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 501):
                    return []
                raise
            out.extend(payload.get(key) or [])
            page = payload.get("next_page_token") or None
            if not page:
                return out

    def create(self, path: str, body: dict) -> tuple[bool, str]:
        """Returns (created, note). An already-existing object is a success."""
        try:
            self._request("POST", path, body)
            return True, "created"
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200]
            if exc.code in (409,) or "ALREADY_EXISTS" in detail:
                return False, "already present"
            return False, f"HTTP {exc.code}: {detail}"


def pick(source: dict, *keys: str) -> dict:
    return {k: source[k] for k in keys if source.get(k) not in (None, "")}


def migrate(src: UnityClient, dst: UnityClient, dry_run: bool) -> int:
    failures = 0
    created = 0
    skipped = 0

    def do(kind: str, path: str, body: dict, label: str) -> None:
        nonlocal failures, created, skipped
        if dry_run:
            print(f"  [dry-run] would create {kind} {label}")
            return
        ok, note = dst.create(path, body)
        if ok:
            created += 1
            print(f"  + {kind} {label}")
        elif note == "already present":
            skipped += 1
            print(f"  = {kind} {label} ({note})")
        else:
            failures += 1
            print(f"  ! {kind} {label} FAILED -- {note}", file=sys.stderr)

    catalogs = src.list_all("/catalogs", "catalogs")
    print(f"source catalogs: {len(catalogs)}")
    for catalog in catalogs:
        cname = catalog.get("name")
        if not cname:
            continue
        do("catalog", "/catalogs", pick(catalog, "name", "comment", "properties"), cname)

        schemas = src.list_all("/schemas", "schemas", {"catalog_name": cname})
        for schema in schemas:
            sname = schema.get("name")
            if not sname:
                continue
            body = pick(schema, "name", "comment", "properties")
            body["catalog_name"] = cname
            do("schema", "/schemas", body, f"{cname}.{sname}")

            scope = {"catalog_name": cname, "schema_name": sname}

            for table in src.list_all("/tables", "tables", scope):
                body = pick(
                    table,
                    "name",
                    "table_type",
                    "data_source_format",
                    "columns",
                    "storage_location",
                    "comment",
                    "properties",
                )
                body.update(scope)
                do("table", "/tables", body, f"{cname}.{sname}.{table.get('name')}")

            for volume in src.list_all("/volumes", "volumes", scope):
                body = pick(volume, "name", "volume_type", "storage_location", "comment")
                body.update(scope)
                do("volume", "/volumes", body, f"{cname}.{sname}.{volume.get('name')}")

            for fn in src.list_all("/functions", "functions", scope):
                body = dict(fn)
                for drop in (
                    "function_id",
                    "created_at",
                    "updated_at",
                    "created_by",
                    "updated_by",
                    "full_name",
                    "owner",
                ):
                    body.pop(drop, None)
                body.update(scope)
                do(
                    "function",
                    "/functions",
                    {"function_info": body},
                    f"{cname}.{sname}.{fn.get('name')}",
                )

            for model in src.list_all("/models", "registered_models", scope):
                body = pick(model, "name", "storage_location", "comment")
                body.update(scope)
                do("model", "/models", body, f"{cname}.{sname}.{model.get('name')}")

    print(f"\ncreated={created} already-present={skipped} failed={failures}")
    if not dry_run:
        print(
            "\nREMINDER: grants/permissions are NOT copied. Re-apply them from the\n"
            "Loom Console (/catalog/unity -> Grants) after cutting the Console over\n"
            "to the new LOOM_UNITY_URL. External locations and storage credentials\n"
            "are metastore-level: re-create them on the target before first use."
        )
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", default=os.environ.get("LOOM_UNITY_SOURCE_URL", ""))
    parser.add_argument("--target", default=os.environ.get("LOOM_UNITY_TARGET_URL", ""))
    parser.add_argument("--dry-run", action="store_true", help="list what would be created, change nothing")
    args = parser.parse_args()

    if not args.source or not args.target:
        parser.error(
            "both --source/LOOM_UNITY_SOURCE_URL (the H2-backed instance) and "
            "--target/LOOM_UNITY_TARGET_URL (the Postgres-backed instance) are required"
        )
    if args.source.rstrip("/") == args.target.rstrip("/"):
        parser.error("--source and --target are the same server; deploy the Postgres-backed app alongside the old one first")

    src = UnityClient(args.source, os.environ.get("LOOM_UNITY_SOURCE_TOKEN"), "source")
    dst = UnityClient(args.target, os.environ.get("LOOM_UNITY_TARGET_TOKEN"), "target")
    print(f"source: {src.base}\ntarget: {dst.base}\nmode:   {'dry-run' if args.dry_run else 'apply'}\n")
    try:
        return migrate(src, dst, args.dry_run)
    except urllib.error.HTTPError as exc:
        print(f"FATAL: HTTP {exc.code} from {exc.url}: {exc.read().decode('utf-8', 'replace')[:300]}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(
            f"FATAL: could not reach a Loom Unity server ({exc.reason}). Both apps are "
            "internal-ingress -- run this from inside the VNet.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
