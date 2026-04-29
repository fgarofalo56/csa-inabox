# Support

CSA-in-a-Box is an opinionated reference platform, not a Microsoft-supported product. Use the channels below in priority order.

## Quick links

| You want to...                    | Use                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Read the docs                     | https://fgarofalo56.github.io/csa-inabox/                                                                |
| Get started in 30 minutes         | [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)                                                       |
| Find an example for your scenario | [docs/examples/](docs/examples/) — 17 verticals                                                          |
| Report a security vulnerability   | See [SECURITY.md](SECURITY.md) — **do not file a public issue**                                          |
| Report a bug                      | [GitHub Issues](https://github.com/fgarofalo56/csa-inabox/issues/new) — use the bug template             |
| Request a feature                 | [GitHub Issues](https://github.com/fgarofalo56/csa-inabox/issues/new) — use the feature template         |
| Ask a question                    | [GitHub Discussions](https://github.com/fgarofalo56/csa-inabox/discussions) (preferred) or open an issue |
| Contribute                        | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                       |

## Response expectations

This is a community-maintained reference platform. Maintainers respond on best-effort basis:

| Channel                     | Typical response                       |
| --------------------------- | -------------------------------------- |
| Security advisory (private) | See SLAs in [SECURITY.md](SECURITY.md) |
| Bug with reproducer         | 5 business days                        |
| Bug without reproducer      | Triaged when bandwidth permits         |
| Feature request             | Triaged monthly                        |
| Question on Discussions     | Best effort; community-answered        |

**There is no commercial SLA.** If you need guaranteed response times, fork the repo and operate it yourself, or engage a Microsoft Unified Support contract for the underlying Azure services.

## Microsoft Azure issues vs CSA-in-a-Box issues

| Symptom                                      | Where to file                  |
| -------------------------------------------- | ------------------------------ |
| `bicep build` fails on a CSA-in-a-Box module | This repo (Issues)             |
| `az deployment` returns 500 from ARM         | Azure Support — not us         |
| AOAI quota / region availability             | Azure Support                  |
| MkDocs site renders wrong                    | This repo (Issues)             |
| `dbt` model fails on a synthetic dataset     | This repo (Issues)             |
| Power BI Direct Lake doesn't refresh         | Azure Support / Fabric Support |
| `az login` fails with WAM error              | Azure CLI repo, not here       |

## Asking good questions

To get useful answers fast, please include:

1. **Which CSA-in-a-Box commit** (`git rev-parse HEAD`)
2. **Which example or module** you're using (path)
3. **Azure region + cloud** (Commercial / Government / China)
4. **Exact command + full output** (sanitized of secrets)
5. **What you expected to happen**
6. **What you've already tried**

A well-formed issue with logs gets triaged the same day. A "doesn't work, please help" gets queued.

## Diagnostic info to collect

```bash
# Repo state
git rev-parse HEAD
git status
git remote -v

# Tooling
az --version
bicep --version
python --version
docker --version
node --version
mkdocs --version

# Subscription context
az account show --output table
az group list --query "[?starts_with(name, 'rg-csa-')].name" -o table
```

## Commercial support

If you need:

- Guaranteed response times
- Architecture review of your deployment
- Custom feature work
- Long-term support of a forked release

…engage a Microsoft partner or your Microsoft account team. This repo is **not** a commercial product offering.
