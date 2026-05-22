"""mkdocs hook: promote `.architecture-hero` images to a full-grid page hero.

Pages across the site embed a hero image inline:

    ![alt](path/to/hero.svg){ .architecture-hero loading="eager" }

…optionally wrapped in a link::

    [![alt](path/to/hero.svg){ .architecture-hero }](TARGET.md "title")

Users want that hero to render as a banner that spans the FULL grid
width (left sidebar edge to right TOC edge) sitting between the top
navigation tabs and the main grid. The article's own content column is
too narrow for a banner role.

Implementation
--------------

This hook runs on the merged markdown (after include-markdown shims
expand). For the first `.architecture-hero` image found it:

1. Parses ``src``, ``alt``, and the optional surrounding link.
2. Stashes a dict on ``page.meta["page_hero"]``::

       {"src": "path/to/hero.svg", "alt": "...", "link": "TARGET.md" | None}

3. Removes the inline image line from the markdown so the article body
   does not double-render the hero.

The companion Material theme override at ``overrides/main.html`` reads
``page.meta.page_hero`` and renders the banner in the Material ``hero``
template block — which lives inside ``.md-container`` but outside
``.md-main__inner``, giving the banner full grid width.

Pages without a hero are returned unchanged.
"""

from __future__ import annotations

import posixpath
import re

# A markdown line containing an architecture-hero image. We accept the
# image either bare or wrapped in a link, with anchor text matching:
#
#   ![alt](src){ ... .architecture-hero ... }
#   [![alt](src){ ... .architecture-hero ... }](LINK "title")
#
# The regex captures the full line so callers can excise it cleanly.
_HERO_LINE_RE = re.compile(
    r"^.*!\[[^\]]*\]\([^)]+\)\{[^}]*\barchitecture-hero\b[^}]*\}.*$",
    re.MULTILINE,
)

# Inner extraction of src + alt from the image. Run on the captured
# line so we don't have to worry about line boundaries.
_HERO_IMG_RE = re.compile(
    r"!\[(?P<alt>[^\]]*)\]\((?P<src>[^)]+)\)\{[^}]*\barchitecture-hero\b[^}]*\}",
)

# Detect the link wrapper that puts the hero inside `[ ... ](TARGET)`.
# We tolerate an optional `"title"` after the target. The link target
# itself stops at whitespace or `)` so titles do not bleed in.
_HERO_LINK_RE = re.compile(
    r"\[!\[[^\]]*\]\([^)]+\)\{[^}]*\barchitecture-hero\b[^}]*\}\]"
    r"\((?P<link>[^\s)]+)(?:\s+\"[^\"]*\")?\)",
)


def _resolve_to_docs_root(src: str, page_src_path: str) -> str:
    """Convert a markdown image ``src`` to a docs-root-relative path.

    Markdown image paths are written relative to the source ``.md``
    file's directory. mkdocs's body-renderer rewrites them to be valid
    against the rendered page URL, but our hook bypasses that — we
    extract the raw src and hand it to the Material override template.
    The template will prepend ``base_url`` (which is relative to the
    rendered page's URL), so the path we hand it must be relative to
    the docs root.

    Examples (with ``page_src_path`` shown after each src):

    * ``assets/x.svg`` from ``index.md``                      -> ``assets/x.svg``
    * ``assets/x.svg`` from ``GETTING_STARTED.md``            -> ``assets/x.svg``
    * ``../../assets/x.png`` from ``tutorials/01-foo/README.md`` -> ``assets/x.png``

    Absolute paths and absolute URLs pass through unchanged.
    """
    if not src:
        return src
    # Absolute (web) URL — let it through.
    if src.startswith(("http://", "https://", "data:")):
        return src
    # Already root-relative (single leading slash). Strip the leading
    # slash so the template's ``base_url + "/" + src`` doesn't double-up.
    if src.startswith("/"):
        return src.lstrip("/")
    # page_src_path is repo-relative under docs/ — already without the
    # ``docs/`` prefix. e.g. ``tutorials/01-foundation-platform/README.md``.
    # Use posixpath.normpath so back-references resolve uniformly across
    # platforms (mkdocs always emits forward slashes for src_path).
    page_dir = posixpath.dirname(page_src_path.replace("\\", "/"))
    if page_dir:
        joined = posixpath.normpath(posixpath.join(page_dir, src))
    else:
        joined = posixpath.normpath(src)
    # If the resolved path tries to escape above docs root, fall back
    # to the original src and let mkdocs's link-checker complain.
    if joined.startswith("..") or joined == ".":
        return src
    return joined


