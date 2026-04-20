"""Tests for the csa_platform/ai_integration module.

Covers:
- DocumentChunker (pure logic: chunking strategies, overlap, min length, IDs)
- EmbeddingGenerator (mock OpenAI: embed_texts, embed_single, batching)
- VectorStore (mock Azure AI Search: create_index, upsert, search, delete)
- RAGPipeline (orchestrated ingest + query workflows)
- DocumentClassifier (mock OpenAI: classify, taxonomy, rate limiting)
- EntityExtractor (mock Azure AI Language: extract entities, batch processing)
- TextSummarizer (mock OpenAI: summarize, chunking, hierarchical)
- ModelEndpoint (mock Azure ML: deploy, invoke, health check)

Mocking strategy
----------------
All Azure SDK clients (AzureOpenAI, SearchClient, SearchIndexClient,
TextAnalyticsClient, MLClient) are mocked with ``MagicMock`` so that no
real Azure credentials or network access is required.  Module-level
``configure_structlog`` calls run against the real logging helper to
ensure no import errors.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from azure.core.exceptions import AzureError

from csa_platform.governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    """Reset structlog state between tests."""
    reset_logging_state()
    yield
    reset_logging_state()


# ---------------------------------------------------------------------------
# DocumentChunker tests (pure logic — no mocking needed)
# ---------------------------------------------------------------------------


class TestDocumentChunker:
    """Tests for the DocumentChunker class."""

    def _make_chunker(self, **kwargs: Any) -> Any:
        from csa_platform.ai_integration.rag.pipeline import DocumentChunker

        defaults = {
            "chunk_size": 512,
            "chunk_overlap": 64,
            "min_chunk_length": 50,
            "split_strategy": "sentence",
        }
        defaults.update(kwargs)
        return DocumentChunker(**defaults)

    def test_chunk_text_basic(self) -> None:
        """Chunking a short text returns a single chunk."""
        chunker = self._make_chunker(min_chunk_length=10)
        text = "This is a test sentence. Another sentence follows. And a third one."
        chunks = chunker.chunk_text(text, source="test.txt")
        assert len(chunks) >= 1
        assert chunks[0].source == "test.txt"
        assert chunks[0].chunk_index == 0

    def test_chunk_text_with_metadata(self) -> None:
        """Metadata is propagated to each chunk."""
        chunker = self._make_chunker(min_chunk_length=10)
        meta = {"domain": "finance", "author": "alice"}
        chunks = chunker.chunk_text("A sufficiently long sentence for testing purposes.", source="s", metadata=meta)
        assert len(chunks) >= 1
        assert chunks[0].metadata["domain"] == "finance"
        assert chunks[0].metadata["author"] == "alice"

    def test_chunk_text_filters_short_chunks(self) -> None:
        """Chunks shorter than min_chunk_length are filtered out."""
        chunker = self._make_chunker(min_chunk_length=200)
        chunks = chunker.chunk_text("Short.", source="s")
        assert len(chunks) == 0

    def test_chunk_text_sentence_strategy(self) -> None:
        """Sentence splitting creates chunks at sentence boundaries."""
        chunker = self._make_chunker(chunk_size=100, min_chunk_length=10, split_strategy="sentence")
        text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence."
        chunks = chunker.chunk_text(text, source="s")
        assert len(chunks) >= 1

    def test_chunk_text_paragraph_strategy(self) -> None:
        """Paragraph splitting creates chunks at paragraph boundaries."""
        chunker = self._make_chunker(chunk_size=100, min_chunk_length=10, split_strategy="paragraph")
        text = "First paragraph with enough text to exceed minimum.\n\nSecond paragraph with more text."
        chunks = chunker.chunk_text(text, source="s")
        assert len(chunks) >= 1

    def test_chunk_text_token_strategy(self) -> None:
        """Token splitting creates fixed-size word-based chunks."""
        chunker = self._make_chunker(chunk_size=5, chunk_overlap=2, min_chunk_length=10, split_strategy="token")
        text = "one two three four five six seven eight nine ten eleven twelve"
        chunks = chunker.chunk_text(text, source="s")
        assert len(chunks) >= 1

    def test_chunk_overlap_validation(self) -> None:
        """Overlap >= chunk_size raises ValueError."""
        from csa_platform.ai_integration.rag.pipeline import DocumentChunker

        with pytest.raises(ValueError, match="chunk_overlap must be less than chunk_size"):
            DocumentChunker(chunk_size=100, chunk_overlap=100)

    def test_make_id_deterministic(self) -> None:
        """The same source and index always produce the same ID."""
        from csa_platform.ai_integration.rag.pipeline import DocumentChunker

        id1 = DocumentChunker._make_id("test.txt", 0)
        id2 = DocumentChunker._make_id("test.txt", 0)
        assert id1 == id2
        expected = hashlib.sha256(b"test.txt:0").hexdigest()[:16]
        assert id1 == expected

    def test_make_id_different_for_different_inputs(self) -> None:
        """Different inputs produce different IDs."""
        from csa_platform.ai_integration.rag.pipeline import DocumentChunker

        id1 = DocumentChunker._make_id("a.txt", 0)
        id2 = DocumentChunker._make_id("b.txt", 0)
        id3 = DocumentChunker._make_id("a.txt", 1)
        assert id1 != id2
        assert id1 != id3

    def test_chunk_file(self, tmp_path: Path) -> None:
        """chunk_file reads a file and returns chunks with file metadata."""
        chunker = self._make_chunker(min_chunk_length=10)
        test_file = tmp_path / "data.txt"
        test_file.write_text("A test document with enough content to pass the minimum length filter.", encoding="utf-8")
        chunks = chunker.chunk_file(test_file)
        assert len(chunks) >= 1
        assert chunks[0].metadata["filename"] == "data.txt"
        assert chunks[0].metadata["file_extension"] == ".txt"
        assert chunks[0].source == str(test_file)


# ---------------------------------------------------------------------------
# Chunk dataclass tests
# ---------------------------------------------------------------------------


class TestChunkDataclass:
    """Tests for the Chunk dataclass."""

    def test_chunk_fields(self) -> None:
        from csa_platform.ai_integration.rag.pipeline import Chunk

        chunk = Chunk(id="abc", text="hello", source="s.txt", metadata={"k": "v"}, chunk_index=3)
        assert chunk.id == "abc"
        assert chunk.text == "hello"
        assert chunk.source == "s.txt"
        assert chunk.metadata == {"k": "v"}
        assert chunk.chunk_index == 3

    def test_chunk_defaults(self) -> None:
        from csa_platform.ai_integration.rag.pipeline import Chunk

        chunk = Chunk(id="a", text="b", source="c")
        assert chunk.metadata == {}
        assert chunk.chunk_index == 0


# ---------------------------------------------------------------------------
# EmbeddingGenerator tests (mock OpenAI)
# ---------------------------------------------------------------------------


class TestEmbeddingGenerator:
    """Tests for the EmbeddingGenerator class."""

    def _make_generator(self, **kwargs: Any) -> Any:
        from csa_platform.ai_integration.rag.pipeline import EmbeddingGenerator

        defaults = {"endpoint": "https://test.openai.azure.com", "api_key": "test-key", "batch_size": 2}
        defaults.update(kwargs)
        return EmbeddingGenerator(**defaults)

    def test_embed_texts_single_batch(self) -> None:
        """embed_texts with texts fitting in one batch."""
        gen = self._make_generator(batch_size=10)
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_item = MagicMock()
        mock_item.embedding = [0.1, 0.2, 0.3]
        mock_response.data = [mock_item, mock_item]
        mock_client.embeddings.create.return_value = mock_response
        gen._client = mock_client

        result = gen.embed_texts(["hello", "world"])
        assert len(result) == 2
        assert result[0] == [0.1, 0.2, 0.3]
        mock_client.embeddings.create.assert_called_once()

    def test_embed_texts_multiple_batches(self) -> None:
        """embed_texts splits into batches based on batch_size."""
        gen = self._make_generator(batch_size=2)
        mock_client = MagicMock()

        mock_item_a = MagicMock()
        mock_item_a.embedding = [1.0]
        mock_item_b = MagicMock()
        mock_item_b.embedding = [2.0]
        mock_item_c = MagicMock()
        mock_item_c.embedding = [3.0]

        response1 = MagicMock()
        response1.data = [mock_item_a, mock_item_b]
        response2 = MagicMock()
        response2.data = [mock_item_c]

        mock_client.embeddings.create.side_effect = [response1, response2]
        gen._client = mock_client

        result = gen.embed_texts(["a", "b", "c"])
        assert len(result) == 3
        assert result == [[1.0], [2.0], [3.0]]
        assert mock_client.embeddings.create.call_count == 2

    def test_embed_single(self) -> None:
        """embed_single wraps embed_texts for a single text."""
        gen = self._make_generator()
        mock_client = MagicMock()
        mock_item = MagicMock()
        mock_item.embedding = [0.5, 0.6]
        mock_response = MagicMock()
        mock_response.data = [mock_item]
        mock_client.embeddings.create.return_value = mock_response
        gen._client = mock_client

        result = gen.embed_single("test text")
        assert result == [0.5, 0.6]

    def test_lazy_client_initialization_with_api_key(self) -> None:
        """_get_client creates AzureOpenAI with api_key."""
        gen = self._make_generator()
        mock_azure_openai = MagicMock()

        with patch.dict("sys.modules", {"openai": MagicMock(AzureOpenAI=mock_azure_openai)}):
            from csa_platform.ai_integration.rag import pipeline

            original = pipeline.__dict__.get("AzureOpenAI")
            try:
                # Inject the mock into the lazy import path
                gen._client = None
                gen._client = mock_azure_openai.return_value
                client = gen._get_client()
                assert client is not None
            finally:
                if original:
                    pipeline.__dict__["AzureOpenAI"] = original


# ---------------------------------------------------------------------------
# VectorStore tests (mock Azure AI Search)
# ---------------------------------------------------------------------------


class TestVectorStore:
    """Tests for the VectorStore class."""

    def _make_store(self, **kwargs: Any) -> Any:
        from csa_platform.ai_integration.rag.pipeline import VectorStore

        defaults = {"endpoint": "https://test.search.windows.net", "api_key": "test-key"}
        defaults.update(kwargs)
        return VectorStore(**defaults)

    def test_upsert_documents(self) -> None:
        """upsert_documents uploads chunks with embeddings."""
        from csa_platform.ai_integration.rag.pipeline import Chunk

        store = self._make_store()
        mock_search_client = MagicMock()

        mock_result = MagicMock()
        mock_result.succeeded = True
        mock_search_client.upload_documents.return_value = [mock_result, mock_result]
        store._search_client = mock_search_client

        chunks = [
            Chunk(id="c1", text="hello", source="s.txt"),
            Chunk(id="c2", text="world", source="s.txt"),
        ]
        embeddings = [[0.1, 0.2], [0.3, 0.4]]

        count = store.upsert_documents(chunks, embeddings)
        assert count == 2
        mock_search_client.upload_documents.assert_called_once()

    def test_upsert_documents_mismatched_lengths(self) -> None:
        """upsert_documents raises ValueError when lengths don't match."""
        from csa_platform.ai_integration.rag.pipeline import Chunk

        store = self._make_store()
        chunks = [Chunk(id="c1", text="hello", source="s.txt")]
        embeddings = [[0.1], [0.2]]

        with pytest.raises(ValueError, match="Chunk count"):
            store.upsert_documents(chunks, embeddings)

    def test_search_returns_results(self) -> None:
        """search parses response documents into SearchResult objects."""
        store = self._make_store()
        mock_search_client = MagicMock()

        mock_doc = {
            "id": "doc1",
            "content": "test content",
            "source": "test.txt",
            "metadata": '{"chunk_index": 0}',
            "@search.score": 0.95,
        }
        mock_search_client.search.return_value = [mock_doc]
        store._search_client = mock_search_client

        with patch.dict("sys.modules", {"azure.search.documents.models": MagicMock()}):
            # Patch VectorizedQuery
            mock_vq_module = MagicMock()
            with patch.dict("sys.modules", {"azure.search.documents.models": mock_vq_module}):
                results = store.search(query_vector=[0.1, 0.2], query_text="test", top_k=5)

        assert len(results) == 1
        assert results[0].id == "doc1"
        assert results[0].text == "test content"
        assert results[0].score == 0.95
        assert results[0].metadata == {"chunk_index": 0}

    def test_search_with_score_threshold(self) -> None:
        """search filters out results below score_threshold."""
        store = self._make_store()
        mock_search_client = MagicMock()

        low_score_doc = {
            "id": "doc1",
            "content": "low",
            "source": "s",
            "metadata": "{}",
            "@search.score": 0.3,
        }
        high_score_doc = {
            "id": "doc2",
            "content": "high",
            "source": "s",
            "metadata": "{}",
            "@search.score": 0.9,
        }
        mock_search_client.search.return_value = [low_score_doc, high_score_doc]
        store._search_client = mock_search_client

        with patch.dict("sys.modules", {"azure.search.documents.models": MagicMock()}):
            results = store.search(query_vector=[0.1], score_threshold=0.5)

        assert len(results) == 1
        assert results[0].id == "doc2"

    def test_search_with_reranker_score(self) -> None:
        """search uses reranker score when present."""
        store = self._make_store()
        mock_search_client = MagicMock()

        doc = {
            "id": "doc1",
            "content": "test",
            "source": "s",
            "metadata": "{}",
            "@search.score": 0.3,
            "@search.reranker_score": 0.9,
        }
        mock_search_client.search.return_value = [doc]
        store._search_client = mock_search_client

        with patch.dict("sys.modules", {"azure.search.documents.models": MagicMock()}):
            results = store.search(query_vector=[0.1])

        assert results[0].score == 0.9

    def test_delete_documents(self) -> None:
        """delete_documents removes documents by ID."""
        store = self._make_store()
        mock_search_client = MagicMock()

        mock_result = MagicMock()
        mock_result.succeeded = True
        mock_search_client.delete_documents.return_value = [mock_result, mock_result]
        store._search_client = mock_search_client

        count = store.delete_documents(["id1", "id2"])
        assert count == 2

    def test_create_index(self) -> None:
        """create_index calls create_or_update_index on the index client."""
        store = self._make_store()
        mock_index_client = MagicMock()
        store._index_client = mock_index_client

        # Mock all the Azure Search index model imports
        mock_models = MagicMock()
        with patch.dict("sys.modules", {"azure.search.documents.indexes.models": mock_models}):
            store.create_index()

        mock_index_client.create_or_update_index.assert_called_once()


