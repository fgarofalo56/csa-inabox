# Claude Code Hooks

Hooks run commands automatically at specific Claude Code lifecycle events.
They are configured in `.claude/settings.json` under the `"hooks"` key —
not by dropping scripts into this directory.

## Hook Events

| Event | Fires |
|-------|-------|
| `PreToolUse` | Before a tool call (can block it) |
| `PostToolUse` | After a tool call completes |
| `UserPromptSubmit` | When the user submits a prompt |
| `SessionStart` | When a session starts or resumes |
| `SessionEnd` | When a session ends |
| `Stop` | When Claude finishes responding |
| `PreCompact` | Before context compaction |

## Example Configuration

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "npm run lint" }]
      }
    ]
  }
}
```

## Getting Help

Use the `hook-configurator` skill to set up or troubleshoot hooks. Official
docs: https://code.claude.com/docs/en/hooks
