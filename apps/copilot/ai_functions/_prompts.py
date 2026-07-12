"""System prompts for the five AI functions.

Isolated in its own module so both ``functions`` (scalar path) and ``_batch``
(Series / executor path) can import it without a circular dependency. The text
is copied verbatim from ``apps/fiab-console/lib/azure/ai-functions-client.ts``
so the notebook surface and the Console SQL-editor surface stay 1:1.
"""

from __future__ import annotations


def build_system_prompt(
    fn: str,
    *,
    labels: list[str] | None = None,
    fields: list[str] | None = None,
    target_lang: str | None = None,
) -> str:
    """Return the system prompt for ``fn`` (kept 1:1 with the TS Console client)."""
    if fn == "summarize":
        return "Summarize the following text concisely in 2-3 sentences. Return only the summary, no preamble."
    if fn == "classify":
        joined = ", ".join(labels) if labels else "positive, negative, neutral"
        return (
            f"Classify the following text into exactly one of these labels: {joined}. "
            "Return only the label, nothing else."
        )
    if fn == "sentiment":
        return (
            "Classify the sentiment of the following text as positive, negative, or neutral. "
            "Return only the single label, nothing else."
        )
    if fn == "extract":
        joined = ", ".join(fields) if fields else "all salient fields"
        return (
            f"Extract the following fields as a JSON object: {joined}. "
            "Return only valid JSON with those keys, no markdown fences and no commentary."
        )
    if fn == "translate":
        lang = (target_lang or "English").strip()
        return f"Translate the following text to {lang}. Return only the translation, no quotes and no commentary."
    if fn == "fix_grammar":
        return (
            "Correct the spelling, grammar, and punctuation of the following text. "
            "Preserve the original meaning and tone. Return only the corrected text — "
            "no quotes, no commentary, and no explanation of the changes."
        )
    if fn == "generate_response":
        return (
            "You are a helpful assistant. Generate a clear, professional response to the "
            "following message or prompt. Return only the response text, with no preamble."
        )
    raise ValueError(f"Unknown AI function: {fn!r}")