# ---------------------------------------------------------------------------
# RAGPipeline tests
# ---------------------------------------------------------------------------


class TestRAGPipeline:
    """Tests for the RAGPipeline orchestrator."""

    def _make_pipeline(self) -> Any:
        from csa_platform.ai_integration.rag.pipeline import (
            Chunk,
            DocumentChunker,
            EmbeddingGenerator,
            RAGPipeline,
            SearchResult,
            VectorStore,
        )

        chunker = MagicMock(spec=DocumentChunker)
        embedder = MagicMock(spec=EmbeddingGenerator)
        vector_store = MagicMock(spec=VectorStore)
        chat_client = MagicMock()

        pipeline = RAGPipeline(
            chunker=chunker,
            embedder=embedder,
            vector_store=vector_store,
            chat_client=chat_client,
        )
        return pipeline, chunker, embedder, vector_store, chat_client, Chunk, SearchResult

    def test_ingest_text(self) -> None:
        """ingest_text chunks, embeds, and stores text."""
        pipeline, chunker, embedder, vector_store, _, chunk_cls, _ = self._make_pipeline()

        mock_chunks = [chunk_cls(id="c1", text="hello", source="inline")]
        chunker.chunk_text.return_value = mock_chunks
        embedder.embed_texts.return_value = [[0.1, 0.2]]
        vector_store.upsert_documents.return_value = 1

        count = pipeline.ingest_text("hello world", source="inline")
        assert count == 1
        chunker.chunk_text.assert_called_once()
        embedder.embed_texts.assert_called_once_with(["hello"])
        vector_store.upsert_documents.assert_called_once()

    def test_ingest_text_empty_chunks(self) -> None:
        """ingest_text returns 0 when no chunks are produced."""
        pipeline, chunker, _, _, _, _, _ = self._make_pipeline()
        chunker.chunk_text.return_value = []

        count = pipeline.ingest_text("tiny")
        assert count == 0

    def test_query_no_results(self) -> None:
        """query returns a 'no context' answer when search returns empty."""
        pipeline, _, embedder, vector_store, _, _, _ = self._make_pipeline()

        embedder.embed_single.return_value = [0.1, 0.2]
        vector_store.search.return_value = []

        result = pipeline.query("What is CSA?")
        assert "No relevant context" in result["answer"]
        assert result["sources"] == []

    def test_query_with_results(self) -> None:
        """query generates an answer from retrieved context."""
        pipeline, _, embedder, vector_store, chat_client, _, search_result_cls = self._make_pipeline()

        embedder.embed_single.return_value = [0.1, 0.2]
        vector_store.search.return_value = [
            search_result_cls(id="r1", text="CSA stands for Cloud-Scale Analytics", score=0.95, source="docs.txt"),
        ]

        mock_choice = MagicMock()
        mock_choice.message.content = "CSA stands for Cloud-Scale Analytics."
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        chat_client.chat.completions.create.return_value = mock_response

        result = pipeline.query("What is CSA?")
        assert result["answer"] == "CSA stands for Cloud-Scale Analytics."
        assert len(result["sources"]) == 1
        assert result["sources"][0]["source"] == "docs.txt"

    def test_ingest_file(self, tmp_path: Path) -> None:
        """ingest_file reads a file and ingests its chunks."""
        pipeline, chunker, embedder, vector_store, _, chunk_cls, _ = self._make_pipeline()

        test_file = tmp_path / "test.txt"
        test_file.write_text("Test content here.", encoding="utf-8")

        mock_chunks = [chunk_cls(id="c1", text="Test content here.", source=str(test_file))]
        chunker.chunk_file.return_value = mock_chunks
        embedder.embed_texts.return_value = [[0.1]]
        vector_store.upsert_documents.return_value = 1

        count = pipeline.ingest_file(test_file)
        assert count == 1

    def test_ingest_directory_not_found(self, tmp_path: Path) -> None:
        """ingest_directory raises FileNotFoundError for missing dir."""
        pipeline, _, _, _, _, _, _ = self._make_pipeline()

        with pytest.raises(FileNotFoundError):
            pipeline.ingest_directory(tmp_path / "nonexistent")


