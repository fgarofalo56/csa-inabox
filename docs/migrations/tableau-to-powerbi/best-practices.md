# Best Practices: Tableau to Power BI Migration

**Practical guidance for user training, phased rollout, calculation conversion priority, leveraging Power BI strengths, and avoiding the most common migration pitfalls.**

---

## 1. User training strategy

### 1.1 The champion network model

The single most effective adoption strategy is a champion network. Champions are enthusiastic Tableau power users who learn Power BI first and become the first-line support for their teams.

| Element | Details |
|---|---|
| **Champion ratio** | 1 champion per 15-20 users |
| **Selection criteria** | Enthusiastic Tableau power user; respected by peers; willing to learn first |
| **Training timeline** | Champions train 2-3 weeks before general rollout |
| **Responsibilities** | First-line support, lead team office hours, assist with workbook conversion, report issues |
| **Recognition** | Monthly champion spotlight, early access to new features, LinkedIn certification pathway |
| **Escalation path** | Champion → BI team → Microsoft support |
| **Communication channel** | Dedicated Teams channel for champions to share tips and escalate issues |

### 1.2 Training curriculum by role

**Consumers (view, interact, subscribe) — 1 day**

| Session | Duration | Topics |
|---|---|---|
| Session 1 | 2 hours | Navigating Power BI Service, finding reports, using slicers and filters |
| Session 2 | 1 hour | Subscribing to reports, setting data alerts, mobile app |
| Session 3 | 1 hour | Using Q&A and Copilot for natural language queries |

**Creators (build reports, write DAX) — 5 days**

| Day | Duration | Topics |
|---|---|---|
| Day 1 | 3 hours | Power BI Desktop overview, connecting to csa-inabox Gold tables |
| Day 2 | 3 hours | Building visuals: charts, tables, maps, formatting |
| Day 3 | 3 hours | DAX fundamentals: measures, CALCULATE, filter context |
| Day 4 | 3 hours | DAX for Tableau users: LOD-to-CALCULATE workshop |
| Day 5 | 3 hours | Publishing, workspaces, sharing, deployment pipelines |

**Data modelers (star schema, semantic models) — 3 days**

| Day | Duration | Topics |
|---|---|---|
| Day 1 | 3 hours | Star schema design, relationships, composite models |
| Day 2 | 3 hours | Power Query (M language), data types, incremental refresh |
| Day 3 | 3 hours | RLS, deployment pipelines, Fabric Git integration, governance |

**Administrators — 2 days**

| Day | Duration | Topics |
|---|---|---|
| Day 1 | 3 hours | Admin portal, tenant settings, capacity management |
| Day 2 | 3 hours | Security (workspaces, RLS, sharing), monitoring, audit logs |

### 1.3 Hands-on lab approach

Every training session should include a lab where participants rebuild one of their own Tableau workbooks in Power BI.

**Lab progression:**

| Lab | Source workbook | Complexity | DAX required |
|---|---|---|---|
| Lab 1 | Simple dashboard (2-3 charts, no calcs) | Low | Base measures only |
| Lab 2 | Dashboard with filters and actions | Medium | Measures + slicer configuration |
| Lab 3 | Dashboard with calculated fields | Medium | Row-level calcs and aggregate measures |
| Lab 4 | Dashboard with LOD expressions | High | CALCULATE + ALLEXCEPT patterns |
| Lab 5 | Dashboard with table calculations | High | WINDOW, RANKX, time intelligence |

!!! tip "Use their own workbooks"
    Nothing accelerates adoption faster than seeing familiar data in the new tool. Have participants bring their most-used Tableau workbook to each lab session.

### 1.4 Post-training support

| Support mechanism | Duration | Frequency |
|---|---|---|
| Weekly office hours | First 6 weeks | 1 hour weekly, open Q&A |
| Champion Slack/Teams channel | Ongoing | Asynchronous, always-on |
| Monthly "Tips & Tricks" session | First 6 months | 30 minutes, showcasing best practices |
| Brown bag sessions | Quarterly | Champions present their best Power BI reports |
| DAX help desk | First 3 months | Champions + BI team provide DAX code review |

