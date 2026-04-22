"""Azure Function: CSA-in-a-Box Copilot Chat Backend.

POST /api/chat — accepts ``{message, history[], pageContext}`` and returns
``{reply}`` from Azure OpenAI with full codebase context.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict

import azure.functions as func
from openai import AzureOpenAI

app = func.FunctionApp()
logger = logging.getLogger(__name__)

# ── Rate Limiting ──────────────────────────────────────────────────────────

_rate_store: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT = 20  # requests
_RATE_WINDOW = 60  # seconds


def _check_rate_limit(ip: str) -> bool:
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    window = _rate_store[ip]
    # Purge old entries
    _rate_store[ip] = [t for t in window if now - t < _RATE_WINDOW]
    if len(_rate_store[ip]) >= _RATE_LIMIT:
        return False
    _rate_store[ip].append(now)
    return True


# ── CORS ───────────────────────────────────────────────────────────────────

def _cors_headers() -> dict[str, str]:
    allowed = os.environ.get(
        "ALLOWED_ORIGINS",
        "https://fgarofalo56.github.io,http://localhost:8000",
    )
    return {
        "Access-Control-Allow-Origin": allowed.split(",")[0].strip(),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    }


# ── System Prompt ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are the **CSA-in-a-Box Copilot**, an expert AI assistant for the \
CSA-in-a-Box open-source repository — an Azure-native reference \
implementation of Microsoft's "Unify your data platform" guidance.

## What CSA-in-a-Box Is

An Azure PaaS reference architecture delivering production-grade Data Mesh, \
Data Fabric, and Data Lakehouse capabilities.  Designed for Azure Government \
(where Microsoft Fabric is not yet GA) and as an incremental Fabric on-ramp.

## Repository Structure

```
csa-inabox/
├── deploy/bicep/           # Bicep IaC — ALZ, DLZ, DMLZ, Gov landing zones
│   ├── DLZ/                # Data Landing Zone (ADLS, ADF, Databricks, Key Vault)
│   ├── DMLZ/               # Data Management Zone (Purview, Synapse, WebApp)
│   └── gov/                # Governance zone (policy, compliance)
├── csa_platform/           # Python platform modules
│   ├── ai_integration/     # Azure OpenAI enrichment (classifier, summarizer)
│   ├── data_activator/     # Event-driven data activation & dead-letter
│   ├── data_marketplace/   # (deprecated → portal models)
│   ├── governance/         # Data quality (Great Expectations), policy, lineage
│   ├── metadata_framework/ # Pipeline generator, schema detection, dbt integration
│   ├── functions/          # Azure Functions (AI enrichment, event processing, secret rotation)
│   └── streaming/          # Event Hubs + Spark streaming
├── portal/                 # Self-service data portal
│   ├── shared/api/         # FastAPI backend (routers, models, persistence)
│   ├── react-webapp/       # Next.js + React frontend
│   └── kubernetes/         # Helm chart, Docker, K8s manifests
├── domains/                # dbt domain models (sales, finance, inventory, shared)
├── apps/copilot/           # AI Copilot app (RAG, evals, prompts, skills)
├── docs/                   # Architecture, ADRs, compliance, runbooks, migrations
├── examples/               # 10+ vertical implementations (USDA, NOAA, EPA, etc.)
├── tests/                  # Unit + integration tests
└── scripts/                # Deployment, seeding, CI helpers
```

## Key Technologies

- **IaC:** Bicep (landing zones), GitHub Actions CI/CD
- **Compute:** Azure Databricks (Spark), Azure Synapse Analytics
- **Storage:** ADLS Gen2, Delta Lake (Bronze/Silver/Gold medallion)
- **Orchestration:** Azure Data Factory, dbt Core
- **Governance:** Microsoft Purview, Unity Catalog pattern
- **Streaming:** Azure Event Hubs, Azure Data Explorer
- **AI:** Azure OpenAI (GPT-4o), Cognitive Services
- **Portal:** FastAPI (Python), Next.js + React (TypeScript)
- **Testing:** pytest, Jest, Great Expectations

## Key Files

- `deploy/bicep/DLZ/main.bicep` — Data Landing Zone deployment
- `portal/shared/api/main.py` — FastAPI app entrypoint
- `portal/shared/api/routers/` — API routers (sources, pipelines, marketplace, access, stats)
- `portal/shared/api/models/` — Pydantic data models
- `portal/react-webapp/src/pages/` — React pages
- `domains/shared/dbt/` — Shared dbt models and macros
- `csa_platform/metadata_framework/generator/` — Pipeline generator
- `docs/ARCHITECTURE.md` — Full architecture document
- `docs/adr/` — 20 Architecture Decision Records
- `mkdocs.yml` — Documentation site configuration

## Conventions

- Python: Pydantic models, FastAPI Depends() for DI, structlog logging
- TypeScript: React functional components, React Query for data fetching
- IaC: Bicep modules with parameter files, Checkov scanning
- Testing: pytest (backend), Jest (frontend), dbt test (transformations)
- Auth: MSAL + BFF pattern, Azure AD / Entra ID

## Documentation Pages

The site has these main documentation pages (use these paths when referencing docs):

- `QUICKSTART` — Quick-start guide
- `GETTING_STARTED` — Full getting started walkthrough
- `ARCHITECTURE` — Architecture overview
- `PLATFORM_SERVICES` — Platform services reference
- `MULTI_REGION` / `MULTI_TENANT` — Multi-region & multi-tenant patterns
- `DR` — Disaster recovery
- `ADF_SETUP` — Azure Data Factory setup
- `DATABRICKS_GUIDE` — Databricks guide
- `SELF_HOSTED_IR` — Self-hosted integration runtime
- `IaC-CICD-Best-Practices` — IaC & CI/CD best practices
- `COST_MANAGEMENT` — Cost management / FinOps
- `PRODUCTION_CHECKLIST` — Pre-production checklist
- `ROLLBACK` — Rollback procedures
- `TROUBLESHOOTING` — Common issues & fixes
- `adr/` — 20 Architecture Decision Records (ADR-001 through ADR-020)
- `compliance/` — NIST, CMMC, HIPAA mappings
- `runbooks/` — Operational runbooks (security-incident, key-rotation, dr-drill, etc.)
- `migrations/` — Migration guides (iot-hub-entra, etc.)
- `tutorials/great-expectations` — Great Expectations tutorial

## Instructions

1. Always cite specific file paths when referencing code.
2. **When referencing documentation, mention the page path** (e.g., "See the Architecture page" or "Check the TROUBLESHOOTING page"). The chat widget will automatically find and display clickable links to matching pages.
3. If asked about architecture decisions, reference the ADRs in `adr/`.
4. For deployment questions, reference the Bicep files and `GETTING_STARTED`.
5. For troubleshooting, check `TROUBLESHOOTING` first.
6. Be concise but thorough. Use code blocks for commands and file paths.
7. If you don't know the answer, say so — don't guess.
"""


