# Copilot Prompt Registry

Content-hashed, versioned prompt templates for the CSA Copilot.

## Why

Prompts ARE code. Silent edits to a prompt can cause undetected
regressions in every downstream rubric — the golden set may still pass
while the model behaves subtly differently.

This registry enforces the same discipline we apply to source:

* Every template ships with `id` + `version` frontmatter.
* The body is SHA-256 hashed at load time (newline- + whitespace-
  normalised so Windows checkouts agree with Linux).
* The hash is compared against `_hashes.json`.
* CI fails any PR that edits a template without bumping `version` and
  updating `_hashes.json`.

## Authoring a new prompt

1. Create `templates/<id>_v<n>.md` with the frontmatter block:
   ```
   ---
   id: <stable-id>
   version: v1
   description: One-line summary.
   ---
   <prompt body>
   ```
2. Run `python -c "from apps.copilot.prompts import default_registry; default_registry().write_snapshot()"`
   to regenerate `_hashes.json`.
3. Commit both files together.

## Bumping a prompt version

1. Edit the template body.
2. Bump the `version` frontmatter value (e.g. `v1` -> `v2`).
3. Regenerate `_hashes.json` as above.
4. Update the entry that consumes the prompt if it hard-codes the
   version.

The registry rejects any template whose computed hash does not match
`_hashes.json` (with a matching version) — raising
`PromptHashMismatchError`.

## Observability

Every `PromptSpec.to_log_dict()` yields:

```python
{
    "prompt_id": "ground_and_cite",
    "prompt_version": "v1",
    "prompt_content_hash": "7f7d0fef...",
}
```

The eval harness attaches these keys to every LLM call log event and
to the `copilot.generate` span, so a given response can always be
traced back to the exact template that produced it.

## Registered templates

| id                        | Consumed by                                               |
| ------------------------- | --------------------------------------------------------- |
| `ground_and_cite`         | `CopilotAgent.ask` system prompt                          |
| `refusal_off_scope`       | Refusal rationale shown to the LLM (future use)           |
| `conversation_summarizer` | `ConversationSummarizer` (multi-turn)                     |
