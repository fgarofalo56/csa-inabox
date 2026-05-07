"""Pre-flight sanitizer for issue bodies fed to the Claude Code action.

Reads ``ISSUE_BODY`` and ``ISSUE_TITLE`` from the workflow env, screens
for known prompt-injection patterns, and either:

- exits non-zero with a comment payload (workflow stops, comment posted), or
- writes a ``SANITIZED_BODY`` value to ``GITHUB_OUTPUT`` for the next step.

Defense layers stack:

1. **Pattern detection** — same regex set used to filter chat messages,
   plus a few targeted patterns that only apply to autonomous-fix
   contexts (e.g. requests to modify CI / requirements / auth code).
2. **Input length cap** — issue bodies over 8 KB are rejected; nothing
   legitimate needs more than that for an auto-fix issue.
3. **HTML / script tag stripping** — markdown is fine, but raw HTML
   tags get stripped so a stored issue can't smuggle script payloads
   to Claude (the ``Bash`` tool with ``write`` perms could otherwise
   echo them into a file).

This is the defense-in-depth layer; the auto-merge workflow's path
denylist is the second layer; required CI checks (gitleaks, CodeQL,
Trivy, Checkov) are the third.

Reference: GitHub's "Security hardening for GitHub Actions" doc and
OWASP LLM01 (prompt injection) — https://owasp.org/www-project-top-10-for-large-language-model-applications/
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

MAX_BODY_LENGTH = 8000  # bytes; rejects oversized payloads
MAX_TITLE_LENGTH = 200

# Same set the chat backend uses, plus auto-fix-specific patterns.
_BASE_INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"disregard\s+(your|all|the)\s+(instructions|rules|guidelines)",
    r"you\s+are\s+now\s+(?:a|an|the)",
    r"new\s+instructions?\s*:",
    r"system\s+prompt\s*:",
    r"(?:^|\s)act\s+as\s+(?:a|an|the|if)",
    r"pretend\s+(?:you\s+are|to\s+be)",
    r"jailbreak",
    r"\bDAN\s+mode\b",
    r"developer\s+mode\s*(?:enabled)?",
    r"forget\s+(?:your|all|the)\s+instructions",
    r"override\s+(?:system|your)",
    r"bypass\s+(?:your|the|all)\s+(?:restrictions|filters|rules|guard\s*rails?)",
    r"ignore\s+(?:the\s+)?(?:above|safety|content\s+policy)",
]

# Auto-fix-specific patterns: things a legitimate bug report would
# never need to contain. Stronger than chat-side filtering because the
# downstream consequences are higher (autonomous code changes).
_AUTOFIX_RED_FLAGS = [
    # Requests to touch high-risk paths
    r"(?:please\s+)?(?:also\s+)?(?:add|modify|update|change|edit)\s+the\s+(?:workflow|secret|token|credential|requirement|dependency|package|auth)",
    r"add\s+(?:a\s+)?(?:secret|env\s*var|environment\s+variable)\s+(?:named|called)",
    r"disable\s+(?:the\s+)?(?:test|check|workflow|gate|scan|hook|lint)",
    r"skip\s+(?:the\s+)?(?:test|review|check|scan)",
    # Egress / exfiltration patterns
    r"(?:send|post|exfiltrate|upload)\s+(?:.+\s+)?to\s+https?://",
    r"\bcurl\b.+(?:\.com|\.net|\.io|\.xyz)\/",
    # Direct shell injection
    r"\$\(.*\)|`[^`]*`",  # shell command substitution
    # Encoded payloads
    r"base64\s*(?:-d|--decode)",
    r"\beval\s*\(",
    # Reference to .env / secrets directly
    r"(?:read|cat|print|dump|leak)\s+(?:the\s+)?(?:\.env|secret|credential)",
]

_INJECTION_RE = re.compile("|".join(_BASE_INJECTION_PATTERNS), re.IGNORECASE)
_RED_FLAG_RE = re.compile("|".join(_AUTOFIX_RED_FLAGS), re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<\s*/?\s*(?:script|iframe|object|embed|svg|img|link|meta|style|form)\b[^>]*>", re.IGNORECASE)


def _emit_output(key: str, value: str) -> None:
    """Append a key=value pair to GITHUB_OUTPUT (multi-line safe)."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        # Local invocation — print and continue.
        print(f"{key}={value!r}", file=sys.stderr)
        return
    # Use a heredoc-style delimiter so multi-line values are safe.
    delim = "EOF_SANITIZE_" + os.urandom(4).hex()
    with Path(path).open("a", encoding="utf-8") as f:
        f.write(f"{key}<<{delim}\n{value}\n{delim}\n")


def _emit_summary(message: str) -> None:
    """Append to the workflow Job Summary (rendered in the run page)."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with Path(path).open("a", encoding="utf-8") as f:
        f.write(message + "\n")


def main() -> int:
    body = (os.environ.get("ISSUE_BODY") or "").strip()
    title = (os.environ.get("ISSUE_TITLE") or "").strip()

    if not body:
        print("::error::Issue body is empty.")
        _emit_summary("### ❌ Auto-fix sanitizer\n\nIssue body is empty.")
        return 1

    if len(body.encode("utf-8")) > MAX_BODY_LENGTH:
        print(f"::error::Issue body exceeds {MAX_BODY_LENGTH} bytes; rejecting.")
        _emit_summary(
            "### ❌ Auto-fix sanitizer\n\n"
            f"Issue body exceeds the {MAX_BODY_LENGTH}-byte cap "
            "(actual: {len(body.encode('utf-8'))}). Auto-fix declined; "
            "a maintainer will need to review manually."
        )
        return 1

    title = title[:MAX_TITLE_LENGTH]

    # Layer 1: Known injection patterns
    if (m := _INJECTION_RE.search(body)) or (m := _INJECTION_RE.search(title)):
        snippet = m.group(0)[:120]
        print(f"::error::Prompt-injection pattern detected: {snippet!r}")
        _emit_summary(
            "### ❌ Auto-fix sanitizer\n\n"
            "Detected a known prompt-injection pattern in the issue body "
            "or title:\n\n"
            f"```\n{snippet}\n```\n\n"
            "Auto-fix workflow aborted. A maintainer can re-trigger the fix "
            "after editing the issue, or remove the `auto-fix` label and "
            "produce the fix manually."
        )
        return 1

    # Layer 2: Auto-fix-specific red flags (high-risk asks that a
    # legitimate bug report would not contain).
    if (m := _RED_FLAG_RE.search(body)) or (m := _RED_FLAG_RE.search(title)):
        snippet = m.group(0)[:120]
        print(f"::error::Suspicious auto-fix red flag: {snippet!r}")
        _emit_summary(
            "### ❌ Auto-fix sanitizer\n\n"
            "Detected a high-risk pattern that is out of scope for "
            "autonomous bug-fix:\n\n"
            f"```\n{snippet}\n```\n\n"
            "If the bug genuinely requires changes to workflows, "
            "dependencies, secrets, or auth code, remove the `auto-fix` "
            "label and a maintainer will produce the fix manually."
        )
        return 1

    # Layer 3: Strip HTML tags that could surface as DOM payloads if a
    # downstream tool ever rendered the issue body to HTML.
    sanitized = _HTML_TAG_RE.sub("", body)

    _emit_output("body", sanitized)
    _emit_output("title", title)
    _emit_summary(
        "### ✅ Auto-fix sanitizer\n\n"
        "Issue body passed pattern checks. Handing off to Claude."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
