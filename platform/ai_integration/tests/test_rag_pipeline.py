"""Tests for the RAG pipeline and AI enrichment modules.

Tests DocumentChunker, RAGPipeline query flow, and enrichment modules
(entity extraction, classification, summarization) with mocked Azure
OpenAI and AI Search clients.
"""

from __future__ import annotations

from platform.ai_integration.rag.pipeline import (
    Chunk,
    DocumentChunker,
    EmbeddingGenerator,
    RAGPipeline,
    SearchResult,
    VectorStore,
)
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# DocumentChunker Tests
# ---------------------------------------------------------------------------


class TestDocumentChunker:
    """Test the document chunking engine."""

    def test_basic_sentence_chunking(self):
        chunker = DocumentChunker(chunk_size=100, chunk_overlap=20, min_chunk_length=10)
        text = (
            "The quick brown fox jumped over the lazy dog. "
            "It was a beautiful day in the park. "
            "Children were playing on the swings. "
            "Birds were singing in the trees."
        )
        chunks = chunker.chunk_text(text, source="test.txt")
        assert len(chunks) >= 1
        assert all(isinstance(c, Chunk) for c in chunks)
        assert all(c.source == "test.txt" for c in chunks)

    def test_chunk_ids_are_deterministic(self):
        chunker = DocumentChunker(chunk_size=50, chunk_overlap=10, min_chunk_length=5)
        text = "Hello world. This is a test. Another sentence here."
        chunks_a = chunker.chunk_text(text, source="file.txt")
        chunks_b = chunker.chunk_text(text, source="file.txt")
        assert [c.id for c in chunks_a] == [c.id for c in chunks_b]

    def test_chunk_ids_differ_for_different_sources(self):
        chunker = DocumentChunker(chunk_size=50, chunk_overlap=10, min_chunk_length=5)
        text = "Hello world. This is a test."
        chunks_a = chunker.chunk_text(text, source="file_a.txt")
        chunks_b = chunker.chunk_text(text, source="file_b.txt")
        assert chunks_a[0].id != chunks_b[0].id

    def test_minimum_chunk_length_filtering(self):
        chunker = DocumentChunker(chunk_size=100, chunk_overlap=10, min_chunk_length=50)
        text = "Hi. OK. This is a much longer sentence that should pass the minimum length filter."
        chunks = chunker.chunk_text(text, source="test.txt")
        for chunk in chunks:
            assert len(chunk.text) >= 50

    def test_paragraph_strategy(self):
        chunker = DocumentChunker(
            chunk_size=200, chunk_overlap=20, min_chunk_length=10, split_strategy="paragraph",
        )
        text = "First paragraph with content.\n\nSecond paragraph with more.\n\nThird paragraph final."
        chunks = chunker.chunk_text(text, source="test.txt")
        assert len(chunks) >= 1

    def test_token_strategy(self):
        chunker = DocumentChunker(
            chunk_size=5, chunk_overlap=2, min_chunk_length=3, split_strategy="token",
        )
        text = "one two three four five six seven eight nine ten"
        chunks = chunker.chunk_text(text, source="test.txt")
        assert len(chunks) >= 1

    def test_overlap_less_than_chunk_size(self):
        with pytest.raises(ValueError, match="chunk_overlap must be less than chunk_size"):
            DocumentChunker(chunk_size=50, chunk_overlap=50)

    def test_metadata_passed_through(self):
        chunker = DocumentChunker(chunk_size=200, chunk_overlap=20, min_chunk_length=10)
        text = "Some text content that is long enough to produce a chunk."
        metadata = {"department": "finance", "year": "2024"}
        chunks = chunker.chunk_text(text, source="test.txt", metadata=metadata)
        assert len(chunks) >= 1
        assert chunks[0].metadata["department"] == "finance"

    def test_empty_text_produces_no_chunks(self):
        chunker = DocumentChunker(chunk_size=100, chunk_overlap=10, min_chunk_length=10)
        chunks = chunker.chunk_text("", source="test.txt")
        assert len(chunks) == 0


# ---------------------------------------------------------------------------
# RAGPipeline Query Tests (Mocked)
# ---------------------------------------------------------------------------