---

## 2. Phased rollout strategy

### 2.1 The three-wave approach

Do not attempt to migrate all workbooks simultaneously. Use a phased rollout:

**Wave 1: Pilot (4-6 weeks)**

- Select 5-10 workbooks owned by champions
- Convert and validate with champion oversight
- Gather feedback and refine the conversion process
- Build the semantic model foundation (shared models for primary data domains)
- Document lessons learned

**Wave 2: Priority workbooks (6-8 weeks)**

- Convert the top-20 most-used workbooks (identified by Tableau Server usage metrics)
- Deploy champion network for peer support
- Run parallel operation (Tableau + Power BI) for 2-4 weeks per workbook
- Validate numbers side-by-side before decommissioning Tableau version

**Wave 3: Long tail (8-12 weeks)**

- Convert remaining active workbooks
- Archive stale workbooks (not viewed in 90+ days) without conversion
- Decommission Tableau Server/Cloud
- Cancel Tableau licenses

### 2.2 Workbook prioritization matrix

| Factor | High priority | Low priority |
|---|---|---|
| Usage frequency | Viewed daily/weekly | Viewed monthly or less |
| Business criticality | Executive dashboards, operational reports | Ad-hoc analyses, one-time reports |
| Technical complexity | Simple (no LOD, no table calcs) | Complex (many LOD expressions, custom actions) |
| Data source readiness | Source already in csa-inabox Gold layer | Source requires new data pipeline |
| Owner engagement | Owner eager to migrate | Owner resistant or unavailable |

**Priority calculation:** High usage + Low complexity = migrate first. Low usage + High complexity = migrate last (or archive).

### 2.3 Parallel operation guidelines

During the transition period:

| Guideline | Details |
|---|---|
| Duration | 2-4 weeks of parallel operation per workbook |
| Validation | Daily comparison of key metrics between Tableau and Power BI |
| User feedback | Structured feedback form: "What's better? What's missing? What's broken?" |
| Rollback criteria | If > 3 critical data discrepancies found, pause migration and investigate |
| Cut-over criteria | 5 business days with zero reported discrepancies and positive user feedback |

---

## 3. Calculation conversion priority

### 3.1 Convert in this order

The order matters. Dependencies flow from simple to complex.

| Priority | Calculation type | Why this order |
|---|---|---|
| 1 | **Base measures** (SUM, COUNT, AVG) | Everything depends on these |
| 2 | **Simple calculated columns** (IF, SWITCH, math) | Row-level calcs are independent |
| 3 | **Time intelligence** (YoY, MTD, QTD) | Common and well-patterned in DAX |
| 4 | **FIXED LOD → CALCULATE patterns** | Most common LOD type; unlocks many reports |
| 5 | **INCLUDE/EXCLUDE LOD** | Less common; requires iterator functions |
| 6 | **Table calculations** (RANK, RUNNING_SUM) | Most different from Tableau; save for last |
| 7 | **Parameters** (What-If, field parameters) | Often depends on measures being done first |

### 3.2 When NOT to convert a calculation

Some Tableau calculations should be redesigned rather than converted:

| Tableau pattern | Instead of converting | Do this instead |
|---|---|---|
| LOD for simple percent-of-total | Write nested CALCULATE | Use built-in "Show value as" → "Percent of grand total" |
| Table calc for running total | Write complex DAX | Use the WINDOW function (DAX 2023+) |
| LOD for customer-level metric | Write complex CALCULATE | Create a Customer dimension table with pre-computed columns |
| Parameter for measure switching | Create What-If parameter | Use a field parameter (built-in since 2022) |
| LOD for cohort analysis | Write ALLEXCEPT | Create a Cohort calculated column on the customer table |

---

## 4. Do not replicate: redesign for Power BI

### 4.1 The pixel-perfect trap

The most common and most expensive migration anti-pattern is trying to replicate Tableau dashboards pixel-for-pixel in Power BI. Tableau and Power BI have different visual paradigms, and fighting the paradigm creates ugly, slow, hard-to-maintain reports.

**Instead:**

