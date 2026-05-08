"""Drain Cosmos `copilot.backlog` items into GitHub Issues.

Run by ``.github/workflows/copilot-backlog-drain.yml``. Reads up to
``COSMOS_MAX_BATCH`` items where ``status='open'``, files a GitHub
Issue per item with a label that matches the kind, and flips the
Cosmos item to ``status='promoted'`` with a stamp of the issue number.

Items submitted with ``X-Copilot-Opt-Out: 1`` were never persisted, so
this script only ever sees consenting submissions.

Environment:

==============================  ===========================================
COSMOS_ENDPOINT                 Cosmos account URL (e.g. https://...:443/)
COSMOS_DATABASE                 default: copilot
COSMOS_BACKLOG_CONTAINER        default: backlog
COSMOS_MAX_BATCH                default: 25
GITHUB_TOKEN                    set by Actions
GITHUB_REPOSITORY               set by Actions ("owner/name")
==============================  ===========================================
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

from azure.cosmos import CosmosClient, PartitionKey  # type: ignore
from azure.cosmos.exceptions import CosmosResourceNotFoundError  # type: ignore
from azure.identity import DefaultAzureCredential  # type: ignore
from github import Github  # type: ignore

KIND_LABEL = {
    "feature": "csa-feature-request",
    "bug": "csa-bug",
    "uncovered": "csa-uncovered",
}
# Any kind we don't recognise gets the generic "from-copilot" label
# only. Better to file under-tagged than not at all — maintainers can
# always re-label.
DEFAULT_LABELS = ["from-copilot"]


def _trunc(s: str | None, limit: int) -> str:
    if not s:
        return ""
    s = str(s)
    return s if len(s) <= limit else (s[: limit - 1] + "…")


def _build_body(item: dict[str, Any]) -> str:
    description = _trunc(item.get("description"), 8000)
    page = item.get("page_url") or "(unknown)"
    actor = item.get("actor") or "(unknown)"
    source = item.get("source") or "(unknown)"
    sid = item.get("session_id") or "(none)"
    cid = item.get("conversation_id") or "(none)"
    ts = item.get("ts")
    when = (
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
        if isinstance(ts, (int, float)) else "(unknown)"
    )

    return (
        f"{description}\n\n"
        "---\n\n"
        "_Filed automatically by the Copilot backlog drain. "
        "Submitted via the docs widget; redacted server-side._\n\n"
        f"- **kind:** `{item.get('kind')}`\n"
        f"- **source:** `{source}`\n"
        f"- **submitted:** `{when}`\n"
        f"- **page:** {page}\n"
        f"- **session id:** `{sid}`\n"
        f"- **conversation id:** `{cid}`\n"
        f"- **actor (hashed IP):** `{actor}`\n"
    )


def main() -> int:
    endpoint = os.environ["COSMOS_ENDPOINT"]
    database = os.environ.get("COSMOS_DATABASE", "copilot")
    container_name = os.environ.get("COSMOS_BACKLOG_CONTAINER", "backlog")
    max_batch = int(os.environ.get("COSMOS_MAX_BATCH", "25"))

    cred = DefaultAzureCredential()
    cosmos = CosmosClient(endpoint, credential=cred)
    db = cosmos.get_database_client(database)
    container = db.get_container_client(container_name)

    # Pull a batch of open items. Sort by ts so we drain in roughly the
    # order they were submitted; new items will get caught next cycle.
    query = (
        "SELECT TOP @max * FROM c WHERE c.status = 'open' ORDER BY c.ts ASC"
    )
    items = list(container.query_items(
        query=query,
        parameters=[{"name": "@max", "value": max_batch}],
        enable_cross_partition_query=True,
    ))
    if not items:
        print("No open backlog items.")
        return 0

    gh = Github(os.environ["GITHUB_TOKEN"])
    repo = gh.get_repo(os.environ["GITHUB_REPOSITORY"])

    promoted = 0
    failed = 0
    for item in items:
        kind = (item.get("kind") or "").strip().lower()
        title = _trunc(item.get("title"), 200) or f"(unnamed {kind} from copilot)"
        # Title prefix mirrors what the user-facing issue templates use,
        # so the manual + automated submissions look consistent on the
        # issue list.
        prefix = {"bug": "bug:", "feature": "feat:", "uncovered": "docs:"}.get(kind, "copilot:")
        full_title = f"{prefix} {title}"
        body = _build_body(item)
        labels = list(DEFAULT_LABELS)
        if kind in KIND_LABEL:
            labels.append(KIND_LABEL[kind])

        try:
            issue = repo.create_issue(title=full_title, body=body, labels=labels)
            print(f"Created issue #{issue.number} for cosmos id={item['id']}")
        except Exception as e:
            failed += 1
            print(f"Failed to create issue for {item.get('id')}: {e}", file=sys.stderr)
            continue

        try:
            item["status"] = "promoted"
            item["github_issue"] = issue.number
            item["promoted_ts"] = time.time()
            container.replace_item(item=item["id"], body=item)
            promoted += 1
        except CosmosResourceNotFoundError:
            print(f"Cosmos item {item['id']} disappeared mid-drain; skipping update.",
                  file=sys.stderr)
        except Exception as e:
            failed += 1
            print(f"Failed to flip {item['id']} to promoted: {e}", file=sys.stderr)

    print(f"Drain complete: promoted={promoted}, failed={failed}, batch={len(items)}.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
