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

1. Toggles ACR public access on (the Loom ACR is PE-only), `az acr build`s
   `platform/runners/github-actions/Dockerfile` to
   `acrloomk6mvh5sm6z7do.azurecr.io/gh-aca-runner:latest`, then restores ACR
   public access = Disabled (always, even on build failure).
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
> checksum via build ARGs `RUNNER_VERSION` / `RUNNER_SHA256` (default `v2.328.0`);
> the build fails loudly on a mismatch. Bump both together and confirm the SHA256
> against the [release page](https://github.com/actions/runner/releases) before
> the first build, or override per-run:
> `RUNNER_VERSION=2.x.y RUNNER_SHA256=<hex> ./scripts/csa-loom/provision-gh-runner.sh`.

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
          az acr build --registry acrloomk6mvh5sm6z7do --image loom-console:ci .
          az containerapp update -n loom-console -g rg-csa-loom-admin-centralus \
            --image acrloomk6mvh5sm6z7do.azurecr.io/loom-console:ci
```

Only jobs whose `runs-on` requests `loom-aca` are counted by the scaler and
routed to this runner. Everything else keeps using GitHub-hosted runners.

---

## Rotate / revoke

- **Rotate the PAT:** update the Key Vault secret (or re-run the script with a
  new `GITHUB_PAT`) — it updates the `github-pat` ACA Job secret in place.
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
