# Maintainers

This file is the authoritative current list of CSA-in-a-Box maintainers and the routing for common contributor questions. It is the human counterpart to [`.github/CODEOWNERS`](.github/CODEOWNERS) (which routes individual paths) and [`docs/SUCCESSION.md`](docs/SUCCESSION.md) (which documents the on-ramp).

## Active maintainers

| GitHub | Role | Areas of primary responsibility |
|---|---|---|
| [@fgarofalo56](https://github.com/fgarofalo56) | Lead maintainer | Architecture, ADRs, IaC, CI/CD, docs site, releases |

The repo is currently single-maintainer. Adding a second maintainer is an explicit decision tracked in [`docs/SUCCESSION.md`](docs/SUCCESSION.md). The criteria for proposing a candidate are in [§1 of that doc](docs/SUCCESSION.md#1-criteria-for-naming-a-second-maintainer).

## Emeritus maintainers

_None yet._

## How to reach a maintainer

| Reason | Channel |
|---|---|
| Bug report | Open an issue using the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) |
| Feature request | Open an issue using the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) |
| Security vulnerability (private) | See [`SECURITY.md`](SECURITY.md) — do **not** open a public issue |
| Code of Conduct concern | See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — report by private issue with the `coc` label, or contact the lead maintainer directly |
| Maintainer-candidacy inquiry | Open a discussion or comment on an open ADR; criteria in [`docs/SUCCESSION.md` §1](docs/SUCCESSION.md#1-criteria-for-naming-a-second-maintainer) |
| Architecture question | See the [ADR index](docs/adr/), then open a discussion |
| Runbook clarification | See [Runbooks](docs/runbooks/) on the docs site |

## Decision process

Architectural decisions are captured as ADRs under [`docs/adr/`](docs/adr/) following the existing template (status / date / deciders / consulted / informed). Routine fixes flow through standard PR review. Substantive changes — new top-level package, new external dependency, new compliance posture, change to release process — should propose an ADR first.

## Release cadence

Releases are versioned by [release-please](.github/workflows/release-please.yml) and follow semantic versioning. Patch releases ship as soon as the changeset accrues; minor releases align with quarterly capability additions. See [`docs/RELEASE.md`](docs/RELEASE.md) for the full process.

## Service-level expectations

Best-effort response targets (single-maintainer):

| Item | Target |
|---|---|
| Security vulnerability (per `SECURITY.md`) | 48 hours acknowledgement |
| Bug affecting a documented runbook | 1 week |
| Bug affecting documentation only | 2 weeks |
| Feature request | Triaged within 2 weeks; no implementation commitment |
| Maintainer-candidacy inquiry | 1 week |

These targets are tracked informally today. When the repo onboards a second maintainer per [`docs/SUCCESSION.md`](docs/SUCCESSION.md), these targets become commitments.

---

_Last updated: 2026-05-17_
