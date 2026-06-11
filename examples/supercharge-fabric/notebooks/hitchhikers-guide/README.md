# 🧭 The Hitchhiker's Guide to Fabric

> "DON'T PANIC." — A persona-organized notebook cheat-sheet for everything you
> can do inside a Fabric notebook. Every snippet is **April 2026 canonical
> Microsoft Learn syntax**, with the legacy patterns flagged where they still
> exist.

---

## What this is

Seven independently-runnable notebooks that you can import into any Fabric
workspace and use as a runtime reference. They are **not** a tutorial — each
file is a flat list of recipes you can copy/paste into a real notebook.

> 📓 **The notebook links below open the `.py` source on GitHub** (the docs
> site renders this guide page, not the notebook files themselves). Download
> or copy any notebook, then import it into your Fabric workspace.

| # | Notebook | Audience | When to open it |
|---|---|---|---|
| 00 | [`00_guide_index.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/00_guide_index.py) | Everyone | First time — read the conventions |
| 01 | [`01_guide_connectivity.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/01_guide_connectivity.py) | Data engineers, integration leads | "How do I connect Fabric to ___ ?" |
| 02 | [`02_guide_lakehouse_warehouse_ops.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/02_guide_lakehouse_warehouse_ops.py) | Data engineers | Delta, MERGE, OPTIMIZE, schemas, partitioning |
| 03 | [`03_guide_security_identity.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/03_guide_security_identity.py) | Security engineers | RLS, CLS, DDM, tokens, MSAL, Key Vault |
| 04 | [`04_guide_admin_governance.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/04_guide_admin_governance.py) | Platform admins | REST APIs for workspaces, lakehouses, Git, deployment pipelines |
| 05 | [`05_guide_automation_utilities.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/05_guide_automation_utilities.py) | Automation engineers | `notebookutils` everything, DAG runs, parameters |
| 06 | [`06_guide_troubleshooting.py`](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric/blob/main/notebooks/hitchhikers-guide/06_guide_troubleshooting.py) | Everyone (eventually) | Symptom → cause → fix table |

## Why "Hitchhiker's Guide"?

Because Microsoft Fabric is wide. The product surface area covers Spark,
T-SQL, KQL, DAX, Power Query M, Power BI semantic models, OneLake, Eventhouse,
Real-Time Intelligence, AI Foundry, GraphQL, mirroring, shortcuts, Git
integration, deployment pipelines, capacity admin, tenant admin, Purview…
and that's before you factor in connecting to anything outside Fabric.

Nobody can remember all of it. These notebooks are the cheat sheet you'd write
to yourself if you had time.

## How to import into your workspace

1. Clone or download this repo.
2. In Fabric, open your target workspace → **+ New** → **Import notebook**.
3. Select all `*.py` files in this folder. They import as Spark notebooks.
4. Attach each to a UC-enabled lakehouse so the relative paths and
   `notebookutils.lakehouse.*` cells resolve.

## Conventions

| Symbol | Meaning |
|---|---|
| 🚩 LEGACY | Works but Microsoft has deprecated or renamed it. |
| ✅ 2026-CANONICAL | Current Microsoft-recommended pattern. |
| ⚠️ PREVIEW | Feature labelled Preview in April 2026. |
| 💡 TIP | Non-obvious insight. |
| 🔗 | Source link to Microsoft Learn. |

## Related

- [Defense-in-Depth doc](../../best-practices/security/onelake-defense-in-depth.md)
  — companion conceptual guide.
- [Tutorial 57](../../tutorials/57-databricks-better-together/README.md) —
  the end-to-end walkthrough these notebooks were extracted from.