# File-level default heroes for the standalone root-level markdown
# pages (ADF_SETUP.md, COST_MANAGEMENT.md, etc.). Keyed by the page's
# src_path (always forward-slash, no leading docs/). When a page has
# no inline hero AND no section default, we check this map.
_FILE_DEFAULTS: dict[str, tuple[str, str]] = {
    "ADF_SETUP.md": (
        "assets/images/hero/adf-setup.svg",
        "Azure Data Factory setup — linked services, integration runtime, pipelines",
    ),
    "COST_MANAGEMENT.md": (
        "assets/images/hero/cost-management.svg",
        "FinOps + cost management — budgets, alerts, reserved capacity, auto-pause",
    ),
    "DATABRICKS_GUIDE.md": (
        "assets/images/hero/databricks-guide.svg",
        "Azure Databricks — workspaces, clusters, jobs, Unity Catalog, MLflow",
    ),
    "DR.md": (
        "assets/images/hero/disaster-recovery.svg",
        "Disaster recovery — multi-region failover, RPO / RTO targets, chaos drills",
    ),
    "ENVIRONMENT_PROTECTION.md": (
        "assets/images/hero/environment-protection.svg",
        "Environment protection — required reviewers, deployment gates, branch policies",
    ),
    "GOV_SERVICE_MATRIX.md": (
        "assets/images/hero/gov-service-matrix.svg",
        "Azure Government service matrix — IL4 / IL5 / GCC / GCC-High availability",
    ),
    "IaC-CICD-Best-Practices.md": (
        "assets/images/hero/iac-cicd-best-practices.svg",
        "Infrastructure as Code + CI/CD — Bicep, GitHub Actions, environment promotion",
    ),
    "LOG_SCHEMA.md": (
        "assets/images/hero/log-schema.svg",
        "Log schema reference — Azure Monitor, App Insights, KQL field catalog",
    ),
    "MULTI_REGION.md": (
        "assets/images/hero/multi-region.svg",
        "Multi-region topology — paired regions, traffic manager, geo-replication",
    ),
    "MULTI_TENANT.md": (
        "assets/images/hero/multi-tenant.svg",
        "Multi-tenant isolation — per-tenant landing zones, governance, networking",
    ),
    "PLATFORM_SERVICES.md": (
        "assets/images/hero/platform-services.svg",
        "Platform services — shared identity, Key Vault, monitoring, networking",
    ),
    "ROLLBACK.md": (
        "assets/images/hero/rollback.svg",
        "Rollback playbook — feature-flag flip, version pinning, blue-green back",
    ),
    "SELF_HOSTED_IR.md": (
        "assets/images/hero/self-hosted-ir.svg",
        "Self-hosted Integration Runtime — on-prem connectivity for ADF / Synapse",
    ),
    "SUCCESSION.md": (
        "assets/images/hero/succession.svg",
        "Maintainer succession plan — roles, escalation paths, knowledge transfer",
    ),
    "SUPPLY_CHAIN.md": (
        "assets/images/hero/supply-chain.svg",
        "Supply-chain security — SBOM, signing, dependency scanning, OIDC",
    ),
    "TROUBLESHOOTING.md": (
        "assets/images/hero/troubleshooting.svg",
        "Troubleshooting flowcharts — diagnostics, common errors, escalation",
    ),
    "chat.md": (
        "assets/images/hero/chat.svg",
        "CSA Copilot chat — ask the docs with citations + MS Learn fallback",
    ),
    "cloud-shell-snippets.md": (
        "assets/images/hero/cloud-shell-snippets.svg",
        "Cloud Shell snippets — copy-runnable Azure CLI for every quickstart",
    ),
    "copilot-analytics.md": (
        "assets/images/hero/copilot-analytics.svg",
        "Copilot analytics — KQL queries, content-gap signals, operator runbook",
    ),
    "copilot-privacy.md": (
        "assets/images/hero/copilot-privacy.svg",
        "Copilot privacy notice — redaction, opt-out, retention, data handling",
    ),
    "fabric-in-gov-cloud.md": (
        "assets/images/hero/fabric-in-gov-cloud.svg",
        "Microsoft Fabric in Azure Government — capacity, parity, gap analysis",
    ),
}


