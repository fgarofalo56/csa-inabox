# Upstream container images — the ACR mirror

**No CSA Loom deploy path pulls a third-party container image from a public
registry.** Every third-party image a running Container App or Container Apps Job
pulls is mirrored, **by digest**, into the deployment's own Azure Container
Registry first. This page is the reference for that mechanism: what is mirrored,
how, how to add or bump an image, and how it is enforced.

Issue: [#2682](https://github.com/fgarofalo56/csa-inabox/issues/2682).

---

## Why

Four independent reasons, all load-bearing:

| | |
|---|---|
| **Sovereign / air-gapped** | A GCC-High, IL5 or disconnected enclave cannot reach `docker.io`. An image referenced by its public coordinate is simply unpullable there — the Container App never activates a revision. |
| **Egress posture** | A federal estate should not egress to a public registry at *runtime*. The mirror moves the one unavoidable internet fetch into a controlled build-lane step, inside the ACR firewall lease. |
| **Scanning + signing** | Only images in our ACR get Trivy-scanned and cosign-verified. An anonymous runtime pull bypasses both, and also emits `registries: []` in the ARM template — no pull identity at all. |
| **Provenance** | A Docker Hub tag is *mutable*. Mirroring by tag copies whatever the tag points at that day, so two runs of the same workflow can ship different bits under the same reviewed licence and the same passed CVE scan. Pinning to a manifest digest closes that. |

---

## The single source of truth

`platform/fiab/images/upstream-images.json`. One entry per deploy-path image:

```jsonc
{
  "acrRepo": "apache/airflow",              // == the repo written in the bicep module
  "tag": "2.10.5-python3.12",
  "sourceRegistry": "docker.io",
  "sourceRepo": "apache/airflow",
  "digest": "sha256:6499a680…",             // what actually gets imported
  "spdx": "Apache-2.0",
  "notice": "github.com/apache/airflow LICENSE = Apache License, Version 2.0",
  "consumers": ["platform/fiab/bicep/modules/admin-plane/airflow.bicep (airflowImage)"]
}
```

`acrRepo:tag` **must be byte-identical** to the repo:tag written in the consuming
bicep module, because every module composes its effective ref as
`${acrLoginServer}/${repo}:${tag}`.

### What is mirrored today

| Image | Licence | Consumer |
|---|---|---|
| `apache/airflow:2.10.5-python3.12` | Apache-2.0 | `admin-plane/airflow.bicep` — the OSS Airflow host |
| `s3proxy:3.3.0` (from `andrewgaul/s3proxy`) | Apache-2.0 | `data-plane/s3-gateway-aca.bicep` — the S3-compatible ADLS gateway |
| `curlimages/curl:8.10.1` | curl (MIT/X derivative) | `compute/loom-memory-consolidate-job.bicep` |

---

## How the mirror runs

`scripts/ci/mirror-upstream-images.sh --acr <registryName>` — **one implementation,
both clouds**:

- **Commercial** — `.github/workflows/full-app-deploy-commercial.yml`
- **Gov (GCC-High / IL5)** — `.github/workflows/gov-provision-dataplane-images.yml`

For each manifest entry it runs a **server-side** registry-to-registry copy:

```
az acr import -n <acr> --source docker.io/<repo>@sha256:<digest> --image <acrRepo>:<tag> --force
```

then **reads the digest back out of ACR** and fails if it does not match. A
failed import is a hard error, never a warning: deploying past it produces a
Container App that can never start, and the operator would learn about it from a
revision-provisioning failure rather than from the step that caused it.

If `docker.io` is unreachable from the registry, it retries against the MCR
Docker Hub mirror (`mcr.microsoft.com/mirror/docker/<repo>@<digest>`) — **also by
digest**, since a fallback that resolved a tag would defeat the pinning it stands
in for.

!!! note "Firewall lease"
    The Loom ACRs are `publicNetworkAccess=Disabled` with `defaultAction=Deny`.
    The caller must already hold the [#2603 lease](../runbooks/index.md)
    (`scripts/csa-loom/acr-firewall-lease.sh acquire`) when it invokes the mirror.
    The script deliberately does **not** acquire or release one itself — nesting a
    lease under a holder is how the #2603 incident (a cancelled run's release
    closing the registry under a live one) happened.

---

## Adding or bumping an image

1. Resolve the digest:

   ```bash
   bash scripts/ci/resolve-upstream-digest.sh apache/airflow 2.11.0-python3.12
   # -> sha256:…
   ```

2. Edit `platform/fiab/images/upstream-images.json` — bump **`tag` and `digest`
   together**. A tag without a matching digest bump is the mutable-tag hole.
3. Bump the ref in the consuming bicep module to the same `repo:tag`.
4. Re-review the licence in `scripts/ci/check-license-inventory.mjs`
   (`REVIEWED_BICEP_IMAGES`) and add / update the `THIRD_PARTY_LICENSES.md` row.
5. Regenerate the compiled template if you touched bicep:

   ```bash
   az bicep build -f platform/fiab/bicep/main.bicep \
     --outfile apps/fiab-console/deploy-templates/main.json
   node scripts/ci/check-deploy-template-sync.mjs
   ```

---

## How it is enforced

Three guards, covering **different** properties. None implies the others.

| Guard | Polices | A violation it catches |
|---|---|---|
| `check-license-inventory.mjs` (**LIC0**) | *Licensing* — is the SPDX id permissive and recorded in the NOTICE manifest | Someone swaps in the AGPL MinIO gateway |
| `check-upstream-image-mirror.mjs` (**MIR0**) | *Egress + provenance* — is the image mirrored, digest-pinned, and actually imported by both lanes | Someone bumps a bicep ref without bumping the manifest, so ACR never receives that tag |
| `check-mcr-image-pins.mjs` (**MCR0**) | *Deploy determinism* — does every `mcr.microsoft.com` ref resolve to immutable bits | A `:latest` (or a rolling version tag) lets two deploys of the SAME commit run different software |

LIC0 is completely satisfied by an image pulled anonymously from `docker.io` at
runtime, as long as its licence is recorded. That gap is what MIR0 exists to close.

MIR0 in turn **skips `mcr.microsoft.com` on purpose** — MCR is Microsoft
first-party and is reachable from every boundary Loom deploys into, so the
ACR-mirror requirement does not apply to it. But that skip was *total*: until
FINISHLINE C18 no guard looked at an MCR ref at all, and four of them floated
`:latest` (one on a default-ON path, all of them baked into the shipped
`deploy-templates/main.json`). MCR0 is the half that closes.

MIR0 fails when:

1. a bicep-pinned upstream ref has no manifest entry with the same `repo:tag`;
2. a manifest entry has no `sha256:<64hex>` digest, or floats `:latest`;
3. a bicep deploy path composes a ref from a public registry host;
4. **either** cloud lane stops *invoking* the shared script (comments don't count
   — the check strips them and looks for a real `bash …` run step);
5. the bicep scan or the manifest observes **zero** images (anti-hollow: a scan
   that matches nothing must never report success).

All three run unfiltered in `loom-guardrails.yml`, because the edit that
introduces the violation is a bicep or workflow change.

### MCR0 — the MCR pin registry

Registry of record: **`platform/fiab/images/mcr-images.json`**. Every
`mcr.microsoft.com` ref reachable from a deploy path
(`platform/fiab/bicep/**`, `deploy/bicep/**`, and the compiled
`apps/fiab-console/deploy-templates/*.json`) must have an entry there carrying a
resolved manifest digest, and the ref itself must carry that digest inline:

```bicep
param dabImage string = 'mcr.microsoft.com/azure-databases/data-api-builder:2.0.9@sha256:ad5ac179…'
```

Resolve a digest with:

```bash
bash scripts/ci/resolve-mcr-digest.sh azure-databases/data-api-builder 2.0.9
```

**MCR0 is keyed on the SAFE pattern, not the unsafe one.** The obvious
implementation is `grep ':latest'` — and it is worthless: the moment someone
adopts the fix and writes `:2.0.9`, the token the rule matched is gone and the
guard goes quiet on exactly the files it just policed, while `:2.0.9` with no
digest is *still* mutable. MCR republishes rolling tags (`cbl-mariner/busybox:2.0`,
`azure-functions/python:4-python3.11`) in place on every CVE rebase. So the rule
is "a digest is **present** and matches the registry of record", which stays true
of every ref forever and cannot be satisfied by deleting a substring.

The one escape hatch is `"inlineDigest": false`, which means the consuming ARM
resource type is not known to accept a digest reference. It requires a written
`inlineDigestBlockedBy` reason and an immutable version tag, and the digest is
still recorded so drift stays detectable. Today exactly one entry uses it
(`azureml/openmpi4.1.0-ubuntu20.04`, consumed by the AML curated environment).

### Mutation proof

MIR0:

```bash
# 1. bicep ref drift
sed -i 's/2.10.5-python3.12/2.11.0-python3.12/' platform/fiab/bicep/modules/admin-plane/airflow.bicep
node scripts/ci/check-upstream-image-mirror.mjs    # FAILS
# 2. missing digest -> blank a "digest" in upstream-images.json  # FAILS
# 3. delete the `bash scripts/ci/mirror-upstream-images.sh` run step from either lane  # FAILS
```

MCR0 ships its own mutation harness, which runs in CI beside the guard. It copies
the **real** scanned files into a scratch git repo (never invented fixture
content), breaks them six ways, and requires a RED verdict each time:

```bash
bash scripts/ci/test-check-mcr-image-pins.sh
#   PASS  baseline (unmutated real tree)                           (exit 0)
#   PASS  MUTANT: digest stripped from dab-runtime.bicep           (exit 1)
#   PASS  MUTANT: :latest reintroduced in dab-runtime.bicep        (exit 1)
#   PASS  MUTANT: new un-registered mcr ref pinned only by version tag (exit 1)
#   PASS  MUTANT: manifest digest no longer matches the bicep ref  (exit 1)
#   PASS  MUTANT: inlineDigest:false with no written reason        (exit 1)
#   PASS  MUTANT: zero refs observed (regex/globs broken)          (exit 1)
#   PASS  restored (all mutations reverted)                        (exit 0)
```

---

## Out of scope: build-time base images

This mechanism covers **deploy-time** pulls only — images a running Container App
or Job pulls from a registry.

Images an `apps/*/Dockerfile` builds `FROM` are a different path: they are pulled
**server-side by `az acr build`, inside Azure, during the image build**, and are
then baked into a Loom-owned image that itself lives in our ACR. Nothing at
runtime reaches a public registry for them. They are covered by LIC0's
`REVIEWED_IMAGES` map plus the base-image CVE gate.

For reference, the build-time third-party set today is:

| Kind | Images |
|---|---|
| OSS engines baked into Loom images | `unitycatalog/unitycatalog`, `risingwavelabs/risingwave`, `quay.io/debezium/connect`, `maptiler/tileserver-gl`, `deltaio/delta-sharing-server`, `trinodb/trino` |
| Language / OS bases | `node`, `python`, `debian`, `golang`, `rust`, `eclipse-temurin`, `amazoncorretto`, `gcr.io/distroless/static-debian12` |
| Microsoft first-party (exempt) | `mcr.microsoft.com/dotnet/*`, `mcr.microsoft.com/azure-cli` |

Mirroring the build-time set as well would require the mirror to complete before
the *first* build in a from-scratch deploy, and is tracked separately rather than
bundled here.

---

## Related

- [Greenfield deployment](greenfield.md) — the three-step from-scratch path
- [Brownfield deployment](brownfield.md)
- `.claude/rules/deploy-integrity.md` — R6 (self-diagnosing failures), R7 (true error messages)
- `THIRD_PARTY_LICENSES.md` — the NOTICE manifest
