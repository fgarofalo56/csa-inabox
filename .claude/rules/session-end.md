# End of Session Protocol

Wrap-up is lightweight and native — no external task server, no ritual file
updates for their own sake.

Before ending a significant session:

1. **Commit or PR all work.** Nothing durable lives only in the working tree.
2. **Report estate truth, not merge truth.** Anything merged but not rolled or
   deployed is reported in exactly those words — "merged, not deployed"
   (`deploy-integrity.md` R2).
3. **Persist what the next session needs:** durable facts and gotchas →
   auto-memory; decisions and architecture changes → `docs/`; anything
   mid-flight → a GitHub issue with enough context to resume cold.
4. **Hand off in-flight machinery:** name any running agents, workflows, CI
   runs, or deploys and where their results will land.
5. **Summarize to the operator:** what landed (merged vs deployed vs verified
   live), what's in flight, what's blocked and on whom.

`.claude/SESSION_KNOWLEDGE.md` and `.claude/DEVELOPMENT_LOG.md` are optional
program-level overviews for long multi-session initiatives — update them when
running one, not per session.