class TestRAGPipeline:
    """Test the RAG pipeline query flow with mocked dependencies."""

    @pytest.fixture
    def mock_pipeline(self):
        """Create a RAG pipeline with mocked embedder and vector store."""
        chunker = DocumentChunker(chunk_size=512, chunk_overlap=64, min_chunk_length=50)
        embedder = MagicMock(spec=EmbeddingGenerator)
        vector_store = MagicMock(spec=VectorStore)

        # Mock embedding generation
        embedder.embed_single.return_value = [0.1] * 1536
        embedder.embed_texts.return_value = [[0.1] * 1536]

        # Mock OpenAI client for chat
        mock_client = MagicMock()
        mock_choice = MagicMock()
        mock_choice.message.content = "Based on the context, crop yields increased 15% in 2023."
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        embedder._get_client.return_value = mock_client

        pipeline = RAGPipeline(
            chunker=chunker,
            embedder=embedder,
            vector_store=vector_store,
            top_k=3,
            score_threshold=0.7,
        )
        return pipeline, embedder, vector_store

    def test_query_returns_answer(self, mock_pipeline):
        pipeline, embedder, vector_store = mock_pipeline

        vector_store.search.return_value = [
            SearchResult(id="1", text="Crop yields in 2023 increased by 15%.", score=0.95, source="usda_report.txt"),
            SearchResult(id="2", text="USDA data shows improvement in wheat production.", score=0.88, source="usda_wheat.txt"),
        ]

        result = pipeline.query("What are the crop yield trends?")

        assert "answer" in result
        assert "sources" in result
        assert "context_chunks" in result
        assert len(result["sources"]) == 2
        embedder.embed_single.assert_called_once_with("What are the crop yield trends?")

    def test_query_no_results_returns_message(self, mock_pipeline):
        pipeline, _embedder, vector_store = mock_pipeline
        vector_store.search.return_value = []

        result = pipeline.query("Something with no context")

        assert "No relevant context" in result["answer"]
        assert result["sources"] == []

    def test_query_passes_filters(self, mock_pipeline):
        pipeline, _embedder, vector_store = mock_pipeline
        vector_store.search.return_value = []

        pipeline.query("test", filters="source eq 'usda'")

        call_kwargs = vector_store.search.call_args
        assert call_kwargs.kwargs.get("filters") == "source eq 'usda'" or \
               (len(call_kwargs.args) > 4 and call_kwargs.args[4] == "source eq 'usda'")

    def test_ingest_text(self, mock_pipeline):
        pipeline, embedder, vector_store = mock_pipeline
        vector_store.upsert_documents.return_value = 1

        count = pipeline.ingest_text(
            "This is a sufficiently long test document for chunking purposes. " * 5,
            source="inline-test",
        )

        assert count >= 1
        embedder.embed_texts.assert_called_once()
        vector_store.upsert_documents.assert_called_once()


# ---------------------------------------------------------------------------
# Enrichment Module Tests (Mocked)
# ---------------------------------------------------------------------------


class TestEntityExtractor:
    """Test entity extraction with mocked Azure AI Language client."""

    def test_extract_entities(self):
        from platform.ai_integration.enrichment.entity_extractor import (
            EntityExtractor,
        )

        extractor = EntityExtractor(endpoint="https://test.cognitiveservices.azure.com", api_key="test-key")

        # Mock the client
        mock_client = MagicMock()
        mock_entity = MagicMock()
        mock_entity.text = "Microsoft"
        mock_entity.category = "Organization"
        mock_entity.subcategory = None
        mock_entity.confidence_score = 0.98
        mock_entity.offset = 0
        mock_entity.length = 9

        mock_doc = MagicMock()
        mock_doc.is_error = False
        mock_doc.id = "0"
        mock_doc.entities = [mock_entity]

        mock_client.recognize_entities.return_value = [mock_doc]
        extractor._client = mock_client

        results = extractor.extract_entities(["Microsoft was founded in Redmond."])

        assert len(results) == 1
        assert not results[0].is_error
        assert len(results[0].entities) == 1
        assert results[0].entities[0].category == "Organization"

    def test_extract_entities_error_handling(self):
        from platform.ai_integration.enrichment.entity_extractor import EntityExtractor

        extractor = EntityExtractor(endpoint="https://test.cognitiveservices.azure.com", api_key="test-key")

        mock_client = MagicMock()
        mock_client.recognize_entities.side_effect = Exception("API error")
        extractor._client = mock_client

        results = extractor.extract_entities(["Test text"])

        assert len(results) == 1
        assert results[0].is_error


class TestDocumentClassifier:
    """Test document classification with mocked Azure OpenAI client."""

    def test_classify_single(self):
        from platform.ai_integration.enrichment.document_classifier import (
            DocumentClassifier,
        )

        classifier = DocumentClassifier(endpoint="https://test.openai.azure.com", api_key="test-key")

        mock_client = MagicMock()
        mock_choice = MagicMock()
        mock_choice.message.content = '{"category": "environment", "subcategory": "air_quality", "confidence": 0.92, "reasoning": "Text discusses AQI readings."}'
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        classifier._client = mock_client

        result = classifier.classify_single("AQI reading of 150 was recorded in Denver today.")

        assert result.category == "environment"
        assert result.subcategory == "air_quality"
        assert result.confidence == 0.92
        assert not result.is_error


class TestTextSummarizer:
    """Test text summarization with mocked Azure OpenAI client."""

    def test_summarize(self):
        from platform.ai_integration.enrichment.text_summarizer import (
            TextSummarizer,
        )

        summarizer = TextSummarizer(endpoint="https://test.openai.azure.com", api_key="test-key")

        mock_client = MagicMock()
        mock_choice = MagicMock()
        mock_choice.message.content = "Crop yields increased significantly in FY2023."
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_client.chat.completions.create.return_value = mock_response
        summarizer._client = mock_client

        result = summarizer.summarize(
            "A long document about crop yields and agriculture." * 10,
            style="executive_summary",
            max_length=50,
        )

        assert not result.is_error
        assert result.summary != ""
        assert result.style == "executive_summary"
        assert result.mode == "abstractive"
