#!/usr/bin/env python3
"""
CSA Loom — User Data Functions (UDF) execution host.

Azure-native execution backend for the Loom User Data Function editor
(lib/editors/phase4/user-data-function-editor.tsx). It is the day-one target
of the invoke route:

    POST /api/items/user-data-function/<id>/invoke  (Next.js BFF)
      -> POST {LOOM_UDF_FUNCTION_BASE}/api/<functionName>  (this host)

The host runs REAL Python. It imports the published UDF source verbatim — the
same `import fabric.functions as fn; udf = fn.UserDataFunctions(); @udf.function()`
code an author writes in the editor — via the bundled `fabric.functions`
compatibility shim (see fabric/functions.py). Decorated functions are
registered, then invoked with the JSON body as keyword arguments. The value the
function returns is serialized as the HTTP JSON body, exactly like an Azure
Functions HTTP trigger, so the editor's Test/Run panel shows a real result.

Two source resolution modes (both REAL — no fake results):

  1. Bundled default (day-one): /app/udf/function_app.py — materialized by the
     ACA init container from a bicep-delivered secret. Ships with the sample
     `compute_score` function so a fresh bicep deploy answers the default Test
     panel immediately.

  2. Pushed source (forward-compatible): an X-Udf-Source-B64 request header
     carrying the item's current source (base64). When present the host loads
     that source for the request, so any published function — not just the
     bundled sample — executes. This lets the BFF forward the editor's live
     source without a per-function redeploy.

SECURITY — who may push source (CodeQL py/code-injection, issue #2653):
    Executing the pushed body IS the product: this is a function host, and the
    Loom BFF is its only legitimate caller. The defect was that the pushed-source
    path was UNAUTHENTICATED — every workload sharing the Container Apps
    environment could POST Python here and have it executed. Two changes close it:

      * The host now requires a shared key (LOOM_UDF_HOST_KEY, delivered by
        udf-runtime.bicep to this app AND to the Console) on any request that
        carries X-Udf-Source-B64. It is compared in constant time and the request
        is REFUSED (401) when the key is absent or wrong. FAIL-CLOSED: when
        LOOM_UDF_HOST_KEY is unset the host refuses pushed source altogether and
        serves only its bundled functions — an un-keyed deployment cannot be
        talked into running attacker code.
      * The container app no longer carries the Console user-assigned managed
        identity (udf-runtime.bicep), so code executed here has no ambient Azure
        credential to lift from IMDS.

Pure Python standard library only (http.server) so the container needs no pip
install at start — the stock python image runs it directly, mirroring how the
DAB runtime runs a stock engine image.
"""
import base64
import hmac
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

DEFAULT_SOURCE_PATH = os.path.join(APP_DIR, "udf", "function_app.py")
PORT = int(os.environ.get("PORT") or os.environ.get("FUNCTIONS_HTTPWORKER_PORT") or 8080)
#: Shared key the Loom BFF presents to push per-request source. Empty => pushed
#: source is refused outright (bundled functions still execute normally).
HOST_KEY = (os.environ.get("LOOM_UDF_HOST_KEY") or "").strip()


def source_push_allowed(presented):
    """Constant-time check of the caller's key against LOOM_UDF_HOST_KEY.

    Returns False when no key is configured — pushed source is only ever
    executed for a caller that proved it holds the deployment's key.
    """
    if not HOST_KEY:
        return False
    return hmac.compare_digest(str(presented or ""), HOST_KEY)


def load_functions(source_code):
    """Execute UDF source and return {name: callable} for @udf.function() defs."""
    import fabric.functions as fn  # bundled shim
    fn.reset_registry()
    ns = {}
    exec(compile(source_code, "<udf-source>", "exec"), ns, ns)  # noqa: S102 — trusted, author-owned code
    return dict(fn.registry())


def load_default_functions():
    try:
        with open(DEFAULT_SOURCE_PATH, "r", encoding="utf-8") as fh:
            return load_functions(fh.read())
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("failed to load default UDF source: %s\n" % exc)
        return {}


FUNCS = load_default_functions()


class Handler(BaseHTTPRequestHandler):
    server_version = "loom-udf-host/1.0"

    def _send(self, code, obj):
        body = obj if isinstance(obj, (bytes, bytearray)) else json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("access-control-allow-origin", os.environ.get("LOOM_UDF_CORS_ORIGIN", "*"))
        self.send_header(
            "access-control-allow-headers",
            "content-type,x-udf-source-b64,x-functions-key,x-loom-udf-key",
        )
        self.send_header("access-control-allow-methods", "POST,GET,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # keep stdout clean-ish; ACA captures stderr
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_OPTIONS(self):  # noqa: N802
        self._send(204, b"")

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/health", "/api/health", ""):
            return self._send(200, {"status": "healthy", "functions": sorted(FUNCS.keys())})
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) < 2 or parts[0] != "api":
            return self._send(404, {"error": "route not found; expected POST /api/<functionName>"})
        name = parts[1]

        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            params = json.loads(raw or b"{}")
        except Exception as exc:  # noqa: BLE001
            return self._send(400, {"error": "invalid JSON body: %s" % exc})

        funcs = FUNCS
        override = self.headers.get("x-udf-source-b64")
        if override:
            # Executing pushed source requires the deployment's shared key. No
            # key configured => refuse (fail closed); wrong key => refuse.
            if not source_push_allowed(self.headers.get("x-loom-udf-key")):
                return self._send(401, {
                    "error": (
                        "pushed source rejected: this host only executes X-Udf-Source-B64 for a "
                        "caller presenting X-Loom-Udf-Key. Set LOOM_UDF_HOST_KEY on the udf-runtime "
                        "Container App and on the Console (udf-runtime.bicep wires both)."
                    ),
                })
            try:
                funcs = load_functions(base64.b64decode(override).decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                return self._send(400, {"error": "failed to load pushed source: %s" % exc})

        func = funcs.get(name)
        if func is None:
            return self._send(404, {"error": "function %r not found" % name, "available": sorted(funcs.keys())})

        try:
            result = func(**params) if isinstance(params, dict) else func(params)
        except TypeError as exc:
            return self._send(400, {"error": "bad parameters for %s: %s" % (name, exc)})
        except NotImplementedError as exc:
            # Honest gate — a data-source binding the function needs is not wired.
            return self._send(409, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return self._send(500, {"error": str(exc), "trace": traceback.format_exc()})

        # Return the function's value directly as the JSON body, like an Azure
        # Functions HTTP trigger. The BFF passes this text straight to the editor.
        return self._send(200, result)


def main():
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write("loom-udf-host listening on :%d — %d bundled function(s): %s\n"
                     % (PORT, len(FUNCS), ", ".join(sorted(FUNCS.keys())) or "(none)"))
    httpd.serve_forever()


if __name__ == "__main__":
    main()
