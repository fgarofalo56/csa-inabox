# loom-copilot-maf — MAF orchestration tier (GCC-High / IL5)

Microsoft Agent Framework (MAF) Container App that runs the CSA Loom Copilot
agent loop against **Gov Azure OpenAI direct** (`*.openai.azure.us`), bypassing
the two AI-Foundry paths the Console's in-process orchestrator uses (Foundry-hub
`listConnections()` discovery and the `services.ai.azure.com` Agent Service
endpoint), neither of which is reliable in Azure Government boundaries.

## Why this tier exists

In Commercial / GCC the Console resolves AOAI via the Foundry hub. In
GCC-High / IL5 (`AzureUSGovernment`):

- The Foundry hub is frequently deployed `kind=Default` (classic AML), where the
  `/connections` discovery the orchestrator relies on behaves differently.
- The Foundry **Agent Service** endpoint (`*.services.ai.azure.com`) has no
  confirmed Gov host.
- **Azure OpenAI itself is IL5-authorized** (FedRAMP High, DoD IL4/IL5/IL6) and
  reachable at `*.openai.azure.us` with token audience
  `https://cognitiveservices.azure.us`.

So in Gov the Console auto-routes `orchestrate()` to this app, which calls AOAI
directly and gets a real completion.

## Same contract, same dispatch

- **Transcript shape** is identical — this app emits the same
  `OrchestratorStep` discriminated union over SSE (`event: step`).
- **Tool dispatch + OBO** stay in the Console: when the model requests a tool,
  this app POSTs to the Console's token-gated internal endpoint
  (`/api/internal/copilot/tools/<name>/invoke`) forwarding the user's `oid`, so
  the *exact same handlers*, Azure backends, Cosmos containers, and per-user
  ownership run.
- **Persistence** is single-sourced in the Console: `orchestrateViaMaf()`
  re-yields and persists each step into the shared `copilot-sessions` container.

## HTTP surface

| Method | Path           | Notes                                                            |
|--------|----------------|-----------------------------------------------------------------|
| GET    | `/health`      | `{ ok, tier:'maf', cloud, gov }`                                 |
| POST   | `/orchestrate` | SSE `OrchestratorStep` stream. Header `x-user-oid` required.     |

VNet-internal only (Container Apps internal ingress). Not MSAL-authenticated;
the Console forwards the trusted `x-user-oid`. The callback to the Console is
authenticated with the shared `LOOM_INTERNAL_TOKEN`.

## Environment

| Var                      | Purpose                                                                 |
|--------------------------|-------------------------------------------------------------------------|
| `PORT`                   | Listen port (default `3100`).                                           |
| `AZURE_CLIENT_ID`        | MAF UAMI client id (token source for AOAI).                            |
| `AZURE_CLOUD`            | `AzureUSGovernment` (default) — drives the `cognitiveservices.azure.us` scope. |
| `LOOM_AOAI_ENDPOINT`     | Gov AOAI endpoint `https://<acct>.openai.azure.us/`.                     |
| `LOOM_AOAI_DEPLOYMENT`   | Chat deployment name (e.g. `gpt-4o`).                                    |
| `LOOM_AOAI_API_VERSION`  | AOAI API version (default `2024-10-21`).                                 |
| `LOOM_AOAI_AUDIENCE`     | Optional AOAI token audience override.                                   |
| `LOOM_CONSOLE_ENDPOINT`  | Console internal base URL (e.g. `http://loom-console`) for tool dispatch.|
| `LOOM_INTERNAL_TOKEN`    | Shared secret authenticating the tool-dispatch callback.                |

Deployed by `platform/fiab/bicep/modules/copilot/maf.bicep`, auto-selected when
`copilotMafEnabled=true` and the boundary is GCC-High / IL5.
