# AUTO-BIND BY DEFAULT — no user-performed plumbing (die-hard rule)

**Effective: 2026-08-04. Scope: every CSA Loom item type, editor, provisioner,
API route, and capability that sits on top of an Azure (or OSS) backing service.
All branches, all contributors (human or agent). This rule sits ABOVE convenience
and ABOVE "the gate is honest": an honest gate that asks the USER to do the
binding is now a DEFECT, not a compliant state.**

## The rule (verbatim intent from the operator)

> "For anything in Loom that requires a direct binding or mapping to the Azure
> service, just do that by default. Don't make the user or customer do it. Mount
> ADF, mount whatever the underlying service is, mapped and named exactly the
> same as it is in Loom. It handles all the deployments and debugging. Users
> don't have to guess and figure it out. If there's some binding or mapping or
> mounting that needs to take place between what's in Loom and what's in the
> Azure service, you figure it out, you fix it, you make it work."

## What "done" means

1. **Creating a Loom item PROVISIONS AND BINDS its backing resource.** Creating a
   `data-pipeline` creates/attaches the ADF (or Synapse) pipeline. Creating a
   `lakehouse` creates its ADLS container + Delta root. Creating a `notebook`
   attaches a Spark target. No second step, no wizard the user must find.
2. **Names match, exactly.** The backing Azure object carries the SAME display
   name as the Loom item (sanitized only where the service's naming rules force
   it — and then deterministically, and recorded in the item's state so the
   mapping is inspectable, never guessed).
3. **The binding is self-healing.** If the backing object is missing, renamed, or
   was deleted out-of-band, the next open RE-BINDS (or re-creates) rather than
   erroring. A stale binding is a bug to repair automatically, not a message to
   show the user.
4. **The editor NEVER opens on a "bind me first" form.** The canvas/designer/grid
   is the first thing the user sees. If provisioning is still running, show a
   progress state on the real surface — not a configuration form in its place.
5. **Infra prerequisites are DEPLOYED, not requested.** If the binding needs a
   resource (a factory, a pool, a cluster, a catalog URL), the platform deploys
   it via bicep and wires the env var. "Set `LOOM_X`" as the terminal user-facing
   state is a violation — the value must be produced by the deploy.

## Explicitly forbidden

- An editor whose primary surface is replaced by a "Bind to an existing …" form.
- `status:'remediation'` / a MessageBar whose remediation is **an action the
  PLATFORM could have taken** (create the factory, mint the URL, grant the role).
- "No pipelines found" + a disabled **Bind** button — i.e. a dead end.
- A capability that reports Blocked/Partial on `/admin/readiness` because a value
  the deploy could have set was not set.
- Requiring the operator to hand-run a script/portal step to make a first-class
  item type work.

## Allowed (narrowly, with disclosure)

- A **genuine tenant-level consent** that only a Global Admin can grant (e.g. an
  Entra admin-consent flow) — and even then it must be a one-click **Fix it**
  action in-product (per `ux-baseline.md` G2), registered in the gate registry,
  never a paragraph telling the user what to go do elsewhere.
- A **cost-material opt-in** the operator has explicitly chosen to keep opt-in;
  it must be listed in the gate registry with that reason.

## Relationship to the other rules

- Supersedes the *lenient* reading of `no-vaporware.md`'s "honest config gate":
  a gate is honest ONLY if the platform genuinely cannot perform the action.
  If Loom could have done it, an honest gate is still a defect under THIS rule.
- Reinforces `ux-baseline.md` **G2 (zero day-one gates)** — this rule is the
  stronger form: not merely "gates need a Fix-it button", but "the gate should
  not exist because the platform already did the work".
- `no-fabric-dependency.md` still governs WHICH backend is the default (always
  Azure-native); this rule governs that the default backend is **wired for you**.

## How to spot a violation

```bash
# Editors that open on a binding form / dead-end bind:
grep -rn "Bind to an existing\|No pipelines found\|isn't bound to a real" apps/fiab-console
# Remediations the platform could have performed itself:
grep -rn "status: *'remediation'" apps/fiab-console/lib/install/provisioners
# Readiness gates whose fix is a value a deploy could set:
grep -rn "LOOM_[A-Z_]*_URL\|LOOM_[A-Z_]*_ENDPOINT" platform/fiab/bicep | grep -i "not set\|missing"
```

## Verification per merge

A PR touching an item type must show, from a **clean create**: item created →
backing Azure object created/attached with the matching name → the editor's real
surface open and functional — with **no user binding step**. Per `ux-baseline.md`
G1 that receipt is a live in-browser walk, not tsc + vitest.
