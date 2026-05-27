# Global parity gap: Send feedback button

**Validated**: 2026-05-26  
**Surface**: Chat-help icon in top-bar global actions ("Send feedback")  
**Component**: `apps/fiab-console/lib/components/feedback-widget.tsx`  
**Fabric reference**: Fabric "Submit feedback" opens overlay with bug/feature toggle + textarea + submit-to-Microsoft  
**Backend probed**: code-level submission path (not validated end-to-end in this run)

## What renders

- `ChatHelp24Regular` icon, transparent button, `aria-label="Send feedback"`
- Click → modal dialog with title "Send feedback"
- Body has tabs/segmented control: "File a bug" / "Request a feature"
- Fields: "What broke?" / "Details" textareas
- Privacy notice: "Loom strips user names, emails, workspace and item IDs, hostnames, IPs, and any sensitive-looking strings from your report before sending. Only the route you're on, your browser family, and the redacted text are forwarded."
- Submit button

## Functional probes (auth'd)

- Click feedback → modal opens — PASS
- Two tabs visible: File a bug / Request a feature — PASS
- Privacy notice is clear and Microsoft-internal-friendly — PASS
- Did not submit a real feedback request (would pollute logs); code path appears wired (per UAT-v3.1 test record)

## Row-by-row matrix

| Fabric element | Loom: present | Severity | Notes |
|---|---|---|---|
| Feedback button | YES | — | |
| Bug vs Feature toggle | YES | — | Tabs |
| Textarea | YES | — | |
| Privacy notice | YES + BETTER | — | Explicit redaction policy spelled out |
| Submit + receipt | YES (code) | — | Not validated live but UAT record exists |
| Screenshot attach | NO | MINOR | Fabric optional, skip |

## Grade: **B+**

Real modal, real fields, privacy-conscious copy. Probably the most production-grade chrome surface in Loom. Doesn't need work.
