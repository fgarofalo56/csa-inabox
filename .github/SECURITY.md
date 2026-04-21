# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, please report security issues via:
1. GitHub Security Advisories (preferred): Go to Security → Advisories → New draft advisory
2. Email: [security contact - to be configured]

We will acknowledge receipt within 48 hours and provide a detailed response within 5 business days.

## Security Measures

- All deployments require PR review and CI validation
- Secrets are managed via Azure Key Vault (never in code)
- Dependencies are scanned by Dependabot and Gitleaks
- Static analysis via CodeQL, Bandit, and Checkov
- Authentication via Microsoft Entra ID with JWT validation
- Authorization is domain-scoped (non-admin users see only their domain)
