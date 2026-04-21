"""Tests for the AI enrichment modules.

Covers all three enrichment components — DocumentClassifier, EntityExtractor,
and TextSummarizer — using mocked Azure SDK clients so no live service is
required.  Follows the patterns established in test_rag_pipeline.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
import yaml

from csa_platform.ai_integration.enrichment.document_classifier import (
    ClassificationResult,
    DocumentClassifier,
    TaxonomyCategory,
    load_taxonomy,
)
from csa_platform.ai_integration.enrichment.entity_extractor import (
    Entity,
    EntityExtractor,
    ExtractionResult,
)
from csa_platform.ai_integration.enrichment.text_summarizer import (
    SummarizationMode,
    SummarizationResult,
    SummarizationStyle,
    TextSummarizer,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_openai_response(content: str) -> MagicMock:
    """Build a minimal mock that mimics openai.types.chat.ChatCompletion."""
    mock_choice = MagicMock()
    mock_choice.message.content = content
    mock_response = MagicMock()
    mock_response.choices = [mock_choice]
    return mock_response


def _make_ner_doc(doc_id: str, entities: list[MagicMock], *, is_error: bool = False) -> MagicMock:
    """Build a mock Azure AI Language NER document result."""
    doc = MagicMock()
    doc.id = doc_id
    doc.is_error = is_error
    if is_error:
        doc.error = MagicMock()
        doc.error.code = "InvalidRequest"
        doc.error.message = "The document is too long."
    else:
        doc.entities = entities
    return doc


def _make_ner_entity(
    text: str,
    category: str,
    subcategory: str | None = None,
    confidence: float = 0.95,
    offset: int = 0,
    length: int | None = None,
) -> MagicMock:
    entity = MagicMock()
    entity.text = text
    entity.category = category
    entity.subcategory = subcategory
    entity.confidence_score = confidence
    entity.offset = offset
    entity.length = length if length is not None else len(text)
    return entity


# ---------------------------------------------------------------------------
# load_taxonomy
# ---------------------------------------------------------------------------


class TestLoadTaxonomy:
    """Tests for the standalone load_taxonomy() function."""

    def test_load_valid_taxonomy(self, tmp_path: Path) -> None:
        yaml_content = {
            "categories": [
                {
                    "name": "transport",
                    "description": "Road and rail",
                    "subcategories": ["road", "rail"],
                    "examples": ["Bridge closure", "Train delay"],
                },
                {
                    "name": "health",
                    "description": "Public health",
                    "subcategories": [],
                },
            ]
        }
        taxonomy_file = tmp_path / "taxonomy.yaml"
        taxonomy_file.write_text(yaml.dump(yaml_content), encoding="utf-8")

        categories = load_taxonomy(taxonomy_file)

        assert len(categories) == 2
        assert categories[0].name == "transport"
        assert categories[0].description == "Road and rail"
        assert categories[0].subcategories == ["road", "rail"]
        assert categories[0].examples == ["Bridge closure", "Train delay"]
        assert categories[1].name == "health"
        assert categories[1].subcategories == []

    def test_load_taxonomy_missing_file_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="Taxonomy file not found"):
            load_taxonomy(tmp_path / "does_not_exist.yaml")

    def test_load_taxonomy_missing_categories_key_raises(self, tmp_path: Path) -> None:
        bad_yaml = tmp_path / "bad.yaml"
        bad_yaml.write_text("version: 1\n", encoding="utf-8")
        with pytest.raises(ValueError, match="'categories' key"):
            load_taxonomy(bad_yaml)

    def test_load_taxonomy_no_subcategories_or_examples(self, tmp_path: Path) -> None:
        minimal = {"categories": [{"name": "other"}]}
        f = tmp_path / "min.yaml"
        f.write_text(yaml.dump(minimal), encoding="utf-8")
        categories = load_taxonomy(f)
        assert categories[0].subcategories == []
        assert categories[0].examples == []


# ---------------------------------------------------------------------------
# DocumentClassifier
# ---------------------------------------------------------------------------


class TestDocumentClassifierInit:
    """Constructor and environment variable fallback tests."""

    def test_defaults_read_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://env-endpoint.openai.azure.com")
        monkeypatch.setenv("AZURE_OPENAI_API_KEY", "env-key")
        classifier = DocumentClassifier()
        assert classifier.endpoint == "https://env-endpoint.openai.azure.com"
        assert classifier.api_key == "env-key"

    def test_explicit_args_take_priority_over_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://env.openai.azure.com")
        classifier = DocumentClassifier(endpoint="https://explicit.openai.azure.com", api_key="k")
        assert classifier.endpoint == "https://explicit.openai.azure.com"

    def test_custom_taxonomy_injected(self) -> None:
        tax = [TaxonomyCategory(name="custom")]
        c = DocumentClassifier(taxonomy=tax)
        assert c.taxonomy == tax

    def test_default_taxonomy_used_when_none_provided(self) -> None:
        c = DocumentClassifier()
        assert len(c.taxonomy) > 0
        names = {cat.name for cat in c.taxonomy}
        assert "environment" in names
        assert "other" in names

    def test_min_interval_derived_from_rpm(self) -> None:
        c = DocumentClassifier(requests_per_minute=30)
        assert c._min_interval == pytest.approx(2.0)


class TestDocumentClassifierPrompts:
    """Prompt-building logic — no network calls involved."""

    @pytest.fixture
    def classifier(self) -> DocumentClassifier:
        return DocumentClassifier(endpoint="https://t.openai.azure.com", api_key="k")

    def test_taxonomy_prompt_contains_all_category_names(self, classifier: DocumentClassifier) -> None:
        prompt = classifier._build_taxonomy_prompt()
        for cat in classifier.taxonomy:
            assert cat.name in prompt

    def test_taxonomy_prompt_includes_subcategories(self, classifier: DocumentClassifier) -> None:
        prompt = classifier._build_taxonomy_prompt()
        assert "air_quality" in prompt

    def test_taxonomy_prompt_includes_examples_up_to_three(self) -> None:
        tax = [
            TaxonomyCategory(
                name="demo",
                description="Demo",
                examples=["ex1", "ex2", "ex3", "ex4", "ex5"],
            )
        ]
        c = DocumentClassifier(taxonomy=tax)
        prompt = c._build_taxonomy_prompt()
        # At most 3 examples should appear (the method slices [:3])
        assert prompt.count("ex") == 3

    def test_system_prompt_contains_json_instructions(self, classifier: DocumentClassifier) -> None:
        prompt = classifier._build_system_prompt()
        assert '"category"' in prompt
        assert '"confidence"' in prompt
        assert "JSON" in prompt

    def test_taxonomy_with_no_subcategories_shows_none(self) -> None:
        tax = [TaxonomyCategory(name="empty_sub", description="test")]
        c = DocumentClassifier(taxonomy=tax)
        prompt = c._build_taxonomy_prompt()
        assert "none" in prompt


class TestDocumentClassifierClassifySingle:
    """classify_single() with mocked Azure OpenAI client."""

    @pytest.fixture
    def classifier_with_mock(self) -> tuple[DocumentClassifier, MagicMock]:
        classifier = DocumentClassifier(endpoint="https://t.openai.azure.com", api_key="k")
        mock_client = MagicMock()
        classifier._client = mock_client
        return classifier, mock_client

    def test_successful_classification(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({
                "category": "public_safety",
                "subcategory": "natural_disaster",
                "confidence": 0.95,
                "reasoning": "Text describes a hurricane warning.",
            })
        )
        result = classifier.classify_single("Hurricane warning issued for coastal areas.")
        assert result.category == "public_safety"
        assert result.subcategory == "natural_disaster"
        assert result.confidence == pytest.approx(0.95)
        assert result.reasoning != ""
        assert not result.is_error

    def test_partial_json_response_uses_defaults(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        # Missing 'subcategory', 'confidence', 'reasoning' — should use defaults
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({"category": "finance"})
        )
        result = classifier.classify_single("Budget deficit widened.")
        assert result.category == "finance"
        assert result.subcategory is None
        assert result.confidence == pytest.approx(0.0)
        assert not result.is_error

    def test_api_exception_returns_error_result(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.side_effect = ConnectionError("timeout")
        result = classifier.classify_single("Some text.")
        assert result.is_error
        assert result.category == "other"
        # tenacity wraps the original ConnectionError in a RetryError; the
        # original message is still present somewhere in the error string.
        assert "ConnectionError" in result.error_message or "timeout" in result.error_message

    def test_text_preview_truncated_at_200_chars(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({"category": "other", "confidence": 0.5})
        )
        long_text = "A" * 500
        result = classifier.classify_single(long_text)
        assert result.text_preview.endswith("...")
        # 200 chars + "..." = 203
        assert len(result.text_preview) == 203

    def test_text_shorter_than_200_not_truncated(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({"category": "health", "confidence": 0.8})
        )
        short_text = "Short text."
        result = classifier.classify_single(short_text)
        assert result.text_preview == short_text


class TestDocumentClassifierClassifyBatch:
    """classify() and classify_records() batch methods."""

    @pytest.fixture
    def classifier_with_mock(self) -> tuple[DocumentClassifier, MagicMock]:
        classifier = DocumentClassifier(endpoint="https://t.openai.azure.com", api_key="k")
        mock_client = MagicMock()
        classifier._client = mock_client
        return classifier, mock_client

    def test_classify_returns_one_result_per_input(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({"category": "environment", "confidence": 0.9})
        )
        results = classifier.classify(["Text one.", "Text two.", "Text three."])
        assert len(results) == 3
        assert all(isinstance(r, ClassificationResult) for r in results)

    def test_classify_empty_list_returns_empty(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        results = classifier.classify([])
        assert results == []
        mock_client.chat.completions.create.assert_not_called()

    def test_classify_records_enriches_dicts(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({
                "category": "agriculture",
                "subcategory": "crops",
                "confidence": 0.88,
                "reasoning": "Discusses crop yields.",
            })
        )
        records = [{"id": 1, "text": "Wheat yields fell 10% this harvest."}]
        enriched = classifier.classify_records(records, text_field="text")
        assert len(enriched) == 1
        assert enriched[0]["id"] == 1
        assert enriched[0]["classification"]["category"] == "agriculture"
        assert enriched[0]["classification"]["subcategory"] == "crops"

    def test_classify_records_error_adds_error_key(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.side_effect = RuntimeError("boom")
        records = [{"id": 2, "text": "Some text."}]
        enriched = classifier.classify_records(records)
        assert "classification_error" in enriched[0]

    def test_classify_records_custom_text_field(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({"category": "finance", "confidence": 0.7})
        )
        records = [{"body": "Budget analysis 2024."}]
        enriched = classifier.classify_records(records, text_field="body")
        assert "classification" in enriched[0]

    def test_classify_records_missing_text_field_uses_empty_string(
        self, classifier_with_mock: tuple[DocumentClassifier, MagicMock]
    ) -> None:
        classifier, mock_client = classifier_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            json.dumps({"category": "other", "confidence": 0.3})
        )
        records = [{"id": 99}]  # no 'text' key
        enriched = classifier.classify_records(records)
        # Should not raise; defaults to empty string
        assert "classification" in enriched[0]


class TestDocumentClassifierLoadTaxonomyFromFile:
    """load_taxonomy_from_file() updates the classifier in-place."""

    def test_reload_taxonomy_replaces_existing(self, tmp_path: Path) -> None:
        taxonomy_data = {
            "categories": [
                {"name": "transport", "description": "Transport topics"},
                {"name": "utilities", "description": "Water and power"},
            ]
        }
        taxonomy_file = tmp_path / "new_taxonomy.yaml"
        taxonomy_file.write_text(yaml.dump(taxonomy_data), encoding="utf-8")

        classifier = DocumentClassifier(endpoint="https://t.openai.azure.com", api_key="k")
        original_count = len(classifier.taxonomy)
        classifier.load_taxonomy_from_file(taxonomy_file)

        assert len(classifier.taxonomy) == 2
        assert len(classifier.taxonomy) != original_count
        assert classifier.taxonomy[0].name == "transport"


# ---------------------------------------------------------------------------
# EntityExtractor
# ---------------------------------------------------------------------------


class TestEntityExtractorInit:
    """Constructor and env-var fallback tests."""

    def test_reads_endpoint_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AZURE_LANGUAGE_ENDPOINT", "https://lang.cognitiveservices.azure.com")
        monkeypatch.setenv("AZURE_LANGUAGE_API_KEY", "langkey")
        extractor = EntityExtractor()
        assert extractor.endpoint == "https://lang.cognitiveservices.azure.com"
        assert extractor.api_key == "langkey"

    def test_batch_size_capped_at_25(self) -> None:
        extractor = EntityExtractor(batch_size=100)
        assert extractor.batch_size == 25

    def test_batch_size_below_cap_preserved(self) -> None:
        extractor = EntityExtractor(batch_size=10)
        assert extractor.batch_size == 10

    def test_language_default(self) -> None:
        extractor = EntityExtractor()
        assert extractor.language == "en"


class TestEntityExtractorExtractEntities:
    """extract_entities() with mocked Azure AI Language client."""

    @pytest.fixture
    def extractor_with_mock(self) -> tuple[EntityExtractor, MagicMock]:
        extractor = EntityExtractor(endpoint="https://lang.cognitiveservices.azure.com", api_key="k")
        mock_client = MagicMock()
        extractor._client = mock_client
        return extractor, mock_client

    def test_single_text_single_entity(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        entity = _make_ner_entity("Microsoft", "Organization")
        doc = _make_ner_doc("0", [entity])
        mock_client.recognize_entities.return_value = [doc]

        results = extractor.extract_entities(["Microsoft was founded in Redmond."])

        assert len(results) == 1
        assert not results[0].is_error
        assert len(results[0].entities) == 1
        assert results[0].entities[0].text == "Microsoft"
        assert results[0].entities[0].category == "Organization"

    def test_multiple_entities_in_single_doc(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        entities = [
            _make_ner_entity("Microsoft", "Organization", offset=0, length=9),
            _make_ner_entity("Redmond", "Location", offset=28, length=7),
            _make_ner_entity("1975", "DateTime", subcategory="DateRange", offset=43, length=4),
        ]
        doc = _make_ner_doc("0", entities)
        mock_client.recognize_entities.return_value = [doc]

        results = extractor.extract_entities(["Microsoft was founded in Redmond in 1975."])

        assert len(results[0].entities) == 3
        categories = {e.category for e in results[0].entities}
        assert categories == {"Organization", "Location", "DateTime"}

    def test_entity_with_subcategory(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        entity = _make_ner_entity("2024-01-15", "DateTime", subcategory="Date")
        doc = _make_ner_doc("0", [entity])
        mock_client.recognize_entities.return_value = [doc]

        results = extractor.extract_entities(["The meeting was on 2024-01-15."])

        assert results[0].entities[0].subcategory == "Date"

    def test_document_level_error_in_response(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        error_doc = _make_ner_doc("0", [], is_error=True)
        mock_client.recognize_entities.return_value = [error_doc]

        results = extractor.extract_entities(["Malformed input."])

        assert results[0].is_error
        assert "InvalidRequest" in results[0].error_message

    def test_api_level_azure_error_marks_batch_as_failed(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        from azure.core.exceptions import AzureError

        extractor, mock_client = extractor_with_mock
        mock_client.recognize_entities.side_effect = AzureError("Service unavailable")

        results = extractor.extract_entities(["Text one.", "Text two."])

        assert len(results) == 2
        assert all(r.is_error for r in results)
        assert all(r.error_message == "API call failed" for r in results)

    def test_empty_list_returns_empty(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        results = extractor.extract_entities([])
        assert results == []
        mock_client.recognize_entities.assert_not_called()

    def test_batch_splitting_into_multiple_api_calls(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        """Texts exceeding batch_size must trigger multiple API calls."""
        extractor, mock_client = extractor_with_mock
        extractor.batch_size = 3  # override for test

        # recognize_entities receives (documents, language=...) — first arg is
        # the documents list; use *args to capture it regardless of call style.
        def make_batch_response(*args: Any, **_kwargs: Any) -> list[MagicMock]:
            docs = args[0] if args else _kwargs.get("documents", [])
            return [_make_ner_doc(str(i), []) for i in range(len(docs))]

        mock_client.recognize_entities.side_effect = make_batch_response

        texts = [f"Text number {i}" for i in range(7)]
        results = extractor.extract_entities(texts)

        assert len(results) == 7
        # 7 texts / batch_size 3 → ceil(7/3) = 3 API calls
        assert mock_client.recognize_entities.call_count == 3

    def test_entity_dataclass_fields_preserved(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        entity = _make_ner_entity("FEMA", "Organization", confidence=0.99, offset=4, length=4)
        doc = _make_ner_doc("0", [entity])
        mock_client.recognize_entities.return_value = [doc]

        results = extractor.extract_entities(["The FEMA response was swift."])

        e = results[0].entities[0]
        assert isinstance(e, Entity)
        assert e.confidence_score == pytest.approx(0.99)
        assert e.offset == 4
        assert e.length == 4


class TestEntityExtractorExtractFromRecords:
    """extract_entities_from_records() pipeline integration method."""

    @pytest.fixture
    def extractor_with_mock(self) -> tuple[EntityExtractor, MagicMock]:
        extractor = EntityExtractor(endpoint="https://lang.cognitiveservices.azure.com", api_key="k")
        mock_client = MagicMock()
        extractor._client = mock_client
        return extractor, mock_client

    def test_enriches_records_with_extracted_entities(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        entity = _make_ner_entity("USDA", "Organization")
        doc = _make_ner_doc("0", [entity])
        mock_client.recognize_entities.return_value = [doc]

        records = [{"id": "rec-1", "text": "USDA released new guidelines."}]
        enriched = extractor.extract_entities_from_records(records)

        assert len(enriched) == 1
        assert enriched[0]["id"] == "rec-1"
        assert len(enriched[0]["extracted_entities"]) == 1
        assert enriched[0]["extracted_entities"][0]["text"] == "USDA"
        assert "entity_extraction_error" not in enriched[0]

    def test_error_result_produces_empty_entities_and_error_key(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        from azure.core.exceptions import AzureError

        extractor, mock_client = extractor_with_mock
        mock_client.recognize_entities.side_effect = AzureError("fail")

        records = [{"id": "rec-2", "text": "Some text."}]
        enriched = extractor.extract_entities_from_records(records)

        assert enriched[0]["extracted_entities"] == []
        assert "entity_extraction_error" in enriched[0]

    def test_custom_text_field(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        doc = _make_ner_doc("0", [])
        mock_client.recognize_entities.return_value = [doc]

        records = [{"content": "Some content text."}]
        enriched = extractor.extract_entities_from_records(records, text_field="content")
        assert "extracted_entities" in enriched[0]

    def test_entity_dict_shape(
        self, extractor_with_mock: tuple[EntityExtractor, MagicMock]
    ) -> None:
        extractor, mock_client = extractor_with_mock
        entity = _make_ner_entity("Seattle", "Location", confidence=0.97, offset=10, length=7)
        doc = _make_ner_doc("0", [entity])
        mock_client.recognize_entities.return_value = [doc]

        records = [{"text": "Based in Seattle."}]
        enriched = extractor.extract_entities_from_records(records)

        ent_dict = enriched[0]["extracted_entities"][0]
        assert set(ent_dict.keys()) == {"text", "category", "subcategory", "confidence_score", "offset", "length"}
        assert ent_dict["confidence_score"] == pytest.approx(0.97)


class TestEntityExtractorBronzeToSilver:
    """enrich_bronze_to_silver() file I/O integration."""

    @pytest.fixture
    def extractor_with_mock(self) -> tuple[EntityExtractor, MagicMock]:
        extractor = EntityExtractor(endpoint="https://lang.cognitiveservices.azure.com", api_key="k")
        mock_client = MagicMock()
        extractor._client = mock_client
        return extractor, mock_client

    def test_reads_jsonl_and_writes_enriched_jsonl(
        self,
        extractor_with_mock: tuple[EntityExtractor, MagicMock],
        tmp_path: Path,
    ) -> None:
        extractor, mock_client = extractor_with_mock

        entity = _make_ner_entity("Arizona", "Location")
        doc = _make_ner_doc("0", [entity])
        mock_client.recognize_entities.return_value = [doc]

        bronze = tmp_path / "bronze" / "data.jsonl"
        bronze.parent.mkdir()
        bronze.write_text(
            json.dumps({"id": "1", "text": "Flooding in Arizona."}) + "\n",
            encoding="utf-8",
        )
        silver = tmp_path / "silver" / "data.jsonl"

        stats = extractor.enrich_bronze_to_silver(str(bronze), str(silver))

        assert stats["total"] == 1
        assert stats["errors"] == 0
        assert silver.exists()
        output = json.loads(silver.read_text(encoding="utf-8"))
        assert output["id"] == "1"
        assert len(output["extracted_entities"]) == 1

    def test_empty_bronze_file_returns_zero_counts(
        self,
        extractor_with_mock: tuple[EntityExtractor, MagicMock],
        tmp_path: Path,
    ) -> None:
        extractor, mock_client = extractor_with_mock
        bronze = tmp_path / "empty.jsonl"
        bronze.write_text("", encoding="utf-8")
        silver = tmp_path / "out.jsonl"

        stats = extractor.enrich_bronze_to_silver(str(bronze), str(silver))

        assert stats == {"total": 0, "enriched": 0, "errors": 0}
        mock_client.recognize_entities.assert_not_called()

    def test_errors_counted_in_stats(
        self,
        extractor_with_mock: tuple[EntityExtractor, MagicMock],
        tmp_path: Path,
    ) -> None:
        from azure.core.exceptions import AzureError

        extractor, mock_client = extractor_with_mock
        mock_client.recognize_entities.side_effect = AzureError("fail")

        bronze = tmp_path / "data.jsonl"
        bronze.write_text(
            json.dumps({"id": "1", "text": "Some text."}) + "\n",
            encoding="utf-8",
        )
        silver = tmp_path / "out.jsonl"

        stats = extractor.enrich_bronze_to_silver(str(bronze), str(silver))

        assert stats["errors"] == 1
        assert stats["total"] == 1


# ---------------------------------------------------------------------------
# TextSummarizer
# ---------------------------------------------------------------------------


class TestTextSummarizerInit:
    """Constructor and env-var fallback tests."""

    def test_reads_endpoint_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://env.openai.azure.com")
        monkeypatch.setenv("AZURE_OPENAI_API_KEY", "mykey")
        summarizer = TextSummarizer()
        assert summarizer.endpoint == "https://env.openai.azure.com"

    def test_max_input_chars_derived_from_tokens(self) -> None:
        summarizer = TextSummarizer(max_input_tokens=1000)
        # 1000 tokens * 4 chars/token = 4000 chars
        assert summarizer._max_input_chars == 4000

    def test_min_interval_from_rpm(self) -> None:
        summarizer = TextSummarizer(requests_per_minute=120)
        assert summarizer._min_interval == pytest.approx(0.5)


class TestTextSummarizerChunking:
    """_chunk_text() — no network calls."""

    @pytest.fixture
    def summarizer(self) -> TextSummarizer:
        # Use a very small token budget to force chunking in tests
        return TextSummarizer(
            endpoint="https://t.openai.azure.com",
            api_key="k",
            max_input_tokens=10,  # 40 chars budget
        )

    def test_short_text_returns_single_chunk(self) -> None:
        s = TextSummarizer(
            endpoint="https://t.openai.azure.com",
            api_key="k",
            max_input_tokens=6000,
        )
        text = "A short document."
        chunks = s._chunk_text(text)
        assert chunks == [text]

    def test_long_text_split_on_paragraphs(self, summarizer: TextSummarizer) -> None:
        # Each paragraph is > 40 chars so they must each be in their own chunk
        para1 = "First paragraph with enough content to exceed the limit."
        para2 = "Second paragraph that is also sufficiently long to trigger split."
        text = f"{para1}\n\n{para2}"
        chunks = summarizer._chunk_text(text)
        assert len(chunks) >= 2

    def test_chunks_cover_all_content(self, summarizer: TextSummarizer) -> None:
        paras = [f"Paragraph number {i} with some content." for i in range(5)]
        text = "\n\n".join(paras)
        chunks = summarizer._chunk_text(text)
        reassembled = "\n\n".join(chunks)
        for para in paras:
            assert para in reassembled

    def test_empty_text_returns_single_empty_chunk(self) -> None:
        s = TextSummarizer(endpoint="https://t.openai.azure.com", api_key="k")
        chunks = s._chunk_text("")
        assert chunks == [""]


class TestTextSummarizerStyleInstructions:
    """_style_instruction() prompt construction — no network."""

    def test_bullet_points_instruction(self) -> None:
        instr = TextSummarizer._style_instruction(SummarizationStyle.BULLET_POINTS, 100)
        assert "bulleted" in instr.lower() or "bullet" in instr.lower()
        assert "100" in instr

    def test_executive_summary_instruction(self) -> None:
        instr = TextSummarizer._style_instruction(SummarizationStyle.EXECUTIVE_SUMMARY, 250)
        assert "executive" in instr.lower()
        assert "250" in instr

    def test_paragraph_instruction(self) -> None:
        instr = TextSummarizer._style_instruction(SummarizationStyle.PARAGRAPH, 150)
        assert "paragraph" in instr.lower()
        assert "150" in instr

    def test_system_prompt_extractive_approach(self) -> None:
        s = TextSummarizer(endpoint="https://t.openai.azure.com", api_key="k")
        prompt = s._build_system_prompt(
            SummarizationMode.EXTRACTIVE, SummarizationStyle.PARAGRAPH, 200
        )
        assert "EXTRACTIVE" in prompt

    def test_system_prompt_abstractive_approach(self) -> None:
        s = TextSummarizer(endpoint="https://t.openai.azure.com", api_key="k")
        prompt = s._build_system_prompt(
            SummarizationMode.ABSTRACTIVE, SummarizationStyle.PARAGRAPH, 200
        )
        assert "ABSTRACTIVE" in prompt


class TestTextSummarizerSummarize:
    """summarize() with mocked Azure OpenAI client."""

    @pytest.fixture
    def summarizer_with_mock(self) -> tuple[TextSummarizer, MagicMock]:
        summarizer = TextSummarizer(endpoint="https://t.openai.azure.com", api_key="k")
        mock_client = MagicMock()
        summarizer._client = mock_client
        return summarizer, mock_client

    def test_basic_abstractive_summarization(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            "Crop yields rose 12% driven by improved irrigation."
        )
        result = summarizer.summarize("Long agriculture document text..." * 5)
        assert not result.is_error
        assert result.summary == "Crop yields rose 12% driven by improved irrigation."
        assert result.mode == "abstractive"
        assert result.style == "paragraph"

    def test_extractive_mode_passed_to_prompt(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response("Key sentence.")

        result = summarizer.summarize("Some text.", mode="extractive")

        assert result.mode == "extractive"
        call_args = mock_client.chat.completions.create.call_args
        system_msg = call_args.kwargs["messages"][0]["content"]
        assert "EXTRACTIVE" in system_msg

    def test_bullet_points_style_in_result(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            "- Point 1\n- Point 2"
        )
        result = summarizer.summarize("Text.", style="bullet_points")
        assert result.style == "bullet_points"

    def test_executive_summary_style(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response(
            "Executive overview here."
        )
        result = summarizer.summarize("Long doc.", style="executive_summary")
        assert result.style == "executive_summary"

    def test_api_exception_returns_error_result(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.side_effect = RuntimeError("quota exceeded")

        result = summarizer.summarize("Some text.")

        assert result.is_error
        assert result.summary == ""
        assert "quota exceeded" in result.error_message

    def test_input_and_output_length_recorded(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        input_text = "A document of known length."
        summary_text = "Summary text."
        mock_client.chat.completions.create.return_value = _make_openai_response(summary_text)

        result = summarizer.summarize(input_text)

        assert result.input_length == len(input_text)
        assert result.output_length == len(summary_text)

    def test_invalid_mode_raises_value_error(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, _ = summarizer_with_mock
        with pytest.raises(ValueError, match="magic"):
            summarizer.summarize("Text.", mode="magic")

    def test_invalid_style_raises_value_error(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, _ = summarizer_with_mock
        with pytest.raises(ValueError, match="haiku"):
            summarizer.summarize("Text.", style="haiku")

    def test_single_chunk_makes_one_api_call(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response("Summary.")

        summarizer.summarize("Short text.")

        mock_client.chat.completions.create.assert_called_once()
        assert summarizer.summarize("Short text.").chunks_processed == 1


class TestTextSummarizerLongDocumentHandling:
    """summarize() with multi-chunk documents — hierarchical reduction."""

    def test_long_document_uses_hierarchical_summarization(self) -> None:
        """A text longer than max_input_chars forces multi-chunk path."""
        # 10 token budget = 40 chars; each paragraph >> 40 chars triggers chunks
        summarizer = TextSummarizer(
            endpoint="https://t.openai.azure.com",
            api_key="k",
            max_input_tokens=10,
        )
        mock_client = MagicMock()
        summarizer._client = mock_client

        # Make the mock return incrementally distinctive summaries
        call_count: list[int] = [0]

        def side_effect(**kwargs: Any) -> MagicMock:
            call_count[0] += 1
            return _make_openai_response(f"Chunk summary {call_count[0]}.")

        mock_client.chat.completions.create.side_effect = side_effect

        # Build text that will be split into at least 2 chunks
        long_text = "\n\n".join(
            f"Paragraph {i} with enough content to definitely exceed forty characters."
            for i in range(4)
        )

        result = summarizer.summarize(long_text)

        assert not result.is_error
        # Multiple API calls: one per chunk + one for final combination
        assert mock_client.chat.completions.create.call_count >= 2
        assert result.chunks_processed >= 2

    def test_chunks_processed_is_one_for_short_doc(self) -> None:
        summarizer = TextSummarizer(
            endpoint="https://t.openai.azure.com",
            api_key="k",
            max_input_tokens=6000,
        )
        mock_client = MagicMock()
        summarizer._client = mock_client
        mock_client.chat.completions.create.return_value = _make_openai_response("Brief summary.")

        result = summarizer.summarize("A short document.")

        assert result.chunks_processed == 1


class TestTextSummarizerBatch:
    """summarize_batch() iterates and collects results."""

    @pytest.fixture
    def summarizer_with_mock(self) -> tuple[TextSummarizer, MagicMock]:
        summarizer = TextSummarizer(endpoint="https://t.openai.azure.com", api_key="k")
        mock_client = MagicMock()
        summarizer._client = mock_client
        return summarizer, mock_client

    def test_batch_returns_one_result_per_text(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response("Summary.")
        texts = ["Text A.", "Text B.", "Text C."]
        results = summarizer.summarize_batch(texts)
        assert len(results) == 3
        assert all(isinstance(r, SummarizationResult) for r in results)

    def test_empty_batch_returns_empty(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        results = summarizer.summarize_batch([])
        assert results == []
        mock_client.chat.completions.create.assert_not_called()

    def test_batch_propagates_kwargs(
        self, summarizer_with_mock: tuple[TextSummarizer, MagicMock]
    ) -> None:
        summarizer, mock_client = summarizer_with_mock
        mock_client.chat.completions.create.return_value = _make_openai_response("S.")
        results = summarizer.summarize_batch(
            ["T1.", "T2."],
            mode="extractive",
            style="bullet_points",
            max_length=50,
        )
        for r in results:
            assert r.mode == "extractive"
            assert r.style == "bullet_points"


# ---------------------------------------------------------------------------
# SummarizationResult and ClassificationResult dataclass sanity checks
# ---------------------------------------------------------------------------


class TestDataclasses:
    def test_summarization_result_default_chunks_processed(self) -> None:
        r = SummarizationResult(
            summary="s",
            mode="abstractive",
            style="paragraph",
            input_length=100,
            output_length=20,
        )
        assert r.chunks_processed == 1
        assert not r.is_error

    def test_classification_result_error_flag_default_false(self) -> None:
        r = ClassificationResult(text_preview="p", category="health")
        assert not r.is_error
        assert r.error_message == ""

    def test_extraction_result_empty_entities_by_default(self) -> None:
        r = ExtractionResult(text="t")
        assert r.entities == []
        assert not r.is_error

    def test_entity_dataclass_fields(self) -> None:
        e = Entity(text="Paris", category="Location")
        assert e.subcategory is None
        assert e.confidence_score == 0.0
        assert e.offset == 0