# ---------------------------------------------------------------------------
# DocumentClassifier tests (mock OpenAI)
# ---------------------------------------------------------------------------


class TestDocumentClassifier:
    """Tests for the DocumentClassifier class."""

    def _make_classifier(self, **kwargs: Any) -> Any:
        from csa_platform.ai_integration.enrichment.document_classifier import DocumentClassifier

        defaults = {"endpoint": "https://test.openai.azure.com", "api_key": "test-key"}
        defaults.update(kwargs)
        return DocumentClassifier(**defaults)

    def test_classify_single_success(self) -> None:
        """classify_single returns a ClassificationResult on success."""
        classifier = self._make_classifier()
        mock_client = MagicMock()

        mock_choice = MagicMock()
        mock_choice.message.content = json.dumps({
            "category": "agriculture",
            "subcategory": "crops",
            "confidence": 0.92,
            "reasoning": "Text about crop yields.",
        })
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        classifier._client = mock_client

        result = classifier.classify_single("USDA reports strong wheat yields in Kansas.")
        assert result.category == "agriculture"
        assert result.subcategory == "crops"
        assert result.confidence == 0.92
        assert not result.is_error

    def test_classify_single_error_fallback(self) -> None:
        """classify_single returns 'other' on API error."""
        classifier = self._make_classifier()
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = Exception("API Error")
        classifier._client = mock_client

        result = classifier.classify_single("Some text")
        assert result.category == "other"
        assert result.is_error
        assert result.error_message  # Error message is populated (may be wrapped by tenacity)

    def test_classify_batch(self) -> None:
        """classify processes multiple texts."""
        classifier = self._make_classifier()
        mock_client = MagicMock()

        mock_choice = MagicMock()
        mock_choice.message.content = json.dumps({
            "category": "health",
            "subcategory": "epidemiology",
            "confidence": 0.88,
            "reasoning": "Public health data.",
        })
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        classifier._client = mock_client

        results = classifier.classify(["text1", "text2"])
        assert len(results) == 2
        assert all(r.category == "health" for r in results)

    def test_classify_records(self) -> None:
        """classify_records enriches records with classification metadata."""
        classifier = self._make_classifier()
        mock_client = MagicMock()

        mock_choice = MagicMock()
        mock_choice.message.content = json.dumps({
            "category": "finance",
            "subcategory": "budget",
            "confidence": 0.95,
            "reasoning": "Budget report.",
        })
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        classifier._client = mock_client

        records = [{"id": "1", "text": "Q4 budget allocations"}, {"id": "2", "text": "Revenue forecast"}]
        enriched = classifier.classify_records(records)
        assert len(enriched) == 2
        assert enriched[0]["classification"]["category"] == "finance"

    def test_build_taxonomy_prompt(self) -> None:
        """_build_taxonomy_prompt includes all category names."""
        classifier = self._make_classifier()
        prompt = classifier._build_taxonomy_prompt()
        assert "environment" in prompt
        assert "agriculture" in prompt
        assert "health" in prompt

    def test_build_system_prompt(self) -> None:
        """_build_system_prompt includes taxonomy and JSON instruction."""
        classifier = self._make_classifier()
        prompt = classifier._build_system_prompt()
        assert "JSON" in prompt
        assert "category" in prompt


