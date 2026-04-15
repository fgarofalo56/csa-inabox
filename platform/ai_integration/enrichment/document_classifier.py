"""Azure OpenAI document classification for data enrichment.

Classifies text documents into configurable taxonomy categories using
Azure OpenAI GPT-4o.  Supports batch processing with rate limiting and
confidence scoring.

Usage::

    classifier = DocumentClassifier(
        endpoint="https://<resource>.openai.azure.com",
        deployment="gpt-4o",
    )

    results = classifier.classify(["Hurricane warning issued for coastal areas."])
    print(results[0].category)  # "weather/severe_weather"
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class ClassificationResult:
    """Result of classifying a single document."""

    text_preview: str
    category: str
    subcategory: str | None = None
    confidence: float = 0.0
    reasoning: str = ""
    is_error: bool = False
    error_message: str = ""


@dataclass
class TaxonomyCategory:
    """A single category in the classification taxonomy."""

    name: str
    description: str = ""
    subcategories: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Taxonomy loading
# ---------------------------------------------------------------------------


def load_taxonomy(path: str | Path) -> list[TaxonomyCategory]:
    """Load a classification taxonomy from a YAML file.

    Expected YAML structure::

        categories:
          - name: environment
            description: Environmental and ecological topics
            subcategories: [air_quality, water_quality, wildlife]
            examples: ["AQI reading of 150 in Denver"]
          - name: infrastructure
            description: Infrastructure and transportation
            subcategories: [roads, bridges, public_transit]

    Args:
        path: Path to the taxonomy YAML file.

    Returns:
        List of :class:`TaxonomyCategory` objects.

    Raises:
        FileNotFoundError: If the taxonomy file does not exist.
        ValueError: If the YAML structure is invalid.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Taxonomy file not found: {path}")

    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict) or "categories" not in raw:
        raise ValueError("Taxonomy YAML must have a top-level 'categories' key")

    categories: list[TaxonomyCategory] = []
    for cat in raw["categories"]:
        categories.append(
            TaxonomyCategory(
                name=cat["name"],
                description=cat.get("description", ""),
                subcategories=cat.get("subcategories", []),
                examples=cat.get("examples", []),
            )
        )
    return categories


# Default taxonomy used when no YAML file is provided
_DEFAULT_TAXONOMY: list[TaxonomyCategory] = [
    TaxonomyCategory(
        name="environment",
        description="Environmental monitoring, air/water quality, climate",
        subcategories=["air_quality", "water_quality", "climate", "wildlife"],
    ),
    TaxonomyCategory(
        name="infrastructure",
        description="Roads, bridges, public transit, utilities",
        subcategories=["roads", "bridges", "public_transit", "utilities"],
    ),
    TaxonomyCategory(
        name="public_safety",
        description="Emergency management, law enforcement, fire services",
        subcategories=["emergency", "law_enforcement", "fire", "natural_disaster"],
    ),
    TaxonomyCategory(
        name="agriculture",
        description="Farming, crop yields, food safety, USDA programs",
        subcategories=["crops", "livestock", "food_safety", "subsidies"],
    ),
    TaxonomyCategory(
        name="health",
        description="Public health, epidemiology, healthcare services",
        subcategories=["epidemiology", "healthcare_access", "mental_health"],
    ),
    TaxonomyCategory(
        name="finance",
        description="Budget, spending, grants, economic indicators",
        subcategories=["budget", "grants", "economic_indicators"],
    ),
    TaxonomyCategory(
        name="other",
        description="Topics that do not fit other categories",
        subcategories=[],
    ),
]


# ---------------------------------------------------------------------------
# Document Classifier
# ---------------------------------------------------------------------------


