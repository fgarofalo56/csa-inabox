# GitHub Actions Self-Hosted Runner — scale-to-zero, in-VNet (Azure Container Apps Jobs)

This runbook describes the `gh-aca-runner` Azure Container Apps **Job**: an
event-driven, scale-to-zero, **ephemeral** GitHub Actions self-hosted runner
that executes CSA Loom CI (build / roll / UAT) **inside the console's virtual
network**.

---

## What & why

GitHub-hosted runners live on the public internet and cannot reach Loom's
private-endpoint-only resources. The Loom ACR and Key Vault have
`publicNetworkAccess=Disabled`, and the lake / Purview / ADF / Synapse sit
behind private endpoints in the DLZ. A cloud runner can't talk to any of them.

`gh-aca-runner` is a [Container Apps Job](https://learn.microsoft.com/azure/container-apps/jobs#event-driven-jobs)
in the **same VNet-integrated environment as `loom-console`** (`cae-csa-loom-centralus`,
peered to the DLZ). It uses the [KEDA `github-runner` scaler](https://keda.sh/docs/latest/scalers/github-runner/)
to start **one ephemeral runner per queued workflow run** that targets the
`loom-aca` label, then scales back to **zero** when CI is idle — you pay only
for the seconds a job actually runs.

It reuses the **console UAMI** (`uami-loom-console-centralus`) for both ACR
image pull and `az login --identity`, so CI authenticates as the **same
identity the console runs as** (already holds AcrPull + the DLZ data-plane
roles). This is the Microsoft
["Deploy self-hosted CI/CD runners and agents with Azure Container Apps jobs"](https://learn.microsoft.com/azure/container-apps/tutorial-ci-cd-runners-jobs?pivots=container-apps-jobs-self-hosted-ci-cd-github-actions)
pattern.

> **Cost note:** this does **not** reduce Anthropic / Claude API spend. It only
> moves GitHub Actions **compute** in-VNet and onto scale-to-zero ACA. LLM token
> usage is entirely unaffected.

> **Restriction:** Container Apps jobs do **not** support Docker-in-container.
> Any workflow step that shells out to `docker …` will fail on this runner. The
> Loom roll uses server-side `az acr build` (ACR Tasks), so it needs no local
> Docker daemon.

### Toolchain baked into the image

`platform/runners/github-actions/Dockerfile` (Ubuntu 22.04, glibc) carries:

- GitHub Actions runner agent — pinned + checksum-verified, run `--ephemeral`
- `azure-cli` + `az bicep` — server-side `az acr build`, `az containerapp update`
- Node 20 + pnpm (corepack) — the Next.js console build
- `gh` CLI, `git`, `curl`, `jq`, `ca-certificates`

Playwright (for `pnpm uat`) is an **optional commented layer** in the Dockerfile —
uncomment it only for the UAT runner (adds ~600 MB of browsers + OS deps).

### Runner lifecycle (ephemeral — one job per execution)

`platform/runners/github-actions/entrypoint.sh` runs as the container entrypoint
under `set -euo pipefail` (no silent no-op). Per job execution it:

1. **Mints a short-lived registration token** from the PAT —
   `POST {githubAPIURL}/repos/{owner}/{repo}/actions/runners/registration-token`
   with `Authorization: Bearer <PAT>` and `X-GitHub-Api-Version: 2022-11-28`,
   reading `.token` from the response. The PAT is sent only in the header — never
   echoed.
2. **Registers ephemerally** —
   `./config.sh --url https://github.com/{owner}/{repo} --token <reg> --ephemeral
   --unattended --replace --labels loom-aca,linux,x64 --name loom-aca-$(hostname)
   --work _work`.
3. **Runs exactly one job** — `./run.sh` processes a single workflow run, then the
   process exits, the ACA execution completes, and the replica is reclaimed (back
   to zero).
4. **De-registers on exit** — an `EXIT`/`INT`/`TERM` trap mints a *remove-token*
   and runs `./config.sh remove` so a runner that crashes before/at registration
   doesn't leave a stale entry. (`GITHUB_PAT` is intentionally kept in the env for
   this; only the registration token is unset after `config.sh`.)

A missing PAT, a GitHub `401`, or a `config.sh` failure aborts the container
**non-zero**, so the execution is marked **Failed** (visible + retried per
policy) rather than silently skipped.

---

## The GitHub PAT (the only secret)

The PAT is **user-provided** — it is never committed to the repo or written to
disk. The provisioning script reads it from `$GITHUB_PAT` or from Key Vault and
stores it **only** as an ACA Job secret named `github-pat`, referenced by
`secretref` (the KEDA scaler and the runner entrypoint both read it from there).

### Required scope

Create a **fine-grained** PAT scoped to `fgarofalo56/csa-inabox`:

| Repository permission | Access          | Why |
| --------------------- | --------------- | --- |
| Administration        | **Read & Write**| register / remove self-hosted runners |
| Actions               | **Read**        | the scaler reads the workflow queue |
| Metadata              | Read (implicit) | required by fine-grained PATs |

Set an expiration (e.g. 30 days) and **rotate before expiry** — an expired PAT
silently stops the scaler from starting runners.

A **classic** PAT with the `repo` scope also works. Runner scope = **repo**.

### How to create it

GitHub → your avatar → **Settings** → **Developer settings** →
**Personal access tokens** → **Fine-grained tokens** → **Generate new token**:

- **Repository access:** Only select repositories → `fgarofalo56/csa-inabox`
- **Permissions:** Administration = Read and write, Actions = Read-only
- **Generate token** → copy the value.

Store it in Key Vault (recommended) so the provisioning script and any rotation
job can read it without it ever touching disk:

```bash
az keyvault secret set --vault-name <loom-kv> --name gh-actions-pat --value "$PAT"
```

---

## Provision

From a shell with **Contributor** on `rg-csa-loom-admin-centralus`:

```bash
# Option A — PAT from the environment
GITHUB_PAT=github_pat_xxx \
  ./scripts/csa-loom/provision-gh-runner.sh

# Option B — PAT from Key Vault
KEYVAULT_NAME=<loom-kv> PAT_SECRET_NAME=gh-actions-pat \
  ./scripts/csa-loom/provision-gh-runner.sh
```

The script (idempotent — create-or-update):

1. Takes the ACR firewall lease (the Loom ACR is PE-only; see
   `docs/fiab/acr-firewall-lease.md`), `az acr build`s
   `platform/runners/github-actions/Dockerfile` to
   `acrloom<hash>.azurecr.io/gh-actions-runner:latest` (`IMAGE_REPO` /
   `IMAGE_TAG` override it), then releases the lease and verifies the
   registry re-locked (always, even on build failure). A failed build or an
   unverified re-lock exits non-zero with a `[FATAL]` naming the step, and the
   job is not touched.
   The image repository is `gh-actions-runner`, not the job name
   `gh-aca-runner`: that is the repository the live job pulls from.
2. `az containerapp job create`/`update` an **Event**-triggered job:
   `--min-executions 0 --max-executions 5 --polling-interval 30`,
   `--scale-rule-type github-runner` with metadata
   `owner=fgarofalo56 repos=csa-inabox runnerScope=repo labels=loom-aca targetWorkflowQueueLength=1`,
   `--scale-rule-auth personalAccessToken=github-pat`, the console UAMI for
   `--registry-identity` + `--mi-user-assigned`, and the PAT as the
   `github-pat` secret.

If `GITHUB_PAT` is unset and no Key Vault source is given, the script **errors
loudly and exits non-zero** — it never silently skips.

> **Runner version pin.** The image pins the runner version + a `sha256sum -c`
> checksum via build ARGs `RUNNER_VERSION` / `RUNNER_SHA256` in
> `platform/runners/github-actions/Dockerfile` (currently `v2.338.2`); the
> Dockerfile owns the default and the provision script passes neither unless you
> override both. The build fails loudly on a mismatch. Bump both together and
> confirm the SHA256 against the [release page](https://github.com/actions/runner/releases)
> before the first build, or override per-run:
> `RUNNER_VERSION=2.x.y RUNNER_SHA256=<hex> ./scripts/csa-loom/provision-gh-runner.sh`.
>
> **The pin has an expiry.** GitHub refuses to register a runner below a moving
> minimum version. The image does not disable self-update, but that does not
> help: each execution is a fresh replica that starts from the pinned binary,
> and registration happens before any update could run, so a pin below the
> minimum can never register. On 2026-09-29 GitHub refused `2.328.0` (minimum
> `2.329.0`) and every `[self-hosted, loom-aca]` workflow stranded.
> `scripts/ci/check-runner-version-pin.mjs` guards it. On every PR
> (`loom-guardrails.yml`) it checks the pin is well-formed and at or above the last
> reported minimum. Daily, in its own workflow (`runner-version-pin.yml`,
> GitHub-hosted), it reads two signals and fails on either:
>
> - **GitHub's deprecation schedule** for the pinned version
>   (`GET /repos/{owner}/{repo}/actions/runners/deprecations/{version}`). It fails
>   when `runtime_deprecates_at` or `registration_deprecates_at` is past or less
>   than 30 days away. GitHub documents this endpoint under the "Administration"
>   repository permission, which a workflow `GITHUB_TOKEN` cannot be granted, so
>   in the daily run the read is expected to be refused. The run then says, on
>   every line, that its verdict is **heuristic**, and why.
> - **The release-age heuristic.** GitHub's docs say a runner that is not updated
>   within 30 days of a new release will not be queued jobs. The check warns once
>   the pin has been superseded for more than 14 days (a notice only) and fails
>   at more than 30.
>
> A failure opens or updates the issue "deploy: runner-version-pin is failing",
> and the issue names which failure it was. `runner-version-pin.pin-deprecation-scheduled`
> and `runner-version-pin.pin-superseded` mean the pin is stale: bump it and
> rebuild the image under a new tag. The `releases-*` kinds mean the releases
> API could not be read, refused the token, or gave an unusable answer, so the
> pin's age was not established. Follow the issue's remediation line; do not
> bump the pin on one of those.

The durable IaC mirror is
`platform/fiab/bicep/modules/admin-plane/gh-runner-job.bicep` (see the `// TODO`
header for how it slots into `admin-plane/main.bicep`).

---

## Verify the runner registers

The job evaluates its scale rule every 30 s. Queue a workflow that targets
`loom-aca` (see below), then:

```bash
# Runner appears (ephemeral — it deregisters after the run):
gh api repos/fgarofalo56/csa-inabox/actions/runners --jq '.runners[].name'

# Job executions (one per queued run):
az containerapp job execution list \
  -n gh-aca-runner -g rg-csa-loom-admin-centralus \
  --subscription <YOUR_SUBSCRIPTION_ID> \
  --query '[].{Status:properties.status,Name:name,Start:properties.startTime}' -o table
```

Within ~30 s of queuing a `loom-aca` workflow, an execution starts; it completes
shortly after the workflow finishes and the replica is reclaimed (back to zero).

Inspect the live scale rule if runs stay queued:

```bash
az containerapp job show -n gh-aca-runner -g rg-csa-loom-admin-centralus \
  --subscription <YOUR_SUBSCRIPTION_ID> \
  --query "properties.configuration.eventTriggerConfig.scale.rules[0]"
```

Common causes of "queued but no execution": expired/insufficient-scope PAT, or a
label mismatch between the workflow `runs-on` and the scaler `labels` metadata.

---

## Target it from a workflow

Set `runs-on` to the self-hosted label set the runner registers with:

```yaml
jobs:
  build:
    runs-on: [self-hosted, loom-aca]
    steps:
      - uses: actions/checkout@v4
      - name: az login (console UAMI)
        run: az login --identity
      - name: Build + roll
        run: |
          az acr build --registry acrloom<hash> --image loom-console:ci .
          az containerapp update -n loom-console -g rg-csa-loom-admin-centralus \
            --image acrloom<hash>.azurecr.io/loom-console:ci
```

Only jobs whose `runs-on` requests `loom-aca` are counted by the scaler and
routed to this runner. Everything else keeps using GitHub-hosted runners.

---

## Queue watchdog (#5483)

### The incident

On 2026-11-25, from 05:36Z to 18:08Z, the `github-runner` KEDA scale rule on
`gh-aca-runner` polled GitHub successfully and computed
`MetricValue: 0.00, Active: false` while a `loom-aca` job (run 45574659735) sat
**queued for about ten hours**. Nothing alerted, because a queued job is
neither red nor green. The scaler resumed about five minutes after the
`github-pat` secret was rewritten. The root cause is **not established**: it
could be a dead PAT on a public repo, a wedged scaler instance, or both.

A manual `az containerapp job start` unblocked it immediately. The execution
it started registered an ephemeral runner and took the queued job.

### What the watchdog does

`.github/workflows/loom-aca-queue-watchdog.yml` runs every ~10 minutes, and on
`workflow_dispatch`, on a **GitHub-hosted** `ubuntu-latest` runner. It is
pinned, deliberately not routed through `vars.CI_RUNNER`: a watchdog that ran
on `loom-aca` would be queued behind the job it exists to rescue. The decision
logic is `scripts/ci/loom-aca-queue-watchdog.mjs`, which is tested by
`scripts/ci/__tests__/loom-aca-queue-watchdog.test.mjs`.

- **Detection.** GitHub's `?status=queued` index is not trusted on its own. On
  the same day it returned a zombie (run 43097708136, `queued` since
  2026-11-11, zero jobs, refusing cancel and force-cancel). The watchdog
  therefore takes the union of the `queued`, `in_progress`, `waiting`,
  `pending` and `requested` lists (each paginated, failing closed after 10 full
  pages) and one unfiltered page of runs created in the last 24 h, then lists the jobs of
  every run that is not completed. A job counts when its `status` is `queued`
  and its `labels` include `loom-aca`. It is aged from **its own**
  `created_at`. A run with zero jobs is counted and logged (`::notice::`) but
  never kicked for.
- **Kick (age ≥ 9 min).** Nine minutes covers the measured cold start (about
  2–3 min of `NotTriggerScaleUp: Maximum Allowed Cores exceeded` while the D8
  node scales up). The watchdog starts **at most one** execution per tick, and
  none when a younger execution is already Running or Processing. Younger means
  it started after the job was queued and within the last 6 minutes. A kick
  **exits 6** (`kicked-scaler-miss`), not 0: a job queued 9 minutes is 6+
  minutes past the cold start, so the scale rule missed it. The kick is a
  workaround, not health, and a lane that stayed green while kicks covered for
  a dead scaler would recreate the #5483 outage.
- **Red (age ≥ 25 min).** The run fails with `::error::`, naming the job, its
  age, and whether a kick was made this tick, with the execution name `az`
  returned. At a 10-minute cadence, at least one kick has already been tried by
  this point.
- **Fails closed.** GitHub and Azure reads retry three times with backoff, then
  exit non-zero. A payload that cannot be parsed has its own exit code (3). A
  failed start, or one that names no execution, exits 4 and is **not** retried
  in the same tick, because a failed start may still have created an
  execution. The executions are read on every tick, so a broken Azure
  credential shows up on a quiet tick rather than during an incident.
- **Estate pause.** The watchdog stands down only on a **declared** pause in
  `scripts/ci/estate-pause-declaration.json` for `Commercial`, and it says so
  with a `::warning::` (UNMEASURED, not clean). It does not read the console's
  estate-power record, which is known to be stale (#5484).
- **Tracking issue.** Any non-zero outcome, or a watchdog job that died before
  its verdict (for example at Azure login), opens **one** issue labelled
  `loom-aca-queue-watchdog`, or comments on the open one. This is the
  open-issue-else-comment convention of `loom-synthetic-monitor.yml`. A
  separate `alert` job holds `issues: write`; the job holding the Azure token
  does not. Close the issue by hand once the scaler is healthy again.

| Exit | Outcome | Meaning |
|---|---|---|
| 0 | `clean` / `suppressed` / `paused` | Nothing stale; a younger execution may still take the job; or a declared pause (UNMEASURED) |
| 1 | `stale-red` | A `loom-aca` job queued ≥ 25 min |
| 2 | `api-unreadable` | A GitHub or Azure read failed after 3 tries; nothing established |
| 3 | `parse-failure` | A read succeeded but could not be interpreted, or a list hit the 10-page ceiling |
| 4 | `kick-failed` | The start failed, or `az` exited 0 without naming an execution |
| 5 | `usage` | Configuration missing or inconsistent |
| 6 | `kicked-scaler-miss` | A kick was made because the scaler missed a job queued ≥ 9 min |

When several apply on one tick, the precedence is 4 > 1 > 6 > 0.

**Identity.** The watchdog uses OIDC `azure/login` with the deploy SP
(`AZURE_CLIENT_ID`), the same login `csa-loom-exercise-services.yml` uses. That
SP's rights come from the out-of-band prerequisite in
[prerequisites.md § P2](deployment/prerequisites.md#p2--the-deployment-identity)
(Contributor on the subscription), not from a bicep role assignment.
Contributor covers `Microsoft.App/jobs/start/action`, which is far broader than
this lane needs. A least-privilege identity would hold only job read, start,
and execution read on `gh-aca-runner`, through the built-in *Container Apps
Jobs Operator* role (check its action list before adopting it) or a custom
role. That narrowing needs a dedicated identity and has not been done. The OIDC
federated credential is pinned to `refs/heads/main`, so a dispatch from a branch
fails at `AADSTS700213`. Use `kick: false` from `main` to observe without
starting anything.

### Manual remedy

```bash
# Start one execution by hand. It registers a runner and takes a queued loom-aca job.
MSYS_NO_PATHCONV=1 az containerapp job start -n gh-aca-runner \
  -g rg-csa-loom-admin-centralus --subscription <SUBSCRIPTION_ID> -o json

# Watch it go Processing -> Running -> Succeeded.
az containerapp job execution list -n gh-aca-runner -g rg-csa-loom-admin-centralus \
  --subscription <SUBSCRIPTION_ID> \
  --query '[0:5].{Name:name,Status:properties.status,Start:properties.startTime}' -o table
```

### Rotating the PAT

`scripts/csa-loom/provision-gh-runner.sh` updates the secret in place with
`az containerapp job secret set … --secrets "github-pat=${GITHUB_PAT}"`, then
`az containerapp job update`. Re-running the script with a new `GITHUB_PAT`
(Option A or B under [Provision](#provision)) is the supported path. If you run
the `secret set` by hand, pass the value from an environment variable, never as
a literal. Do not stage it in a file, including one under `temp/`.

### Reading the KEDA scaler events

The scaler's decisions (`MetricValue`, `Active`, `NotTriggerScaleUp`) are in
**`ContainerAppSystemLogs_CL`** in the environment's Log Analytics workspace,
with suffixed columns `JobName_s`, `Reason_s`, `Log_s` (plus `TimeGenerated`).
Query them through the **ARM** endpoint (`management.azure.com`).
`az monitor log-analytics query` calls `api.loganalytics.io`, which the
workstation's LAN DNS sinkholes.

> **Do not "correct" this to `ContainerAppSystemLogs`.** That non-`_CL` table
> also exists in this workspace but is **empty** on this estate (measured
> 2026-11-25), so a query against it returns zero rows and reads like "the
> scaler logged nothing".

```bash
MSYS_NO_PATHCONV=1 az rest --method post \
  --url "https://management.azure.com/subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<WORKSPACE_RG>/providers/Microsoft.OperationalInsights/workspaces/<WORKSPACE_NAME>/api/query?api-version=2020-08-01" \
  --body '{"query":"ContainerAppSystemLogs_CL | where TimeGenerated > ago(6h) | where JobName_s == \"gh-aca-runner\" | project TimeGenerated, Reason_s, Log_s | order by TimeGenerated desc | take 50"}'
```

The legacy path `…/workspaces/<WORKSPACE_NAME>/query?api-version=2017-10-01`
with the same body also works.

`MetricValue: 0.00, Active: false` while `gh api repos/<owner>/<repo>/actions/runs/<id>/jobs`
shows a `loom-aca` job `queued` is the #5483 signature.

---

## Rotate / revoke

- **Rotate the PAT:** update the Key Vault secret (or re-run the script with a
  new `GITHUB_PAT`) — it updates the `github-pat` ACA Job secret in place. See
  [Rotating the PAT](#rotating-the-pat) above.
- **Revoke access:** delete the PAT in GitHub. The scaler immediately stops
  starting runners (no GitHub-side runner can register without a valid token).
- **Remove the runner entirely:**
  `az containerapp job delete -n gh-aca-runner -g rg-csa-loom-admin-centralus`.

---

## Gov / GitHub Enterprise

For a Gov-hosted GitHub Enterprise instance, set `githubAPIURL` (script:
`GITHUB_API_URL`, bicep: `param githubAPIURL`) to that instance's API URL and
`GITHUB_SERVER_URL` (entrypoint env) to its web URL. Everything else — the ACA
job, UAMI, ACR, and scaler contract — is identical across clouds.

---

## PAT rotation and expiry tracking

Follow-up of incident #5483 (2026-11-25), where a dead runner PAT plausibly
froze every `loom-aca` workflow for about 10 hours with nothing alerting. The
PAT has an expiry, so the platform tracks it in the same place as every other
expiring credential: the Key Vault secret `gh-actions-pat`, which the
secret-expiry monitor (`secret-expiry-monitor-job.bicep`, `trackedKvSecrets`)
reads at 60/30/7 days.

The hub vault is private-endpoint-only, so a workstation cannot write
`gh-actions-pat` directly. Rotation is therefore two steps.

**1. Rotate the live secret on the runner job** (the KEDA scaler and the
runner entrypoint both read `github-pat` from here). Paste the new PAT at a
silent prompt so it never lands in shell history or a file:

```bash
read -rs PAT && az containerapp job secret set -n gh-aca-runner \
  -g rg-csa-loom-admin-centralus --secrets "github-pat=$PAT" -o none; unset PAT
```

**2. Mirror it into the vault and stamp its expiry**, from the in-VNet runner:

```bash
gh workflow run ops-kv-secret-sync.yml -f source_kind=job \
  -f containerapp=gh-aca-runner -f aca_secret=github-pat \
  -f kv_secret=gh-actions-pat -f expires_on=YYYY-MM-DD
```

`expires_on` is the PAT's expiry date as GitHub shows it. The workflow:

- refuses anything that is not a real `YYYY-MM-DD` date after today's UTC
  date, before it writes anything;
- stamps the expiry at `00:00:00Z` on that date, so an alert can only come
  early, never late;
- checks the mirror's value hash against the job secret;
- reads back `attributes.expires` (never the value) and fails if it differs
  from the date you asked for.

Run step 2 on the **first** rotation too. Until `gh-actions-pat` exists, the
monitor lists it as "not found in the vault" with no expiry band. That is
reported, but it does not raise an alert. If you run the sync without
`expires_on`, the current version's expiry is carried forward onto the new
version. Only when the vault holds no expiry at all is the new version written
without one; the run warns, and the monitor reports it as no-expiry rather than
counting down. After a rotation, always pass the NEW PAT's `expires_on`, since
a carried-forward date belongs to the old PAT.

Coverage needs the monitor job to carry `gh-actions-pat` in
`LOOM_SECRET_EXPIRY_KV_SECRETS`. The bicep default includes it, so it lands on
the next admin-plane deploy. `deploy-secret-expiry.yml` carries the running
job's env forward, so on its own it does not add the name.