CONFIG_MAX_HISTORY = 20


# ── Chat Endpoint ──────────────────────────────────────────────────────────


@app.route(route="chat", methods=["POST", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def chat(req: func.HttpRequest) -> func.HttpResponse:
    """Handle chat requests from the Copilot widget."""
    headers = _cors_headers()

    # Preflight
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=headers)

    # Rate limit
    ip = req.headers.get("X-Forwarded-For", req.headers.get("X-Real-IP", "unknown"))
    ip = ip.split(",")[0].strip()
    if not _check_rate_limit(ip):
        return func.HttpResponse(
            json.dumps({"error": "Rate limit exceeded. Please wait a moment."}),
            status_code=429,
            mimetype="application/json",
            headers=headers,
        )

    # Parse body
    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON body."}),
            status_code=400,
            mimetype="application/json",
            headers=headers,
        )

    message = (body.get("message") or "").strip()
    if not message:
        return func.HttpResponse(
            json.dumps({"error": "Message is required."}),
            status_code=400,
            mimetype="application/json",
            headers=headers,
        )

    conv_history = body.get("history", [])
    page_context = body.get("pageContext", {})

    # Build messages
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    if page_context:
        ctx_note = (
            f"The user is currently viewing: {page_context.get('title', 'Unknown page')} "
            f"({page_context.get('url', '')})"
        )
        messages.append({"role": "system", "content": ctx_note})

    # Add conversation history (truncated)
    for turn in conv_history[-CONFIG_MAX_HISTORY * 2 :]:
        role = turn.get("role", "user")
        content = turn.get("content", "")[:2000]
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": message})

    # Call Azure OpenAI
    try:
        client = AzureOpenAI(
            azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
            api_key=os.environ["AZURE_OPENAI_KEY"],
            api_version="2025-04-01-preview",
        )

        response = client.chat.completions.create(
            model=os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini"),
            messages=messages,
            temperature=0.3,
            max_completion_tokens=2000,
            stream=True,
        )

        # Collect streamed chunks (Azure Functions v2 doesn't support true streaming)
        reply_parts = []
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                reply_parts.append(chunk.choices[0].delta.content)

        reply = "".join(reply_parts)

        return func.HttpResponse(
            json.dumps({"reply": reply}),
            status_code=200,
            mimetype="application/json",
            headers=headers,
        )

    except KeyError as e:
        logger.error("Missing environment variable: %s", e)
        return func.HttpResponse(
            json.dumps(
                {
                    "error": f"Server configuration error: missing {e}. "
                    "Ensure AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, and "
                    "AZURE_OPENAI_DEPLOYMENT are set."
                }
            ),
            status_code=500,
            mimetype="application/json",
            headers=headers,
        )
    except Exception as e:
        logger.exception("Azure OpenAI call failed")
        return func.HttpResponse(
            json.dumps({"error": f"AI service error: {e!s}"}),
            status_code=500,
            mimetype="application/json",
            headers=headers,
        )


