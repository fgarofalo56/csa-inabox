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
  list (PDP before audit), `HAPI_FHIR_SERVER_ADDRESS` (the tenant public FHIR base `<stampBaseUrl>/<tenant>/fhir`; the plugin sends it as the PDP `base`, so it must equal the token `aud` and the bundle base, #5422 decision 13; an engine without it sends an empty base and every token is denied) and the plugin env (`LOOM_HEALTH_TENANT`, `LOOM_HEALTH_PDP_URL`). The database
  password is a Key Vault secret NAME (`t-<slug>-fhir-db`); the value is never rendered.

### Datasource authentication: Entra workload identity, no database password (W2-2b B2b, #5422 decision 3)

The image bakes `com.azure:azure-identity-extensions` **1.3.1** (+ `azure-identity` 1.19.0, azure-core, msal4j,
netty 4.2.19, reactor-netty 1.3.7 ...; 34 jars, each sha256-pinned in `jdbc-auth.lock.tsv`) into
`/app/extra-classes`, and `config/application.yaml` into `/opt/loom/fhir/config/application.yaml` (the path the CP
renders; `optional:` would otherwise drop the file silently). Jars the server already ships (jackson, reactor-core,
slf4j, pgjdbc 42.7.12, nimbus) are deliberately NOT baked again. The build fails unless the plugin class loads and
implements pgjdbc's `AuthenticationPlugin` against the pinned server's own libs (`JdbcAuthProbe`; `verify-image.sh` re-runs it).

Env contract (no password anywhere):

    SPRING_DATASOURCE_URL=jdbc:postgresql://<fqdn>:5432/<db>?sslmode=require&authenticationPluginClassName=com.azure.identity.extensions.jdbc.postgresql.AzurePostgresqlAuthenticationPlugin
    SPRING_DATASOURCE_USERNAME=<UAMI name, the Entra principal name created in PostgreSQL>
    AZURE_CLIENT_ID=<injected by the workload identity webhook>

Not verified here: a token exchange against a real Entra-only PostgreSQL (that is B3, on the stamp).
Bump = edit the version in a scratch pom, regenerate `jdbc-auth.lock.tsv` (jars only, linux-x86_64 natives, minus what
the HAPI `main.war` ships), rebuild.

### The engine reconciles its own partitions (W2-2b B2e, #5422 decision 11)

The control plane does **not** create partitions over HTTP: the PDP interceptor answers 401 to everything except
`/metadata`, and no exemption exists for `$partition-management-*`. Instead:

- The CP assigns ids (existing ids never change, nothing is dropped) and renders the desired list as canonical JSON
  in `LOOM_HEALTH_PARTITIONS` (`[{"id":1,"name":"site-a"}]`, sorted by id; part of the config revision, so a change
  rolls the pod) plus `LOOM_HEALTH_PG_ADMIN_ROLE` (the stamp PG administrator role).
- The plugin (`plugin/.../partition/`, a Spring configuration registered through
  `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`) runs in a
  `SmartInitializingSingleton`: after the JPA schema exists and before the web server accepts a connection. It
  creates each missing partition **in-process** through HAPI's `IPartitionLookupSvc.createPartition`
  (HAPI 8.12), never deletes or renames, and **fails startup** with a `partitions.conflict` log line when a
  desired id/name collides with an existing row. It refuses `DEFAULT`, id 0, names outside
  `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$`, and a malformed role.
- Then it runs exactly one statement, `GRANT SELECT ON TABLE hfj_partition TO "<role>"` (the partition table of
  HAPI 8.12, `PartitionEntity` `HFJ_PARTITION`, non-PHI), and logs `partitions.reconciled`. Nothing else is granted.
- Both variables unset: skipped with a `partitions.reconcile.skipped` warning. Exactly one set: startup fails.
- The CP reads the table back through the PG admin Job and fails closed on any desired partition that is missing
  or disagrees. `/metadata` stays the only probe over HTTP.

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
multi-delete and `$expunge` refused, and the env caps bind over the file. C10 loads the plugin jar and
checks the partition reconcile: created/untouched counts, a role that could not read `hfj_partition`
before can read it after (and still cannot read `hfj_resource`), and a same-id-other-name desired partition
stops the engine with `partitions.conflict` and changes nothing. Not verified: the PDP/audit interceptors on
top of this config, the Entra JDBC auth plugin, a per-tenant role, and anything on a stamp.

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
   seal. No token, body or query values (parameter names only). Fails closed: see "Audit hardening".

Env: `LOOM_HEALTH_PDP_URL` (required; unset means every request is 503), `LOOM_HEALTH_PDP_TIMEOUT_MS`
(default 1500; bounds the whole response, body included), `LOOM_HEALTH_TENANT` (**required**: the engine
serves one tenant; unset means every request is 503, the URL is never used to guess it;
`LOOM_HEALTH_TEST_ALLOW_PATH_TENANT=true` is a test-only fallback), `LOOM_HEALTH_AUDIT_DIR`, `LOOM_HEALTH_TRUSTED_PROXIES`, `LOOM_HEALTH_FORWARDED_HEADER`.

UPDATE is decided twice: on the new body, and on the stored resource (`STORAGE_PRESTORAGE_RESOURCE_UPDATED`,
also fired for conditional updates), so a token cannot take over another patient's or category's record by
writing a body that claims its own. `$batch` / `$transaction` get one decision (operation `$transaction`)
with no per-entry authorization, so no role may hold them (a test pins the role map). The plugin tests run
in `.github/workflows/health-fhir-plugin-test.yml` (the image build skips them).

Response filtering and `Bundle.total`: the engine's `total` counts the UNFILTERED match set (and
`_summary=count` has no entries to subtract), so it would leak how much was hidden. It is kept only when the
token's scopes cannot hide anything (a `user/` or `system/` `*` scope with `r` and no category constraint) and
is omitted otherwise. A policy-aware count would mean walking the whole result set per request.

