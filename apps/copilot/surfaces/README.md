# CSA Copilot — Client-Facing Surfaces (Phase 5)

Four independent surfaces expose the Copilot agent + tool registry +
broker to clients.  Each surface owns one transport and one concern;
they all share the same core modules (`apps.copilot.agent`,
`apps.copilot.tools`, `apps.copilot.broker`).

| Surface | Transport | Entry point |
|---|---|---|
| FastAPI router | HTTP + SSE | `python -m apps.copilot.surfaces.api` |
| MCP server | stdio (+ optional HTTP) | `python -m apps.copilot.surfaces.mcp` |
| CLI daemon | Unix-socket / localhost TCP JSON-RPC 2.0 | `python -m apps.copilot.surfaces.cli_daemon` |
| Web demo | HTTP + SSE + Jinja2 | `python -m apps.copilot.surfaces.web` |

## FastAPI router

Mountable `APIRouter` available at `apps.copilot.surfaces.api.router.router`.

Routes (under a caller-chosen prefix, default `/copilot`):

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/ask` | `AskRequest` | Single-turn grounded Q&A. `stream=true` returns SSE. |
| POST | `/chat` | `AskRequest` | Multi-turn grounded Q&A; `conversation_id` optional. |
| POST | `/ingest` | `IngestRequest` | Returns a broker token-request URL (execute-class). |
| GET | `/tools` | — | List registered tools. |
| GET | `/skills` | — | List registered skills (empty when absent). |
| POST | `/broker/request` | `BrokerRequestBody` | Record a confirmation request. |
| POST | `/broker/approve` | `BrokerApproveBody` | Approve and receive a token. |
| POST | `/broker/deny` | `BrokerDenyBody` | Deny a pending request. |

### Sample

```
POST /copilot/ask
{"question": "How do I enable private endpoints?"}
→ 200
{
  "answer": {
    "question": "How do I enable private endpoints?",
    "answer": "...",
    "citations": [...],
    "groundedness": 0.87,
    "refused": false
  },
  "conversation_id": null
}
```

### Runbook

```bash
# Dev / local
python -m apps.copilot.surfaces.api --port 8091

# Staging / production (refuses to boot without these)
export COPILOT_API_AUTH_ENABLED=true
export AZURE_TENANT_ID=...
export AZURE_CLIENT_ID=...
export COPILOT_API_CORS_ORIGINS='["https://portal.example.com"]'
python -m apps.copilot.surfaces.api
```

## MCP server

Runs over stdio by default.  Compatible with Claude Desktop, Cursor,
and any MCP-speaking client.

### Sample

```
→ tools/call {"name": "ask", "arguments": {"question": "What is CSA?"}}
← {"status": "ok", "output": {"question": "...", "answer": "...", ...}}

→ resources/read {"uri": "corpus://search/private%20endpoints"}
← {"query": "private endpoints", "chunks": [...]}
```

### Runbook

```bash
# Stdio (default)
python -m apps.copilot.surfaces.mcp

# Register with Claude Desktop — add to claude_desktop_config.json:
# {"mcpServers": {"csa-copilot": {"command": "python",
#   "args": ["-m", "apps.copilot.surfaces.mcp"]}}}
```

## CLI daemon

Long-lived process that keeps the agent warm.  Clients connect over a
Unix-domain socket (POSIX) or a localhost TCP socket (Windows or
`--tcp`).

### Sample

```bash
# First call auto-starts the daemon; subsequent calls reuse it.
$ python -m apps.copilot.surfaces.cli_daemon.client ping
{"jsonrpc": "2.0", "id": "...", "result": {"status": "pong", "pid": 12345}}

$ python -m apps.copilot.surfaces.cli_daemon.client ask "What is CSA?"
{"jsonrpc": "2.0", "id": "...", "result": {"question": "...", "answer": "...", ...}}
```

### Runbook

```bash
# Start explicitly (otherwise the client spawns one on first use).
python -m apps.copilot.surfaces.cli_daemon

# Override paths (tests).
python -m apps.copilot.surfaces.cli_daemon --pidfile /tmp/csa.pid --tcp

# Stop cleanly.
python -m apps.copilot.surfaces.cli_daemon.client shutdown
```

## Web demo

Single Jinja2 page + one JS file + one CSS file.  Streams answers over
SSE.  Scope-bound — no routing, no SPA, no auth UX.

### Sample

```
GET /                        → HTML page with chat form
GET /chat/send?question=...  → text/event-stream with token / done events
```

### Runbook

```bash
# Local demo
python -m apps.copilot.surfaces.web --port 8092

# Staging behind BFF (safe)
export ENVIRONMENT=staging
export AUTH_MODE=bff
python -m apps.copilot.surfaces.web

# Production without BFF — disable demo mode AND configure auth
export ENVIRONMENT=production
export AUTH_MODE=none
export COPILOT_WEB_LOCAL_DEMO_MODE=false
export AZURE_TENANT_ID=...
python -m apps.copilot.surfaces.web
```

## Configuration surface

All four surfaces read :class:`apps.copilot.surfaces.config.SurfacesSettings`
side-by-side with the existing :class:`apps.copilot.config.CopilotSettings`.
Every field is prefixed `COPILOT_` in the environment.

See `config.py` for the authoritative list of variables and their
staging/production defaults.