_SECTION_DEFAULTS: dict[str, tuple[str, str]] = {
    "runbooks": (
        "assets/images/hero/runbooks/index.svg",
        "Operations runbooks — incident response, key rotation, DR drills, "
        "cost-alert response, and routine platform maintenance",
    ),
    "decisions": (
        "assets/images/hero/decisions/index.svg",
        "Decision trees — side-by-side service choices for batch vs "
        "streaming, lakehouse vs warehouse, RAG vs fine-tune, and more",
    ),
    "compliance": (
        "assets/images/hero/compliance/index.svg",
        "Compliance crosswalks — NIST 800-53, FedRAMP, CMMC, HIPAA, "
        "SOC 2, PCI-DSS, GDPR, IL4 / IL5, CJIS, ITAR",
    ),
    "adr": (
        "assets/images/hero/adr/index.svg",
        "Architecture Decision Records — the durable rationale behind "
        "every platform choice from ADF over Airflow to APIM as integration fabric",
    ),
    "guides": (
        "assets/images/hero/guides/index.svg",
        "Platform guides — Databricks, Synapse, Fabric, Cosmos, Purview, "
        "AI Foundry, and the orchestration layer",
    ),
    "industries": (
        "assets/images/hero/industries/index.svg",
        "Industry verticals — financial services, manufacturing, retail, "
        "energy, telecom, life sciences sector reference patterns",
    ),
    "migrations": (
        "assets/images/hero/migrations/index.svg",
        "Migration centers — AWS, GCP, Snowflake, Databricks, Teradata, "
        "Cloudera, Informatica, Palantir, SAS, Oracle to Azure",
    ),
    "assessments": (
        "assets/images/hero/assessments/index.svg",
        "Platform assessments — migration readiness, platform maturity, "
        "compliance gap analysis: score-then-roadmap workflows",
    ),
    "quickstarts": (
        "assets/images/hero/quickstarts/index.svg",
        "Role-based quickstarts — Data Engineer, Data Scientist, BI "
        "Developer, Security Admin, Platform Admin tracks",
    ),
    "patterns": (
        "assets/images/hero/patterns/index.svg",
        "Architecture patterns — Cosmos DB, AKS + Container Apps, "
        "LLMOps, networking + DNS, OpenTelemetry, streaming + CDC",
    ),
    "comparison": (
        "assets/images/hero/comparison/index.svg",
        "Comparisons — Azure side-by-side with MuleSoft, AWS API stack, "
        "Fabric, and other major data platforms",
    ),
    "learn": (
        "assets/images/hero/learn/index.svg",
        "Learn — Azure analytics reference library covering services, "
        "architecture patterns, tutorials, solutions, monitoring, DevOps",
    ),
    "use-cases": (
        "assets/images/hero/use-cases/index.svg",
        "Use cases — industry verticals, government scenarios, API-first "
        "ecosystems, legal, healthcare, financial services, cybersecurity",
    ),
    "research": (
        "assets/images/hero/research/index.svg",
        "Research — enterprise data platform trends, AI readiness, data "
        "mesh maturity, federal cloud adoption, API-first whitepaper",
    ),
    "governance": (
        "assets/images/hero/governance/index.svg",
        "Governance — data access, cataloging, lineage, quality, metadata "
        "management, Purview setup",
    ),
    "solution-store": (
        "assets/images/hero/solution-store/index.svg",
        "Solution store — Azure API-first accelerator catalog: pre-built "
        "Bicep + ARM templates, sample apps, integration patterns",
    ),
    # Section-level default for tutorial pages that don't have their own
    # numbered hero (tutorials/index.md, tutorials/great-expectations.md,
    # and any future legacy / unnumbered tutorial). The numbered
    # tutorials (01-17) carry their own inline hero via markdown.
    "tutorials": (
        "assets/images/hero/tutorials/index.svg",
        "Tutorials — 17 hands-on numbered tutorials plus legacy guides "
        "covering foundation deploy through Copilot integration",
    ),
}


