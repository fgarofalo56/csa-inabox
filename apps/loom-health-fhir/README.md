# loom-health-fhir

The LHDS FHIR engine image (W2-1 of `PRPs/active/loom-health-data-services/`).

| Part | What | State |
|---|---|---|
| Base | `hapiproject/hapi` **8.12.0**, pinned by digest to the image W0-7 measured (FHIR R4 4.0.1) | real |
| Plugin | `/app/extra-classes/loom-health-fhir-plugin.jar`, Loom module layout (`pdp/`, `audit/`) | **skeleton**: loads, registers **no** interceptor. PDP + audit interceptors are W2-3. Nothing in this image authorizes or audits yet. |
| US Core | `hl7.fhir.us.core#6.1.0` + dependency closure, `/opt/loom/fhir/packages` | baked, sha256-pinned (`packages.lock.tsv`) |
| Validator | `validator_cli.jar` **6.9.12** (same `org.hl7.fhir.core` as the server), `/opt/loom/fhir/validator` | baked, sha256-pinned (`validator.lock`) |
| Validator cache | `/opt/loom/fhir/home/.fhir/packages`, built from the pinned tarballs | baked |

No runtime downloads. The runtime stage has no `curl`/package manager (the base is distroless).
All fetching happens in the build's `tools` stage and aborts on any sha256 mismatch.

Engine configuration (partition mode, datasource, validation flags) is W2-2 and is **not** in
this image; wiring the image into Container Apps/bicep is W2-6.

## Build

Context is **this directory** (not the repo root):

    docker build -t loom-health-fhir apps/loom-health-fhir

CI builds it with `az acr build` through `.github/workflows/build-fiab-images-acr-tasks.yml`
(matrix row `loom-health-fhir`, `ctx: ./apps/loom-health-fhir`), the same lane that builds
Commercial and GCC-High/IL5 (`boundary` input), with the shared Trivy CRITICAL gate, SBOM and
cosign steps. The build **fails** if the baked validator cannot accept a valid US Core Patient and
reject an invalid one (`check/check-validator.sh`).

## Verify a built image

    sh apps/loom-health-fhir/scripts/verify-image.sh <image>

Runs the plugin load probe and the validator with `--network none`.

## Bumping

Change the base digest in `Dockerfile` **and** `scripts/measure/health/fhir-engine-deploy.sh`
together (the contract test pins them equal), and re-check the `org.hl7.fhir.core` version the new
server ships against `validator.lock`. Package/validator bumps: edit the lock, rebuild.

## Known limits

- **Trivy CRITICAL (measured 2026-11-14): 2 of the 4 base-image CVEs are patched here, 2 remain.**
  Patched with pinned, sha256-checked layers (no `.trivyignore`): `libbrotli1` CVE-2026-111497
  (`os-patch.lock`, fixed .deb overlaid with its dpkg status entry) and `opentelemetry-javaagent`
  CVE-2026-33701 (`otel-agent.lock`, 2.26.1). **Still failing the gate:** `spring-webmvc` 6.2.19
  in `main.war`, CVE-2026-47884 / CVE-2026-47890. The only fixed version is 7.0.9+ (Maven Central's
  6.2.x line ends at 6.2.19). Swapping that one jar for 7.0.10 was tried: boot fails with
  `NoClassDefFoundError: HttpMessageConverters$ServerBuilder`, because the rest of the server is
  Spring Framework 6.2. Clearing it needs a HAPI starter built on Spring Boot 4 (a new W0 pin),
  which is outside this image's ownership.


- Terminology bindings are not checked by the baked validator (`-tx n/a`: there is no terminology
  server in the image). Profile structure, cardinality and invariants are.
- The validator's own companion packages (terminology, extensions) are resolved "latest" by the
  validator; they are pinned here at the versions seen on 2026-11-14 and the build check fails if the
  validator asks for anything not in the cache.
- Gov: the build path is the same workflow with `boundary=GCC-High|IL5`. It has not been
  exercised for this image (supported-in-code only); `github.com` and `packages.fhir.org` must be
  reachable from the Gov ACR Tasks build (the same assumption other baked-asset images make).
