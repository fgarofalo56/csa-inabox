"""Locust load test for the AI Enrichment Function HTTP trigger.

Run:
    locust -f tests/load/locustfile_ai_enrichment.py \
        --host=https://<function-app>.azurewebsites.net \
        --users=50 --spawn-rate=5 --run-time=2m --headless \
        --csv=reports/locust-ai-enrichment

Environment variables:
    FUNCTION_KEY: Function-level key (``x-functions-key`` header).

See tests/load/README.md for acceptance targets and how to plug these
runs into the release process.
"""

from __future__ import annotations

import os
import random
from typing import Any

from locust import HttpUser, between, events, task

SAMPLE_TEXTS: tuple[str, ...] = (
    "The quick brown fox jumps over the lazy dog. "
    "This is a short sample for language and sentiment detection.",
    "Customer reported a positive experience with the new onboarding flow, "
    "completing signup in under two minutes with no support tickets raised.",
    "Invoice INV-2026-04-123 for $4,780.42 was processed on 2026-04-10 "
    "against account ACCT-7788 for customer Jane Doe.",
    "Le service client a été exceptionnel. Je recommande cette entreprise "
    "à tous mes amis et collègues pour leurs besoins d'analyse.",
)


class AIEnrichmentUser(HttpUser):
    """Virtual user exercising the AI enrichment HTTP trigger."""

    # Represents a realistic user-interaction rhythm: 1-3 seconds between
    # requests. Raise ``--users`` to simulate concurrent load.
    wait_time = between(1, 3)

    function_key: str | None = None

    def on_start(self) -> None:
        """Pull the function key from the env on startup, fail fast if missing."""
        self.function_key = os.environ.get("FUNCTION_KEY")
        if not self.function_key:
            raise RuntimeError(
                "FUNCTION_KEY environment variable is required — set it to "
                "the aiEnrichment Function app's function-level key.",
            )

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-functions-key": self.function_key or "",
        }

    @task(10)
    def enrich_text(self) -> None:
        """POST /api/enrich with a random sample paragraph."""
        payload: dict[str, Any] = {"text": random.choice(SAMPLE_TEXTS)}
        with self.client.post(
            "/api/enrich",
            json=payload,
            headers=self._headers(),
            name="POST /api/enrich",
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(
                    f"unexpected status {response.status_code}: {response.text[:200]}",
                )
                return
            body = response.json()
            if "error" in body:
                response.failure(f"enrichment returned error: {body['error']}")

    @task(1)
    def health_probe(self) -> None:
        """GET /api/health — every tenth request."""
        self.client.get("/api/health", name="GET /api/health")


@events.test_stop.add_listener
def _summarise(environment: Any, **_kwargs: Any) -> None:
    """Emit a one-line pass/fail summary based on the targets in README.md."""
    stats = environment.stats.total
    p95 = stats.get_response_time_percentile(0.95)
    failure_rate = stats.fail_ratio
    ok = p95 < 1500 and failure_rate < 0.01
    verdict = "PASS" if ok else "FAIL"
    print(
        f"[{verdict}] requests={stats.num_requests} "
        f"p50={stats.get_response_time_percentile(0.5):.0f}ms "
        f"p95={p95:.0f}ms "
        f"failure_rate={failure_rate:.3%}",
    )
