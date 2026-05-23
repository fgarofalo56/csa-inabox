# CSA Loom — brand legal review package

Hand this packet to your legal / trademark counsel before public
announcement of the CSA Loom name. Captures clearance checks, prior-
art notes, and fallback chain.

## Brand summary

| Field | Value |
|---|---|
| Primary brand | **CSA Loom** |
| Tagline | *The loom that weaves your sovereign data fabric.* |
| Fallback brand (LD-1) | **TapestryOne** |
| Internal nickname | FiaB (file/dir/code only; never customer-facing) |
| Parent brand | CSA-in-a-Box |
| Domain (current) | `https://fgarofalo56.github.io/csa-inabox/` (pillar lives at `/fiab/`) |
| Proposed customer URL | `csa-loom.com` (or `loom.csa-inabox.io` subdomain) |
| Categories (Nice classification) | Class 9 (computer software), Class 42 (SaaS / PaaS) |

## Why "CSA Loom"

- Builds on the existing **CSA**-in-a-Box brand equity
- "Loom" evokes weaving — the act of combining many threads (data
  sources) into a coherent fabric. Direct metaphorical answer to
  Microsoft's "Fabric"
- Short, pronounceable, ownable
- Single-word product noun pairs cleanly with role-based modifiers
  (Loom Console, Loom Setup Wizard, Loom Data Agents, Loom Activator
  Engine, Loom Mirroring Engine, Loom Direct-Lake Shim)

## Clearance checklist for counsel

- [ ] **USPTO TESS search** — "CSA LOOM" exact match (Class 9, 42)
- [ ] **USPTO TESS search** — "LOOM" + data/cloud/analytics keywords
- [ ] **WIPO Global Brand Database** — international coverage
- [ ] **EUIPO TMview** — EU coverage if expanding
- [ ] **Common-law trademark search** — Google + LinkedIn + GitHub
      "CSA Loom" / "csa-loom" / "csa loom"
- [ ] **Domain availability** — csa-loom.com / .io / .ai / .cloud
- [ ] **GitHub org availability** — `csa-loom` org name
- [ ] **Social handle availability** — @csaloom (X, LinkedIn, YouTube)
- [ ] **Microsoft Partner compliance** — "Built on Azure" / "Microsoft
      Cloud for Sovereignty" co-branding rules (don't use Microsoft
      trade names in product naming; "CSA Loom" alone is clean)
- [ ] **Microsoft brand-confusion risk** — no Microsoft product called
      "Loom" today; Loom.com is the asynchronous-video tool (owned by
      Atlassian as of 2024 acquisition) — different category, likely
      no class collision but counsel should confirm

## Known prior art

| Mark | Owner | Category | Collision risk |
|---|---|---|---|
| **Loom** (loom.com) | Atlassian (acq. 2023) | Asynchronous video / SaaS communication | LOW — different Nice class (typically 9/42 but different practical category) |
| **Loom** (variousweaving brands) | Multiple | Textiles / craft goods | NONE — class 23/24/26 |
| **Loom Systems** | acq. by ServiceNow 2019 | IT operations (AIOps) | MEDIUM — adjacent SaaS/IT category. Counsel should confirm whether legacy mark is active |
| **CSA** | Cloud Security Alliance | Industry consortium | NONE — non-commercial industry body; "CSA" here refers to our internal product line |

**Most important risk:** "Loom Systems" — even though acquired and
likely retired as a standalone mark, counsel should check whether
ServiceNow maintains the registration. The **CSA Loom** compound mark
likely clears even if "Loom" alone is taken in adjacent categories.

## Fallback chain (if CSA Loom is blocked)

1. **TapestryOne** (locked fallback per LD-1) — same weaving metaphor,
   one-word noun, clearly ownable
2. **CSA Tapestry** — compound following same pattern as CSA Loom
3. **CSA Warp** — weaving term; shorter
4. **CSA Weave** — generic but available

If clearance blocks **CSA Loom AND TapestryOne**, escalate to product
naming workshop with brand + counsel + product leads before fallback
selection.

## Brand split rules (LD-1) — for marketing + comms

| Surface | Use |
|---|---|
| Customer-facing copy, product UI, marketing, sales decks | **CSA Loom** (or component noun: *Loom Console*, *Loom Data Agents*, etc.) |
| Repo file paths, directory names, Bicep variables, code comments, GitHub Issue labels | `fiab` (repo-internal nickname; predates the brand name) |
| Tagline | *The loom that weaves your sovereign data fabric.* |
| Boilerplate | *CSA Loom is a productized Microsoft Fabric parity layer for Azure tenants where Fabric isn't yet available — federal civilian, DoD, IC, state+local, defense industrial base.* |

## Visual brand

- **Palette**: navy (#0F2A4A), indigo (#3D2E80), amber (#D89F3D),
  paper (#FAF8F2)
- **Hero motif**: woven-loom warp + weft over Azure boundary chips
  (Commercial / GCC / GCC-High / IL5)
- **Hero image source**: `docs/assets/images/hero/fiab/index.svg`
  (1600x380, SVG, scalable)
- **Logo**: TBD (request brand-design ticket once name clears legal)

## Approval timeline

1. **Submit to counsel** — week of 2026-05-26
2. **Counsel response** — expect 2-3 weeks (clearance + risk memo)
3. **Brand-name decision lock** — by 2026-06-19
4. **Logo + visual system commission** — week of 2026-06-22 (parallel
   with Wave 1 engineering)
5. **Public announcement readiness** — aligned with v1 launch
   (Microsoft Build 2026 freshness rescan + Wave 2 deploy validation
   complete = earliest Q4 2026)

## Tracking

- ADR: [`fiab-0001 Fabric feature scope`](../adr/0001-fabric-feature-scope.md)
  documents v1 scope; brand decision is LD-1 in
  [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/temp/fiab-prd/AMENDMENTS.md)
- Epic: [#279 CSA Loom v1 build roadmap](https://github.com/fgarofalo56/csa-inabox/issues/279)
- PR: [#282 pillar v0.1 ship](https://github.com/fgarofalo56/csa-inabox/pull/282)

## Related

- [Loom Console pane reference](../console/index.md)
- [What is CSA Loom?](../what-is-csa-loom.md)
- [CSA Loom whitepaper](../whitepaper.md)
