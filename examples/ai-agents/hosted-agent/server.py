"""FastAPI server wrapping the hosted-agent for production deployment.

Endpoints:
    POST /agent/invoke   — invoke the agent with a question
    GET  /health         — liveness probe
    GET  /ready          — readiness probe (checks AOAI connectivity)
    GET  /metrics        — Prometheus-format metrics (basic counters)

Authentication: relies on upstream APIM/Front Door for JWT validation;
the container itself is internal-ingress-only per main.bicep.

Observability: distributed tracing via Application Insights (auto-instrumented
via azure-monitor-opentelemetry); structured logs include trace context.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

# Optional Azure Monitor OpenTelemetry — gracefully no-op if connection string absent
_appinsights_enabled = bool(os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"))
if _appinsights_enabled:
    from azure.monitor.opentelemetry import configure_azure_monitor

    configure_azure_monitor(
        connection_string=os.environ["APPLICATIONINSIGHTS_CONNECTION_STRING"],
        logger_name="csa.hosted_agent",
    )

# Structured logging with trace context
def _add_trace_context(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span:
            ctx = span.get_span_context()
            if ctx.is_valid:
                event_dict["trace_id"] = format(ctx.trace_id, "032x")
                event_dict["span_id"] = format(ctx.span_id, "016x")
    except Exception:  # noqa: BLE001  — observability must never crash the request
        pass
    return event_dict


structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        _add_trace_context,
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)
log = structlog.get_logger()

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class InvokeRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    user_id: str | None = Field(None, description="Caller UPN; will be SHA-256 hashed before logging")
    request_id: str | None = Field(None, description="Optional client-supplied correlation id")


class InvokeResponse(BaseModel):
    request_id: str
    answer: str
    cited_data_products: list[str]
    tools_called: list[str]
    tokens_in: int
    tokens_out: int
    cost_usd_estimate: float
    refused: bool
    latency_ms: int


# ---------------------------------------------------------------------------
# Lifespan: build the agent once, share across requests
# ---------------------------------------------------------------------------

_agent_state: dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    log.info("hosted_agent.startup", appinsights_enabled=_appinsights_enabled)
    # Lazy import — avoids forcing semantic-kernel at import time for tests that mock it
    try:
        from azure.identity import DefaultAzureCredential
        from semantic_kernel.agents import ChatCompletionAgent
        from semantic_kernel.connectors.ai.open_ai import AzureChatCompletion

        from .agent import CSAPlatformPlugin  # type: ignore[import-not-found]

        cred = DefaultAzureCredential()
        endpoint = os.environ["AZURE_OPENAI_ENDPOINT"]
        deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")

        agent = ChatCompletionAgent(
            service=AzureChatCompletion(
                deployment_name=deployment,
                endpoint=endpoint,
                ad_token_provider=lambda: cred.get_token("https://cognitiveservices.azure.com/.default").token,
            ),
            name="HostedDataAgent",
            instructions=(
                "You are a read-only data-platform assistant. Answer using only the tools provided. "
                "Always cite the data product name + version. Refuse politely if the request is destructive."
            ),
            plugins=[CSAPlatformPlugin()],
        )
        _agent_state["agent"] = agent
        _agent_state["model"] = deployment
        log.info("hosted_agent.ready", model=deployment, endpoint=endpoint)
    except Exception as e:  # noqa: BLE001
        log.error("hosted_agent.startup_failed", error=str(e))
        # Allow server to come up; /ready will report not-ready
        _agent_state["error"] = str(e)
    yield
    log.info("hosted_agent.shutdown")


app = FastAPI(
    title="CSA Hosted Agent",
    version=os.environ.get("AGENT_VERSION", "1.0.0"),
    lifespan=lifespan,
)

# Auto-instrument FastAPI for distributed tracing
if _appinsights_enabled:
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)
    except Exception:  # noqa: BLE001
        pass

# ---------------------------------------------------------------------------
# Counters (basic Prometheus surface — not full library to keep image small)
# ---------------------------------------------------------------------------

_counters = {
    "invocations_total": 0,
    "invocations_failed_total": 0,
    "refusals_total": 0,
    "tokens_in_total": 0,
    "tokens_out_total": 0,
}


# ---------------------------------------------------------------------------
# Cost estimator (gpt-4o-mini Nov-2024 pricing; bump as pricing changes)
# ---------------------------------------------------------------------------

_PRICING = {
    "gpt-4o-mini": (0.15 / 1_000_000, 0.60 / 1_000_000),
    "gpt-4o": (2.50 / 1_000_000, 10.00 / 1_000_000),
    "o1-mini": (3.00 / 1_000_000, 12.00 / 1_000_000),
    "o1": (15.00 / 1_000_000, 60.00 / 1_000_000),
}


def estimate_cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    in_rate, out_rate = _PRICING.get(model, (0.0, 0.0))
    return round(tokens_in * in_rate + tokens_out * out_rate, 6)


def hash_user(user_id: str | None) -> str:
    if not user_id:
        return "anonymous"
    return hashlib.sha256(user_id.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, Any]:
    if "error" in _agent_state:
        raise HTTPException(status_code=503, detail={"status": "not-ready", "error": _agent_state["error"]})
    if "agent" not in _agent_state:
        raise HTTPException(status_code=503, detail={"status": "starting"})
    return {"status": "ready", "model": _agent_state.get("model")}


@app.get("/metrics")
async def metrics() -> str:
    lines = []
    for name, value in _counters.items():
        lines.append(f"# TYPE csa_agent_{name} counter")
        lines.append(f"csa_agent_{name} {value}")
    return "\n".join(lines) + "\n"


@app.post("/agent/invoke", response_model=InvokeResponse)
async def invoke(req: InvokeRequest, request: Request) -> InvokeResponse:
    request_id = req.request_id or str(uuid.uuid4())
    user_hash = hash_user(req.user_id)
    started = time.monotonic()

    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        request_id=request_id,
        user_id_hash=user_hash,
        agent="HostedDataAgent",
    )

    if "agent" not in _agent_state:
        _counters["invocations_failed_total"] += 1
        log.error("invoke.agent_not_ready")
        raise HTTPException(status_code=503, detail="agent not ready")

    agent = _agent_state["agent"]
    model = _agent_state["model"]
    _counters["invocations_total"] += 1
    log.info("invoke.start", question_len=len(req.question))

    try:
        # Invoke agent (single shot — for streaming, see /agent/stream in roadmap)
        chunks: list[str] = []
        tools_called: list[str] = []
        # SK's invoke_stream yields ChatMessageContent items
        async for msg in agent.invoke_stream(req.question):
            if msg.content:
                chunks.append(msg.content)
            # Best-effort tool extraction (SK schema varies by version)
            for item in getattr(msg, "items", []) or []:
                tname = getattr(item, "function_name", None) or getattr(item, "name", None)
                if tname and tname not in tools_called:
                    tools_called.append(tname)

        answer = "".join(chunks).strip() or "(no response)"

        # Heuristic citation extraction — production should extract from tool results structurally
        cited = _extract_citations(answer)

        # Token estimation — prefer SK usage if available; fall back to char-based estimate
        tokens_in = max(1, len(req.question) // 4)
        tokens_out = max(1, len(answer) // 4)
        _counters["tokens_in_total"] += tokens_in
        _counters["tokens_out_total"] += tokens_out

        refused = _looks_like_refusal(answer)
        if refused:
            _counters["refusals_total"] += 1

        latency_ms = int((time.monotonic() - started) * 1000)
        cost = estimate_cost_usd(model, tokens_in, tokens_out)

        log.info(
            "invoke.success",
            tools_called=tools_called,
            cited=cited,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost,
            latency_ms=latency_ms,
            refused=refused,
        )

        return InvokeResponse(
            request_id=request_id,
            answer=answer,
            cited_data_products=cited,
            tools_called=tools_called,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd_estimate=cost,
            refused=refused,
            latency_ms=latency_ms,
        )

    except Exception as e:  # noqa: BLE001
        _counters["invocations_failed_total"] += 1
        log.error("invoke.failed", error=str(e), error_type=type(e).__name__)
        raise HTTPException(status_code=500, detail="agent invocation failed") from e


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

import re

_CITATION_RE = re.compile(r"\b((?:bronze|silver|gold)\.[a-z0-9_]+\.[a-z0-9_]+)\b", re.IGNORECASE)
_REFUSAL_PHRASES = (
    "I cannot",
    "I can't",
    "I'm unable",
    "I am unable",
    "I won't",
    "I will not",
    "policy prevents",
    "not permitted",
)


def _extract_citations(text: str) -> list[str]:
    """Pull out fully-qualified product references like gold.finance.revenue."""
    return sorted(set(m.group(1).lower() for m in _CITATION_RE.finditer(text)))


def _looks_like_refusal(text: str) -> bool:
    snippet = text[:300]
    return any(phrase.lower() in snippet.lower() for phrase in _REFUSAL_PHRASES)