class DocumentClassifier:
    """Classify documents into taxonomy categories using Azure OpenAI GPT-4o.

    Args:
        endpoint: Azure OpenAI endpoint URL.
        api_key: API key (leave empty for ``DefaultAzureCredential``).
        deployment: Model deployment name.
        api_version: Azure OpenAI API version.
        taxonomy: Classification taxonomy (loaded from YAML or default).
        max_retries: Number of retries for rate-limited requests.
        requests_per_minute: Rate limit (RPM) for the deployment.
    """

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        deployment: str = "gpt-4o",
        api_version: str = "2024-06-01",
        taxonomy: list[TaxonomyCategory] | None = None,
        max_retries: int = 3,
        requests_per_minute: int = 60,
    ) -> None:
        self.endpoint = endpoint or os.environ.get("AZURE_OPENAI_ENDPOINT", "")
        self.api_key = api_key or os.environ.get("AZURE_OPENAI_API_KEY", "")
        self.deployment = deployment
        self.api_version = api_version
        self.taxonomy = taxonomy or _DEFAULT_TAXONOMY
        self.max_retries = max_retries
        self.requests_per_minute = requests_per_minute
        self._client: Any = None
        self._min_interval = 60.0 / requests_per_minute
        self._last_request_time: float = 0.0

    def _get_client(self) -> Any:
        """Lazily initialise the Azure OpenAI client."""
        if self._client is None:
            from openai import AzureOpenAI

            if self.api_key:
                self._client = AzureOpenAI(
                    azure_endpoint=self.endpoint,
                    api_key=self.api_key,
                    api_version=self.api_version,
                )
            else:
                from azure.identity import DefaultAzureCredential, get_bearer_token_provider

                token_provider = get_bearer_token_provider(
                    DefaultAzureCredential(),
                    "https://cognitiveservices.azure.com/.default",
                )
                self._client = AzureOpenAI(
                    azure_endpoint=self.endpoint,
                    azure_ad_token_provider=token_provider,
                    api_version=self.api_version,
                )
        return self._client

    def _build_taxonomy_prompt(self) -> str:
        """Build the taxonomy description for the system prompt."""
        lines: list[str] = ["Available categories:\n"]
        for cat in self.taxonomy:
            subcats = ", ".join(cat.subcategories) if cat.subcategories else "none"
            lines.append(f"- **{cat.name}**: {cat.description}")
            lines.append(f"  Subcategories: {subcats}")
            if cat.examples:
                examples = "; ".join(cat.examples[:3])
                lines.append(f"  Examples: {examples}")
        return "\n".join(lines)

    def _build_system_prompt(self) -> str:
        """Build the classification system prompt."""
        taxonomy_text = self._build_taxonomy_prompt()
        return (
            "You are a document classification assistant. Classify the given text "
            "into exactly one category from the taxonomy below. Return your answer "
            "as a JSON object with these fields:\n"
            '  - "category": the top-level category name\n'
            '  - "subcategory": the subcategory name (or null if none fits)\n'
            '  - "confidence": a float between 0.0 and 1.0\n'
            '  - "reasoning": a brief explanation (1-2 sentences)\n\n'
            f"{taxonomy_text}\n\n"
            "Return ONLY valid JSON. No markdown fences, no extra text."
        )

    def _rate_limit(self) -> None:
        """Enforce rate limiting between API calls."""
        now = time.monotonic()
        elapsed = now - self._last_request_time
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_request_time = time.monotonic()

    def classify_single(self, text: str) -> ClassificationResult:
        """Classify a single text document.

        Args:
            text: The document text to classify.

        Returns:
            A :class:`ClassificationResult` with category, confidence, and reasoning.
        """
        client = self._get_client()
        system_prompt = self._build_system_prompt()
        preview = text[:200] + "..." if len(text) > 200 else text

        for attempt in range(self.max_retries):
            try:
                self._rate_limit()
                response = client.chat.completions.create(
                    model=self.deployment,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"Classify this text:\n\n{text}"},
                    ],
                    max_tokens=256,
                    temperature=0.0,
                    response_format={"type": "json_object"},
                )
                raw_content = response.choices[0].message.content or "{}"
                parsed = json.loads(raw_content)
                return ClassificationResult(
                    text_preview=preview,
                    category=parsed.get("category", "other"),
                    subcategory=parsed.get("subcategory"),
                    confidence=float(parsed.get("confidence", 0.0)),
                    reasoning=parsed.get("reasoning", ""),
                )
            except json.JSONDecodeError as exc:
                logger.warning("Failed to parse classification JSON (attempt %d): %s", attempt + 1, exc)
                if attempt == self.max_retries - 1:
                    return ClassificationResult(
                        text_preview=preview,
                        category="other",
                        is_error=True,
                        error_message=f"JSON parse error: {exc}",
                    )
            except Exception as exc:
                logger.warning("Classification API error (attempt %d): %s", attempt + 1, exc)
                if attempt == self.max_retries - 1:
                    return ClassificationResult(
                        text_preview=preview,
                        category="other",
                        is_error=True,
                        error_message=str(exc),
                    )
                time.sleep(2**attempt)

        # Should not reach here, but satisfy type checker
        return ClassificationResult(
            text_preview=preview, category="other", is_error=True, error_message="Exhausted retries"
        )

    def classify(self, texts: list[str]) -> list[ClassificationResult]:
        """Classify a batch of texts with rate limiting.

        Args:
            texts: List of document texts to classify.

        Returns:
            List of :class:`ClassificationResult`, one per input text.
        """
        results: list[ClassificationResult] = []
        for idx, text in enumerate(texts):
            logger.info("Classifying document %d of %d", idx + 1, len(texts))
            result = self.classify_single(text)
            results.append(result)
        return results

    def classify_records(
        self,
        records: Sequence[dict[str, Any]],
        text_field: str = "text",
    ) -> list[dict[str, Any]]:
        """Classify structured data records and return enriched copies.

        Args:
            records: List of dictionaries with text to classify.
            text_field: Key containing the text to classify.

        Returns:
            Enriched records with ``classification`` field added.
        """
        texts = [str(r.get(text_field, "")) for r in records]
        results = self.classify(texts)

        enriched: list[dict[str, Any]] = []
        for record, result in zip(records, results, strict=True):
            enriched_record = {**record}
            enriched_record["classification"] = {
                "category": result.category,
                "subcategory": result.subcategory,
                "confidence": result.confidence,
                "reasoning": result.reasoning,
            }
            if result.is_error:
                enriched_record["classification_error"] = result.error_message
            enriched.append(enriched_record)

        return enriched

    def load_taxonomy_from_file(self, path: str | Path) -> None:
        """Load (or reload) the taxonomy from a YAML file.

        Args:
            path: Path to the taxonomy YAML file.
        """
        self.taxonomy = load_taxonomy(path)
        logger.info("Loaded taxonomy with %d categories from %s", len(self.taxonomy), path)