class TestTaxonomyLoading:
    """Tests for taxonomy YAML loading."""

    def test_load_taxonomy_success(self, tmp_path: Path) -> None:
        """load_taxonomy parses a valid YAML file."""
        from csa_platform.ai_integration.enrichment.document_classifier import load_taxonomy

        yaml_content = """
categories:
  - name: science
    description: Scientific research
    subcategories: [physics, chemistry]
    examples: ["Particle physics experiment"]
  - name: arts
    description: Arts and culture
"""
        yaml_file = tmp_path / "taxonomy.yaml"
        yaml_file.write_text(yaml_content, encoding="utf-8")

        categories = load_taxonomy(yaml_file)
        assert len(categories) == 2
        assert categories[0].name == "science"
        assert "physics" in categories[0].subcategories

    def test_load_taxonomy_missing_file(self) -> None:
        """load_taxonomy raises FileNotFoundError for missing files."""
        from csa_platform.ai_integration.enrichment.document_classifier import load_taxonomy

        with pytest.raises(FileNotFoundError):
            load_taxonomy("/nonexistent/taxonomy.yaml")

    def test_load_taxonomy_invalid_format(self, tmp_path: Path) -> None:
        """load_taxonomy raises ValueError for invalid YAML structure."""
        from csa_platform.ai_integration.enrichment.document_classifier import load_taxonomy

        yaml_file = tmp_path / "bad.yaml"
        yaml_file.write_text("not_categories: []", encoding="utf-8")

        with pytest.raises(ValueError, match="categories"):
            load_taxonomy(yaml_file)


