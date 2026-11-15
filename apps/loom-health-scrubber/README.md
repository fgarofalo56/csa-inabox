# loom-health-scrubber

PHI log scrubber for the CSA Loom Health Data Services (LHDS) engines. Wave W2-5
(`PRPs/active/loom-health-data-services/W02a-fhir-core-build.md`; design in
`SECURITY-AND-COMPLIANCE.md` section 8.3). **Merged is not deployed**: nothing in this
directory runs on a stamp yet, and the image has no build-matrix row (a separate
integration PR adds it).

## What it is

A zero-dependency Node program (`src/cli.mjs`): log lines in on stdin, scrubbed lines out on
stdout. There is no bypass flag, and a line that cannot be scrubbed (rule error, or longer
than 1 MiB) is dropped and replaced by a marker, never passed through. The same rules are
exported as functions (`src/scrub.mjs`) for structured data:

| Function | Input | Policy |
|---|---|---|
| `scrubLine` | one log/span/metric line as text | pattern rules + query allow-list |
| `scrubAttributes` | span / resource / event attributes | drops body, header, `exception.message`/`stacktrace` keys; scrubs values |
| `scrubMetricLabels` | metric labels | **deny by default**: only an allow-list of bounded, non-PHI label keys survives |
| `scrubOtlp` | an OTLP/JSON document | applies the two above, labels mode under `dataPoints`/`exemplars` |

The OTel agent settings (no header capture, no log forwarding, DB statement sanitizing) are in
`apps/loom-health-fhir/config/otel.properties`.

## What it covers (measured against the real HAPI image)

Output of `hapiproject/hapi@sha256:0ff86aac...` (the Dockerfile-pinned digest, server 8.12.0)
under the OTel Java agent 2.26.1, after create, read, search `?family=ZZ-SENTINEL-LHDS`,
`$everything`, delete and an invalid create carrying the sentinel. Unscrubbed, the sentinel
appears in four places, and the test proves the scrubbed output has none:

1. the HAPI access log (`Params[?_count=5&family=...]`);
2. the span attribute `url.query` (the agent records the raw query string; not configurable away);
3. the metric exemplar attribute `url.query` (metric output carries it too);
4. the exception log line (`Failure during REST processing`, whose message echoes the value).

Rules, in order of strength:

- **Query strings (allow-list):** every `Params[?...]`, `url.query=` and `?...` in a URL keeps
  only `_count`, `_offset`, `_total`, `_summary`, `_pretty`, `_format`, `_sort`, `_elements`,
  `_include`, `_revinclude`, each with a constrained value shape; everything else, including
  keys nobody has thought of yet, becomes `key=[REDACTED]`.
- **HAPI exception messages:** the class and `HAPI-NNNN` code are kept, the message is dropped.
- **JSON keys** (`family`, `given`, `birthDate`, `city`, `telecom`, ...) in an echoed resource
  fragment; **SSN, e-mail, `MRN...`, `DOB...`** shapes; **DICOM** `(0010,0010/0020/0030/0040)`
  tag lines and `PatientName=`/`PatientID=`/`PatientBirthDate=`.
- **Metric labels:** deny by default.

## What it does NOT cover (read before relying on it)

- **Free text.** There is no name detector. A patient name written into an arbitrary log
  message in a shape no rule knows ("Loading chart for Jane Doe") passes untouched. The
  guarantee is "the known HAPI channels are scrubbed", not "no PHI can ever appear".
- **Only the engine output that was captured.** The suite proves the sentinel is absent for
  HAPI 8.12.0 base-image behaviour with H2. It does not cover the W2-3 interceptors, which add
  their own logging, nor the DICOM engine, nor Postgres-side logs.
- **Not a stamp run.** The local run uses an in-memory H2 database, no plugin jar, and the
  agent's `logging` exporters (spans and metrics printed to the same stream). The production
  OTLP export path was not exercised: `scrubOtlp` is tested on a **synthetic** document only.
  The on-stamp run is a later item.
- **Metric labels:** HAPI's own metrics do not carry the sentinel except through the exemplar
  `url.query` above, so the "label allow-list" is proven by unit test, not by a leak the real
  engine produces.
- **Wiring.** How the filter sits next to the engine (the distroless HAPI image has no shell, so
  a `java | scrubber` pipe is not available; a sidecar tailing a shared log volume, or a log
  agent stage, is) is **not implemented here**. The `Dockerfile` only packages the filter.
  Until the engine's stdout is actually routed through it on a stamp, nothing is scrubbed in
  production.
- **Ids are not redacted.** `Patient/1000` stays in access logs by design
  (`SECURITY-AND-COMPLIANCE.md` 8.3: ids are logged, and logs are in the audit retention class).
- **Network and storage:** request/response bodies on the wire and at rest are out of scope.

## Tests

```bash
node --test tests/health/log-scrub.test.mjs                        # replays a committed real capture; no Docker
LHDS_SCRUB_LIVE=1 node --test tests/health/log-scrub.test.mjs      # re-captures from the real HAPI image (Docker, ~1 min)
node apps/loom-health-scrubber/scripts/capture-hapi.mjs <outdir>   # refresh fixtures/ (capture.log, ops.json)
```

`node:test` was chosen over vitest because the scrubber is plain ESM with no dependencies and
the sibling `apps/loom-health-fhir/tests/` already use it. The suite includes a positive
control: with the scrubber replaced by a byte copy the sentinel must be visible in the log,
trace, metric and exception output, otherwise the "absent after scrubbing" test is vacuous.

`fixtures/capture.log` drops ~24,600 background cache-refresh span lines (thread
`search-parameter-identity-cache-*`) from the real capture to stay under half a megabyte; every
request-thread line is kept.