def _default_hero(page_src_path: str) -> dict[str, str | None] | None:
    """Pick a default hero for the page.

    Resolution order:
      1. File-level default (``_FILE_DEFAULTS`` keyed by full ``src_path``)
      2. Section default (``_SECTION_DEFAULTS`` keyed by top-level dir)

    Returns ``None`` if neither matches — the page renders without a
    hero. The returned dict matches the ``page_hero`` shape the
    template expects.
    """
    if not page_src_path:
        return None
    normalized = page_src_path.replace("\\", "/")

    # 1. Exact file match (root-level standalone pages).
    file_spec = _FILE_DEFAULTS.get(normalized)
    if file_spec is not None:
        src, alt = file_spec
        return {"src": src, "alt": alt, "link": None}

    # 2. Top-level directory match.
    top = normalized.split("/", 1)[0]
    spec = _SECTION_DEFAULTS.get(top)
    if not spec:
        return None
    src, alt = spec
    return {"src": src, "alt": alt, "link": None}


# Backward-compat alias — the public surface used to be _section_default_hero
_section_default_hero = _default_hero


def on_page_markdown(markdown: str, page, config, files):  # noqa: ANN001 (mkdocs API)
    page_src_path = getattr(getattr(page, "file", None), "src_path", "") or ""

    hero_line_match = _HERO_LINE_RE.search(markdown)
    if not hero_line_match:
        # No inline hero — check if the page lives in a section that has
        # a configured default hero (runbooks, decisions, compliance, ADRs).
        default = _section_default_hero(page_src_path)
        if default is not None:
            if page.meta is None:  # pragma: no cover - defensive
                page.meta = {}
            page.meta["page_hero"] = default
        return markdown

    line = hero_line_match.group(0)

    img_match = _HERO_IMG_RE.search(line)
    if not img_match:
        return markdown

    alt = img_match.group("alt")
    src = img_match.group("src")

    link_match = _HERO_LINK_RE.search(line)
    link = link_match.group("link") if link_match else None

    # Resolve the markdown-relative src to a docs-root-relative path
    # so the template can prepend `base_url` and produce a working
    # link from any page URL depth.
    resolved_src = _resolve_to_docs_root(src, page_src_path)

    # Stash on page.meta so the Material override template can find it.
    if page.meta is None:  # pragma: no cover - defensive
        page.meta = {}
    page.meta["page_hero"] = {"src": resolved_src, "alt": alt, "link": link}

    # Excise the inline hero from the article body so it does not
    # render below the H1 — the override template now renders it.
    start, end = hero_line_match.span()
    rest = markdown[:start] + markdown[end:]

    # Collapse the blank-line gap left behind so the article body is
    # tight. Two consecutive newlines remain (paragraph break).
    rest = re.sub(r"\n{3,}", "\n\n", rest, count=1)
    return rest