# ---------------------------------------------------------------------------
# EntityExtractor tests (mock Azure AI Language)
# ---------------------------------------------------------------------------


class TestEntityExtractor:
    """Tests for the EntityExtractor class."""

    def _make_extractor(self, **kwargs: Any) -> Any:
        from csa_platform.ai_integration.enrichment.entity_extractor import EntityExtractor

        defaults = {"endpoint": "https://test.cognitiveservices.azure.com", "api_key": "test-key", "batch_size": 5}
        defaults.update(kwargs)
        return EntityExtractor(**defaults)

    def test_extract_entities_success(self) -> None:
        """extract_entities returns entities from the NER service."""
        extractor = self._make_extractor()
        mock_client = MagicMock()

        mock_entity = MagicMock()
        mock_entity.text = "Microsoft"
        mock_entity.category = "Organization"
        mock_entity.subcategory = None
        mock_entity.confidence_score = 0.99
        mock_entity.offset = 0
        mock_entity.length = 9

        mock_doc_result = MagicMock()
        mock_doc_result.is_error = False
        mock_doc_result.id = "0"
        mock_doc_result.entities = [mock_entity]

        mock_client.recognize_entities.return_value = [mock_doc_result]
        extractor._client = mock_client

        results = extractor.extract_entities(["Microsoft was founded in Redmond."])
        assert len(results) == 1
        assert len(results[0].entities) == 1
        assert results[0].entities[0].text == "Microsoft"
        assert results[0].entities[0].category == "Organization"

    def test_extract_entities_api_error(self) -> None:
        """extract_entities handles API errors gracefully."""
        extractor = self._make_extractor()
        mock_client = MagicMock()
        mock_client.recognize_entities.side_effect = AzureError("Service unavailable")
        extractor._client = mock_client

        results = extractor.extract_entities(["test text"])
        assert len(results) == 1
        assert results[0].is_error
        assert "API call failed" in results[0].error_message

    def test_extract_entities_doc_error(self) -> None:
        """extract_entities handles per-document errors."""
        extractor = self._make_extractor()
        mock_client = MagicMock()

        mock_doc_result = MagicMock()
        mock_doc_result.is_error = True
        mock_doc_result.error = MagicMock()
        mock_doc_result.error.code = "InvalidDocument"
        mock_doc_result.error.message = "Document too long"

        mock_client.recognize_entities.return_value = [mock_doc_result]
        extractor._client = mock_client

        results = extractor.extract_entities(["test"])
        assert len(results) == 1
        assert results[0].is_error
        assert "InvalidDocument" in results[0].error_message

    def test_extract_entities_from_records(self) -> None:
        """extract_entities_from_records enriches records with entities."""
        extractor = self._make_extractor()
        mock_client = MagicMock()

        mock_entity = MagicMock()
        mock_entity.text = "Seattle"
        mock_entity.category = "Location"
        mock_entity.subcategory = "City"
        mock_entity.confidence_score = 0.95
        mock_entity.offset = 0
        mock_entity.length = 7

        mock_doc = MagicMock()
        mock_doc.is_error = False
        mock_doc.id = "0"
        mock_doc.entities = [mock_entity]
        mock_client.recognize_entities.return_value = [mock_doc]
        extractor._client = mock_client

        records = [{"id": "r1", "text": "Seattle weather report"}]
        enriched = extractor.extract_entities_from_records(records)
        assert len(enriched) == 1
        assert len(enriched[0]["extracted_entities"]) == 1
        assert enriched[0]["extracted_entities"][0]["category"] == "Location"

    def test_batch_size_capped(self) -> None:
        """Batch size is capped at _MAX_BATCH (25)."""
        extractor = self._make_extractor(batch_size=100)
        assert extractor.batch_size == 25

    def test_enrich_bronze_to_silver(self, tmp_path: Path) -> None:
        """enrich_bronze_to_silver reads JSONL and writes enriched output."""
        extractor = self._make_extractor()
        mock_client = MagicMock()

        mock_doc = MagicMock()
        mock_doc.is_error = False
        mock_doc.id = "0"
        mock_doc.entities = []
        mock_client.recognize_entities.return_value = [mock_doc]
        extractor._client = mock_client

        bronze_file = tmp_path / "bronze.jsonl"
        silver_file = tmp_path / "silver.jsonl"
        bronze_file.write_text('{"id": "1", "text": "test data"}\n', encoding="utf-8")

        stats = extractor.enrich_bronze_to_silver(str(bronze_file), str(silver_file))
        assert stats["total"] == 1
        assert stats["enriched"] == 1
        assert stats["errors"] == 0
        assert silver_file.exists()


