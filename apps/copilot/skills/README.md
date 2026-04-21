# Copilot Skills (Phase 3)

A **skill** is a declarative, YAML-authored workflow that composes one
or more Copilot tools to accomplish a higher-level task. Skills are
loaded from `apps/copilot/skills/skills/*.yaml`, validated against
`_schema.json`, and dispatched by `SkillDispatcher`.

## Authoring a new skill

Create a file `apps/copilot/skills/skills/<kebab-id>.yaml`:

```yaml
id: my-new-skill
name: "Human readable title"
description: "At least 20 characters describing what the skill does."
category: read           # or "execute" if any step uses an execute-class tool
inputs:
  - name: topic
    type: string
    description: "Topic to research."
    required: true
outputs:
  type: object
  fields:
    answer: "Description of the answer field."
steps:
  - id: fetch
    tool: read_repo_file
    input:
      path: docs/adr/README.md
  - id: search
    tool: search_corpus
    input:
      query: "{input.topic}"
      top_k: 5
fallback_if_tool_missing: fail
version: "1.0"
tags: [example, docs]
```

## Interpolation grammar

String values in `steps[].input` may contain `{...}` tokens resolving to:

- `{input.<field_name>}` — the caller-supplied input (with defaults
  applied for optional fields).
- `{<step_id>.output.<dotted.path>}` — a field from an earlier step's
  output.

When the entire string equals a single token, the native type is
preserved (lists stay lists). When a token is embedded in a longer
string, the resolved value is coerced with `str()`.

**No Python expressions are allowed.** Anything other than the two
shapes above raises `SkillInterpolationError`.

## Validation gates

Every YAML is validated at load time in three stages:

1. **JSON-schema** (`_schema.json`) — syntactic correctness.
2. **Pydantic semantic checks** — unique step ids, kebab-case skill
   id, identifier-shaped input names.
3. **Optional tool-registry cross-check** — if the caller passes a
   `ToolRegistry`, every `steps[].tool` must resolve and the effective
   category must match the declared `category`.

## Dispatch

```python
from apps.copilot.skills import SkillCatalog, SkillDispatcher
from apps.copilot.tools.registry import ToolRegistry

catalog = SkillCatalog.from_shipped()
dispatcher = SkillDispatcher()
result = await dispatcher.dispatch(
    catalog.get("grounded-corpus-qa"),
    {"question": "Why Bicep?"},
    registry=tool_registry,
)
```

The returned `SkillResult` is a frozen DTO with `success`, `outputs`,
a full list of `SkillStep` trace entries, and a `trace_id` for
observability.

## Execute-class skills

When any step references an execute-class tool (e.g. `publish_draft_adr`),
set the skill's top-level `category: execute`. The dispatcher will:

1. Acquire a `ConfirmationToken` via the injected `approval_callback`
   (or the reference `auto_approve_callback` when a broker is supplied
   with no explicit callback).
2. Call the tool with that token, forcing the broker to re-verify.

Read-class skills never touch the broker.

## CLI

```bash
python -m apps.copilot.cli skills list
python -m apps.copilot.cli skills show <skill-id>
python -m apps.copilot.cli skills run <skill-id> --input-json '{"field": "value"}'
```