1. Document the **analytical questions** the Tableau dashboard answers
2. Identify the **key metrics and dimensions**
3. Design the Power BI report for **Power BI's strengths**
4. Accept that the report will **look different** — and that is fine

### 4.2 Leverage Power BI-specific features

After converting the core metrics, enhance the report with features Tableau does not have:

| Feature | How to use it | Value |
|---|---|---|
| **Drillthrough pages** | Create a detail page with drillthrough fields | Replace multiple Tableau worksheets with one interactive detail page |
| **Report page tooltips** | Create a tooltip-type page with detail visuals | Rich hover panels without navigation |
| **Bookmarks + buttons** | Create toggle buttons for show/hide panels | Replace Tableau dashboard containers |
| **Q&A visual** | Embed a Q&A box on the report | Let users ask ad-hoc questions without building new visuals |
| **Copilot** | Enable Copilot on the report | Users get AI-generated insights without DAX knowledge |
| **Smart Narratives** | Add a Smart Narrative visual | Automated text commentary on chart trends |
| **Key Influencers** | Add a Key Influencers visual | AI-driven root cause analysis for any metric |
| **Decomposition Tree** | Add a Decomposition Tree visual | Interactive drill into contributing factors |
| **Power BI Apps** | Package reports into an App | Clean, organized distribution to consumers |

### 4.3 When pixel-perfect IS required

For regulatory, compliance, or print-ready reports where exact formatting matters:

- Use **Power BI Paginated Reports** (not standard reports)
- Paginated Reports support precise page layout, headers, footers, subreports
- Export to PDF with exact formatting
- This is a capability Tableau does not have

---

## 5. Leveraging Copilot during migration

### 5.1 For migration teams

Copilot accelerates the migration process itself:

| Task | How Copilot helps |
|---|---|
| Writing DAX measures | Describe the calculation in English; Copilot generates DAX |
| Understanding existing DAX | Select a measure; Copilot explains what it does |
| Creating report layouts | Describe the dashboard needed; Copilot generates a page |
| Generating narratives | Add Smart Narrative visual; Copilot writes the summary |
| Troubleshooting DAX errors | Paste the error; Copilot suggests fixes |

### 5.2 For end users during transition

Copilot reduces the DAX learning curve for Tableau users:

- Users who cannot write DAX can ask Copilot natural language questions
- Q&A visual lets users type questions and get charts without building visuals
- Copilot generates suggested measures based on the semantic model
- This bridges the gap during the transition period while users learn DAX

---

## 6. Governance during migration

### 6.1 Workspace governance

| Practice | Details |
|---|---|
| **Naming convention** | Enforce consistent workspace names: `{Team} - {Purpose}` |
| **Workspace creation control** | Restrict workspace creation to specific security groups |
| **Certification** | Only data stewards can certify semantic models |
| **Endorsement** | Use "Promoted" for team-approved models; "Certified" for enterprise-approved |
| **Workspace cleanup** | Schedule quarterly review of workspace usage; archive inactive |

### 6.2 Semantic model governance

| Practice | Details |
|---|---|
| **One model per domain** | Sales, Finance, HR — not one model per report |
| **Measures in the model** | Never define measures in reports; always in the semantic model |
| **Version control** | Use Fabric Git integration (TMDL) for all production models |
| **Build permissions** | Restrict who can build reports on certified models |
| **Documentation** | Use Purview to catalog and document every semantic model |

---

## 7. Common pitfalls (and how to avoid them)

### Pitfall 1: Converting workbooks 1:1

**Symptom:** Migration team opens a Tableau workbook and tries to recreate every visual pixel-for-pixel.
**Why it fails:** Tableau's mark-based model and Power BI's field-based model are different paradigms. Fighting the paradigm creates slow, ugly reports.
**Fix:** Document the analytical questions, redesign for Power BI's strengths.

### Pitfall 2: Skipping the data model

**Symptom:** Teams drag a flat, wide, denormalized table into Power BI and start building reports.
**Why it fails:** Power BI's Vertipaq engine is optimized for star schemas. Flat tables cause poor performance, high memory usage, and complex DAX.
**Fix:** Invest time upfront in designing a proper star schema. Every hour on the model saves ten hours of DAX.

