# Issue batches

About 460 open GitHub issues had no owner once the old drain harness went idle. The `ib-NN-*` PRPs in this directory give them one.

## The scheme

- **About 5 issues per PRP (maximum 6), grouped by the files they edit**, not by title. An earlier pass clustered by title only; every batch here was rebuilt by reading each issue and grepping the repo for the files it needs. Issues that turned out to be already fixed on main, or that need a different owner, are dropped to a `Deferred candidates` line in the batch with the reason.
- **One batch lane runs beside the program lanes** (LHDS, apigw, loom-brain, and so on). Batches are program-local wave 1; a batch that shares a file with an earlier one is wave 2 and declares `depends_on` (for example `ib-04-no-freeform-pickers-b` after `ib-03-no-freeform-pickers-a`, because both edit `scripts/ci/check-no-freeform.mjs` and its baseline).
- **Two batches never own the same file** unless one depends on the other. `Owns` lists exact paths.
- **Verify before fixing.** Many issue bodies describe a tree that has since moved. Each batch starts by measuring the current state (for guard-strength issues: run the named mutation on a sandbox copy), and only edits where the defect still reproduces.
- **An issue closes only when deployed and verified, never on merge.** A merged batch is reported as "merged, not deployed" until the estate is rolled and the issue's own acceptance is observed live (`deploy-integrity.md` R2). Operators close issues; batches do not use closing keywords.
- Each batch is a normal 16-section PRP with an `Execution state` row per issue.

## Index

| PRP | Family | Issues |
|---|---|---|
| `ib-01-brain-detectors-a` | brain graph, detectors and agents guard-strength (verify and close) | 3963, 3964, 3967, 3970, 4016 |
| `ib-02-brain-detectors-b` | security-graph extractor and artifact | 4411, 4504, 4522, 4806, 4819 |
| `ib-03-no-freeform-pickers-a` | console free-text to pickers, part 1 | 4389, 4444, 4816 |
| `ib-04-no-freeform-pickers-b` | console free-text to pickers, part 2 (serial after ib-03) | 4854, 3626, 4039 |
| `ib-05-slate-parity-a` | slate app widget kinds and inspector | 4374, 4360, 4362, 4929, 4368 |
| `ib-06-ci-guards-a` | CI and hook guard strength | 4614, 4624, 4580, 4581, 4359, 4358 |

`ib-07` to `ib-12` are written by a second lane and indexed separately.
