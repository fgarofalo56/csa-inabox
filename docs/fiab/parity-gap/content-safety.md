# content-safety — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/content-safety/new`
**Fabric reference**: ai.azure.com — Content Safety Studio (Try it: text/image · Blocklists · Jailbreak detection · Custom categories · Prompt Shields · Protected material)
**Loom screenshot**: `temp/parity/content-safety-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/content-safety` | 200 | Returns default thresholds: `hate:4, selfHarm:4, sexual:4, violence:4` |
| `POST /api/items/content-safety` text+image | wired but not exercised | — |

Page shows two cards: Text moderation (Textarea + Analyze button), Image moderation (file input + Analyze button). Pre-text caption: "Default category set + severity thresholds. **Custom blocklists land in v2.6**." which is at least an honest deferral note.

## Phase 3 — Fabric vs Loom

| Fabric (Content Safety Studio) element | Loom present? | Severity |
|---|---|---|
| **Per-category severity sliders** (0–6 for Hate, Sexual, Self-harm, Violence) | NO — thresholds are server-defaults only, no UI to change | MAJOR |
| **Blocklist editor** (terms · regex · wildcard · case-sensitivity) | NO — explicit "v2.6" deferral but no MessageBar in UI surface to set expectations | MAJOR |
| **Custom category wizard** (train on labelled examples) | NO | MAJOR |
| **Prompt Shields** (jailbreak / indirect attack detection) | NO | MAJOR |
| **Protected Material** detection | NO | MAJOR |
| Text moderation try-it | YES — Textarea + Analyze | — |
| Image moderation try-it | YES — file input + Analyze | — |
| Result rendering: severity badges per category | NO — Loom dumps JSON in a `<pre>` | MINOR (BLOCKER per build-phase contract #4 — output rendering should be structured) |
| Batch / bulk testing | NO | MINOR |
| API key view + rate-limit info | NO | MINOR |

## Functional

- Analyze Text / Analyze Image buttons fire real POSTs to BFF (BFF returns 200 with `policies` for GET; POST not exercised live but route is registered)
- Result rendering is `JSON.stringify` in a `<pre>` block — that fails the structured-output rule

## Grade — **D**

Read endpoint is real. Try-it text+image work. But the editor doesn't surface ANY of the Content Safety Studio editing surfaces (sliders, blocklists, Prompt Shields, custom categories) — it's a try-it widget over a no-config policy. The "v2.6 deferral" is honest in the caption but the buttons that LOOK like they configure thresholds don't exist. **Grade D.**
