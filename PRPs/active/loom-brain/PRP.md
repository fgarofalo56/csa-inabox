# LOOM BRAIN — self-managing estate intelligence

**Status:** DRAFT — execution-ready. Created 2026-08-23. Operator-directed.

**Mandate (operator, verbatim intent):** Loom should self-manage the underlying Azure
services — clean up what is no longer used, self-heal, self-monitor problems and
misconfigurations, and keep the estate running at peak capability and minimum cost. Not
just a pause switch: *"a true Loom Brain engine."* Self-learning, self-evolving, wired
into **MAC and MAG**. Plus a **Loom Visualizer** so admins can see how Loom is wired.

---

## 0. The central design decision — the GRAPH is the substrate, not a picture

The visualizer and the Brain are **one system**. Every detector is a **graph query**, not
a bespoke rule:

| Symptom | Graph shape |
|---|---|
| Service deployed but unreachable | node with **no inbound edges** |
| Orphan from a deleted workspace | node whose **parent is gone** |
| Config drift | edge whose **declared** endpoint ≠ **live** endpoint |
| Dangling wire | edge whose target resolves to `''` or a missing resource |
| Always-on with no consumer | node with `minReplicas > 0` and zero inbound **traffic** edges |
| Stale from a past deploy | node with **no edge to any current deploy manifest** |

**Security is the same query with the edge predicate inverted.** Waste is *a node with no
inbound edge*; a vulnerability is *an inbound edge that should not exist*. Both are
reachability over the same graph — see §3.7.

**This is not hypothetical — it is how the founding finding was made.** `loom-capacity-broker`
runs `minReplicas: 2` (0.5 vCPU + 1 GiB each, so 1 vCPU / 2 GiB always-on), is healthy,
has an internal FQDN — and `platform/fiab/bicep/modules/admin-plane/main.bicep:4730`
emits `LOOM_BROKER_URL: ''`. Five console files consume that variable and all read an
empty string. **A billing service with no inbound edge.** One graph query finds that
class; a hand-written rule finds one instance of it.

---

## 1. Operator decisions — binding

1. **Recommend-only. A human approves every mutation.** The Brain inventories, scores,
   ranks and drafts remediation. It does not delete or scale anything on its own.
   *Rationale, measured:* of the **13** Container App environments across these
   subscriptions, **only 1 is Loom's**. The other 12 are the operator's blog, Sentinel,
   two Atlas estates, simplechat, imgrotator, dabdemo, assurancenet, forzelite and
   artemis. Autonomous deletion on a wrong ownership inference destroys someone else's
   production.
2. **Rules + LLM agents first; learned models later.** Deterministic detectors produce
   findings that are explainable and reproducible; an agent layer explains them and
   drafts the fix. ML is added once there is telemetry history to train on — training a
   model today means hosting a model today, which is in tension with the cost goal.
3. **Real cost comes from a Cost Management export to storage**, not the live API. The
   API returned **HTTP 429 on 11 consecutive attempts over ~35 minutes**; every dollar
   figure produced so far is *derived* (measured SKU × published retail rate), not billed.
4. **Reports cover ALL subscriptions. Cleanup recommendations are scoped by ownership.**
   Six subscriptions are visible: `FedCiv ATU FFL - DLZ / DMLZ / ALZ / Main`,
   `House Garofalo Prod / Dev`.
5. **MAC and MAG both.** `cloud-parity.md` applies — a Commercial-only Brain is
   incomplete, not "Commercial-first".

---

## 2. Measured baseline — what is actually out there

Established 2026-08-23 via Resource Graph across all six subscriptions.

| | count |
|---|---|
| Container Apps | **63** (Loom 29 · non-Loom 34) |
| Container App Jobs | **29** |
| Managed environments | **13** (Loom 1 · non-Loom 12) |
| Environments with zero apps and zero jobs | **0** |
| Container **Instances** (ACI) | **0 found** — re-verify before claiming |

**Loom's 29 apps by `minReplicas`:**

    minReplicas = 0   10 apps   (scale to zero — good)
    minReplicas = 1   17 apps
    minReplicas = 2    2 apps   (loom-console, loom-capacity-broker)

**19 of 29 are always-on.** That is where the container spend is, and it is the first
population the Brain must justify resource by resource.

Provisioning state: **0 of 63 apps are in a non-Succeeded state** — so there is no
failed-deployment debris in the container tier. The waste is *healthy services nobody
uses*, which is exactly why a liveness check finds nothing and a **graph reachability
check finds it immediately**.

---

## 3. Architecture

### 3.1 The graph (`lib/brain/graph/`)

**Nodes** — Azure resources (from Resource Graph, all subs), Loom logical items (from
Cosmos), deploy artifacts (bicep modules, params, workflows), and code modules.

**Edges**, each with a `provenance` so a finding can cite its source:
- `declared` — from bicep: a module output wired to another module's input
- `configured` — from a live env var pointing at an FQDN/endpoint/resource id
- `imports` — from source: module → module (this is how `_arm-absence.mjs` was found to
  be import-reachable but never argv-invoked)
