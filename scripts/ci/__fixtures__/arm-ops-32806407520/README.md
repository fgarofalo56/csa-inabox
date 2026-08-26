# Real ARM deployment-operation output — run 32806407520

Captured 2026-08-25 from the live Commercial estate with:

```
az deployment operation sub   list --name csa-loom-ci-32806407520          -o json
az deployment operation group list -g rg-csa-loom-admin-centralus --name admin-plane -o json
az deployment operation group list -g rg-csa-loom-admin-centralus --name aas-server  -o json
```

This is what `deploy-fiab-commercial` run **32806407520** actually failed with
(issue #3948). The walk is `sub → admin-plane → aas-server → the AAS server`.

## What was edited, and nothing else

This is a **public** repo, so the capture is masked in exactly three ways:

| Masked | Replaced with |
|---|---|
| the subscription id | `00000000-0000-0000-0000-000000000000` |
| every other GUID (`RootActivityId`, `trackingId`) | `aaaaaaaa-bbbb-cccc-dddd-0000000000NN`, stable per distinct value |
| the estate's `uniqueString` suffix in resource names | `fixturesuffix` |

`admin-plane` is additionally trimmed to its **failed** operations (1 of 87) —
the walk reads only those and the nested targets under them, and 87 successful
operations is 100 KB of noise. `sub` and `aas-server` are complete.

Codes, messages, `statusCode`, `duration`, `provisioningState`,
`targetResource` types and the whole `details[]` chain are otherwise
byte-for-byte what ARM returned — so the test measures the real shape, not a
shape modelled on the parser (`csa_loom_fixtures_that_model_the_code`).

## The leaf this carries, and why the run could not see it

```
BadRequest  The server '<aas-server>' is currently being updated. Please try again later.
            details[]: RootActivityId=<guid>, Param1=<aas-server>
```

`Microsoft.AnalysisServices/servers`, `statusCode` BadRequest, `duration`
**PT0.3135239S** — an instant refusal, not a timeout.

The cause is in the **parent** `message`. `details[]` holds request diagnostics,
not nested errors — which is the opposite of ARM's own
`DeploymentFailed → ResourceDeploymentFailure` chain that `errorLeaves()` was
written against. So the walk descended past the sentence and handed the
classifier `RootActivityId: <guid>` and `Param1: <aas-server>`: two identifiers
with no cause in them. It reported `unknown`, failed closed, and the run exited
17 with the whole subscription deploy dead and nothing named.

`isDiagnosticAnnotation()` in `deploy-arm-errors.mjs` is what these fixtures
pin, and `transient.resource-mid-update` in the failure taxonomy is what now
classifies the result.

File names encode the call: `<scope>--[<resource-group>--]<deployment>.json`.