Paging: a `_getpages` page has no resource type, so the PDP is asked `resource_type="*"` and only a
wildcard-type scope covers it. Typed-scope paging stays DENIED on purpose: the stored search's type is not
known to the interceptor, and trusting a client-supplied type hint would weaken the check. Every page that is
served is filtered like any search. Remainder tracked in #5316.

Audit hardening (HIPAA 164.312(b)): every sink write failure increments `AuditHealth.failures()` and prints a
`{"lhds_audit_alert":1,...}` line on stdout (the alert rule is W8-4 / bicep work, not created here); a record
no sink accepted also bumps `lost()`. Design: redundant sinks, then **fail closed** (#5339). Stdout plus, when
`LOOM_HEALTH_AUDIT_DIR` is set, DSYNC'd hourly files; one healthy sink is enough. When EVERY sink fails the
interaction answers **503** with a fixed `OperationOutcome` ("Audit trail unavailable", no detail, no
resource) and nothing clinical is released. Stdout alone is only as durable as the log pipeline, so set the audit dir in production.

Where the row is written, and so what fails closed:

| Interaction | Audit write point | If no sink accepts it |
|---|---|---|
| create / update / patch / delete | `STORAGE_PRECOMMIT_RESOURCE_*`, inside the DB transaction, before commit | exception rolls the transaction back: 503, not persisted |
| read, vread, search, history, operations | `SERVER_OUTGOING_RESPONSE`, after the PDP response filter, before serialization | 503, body never written |
| 401 / 403 / 404 / 500 / 503 and `GET /metadata` | `SERVER_PROCESSING_COMPLETED` (after the response) | **cannot fail closed**: answer unchanged, counted + alerted |

Disclosed limits: (1) denied/errored requests and `/metadata` carry no clinical data, so their answer is not
withheld, but their audit row can still be lost (counted and alerted; `/metadata` stays open so a probe does not
kill a pod over an audit outage). (2) Pre-commit means a commit that then fails leaves an audit row for a write
that did not happen (over-reporting, never under-reporting). (3) A write that fires no `STORAGE_PRECOMMIT_*` hook
(an operation that persists some other way) is audited at `SERVER_OUTGOING_RESPONSE`, after its commit: a failure
there returns 503 but cannot un-commit. (4) The rollback is proven against the stand-in engine in the tests (it
models JPA's hook order); a receipt against the real JPA server is a W2-2b item, as is the live stamp.
A request that fail-closed is retried once at `SERVER_PROCESSING_COMPLETED` with its 503 status, so the trail
records it if the sink has recovered.
Each row also records the patient ids whose resources the filter returned and hid (`PatientsReturned`,
`PatientsHidden`, `HiddenResourceCount`; ids capped at 100 per list, the count is not), never bodies.
`RemoteAddr` is the client address: `LOOM_HEALTH_FORWARDED_HEADER` (default `X-Forwarded-For`) is read ONLY
when the TCP peer is in `LOOM_HEALTH_TRUSTED_PROXIES` (IPs/CIDRs; unset trusts nobody), walking hops right to
left to the first untrusted one; a non-IP hop voids the header.

Not verified: any run against the real OPA/Rego or on a live stamp (tests use a stand-in PDP that speaks the
frozen API; a real-OPA test in this lane is a tracked remainder of #5316); the `LhdsAudit_CL` table, its
ingestion rule and the ingress proxy range do not exist yet (W8-4 / bicep). Known limit: a `patient/` token
reading a non-Patient resource by id is denied (owner unknown before the read).

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
