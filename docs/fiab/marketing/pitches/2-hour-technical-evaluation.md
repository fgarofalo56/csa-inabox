# 2-hour technical evaluation — CSA Loom

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


Audience: customer infra lead + security lead + (often) the architect
team from the 60-min deep-dive. Goal: leave with `azd up` running
against the customer's test subscription, Console accessible, and a
signed-off "we'll deploy production in [N weeks]."

This is the *commit* meeting. Two hours, hands-on, technical.

Pre-reqs sent 48 hours before:
1. Customer provisions a test subscription with Contributor + User
   Access Administrator on it
2. Customer creates an Entra group `Loom Admins (test)` and shares the
   object ID
3. Customer reserves an unused /16 CIDR block for the hub VNet
4. Customer installs `az` CLI 2.64+ and `azd` CLI on the laptop they'll
   run the deploy from

If any of these aren't ready when the meeting starts, run the
recovery branch at the bottom of this doc.

---

## Agenda (120 min)

| Min | Topic | Who drives |
|---|---|---|
| 0-10  | Pre-flight checklist + customer-side verifications | Customer infra |
| 10-15 | Workshop preview — 5-day CoE outcome | Microsoft |
| 15-25 | Architecture lightning recap (10 slides max) | Microsoft |
| 25-90 | Hands-on `azd up` deploy + post-deploy bootstrap | Both |
| 90-100 | Console walkthrough (the *aha*) | Microsoft |
| 100-115 | Decision matrix worksheet — Loom vs alternatives | Both |
| 115-120 | Commitment ask + paperwork | Microsoft |

---

## 1. Pre-flight (Min 0-10)

Run this checklist on the call. If any answer is no, escalate before
proceeding.

| # | Check | How to verify |
|---|---|---|
| 1 | `az login` works against test sub | `az account show` returns the right sub ID |
| 2 | `azd version` >= 1.10 | `azd version` |
| 3 | Customer has Contributor + UAA on the sub | `az role assignment list --assignee <user-oid> --scope /subscriptions/<sub-id>` |
| 4 | Entra group object ID handed over | Customer types it into chat |
| 5 | CIDR block reserved | Customer confirms /16 isn't peered to anything |
| 6 | Power BI Premium F-SKU available in target region | `az resource list --resource-type Microsoft.Fabric/capacities` shows availability |
| 7 | Databricks Premium quota in target region | `az vm list-usage -l <region> --query "[?contains(name.value,'standardEv4')]"` |
| 8 | ADX quota | `az vm list-usage -l <region> --query "[?contains(name.value,'D14_v2')]"` |
| 9 | AOAI capacity (TPM allocation) | `az cognitiveservices account list-skus -l <region>` |
| 10 | KV access from customer laptop | n/a — we provision a fresh KV |

If 1-5 fail, abort to recovery branch (you can't run `azd up` without
them). If 6-9 fail, deploy with `*Enabled=false` flags on those
services and document the gap.

## 2. Workshop preview (Min 10-15)

Brief overview of the [5-day Federal CoE workshop](../../workshops/5-day-federal-coe/index.md):

- **Day 1** — Architecture review + boundary mapping
- **Day 2** — Hands-on Lakehouse + Notebook + Warehouse
- **Day 3** — Real-Time Intelligence + Activator + Data Agents
- **Day 4** — Forward-migration planning (Delta → OneLake)
- **Day 5** — Custom workshop on customer's actual workload + handoff

Mention the [Commercial CoE workshop](../../workshops/5-day-commercial-coe/index.md)
is the same content adapted for non-federal customers.

## 3. Architecture lightning recap (Min 15-25)

Skip if the architect team did the deep-dive recently. Else run
slides 5, 7, 11, 13 from the [pitch deck](../pitch-deck.md) — just the
architecture spine. 10 minutes max.

## 4. Hands-on `azd up` deploy (Min 25-90)

This is the meat of the meeting. Customer infra lead drives; Microsoft
narrates.

### Step 1 — Clone the repo (Min 25-30)

```bash
git clone https://github.com/fgarofalo56/csa-inabox.git
cd csa-inabox/platform/fiab
ls bicep/
```

Show them the bicep tree. Highlight `main.bicep`, `params/`, and
`modules/admin-plane/` + `modules/landing-zone/`.

### Step 2 — Pick the boundary (Min 30-32)

```bash
BOUNDARY=commercial   # or gcc, gcc-high, il5, commercial-full
```

If the customer's audit boundary is FedRAMP High → `commercial`.
If GCC identity → `gcc`. If IL4 / IL5 → `gcc-high` / `il5`.
If they want everything default-on → `commercial-full`.

Walk the param file briefly:
```bash
cat bicep/params/${BOUNDARY}.bicepparam
```

### Step 3 — Set the admin group OID (Min 32-34)

```bash
ADMIN_GROUP=<the object id customer shared in step 0>
```

### Step 4 — Validate (Min 34-37)

```bash
az deployment sub validate \
  --location eastus2 \
  --template-file bicep/main.bicep \
  --parameters bicep/params/${BOUNDARY}.bicepparam \
  --parameters loomAdminGroupObjectId=$ADMIN_GROUP
```

If validation fails, the error message points at the offending param.
Resolve before proceeding to the real deploy.

### Step 5 — Deploy (Min 37-77)

```bash
az deployment sub create \
  --name loom-eval-$(date +%Y%m%d-%H%M%S) \
  --location eastus2 \
  --template-file bicep/main.bicep \
  --parameters bicep/params/${BOUNDARY}.bicepparam \
  --parameters loomAdminGroupObjectId=$ADMIN_GROUP \
  --no-prompt
```

This takes 35-55 minutes. While it runs:

- Watch the Azure portal — show the customer the resources appearing in
  real time in `rg-csa-loom-admin-<region>`
- Walk through what each module does (network, identity, monitoring,
  Container Apps, Cosmos, Key Vault, ACR)
- Answer architectural questions while they wait

### Step 6 — Post-deploy bootstrap (Min 77-87)

After the deployment finishes:

```bash
# Pull workflow context
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
RG=rg-csa-loom-admin-eastus2
CONSOLE_UAMI=$(az identity show -n uami-loom-console-eastus2 -g $RG --query principalId -o tsv)

# Grant Graph roles (Directory.Read.All + User.Read.All)
export LOOM_UAMI_OBJECT_ID=$CONSOLE_UAMI
export AZURE_TENANT_ID=$TENANT
bash scripts/csa-loom/grant-uami-graph-roles.sh

# Optional: register Console UAMI in Databricks workspace SCIM
bash scripts/csa-loom/bootstrap-databricks-scim.sh
```

Open the [post-deploy bootstrap workflow file](../../../../.github/workflows/csa-loom-post-deploy-bootstrap.yml)
so the customer sees this is a real, runnable script — they can run
the same workflow in their own GitHub repo / Azure DevOps pipeline.

### Step 7 — Get the Console URL (Min 87-90)

```bash
LOOM_FQDN=$(az containerapp show -n loom-console -g $RG \
  --query 'properties.configuration.ingress.fqdn' -o tsv)
echo "https://$LOOM_FQDN"
```

Open it. They should see the MSAL sign-in. Sign in with their Entra
identity.

## 5. Console walkthrough (Min 90-100)

This is the *aha*. Use [demo-script.md](../demo-script.md) section
"First-deploy walkthrough":

1. Home — show the deployment status pills (all green)
2. `/workspaces` — create one
3. Pick "Casino Analytics" from `/apps` (or any sample app), install
   into the workspace
4. Open a notebook — show real cells, run one (it'll spin up Spark)
5. Open `/admin/security` — show the Purview tab pulling real data
6. Open `/admin/users` — show the displayName + department coming
   from Entra (Graph enrichment is now on by default)
7. Open `/copilot-loom` — show the 30-tool orchestrator

By minute 100, the customer should be saying "OK, this is real."

## 6. Decision matrix (Min 100-115)

Run this worksheet with the customer's team. It's a Loom vs alternatives
self-assessment.

| Dimension | Loom | Competing data warehouse (Gov) | Competing data-ops platform (IL5) | Databricks Gov |
|---|---|---|---|---|
| Microsoft strategic alignment | ✓ | ✗ | ✗ | partial |
| Boundary support today (FedRAMP High / IL4 / IL5) | ✓ | partial | ✓ | partial |
| Open source under the covers | ✓ | ✗ | ✗ | ✓ |
| Direct Fabric migration path | ✓ | ✗ | ✗ | partial |
| Console SaaS-feel UI | ✓ | ✓ | ✓ | ✗ |
| 5-day CoE workshop | ✓ | varies | ✓ | varies |
| Cost to start | $0 (Azure consumption) | $30K+ commit | $200K+ | $0 (Azure consumption) |
| Customer-managed (no proprietary lock) | ✓ | ✗ | ✗ | ✓ |

Have the customer fill in a *weight* per row (0-10) based on their
priorities. Multiply through. Loom should come out ahead on Microsoft-
alignment-heavy + cost-conscious + Fabric-migration-path customers.

## 7. Commitment ask (Min 115-120)

The close. Choose the one that fits the customer's signal:

### "We're sold" close

> "Great. The next step is the 5-day workshop. I'll send the SOW
> tomorrow. Can you confirm a workshop start date in the next 4-6
> weeks?"

### "We need to socialize" close

> "Understood. The path forward is this 2-week trial: keep the deploy
> running, walk through tutorials 01-05 with your team. Two weeks from
> today we re-convene; if it passes their gut check, we book the
> workshop. Same time, same Webex?"

### "We have concerns" close

> "Walk me through what's blocking — I'd rather lose the deal honest
> than win it on overpromises. Let's add 30 minutes after this to dig
> into your concerns."

---

## Recovery branch — pre-flight failed

If pre-flight checks 1-5 fail:

- *Customer doesn't have UAA on sub:* abort `azd up`. Run a deploy
  validation only (`az deployment sub validate`) — that exercises the
  bicep without provisioning, so they see "this is the real
  blueprint." Re-book the eval for after their IT team grants UAA.
- *No Entra group:* create one in real time using `az ad group create`
  — takes 2 minutes; customer's Entra Admin must be on the call.
- *No CIDR block:* deploy with the default `10.0.0.0/16` and document
  that production-deploy needs a different range.

---

## After the meeting

Within 24 hours:

- Send the recap email with: Console URL, sign-in instructions, SOW
  if applicable, link to the [5-day workshop](../../workshops/index.md), link
  to [tutorials 01-05](../../tutorials/index.md)
- Schedule the workshop start date if customer committed
- Schedule the 2-week re-convene if customer is socializing
- Loop in customer-success rep for the warm hand-off

## Related

- [60-min architecture deep-dive](60-min-architecture-deep-dive.md) — preceded this meeting
- [30-min CIO pitch](30-min-cio-pitch.md) — preceded the deep-dive
- [Seller playbook](../seller-playbook.md) — full objection bank + competitive positioning
- [Federal CoE workshop](../../workshops/5-day-federal-coe/index.md) — the workshop SOW
- [Demo script](../demo-script.md) — Console walkthrough flow
- [Tutorials 01-05](../../tutorials/index.md) — what customers do in week 2
- [Quick Start (60-min deploy)](../../deployment/quickstart.md) — same `azd up` flow doc'd separately
