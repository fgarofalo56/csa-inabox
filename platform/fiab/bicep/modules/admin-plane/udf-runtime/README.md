# Loom User Data Functions (UDF) runtime host

Azure-native execution backend for the Loom **User Data Function** editor. It is
the day-one target the invoke route resolves via `LOOM_UDF_FUNCTION_BASE`:

```
POST /api/items/user-data-function/<id>/invoke        (Next.js BFF)
  → POST {LOOM_UDF_FUNCTION_BASE}/api/<functionName>   (this host, ACA)
```

Deployed by [`../udf-runtime.bicep`](../udf-runtime.bicep) as a Container App in
the Loom admin-plane environment — mirroring the DAB preview runtime
(`../dab-runtime.bicep`): a **stock image** runs code delivered as base64
secrets and materialized by a busybox **init container** onto an EmptyDir
volume. No custom image build, no ACR dependency.

## What it does (real, not a stub)

The host runs **real Python**. It imports published UDF source verbatim — the
same `import fabric.functions as fn; udf = fn.UserDataFunctions(); @udf.function()`
code authored in the editor — through the bundled `fabric.functions`
compatibility shim, registers the decorated functions, invokes the requested one
with the JSON body as keyword arguments, and returns the function's value as the
JSON HTTP body (exactly like an Azure Functions HTTP trigger). The editor's
Test/Run panel therefore shows a genuinely computed result.

## Files

| File | Materialized as | Purpose |
|------|-----------------|---------|
| `app.py` | `/app/app.py` | stdlib `http.server` host + executor (no pip needed) |
| `fabric_functions.py` | `/app/fabric/functions.py` | `fabric.functions` shim (`UserDataFunctions`, `@udf.function()`, binding placeholders) |
| `default_function_app.py` | `/app/udf/function_app.py` | day-one sample source (`compute_score`, `echo`) |

`bicep` reads these via `loadTextContent()` and delivers them as base64 secrets;
the init container decodes them and creates the `fabric/` package before the
main container runs `python3 /app/app.py`.

## Endpoints

- `GET /health` → `{ "status": "healthy", "functions": [...] }` (liveness probe)
- `POST /api/<functionName>` with a JSON object body → the function's return
  value as JSON. Optional `X-Udf-Source-B64` header carries the item's current
  source (base64) so **any** published function runs, not just the bundled
  sample — forward-compatible with the BFF forwarding live source.

## Source resolution (both real)

1. **Bundled default (day-one):** `/app/udf/function_app.py`. A fresh bicep
   deploy answers the default Test panel immediately (`compute_score`).
2. **Pushed source:** `X-Udf-Source-B64` request header. Loaded per-request; lets
   the BFF forward the editor's live source without a per-function redeploy.

## Data-source bindings (honest gate)

Binding types (`FabricSqlConnection`, lakehouse clients, `UserDataFunctionContext`)
exist as placeholders so source using them as annotations imports cleanly. If a
function actually *uses* an unwired binding it raises `NotImplementedError` and
the host returns **HTTP 409** naming the remediation — never a faked result (per
`.claude/rules/no-vaporware.md`). Wire a real connection by setting its
env/Key Vault secret, granting the Console UAMI access, and replacing the
placeholder. Functions run **as the Console UAMI**, so managed-identity access to
Azure data (SQL, ADLS, Cosmos) is available once RBAC is granted.

## Local test

```bash
python3 app.py &                       # PORT env, default 8080
curl localhost:8080/health
curl -X POST localhost:8080/api/compute_score \
  -H 'content-type: application/json' \
  -d '{"user_id":"alice","weight":2}'
# → {"user": "alice", "score": 84.0, "computed_at": "...Z"}
```
