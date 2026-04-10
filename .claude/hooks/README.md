# Claude Code Hooks

This directory contains **hooks** - scripts that run before or after Claude Code operations.

## What are Hooks?

Hooks are executable scripts that Claude Code runs automatically at specific points in its workflow. They enable:
- Pre-flight checks before operations
- Post-operation cleanup or validation
- Custom integrations with external tools
- Enforcement of project policies

## Hook Types

### Pre-Execution Hooks

Run **before** Claude executes a command or makes a change:

| Hook | Trigger | Use Case |
|------|---------|----------|
| `pre-commit` | Before git commit | Lint, format, test |
| `pre-write` | Before file write | Validate content |
| `pre-bash` | Before bash command | Security checks |

### Post-Execution Hooks

Run **after** Claude completes an operation:

| Hook | Trigger | Use Case |
|------|---------|----------|
| `post-commit` | After git commit | Notify, deploy |
| `post-write` | After file write | Index, validate |
| `post-session` | After session ends | Cleanup, backup |

## Directory Structure

```
hooks/
├── README.md           # This file
├── pre-commit.sh       # Runs before commits
├── post-commit.sh      # Runs after commits
├── pre-write.py        # Validates file writes
└── post-session.sh     # Session cleanup
```

## Creating Hooks

### 1. Create the Script

```bash
#!/bin/bash
# hooks/pre-commit.sh

# Run linting
npm run lint
if [ $? -ne 0 ]; then
    echo "Lint failed - commit aborted"
    exit 1
fi

# Run tests
npm test
if [ $? -ne 0 ]; then
    echo "Tests failed - commit aborted"
    exit 1
fi

echo "Pre-commit checks passed"
exit 0
```

### 2. Make it Executable

```bash
chmod +x hooks/pre-commit.sh
```

### 3. Register in Settings (if needed)

Some hooks are automatic, others need registration in `settings.json`:

```json
{
  "hooks": {
    "pre-commit": ".claude/hooks/pre-commit.sh",
    "post-session": ".claude/hooks/post-session.sh"
  }
}
```

## Hook Environment

Hooks receive context through environment variables:

| Variable | Description |
|----------|-------------|
| `CLAUDE_PROJECT_ROOT` | Project root directory |
| `CLAUDE_OPERATION` | Current operation type |
| `CLAUDE_TARGET_FILE` | File being modified (if applicable) |
| `CLAUDE_SESSION_ID` | Current session identifier |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success - continue operation |
| 1 | Failure - abort operation |
| 2 | Warning - continue with caution |

## Best Practices

1. **Keep hooks fast** - Long-running hooks degrade experience
2. **Handle errors gracefully** - Don't leave things in broken state
3. **Log clearly** - Output should explain what happened
4. **Test independently** - Hooks should work outside Claude Code
5. **Use appropriate language** - Shell for simple, Python for complex

## Security Considerations

- Hooks run with your user permissions
- Sanitize any input from Claude
- Don't store secrets in hook scripts
- Review hooks before running untrusted projects

## Documentation

- [Hooks Overview](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Hook API Reference](https://docs.anthropic.com/en/docs/claude-code/reference/hooks)

---

*Add hooks to automate your development workflow.*
