"""Azure AI Language named entity extraction for data enrichment.

Extracts named entities (person, location, organisation, date, etc.) from
text fields using the Azure AI Language NER service.  Designed to plug into
CSA-in-a-Box data pipelines — reads from Bronze and writes enriched results
to Silver.

Usage::

    extractor = EntityExtractor(
        endpoint="https://<resource>.cognitiveservices.azure.com",
        api_key="...",
    )
    results = extractor.extract_entities(["Microsoft was founded in Redmond."])
    print(results[0].entities)
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from azure.ai.textanalytics import TextAnalyticsClient
    from azure.core.credentials import AzureKeyCredential
    from azure.identity import DefaultAzureCredential

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="entity-extractor")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class Entity:
    """A single extracted entity."""

    text: str
    category: str
    subcategory: str | None = None
    confidence_score: float = 0.0
    offset: int = 0
    length: int = 0


@dataclass
class ExtractionResult:
    """Extraction result for a single text record."""

    text: str
    entities: list[Entity] = field(default_factory=list)
    is_error: bool = False
    error_message: str = ""


# ---------------------------------------------------------------------------
# Entity Extractor
# ---------------------------------------------------------------------------


class EntityExtractor:
    """Extract named entities from text using Azure AI Language NER.

    Supports batch processing and integrates with the CSA-in-a-Box
    medallion architecture (Bronze -> Silver enrichment).

    Args:
        endpoint: Azure AI Language endpoint URL.
        api_key: API key.  Leave empty to use ``DefaultAzureCredential``.
        language: Default language hint for NER (ISO 639-1 code).
        batch_size: Maximum documents per API call (service limit is 25).
    """

    _MAX_BATCH = 25  # Azure AI Language batch limit

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        language: str = "en",
        batch_size: int = 25,
    ) -> None:
        self.endpoint = endpoint or os.environ.get("AZURE_LANGUAGE_ENDPOINT", "")
        self.api_key = api_key or os.environ.get("AZURE_LANGUAGE_API_KEY", "")
        self.language = language
        self.batch_size = min(batch_size, self._MAX_BATCH)
        self._client: TextAnalyticsClient | None = None

    def _get_client(self) -> TextAnalyticsClient:
        """Lazily initialise the Azure AI Language text analytics client."""
        if self._client is None:
            from azure.ai.textanalytics import TextAnalyticsClient

            credential: AzureKeyCredential | DefaultAzureCredential
            if self.api_key:
                from azure.core.credentials import AzureKeyCredential

                credential = AzureKeyCredential(self.api_key)
            else:
                from azure.identity import DefaultAzureCredential

                credential = DefaultAzureCredential()

            self._client = TextAnalyticsClient(
                endpoint=self.endpoint,
                credential=credential,
            )
        return self._client

    # -- Core extraction ----------------------------------------------------

    def extract_entities(self, texts: list[str]) -> list[ExtractionResult]:
        """Extract named entities from a list of texts.

        Automatically batches requests to respect the API batch limit.

        Args:
            texts: List of text strings to analyse.

        Returns:
            List of :class:`ExtractionResult`, one per input text.
        """
        all_results: list[ExtractionResult] = []
        client = self._get_client()

        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            # Map document IDs back to original text so ExtractionResult
            # preserves the input text rather than the Azure SDK doc ID.
            original_texts: dict[str, str] = {str(idx): text for idx, text in enumerate(batch)}
            logger.info("ner_batch.processing", batch_start=i, batch_end=i + len(batch), total=len(texts))

            try:
                response = client.recognize_entities(
                    documents=batch,
                    language=self.language,
                )
            except Exception:
                logger.exception("ner_batch.failed", batch_start=i)
                all_results.extend(
                    ExtractionResult(text=t, is_error=True, error_message="API call failed") for t in batch
                )
                continue

            for doc_result in response:
                if doc_result.is_error:
                    all_results.append(
                        ExtractionResult(
                            text=original_texts.get(doc_result.id, ""),
                            is_error=True,
                            error_message=f"{doc_result.error.code}: {doc_result.error.message}",
                        )
                    )
                else:
                    entities = [
                        Entity(
                            text=ent.text,
                            category=ent.category,
                            subcategory=ent.subcategory,
                            confidence_score=ent.confidence_score,
                            offset=ent.offset,
                            length=ent.length,
                        )
                        for ent in doc_result.entities
                    ]
                    all_results.append(ExtractionResult(text=original_texts.get(doc_result.id, doc_result.id), entities=entities))

        return all_results

    def extract_entities_from_records(
        self,
        records: Sequence[dict[str, Any]],
        text_field: str = "text",
        id_field: str = "id",  # noqa: ARG002 (part of public API)
    ) -> list[dict[str, Any]]:
        """Extract entities from structured data records.

        Designed for pipeline integration: accepts a list of dictionaries
        (e.g. rows from a DataFrame) and returns enriched copies with an
        ``extracted_entities`` field.

        Args:
            records: List of dictionaries containing text to analyse.
            text_field: Key within each record that contains the text.
            id_field: Key for the record identifier.

        Returns:
            List of enriched records with ``extracted_entities`` added.
        """
        texts = [str(r.get(text_field, "")) for r in records]
        extraction_results = self.extract_entities(texts)

        enriched: list[dict[str, Any]] = []
        for record, result in zip(records, extraction_results, strict=True):
            enriched_record = {**record}
            if result.is_error:
                enriched_record["extracted_entities"] = []
                enriched_record["entity_extraction_error"] = result.error_message
            else:
                enriched_record["extracted_entities"] = [
                    {
                        "text": e.text,
                        "category": e.category,
                        "subcategory": e.subcategory,
                        "confidence_score": e.confidence_score,
                        "offset": e.offset,
                        "length": e.length,
                    }
                    for e in result.entities
                ]
            enriched.append(enriched_record)

        return enriched

    # -- Pipeline integration (Bronze -> Silver) ----------------------------

    def enrich_bronze_to_silver(
        self,
        bronze_path: str,
        silver_path: str,
        text_field: str = "text",
        id_field: str = "id",
    ) -> dict[str, int]:
        """Read records from Bronze storage, extract entities, write to Silver.

        Reads JSON-lines from *bronze_path*, enriches with NER, and writes
        enriched records to *silver_path*.

        Args:
            bronze_path: Path to the Bronze-layer input file (JSONL format).
            silver_path: Path to the Silver-layer output file (JSONL format).
            text_field: Key for the text field in each record.
            id_field: Key for the record identifier.

        Returns:
            Dictionary with ``total``, ``enriched``, and ``errors`` counts.
        """
        from pathlib import Path

        input_path = Path(bronze_path)
        output_path = Path(silver_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        records: list[dict[str, Any]] = []
        with open(input_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))

        if not records:
            logger.warning("no_records_found", path=bronze_path)
            return {"total": 0, "enriched": 0, "errors": 0}

        enriched_records = self.extract_entities_from_records(records, text_field=text_field, id_field=id_field)

        error_count = sum(1 for r in enriched_records if r.get("entity_extraction_error"))

        with open(output_path, "w", encoding="utf-8") as f:
            for record in enriched_records:
                f.write(json.dumps(record, default=str) + "\n")

        stats = {
            "total": len(records),
            "enriched": len(enriched_records) - error_count,
            "errors": error_count,
        }
        logger.info(
            "bronze_to_silver.complete",
            total=stats["total"],
            enriched=stats["enriched"],
            errors=stats["errors"],
        )
        return stats
