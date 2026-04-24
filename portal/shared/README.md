[← Portal Implementations](../README.md)

# CSA-in-a-Box — Shared Backend API


> [!NOTE]
> **TL;DR:** FastAPI shared backend providing common API surface for all four portal frontends — sources, pipelines, marketplace, access requests, and stats. Supports Microsoft Entra ID JWT auth (Commercial + Gov), demo mode for local development, and Docker deployment.

The **shared backend** is a FastAPI application that provides the common API surface for all four portal front-end implementations:

| Frontend | Technology | Notes |
|---|---|---|
| React Web App | Next.js / React | `portal/react-webapp/` |
| PowerApps | Power Platform | Custom connector |
| Static Web App | Azure SWA | `portal/swa/` |
| Kubernetes | AKS-hosted SPA | `portal/k8s/` |

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [API Endpoints](#api-endpoints)
- [Authentication](#authentication)
- [Configuration](#configuration)
- [Docker](#docker)
- [Demo Mode](#demo-mode)
- [Related Documentation](#related-documentation)

---

## 🏗️ Architecture

```text
portal/shared/
├── api/
│   ├── main.py              # FastAPI app, CORS, lifespan, routers
│   ├── config.py             # pydantic-settings configuration
│   ├── models/               # Pydantic request/response models
│   │   ├── source.py         # Source registration & lifecycle
│   │   ├── pipeline.py       # Pipeline records & runs
│   │   └── marketplace.py    # Data products, quality, access, stats
│   ├── routers/              # API endpoint handlers (v1)
│   │   ├── sources.py        # /api/v1/sources/*
│   │   ├── pipelines.py      # /api/v1/pipelines/*
│   │   ├── marketplace.py    # /api/v1/marketplace/*
│   │   ├── access.py         # /api/v1/access/*
│   │   └── stats.py          # /api/v1/stats/*
│   └── services/             # Business logic & integrations
│       ├── auth.py           # Microsoft Entra ID JWT validation
│       └── provisioning.py   # DLZ provisioning orchestrator
├── requirements.txt
├── Dockerfile
└── README.md                 # ← you are here
```

---

## 🚀 Quick Start

```bash
# From portal/shared/
pip install -r requirements.txt

# Run locally (with hot reload)
uvicorn api.main:app --reload --port 8000

# Interactive docs
open http://localhost:8000/api/docs
```

---

## 🔌 API Endpoints

### Health
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Liveness / readiness probe |

### Sources
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/sources` | List sources (filter by domain, status, type) |
| GET | `/api/v1/sources/{id}` | Get single source |
| POST | `/api/v1/sources` | Register new source |
| PATCH | `/api/v1/sources/{id}` | Partial update |
| POST | `/api/v1/sources/{id}/decommission` | Decommission source |
| POST | `/api/v1/sources/{id}/provision` | Trigger DLZ provisioning |
| POST | `/api/v1/sources/{id}/scan` | Trigger Purview scan |

### Pipelines
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/pipelines` | List pipelines |
| GET | `/api/v1/pipelines/{id}` | Get pipeline |
| GET | `/api/v1/pipelines/{id}/runs` | Get pipeline runs |
| POST | `/api/v1/pipelines/{id}/trigger` | Trigger run |

### Marketplace
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/marketplace/products` | Browse data products |
| GET | `/api/v1/marketplace/products/{id}` | Get data product |
| GET | `/api/v1/marketplace/products/{id}/quality` | Quality history |
| GET | `/api/v1/marketplace/domains` | List domains |
| GET | `/api/v1/marketplace/stats` | Marketplace statistics |

### Access Requests
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/access` | List access requests |
| POST | `/api/v1/access` | Create access request |
| POST | `/api/v1/access/{id}/approve` | Approve request |
| POST | `/api/v1/access/{id}/deny` | Deny request |

### Statistics
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/stats` | Platform statistics |
| GET | `/api/v1/stats/domains/{domain}` | Domain overview |
| GET | `/api/v1/domains` | All domain overviews |

---

## 🔒 Authentication

The API uses **Microsoft Entra ID** JWT bearer tokens. Both Commercial and Government cloud endpoints are supported, controlled by the `IS_GOVERNMENT_CLOUD` environment variable.

> [!TIP]
> In **demo mode** (no `AZURE_TENANT_ID` set), authentication is bypassed and all endpoints return data for a synthetic demo user.

### Roles
| Role | Permissions |
|---|---|
| Reader | Read-only access to all endpoints |
| Contributor | Read + write (register sources, trigger pipelines, approve access) |
| Admin | Full access including decommission and configuration |

---

## 🔄 BFF reverse-proxy (CSA-0020 Phase 3)

When `AUTH_MODE=bff` AND `BFF_PROXY_ENABLED=true`, the shared backend
mounts a reverse-proxy at `/api/{path:path}` that:

1. Resolves the SPA's `csa_sid` cookie → server-side session.
2. Silently acquires a bearer token for the upstream API via MSAL
   (`acquire_token_silent` → `acquire_token_by_refresh_token`
   fallback).
3. Forwards the request — with `Authorization: Bearer …` injected —
   to `BFF_UPSTREAM_API_ORIGIN`.
4. Streams the response back, stripping hop-by-hop headers and any
   upstream `Set-Cookie` (cookies on the BFF origin are BFF-managed
   only).

```
  Browser (SPA)            BFF                     Upstream API
  ───────────              ───                     ─────────────
  fetch('/api/v1/x',
        {credentials:            csa_sid cookie
         'include'})     ──────────────────►
                                    │
                                    │  TokenBroker.acquire_token()
                                    │  → silent-hit OR refresh_token
                                    │  (cache via Redis, HMAC-sealed)
                                    ▼
                                 GET /api/v1/x
                                 Authorization: Bearer …
                                                   ──────────────►
                                                           │
                                                           ▼
                                                      200 JSON
                                  ◄───────────────────
                             (strip set-cookie,
                              strip hop-by-hop)
                           200 JSON
  ◄─────────────────────
```

### Feature flags

| Setting | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `spa` | Set to `bff` to enable server-side auth + cookie. |
| `BFF_PROXY_ENABLED` | `false` | Mount the reverse-proxy (requires `AUTH_MODE=bff`). |
| `BFF_UPSTREAM_API_ORIGIN` | `http://localhost:8001` | Where to forward `/api/*`. |
| `BFF_UPSTREAM_API_SCOPE` | *(required)* | MSAL scope for the upstream bearer (e.g. `api://<id>/.default`). |
| `BFF_UPSTREAM_API_TIMEOUT_SECONDS` | `30` | Per-request upstream timeout. |
| `BFF_TOKEN_CACHE_BACKEND` | `memory` | `memory` (dev) or `redis` (prod). |
| `BFF_TOKEN_CACHE_TTL_SECONDS` | `86400` | Redis EX TTL for the sealed cache. |
| `BFF_TOKEN_CACHE_HMAC_KEY` | *(required when `redis`)* | ≥ 32-char HMAC key for sealing. |

### SPA change

Replace direct-token calls with cookie-only fetches:

```ts
// Before (Phase 2 — direct handoff)
const token = await bffFetchToken('api');
const resp = await fetch('https://api.example.com/v1/sources', {
  headers: { Authorization: `Bearer ${token}` },
});

// After (Phase 3 — reverse proxy)
const resp = await fetch('/api/v1/sources', {
  credentials: 'include', // sends csa_sid cookie
});
```

See [`docs/adr/0019-bff-reverse-proxy.md`](../../docs/adr/0019-bff-reverse-proxy.md)
for the full rationale and migration plan.

---

## ⚙️ Configuration

All settings are loaded from environment variables (or a `.env` file):

| Variable | Default | Description |
|---|---|---|
| `AZURE_TENANT_ID` | *(empty)* | Microsoft Entra ID tenant ID |
| `AZURE_CLIENT_ID` | *(empty)* | App registration client ID |
| `IS_GOVERNMENT_CLOUD` | `false` | Use Azure Gov endpoints |
| `DATABASE_URL` | `sqlite:///./csainabox.db` | Metadata database connection |
| `STORAGE_ACCOUNT_NAME` | *(empty)* | Azure Storage account |
| `ADF_RESOURCE_GROUP` | *(empty)* | ADF resource group |
| `ADF_FACTORY_NAME` | *(empty)* | ADF factory name |
| `PURVIEW_ACCOUNT_NAME` | *(empty)* | Microsoft Purview account |
| `LOG_LEVEL` | `INFO` | Logging level |
| `CORS_ORIGINS` | `localhost:3000,5173,8080` | Allowed CORS origins |

---

## 📦 Docker

```bash
# Build
docker build -t csainabox-api .

# Run
docker run -p 8000:8000 \
  -e AZURE_TENANT_ID=your-tenant-id \
  -e AZURE_CLIENT_ID=your-client-id \
  csainabox-api
```

---

## 💡 Demo Mode

When no `AZURE_TENANT_ID` is configured, the API runs in demo mode:

- Authentication is bypassed (all users get Admin role)
- Endpoints return realistic seed data
- All mutations use in-memory storage (reset on restart)

This is ideal for local development and CI testing.

---

## 🔗 Related Documentation

- [Portal Implementations](../README.md) — Portal implementation index
- [Shared Backend](../shared/README.md) — Shared backend API
- [Architecture](../../docs/ARCHITECTURE.md) — Overall system architecture