### Pitfall 3: Translating LOD expressions line-by-line

**Symptom:** Migration team converts `{ FIXED [Region] : SUM([Sales]) }` to DAX by trying to match the syntax.
**Why it fails:** LOD and DAX have different conceptual models (level of detail vs filter context).
**Fix:** Understand DAX filter context first, then use the pattern mapping tables. Train creators on CALCULATE before they touch LOD migration.

### Pitfall 4: Importing too much data

**Symptom:** Teams import 50 GB tables into Import mode because "that's how we did it in Tableau."
**Why it fails:** Import mode stores everything in memory. Large imports cause slow refresh, high memory pressure, and gateway timeouts.
**Fix:** Use DirectQuery or Direct Lake for large datasets. Import mode is for datasets under 1 GB or slowly-changing dimensions.

### Pitfall 5: Putting business logic in Power Query

**Symptom:** Complex business calculations live in Power Query M code instead of DAX measures.
**Why it fails:** Power Query runs at refresh time, not at query time. Changes require a full refresh. Logic is harder to debug and version-control.
**Fix:** Power Query handles connectivity and light shaping. Business logic goes in DAX measures. Heavy transformation goes in dbt models.

### Pitfall 6: Not using shared semantic models

**Symptom:** Every report has its own embedded semantic model with its own connections and measures.
**Why it fails:** Duplicate logic, divergent numbers, no single source of truth. This recreates Tableau's worst pattern.
**Fix:** Create shared semantic models per data domain. Reports connect via live connection. Certify the model.

### Pitfall 7: Ignoring Copilot and Q&A

**Symptom:** Migration team builds traditional dashboards without enabling AI features.
**Why it misses:** Copilot and Q&A are the features that help Tableau users transition and reduce the DAX learning curve.
**Fix:** Enable Copilot on every report. Add Q&A visuals where appropriate. Show users how to ask questions in natural language.

### Pitfall 8: No parallel operation period

**Symptom:** Team decommissions Tableau workbooks immediately after publishing Power BI reports.
**Why it fails:** Undiscovered data discrepancies, missing features, and user confusion. No rollback path.
**Fix:** Run parallel for 2-4 weeks. Validate numbers daily. Get formal sign-off from workbook owners before decommission.

---

## 8. Migration success metrics

Track these metrics to measure migration success:

| Metric | Target | How to measure |
|---|---|---|
| **Report adoption** | 80% of migrated reports viewed weekly within 30 days | Power BI usage metrics |
| **User satisfaction** | NPS > 0 within 60 days (positive momentum) | Survey after 30 and 60 days |
| **DAX proficiency** | Champions can write CALCULATE patterns unassisted | Skills assessment quiz |
| **Data accuracy** | Zero critical discrepancies after parallel validation | Side-by-side comparison logs |
| **Tableau license reduction** | 100% reduction within 90 days of last workbook migration | Procurement records |
| **Support ticket volume** | Declining trend after Week 4 | Help desk / champion channel metrics |
| **Copilot usage** | 30%+ of users using Q&A or Copilot within 60 days | Admin portal activity logs |
| **Time to report** | Creators can build a report from scratch in < 2 hours by Week 8 | Skills assessment |

---

## 9. Post-migration checklist

After all workbooks are migrated and Tableau is decommissioned:

- [ ] All Tableau licenses cancelled or not renewed
- [ ] All Tableau Server VMs decommissioned or repurposed
- [ ] All .twbx/.twb files archived (retain for 90 days minimum)
- [ ] All Power BI reports published and accessible
- [ ] All semantic models certified and documented in Purview
- [ ] All RLS roles configured and tested
- [ ] All scheduled refreshes running successfully
- [ ] All subscriptions and alerts migrated
- [ ] Champion network active and supported
- [ ] Training materials archived for onboarding new users
- [ ] Migration retrospective conducted and documented
- [ ] Post-migration survey sent to all users

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Why Power BI over Tableau](why-powerbi-over-tableau.md) | [Benchmarks](benchmarks.md) | [Migration Playbook](../tableau-to-powerbi.md) | [Tutorials](index.md#tutorials)
