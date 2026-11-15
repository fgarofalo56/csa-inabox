# Estate power - Commercial receipts (lane A)

Status: PARTIAL. Resume and Pause legs RUN and read back on 2026-11-15 (UTC) against main `fd9f80ebe`; the unattended
idle auto-pause receipt is still owed; one defect found (resume reports RUNNING with the gateway VM still deallocated).
Boundary: Commercial only. GCC-High is lane B; IL5 never run; GCC supported-in-code, never exercised.
The estate was found PAUSED and was left PAUSED (operator decision 2026-11-15: resume, verify, pause again).

## Resume then Pause cycle (operator-approved)

| Leg | Run | Window (UTC) | Run result | State read by a separate `action=state` run |
|---|---|---|---|---|
| Resume (`action=resume dry_run=false`) | 43675916011 | 04:14:58 to 04:26:44 | success; log line `VERIFIED: the console reports RUNNING.` | run 43676835860: `state=RUNNING`, `lastResumedAt=2026-11-15T04:26:40.501Z` |
| Pause (`action=pause dry_run=false confirm=<estate id>`) | 43676954494 | 04:28:58 to 04:35:58 | success; log line `VERIFIED: the console reports PAUSED.` | not re-dispatched; the pause run read `state=RUNNING` at its start |

Safety gate before each mutation: no deploy, roll, build-images or bootstrap run in progress or queued (only push CI,
a stale license-scan from 2026-08-12 and a queued `deploy-staleness` run from 2026-11-11).

**Defect found (resume).** The resume run's own readback lists 8 resources: 7 `Online` and
`vm-loom-pbigw-centralus | Deallocated`, yet it printed `VERIFIED: the console reports RUNNING.` An independent
`az vm get-instance-view` at 04:27:33Z and again at 04:28:25Z returned `PowerState/deallocated`. Either the VM is
deliberately excluded from resume (then the run should say so and not list it in the resume set), or resume declares
success with a resource not at its expected state. Not fixed here; the pause leg's wording ("every resource at its
expected state") has no equivalent on the resume leg.

## State as found (before the cycle)

The lane's first pass stopped here because its gate allowed a pause only from `RUNNING`:

| Field | Value |
|---|---|
| `estate-power.yml` Commercial `action=state`, run 43675258217 (2026-11-15T04:06Z, success) | `state=PAUSED`, `lastPausedAt=2026-10-25T20:52:15.878Z`, `lastResumedAt=n/a`, `lastActivityAt=2026-11-13T04:01:21.913Z` |
| estate id | `loom:e093f4fd:rg-csa-loom-admin-centralus` |
| State listing (8 resources) | loom-dab-preview, loom-udf-runtime, loom-directlake, loom-transform-runner (Container Apps); vm-loom-pbigw-centralus; loompool (Synapse SQL pool); adx-csa-loom-z52x3p (ADX); aasloomk6mvh5sm6z7do (AAS) |
| `action=preview`, run 43675306613 (success) | pause set from this state is 4 resources: VM deallocate, loompool arm-pause, ADX arm-stop, AAS arm-stop (Container Apps already at 0) |

Resuming a 3-week-old pause is a declared-state decision for the operator, so the first pass sent no mutation. The operator then chose resume, verify, pause again; that cycle is the section above.

Safety gate at 2026-11-15T04:05Z: in_progress runs were docs deploy, Loom Guardrails, CodeQL, copilot-quality-evals, Trivy, Test Suite (all push events on main) and a stale license-scan from 2026-08-12; queued was one `deploy-staleness` schedule run from 2026-11-11. No deploy, roll, build-images or bootstrap run in flight.

Live build marker: `sha=3ff103559102d1e2c1e6b75b080cb1f4849e5db4 stamp=20261114T234918Z`. Commits on origin/main after that sha: 1 (`fd9f80ebe`, docs only). The diff for `apps/fiab-console/lib/estate` and `scripts/estate-power` between the live sha and main is empty, so no estate code merge is missing from the live console.

