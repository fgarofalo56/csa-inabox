# loom-health-fhir

The LHDS FHIR engine image (W2-1 of `PRPs/active/loom-health-data-services/`).

| Part | What | State |
|---|---|---|
| Base | `hapiproject/hapi` **8.12.0**, pinned by digest to the image W0-7 measured (FHIR R4 4.0.1) | real |
| Plugin | `/app/extra-classes/loom-health-fhir-plugin.jar`, Loom module layout (`pdp/`, `audit/`) | PDP + audit interceptors (W2-3, see "Interceptors" below). **Present, not wired**: nothing in this image enables them until the per-tenant engine config (W2-2) lists them. |
| US Core | `hl7.fhir.us.core#6.1.0` + dependency closure, `/opt/loom/fhir/packages` | baked, sha256-pinned (`packages.lock.tsv`) |
| Validator | `validator_cli.jar` **6.9.12** (same `org.hl7.fhir.core` as the server), `/opt/loom/fhir/validator` | baked, sha256-pinned (`validator.lock`) |
| Validator cache | `/opt/loom/fhir/home/.fhir/packages`, built from the pinned tarballs | baked |

No runtime downloads. The runtime stage has no `curl`/package manager (the base is distroless).
All fetching happens in the build's `tools` stage and aborts on any sha256 mismatch.

Engine configuration (partition mode, datasource, validation flags) is W2-2 and is **not** in
this image: see "Per-tenant engine config" below. Wiring the image into Container Apps/bicep is
W2-2b/W2-6.

## Per-tenant engine config (W2-2a)

Two halves, both measured against the pinned image (8.12.0):

- **Policy, tenant-independent**: `config/application.yaml`, loaded as an additional Spring config
  file (`SPRING_CONFIG_ADDITIONAL_LOCATION=optional:file:/opt/loom/fhir/config/application.yaml`).
  Partition mode (database mode; the partition is the first path segment, `/fhir/<facility>/Patient`;
  no segment is a 400), referential integrity on write and delete, validation on write, versioning
  (ETag, history kept; expunge, multi-delete and cascading delete off), conditional-create uniqueness,
  external references off, page-size ceiling 200.
- **Per tenant**: rendered by `apps/loom-health-cp/src/jobs/fhir-tenant-config.ts` as environment
  variables: the datasource (the tenant's own database and its own role, `sslmode=require`), pool size
  from the request quota, page/binary caps (these may only lower the file's ceiling), the interceptor
  list (PDP before audit) and the plugin env (`LOOM_HEALTH_TENANT`, `LOOM_HEALTH_PDP_URL`). The database
  password is a Key Vault secret NAME (`t-<slug>-fhir-db`); the value is never rendered.

Lifecycle jobs (`fhir-tenant.create|configure|teardown`, `fhir-tenant-jobs.ts`) apply it through a
`FhirEngineHost` port and read every step back. **Not wired**: no host adapter exists yet (W2-2b), so
`compose.ts` does not register the kinds.

Gotchas found on the pinned image: `database_partition_mode_enabled` belongs under `partitioning:`,
not directly under `hapi.fhir:` where the starter's template comments place it (there it is ignored
and the engine logs "Database Partition Mode Enabled: false"). Partition mode cannot be enabled on an
existing database. `request_tenant_partitioning_mode` is the starter default; it is stated in the file
so a change is a diff.

Local proof (needs Docker; the image and `postgres:16` locally, no Azure):

    bash apps/loom-health-fhir/config/probe/engine-config-probe.sh

It runs the config against the real engine and checks: partition mode on, no-partition request 400,
validation on write 422 (with a valid-body control), referential integrity on create and on delete,
50 parallel conditional creates give exactly 1 resource (with a 50-resource unconditional control),
a history read's SELECT count does not scale with versions (with a counter-sees-scaling control),
multi-delete and `$expunge` refused, and the env caps bind over the file. Not verified: the plugin
interceptors on top of this config (the plugin jar is not loaded by the probe), a Postgres per-tenant role,
and anything on a stamp.

## Interceptors (W2-3)

Two HAPI interceptors in `plugin/`, registered in this order via `hapi.fhir.custom-interceptor-classes`
(no-arg constructors, env-configured) or `LoomPlugin.register(...)`:

1. `ai.loom.health.fhir.pdp.LoomPdpInterceptor`: before the engine does any work, `POST
   /v1/data/lhds/authz/decision` on the in-cluster OPA with the raw bearer token and
   `{service, interaction, tenant, base, resource_type, op, patient_compartment, categories}`
   (`apps/loom-health-pdp/input-contract.json`). Only `result.allow == true` permits; deny is 403;
   timeout, connection error, non-200 or a reply without `result` is **503**, never 200; no bearer is 401
   (PDP not asked). `GET /metadata` is the one unauthenticated interaction (still audited). On the way out,
   read/vread/history/search results are filtered by the token's SMART v2 scopes (type, `r`, `category`
   constraint, patient compartment), so `_include` / `_revinclude` cannot leak other types or patients;
   a single resource outside the scopes is 403.
2. `ai.loom.health.fhir.audit.LoomAuditInterceptor`: exactly one record per interaction (permit, deny,
   503, 401), as an R4 `AuditEvent` plus a flat `LhdsAudit_CL` row: one JSON line on stdout
   (`"lhds_audit":1`) and, if `LOOM_HEALTH_AUDIT_DIR` is set, hourly append-only JSONL files for W8-4 to
   seal. No token, body or query values (parameter names only).

Env: `LOOM_HEALTH_PDP_URL` (required; unset means every request is 503), `LOOM_HEALTH_PDP_TIMEOUT_MS`
(default 1500; bounds the whole response, body included), `LOOM_HEALTH_TENANT` (**required**: the engine
serves one tenant; unset means every request is 503, the URL is never used to guess it;
`LOOM_HEALTH_TEST_ALLOW_PATH_TENANT=true` is a test-only fallback), `LOOM_HEALTH_AUDIT_DIR`.

UPDATE is decided twice: on the new body, and on the stored resource (`STORAGE_PRESTORAGE_RESOURCE_UPDATED`,
also fired for conditional updates), so a token cannot take over another patient's or category's record by
writing a body that claims its own. `$batch` / `$transaction` get one decision (operation `$transaction`)
with no per-entry authorization, so no role may hold them (a test pins the role map). The plugin tests run
in `.github/workflows/health-fhir-plugin-test.yml` (the image build skips them).

Not verified: any run against the real OPA/Rego or on a live stamp (tests use a stand-in PDP that speaks the
frozen API); the `LhdsAudit_CL` table and its ingestion rule do not exist yet (W8-4 / bicep). Known limits:
a search page fetched via `_getpages` has no resource type, so only wildcard-type scopes cover it; a
`patient/` token reading a non-Patient resource by id is denied (owner unknown before the read); the audit
sink does not block the interaction if it fails to write.

Test: `mvn -f apps/loom-health-fhir/plugin/pom.xml -q test` (embedded Jetty + real `RestfulServer`).

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
