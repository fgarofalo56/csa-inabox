# Help Copilot

The Help Copilot is a docs-grounded floating chat widget mounted at the
top-right Sparkle icon of every Loom Console page. It answers questions
about CSA Loom — what it is, how to set it up, how to do any specific
thing — grounded in the published docs and the live repo source.

## What it is and isn't

- **It is** a retrieval-augmented assistant. Every claim is cited. It
  refuses to fabricate doc content.
- **It is not** the action orchestrator. It does not create workspaces,
  run pipelines, or call Azure APIs that change state. When you ask
  for an action it hands off to the full Loom Copilot at `/copilot`.

## Where to find it

Click the Sparkle icon at the top-right of the topbar, or press
`Ctrl + /` (or `Cmd + /` on macOS). The widget opens as a floating
panel in the bottom-right of the viewport.

## Suggested starting points

The empty state shows six baked-in prompts:

1. What is CSA Loom?
2. How do I deploy?
3. How do I create my first workspace?
4. What's a data product?
5. How does Direct Lake parity work?
6. Why does Cluster save return PERMISSION_DENIED?

Click any of them to send.

## The five tools

The Help Copilot has access to exactly five tools — all read-only and
all docs/diagnostic-focused:

| Tool             | Purpose                                                                          |
|------------------|----------------------------------------------------------------------------------|
| `searchDocs`     | RAG over `docs/fiab/`, `docs/`, `PRPs/active/csa-loom`, `docs/fiab/adr`         |
| `searchRepo`     | RAG over `apps/fiab-console/lib/{azure,editors,components}` source summaries    |
| `openLoomPage`   | Tells the frontend to `router.push()` to a specific page                         |
| `runDiagnostic`  | Probes live config (AOAI, AI Search, Cosmos, version, tenant)                    |
| `logIssue`       | Files a GitHub issue against the upstream repo (asks confirmation first)         |

## Degradation behaviour

The widget surfaces every degraded state via a Fluent UI `MessageBar`:

- **No AOAI deployment** → orange warning bar with a deep link to the AI
  Foundry hub deployments page.
- **No AI Search service** → info bar noting that results may be less
  relevant and the corpus falls back to a Cosmos substring index. The
  bar references the env var (`LOOM_AI_SEARCH_SERVICE`) and the bicep
  module that would provision it.

Neither degradation is silent. The widget always tells you exactly what
is missing and what to do about it.

## Related

- [Architecture](./architecture.md)
- [Prompt library and examples](./prompts.md)
- [Full Loom Copilot (cross-item orchestrator)](../console/copilot-runtime.md)