## Per-resource ARM readbacks

Independent reads use local `az` against the Commercial DMLZ subscription (explicit `--subscription`), not the workflow.
"Console" is the workflow's own readback block, which is the same system that performed the action.

| Resource | After resume, console | After resume, independent (04:27:33Z) | After pause, console | After pause, independent (04:36:30Z) |
|---|---|---|---|---|
| adx-csa-loom-z52x3p (ADX) | Online | `Running` | Stopped | `Stopped` |
| aasloomk6mvh5sm6z7do (AAS) | Online | `Succeeded` (the running state for this service) | Paused | `Paused` |
| vm-loom-pbigw-centralus (VM) | **Deallocated** | `PowerState/deallocated` | Deallocated | `PowerState/deallocated` |
| loompool (Synapse SQL pool) | Online | NOT READ | Paused | NOT READ |
| 4 Container Apps (dab-preview, udf-runtime, directlake, transform-runner) | Online | NOT READ | Paused | NOT READ |

NOT READ, and why: `az resource list --resource-type Microsoft.Synapse/workspaces` returned no workspace in that
subscription for this identity, so the pool could not be located; the query path was never shown to work for the pool
(no positive control), so its two cells rest on the console alone. The Container Apps were not queried independently.
The VM row cannot distinguish "pause deallocated it" from "it was already deallocated": it never left that state.

Console health: `GET /build-marker.txt` returned 200 after the resume and after the pause. A signed-in page load and
`GET /api/admin/estate/state` from a browser session were NOT done (PRP step 4 asks for both).

## Idle auto-pause: the schedule's actual behaviour

Population: the last 20 runs of `estate-idle-autopause.yml` (`gh run list --workflow estate-idle-autopause.yml --limit 20`), all `event=schedule`, all `conclusion=success`, spanning 2026-11-09T20:39Z to 2026-11-15T01:16Z (about 124.6 h).

Run start times (UTC), newest first: 11-15 01:16, 11-14 21:23, 11-14 16:42, 11-14 10:11, 11-14 02:39, 11-13 22:07, 11-13 16:12, 11-13 07:50, 11-13 01:00, 11-12 19:50, 11-12 11:46, 11-12 03:19, 11-11 22:13, 11-11 15:07, 11-11 07:06, 11-11 00:35, 11-10 19:39, 11-10 11:41, 11-10 03:28, 11-09 20:39.

Cadence: the workflow cron is `7,37 * * * *` (every 30 minutes, about 249 expected runs in that window). Measured: 20 runs, 19 gaps, min about 3.9 h, max about 8.4 h, mean about 6.6 h, so roughly 1 run in 13 fires. Likely cause: GitHub schedule triggers are best-effort and are dropped under load (the workflow header itself records 12 dropped scheduled runs for the GCC-High deploy). Nothing in the workflow file explains a 4-8 h gap; it only sets per-boundary concurrency groups. This is inferred from platform behaviour, not proven. In practice a 2 h idle window resolves to 4-8 h.

What the runs decide: the newest run (43662330146, 2026-11-15T01:16Z) logged `AUTOPAUSE Commercial: SKIP (not-running) - estate state is "PAUSED", not RUNNING` and `AUTOPAUSE GCC-High: SKIP (declared-paused)`. Conclusion `success` over a SKIP is a no-op, not a pause. The other 19 runs were not opened.

Acceptance for the unattended-cron receipt (a `schedule`-event run whose summary says `PAUSE (idle)`) is NOT met: none exists in this population, and the estate was not RUNNING for one to fire. Step 5 is not this lane's run and remains open.

## Per-cloud status

Commercial: state, preview, resume and pause exercised today via `workflow_dispatch`; idle auto-pause on a `schedule` event not observed; signed-in console check not done. GCC-High: not touched (lane B). IL5: never run. GCC: supported-in-code, never exercised.
