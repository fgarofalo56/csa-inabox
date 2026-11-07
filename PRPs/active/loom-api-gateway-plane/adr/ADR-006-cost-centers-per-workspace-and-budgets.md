# ADR-006 — Cost centers auto-bound per workspace; budgets enforced through one named value

**Status:** Proposed 2026-10-28; accepted when W4 (cost centers) and W5 (budgets) ship.
**Mosaic lineage:** ADR 0022 (cost centers), 0023 (budgets and notifications),
`cost-centers.md`, `budgets-and-alerts.md`. Operator decision Q5.

## Context

Mosaic's cost center is a tenant-wide catalog administrators populate by hand.
Loom already has workspaces (the unit people recognise), domains, capacity
chargeback by the `loom-domain` tag and Azure Consumption budgets.
`auto-bind-by-default.md` forbids asking users to create plumbing the platform
could create.

## Decision

1. **Entity**: `costCenter{ id, code, name, owners[], members[], keysAllowed,
   limits{ perPersonDefaults, pooled[] }, workspaceId?, domainId? }`. `code`
   is 1–64 characters of letters, digits, dots, hyphens, underscores, unique
   per tenant case-insensitively. `general` is built-in, renamable, undeletable
   and the tenant default.
2. **Auto-bind**: creating a Loom workspace creates its cost center (`code` =
   workspace slug, deduplicated deterministically, owners = workspace admins,
   members = workspace members by security group where one exists). A W4
   backfill job creates centers for existing workspaces. Administrators add
   cross-workspace centers; renaming a workspace does not change its code.
3. **Who may charge**: the tenant default (everyone), the principal's own
   default, a listed member, or a member of a listed security group. Removing
   a member revokes grants that relied on it (recorded reason; keys deleted at
   the next apply); a revoke that must wait for a lock shows **Recheck
   pending** with a **Check grants again** action.
4. **Attribution per call**: `x-loom-cost-center` (case-insensitive code) →
   the caller's direct grant under their default center → other direct grants
   oldest first → group grants most generous first. Keys always charge their
   own grant's center; a conflicting header is `403 cost-center-mismatch`; an
   unknown or unheld code is `403 cost-center`. The header is stripped before
   the backend.
5. **Limits**: per-person defaults apply to grants without their own; pooled
   monthly tokens are a second `llm-token-limit` with a `Monthly` quota keyed
   per cost center and publication; pooled monthly calls a `quota-by-key` over
   the calendar month; counters are per gateway (disclosed). Remaining-quota
   headers: `x-loom-remaining-tokens`, `x-loom-remaining-quota-tokens`,
   `x-loom-remaining-calls`, `x-loom-cost-center-remaining-quota-tokens`.
6. **Budgets**: at most one per cost center and one for the organization;
   monthly USD at list price for the UTC month; thresholds 1–1,000 (default
   80, 100); recipients = owners (toggle) + up to 20 addresses; a cost-center
   budget may **block** at 100%, the organization budget only warns.
   Forecast = spend × days-in-month ÷ days-elapsed, labelled projected.
7. **Enforcement**: each managed gateway carries the named value
   `loom-blocked-cost-centers` (comma-separated 12-hex SHA-256 prefixes of
   blocked center IDs, `-` when none, ≤ 4,096 chars; overflow drops the newest
   and is reported). The `loom-*` fragments check it after grant and cost
   center resolution; blocked calls are `403` with `r=budget`; a value not
   written by the plane yields `503 r=budget-list` (fail closed). Every
   governed plan starts with a step that creates the value if missing and
   never overwrites it; unpublish, rollback and recovery never delete it.
8. **Evaluation**: full check every cycle after rollup (15 min), at month
   start and right after a budget is saved; budgets at ≥ 90% with a pending
   threshold or block are checked every 5 min; each threshold fires once per
   month; only a raised amount re-arms; a new month resets everything and
   lifts blocks; blocks lift at month end, raise above spend, disable or
   delete; blocks never revoke grants.
9. **Money shown**: unattributed cost and idle reserved capacity count only
   toward the organization budget; unpriced tokens do not count and are
   reported; if the whole month cannot be priced a check changes nothing.
10. **Chargeback**: the plane's per-cost-center cost joins the existing
    Admin → Chargeback and FinOps pages (Cost Management by `loom-domain`
    tag stays the source for Azure resource spend); CSV adds cost center,
    cost center name, on-behalf columns.

## Consequences

- Every workspace has a cost center on day one without anyone creating it;
  teams can still be organised across workspaces.
- Blocking lags spend by 15–30 minutes and lets a little through; the form
  says so.
- Only plane-managed gateways check the list; gateways published before
  budgets existed check it after their next apply.
- Portal totals can let a user infer another's usage when only two grants
  share a center (Mosaic's disclosed limit; stated in docs).

## Alternatives rejected

- Cost centers = domains (too coarse for teams; domains remain the Cost
  Management dimension); an independent catalog with no default (users would
  have to create plumbing); recompiling policies to block (a publish per
  block); revoking grants to block (loses keys and limits); calling the plane
  from policy (ADR-001); charging idle PTU to cost centers.

## Verification

`resolveCostCenter`, `evaluate`, `blockListValue` mutation receipts;
`budget-probe.mjs` on the Commercial estate; auto-bind receipt: create a
workspace → cost center exists with matching code, no user step.