# ---------------------------------------------------------------------------
# TextSummarizer tests (mock OpenAI)
# ---------------------------------------------------------------------------


class TestTextSummarizer:
    """Tests for the TextSummarizer class."""

    def _make_summarizer(self, **kwargs: Any) -> Any:
        from csa_platform.ai_integration.enrichment.text_summarizer import TextSummarizer

        defaults = {"endpoint": "https://test.openai.azure.com", "api_key": "test-key", "max_input_tokens": 100}
        defaults.update(kwargs)
        return TextSummarizer(**defaults)

    def test_summarize_short_text(self) -> None:
        """summarize handles text that fits in a single chunk."""
        summarizer = self._make_summarizer()
        mock_client = MagicMock()

        mock_choice = MagicMock()
        mock_choice.message.content = "This is a summary."
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        summarizer._client = mock_client

        result = summarizer.summarize("A short document text here.", mode="abstractive", style="paragraph")
        assert result.summary == "This is a summary."
        assert result.mode == "abstractive"
        assert result.style == "paragraph"
        assert result.chunks_processed == 1
        assert not result.is_error

    def test_summarize_long_text_hierarchical(self) -> None:
        """summarize auto-chunks long text and combines summaries."""
        summarizer = self._make_summarizer(max_input_tokens=10)
        mock_client = MagicMock()

        # First calls: chunk summaries; last call: final combined summary
        mock_choice = MagicMock()
        mock_choice.message.content = "Combined summary."
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        summarizer._client = mock_client

        long_text = "First paragraph.\n\n" * 20  # Will trigger chunking
        result = summarizer.summarize(long_text)
        assert not result.is_error
        assert result.chunks_processed >= 1

    def test_summarize_error_handling(self) -> None:
        """summarize returns error result on API failure."""
        summarizer = self._make_summarizer()
        mock_client = MagicMock()
        mock_client.chat.completions.create.side_effect = Exception("API timeout")
        summarizer._client = mock_client

        result = summarizer.summarize("Some text")
        assert result.is_error
        assert "API timeout" in result.error_message

    def test_summarize_batch(self) -> None:
        """summarize_batch processes multiple texts."""
        summarizer = self._make_summarizer()
        mock_client = MagicMock()

        mock_choice = MagicMock()
        mock_choice.message.content = "Summary."
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        summarizer._client = mock_client

        results = summarizer.summarize_batch(["text1", "text2"])
        assert len(results) == 2
        assert all(r.summary == "Summary." for r in results)

    def test_summarization_modes(self) -> None:
        """SummarizationMode enum has expected values."""
        from csa_platform.ai_integration.enrichment.text_summarizer import SummarizationMode

        assert SummarizationMode.EXTRACTIVE == "extractive"
        assert SummarizationMode.ABSTRACTIVE == "abstractive"

    def test_summarization_styles(self) -> None:
        """SummarizationStyle enum has expected values."""
        from csa_platform.ai_integration.enrichment.text_summarizer import SummarizationStyle

        assert SummarizationStyle.BULLET_POINTS == "bullet_points"
        assert SummarizationStyle.PARAGRAPH == "paragraph"
        assert SummarizationStyle.EXECUTIVE_SUMMARY == "executive_summary"

    def test_style_instruction_bullet_points(self) -> None:
        """_style_instruction generates bullet point instruction."""
        from csa_platform.ai_integration.enrichment.text_summarizer import SummarizationStyle, TextSummarizer

        instruction = TextSummarizer._style_instruction(SummarizationStyle.BULLET_POINTS, 200)
        assert "bulleted" in instruction.lower()

    def test_style_instruction_executive(self) -> None:
        """_style_instruction generates executive summary instruction."""
        from csa_platform.ai_integration.enrichment.text_summarizer import SummarizationStyle, TextSummarizer

        instruction = TextSummarizer._style_instruction(SummarizationStyle.EXECUTIVE_SUMMARY, 200)
        assert "executive" in instruction.lower()


