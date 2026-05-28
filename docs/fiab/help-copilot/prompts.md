# Help Copilot — prompt patterns

The widget is tuned for how-to and discovery prompts. Below are the
patterns that work best and the patterns that get handed off to the
full Loom Copilot at `/copilot`.

## What works well

### Conceptual

- "What is CSA Loom?"
- "What's the difference between a Lakehouse and a Warehouse in Loom?"
- "How does Direct Lake parity work?"
- "What's a data product?"

### Setup / deployment

- "How do I deploy Loom to a new Azure subscription?"
- "What roles does the deployment service principal need?"
- "How do I configure Power BI tenant settings for embedded?"

### Navigation

- "Open the workspaces page"
- "Take me to the data agent"
- "Where do I see the Activator rules?"

(The Copilot will call `openLoomPage` and the widget auto-navigates
800ms after the answer renders so you can read the explanation first.)

### Code / repo lookups

- "Where does the synapse SQL client live?"
- "What endpoints exist for workspaces?"
- "Where is the editor for Power BI Reports defined?"

### Diagnostics

- "Is AOAI wired in this deployment?"
- "What tenant am I in?"
- "What's the current Loom version?"
- "Is AI Search configured?"

### Reporting

- "I think there's a bug in the notebook ribbon — file an issue."

(The Copilot will draft a title + body and ask you to confirm before
calling `logIssue`. With no GitHub token, it returns a deep link to
the issue-new URL.)

## What gets handed off to `/copilot`

Anything that **acts** on Azure state:

- "Create a workspace called Foo."
- "Run the daily-refresh pipeline."
- "Pause the dedicated SQL pool."
- "Deploy a notebook from this Git path."

For these the Help Copilot returns an explanation **and** a `handoff`
block. The widget renders a "Switch to Loom Copilot for this action"
button that opens `/copilot` with the prompt prefilled.

## What it refuses

- Inventing doc content. If `searchDocs` returns nothing relevant, the
  Help Copilot says so and suggests where to look.
- Calling out tenant secrets. Diagnostic results include endpoint URLs
  and resource IDs, but not access tokens or session cookies.
- Modifying state. Every tool the widget has is read-only or
  navigation-only. `logIssue` is the one exception, and it confirms
  with the user before calling.

## Tips for sharper answers

- Use 2-5 keywords when asking. The retriever ranks better on focused
  queries than on full sentences.
- If the answer cites a stale doc, follow the citation link, edit the
  source, and call `POST /api/help-copilot/reindex` to refresh.
- For "where is X in code" prompts, prefer `searchRepo` phrasing:
  "Where in the repo is the synapse client defined?" beats
  "Show me synapse code."
