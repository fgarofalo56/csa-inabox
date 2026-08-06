# Real ARM deployment-operation output — run 31069329802

Captured 2026-08-06 from the live Commercial estate with:

```
az deployment operation sub   list --name csa-loom-ci-31069329802            -o json
az deployment operation group list -g rg-csa-loom-admin-centralus --name admin-plane      -o json
az deployment operation group list -g rg-csa-loom-admin-centralus --name network          -o json
az deployment operation group list -g rg-csa-loom-admin-centralus --name swa-publish-rbac -o json
```

This is what `deploy-fiab-commercial` run **31069329802** actually failed with
(issue #3039). The ONLY edit is the subscription GUID, replaced everywhere with
`00000000-0000-0000-0000-000000000000`. Codes, messages, `provisioningState`,
`targetResource` types/names and the whole nested `details[]` chain are
byte-for-byte what ARM returned — so the test measures the real shape, not a
shape modelled on the parser (`csa_loom_fixtures_that_model_the_code`).

The two leaf causes these carry, and which the run's own stderr did NOT:

```
BadRequest            A virtual network cannot be linked to multiple zones with
                      overlapping namespaces. …
RoleAssignmentExists  The role assignment already exists. …
```

File names encode the call: `<scope>--[<resource-group>--]<deployment>.json`.