- `observed` — from telemetry: real traffic between two nodes
- `owns` — tag or deploy manifest → resource (see #3922)

**The edge type matters.** A node with a `declared` edge but no `configured` edge is
*wired in the template and dead in the deployment*. A node with `configured` but no
`observed` is *reachable and unused*. Those are different findings with different fixes,
and conflating them is how "it's deployed so it must be used" happens.

### 3.2 Detectors (`lib/brain/detectors/`)

Each is a pure function `graph → Finding[]`. Every `Finding` carries: severity, the
**evidence** (node ids, edge ids, the query that produced it), a **derived** dollar
estimate labelled as derived, a **confidence**, and a drafted remediation.

**A detector that returns zero findings must report the population it examined.** A
detector over an empty node set is green and blind — that failure has been found
repeatedly in this repo. This is non-negotiable and applies to every detector.

### 3.3 The agent layer (`lib/brain/agents/`)

LLM agents that **explain, correlate and draft** — never decide alone:
- **Explainer** — turns a finding into an operator-readable narrative with its evidence.
- **Correlator** — groups findings that share a root cause (nine bicep issues that are
  one dead gate; see #3893).
- **Remediator** — drafts the PR or the ARM call. **Output is a proposal, never an action.**
- **Critic** — adversarially attacks each finding before it is shown: *what would make
  this wrong?* Findings that do not survive are dropped or marked low-confidence.

The Critic exists because the dominant failure in this repo is a **confident claim from
a partial measurement**. It is the agent-layer equivalent of the mutation discipline.

### 3.4 Cost (`lib/brain/cost/`)

Cost Management **export to storage**, read from the export rather than the API. Every
figure carries a `source: 'billed' | 'derived'` field and the UI renders the distinction.
**Never present a derived number as a bill.**

### 3.5 Self-heal and self-monitor

Reuses what exists rather than inventing: `/admin/readiness` gates, the
`lcu-autopilot` loop (which already does read → decide → **actuate** → audit but is
default `propose` and has no scheduler), and the estate pause work (W1 merged as
`e4dcfd72`). The Brain **proposes**; existing actuators execute on approval.

### 3.6 The Visualizer (`app/admin/brain/`)

Interactive graph over the same model. Filter by subscription, ownership, edge type,
cost. Click a node for its evidence, its edges and its findings. **Unreachable nodes and
dangling edges are visually distinct** — the picture and the analysis are the same data,
so they cannot disagree.

---

### 3.7 Security — the synapse view (operator-directed, 2026-08-23)

**Mandate:** *"look for gaps and vulnerabilities and potential issues… as Loom grows and
enhances itself over time it will self-identify and report these in the Brain surface and
Brain synapses view, like how the human brain works to prune and clean and grow synapses —
so there is no waste, but also no security concerns for customers as they use and evolve
their work."*

**The design claim: security detection is reachability with the predicate inverted.**
Waste is a node with no inbound edge. A vulnerability is **an inbound edge that should not
exist** — a path from an untrusted origin to a privileged sink with no authorization edge
on it. Same graph, same engine, opposite question. That is why security belongs inside the
Brain rather than beside it.

**Grounded in this repo's own defect history** — every class below is a real shipped
finding, which makes them the detector spec *and* the regression corpus:

| Defect class | Graph shape | Real instance |
|---|---|---|
| Authorization bypass | route node → privileged resource with **no `withTenantAdmin` edge** | the admin-bypass **family** — three greppable shapes; four PRs each fixed only one |
| Cross-tenant leak | a **caller-supplied** scope edge reaching another tenant's data | a count became an oracle: a caller-chosen `workspaceId` leaked existence + cardinality |
| Secret publication | path from a secret-bearing node to a **public sink** | four surfaces — issue body, issue **title**, annotation **and raw stderr** (a different path), artifact |
| Invisible egress | an edge with **no `write()` in source** | `stdio:'inherit'` publishes the child's bytes with nothing to grep for |
| Guard that cannot see | guard node whose **examined population is empty** | route guards blind three ways; a guard keyed to the *unsafe* pattern |
| Fail-open | an error edge that **widens** rather than denies | `2>/dev/null` turned a permission denial into a false claim (R7) |
| Drifted exposure | a `configured` edge to a **public** endpoint where `declared` said private | network / firewall drift |

**Growth is when new risk appears.** A newly added route with no authorization edge, a new
env var carrying a secret to a new consumer, a newly public endpoint — each is a **new edge**,
and the Brain diffs the graph across time. That is the synapse model made literal: the graph
is versioned, so *pruning* (dead nodes), *strengthening* (hot paths) and **"a new edge that
should not have formed"** become three queries over one history.

**Non-negotiable, from this repo's scar tissue:** a security detector reporting zero findings
**must report the population it examined** — a guard over an empty set is green and blind,
and that is the single most repeated failure here. And **every detector is proven by a NARROW
mutation**: scoping a bypass to one route, one item type or one cursor passes a broad guard
*and* a full suite. The narrow form is the evasion that actually works.

**Recommend-only applies here too.** The Brain reports and drafts; it never patches an
authorization path on its own. A wrong autonomous "fix" to authz is worse than the gap.

---

## 4. Explicitly out of scope for v1

- Autonomous deletion or scaling (decision 1)
- Custom AML models (decision 2) — the graph and findings **are** the training corpus for
  a later model; record them from day one with that in mind
- Anything that mutates a non-Loom subscription

---

## 5. Definition of done

- The graph builds across **all six subscriptions** and its node/edge counts are reported.
- **`loom-capacity-broker` appears as an unreachable always-on node** with its evidence
  chain — that is the acceptance test, because it is the founding measured example.
- Every detector reports its **examined population**, and a mutation of its subject makes
  it change verdict.
- Cost figures are labelled `billed` or `derived` and never conflated.
- A recommendation can be reviewed and approved by a human; nothing executes without that.
- Works in **MAC and MAG**, or the untested boundary is **named as untested**.
