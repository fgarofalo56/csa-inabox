"""Compat-shim tests for :mod:`csa_platform.ai_integration.rag.pipeline`.

Proves that every symbol the pre-split codebase imported from the
legacy ``pipeline`` module still resolves via the compat shim after
the CSA-0133 service-layer extraction.
"""

from __future__ import annotations


def test_legacy_imports_resolve() -> None:
    """Every public symbol that ever lived in ``pipeline`` is still importable."""
    from csa_platform.ai_integration.rag.pipeline import (
        Chunk,
        DocumentChunker,
        EmbeddingGenerator,
        RAGPipeline,
        SearchResult,
        VectorStore,
        create_pipeline_from_config,
        main,
    )

    # Spot-check the constructors so we know the shim re-exported the
    # real classes rather than stale stubs.
    chunker = DocumentChunker(chunk_size=200, chunk_overlap=10, min_chunk_length=5)
    assert chunker.chunk_size == 200
    assert Chunk(id="a", text="b", source="c").chunk_index == 0
    assert SearchResult(id="a", text="b", score=0.1, source="s").metadata == {}
    assert EmbeddingGenerator(endpoint="", api_key="k").batch_size == 100
    assert VectorStore(endpoint="", api_key="k").index_name == "csa-rag-index"
    assert callable(create_pipeline_from_config)
    assert callable(main)
    # The class itself must still be the same type the tests use with MagicMock(spec=...).
    assert RAGPipeline.__name__ == "RAGPipeline"


def test_package_root_exports_service() -> None:
    """The new facade + legacy types are both importable from the package root."""
    from csa_platform.ai_integration.rag import (
        AnswerResponse,
        Chunk,
        Citation,
        DocumentChunker,
        EmbeddingGenerator,
        IndexReport,
        RAGPipeline,
        RAGService,
        RAGSettings,
        SearchResult,
        VectorStore,
    )

    assert RAGService.__name__ == "RAGService"
    assert RAGPipeline.__name__ == "RAGPipeline"
    # Sanity: importing the package root must not trigger heavy Azure
    # SDK loads.  If someone adds a top-level `openai` import, this
    # test won't catch it directly but the fast run time (<100ms) will.
    _ = (AnswerResponse, Citation, IndexReport, RAGSettings, DocumentChunker, EmbeddingGenerator, VectorStore, Chunk, SearchResult)


def test_pipeline_module_has_logger() -> None:
    """Ensure the shim still configures structlog (side-effect on import)."""
    from csa_platform.ai_integration.rag import pipeline

    assert pipeline.logger is not None
