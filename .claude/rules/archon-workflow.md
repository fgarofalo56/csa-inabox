# Task-Driven Development (Native-First)

> **Migration note (2026-05):** Archon v1 was archived by its author in April
> 2026. This rule file used to bind Claude to use `find_tasks` / `manage_task`
> / `rag_*` calls that no longer have a long-lived backend. Updated below to
> use native tools.

## Task Cycle

1. **Get task**: Use `TodoWrite` (in-session) or `gh issue view <num>` (cross-session)
2. **Start work**: Set TodoWrite item to `in_progress`, or `gh issue comment <num> -b "Starting work"`
3. **Research**: Use the knowledge lookup workflow below
4. **Implement**: Write code
5. **Review**: Set TodoWrite item to `completed`, open PR (review is implicit at PR-open)
6. **Complete**: `gh issue close <num>` on merge (or auto-close via "Closes #N" in PR body)

NEVER skip status updates. NEVER code without checking current tasks first.

## Knowledge Lookup Workflow

Use Context7 MCP for library / framework docs and filesystem grep for
project-internal docs:

```
# Library docs (FastAPI, React, Pydantic, Azure SDK, etc.)
mcp__plugin_context7_context7__query-docs query="keyword keyword" library="<lib>" match_count=5

# Project-internal docs
Grep "<query>" path=".claude/reference/" output_mode=content -C=2
Grep "<query>" path="docs/" output_mode=content -C=2

# Code examples in this repo
Grep "<pattern>" type="<lang>" output_mode=content -C=3 head_limit=10
```

Keep queries to 2-5 keywords. Run multiple focused queries rather than one
broad query.
