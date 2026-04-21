"""Expose Copilot read-only surfaces as MCP resources.

An MCP resource is a read-only document addressed by URI (``scheme://``
path).  The Copilot exposes two families:

* ``corpus://search/{query}`` — returns top-k chunks.
* ``decision-tree://{tree_id}`` — returns the YAML body of a tree.

The bridge keeps parsing + URI handling in pure-Python helpers so the
unit tests can exercise them without the MCP SDK loaded.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from apps.copilot.tools.readonly import (
    ReadRepoFileInput,
    ReadRepoFileTool,
    SearchCorpusInput,
    SearchCorpusTool,
    WalkDecisionTreeInput,
    WalkDecisionTreeTool,
)


@dataclass(frozen=True)
class ResourceDescriptor:
    """Minimal MCP resource descriptor (name, uri, description)."""

    uri: str
    name: str
    description: str
    mime_type: str = "application/json"


_CORPUS_URI_PATTERN = re.compile(r"^corpus://search/(?P<query>.+)$")
_DECISION_TREE_URI_PATTERN = re.compile(r"^decision-tree://(?P<tree_id>[^/]+)$")
_REPO_FILE_URI_PATTERN = re.compile(r"^repo-file://(?P<path>.+)$")


def parse_corpus_uri(uri: str) -> str | None:
    """Return the decoded query string, or None when *uri* does not match."""
    match = _CORPUS_URI_PATTERN.match(uri)
    if not match:
        return None
    return unquote(match.group("query"))


def parse_decision_tree_uri(uri: str) -> str | None:
    """Return the tree id, or None when *uri* does not match."""
    match = _DECISION_TREE_URI_PATTERN.match(uri)
    if not match:
        return None
    return match.group("tree_id")


def parse_repo_file_uri(uri: str) -> str | None:
    """Return the repo-relative path, or None when *uri* does not match."""
    match = _REPO_FILE_URI_PATTERN.match(uri)
    if not match:
        return None
    return unquote(match.group("path"))


def static_resource_descriptors() -> list[ResourceDescriptor]:
    """Return the descriptors advertised for every MCP client session.

    The URIs carry placeholders (``{query}``, ``{tree_id}``) so clients
    can template them; production MCP clients expand the templates
    before calling :func:`read_resource`.
    """
    return [
        ResourceDescriptor(
            uri="corpus://search/{query}",
            name="CSA corpus search",
            description=(
                "Retrieve the top-k grounded context chunks for a natural-"
                "language query.  The query segment must be URL-encoded."
            ),
        ),
        ResourceDescriptor(
            uri="decision-tree://{tree_id}",
            name="CSA decision tree",
            description=(
                "Return the raw YAML body of a decision tree under "
                "``decision-trees/``.  The ``tree_id`` is the filename stem."
            ),
            mime_type="text/yaml",
        ),
        ResourceDescriptor(
            uri="repo-file://{path}",
            name="Allowlisted repo file",
            description=(
                "Read a bounded text file from an allowlisted repo path "
                "(see apps.copilot.tools.readonly.ALLOWED_READ_ROOTS)."
            ),
            mime_type="text/plain",
        ),
    ]


async def read_corpus_resource(
    search_tool: SearchCorpusTool,
    query: str,
    *,
    top_k: int = 5,
) -> dict[str, Any]:
    """Invoke the corpus search tool and return a JSON-serialisable dict."""
    result = await search_tool(SearchCorpusInput(query=query, top_k=top_k))
    return {"query": query, "chunks": [c.model_dump(mode="json") for c in result.chunks]}


async def read_decision_tree_resource(
    walker: WalkDecisionTreeTool,
    tree_id: str,
) -> dict[str, Any]:
    """Return the initial walk of a decision tree (no choices → start node)."""
    result = await walker(WalkDecisionTreeInput(tree_id=tree_id, choices=[]))
    return result.model_dump(mode="json")


async def read_repo_file_resource(
    reader: ReadRepoFileTool,
    path: str,
) -> dict[str, Any]:
    """Invoke the repo-file reader and return a JSON-serialisable dict."""
    result = await reader(ReadRepoFileInput(path=path))
    return result.model_dump(mode="json")


def default_decision_trees_root(repo_root: Path) -> Path:
    """Conventional location for decision tree YAMLs."""
    return repo_root / "decision-trees"


__all__ = [
    "ResourceDescriptor",
    "default_decision_trees_root",
    "parse_corpus_uri",
    "parse_decision_tree_uri",
    "parse_repo_file_uri",
    "read_corpus_resource",
    "read_decision_tree_resource",
    "read_repo_file_resource",
    "static_resource_descriptors",
]
