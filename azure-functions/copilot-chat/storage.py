"""Cosmos DB persistence for Copilot Chat conversations, feedback, and backlog.

Authentication uses the Function App's system-assigned managed identity via
``DefaultAzureCredential``. The MI must hold the **Cosmos DB Built-in Data
Contributor** role on the account. See ``deploy/main.bicep`` for the IaC.

Containers (database name: ``copilot``):

============== =========== ===================== ========================
container      partition   ttl                   purpose
============== =========== ===================== ========================
conversations  session_id  90 days               one chat turn per item
feedback       session_id  none                  thumbs up/down + comment
backlog        kind        none                  feature/bug/uncovered
============== =========== ===================== ========================

If ``COSMOS_ENDPOINT`` is unset OR the SDK is unavailable, every helper
no-ops and returns ``False``. The chat path stays healthy regardless of
analytics-pipeline state.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any

_log = logging.getLogger("copilot.storage")

_DB_NAME = os.environ.get("COSMOS_DATABASE", "copilot")
_CONTAINER_CONVERSATIONS = "conversations"
_CONTAINER_FEEDBACK = "feedback"
_CONTAINER_BACKLOG = "backlog"

_client: Any = None
_db: Any = None
_init_attempted = False


def _get_db() -> Any:
    global _client, _db, _init_attempted
    if _init_attempted:
        return _db
    _init_attempted = True

    endpoint = os.environ.get("COSMOS_ENDPOINT", "")
    if not endpoint:
        return None

    try:
        from azure.cosmos import CosmosClient  # type: ignore
        from azure.identity import DefaultAzureCredential  # type: ignore

        cred = DefaultAzureCredential()
        _client = CosmosClient(endpoint, credential=cred)
        _db = _client.get_database_client(_DB_NAME)
        return _db
    except Exception:
        _log.exception("Cosmos DB initialization failed; persistence disabled")
        return None


def _container(name: str) -> Any:
    db = _get_db()
    if db is None:
        return None
    try:
        return db.get_container_client(name)
    except Exception:
        _log.exception("get_container_client(%s) failed", name)
        return None


def is_enabled() -> bool:
    """True if Cosmos is reachable enough to write."""
    return _get_db() is not None


def write_conversation_turn(
    *,
    session_id: str,
    conversation_id: str,
    **fields: Any,
) -> bool:
    """Persist one chat turn. ``conversation_id`` becomes the doc id;
    ``session_id`` is the partition key. Returns True on success."""
    c = _container(_CONTAINER_CONVERSATIONS)
    if c is None:
        return False
    try:
        item = {
            "id": conversation_id,
            "session_id": session_id,
            "ts": time.time(),
            **fields,
        }
        c.upsert_item(item)
        return True
    except Exception:
        _log.exception("write_conversation_turn failed")
        return False


def write_feedback(
    *,
    session_id: str,
    conversation_id: str,
    **fields: Any,
) -> bool:
    """Persist a feedback record (thumbs up/down + optional comment)."""
    c = _container(_CONTAINER_FEEDBACK)
    if c is None:
        return False
    try:
        item = {
            "id": str(uuid.uuid4()),
            "session_id": session_id,
            "conversation_id": conversation_id,
            "ts": time.time(),
            **fields,
        }
        c.upsert_item(item)
        return True
    except Exception:
        _log.exception("write_feedback failed")
        return False


def write_backlog(*, kind: str, **fields: Any) -> bool:
    """Persist a backlog entry. ``kind`` is the partition key:

    - ``feature`` — explicit user-submitted use-case request
    - ``bug``     — explicit user-reported defect
    - ``uncovered`` — implicit signal that the chat couldn't help

    All entries default to ``status=open``; the cosmos→issues drain
    workflow flips them to ``promoted`` after creating the GitHub Issue.
    """
    c = _container(_CONTAINER_BACKLOG)
    if c is None:
        return False
    try:
        item = {
            "id": str(uuid.uuid4()),
            "kind": kind,
            "status": "open",
            "ts": time.time(),
            **fields,
        }
        c.upsert_item(item)
        return True
    except Exception:
        _log.exception("write_backlog failed")
        return False
