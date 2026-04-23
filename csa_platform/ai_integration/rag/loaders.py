"""Document loaders for the RAG pipeline (CSA-0097).

Two local-text loaders plus one optional Azure Document Intelligence
path feed :class:`~csa_platform.ai_integration.rag.chunker.DocumentChunker`:

* :func:`load_pdf` — ``pypdf``-based page-by-page extraction.  When the
  ``RAG_DOC_INTELLIGENCE_ENDPOINT`` environment variable is set, the
  Azure Document Intelligence path is attempted first and the loader
  falls back to pypdf on any failure.
* :func:`load_docx` — ``python-docx``-based paragraph walker that
  segments the document at heading styles.

All third-party SDK imports are deferred into the function body so the
RAG package stays importable without ``pypdf``, ``python-docx``, or the
Azure Document Intelligence client installed.

Each loader returns a ``list[tuple[str, str | None]]`` — the first
element is the segment text, the second is an optional section anchor
(``"Page 3"``, ``"Heading: Setup"``) that :meth:`DocumentChunker._chunks_from_loader_segments`
threads through to :attr:`Chunk.section_anchor`.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# PDF
# ---------------------------------------------------------------------------


def _load_pdf_pypdf(path: Path) -> list[tuple[str, str | None]]:
    """Extract page text with ``pypdf``.  Raises if the dep is missing."""
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover — guard exercised at boot
        msg = (
            "PDF ingestion requires the 'pypdf' package. Install with "
            "`pip install pypdf` or add the 'platform' extra."
        )
        raise RuntimeError(msg) from exc

    reader = PdfReader(str(path))
    segments: list[tuple[str, str | None]] = []
    for page_idx, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            logger.exception("pdf.page_extract_failed", path=str(path), page=page_idx)
            text = ""
        segments.append((text, f"Page {page_idx}"))
    return segments


def _load_pdf_document_intelligence(
    path: Path, endpoint: str
) -> list[tuple[str, str | None]]:
    """Extract structured text with Azure Document Intelligence.

    Gated on ``RAG_DOC_INTELLIGENCE_ENDPOINT``.  The API key may be
    supplied via ``RAG_DOC_INTELLIGENCE_KEY``; otherwise
    :class:`DefaultAzureCredential` is used (both are lazy-imported).
    """
    from azure.ai.documentintelligence import DocumentIntelligenceClient
    from azure.ai.documentintelligence.models import AnalyzeResult

    api_key = os.environ.get("RAG_DOC_INTELLIGENCE_KEY", "")
    credential: Any
    if api_key:
        from azure.core.credentials import AzureKeyCredential

        credential = AzureKeyCredential(api_key)
    else:
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential()

    client = DocumentIntelligenceClient(endpoint=endpoint, credential=credential)
    with path.open("rb") as fh:
        poller = client.begin_analyze_document("prebuilt-layout", body=fh)
    result: AnalyzeResult = poller.result()

    segments: list[tuple[str, str | None]] = []
    pages = getattr(result, "pages", None) or []
    for page in pages:
        page_number = getattr(page, "page_number", None) or len(segments) + 1
        lines = getattr(page, "lines", None) or []
        text = "\n".join(getattr(line, "content", "") for line in lines)
        segments.append((text, f"Page {page_number}"))
    return segments


def load_pdf(path: Path) -> list[tuple[str, str | None]]:
    """Load *path* as a list of ``(page_text, page_anchor)`` segments.

    Selection order:

    1. If ``RAG_DOC_INTELLIGENCE_ENDPOINT`` is set, Azure Document
       Intelligence is tried first.  Any exception falls back to pypdf.
    2. Otherwise pypdf extracts text directly.
    """
    endpoint = os.environ.get("RAG_DOC_INTELLIGENCE_ENDPOINT", "").strip()
    if endpoint:
        try:
            return _load_pdf_document_intelligence(path, endpoint)
        except Exception:
            logger.exception(
                "pdf.doc_intelligence_failed_fallback_pypdf",
                path=str(path),
            )
    return _load_pdf_pypdf(path)


# ---------------------------------------------------------------------------
# DOCX
# ---------------------------------------------------------------------------


def _is_heading_style(style_name: str | None) -> bool:
    if not style_name:
        return False
    lowered = style_name.lower()
    return lowered.startswith("heading") or lowered in {"title", "subtitle"}


def load_docx(path: Path) -> list[tuple[str, str | None]]:
    """Extract paragraphs from a DOCX as ``(text, section_anchor)`` segments.

    Segments break on heading-styled paragraphs.  Plain DOCX files with
    no headings produce a single ``(body, None)`` segment.
    """
    try:
        import docx  # type: ignore[import-untyped]  # python-docx
    except ImportError as exc:  # pragma: no cover — guard exercised at boot
        msg = (
            "DOCX ingestion requires the 'python-docx' package. Install with "
            "`pip install python-docx` or add the 'platform' extra."
        )
        raise RuntimeError(msg) from exc

    document = docx.Document(str(path))
    segments: list[tuple[str, str | None]] = []
    current_heading: str | None = None
    current_body: list[str] = []

    def _flush() -> None:
        if current_body:
            anchor = f"Heading: {current_heading}" if current_heading else None
            segments.append(("\n".join(current_body), anchor))

    for paragraph in document.paragraphs:
        style_name = getattr(paragraph.style, "name", None) if paragraph.style else None
        text = paragraph.text or ""
        if _is_heading_style(style_name):
            _flush()
            current_heading = text.strip() or current_heading
            current_body = []
            continue
        if text.strip():
            current_body.append(text)

    _flush()
    # If the doc had no body paragraphs at all, return an empty list so
    # the chunker short-circuits gracefully.
    return segments


__all__ = ["load_docx", "load_pdf"]