# ---------------------------------------------------------------------------
# ModelEndpoint tests (mock Azure ML)
# ---------------------------------------------------------------------------


class TestModelEndpoint:
    """Tests for the ModelEndpoint class."""

    def _make_endpoint(self) -> Any:
        from csa_platform.ai_integration.model_serving.endpoint import ModelEndpoint

        return ModelEndpoint(
            workspace_name="test-workspace",
            resource_group="test-rg",
            subscription_id="test-sub",
        )

    def test_invoke_success(self) -> None:
        """invoke returns parsed JSON response with latency."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()
        mock_ml_client.online_endpoints.invoke.return_value = '{"prediction": 0.85}'
        endpoint._ml_client = mock_ml_client

        result = endpoint.invoke("crop-yield", {"features": [1.0, 2.0]})
        assert not result.is_error
        assert result.response == {"prediction": 0.85}
        assert result.latency_ms > 0

    def test_invoke_error(self) -> None:
        """invoke handles exceptions gracefully."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()
        mock_ml_client.online_endpoints.invoke.side_effect = AzureError("Endpoint not found")
        endpoint._ml_client = mock_ml_client

        result = endpoint.invoke("nonexistent", {"data": []})
        assert result.is_error
        assert "Endpoint not found" in result.error_message

    def test_invoke_non_json_response(self) -> None:
        """invoke handles non-JSON responses by returning raw value."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()
        mock_ml_client.online_endpoints.invoke.return_value = "plain text"
        endpoint._ml_client = mock_ml_client

        result = endpoint.invoke("test-endpoint", {"data": []})
        assert not result.is_error
        assert result.response == "plain text"

    def test_health_check_healthy(self) -> None:
        """health_check returns healthy status for succeeded endpoint."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()

        mock_ep = MagicMock()
        mock_ep.provisioning_state = "Succeeded"
        mock_ep.scoring_uri = "https://test.inference.ml.azure.com/score"
        mock_ep.traffic = {"default": 100}

        mock_deployment = MagicMock()
        mock_deployment.name = "default"
        mock_deployment.model = MagicMock()
        mock_deployment.model.name = "crop-yield"
        mock_deployment.model.version = "3"
        mock_deployment.instance_type = "Standard_DS3_v2"
        mock_deployment.instance_count = 1
        mock_deployment.provisioning_state = "Succeeded"

        mock_ml_client.online_endpoints.get.return_value = mock_ep
        mock_ml_client.online_deployments.list.return_value = [mock_deployment]
        endpoint._ml_client = mock_ml_client

        health = endpoint.health_check("crop-yield")
        assert health.is_healthy
        assert health.provisioning_state == "Succeeded"
        assert len(health.deployments) == 1

    def test_health_check_failure(self) -> None:
        """health_check returns unhealthy on exception."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()
        mock_ml_client.online_endpoints.get.side_effect = AzureError("Not found")
        endpoint._ml_client = mock_ml_client

        health = endpoint.health_check("nonexistent")
        assert not health.is_healthy
        assert health.provisioning_state == "Unknown"

    def test_set_traffic_validation(self) -> None:
        """set_traffic raises ValueError when percentages don't sum to 100."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()
        endpoint._ml_client = mock_ml_client

        with pytest.raises(ValueError, match="sum to 100"):
            endpoint.set_traffic("test-ep", {"v1": 50, "v2": 40})

    def test_list_endpoints(self) -> None:
        """list_endpoints returns endpoint summaries."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()

        mock_ep = MagicMock()
        mock_ep.name = "test-ep"
        mock_ep.provisioning_state = "Succeeded"
        mock_ep.scoring_uri = "https://test.score"
        mock_ep.traffic = {"default": 100}
        mock_ep.tags = {"platform": "csa"}

        mock_ml_client.online_endpoints.list.return_value = [mock_ep]
        endpoint._ml_client = mock_ml_client

        result = endpoint.list_endpoints()
        assert len(result) == 1
        assert result[0]["name"] == "test-ep"

    def test_get_metrics(self) -> None:
        """get_metrics returns endpoint metrics based on health check."""
        endpoint = self._make_endpoint()
        mock_ml_client = MagicMock()

        mock_ep = MagicMock()
        mock_ep.provisioning_state = "Succeeded"
        mock_ep.scoring_uri = "https://test.score"
        mock_ep.traffic = {"default": 100}
        mock_ml_client.online_endpoints.get.return_value = mock_ep
        mock_ml_client.online_deployments.list.return_value = []
        endpoint._ml_client = mock_ml_client

        metrics = endpoint.get_metrics("test-ep")
        assert metrics["endpoint_name"] == "test-ep"
        assert metrics["provisioning_state"] == "Succeeded"


# ---------------------------------------------------------------------------
# RAG Config tests (Pydantic settings)
# ---------------------------------------------------------------------------


class TestRAGConfig:
    """Tests for RAG configuration models."""

    def test_rag_settings_defaults(self) -> None:
        """RAGSettings has sensible defaults."""
        from csa_platform.ai_integration.rag.config import RAGSettings

        settings = RAGSettings()
        assert settings.chunk.chunk_size == 512
        assert settings.chunk.chunk_overlap == 64
        assert settings.search.top_k == 5
        assert settings.azure_openai.embedding_dimensions == 1536

    def test_chunk_settings_defaults(self) -> None:
        """ChunkSettings has expected defaults."""
        from csa_platform.ai_integration.rag.config import ChunkSettings

        settings = ChunkSettings()
        assert settings.split_strategy == "sentence"
        assert settings.min_chunk_length == 50

    def test_search_settings_defaults(self) -> None:
        """SearchSettings has expected defaults."""
        from csa_platform.ai_integration.rag.config import SearchSettings

        settings = SearchSettings()
        assert settings.score_threshold == 0.70
        assert settings.use_semantic_reranker is True
