# Release Process

This project uses [release-please](https://github.com/googleapis/release-please)
with [Conventional Commits](https://www.conventionalcommits.org/) for automated
versioning and CHANGELOG maintenance.

## How it works

1. PRs to `main` use Conventional Commits in their titles + body:
    - `feat: ...` → minor bump (pre-1.0: minor; post-1.0: minor)
    - `fix: ...` → patch bump
    - `feat!: ...` or `BREAKING CHANGE:` in body → major bump (post-1.0)
      or minor bump (pre-1.0 per `bump-minor-pre-major: true`)
    - `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `perf:` → no bump,
      shown in CHANGELOG
2. On push to `main`, `release-please` opens (or updates) a release PR
   that accumulates unreleased changes.
3. Merging the release PR:
    - Bumps `pyproject.toml` version
    - Updates `CHANGELOG.md`
    - Creates a git tag (`v0.1.0`, `v0.1.1`, ...)
    - Creates a GitHub Release with generated notes
4. Post-release, any deploy workflows keyed on tag push fire normally.

## Configuration

Release automation is driven by three files at the repository root:

- `.release-please-config.json` — release-type, changelog sections,
  bump rules (`bump-minor-pre-major: true` so pre-1.0 `feat!:` bumps
  minor, not major).
- `.release-please-manifest.json` — current version per package
  (`"." : "0.1.0"`).
- `.github/workflows/release-please.yml` — workflow that runs
  `googleapis/release-please-action@v4` on every push to `main`.

## Cutting v0.1.0 manually

The first release is initialized from the pre-seeded
`.release-please-manifest.json` and the `## [0.1.0]` entry in
`CHANGELOG.md`. To cut it:

1. Merge this commit to `main`.
2. `release-please` will open a PR against `main` with no-op bumps
   (the manifest already says 0.1.0). Review and merge.
3. Tag `v0.1.0` is created automatically; GitHub Release is
   populated from the CHANGELOG.

Alternatively, to tag manually without release-please (one-time for
the initial release):

```bash
git tag -a v0.1.0 -m "csa-inabox v0.1.0 — initial internal release"
git push origin v0.1.0
```

Prefer the release-please path for all future releases.

## Commit message format

```
<type>(<scope>): <subject>

<body — explain what and why, not how>

<footer — BREAKING CHANGE, Closes: #123, Co-Authored-By: ...>
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `ci`,
`perf`.

Scopes (non-exhaustive): `portal`, `governance`, `csa_platform`,
`deploy`, `security`, `ai`, `docs`, `ops`, `session`.

Examples:

- `feat(portal): add Owner step to registration wizard (CSA-0007)`
- `refactor(governance): consolidate governance trees (CSA-0126)`
- `fix(security): harden auth safety gate (CSA-0001/0018/0019)`

## Breaking changes

While the project is pre-1.0 (`0.x.y`), `feat!` / `BREAKING CHANGE:`
footers bump the minor (e.g., `0.1.x` → `0.2.0`) rather than the
major, per `bump-minor-pre-major: true`. Call out breakages in the
PR body so they flow into the generated CHANGELOG.

## Skipping release-please on a commit

To land a commit that should not influence release-please (e.g.,
adjusting release metadata itself), use the `chore:` type or include
`[skip release]` in the commit body. Prefer a non-release commit
type over skipping.
