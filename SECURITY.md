# Security Policy

## Supported Versions

CSA-in-a-Box ships continuously from `main`. There are no long-lived release branches; security fixes land on `main` and are picked up on next consumer pull.

| Version | Supported |
|---------|-----------|
| `main` (HEAD) | ✅ |
| Tagged releases (`v*`) | Best-effort for 90 days after newer tag |
| Forks / customer copies | Customer-maintained |

## Reporting a Vulnerability

**Please do not file public GitHub Issues for security vulnerabilities.**

Use one of:

1. **GitHub Security Advisories** (preferred) — open a private advisory at [Security › Advisories › Report a vulnerability](https://github.com/fgarofalo56/csa-inabox/security/advisories/new). This keeps the report private until a fix is ready.
2. **Email** — `security@<maintainer-domain>` (replace with maintainer-of-record contact in your fork).

Please include:
- Affected file(s), commit SHA, or deployment artifact
- Reproduction steps or PoC
- Impact assessment (confidentiality / integrity / availability)
- Your suggested CVSS v3.1 vector if you have one
- Whether you'd like public credit when the advisory is published

## Response Targets

| Severity | First response | Triage decision | Fix target |
|----------|---------------|-----------------|------------|
| Critical (RCE, auth bypass, secret exposure) | 1 business day | 3 business days | 7 days |
| High (privilege escalation, data leak) | 2 business days | 5 business days | 30 days |
| Medium (DoS, misconfiguration leading to harm) | 5 business days | 10 business days | 90 days |
| Low (info disclosure with no PII, hardening) | 10 business days | next quarter | next quarter |

## Scope

**In scope:**
- Source under `csa_platform/`, `apps/`, `portal/`, `azure-functions/`
- IaC under `deploy/bicep/` (mis-defaults that produce insecure deployments)
- CI/CD workflows under `.github/workflows/` (supply-chain)
- Documented examples under `examples/` if a referenced default is exploitable

**Out of scope:**
- Issues that require already-compromised credentials or root on the host
- Vulnerabilities in upstream dependencies — please report to the upstream project; we'll bump after upstream releases
- Theoretical issues without a working PoC against a representative deployment
- Findings against the public docs site (`https://fgarofalo56.github.io/csa-inabox/`) — this is a static site; no auth, no backend

## Coordinated Disclosure

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure):

1. Reporter sends private report
2. We confirm receipt within the SLA above
3. We work on a fix in a private branch / advisory
4. We agree on a public disclosure date (default: when fix is merged, or 90 days after report — whichever is sooner)
5. We publish a GHSA advisory with credit (or not, your choice)
6. We backport to recent tagged releases when applicable

## Hardening Resources

If you're deploying CSA-in-a-Box and want to reduce attack surface before reporting one:

- [Production Checklist](docs/PRODUCTION_CHECKLIST.md)
- [Security & Compliance Best Practices](docs/best-practices/security-compliance.md)
- [Reference Architecture — Identity & Secrets](docs/reference-architecture/identity-secrets-flow.md)
- [Networking & DNS Strategy](docs/patterns/networking-dns-strategy.md)
- [Compliance crosswalks](docs/compliance/) — FedRAMP Moderate, SOC 2 Type II, PCI-DSS v4, GDPR, NIST 800-53, HIPAA, CMMC

## PGP

Currently no PGP key is published. If you need to send encrypted material, request a key in your initial (clear-text) report and we'll exchange one out-of-band.
