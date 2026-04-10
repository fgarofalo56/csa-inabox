# Archon Task-Driven Development

## Task Cycle

1. Get Task → `find_tasks(task_id="...")` or `find_tasks(filter_by="status", filter_value="todo")`
2. Start Work → `manage_task("update", task_id="...", status="doing")`
3. Research → Use RAG workflow below
4. Implement → Write code
5. Review → `manage_task("update", task_id="...", status="review")`
6. Complete → `manage_task("update", task_id="...", status="done")`

NEVER skip task updates. NEVER code without checking current tasks first.

## RAG Workflow

```python
rag_get_available_sources()
rag_search_knowledge_base(query="keyword keyword", source_id="src_xxx", match_count=5)
rag_search_code_examples(query="React hooks", match_count=3)
```

Keep queries to 2-5 keywords. Run multiple focused queries rather than one broad query.
