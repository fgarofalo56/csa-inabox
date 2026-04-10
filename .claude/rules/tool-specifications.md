---
paths:
  - "skills/**"
  - "commands/**"
  - "agents/**"
  - "mcp-servers/**"
  - "plugins/**"
  - "webhooks/**"
  - "templates/**"
---

# Tool Specifications

Loaded when working with tool files. Each tool type has a specific location and format.

## Skills

Location: `skills/[category]/[skill-name]/SKILL.md`
Model-invoked. Discovered from `~/.claude/skills/` or `.claude/skills/`.
Naming: lowercase letters, numbers, hyphens; max 64 chars.

```yaml
---
name: skill-name
description: What it does and when to use it. Max 1024 chars.
effort: high                          # low|medium|high|max (Opus only)
context: fork                         # Run in isolated subagent (optional)
argument-hint: "[file] [options]"     # Shown in autocomplete (optional)
allowed-tools: Read, Grep, Glob       # Tool restrictions (optional)
hooks:                                # Skill-scoped hooks (optional)
  PostToolUse:
    - matcher: "Edit"
      hooks:
        - type: command
          command: "./format.sh"
---
```

Use `${CLAUDE_SKILL_DIR}` to reference files relative to the skill directory.
Use `$ARGUMENTS` for user-provided arguments.

## Commands

Location: `commands/[category]/[command-name].md`
Filename becomes `/command-name`. User-invoked with slash prefix.

## Agents

Location: `agents/[agent-name].md` (markdown) or `agents/[agent-name]/` (Python)

Markdown agent frontmatter:
```yaml
---
name: agent-name
description: When to use this agent
model: sonnet                         # sonnet|opus|haiku|inherit
background: true                      # Default to background execution
memory: project                       # user|project|local for persistence
isolation: worktree                   # Git worktree isolation (optional)
effort: high                          # Reasoning depth
maxTurns: 50                          # Turn limit
tools: [Read, Grep, Glob, Bash]       # Available tools
skills: [test-generator]              # Preloaded skills (optional)
---
```

## MCP Servers

Location: `mcp-servers/[server-name]/`
See templates for Python and TypeScript structure.

## Webhooks

Location: `webhooks/[webhook-name]/`
HTTP endpoints that receive events and trigger actions.

## Plugins

Location: `plugins/[plugin-name]/`
Packages containing skills + agents + hooks + MCP servers.
