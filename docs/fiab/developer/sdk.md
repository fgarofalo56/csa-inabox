# SDKs

## Today: generate one from the OpenAPI spec

The Loom API publishes a complete **OpenAPI 3.1** document at
`GET /api/openapi.json`. Generate a typed client for any language:

```bash
# Python
openapi-generator-cli generate -i https://<host>/api/openapi.json -g python -o ./loom-py
# TypeScript
openapi-generator-cli generate -i https://<host>/api/openapi.json -g typescript-fetch -o ./loom-ts
```

Authenticate every request with a scoped API token
(`Authorization: Bearer loom_pat_…`). Because the spec's server URL is your
deployment, the generated client targets the correct cloud automatically.

## Roadmap: first-party packages

Thin, hand-maintained TypeScript (`@csa-loom/sdk`) and Python (`csa-loom`)
clients — mirroring the ergonomics of the `loom` CLI — are scoped and sequenced
in the [SDK + Terraform roadmap](../roadmap/loom-sdk-terraform.md). They build on
the shipped foundation (the REST API + the CLI); until they are published, the
generated-client path above is fully supported.
