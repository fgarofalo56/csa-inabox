# Changelog

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/). See
[RELEASE.md](RELEASE.md) for the release process.

## [0.51.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.50.0...csa-inabox-v0.51.0) (2026-07-03)


### Features

* **loom,authz:** tid-partitioned multi-user ACL — second user can open shared workspaces (rel-T11/B4) ([#1601](https://github.com/fgarofalo56/csa-inabox/issues/1601)) ([a85fdd3](https://github.com/fgarofalo56/csa-inabox/commit/a85fdd3ed800b804a49fbcae108d1cd2afbd4c8f))
* **loom,ci:** gate prod roll on vitest + in-VNet UAT, PR-gate CodeQL, wire guard:circular (rel-T22/T27/T29, B13) ([#1618](https://github.com/fgarofalo56/csa-inabox/issues/1618)) ([0ccdd52](https://github.com/fgarofalo56/csa-inabox/commit/0ccdd52f7400e1f818d8b3aa79b2c2f15d8517b9))
* **loom,security:** default-on durable rate limiting + authenticated feedback (rel-T15/T16, B16) ([#1600](https://github.com/fgarofalo56/csa-inabox/issues/1600)) ([802c26d](https://github.com/fgarofalo56/csa-inabox/commit/802c26d7485cfa1b83fc90504395e6c71342d4ae))


### Bug Fixes

* **loom,auth:** OAuth state + PKCE + nonce on the MSAL BFF flow (rel-T12) ([#1597](https://github.com/fgarofalo56/csa-inabox/issues/1597)) ([d1738e4](https://github.com/fgarofalo56/csa-inabox/commit/d1738e4de66e7b9122aa6c2ca4be36464e7a80f4))
* **loom,authz:** ACL-resolve workspace detail + items routes (rel-T11 live-caught) ([#1620](https://github.com/fgarofalo56/csa-inabox/issues/1620)) ([6bef2e2](https://github.com/fgarofalo56/csa-inabox/commit/6bef2e210650e293dccf7323ff483cb6a4a44151))
* **loom,ci:** allowlist session-optional feedback route in route-guard sweep ([#1605](https://github.com/fgarofalo56/csa-inabox/issues/1605)) ([278fc6f](https://github.com/fgarofalo56/csa-inabox/commit/278fc6f0515267fceb95e74906c19b050e724572))
* **loom,security:** ACL-gate data-product preview + per-user notebook contents (rel-T18/T19) ([#1604](https://github.com/fgarofalo56/csa-inabox/issues/1604)) ([d92f930](https://github.com/fgarofalo56/csa-inabox/commit/d92f930b840ac2a2bf8c6bc3c093164d85780265))
* **loom,security:** per-service internal tokens + Front Door block for /api/internal/* (rel-T10/B3) ([#1598](https://github.com/fgarofalo56/csa-inabox/issues/1598)) ([c31267e](https://github.com/fgarofalo56/csa-inabox/commit/c31267eca201e3aaf1db5cd1e7b53e25d3a1be22))
* **loom,security:** route-guard sweep across all api groups + consistent admin gate + PDP shadow-on (rel-T17/T20) ([#1602](https://github.com/fgarofalo56/csa-inabox/issues/1602)) ([0e8f4a3](https://github.com/fgarofalo56/csa-inabox/commit/0e8f4a370e5efb45135c28d619c52cfb9c4394ec))
* **loom,security:** SSRF guard on MCP test-connection + fail-closed admin tier (rel-T13/T14) ([#1599](https://github.com/fgarofalo56/csa-inabox/issues/1599)) ([ea2d29b](https://github.com/fgarofalo56/csa-inabox/commit/ea2d29bd673e2f43a6aa996399a531a6860fac1e))


### Documentation

* **session:** Wave-0 landing + live-verification session state (2026-07-03) ([#1595](https://github.com/fgarofalo56/csa-inabox/issues/1595)) ([23454a0](https://github.com/fgarofalo56/csa-inabox/commit/23454a036eaf44faf5726cbe12064b23d87d2575))


### Tests

* **loom,ci:** green vitest suite + vitest/lint CI gates + validate exits non-zero (rel-T21/T24/T25/T26, B13) ([#1603](https://github.com/fgarofalo56/csa-inabox/issues/1603)) ([528f31b](https://github.com/fgarofalo56/csa-inabox/commit/528f31b5e6eadecd1f58f8d05f016ff216038b2f))
* **loom,e2e:** coverage floor + 10-journey UAT slice + parameterized target (rel-T28/T30) ([#1619](https://github.com/fgarofalo56/csa-inabox/issues/1619)) ([b601f66](https://github.com/fgarofalo56/csa-inabox/commit/b601f660af36ba6ced73a49c63d052a8612636f2))
* **loom:** green vitest against merged Wave-1 security behavior (rate-limit off in harness, tenantScopeId mocks, guard-order assertions) ([#1606](https://github.com/fgarofalo56/csa-inabox/issues/1606)) ([ef22ba1](https://github.com/fgarofalo56/csa-inabox/commit/ef22ba1e1279ed456db14e4ce1d82c4de1e31de2))

## [0.50.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.49.0...csa-inabox-v0.50.0) (2026-07-03)


### Features

* **ci:** scale-to-zero GitHub Actions self-hosted runner on Azure Container Apps (in-VNet) ([3fcf213](https://github.com/fgarofalo56/csa-inabox/commit/3fcf213eeb222110fbada44aaf9cf169bc6dd85a))
* **fiab-admin:** surface Delta Sharing readiness in System Health (inbound providers + publishing) ([8d935d8](https://github.com/fgarofalo56/csa-inabox/commit/8d935d849c95b55abeaaacbc88124208b07e6553))
* **fiab-bicep:** bicep-sync the rev-94 messaging items (Service Bus + Event Grid modules + env wiring + parity docs) ([8b6cca9](https://github.com/fgarofalo56/csa-inabox/commit/8b6cca9a4f7b45361fefe0488bc671863b4961a5))
* **fiab-catalog:** Wave A — pipeline consolidation + ARM Create-new binder + Geo template ([76a3923](https://github.com/fgarofalo56/csa-inabox/commit/76a39235dd380dcf51c8b5ac5ece42b6e6bf5647))
* **fiab-catalog:** Wave B — dedup consolidation (hide merged slugs from gallery, back-compat) ([ef7cade](https://github.com/fgarofalo56/csa-inabox/commit/ef7cade8120ec939a5284689a0923a29dd34df04))
* **fiab-catalog:** Wave C — unified create-step + search-only pipeline shortcuts ([8a9663c](https://github.com/fgarofalo56/csa-inabox/commit/8a9663caf9ede5cf06519a338078ae2909dafe8b))
* **fiab-catalog:** Wave D — notebook + SQL families adopt the create-step pattern ([85880d7](https://github.com/fgarofalo56/csa-inabox/commit/85880d757b3e2fc527760d61cc56caa6f9694b9d))
* **fiab-console/uat:** add UAT_GREP_INVERT to exclude specs (e.g. 'tutorial:' screenshot suite) from functional runs ([#1564](https://github.com/fgarofalo56/csa-inabox/issues/1564)) ([09457c6](https://github.com/fgarofalo56/csa-inabox/commit/09457c62a570515e78d0569d697ce79511da7b81))
* **fiab-console:** collapsible compact ribbon (all editors) + notebook toolbar spacing ([899826d](https://github.com/fgarofalo56/csa-inabox/commit/899826dc4c8527ed8a4f9b4f9d2fd9add19d5396))
* **fiab-console:** data product 'Try it' — live ADX sample preview in the Marketplace ([281ba6e](https://github.com/fgarofalo56/csa-inabox/commit/281ba6e39972158c214b47c109ae54cdb9c6719e))
* **fiab-console:** data product 'Try it' on the OWNER view too (was consumer-only) ([0041be8](https://github.com/fgarofalo56/csa-inabox/commit/0041be81fa63c8fbddbf2347dc3082aca5eaebf3))
* **fiab-console:** Databricks UC mirror discoverability card + Dataverse works day-one ([8614eb2](https://github.com/fgarofalo56/csa-inabox/commit/8614eb2e410fac47915c808310ec1998c91a5aa7))
* **fiab-console:** Power Automate / Logic Apps visual flow designer (no JSON by default) ([095c211](https://github.com/fgarofalo56/csa-inabox/commit/095c2110340f35d0827ab51b2738ae2288fce58b))
* **fiab-console:** real Azure Monitor utilization on admin Scaling page (batch 5) ([7f9c503](https://github.com/fgarofalo56/csa-inabox/commit/7f9c5034916cb52ecff905b269014a7fe403310d))
* **fiab-console:** real dashboard/report charts + AI Search skillset builder + ontology key-value (batch 4) ([2015f53](https://github.com/fgarofalo56/csa-inabox/commit/2015f53527143768a43df6f9394ec51173cc1d0b))
* **fiab-console:** Spark config presets + notebook config builder + Synapse-&gt;Loom-LA logging; green-box fix ([9db33ed](https://github.com/fgarofalo56/csa-inabox/commit/9db33ed0501e26e8b975c970993590c7c554deaf))
* **fiab-console:** unified Loom Marketplace — merge API + Data marketplaces + Delta Sharing ([09621c5](https://github.com/fgarofalo56/csa-inabox/commit/09621c590a345aa0e63dd18bec0b68bdb75079bb))
* **fiab-console:** Web 3.0 UI sweep — overflow / dead-space / resize / responsive fixes across 61 editors + notebook ([71c7c30](https://github.com/fgarofalo56/csa-inabox/commit/71c7c309d4f301ca48d13d20574d19368ed24ffe))
* **fiab-console:** Web 3.0 UI sweep (pages, wave 1) — overflow / dead-space / responsive fixes ([74abe06](https://github.com/fgarofalo56/csa-inabox/commit/74abe06a29d1735ff439abf2120ba52e4b25d4f7))
* **fiab-console:** Web 3.0 UI sweep (pages, wave 2) — 38 page surfaces ([4e20983](https://github.com/fgarofalo56/csa-inabox/commit/4e2098344d02bb621346f5a764c833065cb5776a))
* **fiab-databricks:** provision a default SQL warehouse day-one (query compute) + wire LOOM_DATABRICKS_SQL_WAREHOUSE_ID ([235b3fe](https://github.com/fgarofalo56/csa-inabox/commit/235b3febe19a14f730a52abed192c8c13280a2cc))
* **fiab-delta-sharing:** grant workflow also provisions the default SQL warehouse + wires the env (one-shot live enabler) ([4afc987](https://github.com/fgarofalo56/csa-inabox/commit/4afc9872b869683d17e0fcfd3bdaf699b98443c3))
* **fiab-marketplace:** in-Loom Explore & Query for subscribed Delta shares ([d026936](https://github.com/fgarofalo56/csa-inabox/commit/d026936fc3976cab946678e997afc2f99e6b62ff))
* **fiab-monitor:** Monitor → Spark — application analytics + tuning recs + troubleshooting + native diag links ([6d74411](https://github.com/fgarofalo56/csa-inabox/commit/6d7441141ce6755b14b852e0a8a65deedd5e58d7))
* **fiab-notebook:** Databricks cluster preset builder — best-practice shapes + structured spark_conf + Photon/Spot/autoscale + log delivery ([5bb6db3](https://github.com/fgarofalo56/csa-inabox/commit/5bb6db3b8b30d32ddb94c87de9c87d20cf771250))
* **fiab-pipeline:** ADF/Synapse parity Wave 1 — connector catalog + linked-service gallery + dataset wizard + IR manager ([a492e71](https://github.com/fgarofalo56/csa-inabox/commit/a492e71ec1bb66749ecf2f53175a768daf745193))
* **fiab-pipeline:** ADF/Synapse parity Wave 2 — copy activity Source/Sink/Mapping/Settings to full parity ([c1b4b96](https://github.com/fgarofalo56/csa-inabox/commit/c1b4b96c4bc4a8a91111e0de5e783c29220dd4f6))
* **fiab-pipeline:** ADF/Synapse parity Wave 3 — dynamic content / expression builder ([a006490](https://github.com/fgarofalo56/csa-inabox/commit/a006490a49326feb99fe91aca23c9d7fd670099e))
* **fiab-pipeline:** ADF/Synapse parity Wave 4 — complete control-flow + external activity catalog ([0eca8bd](https://github.com/fgarofalo56/csa-inabox/commit/0eca8bd7d4009e8098014c6a6d4ec4078866d1f0))
* **fiab-pipeline:** ADF/Synapse parity Wave 5 — Mapping Data Flow designer (Spark visual transforms) ([82737c6](https://github.com/fgarofalo56/csa-inabox/commit/82737c69d6223a1c50ce55f6b7f9f876d61e9286))
* **fiab-pipeline:** ADF/Synapse parity Wave 6 — parameters/variables, all trigger types, debug + monitor ([7f82029](https://github.com/fgarofalo56/csa-inabox/commit/7f82029acae9adc72292a31519ddc1d80a597de5))
* **fiab-ui:** collapsible side Copilot + drag-resizable canvases + fully-backed app templates + Copilot Studio picker + ADF managed-VNet bicep ([408f7a8](https://github.com/fgarofalo56/csa-inabox/commit/408f7a83584c2bb9ea4642c0022e9948afb9656b))
* **fiab-ui:** Web-5.0 Wave 1 — canvas nodes as rich shapes + per-activity/transform icons ([b996ac2](https://github.com/fgarofalo56/csa-inabox/commit/b996ac2f7b4676db2472732451f3de807fbd8566))
* **fiab-ui:** Web-5.0 Wave 4 — pipeline/data-flow studio chrome cohesive with rich nodes ([59b8b88](https://github.com/fgarofalo56/csa-inabox/commit/59b8b88d7cf51ace867b1d018eb104653ace6907))
* **fiab-ui:** Web-5.0 Wave 5 — 23 data-plane editors polish pass ([65bf015](https://github.com/fgarofalo56/csa-inabox/commit/65bf015363919e7b2d6c2f63b8e02614f80b4f9a))
* **fiab-ui:** Web-5.0 Wave 6 — AI/ML, copilot, data-agent, APIM/DAB, data-product, Palantir editors polish ([86bdc05](https://github.com/fgarofalo56/csa-inabox/commit/86bdc0559bb574471bb84bb03abad50078c61beb))
* **fiab-ui:** Web-5.0 Waves 2+3 — all flow & topology canvases adopt the shared kit ([0aac59f](https://github.com/fgarofalo56/csa-inabox/commit/0aac59f21d7ae5c00be5191d27cb27825039e704))
* **fiab-ui:** Web-5.0 Waves 7+8 — top-level pages + admin/dialogs polish (program complete) ([a34ee90](https://github.com/fgarofalo56/csa-inabox/commit/a34ee904715508c51935787f7e46a865547a3a72))
* **fiab/day-one:** Internal-APIM gateway private DNS (bicep) + Delta Sharing UAMI grant (bootstrap) ([e5b0066](https://github.com/fgarofalo56/csa-inabox/commit/e5b0066b2ee68d042c51dbed8e80fd9086b28982))
* **fiab/vpn:** auto-DNS for the whole private estate over VPN — DLZ PE DNS-zone-groups ([353a912](https://github.com/fgarofalo56/csa-inabox/commit/353a91281a5e468aa82cc8ef2626cf17a87e528b))
* **fiab/vpn:** Azure DNS Private Resolver so P2S clients resolve the private estate automatically ([6a4f8c7](https://github.com/fgarofalo56/csa-inabox/commit/6a4f8c7673861ca4fd209cc87b5b22a6b97d0ea7))
* **fiab:** activate Azure Data Explorer (Kusto) as a real report data source ([3f23230](https://github.com/fgarofalo56/csa-inabox/commit/3f23230acf9c03e502fd06fc51458fa15183b078))
* **fiab:** add Event Hubs/Service Bus/Event Grid namespaces + lakehouse-shortcut items; finish Copilot Studio action param-mapping + honest gates ([e1f2aab](https://github.com/fgarofalo56/csa-inabox/commit/e1f2aab22445be014dcb194f62bf9d4d8615dd63))
* **fiab:** auto-provision Purview governance domain (remove day-one hard gate) ([bff7216](https://github.com/fgarofalo56/csa-inabox/commit/bff72163a5fbd2f017b5d960baaf556c960b737b))
* **fiab:** Data Factory wave 1 — InfoLabel hover-help cascade + dbt-job freeform→guided ([2a79682](https://github.com/fgarofalo56/csa-inabox/commit/2a796826c33f34feddcb5d3bbeee709b62d2cb10))
* **fiab:** Data Factory wave 2 — per-editor Copilot button (all editors) + mirrored-databricks catalog picker ([46ea76e](https://github.com/fgarofalo56/csa-inabox/commit/46ea76e2f00a70ad93e6b49c4fb2c66ab16cc434))
* **fiab:** Data Factory wave 3 — disabled-reason hover tooltips on copy-job Run + airflow Trigger/Pause ([6cd5b81](https://github.com/fgarofalo56/csa-inabox/commit/6cd5b81d2e41d23aa950127f8dadf0d63059e17d))
* **fiab:** Data Factory wave 4 — logic-app trigger selector for multi-trigger workflows ([99fda97](https://github.com/fgarofalo56/csa-inabox/commit/99fda97d655f4ce6a1b73b414e7f6c93a698f26c))
* **fiab:** data-factory P2 feature gaps — IR Azure-SSIS config+auth-keys, adf-dataset guided forms+import, dataflow schedule/validate, copy-job CDC, pipeline publish/approval (masked SSIS pwd) ([ff2775d](https://github.com/fgarofalo56/csa-inabox/commit/ff2775d48d660ba4130df1aecbbe699905ce785a))
* **fiab:** data-product web5 empty/error states with marketplace + create CTAs ([6e724f0](https://github.com/fgarofalo56/csa-inabox/commit/6e724f0306cf41f0b18adf4bece7e654171381af))
* **fiab:** data-product-template deep-dive — nav-on-spawn, customizable components, deploy-now provision, instructions ([e6aaafc](https://github.com/fgarofalo56/csa-inabox/commit/e6aaafc7af1bf9b6b8ce4689c41bd16f3e4455e2))
* **fiab:** databricks-cluster feature group + 3 follow-ups (foundry identity echo, mlflow lineage, ml-experiment archived-run restore) ([e6d6fd2](https://github.com/fgarofalo56/csa-inabox/commit/e6d6fd2fdf0684577d3a23298a3f1dc0201e0671))
* **fiab:** EH Phase-1 — OBO data-plane scaffold (LOOM_OBO_DATA_PLANE off|shadow|on, default off) ([d9c81ef](https://github.com/fgarofalo56/csa-inabox/commit/d9c81efd2e9829e5a4004a3dfe91294581e4eeaa))
* **fiab:** EH Phase-1 — PDP shadow-report admin route (vet before enforce) ([99cb0fd](https://github.com/fgarofalo56/csa-inabox/commit/99cb0fd3366e2b82807e59d9ed60fc5b28a3df3f))
* **fiab:** EH Phase-1 §2.2 — OneLake RLS/CLS reconciler (real Synapse SECURITY POLICY + ADX RLS) ([3f3cb1f](https://github.com/fgarofalo56/csa-inabox/commit/3f3cb1f0e8b73a26dfb8509c59469316ee4da1cb))
* **fiab:** EH Phase-1 §2.2 foundation — OneLake role RLS/CLS validators (pure) ([0006ecd](https://github.com/fgarofalo56/csa-inabox/commit/0006ecd988dcf9150907b3f75928f87ac57bd583))
* **fiab:** EH Phase-1 §2.3 — protection-policy reconciler (sovereign-rbac) makes PDP layer-7 real ([ceb029c](https://github.com/fgarofalo56/csa-inabox/commit/ceb029c8180ab3f40094511153265031f7d43dfb))
* **fiab:** EH Phase-1 §2.3 — reconciler revokes non-allowed principals on Synapse SQL + ADX (edge middleware dropped, OTel-incompatible) ([7b0e8c3](https://github.com/fgarofalo56/csa-inabox/commit/7b0e8c37548b86f0b6b98ba64ac3f1b3afe35eda))
* **fiab:** EH Phase-1 §2.3 UI — protection-policy management in Governance (completes §2.3 e2e) ([209c058](https://github.com/fgarofalo56/csa-inabox/commit/209c058c941ac63bc8497b37147ec0892e687c7f))
* **fiab:** EH Phase-1 §2.4 — per-workspace identity + trusted-workspace-access (dormant) ([7ef01fc](https://github.com/fgarofalo56/csa-inabox/commit/7ef01fc0d1653e680003857947e7abd36215b450))
* **fiab:** EH Phase-1 P0 — multi-domain ACL Policy Decision Point (PDP) spine ([02d5070](https://github.com/fgarofalo56/csa-inabox/commit/02d507062fa6cfbe3aeaa33e6c86bb1bb108ef06))
* **fiab:** EH Phase-1 P0 — PDP shadow/enforce gate (default-off) wired into 3 routes ([1e88816](https://github.com/fgarofalo56/csa-inabox/commit/1e888163a335d1622f47b3d8ea571a7f01922647))
* **fiab:** EH Phase-2 — wire rate-limiter (AOAI copilots) + query-cache (heavy reads), default-off ([d6d9976](https://github.com/fgarofalo56/csa-inabox/commit/d6d9976993582eddbc8e608e40c0a252ffb57318))
* **fiab:** EH Phase-2 scale primitives — per-principal rate limiter + query cache/governor (default-off) ([c2cc036](https://github.com/fgarofalo56/csa-inabox/commit/c2cc036ec4274aee69dcc6b3b1716ac70df74bb0))
* **fiab:** free-form Power BI-Desktop report canvas + dark-legible visual gallery + AI max_completion_tokens fix ([b5c0728](https://github.com/fgarofalo56/csa-inabox/commit/b5c072878015c7db2de5700a79d23224dadf6100))
* **fiab:** Graph+Vector wave 1 — vector-store guided dimensions + hover-info + gremlin tooltips ([c051c87](https://github.com/fgarofalo56/csa-inabox/commit/c051c8708cc415bdf6f553656dc9f2ec1297dfcb))
* **fiab:** hover-info tooltip pass across Power BI + Graph+Vector + AI&Agents editors ([47ed926](https://github.com/fgarofalo56/csa-inabox/commit/47ed926c561fb9e5fc849e17809c3b253ffa141d))
* **fiab:** notebook editor — Monaco code cells + inline output + tab strip (no-fabric wording) ([ca54dab](https://github.com/fgarofalo56/csa-inabox/commit/ca54dabbde304f5447e1431bc77a75280d8b7995))
* **fiab:** one-click "Open in Power BI Desktop" (.pbids) for Loom Azure data sources ([c0e6e63](https://github.com/fgarofalo56/csa-inabox/commit/c0e6e63eaa2fe5363456941c92364258cd897d85))
* **fiab:** point-to-site VPN access — admin Network & DNS download/instructions + day-one gateway ([1519292](https://github.com/fgarofalo56/csa-inabox/commit/15192927ae7fcf5157277886d2ce4108ebd2cb3f))
* **fiab:** Power BI agentic Copilot integration + pipeline E2E bug fixes ([7504329](https://github.com/fgarofalo56/csa-inabox/commit/7504329c751b065762b1384a4e7a63c670f9009c))
* **fiab:** Power BI Copilot in the report designer (uses the Power BI skills + remote MCP) ([bd7e2ea](https://github.com/fgarofalo56/csa-inabox/commit/bd7e2eab5d4579e1fc22c3c3626515974cc6e3ea))
* **fiab:** real Loom-native interactive report designer (Azure-native, no Power BI) ([eb9df12](https://github.com/fgarofalo56/csa-inabox/commit/eb9df122570cced86352cf12f2878bc2056184b5))
* **fiab:** report designer — Power BI parity wave 1 (visuals, deep Format pane, Analytics pane, interactions, page options, richer filters) ([5fb6617](https://github.com/fgarofalo56/csa-inabox/commit/5fb66173a5fd8585e29832eb7da63564874359c2))
* **fiab:** report designer — Power BI parity wave 2 (bookmarks, selection, drillthrough, canvas authoring, analytics+, filters+) ([f69dcbb](https://github.com/fgarofalo56/csa-inabox/commit/f69dcbbf738f324b20115f3c5509fb97c9db8bc0))
* **fiab:** report designer — Power BI parity wave 3 (themes, export, personalize, AI visuals) + bookmark/theme reload fix ([c928510](https://github.com/fgarofalo56/csa-inabox/commit/c9285109328907ba310cf5f8dad8ed44df6a161f))
* **fiab:** report designer v2 — Weave/query/notebook data sourcing + publish + format/filters/layout ([3c24128](https://github.com/fgarofalo56/csa-inabox/commit/3c2412841cec13fd9e8c08480e7c6220d1d03bc5))
* **fiab:** report W6 (format pane) + W7 (canvas elements) + Enterprise-Hardening PRP ([6026794](https://github.com/fgarofalo56/csa-inabox/commit/6026794304de63336327aeda75858e9aeb3d2b5c))
* **fiab:** report Wave 2 — storage/connectivity modes + Navigator + Azure-native refresh ([150b769](https://github.com/fgarofalo56/csa-inabox/commit/150b769cbb72fa15800188366cdba7a0049817ad))
* **fiab:** report Wave 3 — Azure-native RLS/OLS + What-if + Quick measures + Synonyms + modeling ([5df821e](https://github.com/fgarofalo56/csa-inabox/commit/5df821edc107e002810208c47be7ad6fae1db95f))
* **fiab:** report Wave 4 — Power Query "Transform Data" (reuse Dataflow Gen2 PQ host) ([e4f5cfc](https://github.com/fgarofalo56/csa-inabox/commit/e4f5cfc243f6599c639e2b03472d6e2f853b2de1))
* **fiab:** report Wave 5 — TRUE chart geometry + slicer + Azure Maps + analytics ([a27bc23](https://github.com/fgarofalo56/csa-inabox/commit/a27bc23b539d7d940aa0d65e562d61b78767c62a))
* **fiab:** report Wave 8 — interactivity (drill, sync-slicers, what-if, tooltip-render, relative-time) ([1043652](https://github.com/fgarofalo56/csa-inabox/commit/1043652dc23ccfeb1a265d953d5813b1832251b8))
* **fiab:** report Wave 9 — export-data + MIP labels + deploy-pipeline + endorsement + perf + settings ([1944ddf](https://github.com/fgarofalo56/csa-inabox/commit/1944ddf11639d553a9ecd24083b5936e5d58a308))
* **fiab:** rev-92 batch — MS MCP/skills + pipeline-UX + half-baked fixes + backbone items ([ee5d974](https://github.com/fgarofalo56/csa-inabox/commit/ee5d974eacc7ac3fdd77bef5c64955190cce0261))
* **fiab:** round-2 P0 core data-eng — lakehouse Tables+grid+ribbon, dataset asset surface, notebook history GUID fix ([942aa94](https://github.com/fgarofalo56/csa-inabox/commit/942aa944c1b0721c604a99ce48102827acfb6225))
* **fiab:** round-2 P1/P2 — ml-model deploy ops, ml-experiment run lifecycle, dataset lineage, px-token cleanup ([9404d0d](https://github.com/fgarofalo56/csa-inabox/commit/9404d0d18f51f91d59a35ccfc1a7ec2bc8a6de91))
* **fiab:** vector-store algorithm picker (HNSW vs exhaustive kNN) ([d75013f](https://github.com/fgarofalo56/csa-inabox/commit/d75013f9def45fa13d33248dedde971263076e50))
* **fiab:** wire SQL Warehouse Connection dialog (JDBC/ODBC/CLI) — route existed, UI never opened it ([68956f8](https://github.com/fgarofalo56/csa-inabox/commit/68956f8323eb4a04adaa8b8336545da75fa92682))
* **loom,alm:** Git branch-out to new workspace + deployment-pipeline per-item rules ([0281077](https://github.com/fgarofalo56/csa-inabox/commit/0281077a3afdb61824f9f5ebf465c5b91c57c667))
* **loom,bicep:** UDF runtime host module (mirrors dab-runtime) so UDF invoke works day-one ([f2ad8bd](https://github.com/fgarofalo56/csa-inabox/commit/f2ad8bd67b86d0f636d4c82b831b4c9eb8283fb7))
* **loom,bicep:** wire report-accel + spark-pool + udf-runtime + cost-management modules into main.bicep (out-of-the-box deploy) ([59aa78d](https://github.com/fgarofalo56/csa-inabox/commit/59aa78dcdd68555d8ecdcb98c5a2e7f8a35698fd))
* **loom,data-factory:** expand connector catalog toward Fabric breadth (real ADF linkedService types) ([a3939c0](https://github.com/fgarofalo56/csa-inabox/commit/a3939c088e8c8fe71e3799280a97b8f54ef48019))
* **loom,deploy:** build report-accel image in pipeline + activate (reportAccelImageReady=true) ([d2f73a7](https://github.com/fgarofalo56/csa-inabox/commit/d2f73a703c106a0ad24eb80b5babff732771e027))
* **loom,fabric-iq:** aip-logic real typed block graph (typed outputs + tool blocks) ([c33dc9e](https://github.com/fgarofalo56/csa-inabox/commit/c33dc9ef02c829e3c723cb23a568a70ee67dfe7f))
* **loom,fabric-iq:** data-agent AI-Search/Graph source depth + plan versions/snapshots ([c366a5b](https://github.com/fgarofalo56/csa-inabox/commit/c366a5b328448674b4788abb0d0e884fea7f67c2))
* **loom,fabric-iq:** data-agent schema-tree picker + health-check Notifications tab (Azure Monitor action groups) ([b78f442](https://github.com/fgarofalo56/csa-inabox/commit/b78f442665e124421d5e573dd0169180d8a64866))
* **loom,fabric-iq:** graph-model interactive schema canvas + map drawing/measure/geocode ([12e8bfe](https://github.com/fgarofalo56/csa-inabox/commit/12e8bfebcf416b6d267599e833734a91686ea71b))
* **loom,fabric-iq:** ontology link-instance UI + typed run-action form + interfaces/shared-properties ([d08694c](https://github.com/fgarofalo56/csa-inabox/commit/d08694cf51cda7aa79b4507e2133a78d89506651))
* **loom,fabric-iq:** ontology typed instance form (kill JSON textarea) + datasource column-mapping UI ([d813909](https://github.com/fgarofalo56/csa-inabox/commit/d81390921f234e31835238236728134720681411))
* **loom,fabric-iq:** operations-agent run/test loop + triggers + proposals ([6d66bc6](https://github.com/fgarofalo56/csa-inabox/commit/6d66bc6a1136aa7bc219095643923fbaa3ed97c0))
* **loom,fabric-iq:** plan spreading/breakback/driver rows + Plan Copilot (AOAI) ([bcddb26](https://github.com/fgarofalo56/csa-inabox/commit/bcddb263696b29bd35cc2461c08350f77077fe3d))
* **loom,fabric-iq:** slate variables/events + SWA publish + ontology-sdk try-it + health-check check-type library ([f2bf117](https://github.com/fgarofalo56/csa-inabox/commit/f2bf117a60e59c7e87a365a3be05c55d0d163ba6))
* **loom,fabric-iq:** workshop real Publish (SWA) + graph-model no-code query builder ([6af1715](https://github.com/fgarofalo56/csa-inabox/commit/6af171587afee9e898129c1ac5014635240265d9))
* **loom,governance:** self-service managed private endpoint create + approval (Phase 4 G5) ([e557e56](https://github.com/fgarofalo56/csa-inabox/commit/e557e565f5d2ae16618149ecd4ab57e73458012a))
* **loom,governance:** Share-on-every-editor + OneLake preview-as + generic endorsement (Phase 4) ([5cdb290](https://github.com/fgarofalo56/csa-inabox/commit/5cdb2907f6ee46cd5e1eda8540ae52999f53038f))
* **loom,governance:** trusted workspace access — storage resource-instance rules (Phase 4 G6) ([8fb95cb](https://github.com/fgarofalo56/csa-inabox/commit/8fb95cbb132835ee46217e73f760d705f50c67eb))
* **loom,ops:** scripted purge of test/tutorial workspace debris + UAT cleanup (rel-T09c) ([#1591](https://github.com/fgarofalo56/csa-inabox/issues/1591)) ([972696b](https://github.com/fgarofalo56/csa-inabox/commit/972696b585ee6074c39dd9ef5cec2396c8f639fe))
* **loom,perf:** report query acceleration — result cache + DuckDB-over-Delta fast path (Direct-Lake-ish) + bicep ([1cad0f8](https://github.com/fgarofalo56/csa-inabox/commit/1cad0f8e526592746fff11aaafaf40084af05461))
* **loom,perf:** warm Spark session pool (kill notebook cold starts) + bicep ([64bceb2](https://github.com/fgarofalo56/csa-inabox/commit/64bceb2c7ad90716fcfd989071b47f657d06bccd))
* **loom,report:** AI visuals (decomposition tree, key influencers, smart narrative) + matrix/gauge/KPI/waterfall/funnel/scatter ([c7856b9](https://github.com/fgarofalo56/csa-inabox/commit/c7856b9e56673fed9d3c1ea88f19bce152bfb9ba))
* **loom,rti:** ADX-native Activator runtime — fire rules on Eventhouse/KQL data (keystone) ([b62cf1e](https://github.com/fgarofalo56/csa-inabox/commit/b62cf1e9c6df54534d79c7b1a0443f9f7372cb3c))
* **loom,rti:** alerts-from-tile via ADX Activator runtime + RTI-Hub ADX-sink preview fallback ([2e2b810](https://github.com/fgarofalo56/csa-inabox/commit/2e2b81084894cf877029c2731500070240b6f0c3))
* **loom,rti:** eventstream canvas operators (Manage-fields/Union/Expand/Join) + pause-resume + Spark sink; demote JSON to read-only ([1613099](https://github.com/fgarofalo56/csa-inabox/commit/16130997df90afc12b8cb61eca30c6608dc1c045))
* **loom,rti:** KQL anomaly detection + forecasting on tables + dashboard tiles ([857d858](https://github.com/fgarofalo56/csa-inabox/commit/857d858b377e35adb418cba75c859ee1885ae270))
* **loom:** add lib/api/respond.ts BFF envelope helper + adopt in 2 ADF routes ([d875254](https://github.com/fgarofalo56/csa-inabox/commit/d875254630dd94906fa94b730aa6cca3fc4d3ea5))
* **loom:** admin-page in-product help (6 pages) + Learn-Hub editor tutorials (Fabric IQ + RTI) (wave 9) ([be06996](https://github.com/fgarofalo56/csa-inabox/commit/be0699665d203ade43951b652b622d5a2337d522))
* **loom:** ADX — retention/caching policy + continuous-export authoring (were read-only 'coming') ([2b03e58](https://github.com/fgarofalo56/csa-inabox/commit/2b03e584b0e85982c3845f29a2efe32d33cd9943))
* **loom:** AML — Compute Instance stop/create/idle-shutdown lifecycle + notebook compute controls + default-CI auto-select ([68ad533](https://github.com/fgarofalo56/csa-inabox/commit/68ad5335271cc741cb709b689b28d4201a602d66))
* **loom:** AML zero-gate — default-on ML workspace + idle-TTL Compute Instance + MI Contributor + LOOM_AML_DEFAULT_COMPUTE env ([32b5ba1](https://github.com/fgarofalo56/csa-inabox/commit/32b5ba1f9382769b3e45787c4756c0fe9958f976))
* **loom:** APIM named-values Key Vault secret mode (keyVault.secretIdentifier) ([3635d8a](https://github.com/fgarofalo56/csa-inabox/commit/3635d8a35e593412ce1fc68ae5d3a9e0d9f1a306))
* **loom:** Azure SQL Managed Instance — live TDS query execution (reuse SqlDbTree), was list-only ([44b1b71](https://github.com/fgarofalo56/csa-inabox/commit/44b1b715bd9bfbc08e96b90eba11dbdbf864cb8c))
* **loom:** catalog search — Purview classification + glossary-term facets (find assets by sensitive-info type) ([33fc9e6](https://github.com/fgarofalo56/csa-inabox/commit/33fc9e654a7d2db9cdb47260a1f20e5159a84658))
* **loom:** Cosmos DB — account management tabs (global distribution + consistency + backup/restore + networking) ([be65a35](https://github.com/fgarofalo56/csa-inabox/commit/be65a35c615c15ea4211c3afde309d85215c148d))
* **loom:** Data Factory — global parameters editor + managed private endpoints (were 'coming' stubs) ([b20ba45](https://github.com/fgarofalo56/csa-inabox/commit/b20ba45ce1c79a8a2b733f7642dbfb1b303ddb2c))
* **loom:** Event Grid — create event subscription (destination + filters + dead-letter + retry) + regenerate key ([ccbf15e](https://github.com/fgarofalo56/csa-inabox/commit/ccbf15e3b8bcc88b48bfa6df6898b949c94becba))
* **loom:** Fabric IQ aip-logic — typed AI logic + tool-calling + live run panel ([5392403](https://github.com/fgarofalo56/csa-inabox/commit/539240331cff72f4b6fa76753a0ee947c06918f9))
* **loom:** Fabric IQ data-agent — evaluation + NL ask consume endpoint + conversation starters ([98c5a0b](https://github.com/fgarofalo56/csa-inabox/commit/98c5a0b6864cb862aca56f5b34e0d6f449b4cc71))
* **loom:** Fabric IQ graph-model — typed node/edge schema + ADX make-graph validate/preview ([2d414fb](https://github.com/fgarofalo56/csa-inabox/commit/2d414fb7e2ae71fcda03642911478556411209c2))
* **loom:** Fabric IQ health-check — tabbed monitor (Checks/Status/History/Settings), per-rule run/enable/disable/delete + severity, Azure Monitor fired-alert history ([adfd8ec](https://github.com/fgarofalo56/csa-inabox/commit/adfd8ec1acb802fe444debd2287a8456181b30dc))
* **loom:** Fabric IQ map — interactive Azure Maps (retarget from static SVG) ([8145dd4](https://github.com/fgarofalo56/csa-inabox/commit/8145dd484cec245a6705e1c582f5ffdc326a1570))
* **loom:** Fabric IQ ontology — typed object/link/action modeling UI over typed model ([51aad30](https://github.com/fgarofalo56/csa-inabox/commit/51aad3037df995d98686ea6aefa3b4c9c87cb8a4))
* **loom:** Fabric IQ ontology-sdk — scope selector + action-type codegen + typed properties ([9f73952](https://github.com/fgarofalo56/csa-inabox/commit/9f73952924d92cf4d2ba899831fcf72764bc8d55))
* **loom:** Fabric IQ plan — Model/cube tab (dimensions+measures+hierarchies) + guided Formula builder ([052d05e](https://github.com/fgarofalo56/csa-inabox/commit/052d05e99f52c1a7fe83b3af98a2f2f5aee48b7e))
* **loom:** Fabric IQ release-environment — rich environments + pipeline + approval gates + slot swap + versions ([e6ce1d2](https://github.com/fgarofalo56/csa-inabox/commit/e6ce1d2d17b969708965aa397396274cd4cb45f4))
* **loom:** Fabric IQ slate-app — live preview (Run mode) + query engine + widget canvas ([6edb13f](https://github.com/fgarofalo56/csa-inabox/commit/6edb13f52441a88296fdaabc6b3c3f2cb7fae3b5))
* **loom:** Fabric IQ workshop-app — widget/layout canvas + variables/bindings + actions ([557ce35](https://github.com/fgarofalo56/csa-inabox/commit/557ce354788624972e5b9848bc2f8c15b1b2e88a))
* **loom:** Foundry playground — in-product On-Your-Data grounding (AI Search) with citations, was a portal deep-link ([c9e4ed4](https://github.com/fgarofalo56/csa-inabox/commit/c9e4ed45cd646291c46ad11239844a3492580b86))
* **loom:** lakehouse-shortcut — source-type picker (S3 / S3-compatible / GCS / Blob / Dataverse / internal), was ADLS-only ([1bf2d76](https://github.com/fgarofalo56/csa-inabox/commit/1bf2d7625d463b3c60f0113616de7480ee2a9ed0))
* **loom:** marketplace + catalog editor validation & fixes (Data Factory / Power BI / Graph+Vector / AI&Agents / data-product), ADX+tapestry fixes, no-fabric framing ([e8bec85](https://github.com/fgarofalo56/csa-inabox/commit/e8bec854ddb868b01074740a85923e0f3ba24ff4))
* **loom:** messaging editors — Azure Monitor Metrics tab (EH/SB/EG) + Event Hubs/Service Bus message explorer ([baa0f86](https://github.com/fgarofalo56/csa-inabox/commit/baa0f86de03bc7fe93100d7c4ffa375f70a974a9))
* **loom:** Notebook designer — folders/subfolders + sort + move in the Notebooks pane (reuse folders engine) ([e94c1ac](https://github.com/fgarofalo56/csa-inabox/commit/e94c1ac132b6ac2d5ee300e659df3b0eb33bc364))
* **loom:** per-user notebook Compute Instances (multi-user AML) + bicep ([12b8ad2](https://github.com/fgarofalo56/csa-inabox/commit/12b8ad2f1b35e1376b10b311703be0a7ffad63dc))
* **loom:** Purview — add-existing data sources (browse subscriptions via ARG → register/scan) + Connections→Purview registration ([95358d1](https://github.com/fgarofalo56/csa-inabox/commit/95358d19bed5905df48f0e129548239b66636575))
* **loom:** Purview — auto-register Loom items as scan sources + define/trigger scan on create (LOOM_PURVIEW_AUTOSCAN gate) ([3ae4a6d](https://github.com/fgarofalo56/csa-inabox/commit/3ae4a6de08e1e23df6a85e2f1dbc695b96bd1e00))
* **loom:** Purview — built-in system classifications catalog + glossary surface + custom business-metadata tags ([a8b0e05](https://github.com/fgarofalo56/csa-inabox/commit/a8b0e059a438c5fed335f27dec45a23260f91509))
* **loom:** Purview — custom business-metadata tags flyout UI + per-item BFF route ([da6f838](https://github.com/fgarofalo56/csa-inabox/commit/da6f8389bc9c3de882175c76e3f963c0753b35ea))
* **loom:** Purview — managed-VNet Integration Runtime + managed private endpoints (scan PE-locked sources without a SHIR VMSS) ([8704e7e](https://github.com/fgarofalo56/csa-inabox/commit/8704e7ef473aef7643577fc1a6b07a61828bb090))
* **loom:** Purview SHIR — universalize scan prewarm across all triggers + auto-register Purview integration runtime ([1d421f6](https://github.com/fgarofalo56/csa-inabox/commit/1d421f6d0ef649f0bc4b1a89191110839a1bc25c))
* **loom:** Service Bus — topic subscriptions + filter rules + full queue/topic settings + SAS keys + networking view ([9e1480f](https://github.com/fgarofalo56/csa-inabox/commit/9e1480f827fb519019b8eca3a490e244e6f24eb3))
* **loom:** Synapse pipelines — wire Integration Runtime backend (managed + self-hosted IR list/manage) ([63a7f95](https://github.com/fgarofalo56/csa-inabox/commit/63a7f95b2d6b93f614741af42fcf8469ca2e3583))
* **loom:** unified capacity + chargeback dashboard (Cost Management + Monitor, normalized-CU) + bicep ([4ed5bf8](https://github.com/fgarofalo56/csa-inabox/commit/4ed5bf845800d311b16424737185b0ad00b99632))
* **loom:** Unity Catalog — Databricks Marketplace listings/installations + Clean Rooms (completes UC feature coverage) ([29b8f31](https://github.com/fgarofalo56/csa-inabox/commit/29b8f31212558b7b17d02ee1bf723bf0280a42a6))
* **loom:** Unity Catalog — external locations + storage credentials + Lakehouse Federation connections/foreign catalogs ([13d1397](https://github.com/fgarofalo56/csa-inabox/commit/13d1397d42b6c07cbab21b88dbb05c0ce96e319f))
* **loom:** Unity Catalog — object/column tags + governed tags + ABAC policies ([28782e6](https://github.com/fgarofalo56/csa-inabox/commit/28782e6333fd4ecbd76f16c1985b6426e2c19fea))
* **loom:** Unity Catalog — registered models as securables + lakehouse data-quality monitoring ([5f0e7d7](https://github.com/fgarofalo56/csa-inabox/commit/5f0e7d7401cdbfb9b04dca056cda5f4196a9847a))
* **loom:** Unity Catalog — workspace-catalog binding + system.* audit/query + data-classification ([ae2f0e4](https://github.com/fgarofalo56/csa-inabox/commit/ae2f0e4794373aa370fcdab0f5161077682510fa))
* **loom:** vector-store — wire real index create + kNN for Cosmos vCore + pgvector (were deferred stubs) ([aab2932](https://github.com/fgarofalo56/csa-inabox/commit/aab2932dcf2e51a45963d0b83c6932646cce9a45))
* **loom:** workspace Items list view — endorsement/sensitivity columns + keyword/type filters ([4160a9c](https://github.com/fgarofalo56/csa-inabox/commit/4160a9c996a50fcd3ef230918ac6679e257343a9))


### Bug Fixes

* **bicep:** ADX database name uses underscore (loomdb_&lt;domain&gt;) not hyphen — valid KQL identifier ([c116808](https://github.com/fgarofalo56/csa-inabox/commit/c116808f5954bb25affe2693a97cebab2a2abf5d))
* **ci:** MSYS path-conv guard in provision-gh-runner.sh + loom-aca runner smoke test ([b7885d1](https://github.com/fgarofalo56/csa-inabox/commit/b7885d198f6ced2f4c48746801c795e013458edf))
* **csa-loom:** convert YAML temp path with cygpath for Windows az (job env now applies) ([#1562](https://github.com/fgarofalo56/csa-inabox/issues/1562)) ([929f8bb](https://github.com/fgarofalo56/csa-inabox/commit/929f8bbb53e44c306a93c95f5f9304d0f8f93559))
* **csa-loom:** grant Synapse RBAC by APP id too (working serverless/warehouse login) + dispatch workflow ([#1574](https://github.com/fgarofalo56/csa-inabox/issues/1574)) ([791c172](https://github.com/fgarofalo56/csa-inabox/commit/791c172a3e7837c86e8a89fb969096fe66bd2dee)), closes [#1549](https://github.com/fgarofalo56/csa-inabox/issues/1549)
* **csa-loom:** loom-uat/verify job-deploy scripts — results-account wiring + Windows temp-path fix ([#1557](https://github.com/fgarofalo56/csa-inabox/issues/1557)) ([cd10c0a](https://github.com/fgarofalo56/csa-inabox/commit/cd10c0adcd3a4ca26b3e0a9ad03d520dbedeffe8))
* **fiab-bicep:** durable Spark→LA emission env on the Console (no-vaporware bicep-sync) ([dd7cfbb](https://github.com/fgarofalo56/csa-inabox/commit/dd7cfbb52a73d9cc30d04a111446c9b47582042d))
* **fiab-console/connectables:** use ACA-compatible UAMI credential for Resource Graph (Add existing) ([#1570](https://github.com/fgarofalo56/csa-inabox/issues/1570)) ([4740cdb](https://github.com/fgarofalo56/csa-inabox/commit/4740cdb8ec1c4909b5dfb24c96e5a2f5559a14d7))
* **fiab-console/lakehouse:** never 504 on list-containers — timeout + honest gate (day-1) ([#1569](https://github.com/fgarofalo56/csa-inabox/issues/1569)) ([aaaac6e](https://github.com/fgarofalo56/csa-inabox/commit/aaaac6edf4815544d305ac08d680a0e098ba482e))
* **fiab-console/uat:** classify status:'remediation' as honest infra-gate (was mis-flagged as realFail) ([#1568](https://github.com/fgarofalo56/csa-inabox/issues/1568)) ([164a797](https://github.com/fgarofalo56/csa-inabox/commit/164a797e548cb886332dedaf1868b2be48b473ff))
* **fiab-console/uat:** pass governance domain in createWorkspace + per-run failure enumeration + ACA upload credential ([#1561](https://github.com/fgarofalo56/csa-inabox/issues/1561)) ([c190e17](https://github.com/fgarofalo56/csa-inabox/commit/c190e1755f2750bf4cc3c913b1d9b1c33798f86e))
* **fiab-console/uat:** poll async install job (202 jobId) instead of reading sync response + drop redundant tracing.start ([#1566](https://github.com/fgarofalo56/csa-inabox/issues/1566)) ([91b590b](https://github.com/fgarofalo56/csa-inabox/commit/91b590b7b3faed790abb145574a3eb74e285062c))
* **fiab-console/uat:** resolve all 28 functional UAT failures (verified live — test bugs, product renders correctly) ([#1567](https://github.com/fgarofalo56/csa-inabox/issues/1567)) ([30d6414](https://github.com/fgarofalo56/csa-inabox/commit/30d64145a1661fe45fbaeece09f9757b8568b7ce))
* **fiab-console:** ACA-first UAMI credential sweep across ~47 BFF routes (Refs [#1549](https://github.com/fgarofalo56/csa-inabox/issues/1549)) ([#1571](https://github.com/fgarofalo56/csa-inabox/issues/1571)) ([b558e9f](https://github.com/fgarofalo56/csa-inabox/commit/b558e9f446ef93b5b29cf3d1f1c655bbb22210f7))
* **fiab-console:** activator alert skipQueryValidation + lakehouse empty-path graceful msg + reference-lakehouse probe timeout ([09095e7](https://github.com/fgarofalo56/csa-inabox/commit/09095e7ad9cec47b329e3c9a6d14a57c0ec9083d))
* **fiab-console:** apim-tree smart-quote parse error (broke batch 6 build) ([11565da](https://github.com/fgarofalo56/csa-inabox/commit/11565dae053d6f2c78b18705051c0f5c363ad3c4))
* **fiab-console:** ARM resource-list fallback for connectables "Add existing" when ARG fails ([#1572](https://github.com/fgarofalo56/csa-inabox/issues/1572)) ([c7114f1](https://github.com/fgarofalo56/csa-inabox/commit/c7114f1d7fb10ac60d0f930c33e3f2350a3d2d9a)), closes [#1549](https://github.com/fgarofalo56/csa-inabox/issues/1549)
* **fiab-console:** batch 2 — systemic Griffel unitless-px fix (706 values/121 files) + connection edit/test + data-product wizard layout ([16a31ab](https://github.com/fgarofalo56/csa-inabox/commit/16a31abccc588d81dde6e691936ac6d62ae4354c))
* **fiab-console:** canvas designer reclaims space for node properties + notebook toolbar alignment ([d14a560](https://github.com/fgarofalo56/csa-inabox/commit/d14a56078c8c7d3828ecedae71041b00b141c82f))
* **fiab-console:** claim-vs-reality batch — Power BI dataset delete + APIM backend creds/TLS (Refs [#1549](https://github.com/fgarofalo56/csa-inabox/issues/1549)) ([#1560](https://github.com/fgarofalo56/csa-inabox/issues/1560)) ([a37f010](https://github.com/fgarofalo56/csa-inabox/commit/a37f010c82117474a9aeb9be75e84e8bed0cbcea))
* **fiab-console:** data-product detail 2nd crash — default item to catalog type (ItemEditorChrome item.displayName) ([15236d7](https://github.com/fgarofalo56/csa-inabox/commit/15236d79f8a25994eeae84991ca0c925c187b06b))
* **fiab-console:** data-product detail page crash + Power Automate deprecated admin API (deep-pass live finds) ([a9381bc](https://github.com/fgarofalo56/csa-inabox/commit/a9381bc61ca52b36eb851261eb7f5cee8972d902))
* **fiab-console:** data-product index key used an invalid colon — every upsert 400'd (THE root cause) ([9570ed4](https://github.com/fgarofalo56/csa-inabox/commit/9570ed4cec9a3247cfe9c17702fc97be40d8801c))
* **fiab-console:** data-product index mirror is awaited + logs failures (was fire-and-forget → never indexed) ([1f1fd34](https://github.com/fgarofalo56/csa-inabox/commit/1f1fd3493c47e0ca496060c4d9985977a49a1b50))
* **fiab-console:** data-product PATCH now re-mirrors to the discovery index ([b4c57d7](https://github.com/fgarofalo56/csa-inabox/commit/b4c57d7ca10f9eea869e29723b1aabf7a9ad661c))
* **fiab-console:** item editor renders full ribbon even when live-backend load errors (ui-parity) ([6c87366](https://github.com/fgarofalo56/csa-inabox/commit/6c87366bc494b1dbcf778d91e5235062dadb1852))
* **fiab-console:** JSON-config -&gt; forms + real airflow runs + de-vaporware editors (batch 2) ([6ea39ea](https://github.com/fgarofalo56/csa-inabox/commit/6ea39ea0865f31074a1312e7981f4ea51ca710b7))
* **fiab-console:** lakehouse CREATE SCHEMA runs Spark DDL in background (no 504) ([213b7bb](https://github.com/fgarofalo56/csa-inabox/commit/213b7bb20c25fd136fb174e4d4c537a7a6e952c8))
* **fiab-console:** live-defect batch — Publish-as-API, RBAC RG self-heal, response formatter, icon crashes, mirror connections ([a0b62d9](https://github.com/fgarofalo56/csa-inabox/commit/a0b62d9f677d4bf1eda43eaa0a6a3ada1a755b46))
* **fiab-console:** loom-items index keys used invalid colons (it:/ws:) — same bug as data-products ([f18e315](https://github.com/fgarofalo56/csa-inabox/commit/f18e31550aff868e4bafa6780485d8dcbce38d87))
* **fiab-console:** marketplace data-products search self-heal + Web 3.0 visual alignment ([7189ac1](https://github.com/fgarofalo56/csa-inabox/commit/7189ac1eba4e80ce6cb1d5d60fdec1c63e3308fb))
* **fiab-console:** marketplace functional-loop fixes (data-product indexing + Delta Sharing gate + APIM Internal gateway DNS) ([93bd2fd](https://github.com/fgarofalo56/csa-inabox/commit/93bd2fd3a4a57367c4d3d2c0c3fad80ecd0702b3))
* **fiab-console:** mirror Start — sp_change_feed_enable_db invalid [@max](https://github.com/max)_concurrent_workers param (broke ALL SQL mirror Starts) ([71059d8](https://github.com/fgarofalo56/csa-inabox/commit/71059d81cb5e30aad0f9257fbbad02caaebba3a3))
* **fiab-console:** mirror wizard dialog never closes — conditional-mount the wizard ([4cd128d](https://github.com/fgarofalo56/csa-inabox/commit/4cd128d8ae080634d0cd2ad76830c8f1d6bab1b6))
* **fiab-console:** mirror/table-list — bracket reserved aliases [rowCount]/[type] (Incorrect syntax near keyword 'rowCount') ([184da2f](https://github.com/fgarofalo56/csa-inabox/commit/184da2ff72e781894e5d6f95c7b40f571708c8fb))
* **fiab-console:** notebook — readable Spark-session receipt + collapsible compute setup ([1af7391](https://github.com/fgarofalo56/csa-inabox/commit/1af73910b4487209a5818baffb979cf4592a73af))
* **fiab-console:** pipeline "Validate" now runs a real server-side validator (not a non-existent ADF REST call) ([#1559](https://github.com/fgarofalo56/csa-inabox/issues/1559)) ([a310c83](https://github.com/fgarofalo56/csa-inabox/commit/a310c83bf734e8c9a39abbde8a67e38b886ebc2f)), closes [#1549](https://github.com/fgarofalo56/csa-inabox/issues/1549)
* **fiab-console:** pipeline dataset/LS auto-provision ([#1576](https://github.com/fgarofalo56/csa-inabox/issues/1576)) + install-dialog loading state + workspaces count timeout ([b10e916](https://github.com/fgarofalo56/csa-inabox/commit/b10e9166962eef1e889224c83813b60e47ae4f60))
* **fiab-console:** Postgres AAD token resource .azure.com -&gt; .windows.net (AADSTS500011) ([c597578](https://github.com/fgarofalo56/csa-inabox/commit/c59757874f8bd36d5bc82df3a4e21933f57ecf05))
* **fiab-console:** query-through-shortcut action for Files shortcuts + bound compute-targets discovery ([531a428](https://github.com/fgarofalo56/csa-inabox/commit/531a4284ac99c39ec452602d38648974108689b2))
* **fiab-console:** real workspace sensitivity tab + de-vaporware APIM/data-flow framing (batch 6) ([0d892e5](https://github.com/fgarofalo56/csa-inabox/commit/0d892e5f26e4c8c6b841204934c58b85288ac5bb))
* **fiab-console:** render dedicated item editor immediately — don't gate on slow getItem (ui-parity) ([870ed00](https://github.com/fgarofalo56/csa-inabox/commit/870ed003c96ff94b8aa91cf961f76d3744e6384e))
* **fiab-console:** resolveRunCluster picks ALL-PURPOSE clusters only (Databricks notebook/ml-model runs) ([9868ccf](https://github.com/fgarofalo56/csa-inabox/commit/9868ccfff9bc718448946adcde532e04e350689c))
* **fiab-console:** Tables shortcuts register views in a serverless user DB, not master ([65fc2bb](https://github.com/fgarofalo56/csa-inabox/commit/65fc2bba37ad6821771621c80e6b00d70eb7f92f))
* **fiab-console:** Web3.0 token sweep across ~100 item-editor/component files (batch 3) ([b3eba02](https://github.com/fgarofalo56/csa-inabox/commit/b3eba025e0fb709e8fdbe16a041cddd2b76e9713))
* **fiab-console:** Web3.0 tokenize 26 surfaces + remove stub banners + chat cause-logging ([cc6a17d](https://github.com/fgarofalo56/csa-inabox/commit/cc6a17d548995e703f7aeca74a3dd113bc30ae91))
* **fiab-console:** workspace create defaults to 'default' domain when none picked ([3fe039c](https://github.com/fgarofalo56/csa-inabox/commit/3fe039c040253131d7d700a6446a36907528e8ca))
* **fiab-delta-sharing:** add CREATE CATALOG to the grant set — subscribe (create catalog from share) was blocked; wire ALL grants day-one ([e2de68d](https://github.com/fgarofalo56/csa-inabox/commit/e2de68d7ae043936c6929c3de95a886bbb5b68b3))
* **fiab-network:** provision the Power Platform VNet-gateway delegated subnet day-one ([711e92e](https://github.com/fgarofalo56/csa-inabox/commit/711e92ee9a198c2bfbd7e5badbdc0278d9718e02))
* **fiab-notebook:** display() NameError on reused Spark sessions — inject the helper once per session ([ed304e5](https://github.com/fgarofalo56/csa-inabox/commit/ed304e5bc76cc097d031270ab6abff8a127a603b))
* **fiab-notebook:** display() rich grid — collect()-based serialize (no Arrow) + surface fall-through reason ([137166a](https://github.com/fgarofalo56/csa-inabox/commit/137166ace3404c245e8a664660369b5fbb7f4ee5))
* **fiab-notebook:** redact the LA shared key from the Spark session receipt (secret leak) ([3b225a8](https://github.com/fgarofalo56/csa-inabox/commit/3b225a8a724110eb2c28bd3069b181b1c12fd9b7))
* **fiab-notebook:** render Markdown correctly (GFM tables++) + auto-fit cell height to content ([7ff0df9](https://github.com/fgarofalo56/csa-inabox/commit/7ff0df942c32a02996b354ecd22ed03fb4b43083))
* **fiab-pipeline:** Manage hub — edit existing linked services + datasets + reachable Integration runtimes ([4ac4c0b](https://github.com/fgarofalo56/csa-inabox/commit/4ac4c0baea75afa41e2de2c81bf01a40c805ed9f))
* **fiab/apim:** sample API Try-it works for any request (API-level return-response) ([2178212](https://github.com/fgarofalo56/csa-inabox/commit/217821251d069c81f896c820712e2d6b66c14789))
* **fiab/bootstrap:** Power Platform SP management-app grant (script + tenant-bootstrap doc) ([0b29ac1](https://github.com/fgarofalo56/csa-inabox/commit/0b29ac142a5d47b579ffc5ce34a94f32699a887c))
* **fiab/dlz:** make multi-sub DLZ reachability + Synapse RBAC day-1 (no-public) (Refs [#1549](https://github.com/fgarofalo56/csa-inabox/issues/1549)) ([#1573](https://github.com/fgarofalo56/csa-inabox/issues/1573)) ([0f71828](https://github.com/fgarofalo56/csa-inabox/commit/0f71828e2f1337c029195bd03c64f69f8cd92b5f))
* **fiab:** AI private endpoints (fixes all-copilot 'fetch failed') + un-wire flaky resolver DNS ([117a787](https://github.com/fgarofalo56/csa-inabox/commit/117a787d317a639dbbb1911c8c0b531909859880))
* **fiab:** build-loom-report supports catalog "Build report in Loom" source modes ([156ab16](https://github.com/fgarofalo56/csa-inabox/commit/156ab16388f49646369d5bff23f14c35f1a44f1d))
* **fiab:** catalog register uses built-in Atlas DataSet type for Loom items ([f41314a](https://github.com/fgarofalo56/csa-inabox/commit/f41314a909d9e2d887ca24a07a79a5ee32c81031))
* **fiab:** close audit P0/P1 gaps — admin PDP gates + kql-database ribbon wizards (real ADX) + KQL-dashboard dead ribbon ([b1d8f84](https://github.com/fgarofalo56/csa-inabox/commit/b1d8f84fca5d3292b3ab5d98f57fc335bed44565))
* **fiab:** data-product /new opens the create form instead of a dead-end ([e49e08f](https://github.com/fgarofalo56/csa-inabox/commit/e49e08f77037448c70cac2a932b269f48368b4aa))
* **fiab:** dbt command checkbox label toggles again (InfoLabel stole the click) ([1865800](https://github.com/fgarofalo56/csa-inabox/commit/1865800573b2e2b1a23ec08a4b0491602b274841))
* **fiab:** EH Phase-0 — sliding-session token-refresh (hourly-logout bug) + /api/health/deep ([1a6df3c](https://github.com/fgarofalo56/csa-inabox/commit/1a6df3cf916f54efd530aa5675384e5b2bfb640b))
* **fiab:** functional bug-hunt — Azure-native fallbacks + dead-control/honesty fixes ([b7b16fd](https://github.com/fgarofalo56/csa-inabox/commit/b7b16fdbe1e3956288a749b9874058d7f4313f95))
* **fiab:** migrate all AOAI chat-completions calls to max_completion_tokens ([38e6d5d](https://github.com/fgarofalo56/csa-inabox/commit/38e6d5db9a3283142e1306e2b833d27d235c9045))
* **fiab:** mirror incremental — enable TABLE-level change tracking when DB-level is on ([071b80f](https://github.com/fgarofalo56/csa-inabox/commit/071b80f729cf3c2b8d458f2bf0b896bdff8611b0))
* **fiab:** mirror incremental CDC — enable change tracking via sys.change_tracking_databases ([809e46f](https://github.com/fgarofalo56/csa-inabox/commit/809e46f691148b3039859970ec7c6d4359c8cbab))
* **fiab:** move data-product to 'CSA Data Products' catalog group for discoverability ([a386ab7](https://github.com/fgarofalo56/csa-inabox/commit/a386ab71d1aa2eaa74c3561673f401608e30f51e))
* **fiab:** new-item-dialog — drop duplicate runtimeChoice decl (build break) ([7c7e6a7](https://github.com/fgarofalo56/csa-inabox/commit/7c7e6a725d3308a34dee893cff4fe35002de2b3b))
* **fiab:** report designer guards id==='new' (no /api/items/report/new 404s) ([aeb16f6](https://github.com/fgarofalo56/csa-inabox/commit/aeb16f6ca82ac2699d3700c29ded85409fa31fe3))
* **fiab:** robust Cosmos mirror consumption query + bracket reserved AS [type] aliases ([4032e1c](https://github.com/fgarofalo56/csa-inabox/commit/4032e1cba1a0246972229ecb62c50a248ce01c53))
* **fiab:** sample-data loader uses .set-or-replace datatable (inline ingest rejected by ADX mgmt REST) ([89ff9f2](https://github.com/fgarofalo56/csa-inabox/commit/89ff9f216f7f2dea3c72df42cabb79f28fd60ac9))
* **fiab:** sample-loader create commands use .create-merge table (.create-or-alter table is invalid ADX) ([afe4c93](https://github.com/fgarofalo56/csa-inabox/commit/afe4c9338450d43579dc573b7992f8f3a8f29dc3))
* **fiab:** supercharge [#83](https://github.com/fgarofalo56/csa-inabox/issues/83) — {{ADLS_ACCOUNT}} substitution (install+run) + table-naming consistency + sample-data seeder + medallion notebook fixes ([31e10fc](https://github.com/fgarofalo56/csa-inabox/commit/31e10fc8805df57c7995bce181e862d80379b1c8))
* **fiab:** supercharge Bronze Utils runs cell-by-cell (TYPE_CHECKING import bug) ([d954407](https://github.com/fgarofalo56/csa-inabox/commit/d954407abebe592246a549aeef2d13d4a38a4a8b))
* **fiab:** Synapse Spark can't read the PE-only lake — create managed PE in-VNET ([5edc28e](https://github.com/fgarofalo56/csa-inabox/commit/5edc28e746fe26800b9c23ed55b37bec1604d9d3))
* **fiab:** Unified Catalog — register no-fabric + open-in-workspace + build-report-in-Loom ([7efd437](https://github.com/fgarofalo56/csa-inabox/commit/7efd4370d46efdda1d4a710e880fcaf969f66fa6))
* **fiab:** wire existing SQL Warehouse Connection dialog instead of duplicating it ([d99d5cd](https://github.com/fgarofalo56/csa-inabox/commit/d99d5cd11c7be101973abdd4feb863656eb9449a))
* **governance:** correct Unity Catalog metastore_summary endpoint (self-audit Delta Sharing probe) ([0642d53](https://github.com/fgarofalo56/csa-inabox/commit/0642d531da7a7da05261e55566bc4961aa95ab25))
* **loom,bicep:** emit LOOM_SWA_*/ADX_ALERT_SCOPE/MAPS/REPORT_RENDERER env + roles (no-vaporware bicep-sync) ([c2a033a](https://github.com/fgarofalo56/csa-inabox/commit/c2a033a146282dda40bc314efb2be0a976b04f22))
* **loom,bicep:** wire notebook-compute-pool module + strip comments in bicep-sync guard (rel-T08/B6) ([#1588](https://github.com/fgarofalo56/csa-inabox/issues/1588)) ([d21489b](https://github.com/fgarofalo56/csa-inabox/commit/d21489b93730d3eccf23714e559a1ea6dd1e09ed))
* **loom,build:** raise ACR container build heap 4096→6144 (Next build OOM, run cj9h) ([6bef355](https://github.com/fgarofalo56/csa-inabox/commit/6bef35563d28dce3e50701348dd2173ff9cb9947))
* **loom,ci:** bump next-build heap 4096-&gt;6144 (OOM on every console PR) ([#1593](https://github.com/fgarofalo56/csa-inabox/issues/1593)) ([6165092](https://github.com/fgarofalo56/csa-inabox/commit/6165092297bfc015cc9e71f4766d50131e677c65))
* **loom,ci:** green the two required checks blocking [#1582](https://github.com/fgarofalo56/csa-inabox/issues/1582) ([fc820c6](https://github.com/fgarofalo56/csa-inabox/commit/fc820c640826a4f1c84d3aec4850f3e4098e0203))
* **loom,docs:** purge live estate identifiers + PII from published docs, add hygiene CI gate (rel-T02/B2) ([#1592](https://github.com/fgarofalo56/csa-inabox/issues/1592)) ([50e0f67](https://github.com/fgarofalo56/csa-inabox/commit/50e0f67de461cef6d264e9bf05170b9af5b1c70d))
* **loom,no-fabric:** Azure-native BI default — bicep chain + scorecard Cosmos default + zero-PBI-call editors (B11/B12, rel-T03/T04/T07) ([#1587](https://github.com/fgarofalo56/csa-inabox/issues/1587)) ([9fddd55](https://github.com/fgarofalo56/csa-inabox/commit/9fddd553c6cb8a331f0b1d12111b548b3a6a8f33))
* **loom,rti:** ADX activator start/stop honest lifecycle + on-demand run history ([637bb70](https://github.com/fgarofalo56/csa-inabox/commit/637bb702a8436a656dda6c29d7a3983200373424))
* **loom,security:** eliminate predictable guid(rg.id) service secrets (B3/B3b) ([#1585](https://github.com/fgarofalo56/csa-inabox/issues/1585)) ([43964c3](https://github.com/fgarofalo56/csa-inabox/commit/43964c3eb6c781e87d429812acee1b4cab1b503e))
* **loom,security:** gate workspace connections/spark sub-routes with owner-or-admin (wave 7) ([263b3c9](https://github.com/fgarofalo56/csa-inabox/commit/263b3c940ef1ba89e0cc62ed99dd01b95cbed445))
* **loom,security:** ownership gates on data-agent-schema/activator-adx-source/adx-anomaly + geocode all-fail + widen route-guard checker ([ccca74b](https://github.com/fgarofalo56/csa-inabox/commit/ccca74b55a7d33c2a47707718d4216c241503ec8))
* **loom,security:** ownership gates on OneLake security-roles + preview-as (cross-tenant escalation) ([0e62326](https://github.com/fgarofalo56/csa-inabox/commit/0e62326be52efe236c69fcd7a1693f9f488f9968))
* **loom,udf:** load item state directly (self-fetch fails behind Front Door) + internal ingress for udf-runtime ([#1594](https://github.com/fgarofalo56/csa-inabox/issues/1594)) ([217d84a](https://github.com/fgarofalo56/csa-inabox/commit/217d84a940c7046ef3c5f172c96b5e7c6faceccf))
* **loom,udf:** run authored source via x-udf-source-b64 + real config surfaces (rel-T05/T06, B5) ([#1590](https://github.com/fgarofalo56/csa-inabox/issues/1590)) ([84b4813](https://github.com/fgarofalo56/csa-inabox/commit/84b481347441b82f15f2caab67a19d6d8e096336))
* **loom:** add-existing data sources — bump connectables ARG timeout 6s→40s + loading state (cross-sub browse was timing out) ([3670a60](https://github.com/fgarofalo56/csa-inabox/commit/3670a6099a3ff109541fd9023fd5c76298791d8a))
* **loom:** ADX sample-loader — use proven createTable+ingestInline, drop hand-rolled KQL ([6adc5bb](https://github.com/fgarofalo56/csa-inabox/commit/6adc5bbe5f89461f15741dbb99c0b64052c10af8))
* **loom:** ADX sample-loader investigation — bracket column names for reserved KQL keywords ([c2b2d97](https://github.com/fgarofalo56/csa-inabox/commit/c2b2d97c859e4fe8eca0eecb265cc0ddb4a02bdf))
* **loom:** ADX sample-loader SYN0002 — strip space after colon in create/datatable schema ([440c051](https://github.com/fgarofalo56/csa-inabox/commit/440c051046297e20d67b3f984181dac5da7ece18))
* **loom:** CSP allow atlas.microsoft.com so the Azure Maps Web SDK loads ([984a64e](https://github.com/fgarofalo56/csa-inabox/commit/984a64e9564b35c9c587e762ec1eca44e6bc55a5))
* **loom:** data-product create persists empty record — stale setState snapshot ([d103404](https://github.com/fgarofalo56/csa-inabox/commit/d1034047fdee1c7e3b68835a77560027f25cb1d4))
* **loom:** data-product read-view surfaces create-form owner (singular owner fallback) ([835c521](https://github.com/fgarofalo56/csa-inabox/commit/835c521025dd8721e3a751b41020939dd86b4760))
* **loom:** eventstream — lead with Azure-native default, Fabric opt-in (no-fabric framing) ([fd8a6ab](https://github.com/fgarofalo56/csa-inabox/commit/fd8a6ab37bb30fbe0de8512627a41a47edd52d5e))
* **loom:** Learn content — cosmos-db indexing/conflict/scripts + vector-store similarity are shipped (were 'coming'/'deferred') ([cce34c7](https://github.com/fgarofalo56/csa-inabox/commit/cce34c77a3a626551ad23c6d18074b0b9a8f4b72))
* **loom:** Learn content — lead Azure-native for warehouse/mirrored/kql/lakehouse/etc (was teaching Fabric/OneLake default); author synapse-notebook Learn ([1a23892](https://github.com/fgarofalo56/csa-inabox/commit/1a23892215f0efae4c6a13fea89405d04b1f37b6))
* **loom:** nav dedup (governance/domains/lineage) + copilot allow-list from nav + /docs 404 links → loomDocUrl + items-by-type-pane tokens/TileGrid/EmptyState ([1a6003c](https://github.com/fgarofalo56/csa-inabox/commit/1a6003c83f4aa1cccb48965c181d471ebd090eae))
* **loom:** no-fabric framing — mounted-adf + azure-sql-database descriptions ([a6f68ce](https://github.com/fgarofalo56/csa-inabox/commit/a6f68cee1889af71a62ed740beeff3c5b2edfba8))
* **loom:** no-fabric framing in catalog descriptions (OneLake → Azure-native) ([14421e0](https://github.com/fgarofalo56/csa-inabox/commit/14421e081cd6e2516770027b24bc7009761bd975))
* **loom:** Organization Reports — wire ALL reports to live real Loom data, remove sample-data path/gates ([03b023c](https://github.com/fgarofalo56/csa-inabox/commit/03b023ca3fb31a94f78e932bf074749c78a7159f))
* **loom:** Purview — static built-in classification catalog (SSN/address/PII/financial) + fix false not-provisioned banner + rules-load timeout ([68efb05](https://github.com/fgarofalo56/csa-inabox/commit/68efb052f0d914828355d2a09caa6e42d0caed30))
* **loom:** raise chargeback Cost Management query timeout (6s→60s, per-sub parallel) — was always timing out ([2ead9ab](https://github.com/fgarofalo56/csa-inabox/commit/2ead9ab61d3d74fc3d950beb2bff750deec13d1c))
* **loom:** report endorsement PATCH 405 + Rayfin editor chrome wrap + endorsement level help ([54a54c4](https://github.com/fgarofalo56/csa-inabox/commit/54a54c411bd7b6e3ff3ffa5ece3e091cc13cb1c2))
* **loom:** resolve orphaned /lakehouse /notebook /warehouse /semantic-model pages (wire into nav or remove dead dupes) ([7a78571](https://github.com/fgarofalo56/csa-inabox/commit/7a78571ddb7d76f35853f1b4efde5834f6cb179e))
* **loom:** resolve unreachable /catalog/data-quality duplicate (canonical is /governance/data-quality) ([2a68d25](https://github.com/fgarofalo56/csa-inabox/commit/2a68d25190ee6195e2cbbfa53ecfce914459ae05))
* **loom:** SECURITY — admin gate + assertOwner on workspace networking NSG routes (were session-only → firewall bypass) ([20a086d](https://github.com/fgarofalo56/csa-inabox/commit/20a086d206c0f05581c36a9a27ca408ce8f41609))
* **loom:** SECURITY — admin gate on admin/security/* + sensitivity/classifications routes (were session-only → org-wide policy write by any user) ([9ad0caf](https://github.com/fgarofalo56/csa-inabox/commit/9ad0caf9365448a6739df659385ecdd9247199c1))
* **loom:** SECURITY — admin gate on azure-resources/network-topology/users + fail-closed plan approval-callback ([075d19d](https://github.com/fgarofalo56/csa-inabox/commit/075d19d211db963e9acac52604ab34b75b7be753))
* **loom:** SECURITY — assertOwner on workspace connections/spark/task-flows + gate audit-logs/tenant-settings + redact mcp-servers authValue ([3facb9b](https://github.com/fgarofalo56/csa-inabox/commit/3facb9bd2e80cef97b681052e35bbf3eed09f543))
* **loom:** SECURITY — CSP script-src remove unsafe-inline/data (nonce-based) ([920a5f0](https://github.com/fgarofalo56/csa-inabox/commit/920a5f088ab620a586990381c736e2efa0fedd5a))
* **loom:** slate query SSRF credential gating + eventstream env fallback + env-config whitelist + MPE private-DNS zone group ([eee7d68](https://github.com/fgarofalo56/csa-inabox/commit/eee7d6826a1ad41ab42f918e6c2f8777782199fd))
* **loom:** Spark-pool config — editable + real ARM PUT save; fix groupBy codegen (was readOnly stub + broken .agg TODO) ([71f1737](https://github.com/fgarofalo56/csa-inabox/commit/71f173707892dbb7384399bc3f68aaef6810737e))
* **loom:** tapestry geo/timeline KQL — rename reserved __lat/__lon/__ts columns ([7340850](https://github.com/fgarofalo56/csa-inabox/commit/73408506eb921ba9f5da8a89164f4d14f166b65d))
* **loom:** tapestry/gql-graph make-graph prelude — rename reserved __nodes/__edges ([6cde8c3](https://github.com/fgarofalo56/csa-inabox/commit/6cde8c3ae6ceff9c0217a5e2b4c2dbaece0bf4e6))
* **loom:** Wave-0 install-dialog a11y + UDF Run + compute-storm + not-found ([169770d](https://github.com/fgarofalo56/csa-inabox/commit/169770d4f9ad5efa258683b5f39f323bc8307227))


### Code Refactoring

* **fiab:** EH Phase-0 — extract inlined RLS compiler to lib/azure/rls-compiler.ts (+ unit test) ([e59b919](https://github.com/fgarofalo56/csa-inabox/commit/e59b919e3266d245e6052676ac6e83df18bffd2b))
* **fiab:** EH Phase-0 — migrate all 18 AOAI callers to the unified aoai-chat-client ([afb4cce](https://github.com/fgarofalo56/csa-inabox/commit/afb4cceea166b7f61e42356a09b8f9a3aa315f0a))
* **fiab:** EH Phase-0 — one unified AOAI chat client (orchestrator reference migration) ([fdb6319](https://github.com/fgarofalo56/csa-inabox/commit/fdb6319dfea9474c825a0265ece445fa0b59e879))
* **fiab:** EH Phase-0 editor split slice 1 — extract Datamart + Warehouse editors ([e1211b5](https://github.com/fgarofalo56/csa-inabox/commit/e1211b5b4cfb31675dfee796c920e607f106a953))
* **fiab:** EH Phase-0 editor split slice 2 — extract Scorecard + PaginatedReport + Activator ([373f4c1](https://github.com/fgarofalo56/csa-inabox/commit/373f4c17d89f2eac0c311554e55f0cd1e1aeefc6))
* **fiab:** EH Phase-0 editor split slice 3 — extract Eventstream + SemanticModel + Report (+ shared WorkspacePicker) ([9101112](https://github.com/fgarofalo56/csa-inabox/commit/91011123cf5bc462d85cefb6448973a5d26dc32d))
* **fiab:** EH Phase-0 editor split slice 4 — extract Eventhouse + KqlQueryset + Dashboard (+ shared kql-results) ([f409fc5](https://github.com/fgarofalo56/csa-inabox/commit/f409fc53500cff84bca48c176334507d19aba01f))
* **fiab:** EH Phase-0 editor split slice 5 (FINAL) — extract KqlDatabase + KqlDashboard → thin barrel ([d3f0f6f](https://github.com/fgarofalo56/csa-inabox/commit/d3f0f6fa699db2a174d339aed17ee0f4a71fb855))
* **loom,build:** exclude tests from build type-check + fix app tsc errors + gate build on types (ignoreBuildErrors:false) ([9804eb4](https://github.com/fgarofalo56/csa-inabox/commit/9804eb4b457981362788055d67f9cdd2249f700e))
* **loom,perf:** report accel on Databricks SQL/Photon (Azure-native) — retire DuckDB container ([17dde89](https://github.com/fgarofalo56/csa-inabox/commit/17dde8997116b7b8eb367bd3915c2340eb5562f3))
* **loom:** adopt shared editor-styles in top-duplicating editors (DRY, zero visual change) ([f2842b5](https://github.com/fgarofalo56/csa-inabox/commit/f2842b521a4347edd8f6c5f776c99bb6dcc3483f))
* **loom:** dedup monitorGate + AOAI-SSE + err()-&gt;apiError across app/api (behavior-preserving) ([9835236](https://github.com/fgarofalo56/csa-inabox/commit/9835236d123c5595d8f6f4500974693aff1cb9b0))
* **loom:** extract report definition sanitizers into lib/report/ (thin route, zero behavior change) ([277abc5](https://github.com/fgarofalo56/csa-inabox/commit/277abc54e50eccc96f76013cf9c6209052fe3504))
* **loom:** extract shared notebook param preamble in content-bundles (byte-identical output) ([626b201](https://github.com/fgarofalo56/csa-inabox/commit/626b2017840f14815e163ecd0355341a1c1e4b9e))
* **loom:** fix concentrated tsc error clusters (spark-observability/registry/editors/panes) — real type fixes ([6eeaef9](https://github.com/fgarofalo56/csa-inabox/commit/6eeaef993cf12e77eb9dfe03f5674472b492d9d3))
* **loom:** promote editor style primitives to lib/editors/shared-styles.ts ([fef551c](https://github.com/fgarofalo56/csa-inabox/commit/fef551c13c5d69051a09467a794d87989881b23c))
* **loom:** shared lib/azure/swa-publish.ts for slate+workshop publish (dedup, zero behavior change) ([d709e4e](https://github.com/fgarofalo56/csa-inabox/commit/d709e4eb76cd77d5109c46a376fe468ba05e7536))
* **loom:** split 3313-line palantir-editors.tsx into lib/editors/palantir/ (barrel-preserving, zero behavior change) ([cfbbbd3](https://github.com/fgarofalo56/csa-inabox/commit/cfbbbd359339c4f0c0a84c8f4b594b28c1853b6a))
* **loom:** split 5150-line lakehouse-editor.tsx into lib/editors/lakehouse/ (barrel-preserving, zero behavior change) ([0da8ec5](https://github.com/fgarofalo56/csa-inabox/commit/0da8ec5e31c35c241c3636bf5927b55ec4323475))
* **loom:** split 6818-line phase4-editors.tsx into lib/editors/phase4/ (barrel-preserving, zero behavior change) ([cb280f6](https://github.com/fgarofalo56/csa-inabox/commit/cb280f6ed7bfa7ffe7375c1c92564e0608194232))
* **loom:** split 7795-line databricks-editors.tsx into lib/editors/databricks/ (barrel-preserving, zero behavior change) ([b9b7d5e](https://github.com/fgarofalo56/csa-inabox/commit/b9b7d5e69a9f6f30226bf3b011fbf0e06b173f9b))
* **loom:** split lib/catalog/fabric-item-types.ts into per-category item-types/ modules (barrel-preserving, identical item set) ([04cfa8d](https://github.com/fgarofalo56/csa-inabox/commit/04cfa8d1e895c58aff6319ba5c8dff79e0cf221f))


### Documentation

* **audit:** no-cuts functional run — 8 resource-bound editors hide ribbon during load/error (ui-parity gap) ([dc8f994](https://github.com/fgarofalo56/csa-inabox/commit/dc8f994486fc0c2be6e71f322547926bcc2f02fb))
* **eh-prp:** Phase-0 status — AOAI consolidation + editor split COMPLETE (rev 113) ([e1d3e56](https://github.com/fgarofalo56/csa-inabox/commit/e1d3e567d1e4130cc51a5ddfd13abd95785ab5c5))
* **eh-prp:** Phase-0 status — rls-compiler + madge guard done (rev 114); safe autonomous Phase-0 complete ([8810f69](https://github.com/fgarofalo56/csa-inabox/commit/8810f6927aa63a1d62873b8ffd03b08387d581d5))
* **fiab/audit:** live UI sweep log — shortcuts (bugs 1-3) + workspace domain (bug 4) + apps verdict ([84e2db1](https://github.com/fgarofalo56/csa-inabox/commit/84e2db176377730523c73322aa83fc19973d6cf8))
* **fiab/audit:** New-item sweep — all 109 item types pass (batched), realFails=0 ([e83f959](https://github.com/fgarofalo56/csa-inabox/commit/e83f959faa037964f20d5c0291f321aead8f296e))
* **fiab/audit:** verified Databricks all-purpose-cluster fix (3 apps pass on re-run; realFails=0) ([bd0a945](https://github.com/fgarofalo56/csa-inabox/commit/bd0a9450857faa26787393bc0cb77a3cbfdf7e9f))
* **fiab:** admin VPN access guide (P2S setup, host-file, per-service reachability) ([2717e74](https://github.com/fgarofalo56/csa-inabox/commit/2717e7423291befa76c077d4424043cffb9253ec))
* **fiab:** close §3 (Front Door already not caching) + attended follow-ups with leads ([bc1f7e4](https://github.com/fgarofalo56/csa-inabox/commit/bc1f7e476915539f0b8fcd6bc30b17ca2cdd291a))
* **fiab:** continuation plan — mirror e2e remaining types + notebook demo + follow-ups ([1c2161f](https://github.com/fgarofalo56/csa-inabox/commit/1c2161fe3bbbf71af8f8798c7f88019e4c1e12e9))
* **fiab:** correct VPN firewall section — private pool can't be an IP rule; PE+tunnel is the model ([9afe10f](https://github.com/fgarofalo56/csa-inabox/commit/9afe10f6f2e766aaa2676f99698b6e4716bbc2b7))
* **fiab:** Dataverse app-user — note the day-one MSAL-app credential fallback ([b5dfc5c](https://github.com/fgarofalo56/csa-inabox/commit/b5dfc5ceadd427d88c617096aadbab54b8428046))
* **fiab:** editor-doc generator — inline real learnContent steps, drop hardcoded host/count/v3.18 + 404 source links; regenerate ([215ccd8](https://github.com/fgarofalo56/csa-inabox/commit/215ccd866b5b6f40a749868f96df93409a9b43d9))
* **fiab:** Fabric IQ feature-parity gap analyses (ontology, graph-model, plan, map, data-agent, workshop-app, slate-app, ontology-sdk, health-check, release-environment, aip-logic) ([d60337c](https://github.com/fgarofalo56/csa-inabox/commit/d60337c0f7f5374fd4863ea5bcc3ddd19b6bb40c))
* **fiab:** mirror incremental CDC fixed + verified — all 12 tables mode:incremental ([e28ff08](https://github.com/fgarofalo56/csa-inabox/commit/e28ff0801fa0484124f69cad00843da35601a93d))
* **fiab:** overnight 2026-06-24 ledger — rev 65 live, data-product A-grade, loom-uat realFails=0 ([6d5288d](https://github.com/fgarofalo56/csa-inabox/commit/6d5288d9311f2e1097bb2feca46d9665e0939b9d))
* **fiab:** pipelines parity — Waves 1-5 built (coverage matrix + status), Wave 6 in flight ([c3725a5](https://github.com/fgarofalo56/csa-inabox/commit/c3725a51686c4ce7d91af0937425a8d00d17c13f))
* **fiab:** record pool-default-LA secret-safety decision (session-level emission is the secure path) ([80070af](https://github.com/fgarofalo56/csa-inabox/commit/80070af4b59f41596b3150e63120913a470c7657))
* **fiab:** report-builder backlog — all 9 waves shipped + ADX source live ([e434403](https://github.com/fgarofalo56/csa-inabox/commit/e43440305b9e4c42c3578f3600846efa12dc395b))
* **fiab:** sharing + endorsement + preview-as guide (security-feature doc) ([62136cb](https://github.com/fgarofalo56/csa-inabox/commit/62136cb84579298a70c59897c3be3ee8c8c024a3))
* **fiab:** spark-observability ledger — Databricks builder + Monitor→Spark + live LA-emission shipped ([848bb6a](https://github.com/fgarofalo56/csa-inabox/commit/848bb6ac0c23dc2f2351898375bc8b631739a041))
* **fiab:** supercharge [#83](https://github.com/fgarofalo56/csa-inabox/issues/83) — record live 43/43 medallion-green proof ([8a40507](https://github.com/fgarofalo56/csa-inabox/commit/8a405076e128b569f669eb2efd3c6c49df036d57))
* **fiab:** sync docs to shipped state (UC write surface, Fabric IQ 11, Azure Maps/AML env, Synapse IR, Purview managed-VNet, parity re-grades) ([7ef1774](https://github.com/fgarofalo56/csa-inabox/commit/7ef1774813bf1e7788dc2c21c9d31da89f01ac4d))
* **learn:** refresh stale tutorials to current UIs + author missing guides (audit [#2](https://github.com/fgarofalo56/csa-inabox/issues/2)) ([947a8cf](https://github.com/fgarofalo56/csa-inabox/commit/947a8cfee397249743415ccc3b1f0502eae38b24))
* **loom:** public-release readiness audit report + per-dimension details ([ac84072](https://github.com/fgarofalo56/csa-inabox/commit/ac84072ac8f31bac3830c6100b3cbeac86a6b211))
* **loom:** rewrite install path to the working deploy flow (B1 / A1) ([#1586](https://github.com/fgarofalo56/csa-inabox/issues/1586)) ([82fe9e3](https://github.com/fgarofalo56/csa-inabox/commit/82fe9e331b0f60ee1484963153116adff8cbf401))
* **loom:** truth console + root README to the shipped product (rel-T09) ([#1589](https://github.com/fgarofalo56/csa-inabox/issues/1589)) ([f96c1fb](https://github.com/fgarofalo56/csa-inabox/commit/f96c1fbeee42b0a3d2ae7ce9c1c292eda134ce91))
* **parity:** refresh stale coverage tables to match shipped Fabric IQ + RTI code ([46d6320](https://github.com/fgarofalo56/csa-inabox/commit/46d6320156378af34c57d730fa1871452ff764f5))
* **prp:** reword protection-policy acceptance — positive-grant allowlist, not 'Synapse DENY' ([e6545ce](https://github.com/fgarofalo56/csa-inabox/commit/e6545ce49d08ef0d39dc845e8d4c3adffba93e10))
* publish refreshed CSA Loom overview + Fabric IQ/RTI parity docs ([#1583](https://github.com/fgarofalo56/csa-inabox/issues/1583)) ([a2f6387](https://github.com/fgarofalo56/csa-inabox/commit/a2f638718a8663bfe7cdca8b22129fc64674aa00))
* refresh stale overview + CSA Loom capability pages to current platform state ([5b8e795](https://github.com/fgarofalo56/csa-inabox/commit/5b8e795f6b82d4d72f59d476114b119311db6aa9))


### Continuous Integration

* **csa-loom:** targeted Delta Sharing metastore grant workflow (deploy SP grants UAMI CREATE SHARE/RECIPIENT/PROVIDER) ([2647afe](https://github.com/fgarofalo56/csa-inabox/commit/2647afef5a1db9b955d50d966ab2ad952e706afa))
* **loom:** guardrail checks — env-sync + route-guards + no-freeform + bicep-sync (merge-blockers) ([8b1aaf1](https://github.com/fgarofalo56/csa-inabox/commit/8b1aaf134d1d7a7f04356a03af41d3719a44bc9c))


### Miscellaneous

* **bicep:** EH Phase-1 — LOOM_PDP_ENFORCE=off in admin-plane env (no-vaporware bicep-sync) ([774ea7d](https://github.com/fgarofalo56/csa-inabox/commit/774ea7d8e6efd1ef959020d87bd480430e9da599))
* **csa-loom:** bump loom-uat replicaTimeout to 7200s (full-install suite runs longer post-[#1561](https://github.com/fgarofalo56/csa-inabox/issues/1561)) ([#1563](https://github.com/fgarofalo56/csa-inabox/issues/1563)) ([23b7cb2](https://github.com/fgarofalo56/csa-inabox/commit/23b7cb238adbdd0ee6d036c0fa39163016102b24))
* **csa-loom:** wire UAT_GREP_INVERT into loom-uat job env ([#1564](https://github.com/fgarofalo56/csa-inabox/issues/1564)) ([#1565](https://github.com/fgarofalo56/csa-inabox/issues/1565)) ([76a4eeb](https://github.com/fgarofalo56/csa-inabox/commit/76a4eeb8a891d3edff32580a1541cefcc1dc5ac7))
* **deps-dev:** Bump the azure-sdk group across 1 directory with 2 updates ([#1584](https://github.com/fgarofalo56/csa-inabox/issues/1584)) ([5224a60](https://github.com/fgarofalo56/csa-inabox/commit/5224a60f0de602095094fa92ed20793c7a864bec))
* **deps-dev:** Update pydantic-ai requirement ([#1580](https://github.com/fgarofalo56/csa-inabox/issues/1580)) ([d7e77e0](https://github.com/fgarofalo56/csa-inabox/commit/d7e77e04c4cf43945f5671e99019cb47c338cb1b))
* **deps-dev:** Update redis requirement ([#1581](https://github.com/fgarofalo56/csa-inabox/issues/1581)) ([8eac064](https://github.com/fgarofalo56/csa-inabox/commit/8eac0643677dc3c83456fc351491ddb262fc3a2b))
* **fiab-console:** TEMP diag logs for mirror wizard dialog-stuck bug (revert after trace) ([bcadbc8](https://github.com/fgarofalo56/csa-inabox/commit/bcadbc83351bdd9f858e14a658b247eed508d858))
* **fiab:** EH Phase-0 madge circular-dep guard + fix the split's barrel↔paginated-report cycle ([bea942b](https://github.com/fgarofalo56/csa-inabox/commit/bea942bb0d919be5bf6343b077d2f90451054965))
* **fiab:** supercharge notebook importer updates ([#83](https://github.com/fgarofalo56/csa-inabox/issues/83) tooling) ([b3c2ba7](https://github.com/fgarofalo56/csa-inabox/commit/b3c2ba702552c33dc07055d004acd5a66e387ab8))
* **loom,security:** scrub operator identifiers for public release ([a8c1e44](https://github.com/fgarofalo56/csa-inabox/commit/a8c1e443e5155ba65285a72b99092abba4e44475))
* **loom:** command-palette full nav coverage + remove data-science-home dead code + slate widget-kind union ([152719a](https://github.com/fgarofalo56/csa-inabox/commit/152719a28ff28fe88df17cc9419fa83351077a8c))
* **loom:** datamart deprecation banner + Labs flag for novelty editors + docs archive/link cleanup ([8654dd6](https://github.com/fgarofalo56/csa-inabox/commit/8654dd6e77a4180e148b42853ed3a08ebcc83ad5))

## [0.49.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.48.2...csa-inabox-v0.49.0) (2026-06-20)


### Features

* **fiab-console/uat:** blob results upload + real-vs-infra-gate verdict separation ([#1555](https://github.com/fgarofalo56/csa-inabox/issues/1555)) ([e77bc61](https://github.com/fgarofalo56/csa-inabox/commit/e77bc61fb36ec5b178bebcd3cf3123428b41adcc))
* **fiab-console:** geo-dataset format auto-detect + KQL dashboard tile CSV/clipboard export ([#1552](https://github.com/fgarofalo56/csa-inabox/issues/1552)) ([75862b0](https://github.com/fgarofalo56/csa-inabox/commit/75862b0f318d73ff5f68163ef70aa57191aab516))


### Bug Fixes

* **fiab-console/apps:** every use-case app installs — derive GLOBAL seed from the bundle registry ([#1553](https://github.com/fgarofalo56/csa-inabox/issues/1553)) ([1d90bb8](https://github.com/fgarofalo56/csa-inabox/commit/1d90bb897dc642e481fe13d343bec56b5b141cca))
* **fiab-console:** A+ claims-vs-reality — honest comments + Warp badge + UAT count ([#1551](https://github.com/fgarofalo56/csa-inabox/issues/1551)) ([09656fb](https://github.com/fgarofalo56/csa-inabox/commit/09656fbb5983e383209db43dcbd8be0d379b7f60))
* **fiab-console:** A+ UI polish — lineage panel responsiveness, catalog request tracking, warp inspector flex, DAX field ([#1550](https://github.com/fgarofalo56/csa-inabox/issues/1550)) ([5effbd9](https://github.com/fgarofalo56/csa-inabox/commit/5effbd95b8081f18b9f58a789374698a08f378ca))

## [0.48.2](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.48.1...csa-inabox-v0.48.2) (2026-06-20)


### Bug Fixes

* **csa-loom:** loom-uat deploy — define job secret + temp-strip e2e from .dockerignore ([#1545](https://github.com/fgarofalo56/csa-inabox/issues/1545)) ([f26a84d](https://github.com/fgarofalo56/csa-inabox/commit/f26a84d12b34203c148c6425a02c158f96d0036a))


### Code Refactoring

* **fiab-console:** extract network-free AAS XMLA helpers into aas-tmsl.ts (Closes [#1503](https://github.com/fgarofalo56/csa-inabox/issues/1503)) ([#1544](https://github.com/fgarofalo56/csa-inabox/issues/1544)) ([61e3225](https://github.com/fgarofalo56/csa-inabox/commit/61e3225fa58ea3832bea1730e9801abc0e02631c))


### Tests

* **fiab-console:** fix no-cuts-sweep-v3 synapse-pipeline button label drift ([#1547](https://github.com/fgarofalo56/csa-inabox/issues/1547)) ([7bb289b](https://github.com/fgarofalo56/csa-inabox/commit/7bb289be56c71c49843eab84cbb7a73ca967fd62)), closes [#1546](https://github.com/fgarofalo56/csa-inabox/issues/1546)
* **fiab-console:** fix UAT test-side drift in admin-scaling + catalog specs ([#1548](https://github.com/fgarofalo56/csa-inabox/issues/1548)) ([23c8333](https://github.com/fgarofalo56/csa-inabox/commit/23c8333e825d03067e5f5912ca8e7d50f355059f)), closes [#1546](https://github.com/fgarofalo56/csa-inabox/issues/1546)


### Miscellaneous

* **deps-dev:** Bump @types/node in /portal/react-webapp ([#1526](https://github.com/fgarofalo56/csa-inabox/issues/1526)) ([8fca9ee](https://github.com/fgarofalo56/csa-inabox/commit/8fca9ee5453e1525bf9614d03e152bf22c9dd52e))
* **deps-dev:** Update pathspec requirement ([#1530](https://github.com/fgarofalo56/csa-inabox/issues/1530)) ([72a2a61](https://github.com/fgarofalo56/csa-inabox/commit/72a2a616e25e76be478a2f96ed884ec15cc880b7))
* **deps:** Bump @azure/msal-browser in /portal/react-webapp ([#1524](https://github.com/fgarofalo56/csa-inabox/issues/1524)) ([cbdd243](https://github.com/fgarofalo56/csa-inabox/commit/cbdd2436ab46567022fabf79678a4496fd356161))
* **deps:** Bump @azure/msal-react in /portal/react-webapp ([#1522](https://github.com/fgarofalo56/csa-inabox/issues/1522)) ([52f9ed5](https://github.com/fgarofalo56/csa-inabox/commit/52f9ed563666a3ee8a32ce4df1bd3154431d9b4d))
* **deps:** Bump @radix-ui/react-dialog in /portal/react-webapp ([#1529](https://github.com/fgarofalo56/csa-inabox/issues/1529)) ([245bed3](https://github.com/fgarofalo56/csa-inabox/commit/245bed3847062401abdb93c928ba833493afb65f))
* **deps:** Bump @radix-ui/react-dropdown-menu in /portal/react-webapp ([#1521](https://github.com/fgarofalo56/csa-inabox/issues/1521)) ([2e46b63](https://github.com/fgarofalo56/csa-inabox/commit/2e46b6382dca242eaa81ec07c07a5c3c3c6f2169))
* **deps:** Bump @radix-ui/react-select in /portal/react-webapp ([#1523](https://github.com/fgarofalo56/csa-inabox/issues/1523)) ([12b57a8](https://github.com/fgarofalo56/csa-inabox/commit/12b57a829d6cd89e2f21c352e8a47af0b9679f63))
* **deps:** Bump @radix-ui/react-tabs in /portal/react-webapp ([#1528](https://github.com/fgarofalo56/csa-inabox/issues/1528)) ([1935871](https://github.com/fgarofalo56/csa-inabox/commit/19358711b37c156be9f5e5a4b2cfe110ff910324))
* **deps:** Bump axios from 1.17.0 to 1.18.0 in /portal/react-webapp ([#1525](https://github.com/fgarofalo56/csa-inabox/issues/1525)) ([5d30ecf](https://github.com/fgarofalo56/csa-inabox/commit/5d30ecf30756b55a73f22ae51febacca53d05a9d))
* **deps:** Bump react-hook-form in /portal/react-webapp ([#1527](https://github.com/fgarofalo56/csa-inabox/issues/1527)) ([5ac5b64](https://github.com/fgarofalo56/csa-inabox/commit/5ac5b64c459dff7dc8413359640078a6d0fb1366))

## [0.48.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.48.0...csa-inabox-v0.48.1) (2026-06-19)


### Bug Fixes

* **fiab-console/setup:** wizard can toggle eventhubs + streamanalytics (parity with CLI/bicep) ([#1540](https://github.com/fgarofalo56/csa-inabox/issues/1540)) ([c99562b](https://github.com/fgarofalo56/csa-inabox/commit/c99562b9a6958844646addf656aaadd89c8d439a)), closes [#1532](https://github.com/fgarofalo56/csa-inabox/issues/1532)
* **fiab-console:** make App Config AAD token scope endpoint-aware ([#1531](https://github.com/fgarofalo56/csa-inabox/issues/1531)) ([#1539](https://github.com/fgarofalo56/csa-inabox/issues/1539)) ([78f0609](https://github.com/fgarofalo56/csa-inabox/commit/78f0609362f1708ca65881619338ac012da83026))

## [0.48.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.47.0...csa-inabox-v0.48.0) (2026-06-19)


### Features

* **csa-loom:** in-VNet loom-verify Container App Job for unattended console verification ([#1533](https://github.com/fgarofalo56/csa-inabox/issues/1533)) ([9ccc3d1](https://github.com/fgarofalo56/csa-inabox/commit/9ccc3d181eed7d29198a7f3fce3bdbab7cc905bf))
* **fiab-console/e2e:** unattended in-VNet full-visual Playwright UAT runner ([#1536](https://github.com/fgarofalo56/csa-inabox/issues/1536)) ([2e25872](https://github.com/fgarofalo56/csa-inabox/commit/2e25872ac045bb54d709b85adc719ce45988c3bd))


### Bug Fixes

* **csa-loom:** loom-uat build — include e2e (per-Dockerfile ignore), no-frozen-lockfile, --no-logs ([#1541](https://github.com/fgarofalo56/csa-inabox/issues/1541)) ([ba9a3f9](https://github.com/fgarofalo56/csa-inabox/commit/ba9a3f90517bf88f7a991c85697192d549de5c25))
* **csa-loom:** loom-uat deploy — az acr build needs relative context (Windows az) ([#1537](https://github.com/fgarofalo56/csa-inabox/issues/1537)) ([8876d27](https://github.com/fgarofalo56/csa-inabox/commit/8876d2728b4676ac6ab3598807e6cbdeea976922))
* **csa-loom:** loom-uat Dockerfile install pnpm via npm (corepack keyid bug) ([#1538](https://github.com/fgarofalo56/csa-inabox/issues/1538)) ([3cc5064](https://github.com/fgarofalo56/csa-inabox/commit/3cc50647d4a0b21b0a38f76c10740133dbc5254d))

## [0.47.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.46.0...csa-inabox-v0.47.0) (2026-06-19)


### Features

* **content-safety:** wire real RAI-policy + custom-blocklist management ([#1517](https://github.com/fgarofalo56/csa-inabox/issues/1517)) ([b3c4c04](https://github.com/fgarofalo56/csa-inabox/commit/b3c4c044a2aeb23cb9c91d162f4c3adda964e99c)), closes [#1410](https://github.com/fgarofalo56/csa-inabox/issues/1410)
* **fiab-console/e2e:** unattended console verify harness (SESSION_SECRET mint, no MFA) ([#1520](https://github.com/fgarofalo56/csa-inabox/issues/1520)) ([11dcf3c](https://github.com/fgarofalo56/csa-inabox/commit/11dcf3c4ff0657b947ea0b945d44bb8e54d3e390))


### Bug Fixes

* **csa-loom:** Purview Data Map grant jq matched wrong rule id (endswith→startswith) ([#1513](https://github.com/fgarofalo56/csa-inabox/issues/1513)) ([ffbab36](https://github.com/fgarofalo56/csa-inabox/commit/ffbab36d4a921bcb2b77422c5ce7afbfd56aa709))
* **csa-loom:** Purview self-toggle poll must not treat PE-403 as reachable ([#1518](https://github.com/fgarofalo56/csa-inabox/issues/1518)) ([06eff16](https://github.com/fgarofalo56/csa-inabox/commit/06eff1696a99469a4d7a9d2866cb8f7b8d9d82ef))
* **fiab-console:** green long-tail vitest failures ([#1504](https://github.com/fgarofalo56/csa-inabox/issues/1504)) ([#1519](https://github.com/fgarofalo56/csa-inabox/issues/1519)) ([3c668e0](https://github.com/fgarofalo56/csa-inabox/commit/3c668e0a463f1e7a3cb601d412ec4374089d693c))


### Documentation

* **fiab/audit:** day-one gap-closure plan (zero setup gates) ([#1450](https://github.com/fgarofalo56/csa-inabox/issues/1450)) ([c904cfc](https://github.com/fgarofalo56/csa-inabox/commit/c904cfc5c0375a2608301c906ae09e5bc83820a0))

## [0.46.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.45.0...csa-inabox-v0.46.0) (2026-06-19)


### Features

* **deploy-planner:** cost respects configured SKUs + configurable high-variance services ([#1509](https://github.com/fgarofalo56/csa-inabox/issues/1509)) ([a92a9c8](https://github.com/fgarofalo56/csa-inabox/commit/a92a9c834f625d8451afedc74cfd10ac5dcc31d8))
* **fiab-console:** A+ polish — LoomDataTable z-index/aria-live/skeleton + tokenized EmptyState + adopt on key tables ([#1493](https://github.com/fgarofalo56/csa-inabox/issues/1493)) ([d9972ce](https://github.com/fgarofalo56/csa-inabox/commit/d9972ce226f9ab399c8a1eb61fd04de69eea92b6))
* **fiab-console:** auto-set least-privilege RBAC when attaching a Data Landing Zone ([#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)) ([#1473](https://github.com/fgarofalo56/csa-inabox/issues/1473)) ([0b9e051](https://github.com/fgarofalo56/csa-inabox/commit/0b9e051369c25ae55725c1a2d0dc576cc1fc5d9e))
* **fiab-console:** deploy-planner per-resource config inspector + config-aware bicep export ([#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)) ([#1484](https://github.com/fgarofalo56/csa-inabox/issues/1484)) ([55af24e](https://github.com/fgarofalo56/csa-inabox/commit/55af24efedb9ca6133bca99d0daf6fe149a9e5fe))
* **fiab-console:** expand Health & self-audit to validate all new surfaces + data-plane day-one config ([#1490](https://github.com/fgarofalo56/csa-inabox/issues/1490)) ([7178e62](https://github.com/fgarofalo56/csa-inabox/commit/7178e62c5522d0bcb7b30f7e0f57f09a80395911))
* **fiab-console:** full Purview Atlas lineage write (createAtlasLineage + GUID write-back + richer typeNames + Thread edge emit) ([#1510](https://github.com/fgarofalo56/csa-inabox/issues/1510)) ([b1065a1](https://github.com/fgarofalo56/csa-inabox/commit/b1065a1b02294dfc237c7ab6b541da6f819e9129))
* **fiab-console:** Learning Hub overhaul — Knowledge-Center gallery + import-with-sample-data wizard + Learning Hub Copilot ([#1488](https://github.com/fgarofalo56/csa-inabox/issues/1488)) ([1520cee](https://github.com/fgarofalo56/csa-inabox/commit/1520cee345846f86c3eefc0944fd6f3e8dcb92a9)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** MCP Servers catalog as a first-class admin page + nav entry ([#1485](https://github.com/fgarofalo56/csa-inabox/issues/1485)) ([dfe2728](https://github.com/fgarofalo56/csa-inabox/commit/dfe27285c0ea9553938fa40899f998c42d5efeda)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** Organizational Visuals — per-template icons + real-data binding + Loom-native visual builder ([#1486](https://github.com/fgarofalo56/csa-inabox/issues/1486)) ([6cc5a83](https://github.com/fgarofalo56/csa-inabox/commit/6cc5a833563b6e312218fde33602ad4adc060958))
* **fiab-console:** shared LearnPopover + SectionExplainer primitives, adopt on 7 surfaces (epic [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)) ([#1495](https://github.com/fgarofalo56/csa-inabox/issues/1495)) ([28daea3](https://github.com/fgarofalo56/csa-inabox/commit/28daea3abad34d5d44e712dd83514687b883afec))
* **fiab-console:** themed pre-built domains + Federal Civilian agency domain library in Create-new-domain ([#1481](https://github.com/fgarofalo56/csa-inabox/issues/1481)) ([262d463](https://github.com/fgarofalo56/csa-inabox/commit/262d4635b6c4703d8de4778d3979b077e837032c)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** W4 EmptyState adoption + W3 tree/cell skeletons ([#1498](https://github.com/fgarofalo56/csa-inabox/issues/1498)) ([065bd0d](https://github.com/fgarofalo56/csa-inabox/commit/065bd0d7d1feffd81a1ee3286b03c6830478421b))
* **fiab-console:** W7 — sort affordance + aria-sort on LoomDataTable ([#1497](https://github.com/fgarofalo56/csa-inabox/issues/1497)) ([d65bbd0](https://github.com/fgarofalo56/csa-inabox/commit/d65bbd0a97c11c690be1185d6f726a804655283e))
* **fiab-console:** Warp — editable visual transform canvas + starter wizards (compiles/runs on Azure-native engines) ([#1487](https://github.com/fgarofalo56/csa-inabox/issues/1487)) ([8d19e69](https://github.com/fgarofalo56/csa-inabox/commit/8d19e69705cd0bf9ce3af2c6221d33a532a60265))
* **fiab-console:** Wave-2 day-one config — 40/40 runtime config, default Monitor alerts, MIP default-on ([#1476](https://github.com/fgarofalo56/csa-inabox/issues/1476)) ([c2b8b52](https://github.com/fgarofalo56/csa-inabox/commit/c2b8b527cac8ce1dc54daeda4fe70735cce35a6e))
* **fiab:** day-one scripting — DLP Graph roles + flags + SCC sidecar, Databricks Private Link ([#1491](https://github.com/fgarofalo56/csa-inabox/issues/1491)) ([cb0a2c2](https://github.com/fgarofalo56/csa-inabox/commit/cb0a2c28a1f9ce75b1e30ba3fdcfd66b2eabf8c4))


### Bug Fixes

* **bootstrap:** day-one UAMI resolution, Purview PE-toggle, MG Reader + prereqs doc ([#1512](https://github.com/fgarofalo56/csa-inabox/issues/1512)) ([ecb01bf](https://github.com/fgarofalo56/csa-inabox/commit/ecb01bfe1c155a9da2c2bbe1ed2c98d1d820d8f8))
* **fiab-bootstrap:** Foundry AIServices role grant (not AzureML) + Databricks UC account config day-one ([#1492](https://github.com/fgarofalo56/csa-inabox/issues/1492)) ([093db53](https://github.com/fgarofalo56/csa-inabox/commit/093db53a5adeaf728ebc52b516e6eaaca932ccdb))
* **fiab-console:** connections auth-method picker + DSPM empty-state + AML compute gate clarity ([#1511](https://github.com/fgarofalo56/csa-inabox/issues/1511)) ([818c623](https://github.com/fgarofalo56/csa-inabox/commit/818c623126a3c82307347435845a8981cdf72579))
* **fiab-console:** Copilot/Agents linked day-one + External MCP connect actually works (Streamable HTTP) ([#1475](https://github.com/fgarofalo56/csa-inabox/issues/1475)) ([4ec3497](https://github.com/fgarofalo56/csa-inabox/commit/4ec349725d97b51fa075d8daed46359627e4eee3))
* **fiab-console:** domains list no longer blocks on the Purview mirror probe (6s timeout regression) ([#1482](https://github.com/fgarofalo56/csa-inabox/issues/1482)) ([2b2e3e2](https://github.com/fgarofalo56/csa-inabox/commit/2b2e3e20619a4b0eb56e6f81ad45bc355fc23757)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** honest Purview Data Map role gate on /admin/domains (Wave 1) ([#1472](https://github.com/fgarofalo56/csa-inabox/issues/1472)) ([72bbde0](https://github.com/fgarofalo56/csa-inabox/commit/72bbde01603d46ea6028c391754748023df4ef3a))
* **fiab-console:** landing-zone map renders (React-Flow container sizing / fitView) ([#1477](https://github.com/fgarofalo56/csa-inabox/issues/1477)) ([8933e51](https://github.com/fgarofalo56/csa-inabox/commit/8933e51f73f0e5e793d8feeb4f7c06dac5f8f364)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** landing-zone re-attach check uses GET for Microsoft.Authorization/permissions (multi-sub false "only Reader") ([#1465](https://github.com/fgarofalo56/csa-inabox/issues/1465)) ([c2ada61](https://github.com/fgarofalo56/csa-inabox/commit/c2ada613ffb3fa5771c925d5133204ccedd8e7f7))
* **fiab-console:** network topology canvas — per-subnet columns, computed DNS Y, dots bg, readable fonts ([#1507](https://github.com/fgarofalo56/csa-inabox/issues/1507)) ([447f63f](https://github.com/fgarofalo56/csa-inabox/commit/447f63f5de00591ead07f5dc33841a62a85ffd09))
* **fiab-console:** network topology graph renders (React-Flow sizing/fitView) ([#1480](https://github.com/fgarofalo56/csa-inabox/issues/1480)) ([415ac01](https://github.com/fgarofalo56/csa-inabox/commit/415ac01e4d743e64c6894f9689f4a14d47c386ab)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** repair Vitest test-infra (providers, mocks, env, timeouts) ([#1502](https://github.com/fgarofalo56/csa-inabox/issues/1502)) ([1960c8d](https://github.com/fgarofalo56/csa-inabox/commit/1960c8dffeb03188c13028a4adabc933e380418a))
* **fiab-console:** restyle governance pages to Web 3.0 design system + policies Cosmos gate ([#1508](https://github.com/fgarofalo56/csa-inabox/issues/1508)) ([eddeb98](https://github.com/fgarofalo56/csa-inabox/commit/eddeb98eb9ccf918a25a303398fa183de60e49c4))
* **fiab-console:** Wave 1 — multi-sub RG/subscription resolution, AbortError relabel, Activities/Activity-log LAW queries ([#1471](https://github.com/fgarofalo56/csa-inabox/issues/1471)) ([8b580f2](https://github.com/fgarofalo56/csa-inabox/commit/8b580f2cfb721f8bc23354f2b5bd63dbf8f9014a))
* **fiab-console:** wire all API Management CRUD buttons (dead-button day-one blocker) ([#1489](https://github.com/fgarofalo56/csa-inabox/issues/1489)) ([c2431ce](https://github.com/fgarofalo56/csa-inabox/commit/c2431ced33732aa9cbf86d6bfadc9725e9890af8)), closes [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)
* **fiab-console:** wire APIM admin Backends + Policies + Developer portal tabs ([#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)) ([#1474](https://github.com/fgarofalo56/csa-inabox/issues/1474)) ([c78e77a](https://github.com/fgarofalo56/csa-inabox/commit/c78e77a3ea0f43fbc6134db8bd4752cf8f9ca116))
* **fiab:** day-one config round-2 — DLP Graph Security roles + AI Search governance index + posture-refresh function ([#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)) ([#1478](https://github.com/fgarofalo56/csa-inabox/issues/1478)) ([029c070](https://github.com/fgarofalo56/csa-inabox/commit/029c0706ae0e50f19f5e514641c6c230455944b8))
* **fiab:** MSAL console secret as Key Vault reference so bootstrap rotations stop breaking login (AADSTS7000215) ([#1479](https://github.com/fgarofalo56/csa-inabox/issues/1479)) ([c2de651](https://github.com/fgarofalo56/csa-inabox/commit/c2de65103f68b21c6012142ae176ad3a1d40c45a))


### Documentation

* **fiab/audit:** day-one validation scorecard + A+ polish backlog (post-roll sweep) ([#1500](https://github.com/fgarofalo56/csa-inabox/issues/1500)) ([3e60ddb](https://github.com/fgarofalo56/csa-inabox/commit/3e60ddb82e668bbee22459732a745064cdd57072))


### Tests

* **fiab-console:** fix cluster-A stale vitest expectations (5 files) ([#1506](https://github.com/fgarofalo56/csa-inabox/issues/1506)) ([064db25](https://github.com/fgarofalo56/csa-inabox/commit/064db25eef490b593c32640087224b66ebf40e16))
* **fiab-console:** fix TestingLibraryElementError found-multiple-elements in 9 render tests (closes [#1504](https://github.com/fgarofalo56/csa-inabox/issues/1504), epic [#1470](https://github.com/fgarofalo56/csa-inabox/issues/1470)) ([#1505](https://github.com/fgarofalo56/csa-inabox/issues/1505)) ([eb14b71](https://github.com/fgarofalo56/csa-inabox/commit/eb14b710bffb5015e0e786126fda222c7d2a7eb1))

## [0.45.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.44.0...csa-inabox-v0.45.0) (2026-06-18)


### Features

* **fiab-console:** cluster-aware IntelliSense + syntax + Copilot (Databricks / Synapse Spark / Azure ML) ([#1451](https://github.com/fgarofalo56/csa-inabox/issues/1451)) ([28b15b7](https://github.com/fgarofalo56/csa-inabox/commit/28b15b7d7583852579771ffcce142f506e44b987))
* **fiab:** day-one Grafana Govern/Usage embed dashboards (auto-create + default KIND=grafana) ([#1461](https://github.com/fgarofalo56/csa-inabox/issues/1461)) ([6a6ce52](https://github.com/fgarofalo56/csa-inabox/commit/6a6ce5272b31381a3831a1877bcbad6933c3ef0e))


### Bug Fixes

* **bicep+bootstrap:** day-one deploy-time RBAC + service bootstraps (zero permission gates) ([#1453](https://github.com/fgarofalo56/csa-inabox/issues/1453)) ([1c81685](https://github.com/fgarofalo56/csa-inabox/commit/1c81685a3e8ebeca1c5d52a3563fdf381f5540af))
* **bicep:** admin-portal day-one defaults (AOAI model+endpoint, tenant-admin OID, org-visuals env) ([#1458](https://github.com/fgarofalo56/csa-inabox/issues/1458)) ([e1f14cd](https://github.com/fgarofalo56/csa-inabox/commit/e1f14cdbd2bf81c9bb0a9bb84ac855ccb0b6c7e5))
* **bicep:** day-one clean-deploy hardening (APIM create+policy, appImageTags, FD privatelink) ([#1438](https://github.com/fgarofalo56/csa-inabox/issues/1438)) ([25b69a8](https://github.com/fgarofalo56/csa-inabox/commit/25b69a8ae03128873644a3707aed2241f2dc7a85))
* **bicep:** day-one clean-deploy integration ([#1440](https://github.com/fgarofalo56/csa-inabox/issues/1440) + [#1441](https://github.com/fgarofalo56/csa-inabox/issues/1441) + [#1442](https://github.com/fgarofalo56/csa-inabox/issues/1442) + [#1444](https://github.com/fgarofalo56/csa-inabox/issues/1444)) ([#1446](https://github.com/fgarofalo56/csa-inabox/issues/1446)) ([d6a9a2a](https://github.com/fgarofalo56/csa-inabox/commit/d6a9a2adc8971e2ad3515a8ce65cbe4134ff012f))
* **bicep:** day-one deploy errors in newly-enabled modules ([#1454](https://github.com/fgarofalo56/csa-inabox/issues/1454)) ([65c054f](https://github.com/fgarofalo56/csa-inabox/commit/65c054f0da62f0ceff2b35a74494717317f2be39))
* **bicep:** day-one gap closure — enable Azure-native services by default (zero setup gates) ([#1452](https://github.com/fgarofalo56/csa-inabox/issues/1452)) ([c79990e](https://github.com/fgarofalo56/csa-inabox/commit/c79990e92f5773f48f1ac1f789c41fc53b273357))
* **bicep:** day-one hardening of dormant modules (Maps MI, Purview managed-EH, Foundry project account, AAS Reader dedup + idempotent role GUIDs) ([#1456](https://github.com/fgarofalo56/csa-inabox/issues/1456)) ([1b32c2c](https://github.com/fgarofalo56/csa-inabox/commit/1b32c2c6cc0be6c4a4557441148cfc2b9b6b74d3))
* **bicep:** day-one hub deploy round-2 (AAS SKU, firewall policy ordering, duplicate RBAC-admin assignment) ([#1455](https://github.com/fgarofalo56/csa-inabox/issues/1455)) ([ab2560a](https://github.com/fgarofalo56/csa-inabox/commit/ab2560a0b22f46911e0d957c21adb30bafcd7711))
* **csa-loom:** wire LOOM_MSAL_CLIENT_SECRET env + open KV for bootstrap secret write ([#1439](https://github.com/fgarofalo56/csa-inabox/issues/1439)) ([927b68c](https://github.com/fgarofalo56/csa-inabox/commit/927b68c8a59e5dfd622f98a46c3ed5b6f85803a7))
* **deploy:** cross-sub dlz-attach hub-coordinates + region-parameterize post-deploy-bootstrap ([#1457](https://github.com/fgarofalo56/csa-inabox/issues/1457)) ([1017e73](https://github.com/fgarofalo56/csa-inabox/commit/1017e73940ded86dc2d0caf71c381ab04ade76f1))
* **fiab-bootstrap:** MSAL app-reg must stay confidential + register Front Door redirect (login-breaking) ([#1463](https://github.com/fgarofalo56/csa-inabox/issues/1463)) ([7f89715](https://github.com/fgarofalo56/csa-inabox/commit/7f89715920ad328d2ccb7d2a33ce852181a7ea98))
* **fiab-console:** admin-portal day-one gaps — multi-sub capacity, audit query bugs, version-compare, env-config criticality, bicep env completeness ([#1462](https://github.com/fgarofalo56/csa-inabox/issues/1462)) ([1facf66](https://github.com/fgarofalo56/csa-inabox/commit/1facf6626518a4e7c259d265bd462311f4f44b84))
* **fiab-console:** admin-portal round 2 — audit Purview/LAW queries, version-compare display, landing-zone RG-scope RBAC check ([#1464](https://github.com/fgarofalo56/csa-inabox/issues/1464)) ([3fcbc50](https://github.com/fgarofalo56/csa-inabox/commit/3fcbc5002294f358af5623833b9c1f3eb052ff6d))
* **fiab-console:** dedicated-SQL seed query — SUSER_NAME() unsupported on Synapse Dedicated pool ([#1448](https://github.com/fgarofalo56/csa-inabox/issues/1448)) ([78384f8](https://github.com/fgarofalo56/csa-inabox/commit/78384f83bd8a885aa690ba79efbb274fe0c6d476))
* **fiab-console:** generalize DLZ ARM coordinate self-heal (Resource Graph) to Kusto + others ([#1447](https://github.com/fgarofalo56/csa-inabox/issues/1447)) ([94daabb](https://github.com/fgarofalo56/csa-inabox/commit/94daabbe947f46a5751901ee1117aa132d98b810))
* **fiab-console:** serverless-SQL external data source — master key + per-step diagnosis ([#1437](https://github.com/fgarofalo56/csa-inabox/issues/1437)) ([b8ccd38](https://github.com/fgarofalo56/csa-inabox/commit/b8ccd38139501adc8f6aeb12c9a24b816c86de0d))
* **fiab-console:** warehouse status probe (false "Unknown") + Alerts dialog auto-open/no-close ([#1445](https://github.com/fgarofalo56/csa-inabox/issues/1445)) ([c19c549](https://github.com/fgarofalo56/csa-inabox/commit/c19c54955c7315dc9fca04294fb2662682ce1c0d))
* **fiab-deploy:** DLZ deploymentScripts use key-auth staging storage ([#1460](https://github.com/fgarofalo56/csa-inabox/issues/1460)) ([b67abd9](https://github.com/fgarofalo56/csa-inabox/commit/b67abd9375a5b3d0fd29bd98f3795f070c084b01))


### Documentation

* **fiab/audit:** post-roll sweep — Warehouse fixes confirmed live + RAG Builder + image roll ([#1449](https://github.com/fgarofalo56/csa-inabox/issues/1449)) ([b82555e](https://github.com/fgarofalo56/csa-inabox/commit/b82555e88da272d695cf839938b26456e67a2e43))
* **fiab/audit:** serverless-SQL endpoint now PASS (Synapse SQL Administrator RBAC fix) ([#1443](https://github.com/fgarofalo56/csa-inabox/issues/1443)) ([a3bd22e](https://github.com/fgarofalo56/csa-inabox/commit/a3bd22ea095794a318bed6c912c4fcedf1d6bc61))
* **fiab/audit:** validation matrix — P0 datasets PASS (v0.11 live), serverless-SQL FAIL ([#1435](https://github.com/fgarofalo56/csa-inabox/issues/1435)) ([2962217](https://github.com/fgarofalo56/csa-inabox/commit/2962217256b9be8dc7b5a740a990d73c88877f4c))

## [0.44.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.43.1...csa-inabox-v0.44.0) (2026-06-16)


### Features

* **fiab-console:** in-product no-clone update path (Admin &gt; Updates rolls Container Apps to ghcr release images) ([#1426](https://github.com/fgarofalo56/csa-inabox/issues/1426)) ([8d34d8f](https://github.com/fgarofalo56/csa-inabox/commit/8d34d8f51b826cac19be2ddf33a389e02813961a))
* **fiab:** make honest-gated runtime services default-on (DAB, dbt, Weave PG, EH receive, activator table) ([#1424](https://github.com/fgarofalo56/csa-inabox/issues/1424)) ([dd80091](https://github.com/fgarofalo56/csa-inabox/commit/dd80091b935d48d24aec3481be13bbada151a82a))


### Bug Fixes

* **fiab-console:** app-bundle datasets — real, repo-hosted, loaded (no vaporware) ([#1433](https://github.com/fgarofalo56/csa-inabox/issues/1433)) ([f1c06b6](https://github.com/fgarofalo56/csa-inabox/commit/f1c06b6fa0701c19fba1b51484e30bf7935f39ba))
* **fiab-console:** cap AutoML max-concurrent-trials at the cluster's node count ([#1432](https://github.com/fgarofalo56/csa-inabox/issues/1432)) ([290c771](https://github.com/fgarofalo56/csa-inabox/commit/290c771ac8e5736860602532b26fb8472527f72d))
* **fiab-console:** Copilot Studio family honesty — H1 schema / H2 channel gate / H3 analytics / H4 structured topic editor ([#1421](https://github.com/fgarofalo56/csa-inabox/issues/1421)) ([d637537](https://github.com/fgarofalo56/csa-inabox/commit/d637537e5fa7f07b6e7aec14ef40e9ac0373e6eb))
* **fiab-console:** DLZ setup-wizard UX + landing-zone overview/visualize + cross-sub deploy pre-flight ([#1428](https://github.com/fgarofalo56/csa-inabox/issues/1428)) ([f8abbca](https://github.com/fgarofalo56/csa-inabox/commit/f8abbcaff21963e063078e8ca12f46f277580a11))
* **fiab-console:** make map real (binding + layers) + mirrored-databricks an actual mirror (H7/H8) ([#1422](https://github.com/fgarofalo56/csa-inabox/issues/1422)) ([f1199ee](https://github.com/fgarofalo56/csa-inabox/commit/f1199ee22f6de8a039302266cbd2d6ba99edda95))
* **fiab-console:** ship app-bundle sample datasets inside the console image ([#1434](https://github.com/fgarofalo56/csa-inabox/issues/1434)) ([aef51e1](https://github.com/fgarofalo56/csa-inabox/commit/aef51e11246253291697d3e8c7ea9a13aa944cf5))
* **fiab-console:** shortcut parser accepts blob.core.windows.net + onelake:// URIs ([#1429](https://github.com/fgarofalo56/csa-inabox/issues/1429)) ([af8b71d](https://github.com/fgarofalo56/csa-inabox/commit/af8b71db49517b7389014e3201b4a86c4b387946))


### Documentation

* **fiab/audit:** persist E2E audit reports + live UI findings tracker ([#1427](https://github.com/fgarofalo56/csa-inabox/issues/1427)) ([e1ddbda](https://github.com/fgarofalo56/csa-inabox/commit/e1ddbda663a8d435c46e2b14e4345be6d969b232))
* **fiab:** day-one ship plan + validation matrix + worktree cleanup (handoff) ([#1430](https://github.com/fgarofalo56/csa-inabox/issues/1430)) ([dbe64b7](https://github.com/fgarofalo56/csa-inabox/commit/dbe64b7b205351196fa1904c93984b674ea8e2bb))

## [0.43.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.43.0...csa-inabox-v0.43.1) (2026-06-16)


### Bug Fixes

* **fiab-console:** Wave 2 broken feature-surface fixes (B1-B12) ([#1418](https://github.com/fgarofalo56/csa-inabox/issues/1418)) ([52afe2a](https://github.com/fgarofalo56/csa-inabox/commit/52afe2a9aa815ba8809841cbbdd594775587d8dd))
* **fiab-console:** Wave 2 UI updates — governance/admin/platform areas (§4) ([#1420](https://github.com/fgarofalo56/csa-inabox/issues/1420)) ([c3c9035](https://github.com/fgarofalo56/csa-inabox/commit/c3c9035d660f02665d3e96d801d8b51c5d54ed43))
* **fiab-console:** Wave 2 UI updates — RTH/RTI/mirroring/APIs parity affordances ([#1419](https://github.com/fgarofalo56/csa-inabox/issues/1419)) ([2c2d542](https://github.com/fgarofalo56/csa-inabox/commit/2c2d542a658ccfef9618435cf456c70d6bb2baf1))
* **fiab:** deploy-parity — sync live console fixes into the clean-deploy path ([#1415](https://github.com/fgarofalo56/csa-inabox/issues/1415)) ([1e05c22](https://github.com/fgarofalo56/csa-inabox/commit/1e05c2206bd91ce87873960b76863eed697ed2fc))


### Documentation

* **fiab:** concept docs answering 5 csa-uncovered Copilot questions ([#1416](https://github.com/fgarofalo56/csa-inabox/issues/1416)) ([dda80e6](https://github.com/fgarofalo56/csa-inabox/commit/dda80e68d397976e893f540d0d2d128ce82618b2))


### Miscellaneous

* **deps-dev:** Bump eslint in /portal/react-webapp ([#1320](https://github.com/fgarofalo56/csa-inabox/issues/1320)) ([9d012a4](https://github.com/fgarofalo56/csa-inabox/commit/9d012a4298708be6506750d3aee9b853a499bd62))
* **deps-dev:** Bump tailwindcss in /portal/react-webapp ([#1318](https://github.com/fgarofalo56/csa-inabox/issues/1318)) ([330b95f](https://github.com/fgarofalo56/csa-inabox/commit/330b95fa7fc9929dee67a0bb0fec4718355a5b22))
* **deps:** Bump @azure/msal-react in /portal/react-webapp ([#1313](https://github.com/fgarofalo56/csa-inabox/issues/1313)) ([511353c](https://github.com/fgarofalo56/csa-inabox/commit/511353c5e16d3566a65a7509d261a9813fcc6f2a))
* **deps:** Bump @radix-ui/react-label in /portal/react-webapp ([#1314](https://github.com/fgarofalo56/csa-inabox/issues/1314)) ([adcd2a2](https://github.com/fgarofalo56/csa-inabox/commit/adcd2a2917e31c0f2483c761f975b515787b84dc))
* **deps:** Bump @radix-ui/react-toast in /portal/react-webapp ([#1317](https://github.com/fgarofalo56/csa-inabox/issues/1317)) ([10e4eca](https://github.com/fgarofalo56/csa-inabox/commit/10e4eca9bc98e8173d5c208aa015f92967c4e4b3))

## [0.43.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.42.0...csa-inabox-v0.43.0) (2026-06-16)


### Features

* **coe-library:** render CoE report templates + publish to org + consumer gallery ([#1409](https://github.com/fgarofalo56/csa-inabox/issues/1409)) ([70e2cfe](https://github.com/fgarofalo56/csa-inabox/commit/70e2cfe34fd291749415ed77c776de5c66fd4032))
* **coe-report-viewer:** render LIVE data from the customer's Azure estate ([#1412](https://github.com/fgarofalo56/csa-inabox/issues/1412)) ([1e8f318](https://github.com/fgarofalo56/csa-inabox/commit/1e8f3187f05bd11a533b9fa88096463d45e9ff94))
* **mcp:** deploy built-in MCP server live + default-on bicep + catalog fixes ([#1413](https://github.com/fgarofalo56/csa-inabox/issues/1413)) ([bcde157](https://github.com/fgarofalo56/csa-inabox/commit/bcde157c9d98346e9ea1efbb44cecb1f5628ae4c))


### Bug Fixes

* **fiab-console:** LA token audience + hub detection + network topology dupes + Warp blank + cosmos scaling timeout + shortcut empty-path ([#1407](https://github.com/fgarofalo56/csa-inabox/issues/1407)) ([4f6f398](https://github.com/fgarofalo56/csa-inabox/commit/4f6f3980ca828009e4d97ba9683e4eb1461304ca))
* **fiab-console:** paginated-report export streams real binary (not JSON renamed .pdf) + honest copy nits ([#1411](https://github.com/fgarofalo56/csa-inabox/issues/1411)) ([eb484cc](https://github.com/fgarofalo56/csa-inabox/commit/eb484cc09ac4c33e72d1810b42bcf61c4f447663))
* **fiab-console:** wave-1 broken/vaporware items — make each real or honest-gate ([#1414](https://github.com/fgarofalo56/csa-inabox/issues/1414)) ([e47dfc0](https://github.com/fgarofalo56/csa-inabox/commit/e47dfc05fcb6f244d671ce3459d9c92bcd36e299))


### Miscellaneous

* **deps-dev:** Bump @types/node in /portal/react-webapp ([#1319](https://github.com/fgarofalo56/csa-inabox/issues/1319)) ([53e633a](https://github.com/fgarofalo56/csa-inabox/commit/53e633a2e0f6c6399d9e985b87df20f5495bb0ec))
* **deps-dev:** Bump eslint-config-next in /portal/react-webapp ([#1316](https://github.com/fgarofalo56/csa-inabox/issues/1316)) ([45ed04a](https://github.com/fgarofalo56/csa-inabox/commit/45ed04a9574962842177127b3365c1b6aa255215))
* **deps:** Bump @azure/msal-browser in /portal/react-webapp ([#1315](https://github.com/fgarofalo56/csa-inabox/issues/1315)) ([d079cdc](https://github.com/fgarofalo56/csa-inabox/commit/d079cdcf6620a13db8e643922d95c78f4331f881))
* **deps:** Bump @radix-ui/react-dropdown-menu in /portal/react-webapp ([#1325](https://github.com/fgarofalo56/csa-inabox/issues/1325)) ([4d2d3a5](https://github.com/fgarofalo56/csa-inabox/commit/4d2d3a5e590bbb2941401460024708fe4666a0af))
* **deps:** Bump @radix-ui/react-tabs in /portal/react-webapp ([#1323](https://github.com/fgarofalo56/csa-inabox/issues/1323)) ([52687b6](https://github.com/fgarofalo56/csa-inabox/commit/52687b6b140ae0d27950747e902d7b9ba79d75a7))
* **deps:** Bump next from 16.2.7 to 16.2.9 in /portal/react-webapp ([#1321](https://github.com/fgarofalo56/csa-inabox/issues/1321)) ([01c98ba](https://github.com/fgarofalo56/csa-inabox/commit/01c98ba61dff5db0f78b8276eab6fdc88c28060c))

## [0.42.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.41.0...csa-inabox-v0.42.0) (2026-06-15)


### Features

* **fiab-console:** live network topology resource-graph visual (/admin/network) ([#1402](https://github.com/fgarofalo56/csa-inabox/issues/1402)) ([22f28c7](https://github.com/fgarofalo56/csa-inabox/commit/22f28c7eed6c64e74814c4bbf4a9e4ea4f58e97e))
* **fiab-deploy:** integrate 11 deploy-readiness domains — push-button 100% day-one ([#1400](https://github.com/fgarofalo56/csa-inabox/issues/1400)) ([63eb1e0](https://github.com/fgarofalo56/csa-inabox/commit/63eb1e037924d27ba42cdcc20a7560932ea4a4ef))
* **fiab:** CoE Power BI report template library for Org Visuals (PBIP) + catalog + publish script ([#1404](https://github.com/fgarofalo56/csa-inabox/issues/1404)) ([a4d28f1](https://github.com/fgarofalo56/csa-inabox/commit/a4d28f1a04cc8a116a7fb3c56619c0cf4ee6f94b))


### Bug Fixes

* **ci:** unblock all PRs — bare server-fetch guard + mypy/pathspec Python Tests ([#1398](https://github.com/fgarofalo56/csa-inabox/issues/1398)) ([9f7a299](https://github.com/fgarofalo56/csa-inabox/commit/9f7a299102bce30b585f46d3eff05ea6329deaef))
* **fiab-console:** ACA managed-identity credential — bypass @azure/identity MSI parse bug ([#1406](https://github.com/fgarofalo56/csa-inabox/issues/1406)) ([49864ef](https://github.com/fgarofalo56/csa-inabox/commit/49864efbea661c81f9639b112f92e7710646ed58))
* **fiab-console:** backend-aware lakehouse/notebook sample SQL (Synapse Spark Hive default, Unity Catalog only on Databricks) ([#1403](https://github.com/fgarofalo56/csa-inabox/issues/1403)) ([3733ce2](https://github.com/fgarofalo56/csa-inabox/commit/3733ce2ff104c2f83bbcdf8c25403e1db20af1cd))
* **fiab-console:** Fabric azure-native default + Foundry dropdown cross-sub enumeration + connections MI-credential hardening + opt-in walkthroughs ([#1401](https://github.com/fgarofalo56/csa-inabox/issues/1401)) ([c22a42f](https://github.com/fgarofalo56/csa-inabox/commit/c22a42f4a7e951ea5f49362c42acfd24418a6b55))
* **fiab-console:** lakehouse shortcuts — external ADLS+SAS URL construction + in-tenant account enumeration (AAD) + connector sweep ([#1405](https://github.com/fgarofalo56/csa-inabox/issues/1405)) ([f2b1f26](https://github.com/fgarofalo56/csa-inabox/commit/f2b1f262daa8b20e092e68182e07f3b0c2787e5c))


### Documentation

* **fiab:** deploy-readiness PRP — push-button, 100% working, scan-and-choose ([#1385](https://github.com/fgarofalo56/csa-inabox/issues/1385)) ([e3f9c9f](https://github.com/fgarofalo56/csa-inabox/commit/e3f9c9f5734e53685a42d91d2450f0372d728ebf))

## [0.41.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.40.0...csa-inabox-v0.41.0) (2026-06-15)


### Features

* **catalog-metastores:** MI-first Databricks UC scan (no Key Vault) + opt-in PAT KV bicep ([#1375](https://github.com/fgarofalo56/csa-inabox/issues/1375)) ([e195447](https://github.com/fgarofalo56/csa-inabox/commit/e1954477ccbd0f32833da02e56462f0ca9428329))
* **deploy-planner:** currency + pricing-region pickers for cost estimate ([#1368](https://github.com/fgarofalo56/csa-inabox/issues/1368)) ([fb7845f](https://github.com/fgarofalo56/csa-inabox/commit/fb7845f42f1c78b7d10e2065df77c7e5d2cb1cc3))
* **fiab-bicep:** deploy Setup Orchestrator by default + drop duplicate stub (audit-t142) ([#1378](https://github.com/fgarofalo56/csa-inabox/issues/1378)) ([e31c367](https://github.com/fgarofalo56/csa-inabox/commit/e31c367481e8e843878515a1d3f164a8efb920a5))
* **fiab-console:** admin discovery card for Fabric IQ MCP surface (audit-T86 finish) ([#1379](https://github.com/fgarofalo56/csa-inabox/issues/1379)) ([3ff96a0](https://github.com/fgarofalo56/csa-inabox/commit/3ff96a04548f2c03add5a731614374d5071ef8b0))
* **fiab-console:** real DLP policy CRUD via SCC PowerShell sidecar (audit-T127) ([#1365](https://github.com/fgarofalo56/csa-inabox/issues/1365)) ([e65c1d7](https://github.com/fgarofalo56/csa-inabox/commit/e65c1d7f53fc5ce21750d28ed9c4b2dca5ab8e4e))
* **fiab-deploy-planner:** standalone .bicep export (edges→dependsOn) + 3 more config knobs ([#1369](https://github.com/fgarofalo56/csa-inabox/issues/1369)) ([68cf374](https://github.com/fgarofalo56/csa-inabox/commit/68cf374d2951edba0813a643060f7b5e031e392f))
* **fiab-governance:** GA data-quality monitor API + MDM steward crosswalk ([#1377](https://github.com/fgarofalo56/csa-inabox/issues/1377)) ([042c54d](https://github.com/fgarofalo56/csa-inabox/commit/042c54dcfe3fdb5a583e3cfcd222e629b6f2b10f))
* **fiab-lineage:** close unified-lineage gaps — column lineage, identity resolution, path bridge (audit-t138) ([#1372](https://github.com/fgarofalo56/csa-inabox/issues/1372)) ([f7f6101](https://github.com/fgarofalo56/csa-inabox/commit/f7f6101a27a22f2c534688ee22df69fc4b7f32a3))
* **fiab-lineage:** propagate item delete to Purview Atlas entity (offboard) ([#1370](https://github.com/fgarofalo56/csa-inabox/issues/1370)) ([a3c8c77](https://github.com/fgarofalo56/csa-inabox/commit/a3c8c77db9f901535f029e923bd695f165f0d085))
* **fiab-network:** bind private endpoints to Loom service/domain in topology (ARG) + zone A-records ([#1367](https://github.com/fgarofalo56/csa-inabox/issues/1367)) ([1deb04b](https://github.com/fgarofalo56/csa-inabox/commit/1deb04b113b905a87c837c5ef72cbf7d82415c61))
* **fiab-rayfin:** page-template wizards + align Rayfin/Atelier decision (audit-T145/T84) ([#1381](https://github.com/fgarofalo56/csa-inabox/issues/1381)) ([f098bba](https://github.com/fgarofalo56/csa-inabox/commit/f098bba47b39411bb4565296f7874f1620d5aa51))
* **fiab-rti-hub:** namespace create-if-missing + connection pickers + fix Event Grid source binding ([#1371](https://github.com/fgarofalo56/csa-inabox/issues/1371)) ([27a8274](https://github.com/fgarofalo56/csa-inabox/commit/27a82742a7088b58351e53917aaee547b150f9b6))


### Bug Fixes

* **fiab-bicep:** actually correct the RBAC Admin GUID var (not just the comment) ([#1358](https://github.com/fgarofalo56/csa-inabox/issues/1358)) ([64e5b16](https://github.com/fgarofalo56/csa-inabox/commit/64e5b164301562c1ef4559171d0d713cd7228872))
* **fiab-bicep:** correct RBAC Admin GUID + enable Cosmos vector capability (dlz) ([#1357](https://github.com/fgarofalo56/csa-inabox/issues/1357)) ([bca75e6](https://github.com/fgarofalo56/csa-inabox/commit/bca75e6a741319b4295d9febd0ae179e55d49c8d))
* **fiab-bicep:** forward Databricks account id to Console so UC is configured by default ([#1374](https://github.com/fgarofalo56/csa-inabox/issues/1374)) ([0881fc7](https://github.com/fgarofalo56/csa-inabox/commit/0881fc79cb36f829773b4d465b73baf796ec95f3))
* **fiab-bicep:** resolve dlz-attach hub coords from hubCoordinates (peering empty vnet) ([#1356](https://github.com/fgarofalo56/csa-inabox/issues/1356)) ([1cd919a](https://github.com/fgarofalo56/csa-inabox/commit/1cd919a7d0b5c66e8e1199348bdea2b7dfbfc252))
* **fiab-bicep:** set PG Entra admin before restart-triggering config (dlz weave) ([#1359](https://github.com/fgarofalo56/csa-inabox/issues/1359)) ([937815d](https://github.com/fgarofalo56/csa-inabox/commit/937815de5d29efc5fc78bdb3e70acb4fd7764d39))
* **fiab-bicep:** skip deploy-time ADX DB in dlz-attach (cross-sub nested deploy) ([#1354](https://github.com/fgarofalo56/csa-inabox/issues/1354)) ([56038db](https://github.com/fgarofalo56/csa-inabox/commit/56038db74cc8d52c34ab83eac2d2f5225cb4a102))
* **fiab-bicep:** vector container needs dedicated (not shared) throughput ([#1360](https://github.com/fgarofalo56/csa-inabox/issues/1360)) ([9db9432](https://github.com/fgarofalo56/csa-inabox/commit/9db9432a2ec82d3c37c2a5ded58d51e360400b4d))
* **fiab-console:** harden APIM admin panes against "Unexpected token '&lt;'" crash ([#1362](https://github.com/fgarofalo56/csa-inabox/issues/1362)) ([801f384](https://github.com/fgarofalo56/csa-inabox/commit/801f384fdd2029b60b744a83bd95cccb0dc19462))
* **fiab-dbt:** resolve Databricks dbt profile at runtime via injected DBT_ACCESS_TOKEN ([#1380](https://github.com/fgarofalo56/csa-inabox/issues/1380)) ([623ff9b](https://github.com/fgarofalo56/csa-inabox/commit/623ff9b11ca2d9d7df45998ddbb2bbade09a051f))
* **fiab-domains:** governance domains store dual-writes to Purview AND Unity Catalog ([#1376](https://github.com/fgarofalo56/csa-inabox/issues/1376)) ([1504589](https://github.com/fgarofalo56/csa-inabox/commit/15045895b24705efc69aa8866fa24724538242d8))
* **fiab-mip:** render evaluate recommendation as label chip + honest Graph-write doc ([#1363](https://github.com/fgarofalo56/csa-inabox/issues/1363)) ([43e9039](https://github.com/fgarofalo56/csa-inabox/commit/43e9039ab621c23b42719a62a6cb827419684209))
* **fiab-rti-hub:** make RTI catalog streams usable/testable end-to-end ([#1373](https://github.com/fgarofalo56/csa-inabox/issues/1373)) ([8c4d3d5](https://github.com/fgarofalo56/csa-inabox/commit/8c4d3d5c150c53a0adc57524fa6c657b3ae17342))
* **fiab:** authorize Console UAMI on Purview by default + correct UC endpoint host ([#1364](https://github.com/fgarofalo56/csa-inabox/issues/1364)) ([b670226](https://github.com/fgarofalo56/csa-inabox/commit/b670226c75eea463f6fa9a632baad5c3b66b79c9))


### Tests

* **fiab-console:** repin embed-codes bicep-wiring gate to useSingleDlz (audit-T128) ([#1361](https://github.com/fgarofalo56/csa-inabox/issues/1361)) ([eb1d0e7](https://github.com/fgarofalo56/csa-inabox/commit/eb1d0e7fb83e5ee5970fcfd621e5eee13c2be6c3))

## [0.40.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.39.0...csa-inabox-v0.40.0) (2026-06-14)


### Features

* **csa-loom:** dlz-attach topology — orchestrator + wizard + bicep + CI (audit-t157) ([#1312](https://github.com/fgarofalo56/csa-inabox/issues/1312)) ([cd4576f](https://github.com/fgarofalo56/csa-inabox/commit/cd4576f1f30ffe2d64ed730ef9067b2b56120795))
* **csa-loom:** domain registry as authoritative tenant topology + required workspace binding (audit-t158) ([#1311](https://github.com/fgarofalo56/csa-inabox/issues/1311)) ([c1ba963](https://github.com/fgarofalo56/csa-inabox/commit/c1ba963a7787eb7c56dd15e08ac3d694eb5b4168))
* **csa-loom:** domain-aware resource routing for item-creates (audit-t159) ([#1308](https://github.com/fgarofalo56/csa-inabox/issues/1308)) ([3ccc7eb](https://github.com/fgarofalo56/csa-inabox/commit/3ccc7eb92b2942bd2f1175cc092ada37a7471f1b))
* **csa-loom:** FedCiv multi-sub live migration — tenant-dmlz + dlz-attach params, runbook, orphan sweep (audit-t162) ([#1326](https://github.com/fgarofalo56/csa-inabox/issues/1326)) ([4595d54](https://github.com/fgarofalo56/csa-inabox/commit/4595d54011a2851f22e5a163831f22a1d57b9ffa))
* **csa-loom:** tenant-admin vs domain-admin vs domain-contributor RBAC tiers (D2) (audit-t160) ([#1310](https://github.com/fgarofalo56/csa-inabox/issues/1310)) ([fcc9e8d](https://github.com/fgarofalo56/csa-inabox/commit/fcc9e8d9ccfa0d88f41bb15486304666dc55b359))
* **fiab-bicep:** explicit topology modes + optional admin plane (audit-t156) ([#1309](https://github.com/fgarofalo56/csa-inabox/issues/1309)) ([3903c04](https://github.com/fgarofalo56/csa-inabox/commit/3903c045779af4f94dacccf7a7bd088434e26976))
* **fiab-deploy:** allow_existing_hub bypass for idempotent hub reconcile/retry ([#1340](https://github.com/fgarofalo56/csa-inabox/issues/1340)) ([8548462](https://github.com/fgarofalo56/csa-inabox/commit/8548462f28823e79b28ee953bfb9c37536ec56fd))
* **fiab-deploy:** front_door_enabled toggle for public + vanity domain ([#1351](https://github.com/fgarofalo56/csa-inabox/issues/1351)) ([97e82d0](https://github.com/fgarofalo56/csa-inabox/commit/97e82d0eabb3cda82d3625dfbf6187ff5d7eabd9))
* **fiab-deploy:** hubFirewallEnabled toggle (Azure Firewall blocks reconcile passes) ([#1347](https://github.com/fgarofalo56/csa-inabox/issues/1347)) ([29c3642](https://github.com/fgarofalo56/csa-inabox/commit/29c364255a54435addc269359649e89934fc509e))
* **fiab-deploy:** parametrize full-app-deploy for region/sub + deployAppsEnabled toggle ([#1349](https://github.com/fgarofalo56/csa-inabox/issues/1349)) ([6d25812](https://github.com/fgarofalo56/csa-inabox/commit/6d258126ef62e4465bc303dc1c42a7d09cc7c95c))
* **fiab-deploy:** per-sub-unique ADX name + auto-register RPs/features (DMLZ rebuild) ([#1342](https://github.com/fgarofalo56/csa-inabox/issues/1342)) ([886a5a3](https://github.com/fgarofalo56/csa-inabox/commit/886a5a3af4540c60529973ae655685d90503227e))


### Bug Fixes

* **fiab-bicep:** bundle Loom backend selectors to clear ARM 256-param limit (audit-t166) ([#1334](https://github.com/fgarofalo56/csa-inabox/issues/1334)) ([8fa907f](https://github.com/fgarofalo56/csa-inabox/commit/8fa907f7eedc683bf28f694bc744e868d9741072))
* **fiab-bicep:** correct bogus Monitoring Contributor role GUID (deploy blocker) ([#1339](https://github.com/fgarofalo56/csa-inabox/issues/1339)) ([1f381dc](https://github.com/fgarofalo56/csa-inabox/commit/1f381dc951e2a4de3df24196601686c22852d5c1))
* **fiab-bicep:** declare azure-maps params in root template (BCP259 deploy blocker) ([#1337](https://github.com/fgarofalo56/csa-inabox/issues/1337)) ([97d8986](https://github.com/fgarofalo56/csa-inabox/commit/97d898642e2bad735fc8a02a810b0d28da995b32))
* **fiab-bicep:** escape apostrophe in adminPlaneAdxClusterName description (BCP071) ([#1343](https://github.com/fgarofalo56/csa-inabox/issues/1343)) ([a4dca25](https://github.com/fgarofalo56/csa-inabox/commit/a4dca254c5c7e5e62321d59450b714b56e70b0e0))
* **fiab-bicep:** remove eager fail-var that broke what-if for all topologies (audit-t156) ([#1338](https://github.com/fgarofalo56/csa-inabox/issues/1338)) ([1362829](https://github.com/fgarofalo56/csa-inabox/commit/13628292a2f74575604abc2e1a3ffed77a2e5482))
* **fiab-bicep:** skip ADX DLZ-scoped grants in tenant mode (ResourceGroupNotFound) ([#1348](https://github.com/fgarofalo56/csa-inabox/issues/1348)) ([450c100](https://github.com/fgarofalo56/csa-inabox/commit/450c1001f891a80881ebbeb949ab7cdb964be395))
* **fiab-bicep:** suffix AFD endpoint name with uniqueString (global hostname collision) ([#1352](https://github.com/fgarofalo56/csa-inabox/issues/1352)) ([8cb995e](https://github.com/fgarofalo56/csa-inabox/commit/8cb995e3e41b7e542f94a2621347e4441e0a5b54))
* **fiab-bicep:** use real Monitoring Contributor GUID 749f88d5-cbae (deploy blocker) ([#1341](https://github.com/fgarofalo56/csa-inabox/issues/1341)) ([870c992](https://github.com/fgarofalo56/csa-inabox/commit/870c99248d4112a4710bda260852d496e92b8bef))
* **fiab-deploy:** add mcpBridge image tag + build target + skip_role_grants ([#1350](https://github.com/fgarofalo56/csa-inabox/issues/1350)) ([7b5fde2](https://github.com/fgarofalo56/csa-inabox/commit/7b5fde2904589111d49d17521c94eb82ce56c684))
* **fiab-deploy:** correct 3 hallucinated role GUIDs + purview/maps toggles for region split ([#1345](https://github.com/fgarofalo56/csa-inabox/issues/1345)) ([ac2b913](https://github.com/fgarofalo56/csa-inabox/commit/ac2b9139e6da6b399388ba2d845c52aec0141246))
* **fiab-deploy:** pass region input to bicep location param (centralus capacity) ([#1344](https://github.com/fgarofalo56/csa-inabox/issues/1344)) ([f28dbbc](https://github.com/fgarofalo56/csa-inabox/commit/f28dbbca345a0b847028dea196fe54375f55672e))
* **fiab-deploy:** remove duplicate topology input that broke workflow_dispatch ([#1336](https://github.com/fgarofalo56/csa-inabox/issues/1336)) ([b8e87c0](https://github.com/fgarofalo56/csa-inabox/commit/b8e87c014a5d284e8bb6ff731a9f30bb421ab2ba))
* **fiab-deploy:** scope hub-exists guard to target sub, not tenant-wide (audit-t156) ([#1335](https://github.com/fgarofalo56/csa-inabox/issues/1335)) ([e5a532f](https://github.com/fgarofalo56/csa-inabox/commit/e5a532f4462f6114e6bdf0f1a572b7e3716b1960))


### Documentation

* **csa-loom:** tenant topology + deploy-flow diagrams, planner deploymentMode, topology tutorial (audit-t163) ([#1327](https://github.com/fgarofalo56/csa-inabox/issues/1327)) ([693b7c4](https://github.com/fgarofalo56/csa-inabox/commit/693b7c4aa84dd6fbbeafbe67c7a9555c2ca05440))
* **csa-loom:** Wave-13b spec — ARM-256 param unblock + topology enhancements ([#1333](https://github.com/fgarofalo56/csa-inabox/issues/1333)) ([5ed9269](https://github.com/fgarofalo56/csa-inabox/commit/5ed9269de61bee38463f91233653800d1f862899))

## [0.39.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.38.0...csa-inabox-v0.39.0) (2026-06-12)


### Features

* **csa-loom:** /connections icons + cross-sub "add existing" import + KV creds (audit-t153) ([#1243](https://github.com/fgarofalo56/csa-inabox/issues/1243)) ([8737e11](https://github.com/fgarofalo56/csa-inabox/commit/8737e113b3876ea998118d7751e0dd2b036b47f8))
* **csa-loom:** ADX external-tables authoring + RLS/lifecycle parity reconcile (audit-t20) ([#1258](https://github.com/fgarofalo56/csa-inabox/issues/1258)) ([77bbbe1](https://github.com/fgarofalo56/csa-inabox/commit/77bbbe1c0b7d77e3c57fb20255858b6f66a90952))
* **csa-loom:** AI Foundry depth — observability dashboard, FT/eval charts, sovereign AOAI scope (audit-t19) ([#1260](https://github.com/fgarofalo56/csa-inabox/issues/1260)) ([f11755d](https://github.com/fgarofalo56/csa-inabox/commit/f11755ddda8ac813f0fd87edcfa6658112cd56c4))
* **csa-loom:** Atelier real CRUD over Weave-bound warehouse (audit-t51) ([#1285](https://github.com/fgarofalo56/csa-inabox/issues/1285)) ([a009965](https://github.com/fgarofalo56/csa-inabox/commit/a00996557e26751ce86f5c9d47c8397d7c320117))
* **csa-loom:** Azure SQL server table/schema browser sub-panel (audit-t16) ([#1257](https://github.com/fgarofalo56/csa-inabox/issues/1257)) ([7c9d4ca](https://github.com/fgarofalo56/csa-inabox/commit/7c9d4caa92964b51893077c5845a167faa52519d))
* **csa-loom:** complete /admin/env-config registry + wire analytics-embed deploy prereqs (audit-t149) ([#1242](https://github.com/fgarofalo56/csa-inabox/issues/1242)) ([4926fca](https://github.com/fgarofalo56/csa-inabox/commit/4926fca1abdcdbeec21e8d2ba2644746ca9a7fc6))
* **csa-loom:** durable Remove for ontology entity bindings (audit-t12) ([#1253](https://github.com/fgarofalo56/csa-inabox/issues/1253)) ([2f2c385](https://github.com/fgarofalo56/csa-inabox/commit/2f2c385e9e8e786e925e19c64c4a7ce7b122a1a8))
* **csa-loom:** expand deployable MCP catalog to a curated 25 servers (audit-t34) ([#1275](https://github.com/fgarofalo56/csa-inabox/issues/1275)) ([8a5f4a8](https://github.com/fgarofalo56/csa-inabox/commit/8a5f4a870638a7c6a446eceadf32d8e054ed97d9))
* **csa-loom:** geo-dataset geometry map render + geo-pipeline run-status grid (audit-t10) ([#1252](https://github.com/fgarofalo56/csa-inabox/issues/1252)) ([a7ed5ad](https://github.com/fgarofalo56/csa-inabox/commit/a7ed5ad6d8a61e63a6f6444e594d244e08e0836e))
* **csa-loom:** in-product Power Platform maker authoring — flow definition + create table (audit-t28) ([#1269](https://github.com/fgarofalo56/csa-inabox/issues/1269)) ([de9c023](https://github.com/fgarofalo56/csa-inabox/commit/de9c0231ae24c79f1374b5c673203d8c01026dfc))
* **csa-loom:** Learning Hub Copilot tutorial-id receipt-scope fallback (audit-t41) ([#1277](https://github.com/fgarofalo56/csa-inabox/issues/1277)) ([b057b68](https://github.com/fgarofalo56/csa-inabox/commit/b057b68b652ed0bae88959898f64ef1e37602f55))
* **csa-loom:** Learning Hub landing page + README-backed use-case link fix (audit-t37) ([#1272](https://github.com/fgarofalo56/csa-inabox/issues/1272)) ([6aa8819](https://github.com/fgarofalo56/csa-inabox/commit/6aa8819117400ad83ef3dc045e5a32f8f635b8bd))
* **csa-loom:** live Avro compatibility check on event-schema-set edit (audit-T15) ([#1255](https://github.com/fgarofalo56/csa-inabox/issues/1255)) ([830611f](https://github.com/fgarofalo56/csa-inabox/commit/830611f077bf040438fe86ccefcd32e956203165))
* **csa-loom:** make visual-tutorial apps dimension auditable offline + ready the strict coverage gate (B-9 / audit-t33) ([#1268](https://github.com/fgarofalo56/csa-inabox/issues/1268)) ([532ecc9](https://github.com/fgarofalo56/csa-inabox/commit/532ecc927994c54e7869b8f9b4a1d30f10020819))
* **csa-loom:** MCP deployable catalog gov-safety bridge (audit-t44) ([#1279](https://github.com/fgarofalo56/csa-inabox/issues/1279)) ([307727d](https://github.com/fgarofalo56/csa-inabox/commit/307727d0acdd56ac96dfff8a098753ccd213a669))
* **csa-loom:** mount workspace-level Activator pane on /activator-hub + nav (audit-t03) ([#1250](https://github.com/fgarofalo56/csa-inabox/issues/1250)) ([37e3f3f](https://github.com/fgarofalo56/csa-inabox/commit/37e3f3f7f99b95a8c33b5c49025afff185e4fbb7))
* **csa-loom:** reconcile MCP browse-catalog + deploy wizard to one configSchema/per-field-KV surface (audit-t45) ([#1284](https://github.com/fgarofalo56/csa-inabox/issues/1284)) ([c9957d2](https://github.com/fgarofalo56/csa-inabox/commit/c9957d27dc7882bad99eb0a82ebf6717084b2ad1))
* **csa-loom:** Spindle Studio — agents + logic over the Weave ontology (audit-t52) ([#1288](https://github.com/fgarofalo56/csa-inabox/issues/1288)) ([bc528a7](https://github.com/fgarofalo56/csa-inabox/commit/bc528a77bfc704e00285aba1746fc32f77aa559e))
* **csa-loom:** SQL constraint designer — per-backend NOT ENFORCED DDL for Warehouse/Synapse (audit-t24) ([#1265](https://github.com/fgarofalo56/csa-inabox/issues/1265)) ([ac6410e](https://github.com/fgarofalo56/csa-inabox/commit/ac6410e4cbccefa84663c2eabea79b5854ac6a34))
* **csa-loom:** Tapestry — investigative graph (Gotham-equivalent) over ADX + Azure Maps (audit-t53) ([#1286](https://github.com/fgarofalo56/csa-inabox/issues/1286)) ([f41312e](https://github.com/fgarofalo56/csa-inabox/commit/f41312ef79d8eba67cf3f7952eda62e08981c1f7))
* **csa-loom:** UC create-table-from-file + principal picker + storage securables (audit-t18) ([#1259](https://github.com/fgarofalo56/csa-inabox/issues/1259)) ([afd2952](https://github.com/fgarofalo56/csa-inabox/commit/afd29525f8d2443fab4683e8195b079d38106ad5))
* **csa-loom:** unify dual Copilot popups into one chat window with agent routing + attribution (audit-t155) ([#1302](https://github.com/fgarofalo56/csa-inabox/issues/1302)) ([4f1ab3c](https://github.com/fgarofalo56/csa-inabox/commit/4f1ab3c02c5df4b21ee811096728213231fb944b))
* **csa-loom:** Warp — unified visual + code transform/pipeline builder (audit-t54) ([#1287](https://github.com/fgarofalo56/csa-inabox/issues/1287)) ([6d17de2](https://github.com/fgarofalo56/csa-inabox/commit/6d17de21adc9886cf780d25875bbb86e62a89a5b))
* **csa-loom:** Weave (Semantic Ontology) Phase 1 — real object/link/action write-back on PostgreSQL + Apache AGE (audit-T50) ([#1289](https://github.com/fgarofalo56/csa-inabox/issues/1289)) ([8dcdd69](https://github.com/fgarofalo56/csa-inabox/commit/8dcdd696846fce520283d036b80003da36961bd4))
* **csa-loom:** wire ADF CDC change-data preview via real Delta read (audit-t26) ([#1267](https://github.com/fgarofalo56/csa-inabox/issues/1267)) ([769d1a7](https://github.com/fgarofalo56/csa-inabox/commit/769d1a7c003e180482d13d4eda958a88c843ef43))
* **csa-loom:** wire pbi-paginated in-place embed in the RDL designer (audit-t14) ([#1256](https://github.com/fgarofalo56/csa-inabox/issues/1256)) ([246a5ad](https://github.com/fgarofalo56/csa-inabox/commit/246a5ad6ec5969dacb319ee902a819f3c706e480))


### Bug Fixes

* **csa-loom:** /thread adopts shared ViewToggle component (audit-t113) ([#1291](https://github.com/fgarofalo56/csa-inabox/issues/1291)) ([58f4587](https://github.com/fgarofalo56/csa-inabox/commit/58f4587be8ad5e9b69ae21650210e976bf2be9f1))
* **csa-loom:** close AKS env-write gap for /admin/env-config Save (audit-t49) ([#1283](https://github.com/fgarofalo56/csa-inabox/issues/1283)) ([cce18b9](https://github.com/fgarofalo56/csa-inabox/commit/cce18b97c3ae57b95cec1796914b183cefd8640d))
* **csa-loom:** close audit-t43 — Learn portal Loom-docs-first link integrity (README index alias) ([#1278](https://github.com/fgarofalo56/csa-inabox/issues/1278)) ([333fb9e](https://github.com/fgarofalo56/csa-inabox/commit/333fb9e5eafa70e8093d6ca56227f9ad615d1360))
* **csa-loom:** coerce JSON-string args in all workflow scripts ([#1301](https://github.com/fgarofalo56/csa-inabox/issues/1301)) ([b3fbae0](https://github.com/fgarofalo56/csa-inabox/commit/b3fbae0bd621c22610c645a962a9b891a7605e66))
* **csa-loom:** correct Monitor alert-rule equality operator Equal -&gt; Equals (audit-t23) ([#1262](https://github.com/fgarofalo56/csa-inabox/issues/1262)) ([01152e1](https://github.com/fgarofalo56/csa-inabox/commit/01152e1b3595c656ac431bcf723f39d28d536917))
* **csa-loom:** Gov-safe AAD audience for vector-store similarity search (audit-t11) ([#1254](https://github.com/fgarofalo56/csa-inabox/issues/1254)) ([d1e8c96](https://github.com/fgarofalo56/csa-inabox/commit/d1e8c96a52acf814dd5e1f815dad36529ff935ea))
* **csa-loom:** harden federated-search clearance of catalog sidebar rule (audit-t120) ([#1295](https://github.com/fgarofalo56/csa-inabox/issues/1295)) ([c011901](https://github.com/fgarofalo56/csa-inabox/commit/c01190181fe29fdbb878d8b73b55894cff5d1d6c))
* **csa-loom:** hoist McpServersPanel useMemo above early return (React [#310](https://github.com/fgarofalo56/csa-inabox/issues/310)) ([#1239](https://github.com/fgarofalo56/csa-inabox/issues/1239)) ([3ded0dc](https://github.com/fgarofalo56/csa-inabox/commit/3ded0dc1b47518617060b78898c212e0aa000fd4))
* **csa-loom:** honest gate for /admin/audit-logs LA credential + RBAC failures (audit-t148) ([#1241](https://github.com/fgarofalo56/csa-inabox/issues/1241)) ([5608106](https://github.com/fgarofalo56/csa-inabox/commit/5608106fd81f22790b46e3b5d77f50b1f52a13b0))
* **csa-loom:** item-route guard recognizes destructured factory exports ([#1246](https://github.com/fgarofalo56/csa-inabox/issues/1246)) ([89d3b21](https://github.com/fgarofalo56/csa-inabox/commit/89d3b216205842bb5f8e98353a022b8548d234e8))
* **csa-loom:** loom-unleash-fast refuses to run unscoped (no-args guard) ([#1299](https://github.com/fgarofalo56/csa-inabox/issues/1299)) ([9a0c549](https://github.com/fgarofalo56/csa-inabox/commit/9a0c549a36c969edd7ac48d3dae4454901924643))
* **csa-loom:** monitor activity feed KQL — derive Submitter from SystemParameters, not nonexistent TriggerName column (audit-t01) ([#1248](https://github.com/fgarofalo56/csa-inabox/issues/1248)) ([4413023](https://github.com/fgarofalo56/csa-inabox/commit/441302372dcb4b85f46d33ddd9509a6aa6d3d083))
* **csa-loom:** pin data-agent composer dock so Send is always visible (audit-t118) ([#1294](https://github.com/fgarofalo56/csa-inabox/issues/1294)) ([ba55318](https://github.com/fgarofalo56/csa-inabox/commit/ba55318186ff52bf1c99a96d096cbd5829d76989))
* **csa-loom:** resolve MCP catalog bicep collisions (dup mcpStorage symbol/env, dup keyvault param) (audit-t48) ([#1281](https://github.com/fgarofalo56/csa-inabox/issues/1281)) ([051e17d](https://github.com/fgarofalo56/csa-inabox/commit/051e17d4271031f2b95aee075e42c3c7e120e139))
* **csa-loom:** restore native 24px stat icons in realtime-hub-view (audit-t114) ([#1290](https://github.com/fgarofalo56/csa-inabox/issues/1290)) ([ce636ba](https://github.com/fgarofalo56/csa-inabox/commit/ce636ba7a3872a45a3ab63a8c48e91b8dcb77771))
* **csa-loom:** sovereign-cloud parity for Synapse KQL/SJD workspace tree (audit-t25) ([#1264](https://github.com/fgarofalo56/csa-inabox/issues/1264)) ([b4e4057](https://github.com/fgarofalo56/csa-inabox/commit/b4e40579febca48afb0d9adee75930d5cba87d6a))
* **csa-loom:** unblock IL5/GCC-High deploy (main.bicep build) + add gov deploy-verification evidence harness (audit-t30) ([#1270](https://github.com/fgarofalo56/csa-inabox/issues/1270)) ([f13d73e](https://github.com/fgarofalo56/csa-inabox/commit/f13d73e3f1e9c6137989b8d3c5c9e3046493e59f))
* **csa-loom:** unbreak next build — 'Node_*/Edge_*' in JSDoc terminated block comments early (audit-t53) ([#1304](https://github.com/fgarofalo56/csa-inabox/issues/1304)) ([ba4437c](https://github.com/fgarofalo56/csa-inabox/commit/ba4437cf3a548b8ce7a5147a5b879ef7ffc55e08))
* **csa-loom:** wire AI Search debug-session storage by default (keyless MSI) (audit-t22) ([#1263](https://github.com/fgarofalo56/csa-inabox/issues/1263)) ([5b4685b](https://github.com/fgarofalo56/csa-inabox/commit/5b4685b99930611af3564e16720f733107ee5b70))


### Code Refactoring

* **csa-loom:** redesign catalog/metastores onto Loom primitives (audit-t112) ([#1292](https://github.com/fgarofalo56/csa-inabox/issues/1292)) ([1b022b7](https://github.com/fgarofalo56/csa-inabox/commit/1b022b787ca3d09dc8d311aeb4cd3280bb347ec2))
* **csa-loom:** sweep admin-tab inline styles onto useAdminTabStyles tokens (audit-t116) ([#1298](https://github.com/fgarofalo56/csa-inabox/issues/1298)) ([e07aeec](https://github.com/fgarofalo56/csa-inabox/commit/e07aeec8e5f7bd78f7a63f8307f742728b1cadfc))


### Documentation

* **csa-loom:** add MCP library index + bicep-layer tests for stdio→HTTP/SSE bridge (audit-t47) ([#1282](https://github.com/fgarofalo56/csa-inabox/issues/1282)) ([73f6961](https://github.com/fgarofalo56/csa-inabox/commit/73f6961775150fa7ca40a20e46c786c1e610159c))
* **csa-loom:** correct stale Cosmos script-authoring comments (audit-t08) ([#1251](https://github.com/fgarofalo56/csa-inabox/issues/1251)) ([9ff75ae](https://github.com/fgarofalo56/csa-inabox/commit/9ff75ae192581e8df3f3ee4461613ee4057cc5a7))
* **csa-loom:** correct stale Event Hubs tree header + surface Geo-DR failover alias caveat (audit-t21) ([#1261](https://github.com/fgarofalo56/csa-inabox/issues/1261)) ([467b949](https://github.com/fgarofalo56/csa-inabox/commit/467b9498d46d35a17baa8179ed94878ff5473e0a))
* **csa-loom:** Learning-Hub notebook import wizard guide + route tests (audit-t39) ([#1274](https://github.com/fgarofalo56/csa-inabox/issues/1274)) ([d381af6](https://github.com/fgarofalo56/csa-inabox/commit/d381af6aaf517796ac209b33062c56488b28b984))
* **csa-loom:** mark C-86 Self-Modification Pipeline promote as DELIVERED (audit-t36) ([#1271](https://github.com/fgarofalo56/csa-inabox/issues/1271)) ([613cd0d](https://github.com/fgarofalo56/csa-inabox/commit/613cd0ddf619211cae9a53c6dfcc74e8dd49b240))
* **csa-loom:** MCP deploy-to-Container-Apps + Azure Files source-of-truth + api-version pin (audit-t46) ([#1280](https://github.com/fgarofalo56/csa-inabox/issues/1280)) ([2725c2a](https://github.com/fgarofalo56/csa-inabox/commit/2725c2a41ab15d81fb5aceb9a0c9a434671a1573))
* **csa-loom:** reconcile deploy-planner parity counts to verified catalog (audit-t119) ([#1297](https://github.com/fgarofalo56/csa-inabox/issues/1297)) ([de1ce8a](https://github.com/fgarofalo56/csa-inabox/commit/de1ce8aff7fdfab6a2505413a10dcd30233c2bfa))
* **csa-loom:** sync Palantir migration docs to built Loom surfaces (audit-t29) ([#1266](https://github.com/fgarofalo56/csa-inabox/issues/1266)) ([6ee12d6](https://github.com/fgarofalo56/csa-inabox/commit/6ee12d697c4f93066c5d53566ce67ada7086cc6a))
* **csa-loom:** verify-and-close warehouse pane parity (audit-t04) ([#1247](https://github.com/fgarofalo56/csa-inabox/issues/1247)) ([6f6a37a](https://github.com/fgarofalo56/csa-inabox/commit/6f6a37a79b8f1e6511a67918b1e417377ac81292))


### Tests

* **csa-loom:** live e2e for guided onboarding tour + Cosmos data-plane RBAC (audit-t42) ([#1276](https://github.com/fgarofalo56/csa-inabox/issues/1276)) ([f7a3449](https://github.com/fgarofalo56/csa-inabox/commit/f7a3449f2edadf83b9ea092a1d017c9b8510dc75))
* **csa-loom:** pin Learn "Install live example" wiring + registry invariant (audit-t38) ([#1273](https://github.com/fgarofalo56/csa-inabox/issues/1273)) ([696951d](https://github.com/fgarofalo56/csa-inabox/commit/696951d4a8a970168243699e0a6972f1b2a31b50))


### Performance Improvements

* **csa-loom:** TTL-memoize remaining Monitor tab read paths (audit-t117) ([#1296](https://github.com/fgarofalo56/csa-inabox/issues/1296)) ([d91d5df](https://github.com/fgarofalo56/csa-inabox/commit/d91d5df4b8277dae8f46b429ec33917860379589))


### Miscellaneous

* **csa-loom:** pin workflow agents to Claude Fable 5 ([#1245](https://github.com/fgarofalo56/csa-inabox/issues/1245)) ([ff30a4e](https://github.com/fgarofalo56/csa-inabox/commit/ff30a4ec6040d5b0708346499f113f5d1847f3a9))

## [0.38.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.37.0...csa-inabox-v0.38.0) (2026-06-11)


### Features

* **csa-loom:** best-in-class Copilot chat console overhaul (audit-T121) ([#1224](https://github.com/fgarofalo56/csa-inabox/issues/1224)) ([7a00b87](https://github.com/fgarofalo56/csa-inabox/commit/7a00b873d7a39e76fb03c001760ba391f2b39912))
* **csa-loom:** clarify RTI catalog vs Real-Time hub + make streams usable/testable (audit-t135) ([#1219](https://github.com/fgarofalo56/csa-inabox/issues/1219)) ([46c4120](https://github.com/fgarofalo56/csa-inabox/commit/46c4120d2c40bf2914d28bb1127b35ecfe37371d))
* **csa-loom:** close Capacity & compute scale-UI gaps (audit-t107) ([#1196](https://github.com/fgarofalo56/csa-inabox/issues/1196)) ([8a2cf67](https://github.com/fgarofalo56/csa-inabox/commit/8a2cf674089a2085ebbcebb94a64dd118f46d7d4))
* **csa-loom:** configure Unity Catalog by default (audit-t139) ([#1225](https://github.com/fgarofalo56/csa-inabox/issues/1225)) ([b16205c](https://github.com/fgarofalo56/csa-inabox/commit/b16205c10d05f40afd447375aa0361ea91628f6a))
* **csa-loom:** data-agent page full lifecycle management (audit-t122) ([#1223](https://github.com/fgarofalo56/csa-inabox/issues/1223)) ([b2ab131](https://github.com/fgarofalo56/csa-inabox/commit/b2ab13138f63aed53d093ac3ce6151e167ff1337))
* **csa-loom:** dbt visual model/project builder + Azure-native run (audit-t144) ([#1232](https://github.com/fgarofalo56/csa-inabox/issues/1232)) ([5fa99f6](https://github.com/fgarofalo56/csa-inabox/commit/5fa99f65b6aa79b2bb9af3b68229b446a87dd54e))
* **csa-loom:** deploy-planner all-Azure-service nodes + Atlas Diag icon slugs (audit-T119) ([#1215](https://github.com/fgarofalo56/csa-inabox/issues/1215)) ([efa3b5f](https://github.com/fgarofalo56/csa-inabox/commit/efa3b5f92079e4bd7b1fdec3dd20d1b4850600e2))
* **csa-loom:** deploy-planner architecture builder — per-resource config + connections + bicep-synced export (audit-T132) ([#1210](https://github.com/fgarofalo56/csa-inabox/issues/1210)) ([01c33d5](https://github.com/fgarofalo56/csa-inabox/commit/01c33d5780b6dcf0b315decbcc00b301987eccdb))
* **csa-loom:** deploy-planner Estimate cost via Azure Retail Prices API (audit-t133) ([#1211](https://github.com/fgarofalo56/csa-inabox/issues/1211)) ([2c0f2db](https://github.com/fgarofalo56/csa-inabox/commit/2c0f2dbfbfceb845396df9563882979cc5515ef0))
* **csa-loom:** finish Plan (preview) EPM/CPM editor (audit-T64) ([#1233](https://github.com/fgarofalo56/csa-inabox/issues/1233)) ([2b99314](https://github.com/fgarofalo56/csa-inabox/commit/2b99314adb08d72efc391e0ff519e91487098d34))
* **csa-loom:** full MIP management — fix label-policy 400 + label/policy CRUD + apply-label wizard (audit-t126) ([#1201](https://github.com/fgarofalo56/csa-inabox/issues/1201)) ([e139be4](https://github.com/fgarofalo56/csa-inabox/commit/e139be4fb81f98c2cbba0b11353afb2257430585))
* **csa-loom:** lineage auto-reconcile on delete + clickable Weave graph (audit-t137) ([#1217](https://github.com/fgarofalo56/csa-inabox/issues/1217)) ([f6b4980](https://github.com/fgarofalo56/csa-inabox/commit/f6b49807f68dcdeb70452011d2dbde915c16c298))
* **csa-loom:** MDM + Data Quality governance surface (audit-T143) ([#1228](https://github.com/fgarofalo56/csa-inabox/issues/1228)) ([2cb069e](https://github.com/fgarofalo56/csa-inabox/commit/2cb069e3b08e0aa74e9b0ab0d25625fcd3575414))
* **csa-loom:** Network & DNS visual topology — NSGs, real edges, clickable detail (audit-t131) ([#1208](https://github.com/fgarofalo56/csa-inabox/issues/1208)) ([d08e506](https://github.com/fgarofalo56/csa-inabox/commit/d08e5069172c9b2d46b40b3002f601db23fbe7d1))
* **csa-loom:** Organizational visuals Description + Icon parity (audit-t129) ([#1207](https://github.com/fgarofalo56/csa-inabox/issues/1207)) ([6978bec](https://github.com/fgarofalo56/csa-inabox/commit/6978bec52c054422355bb03b12354b3646e16441))
* **csa-loom:** persist Databricks metastore registration + UC attach + Purview scan (audit-t141) ([#1226](https://github.com/fgarofalo56/csa-inabox/issues/1226)) ([e52c98c](https://github.com/fgarofalo56/csa-inabox/commit/e52c98c3ed5b322f015bdc7ef64c6d3b6f381162))
* **csa-loom:** Rayfin Fabric-Apps visual app builder + wizard (audit-T145) ([#1230](https://github.com/fgarofalo56/csa-inabox/issues/1230)) ([e82e021](https://github.com/fgarofalo56/csa-inabox/commit/e82e021600dd6bba777c7ce1fcc30bbd4973eada))
* **csa-loom:** redesign /apps page onto Loom UI primitives (audit-t110) ([#1192](https://github.com/fgarofalo56/csa-inabox/issues/1192)) ([955b2da](https://github.com/fgarofalo56/csa-inabox/commit/955b2da52540c0181b6845963b13df2c53db5893))
* **csa-loom:** registry-driven Workload hub create-by-workload launcher (audit-t123) ([#1222](https://github.com/fgarofalo56/csa-inabox/issues/1222)) ([c891d4a](https://github.com/fgarofalo56/csa-inabox/commit/c891d4aaf46cc69edd7be419f6a87b9ae4470517))
* **csa-loom:** RTI hub source binding via real subscription dropdowns + create-if-missing (audit-t134) ([#1218](https://github.com/fgarofalo56/csa-inabox/issues/1218)) ([d8c8595](https://github.com/fgarofalo56/csa-inabox/commit/d8c8595ec7173f6f7b93a6a59e35dd22e757adcd))
* **csa-loom:** setup wizard sub defaulting + full regions + visual review + deploy orchestrator (audit-t142) ([#1227](https://github.com/fgarofalo56/csa-inabox/issues/1227)) ([82db886](https://github.com/fgarofalo56/csa-inabox/commit/82db886d924625d340689d78c03f8d214b8de098))
* **csa-loom:** tile view + ViewToggle on connections, thread, data-products (audit-t113) ([#1205](https://github.com/fgarofalo56/csa-inabox/issues/1205)) ([3dcb57c](https://github.com/fgarofalo56/csa-inabox/commit/3dcb57cb9b6c6658451eb286f2ca3a15b1166ba0))
* **csa-loom:** true async app install with progress polling (audit-t108) ([#1199](https://github.com/fgarofalo56/csa-inabox/issues/1199)) ([ee4200b](https://github.com/fgarofalo56/csa-inabox/commit/ee4200b822f82d27476d07b011c5fcac0b5d2a71))
* **csa-loom:** unified domain mapping — editable collections/subcollections + move + Purview⇄Unity Catalog (audit-t140) ([#1229](https://github.com/fgarofalo56/csa-inabox/issues/1229)) ([c4a0df2](https://github.com/fgarofalo56/csa-inabox/commit/c4a0df2f587ed1abd5abf2e32f037d6cad44e0bc))
* **csa-loom:** unified lineage — Purview + Unity Catalog + Weave one graph (audit-t138) ([#1221](https://github.com/fgarofalo56/csa-inabox/issues/1221)) ([629eeab](https://github.com/fgarofalo56/csa-inabox/commit/629eeab55fbf6436fadc0767616f3f8fd0f1ab4d))


### Bug Fixes

* **csa-loom:** API marketplace subscription-key 401 + Try console + working curl (audit-t136) ([#1220](https://github.com/fgarofalo56/csa-inabox/issues/1220)) ([98c6469](https://github.com/fgarofalo56/csa-inabox/commit/98c646967caf499024470d75f2a3e187bddc9bfa))
* **csa-loom:** bound server fetches + fast-fail client spinners; wire page-load timing harness (audit-t106) ([#1198](https://github.com/fgarofalo56/csa-inabox/issues/1198)) ([c77bc54](https://github.com/fgarofalo56/csa-inabox/commit/c77bc54904e56bb07a563a24a350da57415f1790))
* **csa-loom:** Copilot usage panel "could not load" — robust read + ingestion enabled (audit-t130) ([#1206](https://github.com/fgarofalo56/csa-inabox/issues/1206)) ([3b46178](https://github.com/fgarofalo56/csa-inabox/commit/3b46178f84f23c1ff8928f49f6812cda1b868105))
* **csa-loom:** fix APIM admin pane "Unexpected token" crash (audit-t124) ([#1197](https://github.com/fgarofalo56/csa-inabox/issues/1197)) ([ca7d5a8](https://github.com/fgarofalo56/csa-inabox/commit/ca7d5a8f9505e7fb96bf1f17e032188566b0c645))
* **csa-loom:** pin data-agent composer so Send is always visible (audit-t118) ([#1212](https://github.com/fgarofalo56/csa-inabox/issues/1212)) ([ddb4124](https://github.com/fgarofalo56/csa-inabox/commit/ddb41241cc670dd5205158abebd99d0930b223f6))
* **csa-loom:** Purview admin pane honors 403 as honest gate (audit-t125) ([#1193](https://github.com/fgarofalo56/csa-inabox/issues/1193)) ([041e245](https://github.com/fgarofalo56/csa-inabox/commit/041e24521dab35d488d83b298a144b973f8c4002))
* **csa-loom:** resolve plan-editor type errors from audit-t146 merge ([#1238](https://github.com/fgarofalo56/csa-inabox/issues/1238)) ([57cd8c6](https://github.com/fgarofalo56/csa-inabox/commit/57cd8c616913b221af89d5ae86b74d4d6c43fbc5))
* **csa-loom:** resolve type collisions surfaced by dbt merge (audit-t144) ([#1237](https://github.com/fgarofalo56/csa-inabox/issues/1237)) ([e5b15ad](https://github.com/fgarofalo56/csa-inabox/commit/e5b15ad30e3c2093d52363bb15cfa63098ad0380))
* **csa-loom:** stop federated-search clipping the catalog sidebar rule ([#1213](https://github.com/fgarofalo56/csa-inabox/issues/1213)) ([a2b61f0](https://github.com/fgarofalo56/csa-inabox/commit/a2b61f02251a89e5a63cb1f13278896b31856ae7))
* **csa-loom:** wire Admin DLP by default + fix bootstrap GUID & Graph segment (audit-T127) ([#1195](https://github.com/fgarofalo56/csa-inabox/issues/1195)) ([b21f595](https://github.com/fgarofalo56/csa-inabox/commit/b21f59574bd7589b113af1dcf2a35e44f04feeb1))
* **csa-loom:** wire Embed codes backend by default + fix multi-sub phantom storage account (audit-T128) ([#1194](https://github.com/fgarofalo56/csa-inabox/issues/1194)) ([f2b692b](https://github.com/fgarofalo56/csa-inabox/commit/f2b692b79f902417bb1349fb19b66a8be3907449))


### Code Refactoring

* **csa-loom:** inline-style sweep on primitive-wired pages (audit-t115) ([#1209](https://github.com/fgarofalo56/csa-inabox/issues/1209)) ([4d02cf7](https://github.com/fgarofalo56/csa-inabox/commit/4d02cf73585ab881cae53314ef5182ac7a1f9920))
* **csa-loom:** realtime-hub-view makeStyles + Tile/List view + icon-quality (audit-t114) ([#1203](https://github.com/fgarofalo56/csa-inabox/issues/1203)) ([37fba73](https://github.com/fgarofalo56/csa-inabox/commit/37fba731876e5ba553e01f66dd8d5ed2cfef2238))
* **csa-loom:** rebuild /admin/scaling with Fluent Card + LoomDataTable (audit-t111) ([#1204](https://github.com/fgarofalo56/csa-inabox/issues/1204)) ([383e6e8](https://github.com/fgarofalo56/csa-inabox/commit/383e6e8fbb719414bfe5665fcc2fbff36b7e04a6))
* **csa-loom:** rebuild /workspaces on Loom UI primitives (audit-t109) ([#1200](https://github.com/fgarofalo56/csa-inabox/issues/1200)) ([9ebcb77](https://github.com/fgarofalo56/csa-inabox/commit/9ebcb776526e68eb4ea2245346c87972709dd3fa))
* **csa-loom:** redesign catalog/metastores page with Loom primitives (audit-t112) ([#1202](https://github.com/fgarofalo56/csa-inabox/issues/1202)) ([fabab96](https://github.com/fgarofalo56/csa-inabox/commit/fabab9671fa9c40bb9ee002fb3b8be801d95ea18))


### Performance Improvements

* **csa-loom:** speed up Monitor load — TTL memo + ARG health fast path + activities debounce (audit-t117) ([#1214](https://github.com/fgarofalo56/csa-inabox/issues/1214)) ([091f68d](https://github.com/fgarofalo56/csa-inabox/commit/091f68d119f04197da17f8e1fded7cb182e3380f))

## [0.37.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.36.0...csa-inabox-v0.37.0) (2026-06-11)


### Features

* **csa-loom:** Azure DevOps pipeline task for Loom deploys (audit-t91) ([#1177](https://github.com/fgarofalo56/csa-inabox/issues/1177)) ([de83280](https://github.com/fgarofalo56/csa-inabox/commit/de83280fa182e9a8f4ab2aca24f5a608fb237eff))
* **csa-loom:** bind Azure Maps account to env + prefill geo surfaces (audit-t94) ([#1178](https://github.com/fgarofalo56/csa-inabox/issues/1178)) ([2543cad](https://github.com/fgarofalo56/csa-inabox/commit/2543cad4b26746ffb1ef271e1afa5068ee910cfc))
* **csa-loom:** BYO wizard + bicepparam generator (existing&lt;Svc&gt;{Name,Rg,Sub} for every service) (audit-t93) ([#1182](https://github.com/fgarofalo56/csa-inabox/issues/1182)) ([6c0bd8e](https://github.com/fgarofalo56/csa-inabox/commit/6c0bd8edbc665d782a81798e0f74a42d8d265a71))
* **csa-loom:** deepen Purview auto-classification + scan trigger (audit-t104) ([#1189](https://github.com/fgarofalo56/csa-inabox/issues/1189)) ([0c3b2b7](https://github.com/fgarofalo56/csa-inabox/commit/0c3b2b737951b1f4ff1bedb94e8ffbe954f7aad3))
* **csa-loom:** DLP restrict-access for ADLS Gen2 paths + Synapse SQL schemas (audit-t99) ([#1185](https://github.com/fgarofalo56/csa-inabox/issues/1185)) ([f7e1fb9](https://github.com/fgarofalo56/csa-inabox/commit/f7e1fb9ee424917351e77f8ed75d5cb6f0e1d9f3))
* **csa-loom:** DSPM-for-AI posture report (audit-t100) ([#1187](https://github.com/fgarofalo56/csa-inabox/issues/1187)) ([940b324](https://github.com/fgarofalo56/csa-inabox/commit/940b3249733b2c78785cec2584cd46b428d5439e))
* **csa-loom:** GitHub Enterprise Cloud (ghe.com) Git integration (audit-t89) ([#1174](https://github.com/fgarofalo56/csa-inabox/issues/1174)) ([4d8c922](https://github.com/fgarofalo56/csa-inabox/commit/4d8c922d39e07f9bed6f68c0a007c94bc2fd3ca4))
* **csa-loom:** guided dataset location/format builder (audit-T96) ([#1179](https://github.com/fgarofalo56/csa-inabox/issues/1179)) ([c27ed60](https://github.com/fgarofalo56/csa-inabox/commit/c27ed60160ede01af8fecac8e2862fca749852b3))
* **csa-loom:** honest VNet data gateway tenant gate in Network UI (audit-t98) ([#1183](https://github.com/fgarofalo56/csa-inabox/issues/1183)) ([acf2c96](https://github.com/fgarofalo56/csa-inabox/commit/acf2c963ff839e10088841470c9a36e73a090d2e))
* **csa-loom:** IRM-for-Lakehouse insider-risk indicators dashboard (audit-t101) ([#1186](https://github.com/fgarofalo56/csa-inabox/issues/1186)) ([7e421bb](https://github.com/fgarofalo56/csa-inabox/commit/7e421bb542571131b5e827f9cf1712f4200e72fb))
* **csa-loom:** item editors pick classifications from the tenant taxonomy (audit-t103) ([#1188](https://github.com/fgarofalo56/csa-inabox/issues/1188)) ([f2dbf21](https://github.com/fgarofalo56/csa-inabox/commit/f2dbf2175f4a2235f8fdaa4a9e1f4d60aa347934))
* **csa-loom:** MCP copy-job + dataflow author/run tools (audit-t92) ([#1173](https://github.com/fgarofalo56/csa-inabox/issues/1173)) ([0ce6525](https://github.com/fgarofalo56/csa-inabox/commit/0ce6525bd3e6bfcf29dabf21016fcfe5ddaa68a8))
* **csa-loom:** ongoing CDC for PostgreSQL + Cosmos + Snowflake ADF copy runtime (audit-t105) ([#1190](https://github.com/fgarofalo56/csa-inabox/issues/1190)) ([8fb91d6](https://github.com/fgarofalo56/csa-inabox/commit/8fb91d612f7a8cfc255347d7a11cbd66032c956e))
* **csa-loom:** publish loom CLI npm package wrapping the Loom REST API (audit-t90) ([#1176](https://github.com/fgarofalo56/csa-inabox/issues/1176)) ([0cd39ab](https://github.com/fgarofalo56/csa-inabox/commit/0cd39ab7aa6def3725b66b55be7fbd1c188930ed))
* **csa-loom:** shared admin-zone Purview SHIR + auto-scale-up on trigger (audit-t97) ([#1181](https://github.com/fgarofalo56/csa-inabox/issues/1181)) ([31599d1](https://github.com/fgarofalo56/csa-inabox/commit/31599d11bc3ca87172ec42494a912140b68e287c))


### Bug Fixes

* **csa-loom:** enforce warehouse + ADX access-policy grants (audit-t102) ([#1184](https://github.com/fgarofalo56/csa-inabox/issues/1184)) ([cb12c17](https://github.com/fgarofalo56/csa-inabox/commit/cb12c17067e83a71bea0439658ce830870933a53))
* **csa-loom:** parenthesize ??/|| mix in IRM SpinButton onChange handlers ([#1191](https://github.com/fgarofalo56/csa-inabox/issues/1191)) ([2af8550](https://github.com/fgarofalo56/csa-inabox/commit/2af855011a207478f34154e5408a4bcbe4036378))
* **csa-loom:** use valid DatabasePlugConnected20Regular icon in SQL migration wizard ([#1171](https://github.com/fgarofalo56/csa-inabox/issues/1171)) ([39dd8c4](https://github.com/fgarofalo56/csa-inabox/commit/39dd8c440cf518fcb0c9aa8548ba9f658c6f9ceb))
* **csa-loom:** wire Gremlin Cosmos account into Console env + add private DNS zone (audit-t95) ([#1180](https://github.com/fgarofalo56/csa-inabox/issues/1180)) ([4d20bdb](https://github.com/fgarofalo56/csa-inabox/commit/4d20bdb038572f1f8ca129d6389cac9a6cf3137c))


### Documentation

* **loom-skills:** Azure-native client-pattern skills bundle for AI coding agents (audit-t88) ([#1175](https://github.com/fgarofalo56/csa-inabox/issues/1175)) ([55d8b3e](https://github.com/fgarofalo56/csa-inabox/commit/55d8b3e1b66e81c5dc72c8d31de21b43a3bc79b5))

## [0.36.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.35.0...csa-inabox-v0.36.0) (2026-06-11)


### Features

* **csa-loom:** admin runtime env/config management UI (audit-t49) ([#1164](https://github.com/fgarofalo56/csa-inabox/issues/1164)) ([fb4421f](https://github.com/fgarofalo56/csa-inabox/commit/fb4421f2a426f3dfd2c6ace4eefeeddf8fac1930))
* **csa-loom:** convert all Supercharge-Fabric notebooks to Loom-native bundles (audit-t40) ([#1162](https://github.com/fgarofalo56/csa-inabox/issues/1162)) ([8529fa1](https://github.com/fgarofalo56/csa-inabox/commit/8529fa14c4f5c3986614f977799668f8cf0ce7e9))
* **csa-loom:** deep-link 40 use-case LearnTopics + app-install links (audit-t37) ([#1158](https://github.com/fgarofalo56/csa-inabox/issues/1158)) ([e83dde3](https://github.com/fgarofalo56/csa-inabox/commit/e83dde3c183a05a31f4826868e1f73b34119b0b5))
* **csa-loom:** deep-link Learn use cases + enforce Loom-docs-first links (audit-T43) ([#1165](https://github.com/fgarofalo56/csa-inabox/issues/1165)) ([f30521b](https://github.com/fgarofalo56/csa-inabox/commit/f30521b6d1c550a7d8b145ef319db2157e3c225b))
* **csa-loom:** guided in-product onboarding tour (audit-t42) ([#1168](https://github.com/fgarofalo56/csa-inabox/issues/1168)) ([136c39a](https://github.com/fgarofalo56/csa-inabox/commit/136c39a64ada788a413dfa6a08993ce002eff93f))
* **csa-loom:** Learning Hub Copilot — tutorial-step context + auto-error-detect + apply-fix (audit-T41) ([#1167](https://github.com/fgarofalo56/csa-inabox/issues/1167)) ([1e76449](https://github.com/fgarofalo56/csa-inabox/commit/1e7644928efbdc2d6eb8bda6fe61a9e87e377f59))
* **csa-loom:** Learning-Hub notebook import wizard (audit-t39) ([#1157](https://github.com/fgarofalo56/csa-inabox/issues/1157)) ([8adff00](https://github.com/fgarofalo56/csa-inabox/commit/8adff0021660381524e6aba953e26df63c8726a7))
* **csa-loom:** MCP browse-catalog + deploy wizard (per-field KV secrets) (audit-t45) ([#1163](https://github.com/fgarofalo56/csa-inabox/issues/1163)) ([9fa6ecd](https://github.com/fgarofalo56/csa-inabox/commit/9fa6ecd726ed31e17da87f8cfba14aa39fbc9a32))
* **csa-loom:** MCP catalog deploy/status/delete BFF + bicep (audit-t48) ([#1166](https://github.com/fgarofalo56/csa-inabox/issues/1166)) ([92aadeb](https://github.com/fgarofalo56/csa-inabox/commit/92aadeb088dda8d15392a22abff37239e36e435c))
* **csa-loom:** MCP deploy-to-Container-Apps + Azure Files mount (audit-t46) ([#1161](https://github.com/fgarofalo56/csa-inabox/issues/1161)) ([29f96d0](https://github.com/fgarofalo56/csa-inabox/commit/29f96d00b6cbfe5574e0873d9b05dfdf8bbb53b4))
* **csa-loom:** MCP deployable-catalog data file (audit-t44) ([#1159](https://github.com/fgarofalo56/csa-inabox/issues/1159)) ([af2322c](https://github.com/fgarofalo56/csa-inabox/commit/af2322c9c6ad0937f5dc8e32e3be27ea5081fbcc))
* **csa-loom:** MCP stdio-&gt;HTTP/SSE bridge for npx/uvx servers (audit-t47) ([#1160](https://github.com/fgarofalo56/csa-inabox/issues/1160)) ([be7a955](https://github.com/fgarofalo56/csa-inabox/commit/be7a955cd8d8c904ca6de3aff71617a6c35fdbd8))
* **csa-loom:** wire Learn use-case "Install live example" wizard (audit-t38) ([#1156](https://github.com/fgarofalo56/csa-inabox/issues/1156)) ([d895a2e](https://github.com/fgarofalo56/csa-inabox/commit/d895a2e0fd03d16c6b9217d7645742722b0d3c2e))


### Bug Fixes

* **csa-loom:** close JSX expression in palantir AIP-Logic editor ([#1154](https://github.com/fgarofalo56/csa-inabox/issues/1154)) ([2cd5bcd](https://github.com/fgarofalo56/csa-inabox/commit/2cd5bcde8e41380d76956cc4fff0362844fc8ec4))
* **csa-loom:** remove orphaned JSX close from learn app-install merge ([#1169](https://github.com/fgarofalo56/csa-inabox/issues/1169)) ([88adcf9](https://github.com/fgarofalo56/csa-inabox/commit/88adcf9d342ab0a6026e0ef23f1b9ddc29c1219b))
* **csa-loom:** use style weight for Body2 in mcp-servers panel ([#1170](https://github.com/fgarofalo56/csa-inabox/issues/1170)) ([ed3e21a](https://github.com/fgarofalo56/csa-inabox/commit/ed3e21a5a3c2cc7c50de8ad06b59f47dcd7ded7f))

## [0.35.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.34.0...csa-inabox-v0.35.0) (2026-06-11)


### Features

* **csa-loom:** all-3-dimension tutorial capture + coverage gate (audit-t33) ([#1148](https://github.com/fgarofalo56/csa-inabox/issues/1148)) ([5599394](https://github.com/fgarofalo56/csa-inabox/commit/5599394a2fe6e1e109dbfa0dfc99e30c6e0a1ad6))
* **csa-loom:** Palantir migration surfaces as Azure-native item types (audit-T29) ([#1151](https://github.com/fgarofalo56/csa-inabox/issues/1151)) ([7b5e070](https://github.com/fgarofalo56/csa-inabox/commit/7b5e070d037eeca14deb266fdc50e9a82baa5bbc))
* **csa-loom:** wire + verify IL5/GCC-High full-stack deploy (A-4/PMF-64) ([#1149](https://github.com/fgarofalo56/csa-inabox/issues/1149)) ([86968e7](https://github.com/fgarofalo56/csa-inabox/commit/86968e7468f40608a75c80fac74aa470043b26dd))


### Bug Fixes

* **csa-loom:** block self-referential deployment pipelines (C-86 promote error) ([#1146](https://github.com/fgarofalo56/csa-inabox/issues/1146)) ([ae03947](https://github.com/fgarofalo56/csa-inabox/commit/ae03947a2d6b9434812123aef8a3d8e05138b00b))


### Documentation

* **csa-loom:** honest-gap disclosure for Foundry Phonograph / IL6 / writeback (audit-T35) ([#1145](https://github.com/fgarofalo56/csa-inabox/issues/1145)) ([e2dbedb](https://github.com/fgarofalo56/csa-inabox/commit/e2dbedb89259f3c99ee6bbf9e0d9fc7df56f3eba))
* **csa-loom:** PRP-21/22/23/25 marketing+workshops+use-cases+solution-store (audit-T32) ([#1150](https://github.com/fgarofalo56/csa-inabox/issues/1150)) ([eb3ef9b](https://github.com/fgarofalo56/csa-inabox/commit/eb3ef9b3ad7d778f652ae9077f609367a99d8e57))
* **csa-loom:** Wave-4 parity-doc re-audit + Scorecard rev.6 (audit-T31) ([#1147](https://github.com/fgarofalo56/csa-inabox/issues/1147)) ([a3650e9](https://github.com/fgarofalo56/csa-inabox/commit/a3650e98a01a05801e737d9681d1ac0edeea29fe))


### Miscellaneous

* **csa-loom:** hardcode deterministic WAVE_IDS map in fast builder ([#1152](https://github.com/fgarofalo56/csa-inabox/issues/1152)) ([879d883](https://github.com/fgarofalo56/csa-inabox/commit/879d883286780ba33b60e1b2dd1ed768bb802d04))

## [0.34.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.33.0...csa-inabox-v0.34.0) (2026-06-10)


### Features

* **csa-loom:** AutoML low-code wizard over Azure ML AutoML (audit-t87) ([#1128](https://github.com/fgarofalo56/csa-inabox/issues/1128)) ([3c45fed](https://github.com/fgarofalo56/csa-inabox/commit/3c45fed5deb4eab8475c342548e448ddfe55f034))
* **csa-loom:** BigQuery + Oracle mirror source wizard (audit-t80) ([#1109](https://github.com/fgarofalo56/csa-inabox/issues/1109)) ([aa06e66](https://github.com/fgarofalo56/csa-inabox/commit/aa06e663fbec397277d7cffff58ddc49fc4eee71))
* **csa-loom:** bulk AI auto-description for semantic models (audit-T83) ([#1125](https://github.com/fgarofalo56/csa-inabox/issues/1125)) ([3e9812e](https://github.com/fgarofalo56/csa-inabox/commit/3e9812e0df9dddb4d54381a1c7b7df4257e3dbbf))
* **csa-loom:** Business Events publishing surface (Activator structured signals) (audit-T72) ([#1101](https://github.com/fgarofalo56/csa-inabox/issues/1101)) ([7216cd4](https://github.com/fgarofalo56/csa-inabox/commit/7216cd4b4ae4f50a14784e0bb2c9ff034a764dfd))
* **csa-loom:** Copilot edits semantic-model structure (NL pane + checkpoints) (audit-t82) ([#1117](https://github.com/fgarofalo56/csa-inabox/issues/1117)) ([8ea3818](https://github.com/fgarofalo56/csa-inabox/commit/8ea3818fce9599eba28788c145703dbfc472c4fc))
* **csa-loom:** Copy job native CDC mode for SQL sources (audit-t79) ([#1108](https://github.com/fgarofalo56/csa-inabox/issues/1108)) ([3b9f23f](https://github.com/fgarofalo56/csa-inabox/commit/3b9f23f5cfc4f7e71383743872a6b4913028192e))
* **csa-loom:** Eventstream code-first T-SQL operator tab (audit-t66) ([#1096](https://github.com/fgarofalo56/csa-inabox/issues/1096)) ([04a7946](https://github.com/fgarofalo56/csa-inabox/commit/04a7946d53e25eccb792e343c02033c9de4330ec))
* **csa-loom:** eventstream MQTT secure mTLS source with Key Vault cert pickers ([#1123](https://github.com/fgarofalo56/csa-inabox/issues/1123)) ([a8053b1](https://github.com/fgarofalo56/csa-inabox/commit/a8053b1344ed5aedd50f72ae9b23a91d023edcef))
* **csa-loom:** Eventstream ribbon Add-alert creates linked Activator (audit-t67) ([#1092](https://github.com/fgarofalo56/csa-inabox/issues/1092)) ([9ec45f8](https://github.com/fgarofalo56/csa-inabox/commit/9ec45f87c57054a14f875490ee3d7787c5192864))
* **csa-loom:** lakehouse "Expose as Iceberg" V2 endpoint via Delta UniForm ([#1095](https://github.com/fgarofalo56/csa-inabox/issues/1095)) ([ea4908a](https://github.com/fgarofalo56/csa-inabox/commit/ea4908ad8e6579774f0ef8135fb29ab4ce0b5314))
* **csa-loom:** Materialized Lake Views item type (audit-t65) ([#1104](https://github.com/fgarofalo56/csa-inabox/issues/1104)) ([0d0ad44](https://github.com/fgarofalo56/csa-inabox/commit/0d0ad44f33ad1aeff03979c2b63b55008a408426))
* **csa-loom:** MCP data-movement tools (pipelines/copy-jobs/dataflows) ([#1142](https://github.com/fgarofalo56/csa-inabox/issues/1142)) ([0d13fb8](https://github.com/fgarofalo56/csa-inabox/commit/0d13fb8d1a6ffb02c12cb1a4ea5dc956a86d2a64))
* **csa-loom:** model-bound Rayfin app builder over semantic models (audit-t84) ([#1129](https://github.com/fgarofalo56/csa-inabox/issues/1129)) ([20e3f00](https://github.com/fgarofalo56/csa-inabox/commit/20e3f008ebfa106e39c3498adb0df34ab83880a0))
* **csa-loom:** OneLake item-size reporting (audit-T73) ([#1099](https://github.com/fgarofalo56/csa-inabox/issues/1099)) ([e68f473](https://github.com/fgarofalo56/csa-inabox/commit/e68f4739d604663fa954f2894c7cfbd69a4a908a))
* **csa-loom:** OneLake shortcuts to SharePoint/OneDrive via Microsoft Graph ([#1102](https://github.com/fgarofalo56/csa-inabox/issues/1102)) ([5e97513](https://github.com/fgarofalo56/csa-inabox/commit/5e97513b7d69adbe4574b4221297370de13d4396))
* **csa-loom:** publish data agent to M365 Copilot via Copilot Studio (audit-t85) ([#1126](https://github.com/fgarofalo56/csa-inabox/issues/1126)) ([33f623d](https://github.com/fgarofalo56/csa-inabox/commit/33f623d8f01e059c75b7f7c74e7852ac88c52244))
* **csa-loom:** RTI dashboard 5s live-refresh interval + pile-up guard ([#1111](https://github.com/fgarofalo56/csa-inabox/issues/1111)) ([106acc7](https://github.com/fgarofalo56/csa-inabox/commit/106acc7b4fb95c812e0750e52af8409b10af5612))
* **csa-loom:** RTI dashboard AI tile editor (NL → KQL) (audit-t70) ([#1114](https://github.com/fgarofalo56/csa-inabox/issues/1114)) ([a3ea6fd](https://github.com/fgarofalo56/csa-inabox/commit/a3ea6fd66342b876df5754ec61725b3125c91508))
* **csa-loom:** RTI dashboard time-series visualization controls (audit-t71) ([#1094](https://github.com/fgarofalo56/csa-inabox/issues/1094)) ([cb55f65](https://github.com/fgarofalo56/csa-inabox/commit/cb55f6545429c066a520abf96a95a08650a7fec9))
* **csa-loom:** Snowflake "Include Iceberg tables" option in mirror wizard ([#1105](https://github.com/fgarofalo56/csa-inabox/issues/1105)) ([73b2b80](https://github.com/fgarofalo56/csa-inabox/commit/73b2b80fcea8acb7c9db7570f914895cc105d3b9))
* **csa-loom:** SQL DB full-text + vector index management tabs (audit-t78) ([#1106](https://github.com/fgarofalo56/csa-inabox/issues/1106)) ([a7a4263](https://github.com/fgarofalo56/csa-inabox/commit/a7a42637a6537169cad28fc3561c7c993e1d1e39))
* **csa-loom:** SQL DB migration assistant (DACPAC import + compatibility scan) ([#1098](https://github.com/fgarofalo56/csa-inabox/issues/1098)) ([9b69371](https://github.com/fgarofalo56/csa-inabox/commit/9b693717a41b3bb3ab4356a731d19bc6067c2279))
* **csa-loom:** unified Fabric IQ MCP tool surface for external agents (audit-t86) ([#1127](https://github.com/fgarofalo56/csa-inabox/issues/1127)) ([078e2e2](https://github.com/fgarofalo56/csa-inabox/commit/078e2e2bee46c8fa7fab08b5ad2a9aa9ab370247))
* **csa-loom:** warehouse query-acceleration toggle + honest GPU gate (audit-t76) ([#1091](https://github.com/fgarofalo56/csa-inabox/issues/1091)) ([b0e5ed3](https://github.com/fgarofalo56/csa-inabox/commit/b0e5ed395ef687e6b19287378265c980527eda35))

## [0.33.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.32.0...csa-inabox-v0.33.0) (2026-06-10)


### Features

* **csa-loom:** ADX cluster lifecycle + RBAC principal mgmt + RLS authoring ([#1076](https://github.com/fgarofalo56/csa-inabox/issues/1076)) ([74c0244](https://github.com/fgarofalo56/csa-inabox/commit/74c0244d2580365b8000f251c709703f9b53d2e4))
* **csa-loom:** AI Foundry fine-tuning, evals run/upload, span-tree tracing + Images/Audio playgrounds ([#1078](https://github.com/fgarofalo56/csa-inabox/issues/1078)) ([2849d66](https://github.com/fgarofalo56/csa-inabox/commit/2849d66b259fe7053469ef40208f70552625f97b))
* **csa-loom:** AI Search indexer scheduling + semantic/vector designers + debug sessions ([#1077](https://github.com/fgarofalo56/csa-inabox/issues/1077)) ([71f8a9c](https://github.com/fgarofalo56/csa-inabox/commit/71f8a9cf9e5c302de0e08204d4a2ea7206913c56))
* **csa-loom:** Databricks UC write-path + DLT/MLflow/Serving + lineage (audit-t18) ([#1073](https://github.com/fgarofalo56/csa-inabox/issues/1073)) ([80bba45](https://github.com/fgarofalo56/csa-inabox/commit/80bba455451cae51ea961c04bb8777cba78e30f0))
* **csa-loom:** Monitor alert-rule authoring (create/edit/enable/delete) ([#1082](https://github.com/fgarofalo56/csa-inabox/issues/1082)) ([1d946e9](https://github.com/fgarofalo56/csa-inabox/commit/1d946e97fc7966707f8b639627844aac31e40768))
* **csa-loom:** Power Platform maker authoring in-Loom (canvas/flow/table) ([#1086](https://github.com/fgarofalo56/csa-inabox/issues/1086)) ([ea1bef8](https://github.com/fgarofalo56/csa-inabox/commit/ea1bef8a1afdc689913511b3f4c78a2d11ad73e9))
* **csa-loom:** SQL DB keys & constraints inline designer (audit-t24) ([#1081](https://github.com/fgarofalo56/csa-inabox/issues/1081)) ([a095ab5](https://github.com/fgarofalo56/csa-inabox/commit/a095ab5f46758d38691dd9c45382a35c4bb4b17e))
* **csa-loom:** UC write-path — ownership transfer + catalog type + tags (audit-t18) ([#1074](https://github.com/fgarofalo56/csa-inabox/issues/1074)) ([9e56044](https://github.com/fgarofalo56/csa-inabox/commit/9e56044342c6ffc95ebc30e6d3378ac33c3b0145))
* **csa-loom:** wire ADF Change Data Capture (preview) REST + editor ([#1080](https://github.com/fgarofalo56/csa-inabox/issues/1080)) ([4759a29](https://github.com/fgarofalo56/csa-inabox/commit/4759a2930e4fc6704322df3de50c286b22fbbab0))
* **csa-loom:** wire Cosmos conflict-resolution policy (audit-T27) ([#1083](https://github.com/fgarofalo56/csa-inabox/issues/1083)) ([d0346e8](https://github.com/fgarofalo56/csa-inabox/commit/d0346e8298afc1ecbff7578a53042e2c53283b02))
* **csa-loom:** wire Event Hubs Capture / Geo-DR / SAS rotation / private endpoints ([#1075](https://github.com/fgarofalo56/csa-inabox/issues/1075)) ([66b1e13](https://github.com/fgarofalo56/csa-inabox/commit/66b1e13a1ee95b94fb3f7721ce779dcfa2becc03))
* **csa-loom:** wire EventhouseEditor "New dashboard" ribbon to real creation flow ([#1072](https://github.com/fgarofalo56/csa-inabox/issues/1072)) ([9a5ae72](https://github.com/fgarofalo56/csa-inabox/commit/9a5ae721d64c2b09ab408adbade2b9e24934decd))
* **csa-loom:** wire Synapse KQL scripts + Spark job definitions in workspace tree ([#1084](https://github.com/fgarofalo56/csa-inabox/issues/1084)) ([ac153d0](https://github.com/fgarofalo56/csa-inabox/commit/ac153d061953b8f81d3ad563cc5cf52d56990837))


### Miscellaneous

* **csa-loom:** pin workflow agent models to opus + persist fast builder & wave 10/11 specs ([#1088](https://github.com/fgarofalo56/csa-inabox/issues/1088)) ([bdc5e76](https://github.com/fgarofalo56/csa-inabox/commit/bdc5e763c364b6a4400569ff79a67ac4fb317453))

## [0.32.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.31.0...csa-inabox-v0.32.0) (2026-06-10)


### Features

* **csa-loom:** Cosmos stored-proc/trigger/UDF authoring (real ARM + data-plane execute) ([#1062](https://github.com/fgarofalo56/csa-inabox/issues/1062)) ([8546733](https://github.com/fgarofalo56/csa-inabox/commit/854673388ef456d874b174e904a0d5105413ed35))
* **csa-loom:** enforce event-schema-set compatibility before publish (audit-T15) ([#1069](https://github.com/fgarofalo56/csa-inabox/issues/1069)) ([3ef6f3a](https://github.com/fgarofalo56/csa-inabox/commit/3ef6f3a666a90e91dd5798f16d148d99999f2e97))
* **csa-loom:** geo dataset geometry inspector + geo pipeline ADF params ([#1064](https://github.com/fgarofalo56/csa-inabox/issues/1064)) ([e7b1bb5](https://github.com/fgarofalo56/csa-inabox/commit/e7b1bb5ac4a4e15d0c865612b7f641badd883f0c))
* **csa-loom:** in-place Power BI paginated report embed + export (T14) ([#1068](https://github.com/fgarofalo56/csa-inabox/issues/1068)) ([f454ff8](https://github.com/fgarofalo56/csa-inabox/commit/f454ff8294171a5d106510b42fb6108c6f4c5b9f))
* **csa-loom:** ontology Lakehouse/Warehouse entity binding + Activator triggers ([#1066](https://github.com/fgarofalo56/csa-inabox/issues/1066)) ([760a2ab](https://github.com/fgarofalo56/csa-inabox/commit/760a2ab08085e7eaf6aeda8fa37296a4c0500322))
* **csa-loom:** plan approval-workflow handoff + semantic-model writeback (audit-T13) ([#1067](https://github.com/fgarofalo56/csa-inabox/issues/1067)) ([19ff78d](https://github.com/fgarofalo56/csa-inabox/commit/19ff78d33f27ec00ea08d545410248adc3b7bf96))
* **csa-loom:** semantic-model workspace pane — real AAS list + XMLA/Fabric deploy ([#1061](https://github.com/fgarofalo56/csa-inabox/issues/1061)) ([7068c9d](https://github.com/fgarofalo56/csa-inabox/commit/7068c9dbb346b9aac69b61ef19e4c7750a77145b))
* **csa-loom:** wire APIM subscription state + key regen in product editor ([#1063](https://github.com/fgarofalo56/csa-inabox/issues/1063)) ([196c51f](https://github.com/fgarofalo56/csa-inabox/commit/196c51f45da9e2505b12544fd0c3d38b5345bda4))
* **csa-loom:** wire AzureSqlDatabaseEditor schema browser (audit-t16) ([#1070](https://github.com/fgarofalo56/csa-inabox/issues/1070)) ([05f8d2f](https://github.com/fgarofalo56/csa-inabox/commit/05f8d2f5db105b1839f7b784057f5228fd39dcdc))


### Bug Fixes

* **csa-loom:** Gov-safe vector-store similarity search + Console UAMI data-plane RBAC ([#1065](https://github.com/fgarofalo56/csa-inabox/issues/1065)) ([1c9bf27](https://github.com/fgarofalo56/csa-inabox/commit/1c9bf27dac061eec3f59ee12de88fd9aa9f71f44))


### Tests

* **csa-loom:** cover warehouse query+history BFF routes; fix pane assertions ([#1060](https://github.com/fgarofalo56/csa-inabox/issues/1060)) ([95ce392](https://github.com/fgarofalo56/csa-inabox/commit/95ce392ea3934c1b983564e0fb847cd8ad168b60))


### Performance Improvements

* **csa-loom:** partition-safe OneLake catalog read + workspace owner in tree ([#1059](https://github.com/fgarofalo56/csa-inabox/issues/1059)) ([0b54c10](https://github.com/fgarofalo56/csa-inabox/commit/0b54c105128d53fb30f7ea18369015558f8fe7fd))

## [0.31.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.30.0...csa-inabox-v0.31.0) (2026-06-10)


### Features

* **csa-loom:** Activator pane persists rules to Azure Monitor (live CRUD + Objects/History) ([#1053](https://github.com/fgarofalo56/csa-inabox/issues/1053)) ([47a8a92](https://github.com/fgarofalo56/csa-inabox/commit/47a8a92e6282f7a0049f3cd2adea3f14474f350a))
* **csa-loom:** Monitor hub real activity feed from Log Analytics ([#1051](https://github.com/fgarofalo56/csa-inabox/issues/1051)) ([2b5d57c](https://github.com/fgarofalo56/csa-inabox/commit/2b5d57cb38cc32844df8317e6ea2d612072035bd))
* **csa-loom:** OneLake catalog live items + dynamic workspace tree ([#1052](https://github.com/fgarofalo56/csa-inabox/issues/1052)) ([014bdbe](https://github.com/fgarofalo56/csa-inabox/commit/014bdbe810ec42c5f0b48bcc7cce56e18c22f924))
* **csa-loom:** real /warehouse query surface — Monaco T-SQL, results grid, Explain + History tabs ([#1054](https://github.com/fgarofalo56/csa-inabox/issues/1054)) ([eb0d00d](https://github.com/fgarofalo56/csa-inabox/commit/eb0d00d8577a51515f8f0bac1048a99e443bedf7))
* **csa-loom:** RTI hub pane — live sources + wired "open eventstream editor" + alias route ([#1055](https://github.com/fgarofalo56/csa-inabox/issues/1055)) ([7c28f88](https://github.com/fgarofalo56/csa-inabox/commit/7c28f88d22e1c028ad83ff2795c157f65e062a19))
* **csa-loom:** unify Loom-native paginated-report RDL renderer onto main ([#993](https://github.com/fgarofalo56/csa-inabox/issues/993)) ([#1048](https://github.com/fgarofalo56/csa-inabox/issues/1048)) ([ba68ab6](https://github.com/fgarofalo56/csa-inabox/commit/ba68ab6fa131914489c9b17d91c53a45b1ea4777))


### Code Refactoring

* **csa-loom:** remove dead SemanticModelPane workspace surface ([#1056](https://github.com/fgarofalo56/csa-inabox/issues/1056)) ([a411ffb](https://github.com/fgarofalo56/csa-inabox/commit/a411ffb1bcc2125cdb222f886912db58a631f7d3))


### Miscellaneous

* **csa-loom:** persist autopilot workflows + audit backlog (durability) ([#1058](https://github.com/fgarofalo56/csa-inabox/issues/1058)) ([3c78ca7](https://github.com/fgarofalo56/csa-inabox/commit/3c78ca70310d55131a79a47ef1e10fbb69d67415))
* **csa-loom:** remove dead deployment-pipelines stub pane (audit-T07) ([#1057](https://github.com/fgarofalo56/csa-inabox/issues/1057)) ([99177d1](https://github.com/fgarofalo56/csa-inabox/commit/99177d1769af745b1698ddc3ea8472ff2c089eca))

## [0.30.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.29.0...csa-inabox-v0.30.0) (2026-06-10)


### Features

* **csa-loom:** per-pane Copilot persona registry + context resolver ([#1046](https://github.com/fgarofalo56/csa-inabox/issues/1046)) ([b2446a6](https://github.com/fgarofalo56/csa-inabox/commit/b2446a6237171cd37c3ac931bfed0ec658a4e7ae))

## [0.29.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.28.0...csa-inabox-v0.29.0) (2026-06-10)


### Features

* **csa-loom:** aas-client + Import-mode refresh hardening (Azure-native semantic model) ([#976](https://github.com/fgarofalo56/csa-inabox/issues/976)) ([7365a60](https://github.com/fgarofalo56/csa-inabox/commit/7365a606c02b4cd85822d24e4f61e9b0fd9e7391))
* **csa-loom:** Activator Copilot — NL → real Monitor scheduled-query alert rule ([#1001](https://github.com/fgarofalo56/csa-inabox/issues/1001)) ([2fd2e4a](https://github.com/fgarofalo56/csa-inabox/commit/2fd2e4abbbc68f00fc2c85a689e3e3195e4095da))
* **csa-loom:** admin shell landing tiles with live section counts (F1) ([#1014](https://github.com/fgarofalo56/csa-inabox/issues/1014)) ([c33840b](https://github.com/fgarofalo56/csa-inabox/commit/c33840b2db1a1888011827fb81661789700aafd7))
* **csa-loom:** advanced networking (F15) — inbound protection, IP firewall, outbound + trusted instances ([#1024](https://github.com/fgarofalo56/csa-inabox/issues/1024)) ([272a7c3](https://github.com/fgarofalo56/csa-inabox/commit/272a7c3513384986c1a4efae6c8bc8c423d95b31))
* **csa-loom:** approval-diff gate (Keep / Undo) for Copilot-proposed edits ([#996](https://github.com/fgarofalo56/csa-inabox/issues/996)) ([43056d7](https://github.com/fgarofalo56/csa-inabox/commit/43056d7308eef871a54c39c102f3db4f3165503b))
* **csa-loom:** bicep + env sync for the BI stack (AAS + Direct Lake shim) ([#985](https://github.com/fgarofalo56/csa-inabox/issues/985)) ([e7735eb](https://github.com/fgarofalo56/csa-inabox/commit/e7735eb5ce11fdbd1588d9ef2fc3d0d476315fc4))
* **csa-loom:** calculation groups + field parameters for semantic models ([#973](https://github.com/fgarofalo56/csa-inabox/issues/973)) ([3b7d991](https://github.com/fgarofalo56/csa-inabox/commit/3b7d991e078a4e9b61a33217fde69eba71c6d829))
* **csa-loom:** capacity cost + utilization (F5) — real Cost Management + Monitor ([#1037](https://github.com/fgarofalo56/csa-inabox/issues/1037)) ([269e57a](https://github.com/fgarofalo56/csa-inabox/commit/269e57abed45136c89eb87657b465fe740737e93))
* **csa-loom:** capacity detail pane — Scale & Manage drawer (live ARM) ([#1035](https://github.com/fgarofalo56/csa-inabox/issues/1035)) ([caa8d71](https://github.com/fgarofalo56/csa-inabox/commit/caa8d71b50ac51000ad81fcb07786720defdffe4))
* **csa-loom:** composite + Dual per-table storage mode for semantic models ([#968](https://github.com/fgarofalo56/csa-inabox/issues/968)) ([a880281](https://github.com/fgarofalo56/csa-inabox/commit/a880281f397a9c0878004e0b29804d0b2c177c57))
* **csa-loom:** copilot feedback (thumbs) + clear-chat + history drawer ([#986](https://github.com/fgarofalo56/csa-inabox/issues/986)) ([ba1ebfd](https://github.com/fgarofalo56/csa-inabox/commit/ba1ebfd0b88310f6b43011a9e45d44e9fb643e40))
* **csa-loom:** cross-item Copilot tool audit — all tools real + Fabric async poll + sovereign gate ([#1007](https://github.com/fgarofalo56/csa-inabox/issues/1007)) ([23ca0de](https://github.com/fgarofalo56/csa-inabox/commit/23ca0de623555cb44eeafb4a882fb9a3c5a7f9c1))
* **csa-loom:** customer-managed keys (F14) — KV-backed workspace encryption bind ([#1026](https://github.com/fgarofalo56/csa-inabox/issues/1026)) ([2290ffc](https://github.com/fgarofalo56/csa-inabox/commit/2290ffc8c165f7bd131b1e8e6149127a77149b70))
* **csa-loom:** dashboard tiles — pin / Q&A (Copilot→DAX) / streaming ADX, grid + Cosmos persist ([#997](https://github.com/fgarofalo56/csa-inabox/issues/997)) ([8457b8f](https://github.com/fgarofalo56/csa-inabox/commit/8457b8fdc4b3a0177b4894e34a995a044e8b2cdb))
* **csa-loom:** data-agent Config Copilot — example-query + field-description generation ([#1002](https://github.com/fgarofalo56/csa-inabox/issues/1002)) ([987a2f4](https://github.com/fgarofalo56/csa-inabox/commit/987a2f4ad634c1bfb407fec61c948b452c9fa2d4))
* **csa-loom:** Dataflow Gen2 Copilot — NL→M query, ref/explain/add-step/undo ([#1004](https://github.com/fgarofalo56/csa-inabox/issues/1004)) ([90ea8dc](https://github.com/fgarofalo56/csa-inabox/commit/90ea8dc4bcd9f2b76999f052b20bc49e8579b998))
* **csa-loom:** datamart migration assistant (deprecated → Synapse Serverless + AAS) ([#978](https://github.com/fgarofalo56/csa-inabox/issues/978)) ([75e5a06](https://github.com/fgarofalo56/csa-inabox/commit/75e5a0689b9e4b072c5618163c9e8b03e0591525))
* **csa-loom:** DAX / semantic-model Copilot (NL2DAX, explain, optimize, descriptions) ([#1016](https://github.com/fgarofalo56/csa-inabox/issues/1016)) ([a8c2c8c](https://github.com/fgarofalo56/csa-inabox/commit/a8c2c8cd616abadd93fe0594bfcc347c1f29b83a))
* **csa-loom:** dedicated low-latency deployment for notebook inline code completion ([#991](https://github.com/fgarofalo56/csa-inabox/issues/991)) ([5fc61aa](https://github.com/fgarofalo56/csa-inabox/commit/5fc61aa2bfe14f3872791c249504e192a4d5fc2f))
* **csa-loom:** Direct Lake DirectQuery fallback for semantic models ([#970](https://github.com/fgarofalo56/csa-inabox/issues/970)) ([0b128d8](https://github.com/fgarofalo56/csa-inabox/commit/0b128d832164cd68510a75aaa7ad1e5021328811))
* **csa-loom:** DirectQuery source binder for semantic models (Azure-native via AAS) ([#989](https://github.com/fgarofalo56/csa-inabox/issues/989)) ([26ec1a3](https://github.com/fgarofalo56/csa-inabox/commit/26ec1a300d328cb637fb8fb185d1a7dcaadafdc0))
* **csa-loom:** documented Fabric/Power BI Copilot opt-in (no default gate) ([#1022](https://github.com/fgarofalo56/csa-inabox/issues/1022)) ([e73b4a6](https://github.com/fgarofalo56/csa-inabox/commit/e73b4a6f460fc77296abe63fee65ae0b4855d268))
* **csa-loom:** embed codes + organizational visuals (F22 + F23) ([#1041](https://github.com/fgarofalo56/csa-inabox/issues/1041)) ([f55b602](https://github.com/fgarofalo56/csa-inabox/commit/f55b60210fd55680c0410cae46821e55b968d037))
* **csa-loom:** F12 Git integration — real ADO + GitHub source control ([#1029](https://github.com/fgarofalo56/csa-inabox/issues/1029)) ([810b8a8](https://github.com/fgarofalo56/csa-inabox/commit/810b8a815226bf48a27cf036a9bb66b03d7def20))
* **csa-loom:** F16 Azure connections — bind ADLS Gen2 + Log Analytics per workspace ([#1028](https://github.com/fgarofalo56/csa-inabox/issues/1028)) ([c16701f](https://github.com/fgarofalo56/csa-inabox/commit/c16701f3385dd5488e76270429e44eb679b6745c))
* **csa-loom:** F17 users & licenses — real Graph license roll-up + per-user workspace-role expansion ([#1025](https://github.com/fgarofalo56/csa-inabox/issues/1025)) ([bc8c3f4](https://github.com/fgarofalo56/csa-inabox/commit/bc8c3f4a0f6aa1aca674e423c3dcf0c0d526f6cf))
* **csa-loom:** F18 Domains — mirror domain edits + subdomain hierarchy to Purview collections ([#1034](https://github.com/fgarofalo56/csa-inabox/issues/1034)) ([00a9f33](https://github.com/fgarofalo56/csa-inabox/commit/00a9f33e8504dae1f6aa601571f5bb6a3acce16c))
* **csa-loom:** F19 audit logs — real Purview Audit + Log Analytics fan-out ([#1027](https://github.com/fgarofalo56/csa-inabox/issues/1027)) ([66a894f](https://github.com/fgarofalo56/csa-inabox/commit/66a894f4e3f8e6d3e709b87c711c23e5b4347601))
* **csa-loom:** F6 admin Workspaces list & govern — tenant-wide Cosmos inventory ([#1031](https://github.com/fgarofalo56/csa-inabox/issues/1031)) ([5c68cea](https://github.com/fgarofalo56/csa-inabox/commit/5c68cea120a58a3f5bf4a48ac7a7e2c658f0eb79))
* **csa-loom:** F9 admin-plane Workspace access — per-workspace role grid on real Azure RBAC ([#1018](https://github.com/fgarofalo56/csa-inabox/issues/1018)) ([8899ebe](https://github.com/fgarofalo56/csa-inabox/commit/8899ebed46184be34761e378ca147d4bf0c8a54c))
* **csa-loom:** Fix with Copilot — error summary + root cause + diff under failed cells ([#999](https://github.com/fgarofalo56/csa-inabox/issues/999)) ([8228dc8](https://github.com/fgarofalo56/csa-inabox/commit/8228dc8127e9a600aac2f0ca5a706f8ff9241bdb))
* **csa-loom:** harden AOAI target resolution across all 4 clouds ([#982](https://github.com/fgarofalo56/csa-inabox/issues/982)) ([c13c19b](https://github.com/fgarofalo56/csa-inabox/commit/c13c19b1db1398857ca2b84203dd35742f5a6fde))
* **csa-loom:** KQL Copilot — NL2KQL + explain grounded in real ADX schema ([#1009](https://github.com/fgarofalo56/csa-inabox/issues/1009)) ([01db2f4](https://github.com/fgarofalo56/csa-inabox/commit/01db2f4000f17a1ddd2376b3e247ac7a96d63143))
* **csa-loom:** Loom-native deployment pipelines — stages, content compare, selective deploy, deployment rules ([#990](https://github.com/fgarofalo56/csa-inabox/issues/990)) ([35af5dc](https://github.com/fgarofalo56/csa-inabox/commit/35af5dc541ac4b20f2bcdbd69e3aaa8bc74e020b))
* **csa-loom:** MAF orchestration tier for GCC-High / IL5 (Gov AOAI direct) ([#1019](https://github.com/fgarofalo56/csa-inabox/issues/1019)) ([c5619b2](https://github.com/fgarofalo56/csa-inabox/commit/c5619b2536f6a390fa627e28ecaf1b6871148bd6))
* **csa-loom:** notebook AI functions — LLM in Spark/pandas via Azure OpenAI ([#1011](https://github.com/fgarofalo56/csa-inabox/issues/1011)) ([a3e29a8](https://github.com/fgarofalo56/csa-inabox/commit/a3e29a86536b10a2cba7b94b6b1904d8071f33ca))
* **csa-loom:** notebook Copilot persona — summarize, generate, refactor, profile, perf ([#1003](https://github.com/fgarofalo56/csa-inabox/issues/1003)) ([48d8681](https://github.com/fgarofalo56/csa-inabox/commit/48d86814dbda3d0fb6d73e16c24cd26481a7e6af))
* **csa-loom:** notebook in-cell Copilot — /comments /optimize + approval-diff + live-Livy /fix ([#995](https://github.com/fgarofalo56/csa-inabox/issues/995)) ([0e09c46](https://github.com/fgarofalo56/csa-inabox/commit/0e09c46113c1906b1f52fab95ada3980d102baf3))
* **csa-loom:** Ops Admin Copilot — NL capacity scale / OAP toggle / workspace create ([#1017](https://github.com/fgarofalo56/csa-inabox/issues/1017)) ([86d28b1](https://github.com/fgarofalo56/csa-inabox/commit/86d28b1a8c9cead4717bd91677d37ce3b40234f8))
* **csa-loom:** paginated report (RDL) designer + PDF/Excel/Word export ([#992](https://github.com/fgarofalo56/csa-inabox/issues/992)) ([b468d61](https://github.com/fgarofalo56/csa-inabox/commit/b468d616b1fc7ebfa2bd9a50a8db292374091d62))
* **csa-loom:** per-persona Copilot usage metering + cost panel ([#1013](https://github.com/fgarofalo56/csa-inabox/issues/1013)) ([024542f](https://github.com/fgarofalo56/csa-inabox/commit/024542fb15f89675e755b524de1ba6df81290d5c))
* **csa-loom:** per-persona suggested-prompt chips above the Copilot composer ([#983](https://github.com/fgarofalo56/csa-inabox/issues/983)) ([eaff0f7](https://github.com/fgarofalo56/csa-inabox/commit/eaff0f77efa06776752b480b59b6bd52bfe469af))
* **csa-loom:** Pipeline Copilot — NL→pipeline, / completion, run, summarize, error assistant ([#1000](https://github.com/fgarofalo56/csa-inabox/issues/1000)) ([ac90ccc](https://github.com/fgarofalo56/csa-inabox/commit/ac90ccce8c81161f0ce8be0ad856f1a8463d6d3c))
* **csa-loom:** real Git integration — commit / pull / sync for workspace items ([#987](https://github.com/fgarofalo56/csa-inabox/issues/987)) ([4adb7be](https://github.com/fgarofalo56/csa-inabox/commit/4adb7beba5741d3f2b16b379fbbd5ee2566e1351))
* **csa-loom:** real usage metrics & feature adoption (F21) ([#1032](https://github.com/fgarofalo56/csa-inabox/issues/1032)) ([f9fd768](https://github.com/fgarofalo56/csa-inabox/commit/f9fd768e80bf9ed2b891189b8df213b54227a6b9))
* **csa-loom:** refresh summary (F20) — scheduled-refresh overview from real run history ([#1038](https://github.com/fgarofalo56/csa-inabox/issues/1038)) ([e1da878](https://github.com/fgarofalo56/csa-inabox/commit/e1da878ac205661d728c6c4effa8eeae3e8eda76))
* **csa-loom:** Report Copilot — narrative summary + suggest visuals (Loom-native, no Power BI) ([#1023](https://github.com/fgarofalo56/csa-inabox/issues/1023)) ([e87c4c4](https://github.com/fgarofalo56/csa-inabox/commit/e87c4c4bedeaa033228bec9bf28764d9472bcaae))
* **csa-loom:** report export + subscriptions (scheduled PBI export → email) ([#1008](https://github.com/fgarofalo56/csa-inabox/issues/1008)) ([409b6bd](https://github.com/fgarofalo56/csa-inabox/commit/409b6bda41d0ce4ead43c9403daca5d6ec91808d))
* **csa-loom:** report viewer — bookmarks sync, drill-through context, cross-highlight, theme + format pane ([#965](https://github.com/fgarofalo56/csa-inabox/issues/965)) ([d069534](https://github.com/fgarofalo56/csa-inabox/commit/d069534d9a85d234c61c0292f8883da28f5edefa))
* **csa-loom:** report viewer Loom-native default over Azure Analysis Services ([#966](https://github.com/fgarofalo56/csa-inabox/issues/966)) ([e53f39a](https://github.com/fgarofalo56/csa-inabox/commit/e53f39a0295475f563ae1eb677339579239e1c80))
* **csa-loom:** report visual gallery + Fields/Format/Filters panes (DAX over executeQueries) ([#977](https://github.com/fgarofalo56/csa-inabox/issues/977)) ([023cdb8](https://github.com/fgarofalo56/csa-inabox/commit/023cdb8f57181e841944f29a46ef257678886dfa))
* **csa-loom:** route every copilot persona through Content Safety verdict ([#1015](https://github.com/fgarofalo56/csa-inabox/issues/1015)) ([8140a82](https://github.com/fgarofalo56/csa-inabox/commit/8140a82a800529f0d8af0a3e02a33ea9d91f9e36))
* **csa-loom:** scorecard goals + connected metrics + check-ins ([#994](https://github.com/fgarofalo56/csa-inabox/issues/994)) ([e500b4a](https://github.com/fgarofalo56/csa-inabox/commit/e500b4a8c6aa2d65469af91ae640781a7ec77e5f))
* **csa-loom:** scorecard rollups + status rules (Azure-native, no Fabric dep) ([#972](https://github.com/fgarofalo56/csa-inabox/issues/972)) ([39ce827](https://github.com/fgarofalo56/csa-inabox/commit/39ce82793ac9675dd81a92afedee36be1187bd5a))
* **csa-loom:** Semantic Link read — Copilot reads the tabular model, no Power BI ([#1030](https://github.com/fgarofalo56/csa-inabox/issues/1030)) ([8ce44ca](https://github.com/fgarofalo56/csa-inabox/commit/8ce44ca2f57b49e99d68828e128c44c27849ab85))
* **csa-loom:** semantic model Automatic aggregations (XMLA alternateOf) ([#974](https://github.com/fgarofalo56/csa-inabox/issues/974)) ([9bcd6eb](https://github.com/fgarofalo56/csa-inabox/commit/9bcd6eb07237a096312924054c2aa45993d3879b))
* **csa-loom:** semantic-model "Get data" — Power Query (M) → Delta → AAS ingest ([#967](https://github.com/fgarofalo56/csa-inabox/issues/967)) ([0bf1c4d](https://github.com/fgarofalo56/csa-inabox/commit/0bf1c4de68ed7ecbf253d738401e6e8572b34a4f))
* **csa-loom:** semantic-model column editor — calc, data category, format, summarize, sort-by, folder (XMLA/AAS) ([#984](https://github.com/fgarofalo56/csa-inabox/issues/984)) ([b84e440](https://github.com/fgarofalo56/csa-inabox/commit/b84e440c50a98968ef18b1175b3c5fd085a3e3c4))
* **csa-loom:** semantic-model hybrid tables + incremental/enhanced refresh ([#979](https://github.com/fgarofalo56/csa-inabox/issues/979)) ([7353dcc](https://github.com/fgarofalo56/csa-inabox/commit/7353dcc2eecfe690189233dfe4e39a294be0ea21))
* **csa-loom:** semantic-model measures — Monaco DAX editor + format strings + XMLA persistence ([#980](https://github.com/fgarofalo56/csa-inabox/issues/980)) ([38787bf](https://github.com/fgarofalo56/csa-inabox/commit/38787bf3112661ddb57665ae90e23d7b5529682a))
* **csa-loom:** semantic-model Model view — relationship diagram + drill hierarchies ([#971](https://github.com/fgarofalo56/csa-inabox/issues/971)) ([7419f85](https://github.com/fgarofalo56/csa-inabox/commit/7419f850dcc16eb291ed6519211be698ecd689a1))
* **csa-loom:** semantic-model RLS + OLS Security tab (Analysis Services XMLA) ([#975](https://github.com/fgarofalo56/csa-inabox/issues/975)) ([f6cde8c](https://github.com/fgarofalo56/csa-inabox/commit/f6cde8ce848ef4b84ac1890b4fb87f62325ae769))
* **csa-loom:** shared cloud-endpoints resolver getters + foundation Cosmos containers ([#1012](https://github.com/fgarofalo56/csa-inabox/issues/1012)) ([265e5b0](https://github.com/fgarofalo56/csa-inabox/commit/265e5b0b2602b50e3b1d5961c285e0b1aaafb742))
* **csa-loom:** slash-command parser + /explain /fix /comments /optimize Copilot tools ([#1005](https://github.com/fgarofalo56/csa-inabox/issues/1005)) ([d59ac8a](https://github.com/fgarofalo56/csa-inabox/commit/d59ac8a4726de4a94cd0e5cb491d171d15c3ec94))
* **csa-loom:** Spark / compute configuration (F13) — Databricks pools/runtime/env/jobs ([#1040](https://github.com/fgarofalo56/csa-inabox/issues/1040)) ([035c155](https://github.com/fgarofalo56/csa-inabox/commit/035c15503bd2666052e89b6a82aecaa7d9698972))
* **csa-loom:** tenant-settings per-toggle group scoping + numeric params (F2) ([#1020](https://github.com/fgarofalo56/csa-inabox/issues/1020)) ([2002bb2](https://github.com/fgarofalo56/csa-inabox/commit/2002bb21ba45a230c739433d1368bf3139892246))
* **csa-loom:** typed Copilot tool-result renderer (table/chart/code/summary) ([#988](https://github.com/fgarofalo56/csa-inabox/issues/988)) ([5e10418](https://github.com/fgarofalo56/csa-inabox/commit/5e10418f42dc024edaa0f61cadb725e3c6062009))
* **csa-loom:** Warehouse SQL Copilot — NL2SQL, explain, fix, optimize (real EXPLAIN), quick actions ([#1010](https://github.com/fgarofalo56/csa-inabox/issues/1010)) ([a56b784](https://github.com/fgarofalo56/csa-inabox/commit/a56b784163bd248d691d1ebc436570e8eaaee3a5))
* **csa-loom:** wire Direct-Lake-shim into the semantic-model editor ([#969](https://github.com/fgarofalo56/csa-inabox/issues/969)) ([f4fcc13](https://github.com/fgarofalo56/csa-inabox/commit/f4fcc132cfb362b427e7eed53db34ede7a2a6c8c))
* **csa-loom:** workspace create wizard + settings flyout (F7 + F8) ([#1039](https://github.com/fgarofalo56/csa-inabox/issues/1039)) ([f8419d6](https://github.com/fgarofalo56/csa-inabox/commit/f8419d60a1f6a5ef3252c61ac82ab3838e70ddcf))
* **csa-loom:** workspace folders pane + task-flow canvas (F10 + F11) ([#1033](https://github.com/fgarofalo56/csa-inabox/issues/1033)) ([d423fa3](https://github.com/fgarofalo56/csa-inabox/commit/d423fa3de0fba157eedddf771003d6fc6ea0f9d9))


### Bug Fixes

* **csa-loom:** cloud-endpoint + RBAC sweep — sovereign-cloud hostname resolution ([#998](https://github.com/fgarofalo56/csa-inabox/issues/998)) ([3b6b6c7](https://github.com/fgarofalo56/csa-inabox/commit/3b6b6c75dd97ae4f3e86000be44f3da7fa28b8ba))
* **csa-loom:** lakehouse page crash — resolve temporal-dead-zone (use-before-init) ([#1043](https://github.com/fgarofalo56/csa-inabox/issues/1043)) ([eb23452](https://github.com/fgarofalo56/csa-inabox/commit/eb234526dab4797ab174b8a048c7e0c477edfac0))


### Documentation

* **csa-loom:** Copilot surface parity docs + deep-functional UAT (14 personas) ([#1021](https://github.com/fgarofalo56/csa-inabox/issues/1021)) ([d197287](https://github.com/fgarofalo56/csa-inabox/commit/d197287da17700091b0c3bb91e0f4540188da0c6))
* **csa-loom:** Platform & Admin parity docs + whole-experience scorecard (rev.5) ([#1036](https://github.com/fgarofalo56/csa-inabox/issues/1036)) ([42cc3e7](https://github.com/fgarofalo56/csa-inabox/commit/42cc3e7964b4e3bcebaec766da539bd8ca56199b))
* **csa-loom:** refresh Power BI per-surface parity docs + add direct-lake.md ([#981](https://github.com/fgarofalo56/csa-inabox/issues/981)) ([92dd245](https://github.com/fgarofalo56/csa-inabox/commit/92dd24568cfd9284b895548585a95550d4e7c1ac))

## [0.28.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.27.0...csa-inabox-v0.28.0) (2026-06-09)


### Features

* **csa-loom:** AI functions in T-SQL — sentiment/classify/translate/summarize/extract ([#933](https://github.com/fgarofalo56/csa-inabox/issues/933)) ([8c6a778](https://github.com/fgarofalo56/csa-inabox/commit/8c6a778f831d5c47f43e1b151762835fd31ec504))
* **csa-loom:** Azure SQL Compute & Storage scale tab (vCore/DTU/serverless) ([#948](https://github.com/fgarofalo56/csa-inabox/issues/948)) ([b5d25b1](https://github.com/fgarofalo56/csa-inabox/commit/b5d25b172d130d6f02190a0d8e4f44b30c43874e))
* **csa-loom:** cancel running SQL query + background continuation + completion toast ([#943](https://github.com/fgarofalo56/csa-inabox/issues/943)) ([8b83fcb](https://github.com/fgarofalo56/csa-inabox/commit/8b83fcbe444f6872c6e6e64828c55bbe84f35814))
* **csa-loom:** column-level + row-level security in the Permissions surface ([#937](https://github.com/fgarofalo56/csa-inabox/issues/937)) ([5d14de7](https://github.com/fgarofalo56/csa-inabox/commit/5d14de792a2ae46008129b53a2273e54f67947de))
* **csa-loom:** Connect-tab connection strings (ADO.NET/JDBC/ODBC/PHP/Go), cloud-aware ([#940](https://github.com/fgarofalo56/csa-inabox/issues/940)) ([77640a7](https://github.com/fgarofalo56/csa-inabox/commit/77640a7a70f854606ff75d21405816de5b7fa307))
* **csa-loom:** connection details panel for SQL warehouse + Synapse pools ([#939](https://github.com/fgarofalo56/csa-inabox/issues/939)) ([32e5fe5](https://github.com/fgarofalo56/csa-inabox/commit/32e5fe54a4ee8f590a55a26e2d7cbfc24dccd656))
* **csa-loom:** Copilot quick-actions in the SQL editor (Fix / Explain / inline / NL→T-SQL) ([#949](https://github.com/fgarofalo56/csa-inabox/issues/949)) ([149bb84](https://github.com/fgarofalo56/csa-inabox/commit/149bb84cd873a22e4e25d1c56cb070309a2d18e2))
* **csa-loom:** Cosmos container CRUD wizard + editable Scale & Settings (throughput/indexing/TTL) ([#944](https://github.com/fgarofalo56/csa-inabox/issues/944)) ([f4532b8](https://github.com/fgarofalo56/csa-inabox/commit/f4532b803c5e77c3bf2cd41fd0d573969bacfbb2))
* **csa-loom:** Cosmos DB keys / connection strings Connect panel ([#956](https://github.com/fgarofalo56/csa-inabox/issues/956)) ([7271613](https://github.com/fgarofalo56/csa-inabox/commit/7271613e3cb1d5bf65b90873761b85ff8a8fa205))
* **csa-loom:** Cosmos DB Metrics tab — RU/s, storage, 429 throttling ([#957](https://github.com/fgarofalo56/csa-inabox/issues/957)) ([5223af8](https://github.com/fgarofalo56/csa-inabox/commit/5223af88ebcaadbd6fd4521ffddf6e6a537807e7))
* **csa-loom:** Cosmos Gremlin graph explorer canvas + addV/addE + cloud-aware endpoint ([#952](https://github.com/fgarofalo56/csa-inabox/issues/952)) ([e648378](https://github.com/fgarofalo56/csa-inabox/commit/e6483788e1426ec139868fce20c78f359cb31737))
* **csa-loom:** CTAS + clone + SELECT INTO for Databricks & Synapse SQL ([#925](https://github.com/fgarofalo56/csa-inabox/issues/925)) ([225c08b](https://github.com/fgarofalo56/csa-inabox/commit/225c08b99655a4528c323b62dfb35ddb81641e31))
* **csa-loom:** Explorer views/SPs/functions + row counts + script-out (SQL family) ([#923](https://github.com/fgarofalo56/csa-inabox/issues/923)) ([1177178](https://github.com/fgarofalo56/csa-inabox/commit/11771788b92b65983042a2c26cb1c02e52ba116a))
* **csa-loom:** export results CSV/JSON + Open-in-Excel (.iqy) for Databricks + Synapse Serverless ([#919](https://github.com/fgarofalo56/csa-inabox/issues/919)) ([df8912a](https://github.com/fgarofalo56/csa-inabox/commit/df8912aa99080df7f6b8c6f7b006145cba29c661))
* **csa-loom:** external shortcut connectors (S3/GCS/ADLS/Dataverse) with KV-only creds + live browse ([#928](https://github.com/fgarofalo56/csa-inabox/issues/928)) ([e04ee71](https://github.com/fgarofalo56/csa-inabox/commit/e04ee713ece3f0e2e49050f6a968ce82f4c05e11))
* **csa-loom:** Get-data ribbon → ADF Copy/pipeline/dataflow deep-links (SQL DB sink) ([#941](https://github.com/fgarofalo56/csa-inabox/issues/941)) ([ddaca75](https://github.com/fgarofalo56/csa-inabox/commit/ddaca7532cdc2f1af649e30d04a590bcdf13a192))
* **csa-loom:** in-Loom chart visualize + injection-safe query parameters (W13/W15) ([#931](https://github.com/fgarofalo56/csa-inabox/issues/931)) ([9c5e649](https://github.com/fgarofalo56/csa-inabox/commit/9c5e6492f3eb46f853d87760abe463916a240237))
* **csa-loom:** internal lakehouse shortcuts — item-scoped CRUD + live Test + Broken status ([#929](https://github.com/fgarofalo56/csa-inabox/issues/929)) ([1f2a303](https://github.com/fgarofalo56/csa-inabox/commit/1f2a303d6c7a798e94b2272ec6b9a698f387cdb8))
* **csa-loom:** item-level Share + Git source-control gate for Azure SQL databases ([#955](https://github.com/fgarofalo56/csa-inabox/issues/955)) ([000a173](https://github.com/fgarofalo56/csa-inabox/commit/000a1738bb85630d90c5f365cec5e121d28a1365))
* **csa-loom:** item-to-item lineage drawer (OneLake, Azure-native per boundary) ([#921](https://github.com/fgarofalo56/csa-inabox/issues/921)) ([c749760](https://github.com/fgarofalo56/csa-inabox/commit/c74976046ccd0cc941eb4b4302906c432c13542c))
* **csa-loom:** mirrored-database replication monitor + stop/start/restart lifecycle ([#958](https://github.com/fgarofalo56/csa-inabox/issues/958)) ([ab90e5c](https://github.com/fgarofalo56/csa-inabox/commit/ab90e5ce9672ced2c20a5684e3147b2695caad13))
* **csa-loom:** mirrored-DB wizard + multi-source connectors + table selection ([#961](https://github.com/fgarofalo56/csa-inabox/issues/961)) ([dfa916f](https://github.com/fgarofalo56/csa-inabox/commit/dfa916fdf763901ae1a8a1f4b80d92741634282e))
* **csa-loom:** Model view canvas — relationships + measures (no Power BI dependency) ([#934](https://github.com/fgarofalo56/csa-inabox/issues/934)) ([a40bd89](https://github.com/fgarofalo56/csa-inabox/commit/a40bd89cc2b94a0e997bda6627b568a7e28d9d58))
* **csa-loom:** My Queries / Shared Queries folders + bulk delete for the SQL editor ([#954](https://github.com/fgarofalo56/csa-inabox/issues/954)) ([ab44a96](https://github.com/fgarofalo56/csa-inabox/commit/ab44a96c26863d6eae5e6df12eec9f629c9493a8))
* **csa-loom:** OneLake card endorsement badge + owner avatar + domain badge ([#915](https://github.com/fgarofalo56/csa-inabox/issues/915)) ([600e16b](https://github.com/fgarofalo56/csa-inabox/commit/600e16b950e75e919c629a92f7b77501669a35e6))
* **csa-loom:** OneLake catalog Govern tab — Azure-native governance score ([#918](https://github.com/fgarofalo56/csa-inabox/issues/918)) ([02b9650](https://github.com/fgarofalo56/csa-inabox/commit/02b9650c03759040ffdf5ff999bff468004da432))
* **csa-loom:** OneLake catalog Secure tab — Azure-native access matrix ([#920](https://github.com/fgarofalo56/csa-inabox/issues/920)) ([b70dc02](https://github.com/fgarofalo56/csa-inabox/commit/b70dc02a264f9230c779cf003496f3cc848b4db2))
* **csa-loom:** OneLake lifecycle-management rules editor + workspace storage binding ([#924](https://github.com/fgarofalo56/csa-inabox/issues/924)) ([883af03](https://github.com/fgarofalo56/csa-inabox/commit/883af03bf11ff8f26c0122ea8f45bba2cb1dd71f))
* **csa-loom:** OneLake path/URI model + ItemTile overflow menu + Connect snippets ([#916](https://github.com/fgarofalo56/csa-inabox/issues/916)) ([3d73fa7](https://github.com/fgarofalo56/csa-inabox/commit/3d73fa72c45ac44261974c3358038dafc47c009d))
* **csa-loom:** OneLake soft-delete / restore (Recycle bin) ([#930](https://github.com/fgarofalo56/csa-inabox/issues/930)) ([399693b](https://github.com/fgarofalo56/csa-inabox/commit/399693b11cc79fbc7ad151b0c02684b3c857522b))
* **csa-loom:** OneLake storage-tier (Hot/Cool/Cold) management ([#922](https://github.com/fgarofalo56/csa-inabox/issues/922)) ([2c1a100](https://github.com/fgarofalo56/csa-inabox/commit/2c1a1005f2c807f98de67114839154a28a4b0a40))
* **csa-loom:** open mirroring — push Parquet → managed Delta (Azure-native) ([#959](https://github.com/fgarofalo56/csa-inabox/issues/959)) ([859d935](https://github.com/fgarofalo56/csa-inabox/commit/859d9357ae9806d58b3d823f949788a66f1bbb48))
* **csa-loom:** paired SQL analytics endpoint over the mirror (Azure-native) ([#962](https://github.com/fgarofalo56/csa-inabox/issues/962)) ([b85b28f](https://github.com/fgarofalo56/csa-inabox/commit/b85b28f917eedcbfa572fb4e47ff41515b50cbd3))
* **csa-loom:** query-history profile drawer (Databricks) + DMV history (Synapse) ([#927](https://github.com/fgarofalo56/csa-inabox/issues/927)) ([9c300c9](https://github.com/fgarofalo56/csa-inabox/commit/9c300c9018b34d103b6f7b4e7276523eea1bdc5e))
* **csa-loom:** sensitivity label chip on OneLake card + set-label action ([#917](https://github.com/fgarofalo56/csa-inabox/issues/917)) ([ee63da2](https://github.com/fgarofalo56/csa-inabox/commit/ee63da2471a4f55f659013e93545625a3031b34f))
* **csa-loom:** SQL DB advanced create options (collation / ZR / backup-redundancy / maintenance window) ([#935](https://github.com/fgarofalo56/csa-inabox/issues/935)) ([5f7980e](https://github.com/fgarofalo56/csa-inabox/commit/5f7980ef56fe360cda77b2815a09cfb8291f7417))
* **csa-loom:** SQL editor parity — run-selection + cancel + multi-tab + schema IntelliSense + cross-DB picker ([#947](https://github.com/fgarofalo56/csa-inabox/issues/947)) ([74750a3](https://github.com/fgarofalo56/csa-inabox/commit/74750a3314aa2e9b6332b915f417b4aaf5029d93))
* **csa-loom:** SQL Object Explorer parity — indexes, data preview, full context menus ([#960](https://github.com/fgarofalo56/csa-inabox/issues/960)) ([b8d2b50](https://github.com/fgarofalo56/csa-inabox/commit/b8d2b5092a631928fb93630fdb0092b8777cb518))
* **csa-loom:** SQL performance dashboard over Query Store (QPI parity) ([#938](https://github.com/fgarofalo56/csa-inabox/issues/938)) ([b8556a6](https://github.com/fgarofalo56/csa-inabox/commit/b8556a67dab58c4004ff945ba15c253e3538a189))
* **csa-loom:** SQL results pane parity — 10k rows, Messages tab, multi-result-set, XLSX/copy/search ([#951](https://github.com/fgarofalo56/csa-inabox/issues/951)) ([c4f9ddd](https://github.com/fgarofalo56/csa-inabox/commit/c4f9ddd19a79090cfbe891b68c69393e4d0b4afc))
* **csa-loom:** Statistics manager + OPTIMIZE/ANALYZE + V-Order honest gate ([#953](https://github.com/fgarofalo56/csa-inabox/issues/953)) ([0b9d465](https://github.com/fgarofalo56/csa-inabox/commit/0b9d465d30d5e5a5e157a88b36a1a2e1e1e340cf))
* **csa-loom:** T-SQL query editor Fabric parity — templates, snippets, IntelliSense, run-selection ([#936](https://github.com/fgarofalo56/csa-inabox/issues/936)) ([e80f651](https://github.com/fgarofalo56/csa-inabox/commit/e80f6518248d52e13b137cadcbf3ba6326d2f2a2))
* **csa-loom:** visual (no-code) query editor — Power-Query canvas + SQL compiler ([#932](https://github.com/fgarofalo56/csa-inabox/issues/932)) ([c56fc15](https://github.com/fgarofalo56/csa-inabox/commit/c56fc152d49be1ca114d1d750508a7f5b879609f))
* **csa-loom:** Warehouse Copilot — NL→SQL + Explain + Fix on Azure-native warehouses ([#945](https://github.com/fgarofalo56/csa-inabox/issues/945)) ([e989f7d](https://github.com/fgarofalo56/csa-inabox/commit/e989f7d6d864cc6e1259f50373eb1426cc022c68))
* **csa-loom:** warehouse create + delete + $/hr estimate (lifecycle complete) ([#926](https://github.com/fgarofalo56/csa-inabox/issues/926)) ([c1202a0](https://github.com/fgarofalo56/csa-inabox/commit/c1202a053bc1cffa1b629a8a70f53cfcb85b0da3))
* **csa-loom:** warehouse Monitoring tab — running-clusters + query-load chart ([#942](https://github.com/fgarofalo56/csa-inabox/issues/942)) ([1692105](https://github.com/fgarofalo56/csa-inabox/commit/16921054a2858b80340a547cd12b49909413facb))
* **csa-loom:** warehouse query-result Alerts editor (query + condition + schedule + destination) ([#946](https://github.com/fgarofalo56/csa-inabox/issues/946)) ([d3640ec](https://github.com/fgarofalo56/csa-inabox/commit/d3640ecfd755f3db97ed851cf1319f19f7ee9408))


### Bug Fixes

* **csa-loom:** auto-mirror is Azure-native by default + land Bronze from SQL DB editor ([#950](https://github.com/fgarofalo56/csa-inabox/issues/950)) ([0c2f0d4](https://github.com/fgarofalo56/csa-inabox/commit/0c2f0d495704b8167021c10273f83bacdd849544))

## [0.27.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.26.0...csa-inabox-v0.27.0) (2026-06-08)


### Features

* **csa-loom:** batch labeling — bulk sensitivity labels (Cosmos + Purview + opt-in Power BI) ([#884](https://github.com/fgarofalo56/csa-inabox/issues/884)) ([7b7d155](https://github.com/fgarofalo56/csa-inabox/commit/7b7d155f13a087cf760df67a91115b1cd210b23e))
* **csa-loom:** bulk import data products via CSV flyout + polled job monitor ([#898](https://github.com/fgarofalo56/csa-inabox/issues/898)) ([a7fc93d](https://github.com/fgarofalo56/csa-inabox/commit/a7fc93df22b16e390038ad02d6dbca93be427271))
* **csa-loom:** catalog Explore upgrade — live domains, AI Search facets, discoverable items (F1) ([#877](https://github.com/fgarofalo56/csa-inabox/issues/877)) ([0c4ce02](https://github.com/fgarofalo56/csa-inabox/commit/0c4ce02d76e3f616e230a045dd8d6eec9f574299))
* **csa-loom:** custom attributes / attribute groups admin (F17) ([#907](https://github.com/fgarofalo56/csa-inabox/issues/907)) ([318de92](https://github.com/fgarofalo56/csa-inabox/commit/318de92f913c64fa24be9aca56c9497bd8ee40eb))
* **csa-loom:** data marketplace consumer discovery (F14/F18) ([#912](https://github.com/fgarofalo56/csa-inabox/issues/912)) ([6885d5d](https://github.com/fgarofalo56/csa-inabox/commit/6885d5d2061b23f8065f2f3296fff73d12c2094c))
* **csa-loom:** data product creation wizard (Purview Unified Catalog parity) ([#896](https://github.com/fgarofalo56/csa-inabox/issues/896)) ([84d2349](https://github.com/fgarofalo56/csa-inabox/commit/84d234989e09480d6206e54d03f4d20678a7afe4))
* **csa-loom:** Data Product Edit Dialog + Endorse (Marketplace F4, F7) ([#901](https://github.com/fgarofalo56/csa-inabox/issues/901)) ([cb7ebd6](https://github.com/fgarofalo56/csa-inabox/commit/cb7ebd6f15c8212eb10fd077213d417035b0222e))
* **csa-loom:** data product owner details page (F3) — Cosmos-backed read view ([#904](https://github.com/fgarofalo56/csa-inabox/issues/904)) ([26aec30](https://github.com/fgarofalo56/csa-inabox/commit/26aec30e0bedae170b5802af199e8392f79634a8))
* **csa-loom:** data-product inline attribute panels — Update frequency + Terms of use + Documentation (F5/F11/F12) ([#893](https://github.com/fgarofalo56/csa-inabox/issues/893)) ([30a826c](https://github.com/fgarofalo56/csa-inabox/commit/30a826c5305ad8a2234e463126534c97fbc29a80))
* **csa-loom:** data-product Linked resources — glossary terms + OKRs + CDEs (F10) ([#908](https://github.com/fgarofalo56/csa-inabox/issues/908)) ([7b18ac0](https://github.com/fgarofalo56/csa-inabox/commit/7b18ac0fa8bf900f8e34c51e1d41e247015920a5))
* **csa-loom:** data-product observability tab + DQ score gauge + health actions (F19/F20) ([#910](https://github.com/fgarofalo56/csa-inabox/issues/910)) ([bbfa01b](https://github.com/fgarofalo56/csa-inabox/commit/bbfa01b8fca0fef46322bafe01511ec84e8a6609))
* **csa-loom:** data-product publish/unpublish/expire lifecycle (F6) ([#900](https://github.com/fgarofalo56/csa-inabox/issues/900)) ([f1de99e](https://github.com/fgarofalo56/csa-inabox/commit/f1de99e73093a8473bd40ce693010283ddfdf5f4))
* **csa-loom:** DataProductStore interface + Cosmos default adapter (replace data-product honest-gates) ([#888](https://github.com/fgarofalo56/csa-inabox/issues/888)) ([e9cd0d1](https://github.com/fgarofalo56/csa-inabox/commit/e9cd0d1145a95055dda58a47f7c8ed8cce8004a0))
* **csa-loom:** DLP policies + violations, tips, trigger-scan, restrict-access (F22) ([#885](https://github.com/fgarofalo56/csa-inabox/issues/885)) ([90b7d2a](https://github.com/fgarofalo56/csa-inabox/commit/90b7d2accabca78702b6cedbf77027e9d0055d4f))
* **csa-loom:** Domains F4 — settings side-pane (6 tabs), image gallery, assign-workspaces, governance view ([#889](https://github.com/fgarofalo56/csa-inabox/issues/889)) ([85d5065](https://github.com/fgarofalo56/csa-inabox/commit/85d5065f7dfa01091d3a2d10d26afe9adfa50c2b))
* **csa-loom:** export protection + protected/label-based access control (F19/F20/F21) ([#913](https://github.com/fgarofalo56/csa-inabox/issues/913)) ([f491a54](https://github.com/fgarofalo56/csa-inabox/commit/f491a54535d76abd7a6ff87b2e158974e6be5cdb))
* **csa-loom:** F13 precondition-gated delete for data products ([#905](https://github.com/fgarofalo56/csa-inabox/issues/905)) ([79a9845](https://github.com/fgarofalo56/csa-inabox/commit/79a9845ec24f8abab0bed58e94b8aa1d9df0d290))
* **csa-loom:** F15 consumer data-product view + purpose-bound request access ([#903](https://github.com/fgarofalo56/csa-inabox/issues/903)) ([699d4fc](https://github.com/fgarofalo56/csa-inabox/commit/699d4fca3de0f194015233b825b2ec4fddeddacd))
* **csa-loom:** F16 access-request approval workflow + real RBAC grant ([#909](https://github.com/fgarofalo56/csa-inabox/issues/909)) ([b5b1f73](https://github.com/fgarofalo56/csa-inabox/commit/b5b1f73eb6cd5d0f4eaf0902564b788d7803496b))
* **csa-loom:** F21 publish data product as consumable APIM API ([#899](https://github.com/fgarofalo56/csa-inabox/issues/899)) ([46a3f7d](https://github.com/fgarofalo56/csa-inabox/commit/46a3f7dc166977ed8bbea5c9ea7230754981d9e4))
* **csa-loom:** F4 governance domains — Cosmos CRUD + Purview mirror, opt-in Fabric Admin ([#880](https://github.com/fgarofalo56/csa-inabox/issues/880)) ([50d7ec8](https://github.com/fgarofalo56/csa-inabox/commit/50d7ec8d3a432a0dbfff8fe217883aff6404e20b))
* **csa-loom:** F5 workspace roles & Manage Access — Cosmos + Azure RBAC mirror ([#883](https://github.com/fgarofalo56/csa-inabox/issues/883)) ([1d20734](https://github.com/fgarofalo56/csa-inabox/commit/1d207347e220977b11ebcee7c2e7f026e3213590))
* **csa-loom:** F8 Manage Policies — data-product access-policy editor ([#911](https://github.com/fgarofalo56/csa-inabox/issues/911)) ([06a8f2a](https://github.com/fgarofalo56/csa-inabox/commit/06a8f2a89fdf2b73ddc426682c401a383dd9f012))
* **csa-loom:** F8 OneLake RLS WHERE-predicate editor ([#892](https://github.com/fgarofalo56/csa-inabox/issues/892)) ([7028310](https://github.com/fgarofalo56/csa-inabox/commit/7028310424a62dde25f74d99e47839b01d9a496c))
* **csa-loom:** F9 add/remove data assets on data products (Purview Data Map) ([#902](https://github.com/fgarofalo56/csa-inabox/issues/902)) ([462337e](https://github.com/fgarofalo56/csa-inabox/commit/462337e169fe59d08acb06b1608400bba0648118))
* **csa-loom:** Govern tab Admin view (F2) — posture tiles, Copilot, embedded report ([#895](https://github.com/fgarofalo56/csa-inabox/issues/895)) ([aab1616](https://github.com/fgarofalo56/csa-inabox/commit/aab1616a4ec91e0f66ba4b3bd99aa48311aeea47))
* **csa-loom:** Govern tab data-owner view (F3) — My-items posture, on-open refresh ([#894](https://github.com/fgarofalo56/csa-inabox/issues/894)) ([4465a4b](https://github.com/fgarofalo56/csa-inabox/commit/4465a4be14089e4d90c0fbac37665f57683d8fdc))
* **csa-loom:** item-level permissions & sharing (F6) — Azure-native default ([#886](https://github.com/fgarofalo56/csa-inabox/issues/886)) ([3556c37](https://github.com/fgarofalo56/csa-inabox/commit/3556c37f387786831416d4bf49afcf70c6dd78fe))
* **csa-loom:** OneLake column-level security (CLS) — hidden-column editor (F9) ([#878](https://github.com/fgarofalo56/csa-inabox/issues/878)) ([b17f915](https://github.com/fgarofalo56/csa-inabox/commit/b17f9155010b5147a61cad463c777adeb247143a))
* **csa-loom:** OneLake Security tab + role wizard (F7) — Azure-native ADLS ACL backend ([#891](https://github.com/fgarofalo56/csa-inabox/issues/891)) ([4c4de06](https://github.com/fgarofalo56/csa-inabox/commit/4c4de06623d479225bbd7916dab282c67f59d037))
* **csa-loom:** Purview Unified Catalog opt-in data-product adapter + Settings backend indicator (F22) ([#906](https://github.com/fgarofalo56/csa-inabox/issues/906)) ([4c15f9e](https://github.com/fgarofalo56/csa-inabox/commit/4c15f9ee443c524aab3f44439ffba85d0b43a04b))
* **csa-loom:** reusable Graph identity picker (user/group/SPN + nested groups) ([#881](https://github.com/fgarofalo56/csa-inabox/issues/881)) ([3fa0681](https://github.com/fgarofalo56/csa-inabox/commit/3fa06819eaa32d4365c49c1f9d9f1f82722955f8))
* **csa-loom:** sensitivity-label flyout (F12) + live Graph taxonomy ([#879](https://github.com/fgarofalo56/csa-inabox/issues/879)) ([e42e247](https://github.com/fgarofalo56/csa-inabox/commit/e42e24704d71e5e0a27e87113562809fc4ae6027))
* **csa-loom:** sensitivity-label inheritance + downstream propagation (F15/F16/F17) ([#897](https://github.com/fgarofalo56/csa-inabox/issues/897)) ([e7600a0](https://github.com/fgarofalo56/csa-inabox/commit/e7600a04492af117fab69c9dafb5ad2f95040f76))
* **csa-loom:** shared cloud-endpoints resolver for governance clients ([#876](https://github.com/fgarofalo56/csa-inabox/issues/876)) ([af12dc0](https://github.com/fgarofalo56/csa-inabox/commit/af12dc059962347170ae5ce56723fb9f1f4988b8))
* **csa-loom:** SQL endpoint data-access mode — delegated vs user's identity (F10) ([#882](https://github.com/fgarofalo56/csa-inabox/issues/882)) ([0a3f409](https://github.com/fgarofalo56/csa-inabox/commit/0a3f4097252a53e453b931e69d76a3b1c58f65b6))
* **csa-loom:** SQL granular security wizards — GRANT/RLS/DDM over TDS (F11) ([#887](https://github.com/fgarofalo56/csa-inabox/issues/887)) ([2a70a75](https://github.com/fgarofalo56/csa-inabox/commit/2a70a75d8c8ce8c9392ea1abc6bbc6b29a6eafe0))


### Documentation

* **csa-loom:** per-surface parity docs for the 9 built Governance surfaces + scorecard ([#890](https://github.com/fgarofalo56/csa-inabox/issues/890)) ([e59c554](https://github.com/fgarofalo56/csa-inabox/commit/e59c5547e75c7d0595f74502f4b737513950d6d3))

## [0.26.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.25.0...csa-inabox-v0.26.0) (2026-06-07)


### Features

* **csa-loom:** AML Compute-Instance Jupyter Server proxy (contents + kernel execute) ([#868](https://github.com/fgarofalo56/csa-inabox/issues/868)) ([04ca67e](https://github.com/fgarofalo56/csa-inabox/commit/04ca67e9c823450e5d1bf02059a006212ffb4616))
* **csa-loom:** Compute Instance API — list / start / status ([#858](https://github.com/fgarofalo56/csa-inabox/issues/858)) ([1e9e51c](https://github.com/fgarofalo56/csa-inabox/commit/1e9e51c5e1fe94bdfa4ac0d3ecde3f7389888469))
* **csa-loom:** Data Science experience home + switcher entry ([#870](https://github.com/fgarofalo56/csa-inabox/issues/870)) ([cf85173](https://github.com/fgarofalo56/csa-inabox/commit/cf851738fe9f959113b4d2e6cfe0a4870ec67305))
* **csa-loom:** display(df) rich grid + chart recommendations (notebook) ([#871](https://github.com/fgarofalo56/csa-inabox/issues/871)) ([c969580](https://github.com/fgarofalo56/csa-inabox/commit/c96958066d3693611ef46d8891c66bf08bb97f26))
* **csa-loom:** Fix with Copilot — inline error remediation for notebook cells ([#856](https://github.com/fgarofalo56/csa-inabox/issues/856)) ([6d3ef60](https://github.com/fgarofalo56/csa-inabox/commit/6d3ef60101276e747b82c95d59e201c5612707fe))
* **csa-loom:** full MLflow ML Experiment editor (sortable runs, step charts, compare, IL5 gate) ([#872](https://github.com/fgarofalo56/csa-inabox/issues/872)) ([3256248](https://github.com/fgarofalo56/csa-inabox/commit/3256248a825b47e5c51e3cd48c5f706bbf00a7ec))
* **csa-loom:** in-cell Copilot for the notebook editor (Fabric parity) ([#860](https://github.com/fgarofalo56/csa-inabox/issues/860)) ([9ec8f0e](https://github.com/fgarofalo56/csa-inabox/commit/9ec8f0e67b624fe48395daa94b4c52ce84388eed))
* **csa-loom:** inline code completion (ghost text) in notebook cells ([#861](https://github.com/fgarofalo56/csa-inabox/issues/861)) ([f14efa5](https://github.com/fgarofalo56/csa-inabox/commit/f14efa5b04f58e3e5d938159fe0b7d627250e3f2))
* **csa-loom:** ml-model editor — MLflow stage transitions, register-from-run lineage, gov-cloud host ([#865](https://github.com/fgarofalo56/csa-inabox/issues/865)) ([95e041b](https://github.com/fgarofalo56/csa-inabox/commit/95e041b1f818b61196c83986f028ceb5c3be3ae6))
* **csa-loom:** Monaco notebook cells + Pylance/pylsp LSP bridge (Azure-native) ([#866](https://github.com/fgarofalo56/csa-inabox/issues/866)) ([45d8a8f](https://github.com/fgarofalo56/csa-inabox/commit/45d8a8fb80a3a36e8230fb20b4fa8e192e043530))
* **csa-loom:** notebook Azure ML path — CI selector, auto-start, datastore explorer, .ipynb run ([#873](https://github.com/fgarofalo56/csa-inabox/issues/873)) ([7ac289e](https://github.com/fgarofalo56/csa-inabox/commit/7ac289e9c8362e20b65cf889e1c04261f3a9db82))
* **csa-loom:** notebook cell authoring + %%pyspark Spark routing (AML / Synapse Livy) ([#874](https://github.com/fgarofalo56/csa-inabox/issues/874)) ([8429974](https://github.com/fgarofalo56/csa-inabox/commit/842997483dd38b5754090540a67da3d284139170))
* **csa-loom:** notebook Configure-session dialog + Spark session status badge ([#863](https://github.com/fgarofalo56/csa-inabox/issues/863)) ([c9384e9](https://github.com/fgarofalo56/csa-inabox/commit/c9384e96b07dbdce311263c57abaa08acf515398))
* **csa-loom:** notebook Copilot chat pane — streaming AOAI, slash commands, apply-to-notebook ([#862](https://github.com/fgarofalo56/csa-inabox/issues/862)) ([c7618cd](https://github.com/fgarofalo56/csa-inabox/commit/c7618cdc4061b4e40ac0d27795a3ffa6e8b3a6f7))
* **csa-loom:** notebook Library & Environment management (AML-backed, no Fabric) ([#864](https://github.com/fgarofalo56/csa-inabox/issues/864)) ([37cfa3d](https://github.com/fgarofalo56/csa-inabox/commit/37cfa3d7341e34a40dbfad725a85b00c65110cf4))
* **csa-loom:** notebook scheduling via AML job schedule REST (recurrence, no cron) ([#859](https://github.com/fgarofalo56/csa-inabox/issues/859)) ([853234b](https://github.com/fgarofalo56/csa-inabox/commit/853234b02e659767e596a318299669d7c7bf860b))
* **csa-loom:** notebook Variable explorer (Name/Type/Length/Value, sortable, Python-only) ([#857](https://github.com/fgarofalo56/csa-inabox/issues/857)) ([259b148](https://github.com/fgarofalo56/csa-inabox/commit/259b1482316d74e266d6446f28188d041d5327fc))
* **csa-loom:** resolveAmlTarget() + AML control-plane REST client (foundation) ([#867](https://github.com/fgarofalo56/csa-inabox/issues/867)) ([e593183](https://github.com/fgarofalo56/csa-inabox/commit/e5931830f1cc4b846d6d002e46e16be460cedf56))


### Documentation

* **csa-loom:** Data Science parity doc + bicep/teardown sync (no-Fabric default) ([#869](https://github.com/fgarofalo56/csa-inabox/issues/869)) ([3aa4ccc](https://github.com/fgarofalo56/csa-inabox/commit/3aa4ccc0c3d4c6f1e9b218b9a8dee8420611aa3e))

## [0.25.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.24.0...csa-inabox-v0.25.0) (2026-06-07)


### Features

* **csa-loom:** Activator action editor — action group CRUD + Logic App actions ([#845](https://github.com/fgarofalo56/csa-inabox/issues/845)) ([bdf1634](https://github.com/fgarofalo56/csa-inabox/commit/bdf1634d8aa08e9e636542c6fee87a612f92286d))
* **csa-loom:** Activator rule wizard backed by Azure Monitor scheduled-query alerts ([#847](https://github.com/fgarofalo56/csa-inabox/issues/847)) ([2fbc9e4](https://github.com/fgarofalo56/csa-inabox/commit/2fbc9e47181918d100c9b94cb54945ec560b4493))
* **csa-loom:** Activator run history + trigger log (Azure Monitor alert instances) ([#854](https://github.com/fgarofalo56/csa-inabox/issues/854)) ([32144f4](https://github.com/fgarofalo56/csa-inabox/commit/32144f40c6a3c7e04a62d9349c71911bdb052541))
* **csa-loom:** ADX follower database attach (database shortcut) ([#818](https://github.com/fgarofalo56/csa-inabox/issues/818)) ([6ebbb55](https://github.com/fgarofalo56/csa-inabox/commit/6ebbb550470f561986e155e9712edad02ec31f53))
* **csa-loom:** ASA lifecycle + live metric tiles on the Stream Analytics editor ([#833](https://github.com/fgarofalo56/csa-inabox/issues/833)) ([5b61e72](https://github.com/fgarofalo56/csa-inabox/commit/5b61e72ee111b7225bc0a0f7ce537458e0b8dbb6))
* **csa-loom:** bicep + env sync for RTI — ADX cluster MI grants + RTI env vars ([#848](https://github.com/fgarofalo56/csa-inabox/issues/848)) ([0043821](https://github.com/fgarofalo56/csa-inabox/commit/004382146db1a9b4f7632721a2260534c7d264d8))
* **csa-loom:** cross-service query source binder (ADX + Log Analytics / App Insights) ([#832](https://github.com/fgarofalo56/csa-inabox/issues/832)) ([73f9e5e](https://github.com/fgarofalo56/csa-inabox/commit/73f9e5ecacaa4d1e2aace93c6342907813458e0f))
* **csa-loom:** enrich one-click ingestion pickers in the Get Data wizard ([#820](https://github.com/fgarofalo56/csa-inabox/issues/820)) ([1b21829](https://github.com/fgarofalo56/csa-inabox/commit/1b21829466b70d06a66e9fd31e1c8f9faa845935))
* **csa-loom:** Event Hubs streaming data connection wizard for KQL database ([#830](https://github.com/fgarofalo56/csa-inabox/issues/830)) ([56c3122](https://github.com/fgarofalo56/csa-inabox/commit/56c31226870eb8a53e67264336f2a29550475c83))
* **csa-loom:** Eventhouse capacity / throttle panel (ADX-native) ([#842](https://github.com/fgarofalo56/csa-inabox/issues/842)) ([b820499](https://github.com/fgarofalo56/csa-inabox/commit/b820499db51b71a4913452001ef241c4c8bf86ba))
* **csa-loom:** Eventhouse lakehouse/warehouse Delta endpoint (ADX external table + query acceleration) ([#843](https://github.com/fgarofalo56/csa-inabox/issues/843)) ([14d1584](https://github.com/fgarofalo56/csa-inabox/commit/14d15840ee8b3e7b4ffe0932ee9d5df8c79e5502))
* **csa-loom:** eventhouse OneLake availability via ADX continuous-export to ADLS Delta ([#834](https://github.com/fgarofalo56/csa-inabox/issues/834)) ([c7a766c](https://github.com/fgarofalo56/csa-inabox/commit/c7a766ce543fb2d2701af684b78d7ee98bb9b7c6))
* **csa-loom:** Eventhouse optimized auto-scale controls (ADX ARM, no Fabric) ([#821](https://github.com/fgarofalo56/csa-inabox/issues/821)) ([5333093](https://github.com/fgarofalo56/csa-inabox/commit/5333093eb2d84137f722ccfef2648e7c1a2bb9f6))
* **csa-loom:** eventhouse purge table records (GDPR erasure) ([#828](https://github.com/fgarofalo56/csa-inabox/issues/828)) ([f586e01](https://github.com/fgarofalo56/csa-inabox/commit/f586e0154598c64ebe7d7f6a1733d402ff38eda9))
* **csa-loom:** Eventhouse system overview panel (live ADX + Monitor) ([#819](https://github.com/fgarofalo56/csa-inabox/issues/819)) ([d28951d](https://github.com/fgarofalo56/csa-inabox/commit/d28951de0bc2d755d17319754e9f5a905f566ac0))
* **csa-loom:** eventstream canvas → real Event Hubs + Stream Analytics backend ([#844](https://github.com/fgarofalo56/csa-inabox/issues/844)) ([fa72f7d](https://github.com/fgarofalo56/csa-inabox/commit/fa72f7df048708b2aa3fc38063eee479de76ac50))
* **csa-loom:** eventstream destination wizards → real ASA outputs ([#849](https://github.com/fgarofalo56/csa-inabox/issues/849)) ([cb4cce3](https://github.com/fgarofalo56/csa-inabox/commit/cb4cce3a324f47864920f728312b686de7bbe338))
* **csa-loom:** eventstream source-node provisioning wizards (EH/IoT/Kafka/CDC/custom) ([#851](https://github.com/fgarofalo56/csa-inabox/issues/851)) ([36e2c2d](https://github.com/fgarofalo56/csa-inabox/commit/36e2c2db358043a44c3ddd67e8b4e75d07f0ef37))
* **csa-loom:** full Databases browser for Eventhouse (tile/list, delete, new-tab) ([#825](https://github.com/fgarofalo56/csa-inabox/issues/825)) ([eb5c9d0](https://github.com/fgarofalo56/csa-inabox/commit/eb5c9d0baac571138c81491b4ac8c64d22ab438f))
* **csa-loom:** guided ASA transform-node builder in Eventstream (compile + test query) ([#853](https://github.com/fgarofalo56/csa-inabox/issues/853)) ([cef8d17](https://github.com/fgarofalo56/csa-inabox/commit/cef8d17daa257d5669168bd980fa8440242c1f46))
* **csa-loom:** injection-safe dashboard parameter engine (declare query_parameters) ([#838](https://github.com/fgarofalo56/csa-inabox/issues/838)) ([64c590b](https://github.com/fgarofalo56/csa-inabox/commit/64c590b4f9f1bd1cccc311f9ef08b4f856d40a14))
* **csa-loom:** IoT Hub data connection wizard for KQL Database (ADX, Azure-native) ([#837](https://github.com/fgarofalo56/csa-inabox/issues/837)) ([f221b9b](https://github.com/fgarofalo56/csa-inabox/commit/f221b9ba14474c40f5a3c02ace80a07bd6cb63e5))
* **csa-loom:** KQL dashboard auto-refresh interval picker + tile drill-through ([#836](https://github.com/fgarofalo56/csa-inabox/issues/836)) ([1ebc174](https://github.com/fgarofalo56/csa-inabox/commit/1ebc174e5b0961581128c7278767607d396121c4))
* **csa-loom:** KQL Database entity diagram (React Flow) over live ADX schema ([#822](https://github.com/fgarofalo56/csa-inabox/issues/822)) ([f5a4646](https://github.com/fgarofalo56/csa-inabox/commit/f5a46462b455873314f0b0a94859d0f0c1c244c9))
* **csa-loom:** KQL DB ingestion mapping wizard + auto-detect ([#835](https://github.com/fgarofalo56/csa-inabox/issues/835)) ([fde8d85](https://github.com/fgarofalo56/csa-inabox/commit/fde8d8585da72905f7d40a792fabb56683241cfa))
* **csa-loom:** KQL Queryset parity — column resize + Share ([#829](https://github.com/fgarofalo56/csa-inabox/issues/829)) ([b32c409](https://github.com/fgarofalo56/csa-inabox/commit/b32c409e93d2abf692fe5b32b558fdd0baf2b4e7))
* **csa-loom:** kql-dashboard tile edit flyout + base queries (RTD parity) ([#839](https://github.com/fgarofalo56/csa-inabox/issues/839)) ([80ea25c](https://github.com/fgarofalo56/csa-inabox/commit/80ea25c7ecdffb978cafa28230ff6f34688e463b))
* **csa-loom:** materialized-views editor — source-table picker, monaco-kusto body, backfill toggle ([#824](https://github.com/fgarofalo56/csa-inabox/issues/824)) ([fde1237](https://github.com/fgarofalo56/csa-inabox/commit/fde1237a464f2cf941445365e855a245457db2c3))
* **csa-loom:** NL2KQL Copilot edge for the KQL Queryset editor ([#826](https://github.com/fgarofalo56/csa-inabox/issues/826)) ([da730b6](https://github.com/fgarofalo56/csa-inabox/commit/da730b6c6174b81f52fcb1ce21bc3e63dbec4635))
* **csa-loom:** per-tile conditional formatting for Real-Time Dashboard ([#840](https://github.com/fgarofalo56/csa-inabox/issues/840)) ([ac3ca61](https://github.com/fgarofalo56/csa-inabox/commit/ac3ca61719436fb8b1fb294f71a5b1744dcb1e93))
* **csa-loom:** Real-Time Intelligence hub — unified cross-subscription stream catalog ([#852](https://github.com/fgarofalo56/csa-inabox/issues/852)) ([fd4fa11](https://github.com/fgarofalo56/csa-inabox/commit/fd4fa11751aefc83b030afa283ca3a66760aac3c))
* **csa-loom:** structured stored-function editor for the KQL DB editor ([#841](https://github.com/fgarofalo56/csa-inabox/issues/841)) ([39bee2b](https://github.com/fgarofalo56/csa-inabox/commit/39bee2ba1c3c74f936d1be341094eb0804cd2d81))
* **csa-loom:** update policy wizard in the KQL DB editor (ADX transform-on-ingest) ([#823](https://github.com/fgarofalo56/csa-inabox/issues/823)) ([2997b48](https://github.com/fgarofalo56/csa-inabox/commit/2997b4800b9290273619185d7502fdde67931e9f))
* **csa-loom:** visual table schema designer for KQL DB (create/alter/drop) ([#827](https://github.com/fgarofalo56/csa-inabox/issues/827)) ([fc7a695](https://github.com/fgarofalo56/csa-inabox/commit/fc7a69538c3383ac4956ec20f96643d71132b8c0))
* **csa-loom:** wire all six AdxDatabaseTree table hover actions to real ops ([#831](https://github.com/fgarofalo56/csa-inabox/issues/831)) ([d9cebb9](https://github.com/fgarofalo56/csa-inabox/commit/d9cebb98f86423105165cf3b0262bc05953f430a))
* **csa-loom:** wire eventhouse streaming-ingestion toggle to real ARM PATCH ([#817](https://github.com/fgarofalo56/csa-inabox/issues/817)) ([ede51cf](https://github.com/fgarofalo56/csa-inabox/commit/ede51cfa38f5717838761f5c09f64fab36c890ad))
* **csa-loom:** workspace-monitoring eventhouse provisioner (Azure Monitor -&gt; read-only ADX + dashboard) ([#850](https://github.com/fgarofalo56/csa-inabox/issues/850)) ([0dec04c](https://github.com/fgarofalo56/csa-inabox/commit/0dec04c91ce4dadfe8dce0e6a509b2b3614226db))


### Bug Fixes

* **ci:** release-please auto-pass must cover "next build (node 20)" ([#815](https://github.com/fgarofalo56/csa-inabox/issues/815)) ([ecb9683](https://github.com/fgarofalo56/csa-inabox/commit/ecb9683418c16d338c666e121f2e1cad289df6f9))
* **csa-loom:** cloud-endpoint + RBAC sweep — central cloud-endpoints, sovereign-cloud-correct everywhere ([#855](https://github.com/fgarofalo56/csa-inabox/issues/855)) ([970c006](https://github.com/fgarofalo56/csa-inabox/commit/970c006a85f337fa05ab04922dbb0e5346d0bf1f))


### Documentation

* **csa-loom:** per-surface RTI parity docs for all seven Real-Time Intelligence experiences ([#846](https://github.com/fgarofalo56/csa-inabox/issues/846)) ([a913ac9](https://github.com/fgarofalo56/csa-inabox/commit/a913ac9e61340ca2923fd314e4da3a8c289f9d1d))

## [0.24.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.23.0...csa-inabox-v0.24.0) (2026-06-07)


### Features

* **csa-loom:** A+ parity [#37](https://github.com/fgarofalo56/csa-inabox/issues/37) — Copy activity guided settings (no JSON-first config) ([#689](https://github.com/fgarofalo56/csa-inabox/issues/689)) ([4695ef0](https://github.com/fgarofalo56/csa-inabox/commit/4695ef0434ef8d2597de3db1bcb469916d49929b))
* **csa-loom:** access-policy wizard — selectable scope + per-kind rule builder (no freeform) ([#626](https://github.com/fgarofalo56/csa-inabox/issues/626)) ([a6c5249](https://github.com/fgarofalo56/csa-inabox/commit/a6c52495544ffcc72fc0bbcc79c8ae620f4f975b))
* **csa-loom:** access-policy wizard now ENFORCES (real Storage RBAC) ([#703](https://github.com/fgarofalo56/csa-inabox/issues/703)) ([faf495c](https://github.com/fgarofalo56/csa-inabox/commit/faf495c11b6493b4c08da3f9dd3fee749ff5d2b6))
* **csa-loom:** Activator rule wizard — no JSON (global no-freeform-config rule) ([#630](https://github.com/fgarofalo56/csa-inabox/issues/630)) ([8bbcd2a](https://github.com/fgarofalo56/csa-inabox/commit/8bbcd2a89772b7ac311c8509b8c7ff640a957472))
* **csa-loom:** add Rayfin app (Fabric Apps) item type + editor (Build 2026 preview) ([#615](https://github.com/fgarofalo56/csa-inabox/issues/615)) ([72d0359](https://github.com/fgarofalo56/csa-inabox/commit/72d035988683b1d30d479c3035fd0f3f36881c01))
* **csa-loom:** ADF Output-tab Log Analytics fallback + SetVariable parallel-ForEach banner ([#799](https://github.com/fgarofalo56/csa-inabox/issues/799)) ([7d30cbd](https://github.com/fgarofalo56/csa-inabox/commit/7d30cbdad9b2b3733de19ba3787dea5442d90c00))
* **csa-loom:** ADF trigger wizard — Schedule/Tumbling/Storage-events/Custom-events (no cron, no JSON) ([#695](https://github.com/fgarofalo56/csa-inabox/issues/695)) ([cdc4149](https://github.com/fgarofalo56/csa-inabox/commit/cdc4149a16be4d19f2d49d30c19b2c372b776b9d))
* **csa-loom:** ADF/Synapse dataset guided config — no raw typeProperties JSON ([#696](https://github.com/fgarofalo56/csa-inabox/issues/696)) ([7525732](https://github.com/fgarofalo56/csa-inabox/commit/752573213bf015d2becaa8ff4873ec05b5e49923))
* **csa-loom:** admin API management page — full APIM control for the marketplace ([#648](https://github.com/fgarofalo56/csa-inabox/issues/648)) ([9999b78](https://github.com/fgarofalo56/csa-inabox/commit/9999b78dcd826d1056e131666f0b8cccf84d6ba7))
* **csa-loom:** admin Health & self-audit tab + agent-loom healer ([#636](https://github.com/fgarofalo56/csa-inabox/issues/636)) ([a57ae58](https://github.com/fgarofalo56/csa-inabox/commit/a57ae5808c513449200f6ab7e6eae7337104f98c))
* **csa-loom:** API Marketplace — manage subscriptions + use APIs as a source + mini-app builder ([#763](https://github.com/fgarofalo56/csa-inabox/issues/763)) ([3738ddb](https://github.com/fgarofalo56/csa-inabox/commit/3738ddbe0ef4b963e97f064690458e91ff375d3d))
* **csa-loom:** APIM AI-gateway LLM policy snippets (Build 2026) ([#623](https://github.com/fgarofalo56/csa-inabox/issues/623)) ([73079ff](https://github.com/fgarofalo56/csa-inabox/commit/73079ffdd1e4482f07e772e0ba7a4f879aae7262))
* **csa-loom:** app install — choose target folder + clearer Fabric-workspace gate ([#608](https://github.com/fgarofalo56/csa-inabox/issues/608)) ([5c17534](https://github.com/fgarofalo56/csa-inabox/commit/5c17534ef5718cbb218b0753ecdc1dfa8a24e6c2))
* **csa-loom:** Approval activity (Logic App + O365) for pipelines (F25) ([#814](https://github.com/fgarofalo56/csa-inabox/issues/814)) ([8fa9b0d](https://github.com/fgarofalo56/csa-inabox/commit/8fa9b0d3220f81f5752a58b9658128c13fc050b8))
* **csa-loom:** auto-onboard every Loom item to Microsoft Purview on create ([#754](https://github.com/fgarofalo56/csa-inabox/issues/754)) ([9c76258](https://github.com/fgarofalo56/csa-inabox/commit/9c762589a4e68a2e54665055d9827a0c8a4f5605))
* **csa-loom:** Azure Functions-hosted MCP tool server + bicep (task-006) ([#712](https://github.com/fgarofalo56/csa-inabox/issues/712)) ([9f59446](https://github.com/fgarofalo56/csa-inabox/commit/9f59446d9de5d55fb8d3f77bc4ccfef93bbc33bc))
* **csa-loom:** Azure-native compute scaling route (ADX SKU, Synapse pause/resume, SHIR scale) ([#663](https://github.com/fgarofalo56/csa-inabox/issues/663)) ([6899029](https://github.com/fgarofalo56/csa-inabox/commit/6899029005f0b68b707f64d9070b21ac0f55fc41))
* **csa-loom:** Azure-native provisioner fallbacks (lakehouse/notebook/semantic-model) + bundle raw-SQL sweep ([#586](https://github.com/fgarofalo56/csa-inabox/issues/586)) ([35b37af](https://github.com/fgarofalo56/csa-inabox/commit/35b37af3d2a6976ce80eb2aeda1216c11053d9f8))
* **csa-loom:** background-job continuity + per-lakehouse toasts (F10) ([#804](https://github.com/fgarofalo56/csa-inabox/issues/804)) ([127f8a5](https://github.com/fgarofalo56/csa-inabox/commit/127f8a5a1b1c3aff3910f1efde7db65f86f491f2))
* **csa-loom:** bicep env wiring for Azure-native backends + de-Fabric bundle copy ([#638](https://github.com/fgarofalo56/csa-inabox/issues/638)) ([28af309](https://github.com/fgarofalo56/csa-inabox/commit/28af3092c807e530fc16d0556db6cfa2d94c5419))
* **csa-loom:** Browse 'All items' explorer — every tenant item, color-coded, filter/group/KPI ([#622](https://github.com/fgarofalo56/csa-inabox/issues/622)) ([892da63](https://github.com/fgarofalo56/csa-inabox/commit/892da637e2dc0d37f038b06e5eeb86ea5be9f477))
* **csa-loom:** Capacity & Compute — Scale & manage UI (SKU scaling, pause/resume, web-3.0 cards) ([#666](https://github.com/fgarofalo56/csa-inabox/issues/666)) ([a4069cb](https://github.com/fgarofalo56/csa-inabox/commit/a4069cb913fabb5a39edc96788060079a31c4be9))
* **csa-loom:** catalog UX — OneLake tree expand/collapse + Unified-catalog metadata tile + no column overlap ([#646](https://github.com/fgarofalo56/csa-inabox/issues/646)) ([23d136b](https://github.com/fgarofalo56/csa-inabox/commit/23d136b7b12abf24adb809e2364ea0e97e04504c))
* **csa-loom:** classifications page — real label-taxonomy admin (two-way) ([#704](https://github.com/fgarofalo56/csa-inabox/issues/704)) ([b4f78aa](https://github.com/fgarofalo56/csa-inabox/commit/b4f78aa5943c5c0b9d9e5642737f448ebf0267f1))
* **csa-loom:** clean catalog Browse tree — honest UC 403 gate, clear OneLake(Fabric) labeling, Web-3.0 UI ([#599](https://github.com/fgarofalo56/csa-inabox/issues/599)) ([a7f5ebf](https://github.com/fgarofalo56/csa-inabox/commit/a7f5ebfb67b65b7f70d1a8247a454f60ad98a6d1))
* **csa-loom:** close remaining gaps — pipelines CI, MLflow, ext-shortcut creds, deploy-planner +13, DAB runtime, parity docs ([#581](https://github.com/fgarofalo56/csa-inabox/issues/581)) ([80bec78](https://github.com/fgarofalo56/csa-inabox/commit/80bec7889b4d424d03a049dccea921a0558ef720))
* **csa-loom:** complete Network & DNS — all PEs + A-record hosts file + vNet/subnet + topology graph ([#650](https://github.com/fgarofalo56/csa-inabox/issues/650)) ([1b2f560](https://github.com/fgarofalo56/csa-inabox/commit/1b2f56072de6cde3fb24cf4e0848f9448e9e726e))
* **csa-loom:** Connect MCP tools — agents call external MCP servers ([#19](https://github.com/fgarofalo56/csa-inabox/issues/19)) ([#644](https://github.com/fgarofalo56/csa-inabox/issues/644)) ([a466358](https://github.com/fgarofalo56/csa-inabox/commit/a4663588fd9ab96afcc3fbc441a8d9c7b0545e44))
* **csa-loom:** Copilot build-assist — create/configure OWNED items with state ([#702](https://github.com/fgarofalo56/csa-inabox/issues/702)) ([37c07d5](https://github.com/fgarofalo56/csa-inabox/commit/37c07d5ecf65a79c6234390b41f40b12ee09185a))
* **csa-loom:** Copilot chat shows token usage (parity with data-agent) ([#701](https://github.com/fgarofalo56/csa-inabox/issues/701)) ([b2b5eff](https://github.com/fgarofalo56/csa-inabox/commit/b2b5effdafd7722a6c4ba294319ae56ac0e50ac8))
* **csa-loom:** Copilot is screen-aware (floating overlay knows your page) ([#637](https://github.com/fgarofalo56/csa-inabox/issues/637)) ([8156cfb](https://github.com/fgarofalo56/csa-inabox/commit/8156cfbc5a58489bcb910508f67b2784eb808edb))
* **csa-loom:** Copilot Studio channel settings as guided key/value (no JSON) ([#699](https://github.com/fgarofalo56/csa-inabox/issues/699)) ([e665cba](https://github.com/fgarofalo56/csa-inabox/commit/e665cba8a6361459ee863830aa35d1883de6ac0a))
* **csa-loom:** Copilot tool runner = guided forms (no JSON) + CSA Loom branding ([#647](https://github.com/fgarofalo56/csa-inabox/issues/647)) ([2d51e7c](https://github.com/fgarofalo56/csa-inabox/commit/2d51e7c01e8645cc74a748ddce4fc49d102717b8))
* **csa-loom:** Copy activity Source/Sink/Mapping/Settings tabs (ADF parity F13) ([#793](https://github.com/fgarofalo56/csa-inabox/issues/793)) ([ad7e5d0](https://github.com/fgarofalo56/csa-inabox/commit/ad7e5d032fea5fe89fa26fe45d2a5bf6284d62db))
* **csa-loom:** Copy job wizard + Azure SQL watermark (F14) ([#809](https://github.com/fgarofalo56/csa-inabox/issues/809)) ([1ca7306](https://github.com/fgarofalo56/csa-inabox/commit/1ca7306753b188a62763d55a7227ca5e2247b6b1))
* **csa-loom:** Cosmos NoSQL semantic reranker in the data explorer (Build 2026 preview) ([#620](https://github.com/fgarofalo56/csa-inabox/issues/620)) ([44c1572](https://github.com/fgarofalo56/csa-inabox/commit/44c1572825e68e050f22acb4937730a2993a2385))
* **csa-loom:** create Databricks clusters from the notebook compute picker (no-JSON) ([#654](https://github.com/fgarofalo56/csa-inabox/issues/654)) ([69570ff](https://github.com/fgarofalo56/csa-inabox/commit/69570ffc6cd976a73e5b557982eb5ccad969c017))
* **csa-loom:** Data Agent editor — web-3.0 visual enhancement (Build tab) ([#768](https://github.com/fgarofalo56/csa-inabox/issues/768)) ([aca0810](https://github.com/fgarofalo56/csa-inabox/commit/aca0810c1da9cdd98f503e81649cd0479566aa3e))
* **csa-loom:** data-agent chat surfaces context usage + model + source metadata ([#683](https://github.com/fgarofalo56/csa-inabox/issues/683)) ([ae7b93b](https://github.com/fgarofalo56/csa-inabox/commit/ae7b93b05ef6e6ce0301809ce526728ac5511229))
* **csa-loom:** data-agent conversation history — persist + resume test-chat threads ([#36](https://github.com/fgarofalo56/csa-inabox/issues/36)) ([#684](https://github.com/fgarofalo56/csa-inabox/issues/684)) ([fc7b11d](https://github.com/fgarofalo56/csa-inabox/commit/fc7b11d00adb7b6078a84476a553cdc91e1bd20c))
* **csa-loom:** data-agent executes its generated query on real rows (task-008) ([#714](https://github.com/fgarofalo56/csa-inabox/issues/714)) ([74a5444](https://github.com/fgarofalo56/csa-inabox/commit/74a5444b6e3b2577472a043a5901a05f334862ac))
* **csa-loom:** data-agent multi-source citations + 'tools used' panel ([#700](https://github.com/fgarofalo56/csa-inabox/issues/700)) ([6c22128](https://github.com/fgarofalo56/csa-inabox/commit/6c22128296485f9cf3f7a187dd46412dda55f995))
* **csa-loom:** data-agent publish error surfacing + custom alias + delete ([#718](https://github.com/fgarofalo56/csa-inabox/issues/718)) ([2615867](https://github.com/fgarofalo56/csa-inabox/commit/2615867be920467db450d0a1f4ebb99b3482d3f6))
* **csa-loom:** data-agent renders KPIs/charts/tables + runs queries immediately ([#717](https://github.com/fgarofalo56/csa-inabox/issues/717)) ([893b02c](https://github.com/fgarofalo56/csa-inabox/commit/893b02c6850d13cd03c522e43a282dc25319ad38))
* **csa-loom:** data-pipeline Export/Import + template gallery (F3, F28) ([#808](https://github.com/fgarofalo56/csa-inabox/issues/808)) ([67e9c67](https://github.com/fgarofalo56/csa-inabox/commit/67e9c67463f11c5f07512e82c228df47872f94a0))
* **csa-loom:** data-product classifications pick from the tenant label taxonomy ([#705](https://github.com/fgarofalo56/csa-inabox/issues/705)) ([192dcba](https://github.com/fgarofalo56/csa-inabox/commit/192dcbac15ca13f7023a14498a7fd172069c45ac))
* **csa-loom:** Dataflow Gen2 — Azure-native Power Query Online (F15, no Fabric) ([#798](https://github.com/fgarofalo56/csa-inabox/issues/798)) ([734d7b2](https://github.com/fgarofalo56/csa-inabox/commit/734d7b2df98e2dd484be9378b62f9c188ebb74e2))
* **csa-loom:** dedicated Synapse Serverless SQL editor — IntelliSense + view/proc/iTVF CRUD (F14/T15) ([#801](https://github.com/fgarofalo56/csa-inabox/issues/801)) ([47a3ec9](https://github.com/fgarofalo56/csa-inabox/commit/47a3ec972f28ba58f405c22a14213484cf3dbf63))
* **csa-loom:** Delta maintenance dialog — OPTIMIZE/VACUUM/ZORDER BY on Synapse Spark (F19) ([#813](https://github.com/fgarofalo56/csa-inabox/issues/813)) ([fa7140e](https://github.com/fgarofalo56/csa-inabox/commit/fa7140e648b75b6599cd467563bdbf3b89deef1d))
* **csa-loom:** Delta Sharing shortcut type + Broken badge + Retry (F11) ([#796](https://github.com/fgarofalo56/csa-inabox/issues/796)) ([6f1a6bd](https://github.com/fgarofalo56/csa-inabox/commit/6f1a6bd7afb2a6a698bf25dfb16a6e057139f720))
* **csa-loom:** documented use cases as one-click seeded apps (E2E) ([#582](https://github.com/fgarofalo56/csa-inabox/issues/582)) ([99b1a34](https://github.com/fgarofalo56/csa-inabox/commit/99b1a349c0ddf8bef9c6e4ebf032efb9ac559fae))
* **csa-loom:** Evaluate Expression (pre-run debugger / F9) in the pipeline expression builder ([#802](https://github.com/fgarofalo56/csa-inabox/issues/802)) ([23055e0](https://github.com/fgarofalo56/csa-inabox/commit/23055e0a73aa1ff63d4bef11ba963e780abbd2d2))
* **csa-loom:** every app object opens fully built-out from bundle content ([#593](https://github.com/fgarofalo56/csa-inabox/issues/593)) ([7ced022](https://github.com/fgarofalo56/csa-inabox/commit/7ced022b38d25c2b1f3b2936f3c04c63c2dab4ee))
* **csa-loom:** F13 lakehouse permissions — table/column/row-level security ([#789](https://github.com/fgarofalo56/csa-inabox/issues/789)) ([b73f126](https://github.com/fgarofalo56/csa-inabox/commit/b73f1264d0048f076eb67056c11500ee95d60591))
* **csa-loom:** Fluent DataGrid lakehouse preview + Spark column stats (F3) ([#785](https://github.com/fgarofalo56/csa-inabox/issues/785)) ([55a7d0a](https://github.com/fgarofalo56/csa-inabox/commit/55a7d0a9342bfb46812e62c1cc00483a5ae9710e))
* **csa-loom:** full Spark Job Definition editor + submit/runs/logs/cancel (F17) ([#806](https://github.com/fgarofalo56/csa-inabox/issues/806)) ([041c6e0](https://github.com/fgarofalo56/csa-inabox/commit/041c6e0930ca4f9befb227ab61ae410b7bd267a6))
* **csa-loom:** gate Setup wizard deploy on admin.deploy-dlz capability (task-003) ([#709](https://github.com/fgarofalo56/csa-inabox/issues/709)) ([c738abd](https://github.com/fgarofalo56/csa-inabox/commit/c738abdf9b9d66974609d0b04c95ddb72566ed42))
* **csa-loom:** governance Insights — ownership/endorsement/policy-effectiveness (task-009) ([#715](https://github.com/fgarofalo56/csa-inabox/issues/715)) ([39ef882](https://github.com/fgarofalo56/csa-inabox/commit/39ef88275c488f4a605f7060b3a73621f55c16e7))
* **csa-loom:** Graph-in-Fabric parity on ADX — native graph query, no Fabric dependency ([#661](https://github.com/fgarofalo56/csa-inabox/issues/661)) ([a67f09d](https://github.com/fgarofalo56/csa-inabox/commit/a67f09db043843583d1bad78cb6bb62fd9b1d5b8))
* **csa-loom:** graph-model node/edge guided schema editor (no JSON) ([#698](https://github.com/fgarofalo56/csa-inabox/issues/698)) ([dd4060c](https://github.com/fgarofalo56/csa-inabox/commit/dd4060cd8eda9785b89da2019c82ad5fdf3c1ad4))
* **csa-loom:** guided F-SKU capacity-equivalence panel in Setup wizard (task-004) ([#710](https://github.com/fgarofalo56/csa-inabox/issues/710)) ([4a6f0d4](https://github.com/fgarofalo56/csa-inabox/commit/4a6f0d4dc130061ea35f0ae87c6d415578b0e570))
* **csa-loom:** guided forms for 6 more ADF/Synapse activities (kill raw-JSON config) ([#691](https://github.com/fgarofalo56/csa-inabox/issues/691)) ([dd0eaef](https://github.com/fgarofalo56/csa-inabox/commit/dd0eaefd80acd3f5457ecaab24bcdfcca311566a))
* **csa-loom:** guided key/value editor for Spark conf + column mappings (no JSON) ([#697](https://github.com/fgarofalo56/csa-inabox/issues/697)) ([c4d8494](https://github.com/fgarofalo56/csa-inabox/commit/c4d8494dc5d5907439fa8964478d0fbd7e0fcbb7))
* **csa-loom:** HDInsight pipeline activities — Hive/Spark/MapReduce/Streaming (F17) ([#803](https://github.com/fgarofalo56/csa-inabox/issues/803)) ([ca341bd](https://github.com/fgarofalo56/csa-inabox/commit/ca341bdb74327cb5cd7b0286ca976e4123dbb57f))
* **csa-loom:** Health & Self-audit — per-finding fix instructions (portal steps + copy-paste PowerShell) ([#662](https://github.com/fgarofalo56/csa-inabox/issues/662)) ([c490ed5](https://github.com/fgarofalo56/csa-inabox/commit/c490ed5af641ae9f1f2f5204e4c5d9e18f4218cf))
* **csa-loom:** insights — sortable coverage table with visual bars (governance [#16](https://github.com/fgarofalo56/csa-inabox/issues/16)) ([#628](https://github.com/fgarofalo56/csa-inabox/issues/628)) ([e02a555](https://github.com/fgarofalo56/csa-inabox/commit/e02a5550a54fe65057f892103f157c80ff3d8bf8))
* **csa-loom:** lakehouse folder DnD upload + MIP sensitivity-label stamp on download (F5) ([#792](https://github.com/fgarofalo56/csa-inabox/issues/792)) ([9ec4636](https://github.com/fgarofalo56/csa-inabox/commit/9ec46366151bc6d7cb86bfd9a98769ed137f6f97))
* **csa-loom:** lakehouse liquid clustering + Fabric-only acceleration gates (F12/F22) ([#784](https://github.com/fgarofalo56/csa-inabox/issues/784)) ([2093712](https://github.com/fgarofalo56/csa-inabox/commit/20937126eba33f1d3d1df01799af4bcd8f2ed6bc))
* **csa-loom:** lakehouse multi-schema CRUD + move table (F9) ([#790](https://github.com/fgarofalo56/csa-inabox/issues/790)) ([6c3f381](https://github.com/fgarofalo56/csa-inabox/commit/6c3f381e2594ce9b0da33977f01395cf0897301b))
* **csa-loom:** lakehouse ribbon — Get data + Analyze data + Share menus (F7) ([#795](https://github.com/fgarofalo56/csa-inabox/issues/795)) ([ccdc4ee](https://github.com/fgarofalo56/csa-inabox/commit/ccdc4ee61a2b8bab3878c6c32fd63eb96e8cce78))
* **csa-loom:** lakehouse shortcut wizard — in-tenant ADLS account picker + external SAS + more sources ([#632](https://github.com/fgarofalo56/csa-inabox/issues/632)) ([e5ce1ba](https://github.com/fgarofalo56/csa-inabox/commit/e5ce1bac8e72ece58f73748dd069036c762b916a))
* **csa-loom:** lakehouse table history / time travel (F20) ([#805](https://github.com/fgarofalo56/csa-inabox/issues/805)) ([5d699a6](https://github.com/fgarofalo56/csa-inabox/commit/5d699a6b94dfbb30f642aeedc54f701f0b79f568))
* **csa-loom:** Learning Hub — 'Use cases' section (22 real-world CSA-in-a-Box scenarios) ([#668](https://github.com/fgarofalo56/csa-inabox/issues/668)) ([28735d6](https://github.com/fgarofalo56/csa-inabox/commit/28735d6408dfc377fa8ef5b39bd37c560a0f3d6e))
* **csa-loom:** Learning Hub tile on the home page (prominent, first quick-link) ([#665](https://github.com/fgarofalo56/csa-inabox/issues/665)) ([5bf46af](https://github.com/fgarofalo56/csa-inabox/commit/5bf46afe9ba46e4a8feaddb35c5e11253e304195))
* **csa-loom:** let workspace owners bulk-delete their own workspaces ([#716](https://github.com/fgarofalo56/csa-inabox/issues/716)) ([4609ef6](https://github.com/fgarofalo56/csa-inabox/commit/4609ef6654e5e30099dc5aecf0eff6b0caadca5a))
* **csa-loom:** live Delta Tables catalog for lakehouse (/api/lakehouse/tables) ([#786](https://github.com/fgarofalo56/csa-inabox/issues/786)) ([3cf5c36](https://github.com/fgarofalo56/csa-inabox/commit/3cf5c360d83338084a7b986e7cf538f902c778b7))
* **csa-loom:** Load to Table wizard (F6) for the Lakehouse editor ([#783](https://github.com/fgarofalo56/csa-inabox/issues/783)) ([a48d8a1](https://github.com/fgarofalo56/csa-inabox/commit/a48d8a1c6e6dec226c28f19ba0bd466f510c3f17))
* **csa-loom:** Logic App editor — WDL designer + code view on real ARM ([#595](https://github.com/fgarofalo56/csa-inabox/issues/595)) ([7b85a2d](https://github.com/fgarofalo56/csa-inabox/commit/7b85a2d89dcdc2eb7bb66f213a7060d4f71f2d8c))
* **csa-loom:** Loom Connections — Key Vault-backed reusable source credentials ([#751](https://github.com/fgarofalo56/csa-inabox/issues/751)) ([7d65d19](https://github.com/fgarofalo56/csa-inabox/commit/7d65d19c821a72ea95a4e1d6491a1fb5deba350b))
* **csa-loom:** Loom Thread foundation — universal 'Weave' integration fabric ([#720](https://github.com/fgarofalo56/csa-inabox/issues/720)) ([ae12884](https://github.com/fgarofalo56/csa-inabox/commit/ae1288462fc141295ebcfddfae96fc93c8455e0a))
* **csa-loom:** Loom-native classifications + sensitivity-labels admin (no Purview) ([#642](https://github.com/fgarofalo56/csa-inabox/issues/642)) ([f59721c](https://github.com/fgarofalo56/csa-inabox/commit/f59721c409af9073913c060d036dfdc130494894))
* **csa-loom:** Loom-native governance — domains info-gate + data-quality CRUD (no Purview required) ([#639](https://github.com/fgarofalo56/csa-inabox/issues/639)) ([16536b5](https://github.com/fgarofalo56/csa-inabox/commit/16536b5a0aeb9c0726c907ecf3f763c967fc198b))
* **csa-loom:** Manage hub on all 3 pipeline editors + guided no-JSON linked services ([#657](https://github.com/fgarofalo56/csa-inabox/issues/657)) ([098c40a](https://github.com/fgarofalo56/csa-inabox/commit/098c40a92bba8f3b0a0e0aaa345bedd8da62b07c))
* **csa-loom:** mirror — incremental change-feed delta for the SQL family ([#778](https://github.com/fgarofalo56/csa-inabox/issues/778)) ([81e172e](https://github.com/fgarofalo56/csa-inabox/commit/81e172ed05cd40479627215c97e279f3d15d82bc))
* **csa-loom:** mirror engine — add PostgreSQL + Cosmos DB sources (Azure-native snapshot) ([#773](https://github.com/fgarofalo56/csa-inabox/issues/773)) ([388006f](https://github.com/fgarofalo56/csa-inabox/commit/388006ff79659e0828b90b636b03dac89486cdc9))
* **csa-loom:** mirrored database — pick a subset of tables/containers to mirror (Fabric parity) ([#776](https://github.com/fgarofalo56/csa-inabox/issues/776)) ([8c6c1c1](https://github.com/fgarofalo56/csa-inabox/commit/8c6c1c1512020040f1da5d15ec0eccb356b6e382))
* **csa-loom:** mirrored database — real Azure-native Start + edit/test + Weave downstream ([#762](https://github.com/fgarofalo56/csa-inabox/issues/762)) ([1147b82](https://github.com/fgarofalo56/csa-inabox/commit/1147b82c67beaf3ae02580ecd4365b036499c306))
* **csa-loom:** mirrored-database create — Verify connection step (guided, real reachability) ([#633](https://github.com/fgarofalo56/csa-inabox/issues/633)) ([2bbafe0](https://github.com/fgarofalo56/csa-inabox/commit/2bbafe0e117e6ab1cd62bd8a6285e92afc039685))
* **csa-loom:** mirrored-database create wizard (web-3.0 + Key Vault Connections) ([#753](https://github.com/fgarofalo56/csa-inabox/issues/753)) ([18b0447](https://github.com/fgarofalo56/csa-inabox/commit/18b0447c5d64f44e6ef0bc3932eb2eb755b8033f))
* **csa-loom:** Monitor — prebuilt KQL query library + result charts ([#692](https://github.com/fgarofalo56/csa-inabox/issues/692)) ([4e56daf](https://github.com/fgarofalo56/csa-inabox/commit/4e56daf80ed13340baf66b3aa7554ebeb24dfc2c))
* **csa-loom:** Monitor → Cost tab (M3 costing + predictive) — real Cost Management spend + forecast ([#682](https://github.com/fgarofalo56/csa-inabox/issues/682)) ([c19bb26](https://github.com/fgarofalo56/csa-inabox/commit/c19bb266bd19bf651c019e03c47e28a8f1ddc1c6))
* **csa-loom:** Monitor → Security — full Defender remediations per recommendation ([#769](https://github.com/fgarofalo56/csa-inabox/issues/769)) ([f7134f2](https://github.com/fgarofalo56/csa-inabox/commit/f7134f2bb02ea396ccf0eb7bb3b3aa8f22fc46f6))
* **csa-loom:** Monitor Cost — multi-subscription, more reports, budgets, trend ([#694](https://github.com/fgarofalo56/csa-inabox/issues/694)) ([44df656](https://github.com/fgarofalo56/csa-inabox/commit/44df6568812b9c768be9c0ab9da8e0a4180fb634))
* **csa-loom:** Monitor Security (Defender) tab + Cost 429 retry (M5 + action-required) ([#685](https://github.com/fgarofalo56/csa-inabox/issues/685)) ([6775a9c](https://github.com/fgarofalo56/csa-inabox/commit/6775a9c7b5459f49ae7d0f1b3a5a47eb097de69a))
* **csa-loom:** Network & Private DNS surface — PE inventory + hosts-file + enterprise DNS ([#606](https://github.com/fgarofalo56/csa-inabox/issues/606)) ([1744a6b](https://github.com/fgarofalo56/csa-inabox/commit/1744a6be1fa6217f5dfad20d0e090d5cc58c3cce))
* **csa-loom:** no hard MS Fabric dependency — Azure-native default for every item (+ warehouse pre-warm) ([#634](https://github.com/fgarofalo56/csa-inabox/issues/634)) ([3f0e8c6](https://github.com/fgarofalo56/csa-inabox/commit/3f0e8c6c6c53c641b558a79f279cbeeb0fb71e39))
* **csa-loom:** notebook — start terminated compute inline + native-speed cell polling ([#719](https://github.com/fgarofalo56/csa-inabox/issues/719)) ([94df824](https://github.com/fgarofalo56/csa-inabox/commit/94df824d142387c77e34fd20cce1ea37d0981391))
* **csa-loom:** notebook Copilot edges — inline NL→code, explain, fix (F21) ([#791](https://github.com/fgarofalo56/csa-inabox/issues/791)) ([1fc7f2c](https://github.com/fgarofalo56/csa-inabox/commit/1fc7f2c0cb5631628781c9d4eb831d1a864038ef))
* **csa-loom:** notebook per-cell interactive execution via Livy (F16) ([#807](https://github.com/fgarofalo56/csa-inabox/issues/807)) ([379072c](https://github.com/fgarofalo56/csa-inabox/commit/379072cd48b47119ffe796cc64bd8f9b966577b5))
* **csa-loom:** pair synapse-serverless-sql-pool 1:1 with every lakehouse ([#788](https://github.com/fgarofalo56/csa-inabox/issues/788)) ([af65c02](https://github.com/fgarofalo56/csa-inabox/commit/af65c02a2b3693adbe91e0d9518f4122f6962480))
* **csa-loom:** per-object lineage view on the catalog asset page ([#16](https://github.com/fgarofalo56/csa-inabox/issues/16)) ([#643](https://github.com/fgarofalo56/csa-inabox/issues/643)) ([c386aa6](https://github.com/fgarofalo56/csa-inabox/commit/c386aa60504c20d5e08bf3bbc60c961526dee836))
* **csa-loom:** pipeline canvas keyboard map + inline nested previews + drill-back (F1, F22) ([#800](https://github.com/fgarofalo56/csa-inabox/issues/800)) ([7ee871f](https://github.com/fgarofalo56/csa-inabox/commit/7ee871f63d8a4e83be42b64ecca9e533e7112dec))
* **csa-loom:** pipeline canvas parity — fixed canvas + bottom config dock, dynamic-content builder, typed per-activity forms ([#605](https://github.com/fgarofalo56/csa-inabox/issues/605)) ([2e48f16](https://github.com/fgarofalo56/csa-inabox/commit/2e48f16a91672137913c08fa4c6ff501ffc54009))
* **csa-loom:** Power BI embed is opt-in — semantic-model + report editors render Loom-native by default ([#640](https://github.com/fgarofalo56/csa-inabox/issues/640)) ([430d07a](https://github.com/fgarofalo56/csa-inabox/commit/430d07a8992775b373244e4369c3ccd257185e49))
* **csa-loom:** Purview auto-onboard now tags the asset with its classifications ([#757](https://github.com/fgarofalo56/csa-inabox/issues/757)) ([043c507](https://github.com/fgarofalo56/csa-inabox/commit/043c5078b686c6cb45f5c720339b2c5f27898b4e))
* **csa-loom:** real ADLS seed for data-pipeline "Practice with sample data" card (F2) ([#810](https://github.com/fgarofalo56/csa-inabox/issues/810)) ([1b357ca](https://github.com/fgarofalo56/csa-inabox/commit/1b357ca55c0c875d5823fb401063f4f09cd6e0d3))
* **csa-loom:** real AI Functions HTTP surface (replace data-science vaporware) ([#777](https://github.com/fgarofalo56/csa-inabox/issues/777)) ([ed2bdd0](https://github.com/fgarofalo56/csa-inabox/commit/ed2bdd03e01e341173131d9ea6fb909566b3c042))
* **csa-loom:** Real-Time Hub — Azure-native by default (sources work without Fabric) ([#767](https://github.com/fgarofalo56/csa-inabox/issues/767)) ([1d3b5d7](https://github.com/fgarofalo56/csa-inabox/commit/1d3b5d7fd6c1cfb8dd5f9e8c240912c0b77fc20f))
* **csa-loom:** Real-Time Hub endpoints — Azure-native (Loom eventstream topology) ([#771](https://github.com/fgarofalo56/csa-inabox/issues/771)) ([6b386af](https://github.com/fgarofalo56/csa-inabox/commit/6b386afb0701d798635fd55a4768c8465e9b332f))
* **csa-loom:** reference-lakehouse federation in the lakehouse explorer (F8) ([#787](https://github.com/fgarofalo56/csa-inabox/issues/787)) ([2521a83](https://github.com/fgarofalo56/csa-inabox/commit/2521a83c3b0d65b2b9587346672e06694d799012))
* **csa-loom:** scaled self-hosted IR (VMSS, scale-to-0) in every DLZ ([#658](https://github.com/fgarofalo56/csa-inabox/issues/658)) ([d920583](https://github.com/fgarofalo56/csa-inabox/commit/d920583738bc2e08eeca472b0cd6cf105ce5067a))
* **csa-loom:** schedule-time pipeline parameter overrides from Key Vault / App Config (F4) ([#811](https://github.com/fgarofalo56/csa-inabox/issues/811)) ([ad0b6c6](https://github.com/fgarofalo56/csa-inabox/commit/ad0b6c6c4739f47e11bb43af8ab82e9b819816b4))
* **csa-loom:** sensitivity-label page — clickable label cards + filter (modern, governance [#16](https://github.com/fgarofalo56/csa-inabox/issues/16)) ([#627](https://github.com/fgarofalo56/csa-inabox/issues/627)) ([662e497](https://github.com/fgarofalo56/csa-inabox/commit/662e497c6daa40e75e0276997bf55a2bb6574d56))
* **csa-loom:** Setup Wizard — Vanity URL (optional) field → deploy dispatch ([#670](https://github.com/fgarofalo56/csa-inabox/issues/670)) ([69c9462](https://github.com/fgarofalo56/csa-inabox/commit/69c9462ee8db4524edc0a3d94ae219082a750070))
* **csa-loom:** Setup Wizard actually deploys (browser-driven) + real single/multi-sub ([#649](https://github.com/fgarofalo56/csa-inabox/issues/649)) ([920ecfa](https://github.com/fgarofalo56/csa-inabox/commit/920ecfab92c06470e157f3be5156d6af8f1f67da))
* **csa-loom:** Setup wizard streams live GitHub Actions deploy status (task-002) ([#708](https://github.com/fgarofalo56/csa-inabox/issues/708)) ([32f4c4d](https://github.com/fgarofalo56/csa-inabox/commit/32f4c4dfa00868d8a29dcfe92a93531244af5b44))
* **csa-loom:** SHIR idle auto-stop ([#4](https://github.com/fgarofalo56/csa-inabox/issues/4)b) + Power BI VNet data gateway subnet ([#5](https://github.com/fgarofalo56/csa-inabox/issues/5)) ([#660](https://github.com/fgarofalo56/csa-inabox/issues/660)) ([90169c5](https://github.com/fgarofalo56/csa-inabox/commit/90169c5af4365d9222fc42614d96b43756736d48))
* **csa-loom:** SHIR metrics tile + scale controls in the Manage hub ([#4](https://github.com/fgarofalo56/csa-inabox/issues/4)c) ([#659](https://github.com/fgarofalo56/csa-inabox/issues/659)) ([3532ff8](https://github.com/fgarofalo56/csa-inabox/commit/3532ff8b90ca35c38294cb382353a03727df7bfa))
* **csa-loom:** smart table filters — dropdowns + date ranges, free-text only for Name ([#645](https://github.com/fgarofalo56/csa-inabox/issues/645)) ([02e5849](https://github.com/fgarofalo56/csa-inabox/commit/02e5849165d84d6ef82787592ac919ee4fb17574))
* **csa-loom:** Spark Notebook authoring parity (F15) ([#797](https://github.com/fgarofalo56/csa-inabox/issues/797)) ([1e1e199](https://github.com/fgarofalo56/csa-inabox/commit/1e1e1991324b2a153c98cdd0c92ccca1cfae21be))
* **csa-loom:** spark-environment lifecycle item (F18) — Azure-native, no Fabric ([#794](https://github.com/fgarofalo56/csa-inabox/issues/794)) ([7a9be8a](https://github.com/fgarofalo56/csa-inabox/commit/7a9be8a655c255f669a6d15395c06c7b46021926))
* **csa-loom:** surface built-in MCP server in Connect-MCP panel (task-007) ([#713](https://github.com/fgarofalo56/csa-inabox/issues/713)) ([db015e9](https://github.com/fgarofalo56/csa-inabox/commit/db015e953d19a8e6cf3e6247eee739203f168244))
* **csa-loom:** surface per-resource ARM operation drill-in on Deployment page (task-005) ([#711](https://github.com/fgarofalo56/csa-inabox/issues/711)) ([723ae52](https://github.com/fgarofalo56/csa-inabox/commit/723ae522bbf1ba24ed654bdcece275e5aab6c8bd))
* **csa-loom:** task-010 — Purview page web-3.0 cleanup (icon cards + tokens) ([#725](https://github.com/fgarofalo56/csa-inabox/issues/725)) ([7a6558e](https://github.com/fgarofalo56/csa-inabox/commit/7a6558ee95b0d82a2faf958a6354a13f311d8650))
* **csa-loom:** task-011 — enforce warehouse + KQL access policies (Azure-native) ([#726](https://github.com/fgarofalo56/csa-inabox/issues/726)) ([c54f75f](https://github.com/fgarofalo56/csa-inabox/commit/c54f75fea2b8b2f8ac44da770a4ee2bd8e159692))
* **csa-loom:** task-012 — catalog asset detail drawer + request-access + lineage ([#730](https://github.com/fgarofalo56/csa-inabox/issues/730)) ([7496084](https://github.com/fgarofalo56/csa-inabox/commit/74960841d9c3db1bc7ec0f298811c2cf47a8d8e2))
* **csa-loom:** task-013 — Managed Instance editor attempts real schema reads over PE ([#731](https://github.com/fgarofalo56/csa-inabox/issues/731)) ([4ffb09a](https://github.com/fgarofalo56/csa-inabox/commit/4ffb09a235328f2b82c8df424ba7aebd551002c4))
* **csa-loom:** task-014 — Azure SQL mirroring goes Azure-native (no Fabric gate) ([#749](https://github.com/fgarofalo56/csa-inabox/issues/749)) ([fe59c87](https://github.com/fgarofalo56/csa-inabox/commit/fe59c87b6bd3c48d65ad75984694494038109aa9))
* **csa-loom:** task-015 slice — Power BI Deployment Pipelines navigator ([#750](https://github.com/fgarofalo56/csa-inabox/issues/750)) ([2dd6489](https://github.com/fgarofalo56/csa-inabox/commit/2dd6489ce35444d6e720faa2a227e70e658a2b49))
* **csa-loom:** task-016 — live PostgreSQL query (pg + Entra token) ([#740](https://github.com/fgarofalo56/csa-inabox/issues/740)) ([2b4ff00](https://github.com/fgarofalo56/csa-inabox/commit/2b4ff00ccc5ab5f68dd5f22769c9edbdd25a9c8b))
* **csa-loom:** task-018 slice — Catalog domains (collections + glossary) LoomDataTable ([#745](https://github.com/fgarofalo56/csa-inabox/issues/745)) ([762126b](https://github.com/fgarofalo56/csa-inabox/commit/762126b3b0fa3eb97a466f61500e28b993a40948))
* **csa-loom:** task-018 slice — Data Catalog uses the sortable LoomDataTable ([#732](https://github.com/fgarofalo56/csa-inabox/issues/732)) ([18fa124](https://github.com/fgarofalo56/csa-inabox/commit/18fa124a4969c4180966eb6f45e5443ae2af3e6e))
* **csa-loom:** task-018 slice — Data Quality rules table → LoomDataTable ([#744](https://github.com/fgarofalo56/csa-inabox/issues/744)) ([89c9af1](https://github.com/fgarofalo56/csa-inabox/commit/89c9af126a093398fc42da6d7c4429be4314beb6))
* **csa-loom:** task-018 slice — Governance classifications + sensitivity LoomDataTable ([#741](https://github.com/fgarofalo56/csa-inabox/issues/741)) ([86aa97e](https://github.com/fgarofalo56/csa-inabox/commit/86aa97e1b4236975a2bee0f9200cd30ee7bc6ab5))
* **csa-loom:** task-018 slice — Governance policies table → LoomDataTable ([#743](https://github.com/fgarofalo56/csa-inabox/issues/743)) ([ddbdcd7](https://github.com/fgarofalo56/csa-inabox/commit/ddbdcd7f70b896688d0ef5ff45d66b9b7baa1d85))
* **csa-loom:** task-018 slice — Governance scans table → LoomDataTable ([#742](https://github.com/fgarofalo56/csa-inabox/issues/742)) ([a186bdf](https://github.com/fgarofalo56/csa-inabox/commit/a186bdff4849201eaa757a589dc40a89cf11aff2))
* **csa-loom:** Thread edge — 'Analyze in a Notebook' (data item -&gt; notebook) ([#721](https://github.com/fgarofalo56/csa-inabox/issues/721)) ([88dc53d](https://github.com/fgarofalo56/csa-inabox/commit/88dc53defe65912dd7eabdd419fc20d11c987a9e))
* **csa-loom:** Thread PR3 — publish a warehouse table as a REST+GraphQL API ([#723](https://github.com/fgarofalo56/csa-inabox/issues/723)) ([69ecd3c](https://github.com/fgarofalo56/csa-inabox/commit/69ecd3c219cbd0ae4219c6902dff31d934eb6d85))
* **csa-loom:** Thread PR4 spine — edge graph + Lineage view ([#724](https://github.com/fgarofalo56/csa-inabox/issues/724)) ([c7d3cf3](https://github.com/fgarofalo56/csa-inabox/commit/c7d3cf3668d99489229bfa29df3855cca3bf19b3))
* **csa-loom:** Thread PR5 — gold table → Power BI model (push dataset) edge ([#722](https://github.com/fgarofalo56/csa-inabox/issues/722)) ([3996b38](https://github.com/fgarofalo56/csa-inabox/commit/3996b385c3d3290e5c305dd2931d851d1d01b8cb))
* **csa-loom:** UI-configurable Copilot + help/data agents (admin + workspace) ([#598](https://github.com/fgarofalo56/csa-inabox/issues/598)) ([4b29968](https://github.com/fgarofalo56/csa-inabox/commit/4b29968a8b31300145cbbcce1f54c1c8686622e3))
* **csa-loom:** Unified Catalog OneLake source → Azure-native Loom workspaces (Fabric opt-in) ([#756](https://github.com/fgarofalo56/csa-inabox/issues/756)) ([a73657d](https://github.com/fgarofalo56/csa-inabox/commit/a73657da0a36fa1628ffeb7a796b2d107417b94f))
* **csa-loom:** visual tutorial-capture + functional-UAT pipeline (Learn drawer closed) ([#618](https://github.com/fgarofalo56/csa-inabox/issues/618)) ([bd98280](https://github.com/fgarofalo56/csa-inabox/commit/bd9828085a7fa7ac04409430b0da7ac883c2081a))
* **csa-loom:** Web-3.0 spacing pass on catalog permissions + cross-source UI ([#600](https://github.com/fgarofalo56/csa-inabox/issues/600)) ([b849646](https://github.com/fgarofalo56/csa-inabox/commit/b84964618b80a951e8b2b2d911279bc9f1721aa6))
* **csa-loom:** workspace items multi-select + bulk actions (move / delete / open) ([#629](https://github.com/fgarofalo56/csa-inabox/issues/629)) ([07fb04e](https://github.com/fgarofalo56/csa-inabox/commit/07fb04ec1bb1b05d0b235f7db4ada7d1c9c3479f))


### Bug Fixes

* **ci:** build images via az acr build (server-side) to unblock deploys on private ACR ([#609](https://github.com/fgarofalo56/csa-inabox/issues/609)) ([fce2134](https://github.com/fgarofalo56/csa-inabox/commit/fce2134e678c8cca5129b9bbd3189d0dfc68f170))
* **ci:** bump Next build heap (NODE_OPTIONS max-old-space-size=4096) — fixes OOM ([#625](https://github.com/fgarofalo56/csa-inabox/issues/625)) ([93dd6e4](https://github.com/fgarofalo56/csa-inabox/commit/93dd6e4b4771b475dfbdbbec608cfc156b1056db))
* **csa-loom:** 3 stubbed standalone pages → real backends (audit D-grade) ([#678](https://github.com/fgarofalo56/csa-inabox/issues/678)) ([7ce8418](https://github.com/fgarofalo56/csa-inabox/commit/7ce8418ba40fad70f007ff5fdf40d06e2e7bd33d))
* **csa-loom:** 9 Phase-4 editors silently lost edits — add missing /api/items/&lt;type&gt;/[id]/route.ts (audit grade-F cohort) ([#677](https://github.com/fgarofalo56/csa-inabox/issues/677)) ([b539810](https://github.com/fgarofalo56/csa-inabox/commit/b53981071c38e736f5e971979d7cce8e9514e135))
* **csa-loom:** Activator defaults to Azure Monitor (no-fabric) — live rule editor no longer calls Fabric ([#680](https://github.com/fgarofalo56/csa-inabox/issues/680)) ([559dce0](https://github.com/fgarofalo56/csa-inabox/commit/559dce0418b7339fe2e3e7df70a189e7eb140eb2))
* **csa-loom:** ADF pipeline 'no ADF backing' dead-end — add Publish-to-ADF + auto-publish on Save/Run ([#674](https://github.com/fgarofalo56/csa-inabox/issues/674)) ([913b281](https://github.com/fgarofalo56/csa-inabox/commit/913b281e1416eee31042d9ecee537c4eaa0722a8))
* **csa-loom:** API Management admin page spins forever — add real gate route + resolve on any failure ([#664](https://github.com/fgarofalo56/csa-inabox/issues/664)) ([7e01bd6](https://github.com/fgarofalo56/csa-inabox/commit/7e01bd639f43f49e9216392928974f5bb169fd98))
* **csa-loom:** APIM Policies tab crash — add missing /api/items/apim-policy route ([#688](https://github.com/fgarofalo56/csa-inabox/issues/688)) ([9556aa4](https://github.com/fgarofalo56/csa-inabox/commit/9556aa40dc13bcc3c510ba8463239f4ed55a8cac))
* **csa-loom:** app install — honest message on gateway timeout (no "Unexpected token '&lt;'") ([#746](https://github.com/fgarofalo56/csa-inabox/issues/746)) ([deabb52](https://github.com/fgarofalo56/csa-inabox/commit/deabb5253d4c4d8a4d11081c4bc1267987a9e03e))
* **csa-loom:** app-wide horizontal-overflow fix + collapsible icon admin nav ([#607](https://github.com/fgarofalo56/csa-inabox/issues/607)) ([53c8fe9](https://github.com/fgarofalo56/csa-inabox/commit/53c8fe9e89778cc2c603db341336a1d5c686802d))
* **csa-loom:** automate Purview UAMI data-plane grant in post-deploy bootstrap + fix domains hint ([#624](https://github.com/fgarofalo56/csa-inabox/issues/624)) ([6817eb5](https://github.com/fgarofalo56/csa-inabox/commit/6817eb572a83b5b4b4469e13204a66ae212892cd))
* **csa-loom:** bake Console RBAC + Synapse-Spark storage into deploy; stop AZURE_CLIENT_SECRET injection ([#774](https://github.com/fgarofalo56/csa-inabox/issues/774)) ([1e8fa0c](https://github.com/fgarofalo56/csa-inabox/commit/1e8fa0c57ec8b0b61f7838a9e4694addc661c641))
* **csa-loom:** catalog Metastores (Databricks 403 gate + workspace dropdown) + Purview Domains (classic Data Map surface) ([#601](https://github.com/fgarofalo56/csa-inabox/issues/601)) ([b6cf761](https://github.com/fgarofalo56/csa-inabox/commit/b6cf7618c6ea667c93b138b82452b944e7514689))
* **csa-loom:** catalog tree works by default — UC per-workspace catalogs (no account-admin) + Purview domains via classic collections ([#675](https://github.com/fgarofalo56/csa-inabox/issues/675)) ([97d4bbf](https://github.com/fgarofalo56/csa-inabox/commit/97d4bbfcc0562b1e846fdd76053b3236a17ea454))
* **csa-loom:** commit missing lineage-canvas.tsx (build-breaking regression from [#643](https://github.com/fgarofalo56/csa-inabox/issues/643)) ([#653](https://github.com/fgarofalo56/csa-inabox/issues/653)) ([3c13701](https://github.com/fgarofalo56/csa-inabox/commit/3c13701827ac7a1782ee45d03695181056b4657e))
* **csa-loom:** Copilot + data-agent work by default (AOAI temperature + asst_ id) ([#635](https://github.com/fgarofalo56/csa-inabox/issues/635)) ([b63d8a4](https://github.com/fgarofalo56/csa-inabox/commit/b63d8a4b8927b03c0c1330ab58d9dc8c4f24aca8))
* **csa-loom:** Copilot build-assist tools — slug validation, item_list, workspace_list ([#747](https://github.com/fgarofalo56/csa-inabox/issues/747)) ([5b9a1f8](https://github.com/fgarofalo56/csa-inabox/commit/5b9a1f8842cebb8713301ecd448af8a56f185480))
* **csa-loom:** Copilot status reads the admin-saved Foundry config (stop false 'not reachable') ([#617](https://github.com/fgarofalo56/csa-inabox/issues/617)) ([52d7da7](https://github.com/fgarofalo56/csa-inabox/commit/52d7da7d55a8fe92200ba6f4d7b89eced5af8a37))
* **csa-loom:** Cost tab no longer 504s — parallelize CostManagement queries + honest gateway-timeout message ([#760](https://github.com/fgarofalo56/csa-inabox/issues/760)) ([aed7634](https://github.com/fgarofalo56/csa-inabox/commit/aed763441b3e92a15f866dbbaf7d7ffd020e5ec9))
* **csa-loom:** data-agent run resolves Foundry assistant id (asst_) from name ([#612](https://github.com/fgarofalo56/csa-inabox/issues/612)) ([e7c9903](https://github.com/fgarofalo56/csa-inabox/commit/e7c99037e2ef9d9c3358c2fb18d5503532537971))
* **csa-loom:** data-agent runs Azure-native by default + lakehouse shortcut real-account targets ([#693](https://github.com/fgarofalo56/csa-inabox/issues/693)) ([d2c781c](https://github.com/fgarofalo56/csa-inabox/commit/d2c781c2011ba82541de9ff813d3872fa1463458))
* **csa-loom:** databricks-job imports real notebooks so chained jobs run green ([#603](https://github.com/fgarofalo56/csa-inabox/issues/603)) ([7ff46c0](https://github.com/fgarofalo56/csa-inabox/commit/7ff46c095d88d3eb1fa7a3d609da7523f0f51523))
* **csa-loom:** dedicated-pool view/schema, lakehouse user-db views, KQL caching-policy syntax, TOM relationship validation ([#588](https://github.com/fgarofalo56/csa-inabox/issues/588)) ([996f8a0](https://github.com/fgarofalo56/csa-inabox/commit/996f8a045af8bc01306ab58d86974cb4aa911ac6))
* **csa-loom:** deploy-planner — height-bounded body (fixed canvas) + collapsible categories ([#613](https://github.com/fgarofalo56/csa-inabox/issues/613)) ([dfd6d9a](https://github.com/fgarofalo56/csa-inabox/commit/dfd6d9a8942e61bae6a4da1e2256ae6ae3fa36bd))
* **csa-loom:** lakehouse — one-click register planned bundle shortcuts (resolve registry contradiction) ([#631](https://github.com/fgarofalo56/csa-inabox/issues/631)) ([99e1e5b](https://github.com/fgarofalo56/csa-inabox/commit/99e1e5ba37b0574b6eb96fd4204433e22d67235c))
* **csa-loom:** lakehouse [#12](https://github.com/fgarofalo56/csa-inabox/issues/12) — graceful table-list + honest cold-start handling ([#641](https://github.com/fgarofalo56/csa-inabox/issues/641)) ([77dd27d](https://github.com/fgarofalo56/csa-inabox/commit/77dd27dfc7a6c8c417256b7de53b76e1a30607c6))
* **csa-loom:** light/dark readability sweep wave 2 — canvas/diagram accent colors theme-aware ([#681](https://github.com/fgarofalo56/csa-inabox/issues/681)) ([65032a9](https://github.com/fgarofalo56/csa-inabox/commit/65032a9ceb76936207d39f005431ef04830c3075))
* **csa-loom:** lineage view focuses the selected object (not all items) ([#755](https://github.com/fgarofalo56/csa-inabox/issues/755)) ([4024ce6](https://github.com/fgarofalo56/csa-inabox/commit/4024ce61549d1885c9dbb4236cc5af0e53dfc086))
* **csa-loom:** managed-identity credential first — stop EnvironmentCredential breaking Azure calls ([#765](https://github.com/fgarofalo56/csa-inabox/issues/765)) ([a96cf60](https://github.com/fgarofalo56/csa-inabox/commit/a96cf60c0528736a1ce890a5e6d5dd681beb4d1d))
* **csa-loom:** MIP panel crash (t.swatch) + honest AI Search / APIM scale errors ([#686](https://github.com/fgarofalo56/csa-inabox/issues/686)) ([78514b0](https://github.com/fgarofalo56/csa-inabox/commit/78514b0eea33c11a4cfe41e3014c027a61de7fda))
* **csa-loom:** move Network & DNS under admin + hosts-file covers ALL private endpoints + drop side-convo framing ([#611](https://github.com/fgarofalo56/csa-inabox/issues/611)) ([384dcf7](https://github.com/fgarofalo56/csa-inabox/commit/384dcf773a48b66394e57dbca7a54c17c49b6926))
* **csa-loom:** notebook RUN route assembles code from state.content.cells ([#594](https://github.com/fgarofalo56/csa-inabox/issues/594)) ([f1a87e5](https://github.com/fgarofalo56/csa-inabox/commit/f1a87e599b8588edea1d9df0dfb55c649cdb8eb1))
* **csa-loom:** notebook runtime — faster cells + live compute status ([#652](https://github.com/fgarofalo56/csa-inabox/issues/652)) ([e5c219e](https://github.com/fgarofalo56/csa-inabox/commit/e5c219e1caee8d03c9106a31f5d08dfd43308dfc))
* **csa-loom:** OneLake catalog shows each lakehouse's REAL tables, not a mock ([#596](https://github.com/fgarofalo56/csa-inabox/issues/596)) ([28050c8](https://github.com/fgarofalo56/csa-inabox/commit/28050c8b3e040878d6aff5861b9ba0e709a8e1f6))
* **csa-loom:** OneLake item details show real governance signals (kill static Purview gate) ([#752](https://github.com/fgarofalo56/csa-inabox/issues/752)) ([7246a4b](https://github.com/fgarofalo56/csa-inabox/commit/7246a4be7f045f2fcd96c08cd176d917f464b70a))
* **csa-loom:** Purview domain mirror (classic Data Map) + Scale-by-SKU RBAC + light/dark accent colors ([#672](https://github.com/fgarofalo56/csa-inabox/issues/672)) ([b5f00d0](https://github.com/fgarofalo56/csa-inabox/commit/b5f00d08765e6370e708178e113dbd2eb0a5b0d7))
* **csa-loom:** rayfin-app spec never persisted — add missing /api/items/rayfin-app/[id] route ([#679](https://github.com/fgarofalo56/csa-inabox/issues/679)) ([9ef17e3](https://github.com/fgarofalo56/csa-inabox/commit/9ef17e31ec609d5015e6cd547ca0b93cbbf6186a))
* **csa-loom:** reuse Synapse Livy Spark session across notebook cells (stop per-cell cold start) ([#614](https://github.com/fgarofalo56/csa-inabox/issues/614)) ([95dbc30](https://github.com/fgarofalo56/csa-inabox/commit/95dbc302c8779e4c65015b37f8d78fef4eb33203))
* **csa-loom:** RTI batch pipeline used invalid ADF activity type DatabricksSparkSql → DatabricksNotebook ([#687](https://github.com/fgarofalo56/csa-inabox/issues/687)) ([128c1c8](https://github.com/fgarofalo56/csa-inabox/commit/128c1c8eca8a19fc76b781b4aa9fd16d4b07c102))
* **csa-loom:** RTI dashboard 'QualityMetrics table not found' — bind dashboard to its sibling KQL database ([#676](https://github.com/fgarofalo56/csa-inabox/issues/676)) ([1e3764d](https://github.com/fgarofalo56/csa-inabox/commit/1e3764dfe40b7c15fdaf0adcfacb364dc39e6b29))
* **csa-loom:** seed deployment-configured bootstrap admin (fixes /admin 403) ([#610](https://github.com/fgarofalo56/csa-inabox/issues/610)) ([4b883f9](https://github.com/fgarofalo56/csa-inabox/commit/4b883f9de9214bb350d10dbc702c7e8f06008403))
* **csa-loom:** self-audit fix scripts targeted wrong RG (DLZ vs admin) ([#671](https://github.com/fgarofalo56/csa-inabox/issues/671)) ([5c53ee8](https://github.com/fgarofalo56/csa-inabox/commit/5c53ee85e440d210ba83b50914057631baf71ec4))
* **csa-loom:** Spark/Delta dbt models never hit the Synapse dedicated pool (fixes Casino 'Incorrect syntax near {') ([#651](https://github.com/fgarofalo56/csa-inabox/issues/651)) ([58b7435](https://github.com/fgarofalo56/csa-inabox/commit/58b74355f4d5d9c7bdb15c9506aeefffbe282cfa))
* **csa-loom:** Synapse pipeline upsert waits for LRO commit + debug pre-checks existence ([#604](https://github.com/fgarofalo56/csa-inabox/issues/604)) ([fbd504d](https://github.com/fgarofalo56/csa-inabox/commit/fbd504d301edc48152c214c15d247b2c8bd8e935))
* **csa-loom:** Synapse Spark notebook Hive metastore abfss failure (Storage Blob Data + managed PE) ([#764](https://github.com/fgarofalo56/csa-inabox/issues/764)) ([c84a659](https://github.com/fgarofalo56/csa-inabox/commit/c84a659d5ad77fc141960760c395e03532423f8d))
* **csa-loom:** use-case apps iter2 — AI Search schema, warehouse seeding, parallel provisioning, KQL content ([#583](https://github.com/fgarofalo56/csa-inabox/issues/583)) ([0d0744b](https://github.com/fgarofalo56/csa-inabox/commit/0d0744b4255e2e26815f8881f1001937f53744dc))
* **csa-loom:** use-case apps live fix round 1 ([#584](https://github.com/fgarofalo56/csa-inabox/issues/584)) ([c6ef586](https://github.com/fgarofalo56/csa-inabox/commit/c6ef586cbea2696e82c0e0d4541282d9e699622a))
* **csa-loom:** use-case apps live fix round 2 ([#585](https://github.com/fgarofalo56/csa-inabox/issues/585)) ([26107b0](https://github.com/fgarofalo56/csa-inabox/commit/26107b0c07d405256de09011a513b0e87e144840))
* **csa-loom:** warehouse ADD-CONSTRAINT idempotency + CREATE OR ALTER VIEW + databricks-job run honest-gate ([#591](https://github.com/fgarofalo56/csa-inabox/issues/591)) ([07e62c8](https://github.com/fgarofalo56/csa-inabox/commit/07e62c8dbe27bb7a51fac6979949d1294ba1cb63))
* **csa-loom:** warehouse idempotency (all CREATE TABLE forms) + dbt-Jinja skip + pipeline-designer refs ([#590](https://github.com/fgarofalo56/csa-inabox/issues/590)) ([636c172](https://github.com/fgarofalo56/csa-inabox/commit/636c1727db5f8ffa5c3d83075e383a5bef31c233))
* **csa-loom:** Weave "Build a Power BI model" + "Publish as an API" — add custom SQL-query source ([#761](https://github.com/fgarofalo56/csa-inabox/issues/761)) ([9e1bd76](https://github.com/fgarofalo56/csa-inabox/commit/9e1bd768d5ed6daf9410fd7785fed7948212a6a6))


### Documentation

* **csa-loom:** Build 2026 announcements → CSA Loom adoption roadmap ([#616](https://github.com/fgarofalo56/csa-inabox/issues/616)) ([f86dd2b](https://github.com/fgarofalo56/csa-inabox/commit/f86dd2b1341dc1f7aa447625c116ac9ed88d30bc))
* **csa-loom:** complete the Fabric-parity PRP set — remaining 6 experiences (12/12) ([#781](https://github.com/fgarofalo56/csa-inabox/issues/781)) ([2e0d5ba](https://github.com/fgarofalo56/csa-inabox/commit/2e0d5ba7e9f67579b3259de01da5dffc05c63e9d))
* **csa-loom:** Data Factory parity close-out + ADF private-DNS bicep fix ([#812](https://github.com/fgarofalo56/csa-inabox/issues/812)) ([ddfcb6e](https://github.com/fgarofalo56/csa-inabox/commit/ddfcb6ebf285ec4f54716e7ea6239cda6a5fed73))
* **csa-loom:** docs↔shipped audit (2026-06-06) — correct vaporware claims ([#766](https://github.com/fgarofalo56/csa-inabox/issues/766)) ([ae126a6](https://github.com/fgarofalo56/csa-inabox/commit/ae126a6f38a427cbc5f18222127a56a03b053b9b))
* **csa-loom:** how to enable Unity Catalog + grant Loom UAMI metastore admin (in-console + docs) ([#690](https://github.com/fgarofalo56/csa-inabox/issues/690)) ([ea730a8](https://github.com/fgarofalo56/csa-inabox/commit/ea730a83abf8f5c7c50fdacd8b6cff4f58e1fcec))
* **csa-loom:** persistent parity workflows + Fabric-parity PRP set (6 experiences) + Unleash kickoff ([#780](https://github.com/fgarofalo56/csa-inabox/issues/780)) ([e26ca0d](https://github.com/fgarofalo56/csa-inabox/commit/e26ca0dd636d08dcec491a11298e5fa2e22c1cc2))
* **csa-loom:** reconcile design docs to shipped reality + document network/private-dns ([#770](https://github.com/fgarofalo56/csa-inabox/issues/770)) ([77a9253](https://github.com/fgarofalo56/csa-inabox/commit/77a92538c60607c88ce92e5edc65a65f9bbf6d16))
* **csa-loom:** rewrite tutorials 02-08 to the real product ([#779](https://github.com/fgarofalo56/csa-inabox/issues/779)) ([73ce5af](https://github.com/fgarofalo56/csa-inabox/commit/73ce5af27e4939a7c608c7d9c1c167bff997652e))
* **csa-loom:** task-022 — Connections doc + 2026-06-06 batch feature-backlog catch-up ([#758](https://github.com/fgarofalo56/csa-inabox/issues/758)) ([7d1a9fa](https://github.com/fgarofalo56/csa-inabox/commit/7d1a9fa4236b18d855c54017382295ebb3f45918))
* **csa-loom:** tutorials 01–08 corrected to the real shipped product ([#772](https://github.com/fgarofalo56/csa-inabox/issues/772)) ([845154f](https://github.com/fgarofalo56/csa-inabox/commit/845154fda5beb648d2b22d6b4b19e040cc7895f6))
* new workloads/realtime-hub.md (was undocumented). ([1d3b5d7](https://github.com/fgarofalo56/csa-inabox/commit/1d3b5d7fd6c1cfb8dd5f9e8c240912c0b77fc20f))
* parity/api-marketplace.md updated with the new capability rows. ([3738ddb](https://github.com/fgarofalo56/csa-inabox/commit/3738ddbe0ef4b963e97f064690458e91ff375d3d))
* site polish — nav hub, /learn dedup, parity matrix, TCO, maturity, freshness stamps ([#579](https://github.com/fgarofalo56/csa-inabox/issues/579)) ([d002289](https://github.com/fgarofalo56/csa-inabox/commit/d0022897d2157976f0a8b1f5afa54926304b03b0))


### Tests

* **csa-loom:** add Monitor cost/defender/inventory/health to live service-health probes ([#775](https://github.com/fgarofalo56/csa-inabox/issues/775)) ([ae54550](https://github.com/fgarofalo56/csa-inabox/commit/ae5455072380d94b5964fb68dda841f5f3ac4546))
* **csa-loom:** front-end UAT for all 21 use-case apps (UI install→provision→render) ([#592](https://github.com/fgarofalo56/csa-inabox/issues/592)) ([84cc53f](https://github.com/fgarofalo56/csa-inabox/commit/84cc53f45d21eba82e6a4f9470d67a8138b50345))


### Continuous Integration

* **csa-loom:** make required 'next build' report on every PR (fix bicep-only deadlock) ([#673](https://github.com/fgarofalo56/csa-inabox/issues/673)) ([8bf38a8](https://github.com/fgarofalo56/csa-inabox/commit/8bf38a83148c96df59b4717bf72a4fc369461a18))
* **csa-loom:** tutorial-capture uses Node 22 (corepack pnpm needs node:sqlite) ([#621](https://github.com/fgarofalo56/csa-inabox/issues/621)) ([6c4429f](https://github.com/fgarofalo56/csa-inabox/commit/6c4429f0280500c563c6ac71b3269f02987854ff))
* **csa-loom:** tutorial-capture workflow — drives live console, uploads screenshots for review ([#619](https://github.com/fgarofalo56/csa-inabox/issues/619)) ([8b6bcac](https://github.com/fgarofalo56/csa-inabox/commit/8b6bcac949e88c3ba5707a3dd9994da5d480f40a))
* **csa-loom:** unblock TS-only PRs + add real Next.js build gate ([#656](https://github.com/fgarofalo56/csa-inabox/issues/656)) ([a5130ee](https://github.com/fgarofalo56/csa-inabox/commit/a5130ee53b471efee7efda847ad8c011cdec7f21))


### Performance Improvements

* **csa-loom:** kill 'page spins forever' on Capacity + Scale-by-SKU + add page-load harness ([#667](https://github.com/fgarofalo56/csa-inabox/issues/667)) ([1082d14](https://github.com/fgarofalo56/csa-inabox/commit/1082d145e1570a82b7d2eaab87276a4e9c61c6bc))


### Miscellaneous

* **csa-loom:** add loom-unleash workflow (wave-by-wave PRP drain) ([#782](https://github.com/fgarofalo56/csa-inabox/issues/782)) ([62be61c](https://github.com/fgarofalo56/csa-inabox/commit/62be61c4c07b5a0345e800168b15bf2ea465d36d))
* **csa-loom:** harness session 1 — task-001 Phase 0 baseline done (34/34 live GREEN) ([#707](https://github.com/fgarofalo56/csa-inabox/issues/707)) ([14473f9](https://github.com/fgarofalo56/csa-inabox/commit/14473f9c05177aa55115a768c0c92b679abf3d3d))
* **csa-loom:** wire overnight autonomous harness (.harness PRP + 22-task ledger) ([#706](https://github.com/fgarofalo56/csa-inabox/issues/706)) ([4d173f7](https://github.com/fgarofalo56/csa-inabox/commit/4d173f79daeb96a92a8dd54caaf4cbb90daf5b10))
* **deps-dev:** Bump eslint-config-next from 15.5.15 to 16.2.7 in /portal/react-webapp ([#739](https://github.com/fgarofalo56/csa-inabox/issues/739)) ([4eb0d45](https://github.com/fgarofalo56/csa-inabox/commit/4eb0d45e9b5b1e662b195d51d861adc3f801b184))
* **deps:** Bump @tanstack/react-query in /portal/react-webapp ([#484](https://github.com/fgarofalo56/csa-inabox/issues/484)) ([8025d7c](https://github.com/fgarofalo56/csa-inabox/commit/8025d7c001bd3658af9f790d0324fc2353df7605))
* **deps:** Bump @tanstack/react-query in /portal/react-webapp ([#738](https://github.com/fgarofalo56/csa-inabox/issues/738)) ([df889f7](https://github.com/fgarofalo56/csa-inabox/commit/df889f7435ef9fa3a44efaead82f36965d15471e))
* **deps:** Bump axios from 1.16.1 to 1.17.0 in /portal/react-webapp ([#735](https://github.com/fgarofalo56/csa-inabox/issues/735)) ([19b60d3](https://github.com/fgarofalo56/csa-inabox/commit/19b60d3306449e75eb8318c040f75649b5ea22d2))
* **deps:** Bump next from 16.2.6 to 16.2.7 in /portal/react-webapp ([#734](https://github.com/fgarofalo56/csa-inabox/issues/734)) ([c246e4f](https://github.com/fgarofalo56/csa-inabox/commit/c246e4f7b82d3d774efca61113537a0bcb58cdc3))
* **deps:** Bump react-dom in /portal/react-webapp ([#733](https://github.com/fgarofalo56/csa-inabox/issues/733)) ([45fe975](https://github.com/fgarofalo56/csa-inabox/commit/45fe97570d40bd9be250c5adbba53dfdd9a36bf5))
* **deps:** Bump react-hook-form in /portal/react-webapp ([#483](https://github.com/fgarofalo56/csa-inabox/issues/483)) ([c2ed5d5](https://github.com/fgarofalo56/csa-inabox/commit/c2ed5d5f30701becfa8bf418fa954edc62024f5a))
* **deps:** Bump react-hook-form in /portal/react-webapp ([#737](https://github.com/fgarofalo56/csa-inabox/issues/737)) ([73214e0](https://github.com/fgarofalo56/csa-inabox/commit/73214e0d1ad722aabe4c1eb0aa91eecfecec3790))
* **harness:** ledger sync — drained all codeable+verifiable backlog ([#759](https://github.com/fgarofalo56/csa-inabox/issues/759)) ([8cf4db9](https://github.com/fgarofalo56/csa-inabox/commit/8cf4db97c228ee51608b7f412e577365d3393ea4))

## [0.23.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.22.0...csa-inabox-v0.23.0) (2026-06-02)


### Features

* **csa-loom:** complete backlog — studio parity, DAB, Foundry project, MIP/DLP, deploy-planner bicep ([#578](https://github.com/fgarofalo56/csa-inabox/issues/578)) ([62f2fbf](https://github.com/fgarofalo56/csa-inabox/commit/62f2fbf6b7a42bca986b62fc8e9e298eb2730afb))


### Bug Fixes

* **ci:** wait for ACR public-access propagation before build matrix ([#576](https://github.com/fgarofalo56/csa-inabox/issues/576)) ([6a75bf7](https://github.com/fgarofalo56/csa-inabox/commit/6a75bf72ee07cd857d54838531b97edc0081bb83))

## [0.22.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.21.0...csa-inabox-v0.22.0) (2026-06-01)


### Features

* **csa-loom:** ADX database policies in the Kusto navigator (read-only, real .show) ([#536](https://github.com/fgarofalo56/csa-inabox/issues/536)) ([63b1f8a](https://github.com/fgarofalo56/csa-inabox/commit/63b1f8a6d08db477c497369557264dc370ed1945))
* **csa-loom:** compact, breadcrumb-led page header (reclaim vertical space) ([#564](https://github.com/fgarofalo56/csa-inabox/issues/564)) ([6283d2e](https://github.com/fgarofalo56/csa-inabox/commit/6283d2e4f5c845e81a2726bbb07550ceb0acf56f))
* **csa-loom:** Cosmos surface to Data Explorer STUDIO parity (not portal chrome) ([#563](https://github.com/fgarofalo56/csa-inabox/issues/563)) ([64893fd](https://github.com/fgarofalo56/csa-inabox/commit/64893fd263a4529ff206960e64ac930a1c56950e))
* **csa-loom:** grant Cosmos data-plane role for the Items Data Explorer ([#546](https://github.com/fgarofalo56/csa-inabox/issues/546)) ([957af3a](https://github.com/fgarofalo56/csa-inabox/commit/957af3a60154471442bbebb65626d793b88b8622))
* **csa-loom:** Learn portal redesign + Loom-docs-first link model ([#572](https://github.com/fgarofalo56/csa-inabox/issues/572)) ([8cec00f](https://github.com/fgarofalo56/csa-inabox/commit/8cec00fa783856cdda0cb15b1955b05af91e172a))
* **csa-loom:** parity batch 2 — Event Hubs Send / Foundry Agents / APIM operations + build-marker fix ([#552](https://github.com/fgarofalo56/csa-inabox/issues/552)) ([3625019](https://github.com/fgarofalo56/csa-inabox/commit/3625019f5a1c1ee7255a8eadb91f99134830973a))
* **csa-loom:** parity batch 3 — Power BI governance + Power Platform env lifecycle ([#556](https://github.com/fgarofalo56/csa-inabox/issues/556)) ([8f3fae3](https://github.com/fgarofalo56/csa-inabox/commit/8f3fae3978e722a9ff856a12ca8b204c769767e3))
* **csa-loom:** parity build batch 1 — Databricks/SQL/Cosmos/AI Search/ADX/APIM (6 features) ([#545](https://github.com/fgarofalo56/csa-inabox/issues/545)) ([b4b3bd0](https://github.com/fgarofalo56/csa-inabox/commit/b4b3bd0958a00ee14df7653fd6278f22123a429d))
* **csa-loom:** Power BI item governance — workspace ACL, endorsement, gateway binding ([#554](https://github.com/fgarofalo56/csa-inabox/issues/554)) ([6e2315d](https://github.com/fgarofalo56/csa-inabox/commit/6e2315dc5a04b54c0f2f9c672d7ad0f527211608))
* **csa-loom:** Purview classic Data Map wiring + wave-3 Web3 surfaces ([#575](https://github.com/fgarofalo56/csa-inabox/issues/575)) ([66d6f5e](https://github.com/fgarofalo56/csa-inabox/commit/66d6f5e75e9a491b230fbf5bdca8bbe5fc89eb6f))
* **csa-loom:** ship Lakehouse Shortcuts — Azure-native, no Fabric, day-one default ([#568](https://github.com/fgarofalo56/csa-inabox/issues/568)) ([13dd1cf](https://github.com/fgarofalo56/csa-inabox/commit/13dd1cf250539bd4aaee748d057f2e8841718916))
* **csa-loom:** UI A+ sweep wave 1 — 15 editors (RTI, Databricks, APIM, SQL, Lakehouse, Notebook) ([#562](https://github.com/fgarofalo56/csa-inabox/issues/562)) ([0a059b1](https://github.com/fgarofalo56/csa-inabox/commit/0a059b11d27bbdd0dc854a54e9402de1696f42d8))
* **csa-loom:** Web 3.0 redesign wave 1 — Browse, OneLake catalog, Unified catalog ([#566](https://github.com/fgarofalo56/csa-inabox/issues/566)) ([5716ac5](https://github.com/fgarofalo56/csa-inabox/commit/5716ac5b125c896def08db76563d085617e8efd4))
* **csa-loom:** Web 3.0 redesign wave 2 — Governance, Workload Hub, API Marketplace, Copilot ([#567](https://github.com/fgarofalo56/csa-inabox/issues/567)) ([ca324d0](https://github.com/fgarofalo56/csa-inabox/commit/ca324d0e840fcf66a78220da11c655df9179efb2))
* **csa-loom:** Web 3.0 UI foundation primitives (shared data-table/tiles/sections) ([#565](https://github.com/fgarofalo56/csa-inabox/issues/565)) ([60a3bee](https://github.com/fgarofalo56/csa-inabox/commit/60a3beeb6adc4ebd31d4b56bb73b9d848ce5f1fa))


### Bug Fixes

* **csa-loom:** auto-wire Cosmos vector endpoint + cross-sub Purview discovery ([#561](https://github.com/fgarofalo56/csa-inabox/issues/561)) ([d771036](https://github.com/fgarofalo56/csa-inabox/commit/d771036ec1846910f43dc67b88b006c261b2539a))
* **csa-loom:** force a fresh container revision on every roll (--revision-suffix) ([#558](https://github.com/fgarofalo56/csa-inabox/issues/558)) ([61e8aad](https://github.com/fgarofalo56/csa-inabox/commit/61e8aad1e6c07a55c9812234cc7863fe7c1733d9))
* **csa-loom:** Lakehouse shortcuts reach the TARGET storage account (not Loom's) ([#571](https://github.com/fgarofalo56/csa-inabox/issues/571)) ([59c9986](https://github.com/fgarofalo56/csa-inabox/commit/59c9986e6ae1917f5983906d228f7481792be574))
* **csa-loom:** nav icons (OneLake/Unified/Copilot) + FOUC on navigation ([#570](https://github.com/fgarofalo56/csa-inabox/issues/570)) ([dd3c1e7](https://github.com/fgarofalo56/csa-inabox/commit/dd3c1e760e784731f52a10cfa9d619ca9af86107))
* **csa-loom:** shortcut storage authorization = RBAC + VNet service-endpoint rule ([#573](https://github.com/fgarofalo56/csa-inabox/issues/573)) ([0eec197](https://github.com/fgarofalo56/csa-inabox/commit/0eec197841847927678da2ebf8fd9a4944b46e15))
* **csa-loom:** shortcuts work for PE-locked storage too — managed PE + CAE subnet SE in bicep ([#574](https://github.com/fgarofalo56/csa-inabox/issues/574)) ([a8b3424](https://github.com/fgarofalo56/csa-inabox/commit/a8b342425d6965b4d47154e03d1507091d4b8a06))
* **csa-loom:** stamp LOOM_BUILD_SHA in full-app-deploy so build-marker matches ([#549](https://github.com/fgarofalo56/csa-inabox/issues/549)) ([bc155e0](https://github.com/fgarofalo56/csa-inabox/commit/bc155e0bf85e540e67ddfd313a1ce8a4d0e94016))
* **csa-loom:** stop Front Door WAF from blocking BFF query bodies (every query editor was 403) ([#560](https://github.com/fgarofalo56/csa-inabox/issues/560)) ([954cc58](https://github.com/fgarofalo56/csa-inabox/commit/954cc582cf978ef06d10a2aebfc027f21a257209))


### Documentation

* **csa-loom:** correct stale ai-search parity doc — field designer + search explorer are BUILT ([#557](https://github.com/fgarofalo56/csa-inabox/issues/557)) ([895e5b4](https://github.com/fgarofalo56/csa-inabox/commit/895e5b4ce2b514e70ecc7236db606e8db21b71d3))
* **csa-loom:** honest 1:1 Azure parity audit — scorecard + 12 per-service gap docs ([#539](https://github.com/fgarofalo56/csa-inabox/issues/539)) ([f6d63ee](https://github.com/fgarofalo56/csa-inabox/commit/f6d63ee69426f102808842fe36f71cc68ea99f8c))
* **csa-loom:** rev.2 parity re-audit — correct 12 service docs + scorecard against current code ([#559](https://github.com/fgarofalo56/csa-inabox/issues/559)) ([4ff85bf](https://github.com/fgarofalo56/csa-inabox/commit/4ff85bfdb8cc3093edd999f2d533badeb1f9e0a2))

## [0.21.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.20.0...csa-inabox-v0.21.0) (2026-05-31)


### Features

* **csa-loom:** bring-your-own-or-new service parameterization + fix push-button param file ([#533](https://github.com/fgarofalo56/csa-inabox/issues/533)) ([fca53b3](https://github.com/fgarofalo56/csa-inabox/commit/fca53b336ca0ba984a4e3b6c8fc6e06d93ab3d61))
* **csa-loom:** data-agent run-steps inspector (closes the last parity ❌) ([#535](https://github.com/fgarofalo56/csa-inabox/issues/535)) ([ee15a76](https://github.com/fgarofalo56/csa-inabox/commit/ee15a76bb22f6d45c8d9d20fba95fe183ca473dd))


### Bug Fixes

* **csa-loom:** honest empty-state for tier/version-gated navigator sub-tabs ([#531](https://github.com/fgarofalo56/csa-inabox/issues/531)) ([33d9e3d](https://github.com/fgarofalo56/csa-inabox/commit/33d9e3dca78c55be3947f2215d630988f35fba1c))


### Miscellaneous

* gitignore all tsconfig.tsbuildinfo + untrack the tracked ones ([#530](https://github.com/fgarofalo56/csa-inabox/issues/530)) ([1a0a205](https://github.com/fgarofalo56/csa-inabox/commit/1a0a205a0d8bf805b24b11b44d2423146ec56a5a))

## [0.20.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.19.0...csa-inabox-v0.20.0) (2026-05-31)


### Features

* **csa-loom-monitor:** real Azure-Monitor observability surface ([#496](https://github.com/fgarofalo56/csa-inabox/issues/496)) ([902a52e](https://github.com/fgarofalo56/csa-inabox/commit/902a52efadcb7c946eb50463638b3ac4b18ff6e8))
* **csa-loom-rti:** real KQL Dashboard builder (Fabric Real-Time Dashboard parity) ([#490](https://github.com/fgarofalo56/csa-inabox/issues/490)) ([6d7c8d7](https://github.com/fgarofalo56/csa-inabox/commit/6d7c8d7070efd42bccb9cde1289250cf0eb1630b))
* **csa-loom:** ADF Studio Factory Resources navigator for the pipeline editor ([#516](https://github.com/fgarofalo56/csa-inabox/issues/516)) ([1afa966](https://github.com/fgarofalo56/csa-inabox/commit/1afa966cf0d6caefcd14ca8e7e60994a309d1825))
* **csa-loom:** admin portal audit + domains owners/Purview gate + backend contract tests ([#500](https://github.com/fgarofalo56/csa-inabox/issues/500)) ([1b33a7c](https://github.com/fgarofalo56/csa-inabox/commit/1b33a7c91fd7d9ceead5c9b6b91588531c659a0b))
* **csa-loom:** ADX/KQL + AI Search navigators (parity waves 3-4) ([#519](https://github.com/fgarofalo56/csa-inabox/issues/519)) ([a3fcbef](https://github.com/fgarofalo56/csa-inabox/commit/a3fcbef7d7b5a6ad195a7bec9a4748ef27f96999))
* **csa-loom:** atlas-diag-style React Flow drag-drop editors (Bezier) + deployment planner + ADF icon scraper ([#511](https://github.com/fgarofalo56/csa-inabox/issues/511)) ([3fc480e](https://github.com/fgarofalo56/csa-inabox/commit/3fc480e08eca2b60745b017beca6cc839dc54118))
* **csa-loom:** build Real-Time Hub into a real Fabric-parity surface ([#495](https://github.com/fgarofalo56/csa-inabox/issues/495)) ([0b6f49e](https://github.com/fgarofalo56/csa-inabox/commit/0b6f49e3ce418c83c2cf0045550b64356d3d020e))
* **csa-loom:** canvas + shell overhaul, control-flow sub-canvases, cross-sub resource picker ([#513](https://github.com/fgarofalo56/csa-inabox/issues/513)) ([bc40c7f](https://github.com/fgarofalo56/csa-inabox/commit/bc40c7f7ac54372b88eb9c6e398a772dcc2eaca8))
* **csa-loom:** Cosmos DB + Azure SQL navigators (parity waves 7-8) ([#521](https://github.com/fgarofalo56/csa-inabox/issues/521)) ([d02942e](https://github.com/fgarofalo56/csa-inabox/commit/d02942e9d4854d96c66e835af8c6847132a14bd9))
* **csa-loom:** data-agent editor parity with Fabric Data Agent ([#526](https://github.com/fgarofalo56/csa-inabox/issues/526)) ([c29aa33](https://github.com/fgarofalo56/csa-inabox/commit/c29aa338032cc6c136509f5151bbdd27e862fbda))
* **csa-loom:** Databricks workspace navigator — parity wave 2 ([#518](https://github.com/fgarofalo56/csa-inabox/issues/518)) ([122fde5](https://github.com/fgarofalo56/csa-inabox/commit/122fde522513b95b18632127d9a3b4906215304a))
* **csa-loom:** Event Hubs + APIM navigators (parity waves 5-6) ([#520](https://github.com/fgarofalo56/csa-inabox/issues/520)) ([80ffa16](https://github.com/fgarofalo56/csa-inabox/commit/80ffa16e1cc48b3fbc311fbd1c99f85db2bec569))
* **csa-loom:** functional API Marketplace — APIM consumer/catalog surface ([#497](https://github.com/fgarofalo56/csa-inabox/issues/497)) ([e674779](https://github.com/fgarofalo56/csa-inabox/commit/e674779247243962b2ddbb2bf9c9926a9af3c498))
* **csa-loom:** governance framework + unified catalog — honest Purview gate, real Data Map, overview ([#503](https://github.com/fgarofalo56/csa-inabox/issues/503)) ([953f43d](https://github.com/fgarofalo56/csa-inabox/commit/953f43dc2da4aa8378601cce602041721091cb1c))
* **csa-loom:** live validation harness + cross-sub discovery + navigator script fixes ([#528](https://github.com/fgarofalo56/csa-inabox/issues/528)) ([34e8aa4](https://github.com/fgarofalo56/csa-inabox/commit/34e8aa44926786b45282a11ed31e2c073653d2e8))
* **csa-loom:** Power BI + AI Foundry navigators (parity waves 9-10) ([#522](https://github.com/fgarofalo56/csa-inabox/issues/522)) ([4f7f734](https://github.com/fgarofalo56/csa-inabox/commit/4f7f73480f8d44773cca6399571ecc29b0e2dc43))
* **csa-loom:** Power Platform environment navigator (parity wave 11) ([#524](https://github.com/fgarofalo56/csa-inabox/issues/524)) ([3e19ab4](https://github.com/fgarofalo56/csa-inabox/commit/3e19ab4b87569012df45c05c5e37bb59721d8f86))
* **csa-loom:** real Azure AI Search index management (resource-binding) ([#489](https://github.com/fgarofalo56/csa-inabox/issues/489)) ([ffd287c](https://github.com/fgarofalo56/csa-inabox/commit/ffd287cd836275a1902e063a44c7d8a155264d68))
* **csa-loom:** real Azure database services for the SQL surface ([#488](https://github.com/fgarofalo56/csa-inabox/issues/488)) ([e57a319](https://github.com/fgarofalo56/csa-inabox/commit/e57a3193b21b6eec9604bbc44ba655ec8626f9d2))
* **csa-loom:** rebuild ADF/Synapse pipeline canvas to ADF-Studio parity ([#506](https://github.com/fgarofalo56/csa-inabox/issues/506)) ([bbef6dd](https://github.com/fgarofalo56/csa-inabox/commit/bbef6dd0304422ea078f10948f950278d9440e5f))
* **csa-loom:** rebuild Deployment Pipelines as real Fabric CI/CD + ARM history ([#501](https://github.com/fgarofalo56/csa-inabox/issues/501)) ([7ca197f](https://github.com/fgarofalo56/csa-inabox/commit/7ca197f1aba8f1fc830b8acb817cd28aa3893635))
* **csa-loom:** redesign Workload hub with spaced, homepage-style cards ([#504](https://github.com/fgarofalo56/csa-inabox/issues/504)) ([9184cf3](https://github.com/fgarofalo56/csa-inabox/commit/9184cf3940376aeb3e1b3e6eccdb236b5c479b42))
* **csa-loom:** Synapse Studio Workspace Resources navigator for the pipeline editor ([#517](https://github.com/fgarofalo56/csa-inabox/issues/517)) ([13d4e8b](https://github.com/fgarofalo56/csa-inabox/commit/13d4e8bffe02f6057c499926f1cf0d3698571c36))


### Bug Fixes

* **bicep:** onboard LAW to Sentinel via OnboardingStates before alert rules ([#502](https://github.com/fgarofalo56/csa-inabox/issues/502)) ([074a233](https://github.com/fgarofalo56/csa-inabox/commit/074a23340fcc627efbce80f8e279168fd028b852))
* **bicep:** Sentinel AI alert-rule KQL — Properties not CustomDimensions ([#510](https://github.com/fgarofalo56/csa-inabox/issues/510)) ([18fb0b3](https://github.com/fgarofalo56/csa-inabox/commit/18fb0b37adfbd9bfd5f411435437248410112f02))
* **csa-loom-copilot:** kill /copilot tab flicker — smooth-scroll storm + theme churn ([#487](https://github.com/fgarofalo56/csa-inabox/issues/487)) ([4a8d3e6](https://github.com/fgarofalo56/csa-inabox/commit/4a8d3e65bcaf18d6ed155f6d45a1f275f0239a5d))
* **csa-loom-deploy:** retry container-app roll on transient OperationInProgress ([#515](https://github.com/fgarofalo56/csa-inabox/issues/515)) ([97cd368](https://github.com/fgarofalo56/csa-inabox/commit/97cd3682cb7fff29d6bd419306403381e2a2f4dd))
* **csa-loom-deploy:** roll Container Apps via az containerapp update (drift-proof app-roll) ([#512](https://github.com/fgarofalo56/csa-inabox/issues/512)) ([4b2b999](https://github.com/fgarofalo56/csa-inabox/commit/4b2b999b5a8f2eb77a032090d217ffe39c91a2bc))
* **csa-loom:** Copilot tab flicker (scrollbar-race) + lakehouse SQL 403 honest gate ([#499](https://github.com/fgarofalo56/csa-inabox/issues/499)) ([c7bf912](https://github.com/fgarofalo56/csa-inabox/commit/c7bf912b972d2696447c4b2b8eeeffa293733355))
* **csa-loom:** make Data Agent test chat usable — pinned composer + content-type-guarded send ([#493](https://github.com/fgarofalo56/csa-inabox/issues/493)) ([eef3338](https://github.com/fgarofalo56/csa-inabox/commit/eef3338ddd27cf4dd647a6cc82da1966ed52887a))
* **csa-loom:** recover gitignored-out route files + harden .gitignore ([#492](https://github.com/fgarofalo56/csa-inabox/issues/492)) ([dc23eba](https://github.com/fgarofalo56/csa-inabox/commit/dc23eba87e468509491100a4cad7747f93a75d7e))
* **csa-loom:** setup wizard — add subscription selection + harden deploy gate ([#494](https://github.com/fgarofalo56/csa-inabox/issues/494)) ([5b6fba3](https://github.com/fgarofalo56/csa-inabox/commit/5b6fba3a9ed068f072abba7f3502271ab0e1d667))
* **csa-loom:** validate workflow secret-read + AI Search RBAC auth (live 34/34 GREEN) ([#529](https://github.com/fgarofalo56/csa-inabox/issues/529)) ([91a8a57](https://github.com/fgarofalo56/csa-inabox/commit/91a8a5701ed764b841f6bbbc5dfe61ec22ec3eed))
* **csa-loom:** wire service navigators to real Azure backing (bicep env-sync + live RBAC/env bridge) ([#527](https://github.com/fgarofalo56/csa-inabox/issues/527)) ([40421bc](https://github.com/fgarofalo56/csa-inabox/commit/40421bc33b7395cc97afaaaeef07c874904e706a))
* **fiab-bicep:** drift-safe role-assignment grants ([#507](https://github.com/fgarofalo56/csa-inabox/issues/507)) ([b9b2ee4](https://github.com/fgarofalo56/csa-inabox/commit/b9b2ee492f04544308908caf53a0067a1d264d44))


### Documentation

* **assets:** add loom logo image ([#523](https://github.com/fgarofalo56/csa-inabox/issues/523)) ([8f1ebfa](https://github.com/fgarofalo56/csa-inabox/commit/8f1ebfa8c6049dbc156abe7674227bff76ca7e9c))
* finish competitor legal pass — de-name identity products in multi-cloud whitepaper ([#525](https://github.com/fgarofalo56/csa-inabox/issues/525)) ([e13d0bf](https://github.com/fgarofalo56/csa-inabox/commit/e13d0bfa6e502fbcdccb62ff10360d7f2426451c))


### Continuous Integration

* **gitleaks:** allowlist test-fixture files (unblocks [#495](https://github.com/fgarofalo56/csa-inabox/issues/495)/[#496](https://github.com/fgarofalo56/csa-inabox/issues/496)/[#497](https://github.com/fgarofalo56/csa-inabox/issues/497)) ([#498](https://github.com/fgarofalo56/csa-inabox/issues/498)) ([1d14115](https://github.com/fgarofalo56/csa-inabox/commit/1d141159d01b3f539ab155de0dd23fa4975eea80))


### Miscellaneous

* **bicep:** enable Commercial Purview (purviewEnabled=true) ([#505](https://github.com/fgarofalo56/csa-inabox/issues/505)) ([760e397](https://github.com/fgarofalo56/csa-inabox/commit/760e3974841eba6ac7c099f26bd13b2c1be8ffce))
* **bicep:** revert TEMP skipRoleGrants flip — back to env-var default ([#509](https://github.com/fgarofalo56/csa-inabox/issues/509)) ([9e2110c](https://github.com/fgarofalo56/csa-inabox/commit/9e2110c15fed9d5d63e1e6b153e0f99f834d5c1f))
* **bicep:** TEMP skipRoleGrants=true for drifted live Commercial re-provision ([#508](https://github.com/fgarofalo56/csa-inabox/issues/508)) ([5b2b769](https://github.com/fgarofalo56/csa-inabox/commit/5b2b769e9d16ea0f76da4285ca80f29f822d7c82))

## [0.19.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.18.2...csa-inabox-v0.19.0) (2026-05-29)


### Features

* **csa-loom:** functional Eventstream, Semantic Model & Report editors ([#480](https://github.com/fgarofalo56/csa-inabox/issues/480)) ([cb0d812](https://github.com/fgarofalo56/csa-inabox/commit/cb0d81262768d61bedac460f4caf4bfdc8cce583))
* **csa-loom:** real Databricks Jobs parity for DatabricksJobEditor ([#477](https://github.com/fgarofalo56/csa-inabox/issues/477)) ([1afbe1c](https://github.com/fgarofalo56/csa-inabox/commit/1afbe1cb0f7d92d4404d46615724417dd6f28417))
* **csa-loom:** real visual prompt-flow builder (DAG canvas + flow.dag.yaml + run) ([#482](https://github.com/fgarofalo56/csa-inabox/issues/482)) ([824c182](https://github.com/fgarofalo56/csa-inabox/commit/824c182192c56888fa107c53a16f7137052cea89))


### Bug Fixes

* **csa-loom-ml-model:** resource-binding model backed by Azure ML ([#478](https://github.com/fgarofalo56/csa-inabox/issues/478)) ([6247008](https://github.com/fgarofalo56/csa-inabox/commit/6247008d66db776bbc3c9822a45756a741a3ab14))
* **csa-loom:** Power App editor — real resource-binding embed + publish, no 404 ([#479](https://github.com/fgarofalo56/csa-inabox/issues/479)) ([9949eca](https://github.com/fgarofalo56/csa-inabox/commit/9949eca0510e72ab8ff1e7acdf485aabb2c31323))

## [0.18.2](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.18.1...csa-inabox-v0.18.2) (2026-05-29)


### Bug Fixes

* **csa-loom-pipeline:** resource-binding model for ADF + Synapse pipelines ([#476](https://github.com/fgarofalo56/csa-inabox/issues/476)) ([8f8eba6](https://github.com/fgarofalo56/csa-inabox/commit/8f8eba62fcdacfb567f3ce16c8dae2dbdfa504af))


### Documentation

* **legal:** boxed disclaimer admonition + de-naming pass 2 (nav/titles/ADRs/body) + index reframe ([#468](https://github.com/fgarofalo56/csa-inabox/issues/468)) ([3956d6f](https://github.com/fgarofalo56/csa-inabox/commit/3956d6fcbc531599bf31167c01a7b6a1a100a756))
* **review:** apply safe fixes from comprehensive review ([#467](https://github.com/fgarofalo56/csa-inabox/issues/467)) ([6d71300](https://github.com/fgarofalo56/csa-inabox/commit/6d7130017695c0ed14c4b8834db6c14aa4b30e0e))

## [0.18.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.18.0...csa-inabox-v0.18.1) (2026-05-29)


### Documentation

* remove non-analytics 'Beyond Analytics' migrations — keep CSA scope tight ([#465](https://github.com/fgarofalo56/csa-inabox/issues/465)) ([7e7da61](https://github.com/fgarofalo56/csa-inabox/commit/7e7da61dabc57422e420d61b0c6c16fd2daceb78))


### Tests

* **csa-loom-uat:** cap honest-stub editors at C (stop inflating A) ([#446](https://github.com/fgarofalo56/csa-inabox/issues/446)) ([2873751](https://github.com/fgarofalo56/csa-inabox/commit/287375169fa370dde6491d54572acab835a4615c))

## [0.18.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.17.0...csa-inabox-v0.18.0) (2026-05-29)


### Features

* **csa-loom:** AI Foundry — model catalog search + deploy + chat playground (Foundry UI parity) ([#457](https://github.com/fgarofalo56/csa-inabox/issues/457)) ([1b2dbed](https://github.com/fgarofalo56/csa-inabox/commit/1b2dbed11028905cebf8d881078dce7aa572fabc))
* **csa-loom:** AI Foundry + data-agent feature completeness (real ops, no stubs) ([#450](https://github.com/fgarofalo56/csa-inabox/issues/450)) ([23ea7b5](https://github.com/fgarofalo56/csa-inabox/commit/23ea7b5fd7df62a6f2ab3b8225f18a3115af9d4b))
* **csa-loom:** APIs + Data Products family — Azure/Fabric UI parity ([#455](https://github.com/fgarofalo56/csa-inabox/issues/455)) ([de6d945](https://github.com/fgarofalo56/csa-inabox/commit/de6d945f1f1d2f45c7da9621597211aa691dc7ba))
* **csa-loom:** auto-select workspace on /new for final 8 editors (no dead disabled buttons) ([#442](https://github.com/fgarofalo56/csa-inabox/issues/442)) ([1c441c6](https://github.com/fgarofalo56/csa-inabox/commit/1c441c6f86c645f8bce979e7e485944b99506f13))
* **csa-loom:** Data Eng/Warehouse/DB family — Fabric/Azure UI parity ([#453](https://github.com/fgarofalo56/csa-inabox/issues/453)) ([2b1e216](https://github.com/fgarofalo56/csa-inabox/commit/2b1e21694e50f8bff7fe5ccac00df5fbb572a743))
* **csa-loom:** Data Factory family — Fabric/ADF look+feel+feature parity ([#448](https://github.com/fgarofalo56/csa-inabox/issues/448)) ([44b61e1](https://github.com/fgarofalo56/csa-inabox/commit/44b61e11f789ab113b229cb8de3d43b705109509))
* **csa-loom:** Databricks notebook cell-based parity + per-cell execution ([#462](https://github.com/fgarofalo56/csa-inabox/issues/462)) ([582e467](https://github.com/fgarofalo56/csa-inabox/commit/582e46717c7f211e0cb87658316ab1a0407701d6))
* **csa-loom:** Graph+Geo+Fabric-IQ family — Azure/Fabric UI parity ([#452](https://github.com/fgarofalo56/csa-inabox/issues/452)) ([2f83019](https://github.com/fgarofalo56/csa-inabox/commit/2f83019b995526749c48c250ecfe5b8e3b9164fe))
* **csa-loom:** Learn popups for all 90 catalog item types (A+ docs criterion) ([#443](https://github.com/fgarofalo56/csa-inabox/issues/443)) ([dc46d54](https://github.com/fgarofalo56/csa-inabox/commit/dc46d54c32e8f9198fc6c38600637fad0154b3d9))
* **csa-loom:** Power BI family A-grade parity — report viewer, scheduled refresh, take-over, tile drill ([#458](https://github.com/fgarofalo56/csa-inabox/issues/458)) ([178786d](https://github.com/fgarofalo56/csa-inabox/commit/178786dc96fff656f41a9067226c303357572e00))
* **csa-loom:** Power Platform + Copilot Studio family — UI parity ([#456](https://github.com/fgarofalo56/csa-inabox/issues/456)) ([7d6a973](https://github.com/fgarofalo56/csa-inabox/commit/7d6a973ab53c4dcb96f615ef58b163142993ccfa))
* **csa-loom:** RTI family — Fabric/ADX look+feel+feature parity ([#449](https://github.com/fgarofalo56/csa-inabox/issues/449)) ([f25b730](https://github.com/fgarofalo56/csa-inabox/commit/f25b730219b2ff847e4f3aa496162aebaa312744))


### Bug Fixes

* Fix:  ([592d1a8](https://github.com/fgarofalo56/csa-inabox/commit/592d1a84ca97f45beda929b73a5a33d6f3f4a8f5))
* **csa-loom:** activator /new gate + eventstream visual canvas ([#454](https://github.com/fgarofalo56/csa-inabox/issues/454)) ([a9e2222](https://github.com/fgarofalo56/csa-inabox/commit/a9e222292d8f30296aea6fe5c883027186eabe07))
* **csa-loom:** bind AI Foundry Hub to a real selectable Azure account + harden data-agent against legacy string sources ([#463](https://github.com/fgarofalo56/csa-inabox/issues/463)) ([e5044f3](https://github.com/fgarofalo56/csa-inabox/commit/e5044f372388860b942ce0b641527c931f16e64d))
* **csa-loom:** data-product Register-with-Purview made spec-compliant — no fake 200 ([#460](https://github.com/fgarofalo56/csa-inabox/issues/460)) ([592d1a8](https://github.com/fgarofalo56/csa-inabox/commit/592d1a84ca97f45beda929b73a5a33d6f3f4a8f5)), closes [#197](https://github.com/fgarofalo56/csa-inabox/issues/197)
* **csa-loom:** lakehouse SQL query route + Fabric right-click menu + real shortcuts ([#461](https://github.com/fgarofalo56/csa-inabox/issues/461)) ([b7b6f59](https://github.com/fgarofalo56/csa-inabox/commit/b7b6f599df51e00b40052de7d71637bf3186f4ca))


### Documentation

* **legal:** competitor-positioning legal pass — disclaimer (592 docs) + de-name sales/strategy/whitepaper ([#464](https://github.com/fgarofalo56/csa-inabox/issues/464)) ([f799858](https://github.com/fgarofalo56/csa-inabox/commit/f799858a0ac1a4bab78691a88ad19cf93510b6e8))
* **parity:** AI Foundry spec from LIVE screen-by-screen portal walk ([#451](https://github.com/fgarofalo56/csa-inabox/issues/451)) ([cef53c3](https://github.com/fgarofalo56/csa-inabox/commit/cef53c366323d142e41d7d0b0ed0f80cdd56681b))
* **rules:** add UI PARITY rule — one-for-one with Azure & Fabric UIs ([#447](https://github.com/fgarofalo56/csa-inabox/issues/447)) ([b7c9434](https://github.com/fgarofalo56/csa-inabox/commit/b7c9434f289361ab3b839fda05a27539a0675dc1))


### Tests

* **csa-loom-uat:** robust primary-action click (exact match + skip tab labels) ([#445](https://github.com/fgarofalo56/csa-inabox/issues/445)) ([890ced8](https://github.com/fgarofalo56/csa-inabox/commit/890ced895e09fc7ec02391352181e9920036543e))

## [0.17.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.16.0...csa-inabox-v0.17.0) (2026-05-29)


### Features

* **csa-loom-uat:** pnpm uat — one-command launcher (launches Chrome, signs in, runs deep UAT) ([#431](https://github.com/fgarofalo56/csa-inabox/issues/431)) ([0e210ef](https://github.com/fgarofalo56/csa-inabox/commit/0e210ef0304982a2330a56c23852b81be4a3942e))
* **csa-loom:** reframe Power BI editors — embed + refresh + export, remove dead authoring ribbon ([#437](https://github.com/fgarofalo56/csa-inabox/issues/437)) ([c0f465d](https://github.com/fgarofalo56/csa-inabox/commit/c0f465d144f1a6f07b9a3cfe76ca72a9a09cf8df))
* **csa-loom:** wire primary actions on 11 C-grade editors ([#438](https://github.com/fgarofalo56/csa-inabox/issues/438)) ([1c75e31](https://github.com/fgarofalo56/csa-inabox/commit/1c75e31d3bb1e794800cd93cf1f203404b08e325))


### Bug Fixes

* **csa-loom-build:** disable legacy docker-push workflow (was racing ACR firewall) ([#424](https://github.com/fgarofalo56/csa-inabox/issues/424)) ([c6d3283](https://github.com/fgarofalo56/csa-inabox/commit/c6d328381bdffd6e340711153a516a31c095cc1b))
* **csa-loom-console:** force HTML revalidation (stops Front Door serving stale shells) ([#426](https://github.com/fgarofalo56/csa-inabox/issues/426)) ([ce12df0](https://github.com/fgarofalo56/csa-inabox/commit/ce12df0d25bb8fb6ac9302a0bf8b74b37a335d38))
* **csa-loom-monaco:** use absolute origin for worker URL (fixes importScripts invalid-URL) ([#432](https://github.com/fgarofalo56/csa-inabox/issues/432)) ([aa4a2a0](https://github.com/fgarofalo56/csa-inabox/commit/aa4a2a0d9c7adaa0ac49b2763eb198f2f9d9e907))
* **csa-loom-monaco:** use absolute origin for worker URL (fixes importScripts invalid-URL) ([#433](https://github.com/fgarofalo56/csa-inabox/issues/433)) ([a5262f3](https://github.com/fgarofalo56/csa-inabox/commit/a5262f388ae0095d38b9c66914b37e4c8bc9ac14))
* **csa-loom-notebook:** add /api/items/lakehouse list route + deep functional UAT spec ([#427](https://github.com/fgarofalo56/csa-inabox/issues/427)) ([bd5d7cd](https://github.com/fgarofalo56/csa-inabox/commit/bd5d7cd0eb1cda33e2e9126ff7b9933c1bfe5990))
* **csa-loom-pipeline:** no 502 on run-history for unsaved pipelines ([#435](https://github.com/fgarofalo56/csa-inabox/issues/435)) ([f5093f7](https://github.com/fgarofalo56/csa-inabox/commit/f5093f734a3db70121bdf301ad93e0d0ff9f95ec))
* **csa-loom-uat:** validate saved session against /api/me before reuse + adf runs new-guard ([#436](https://github.com/fgarofalo56/csa-inabox/issues/436)) ([69c52a2](https://github.com/fgarofalo56/csa-inabox/commit/69c52a251be29e60a23994b0763bbddaf1781df5))
* **csa-loom:** activator /new gate + eventstream visual canvas ([#440](https://github.com/fgarofalo56/csa-inabox/issues/440)) ([26f2dd0](https://github.com/fgarofalo56/csa-inabox/commit/26f2dd02c9f1cc7926abf8097203e306c616528f))
* **csa-loom:** adf-dataset editor + graph/ontology editor wiring ([#434](https://github.com/fgarofalo56/csa-inabox/issues/434)) ([3df44a0](https://github.com/fgarofalo56/csa-inabox/commit/3df44a03e794de7b4414e88db18539bb7fde8b5f))


### Tests

* **csa-loom-uat:** award A/A+ grades (B + Vitest test + Learn popup) ([#441](https://github.com/fgarofalo56/csa-inabox/issues/441)) ([aa188cd](https://github.com/fgarofalo56/csa-inabox/commit/aa188cd490a99750c969b2d37ef9b14526b23c1a))
* **csa-loom-uat:** honest verdict grading + hydration-race guard ([#439](https://github.com/fgarofalo56/csa-inabox/issues/439)) ([d6d3807](https://github.com/fgarofalo56/csa-inabox/commit/d6d380750d2815121d9429ef93b618ee1f96fd00))

## [0.16.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.15.0...csa-inabox-v0.16.0) (2026-05-28)


### Features

* **csa-loom:** bump 6 D-grade editors to B + polish 2 C-grade editors ([#420](https://github.com/fgarofalo56/csa-inabox/issues/420)) ([dcd8cbf](https://github.com/fgarofalo56/csa-inabox/commit/dcd8cbff303fb394ae2aeec29ede2a7ccaed1ac9))


### Bug Fixes

* **csa-loom:** remove malformed pnpm-workspace.yaml that broke loom-console build ([#421](https://github.com/fgarofalo56/csa-inabox/issues/421)) ([7ffc54c](https://github.com/fgarofalo56/csa-inabox/commit/7ffc54c2b644f71a4f23ee75d75431ee91624515))

## [0.15.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.14.1...csa-inabox-v0.15.0) (2026-05-28)


### Features

* **csa-loom:** no-cuts sweep — restore every deferred feature across editors + admin + infra ([#380](https://github.com/fgarofalo56/csa-inabox/issues/380)) ([e076e97](https://github.com/fgarofalo56/csa-inabox/commit/e076e97ff798bd0b4e2c79e0d34ecdfdd50c95ab))
* **csa-loom:** Unified Catalog — Purview + Unity Catalog + OneLake federation with cross-source ops ([#376](https://github.com/fgarofalo56/csa-inabox/issues/376)) ([49b1ed8](https://github.com/fgarofalo56/csa-inabox/commit/49b1ed8064e7ac53f88e7f035891e8c50a780c7a))


### Tests

* **csa-loom:** Vitest contract tests across all 90 editors — bump everything to A-grade ([#418](https://github.com/fgarofalo56/csa-inabox/issues/418)) ([db7b9d7](https://github.com/fgarofalo56/csa-inabox/commit/db7b9d77af1dd5ca9416e7efe230daaac3ee22d5))

## [0.14.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.14.0...csa-inabox-v0.14.1) (2026-05-28)


### Bug Fixes

* **docs:** shrink search index ~20x and fix broken site search (Closes [#399](https://github.com/fgarofalo56/csa-inabox/issues/399)) ([#415](https://github.com/fgarofalo56/csa-inabox/issues/415)) ([f775380](https://github.com/fgarofalo56/csa-inabox/commit/f775380e444540cb6f156e9f9bbbfd7e44fc4710))


### Documentation

* **csa-loom:** reorganize nav into 13 coherent categories (Closes [#408](https://github.com/fgarofalo56/csa-inabox/issues/408)) ([#416](https://github.com/fgarofalo56/csa-inabox/issues/416)) ([fa4b85d](https://github.com/fgarofalo56/csa-inabox/commit/fa4b85dd627af82932bb76781b92c37dc15328b9))

## [0.14.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.13.0...csa-inabox-v0.14.0) (2026-05-28)


### Features

* **csa-loom:** AI Foundry / APIM / Copilot Studio family — production-grade across 19 editors ([#365](https://github.com/fgarofalo56/csa-inabox/issues/365)) ([81c0463](https://github.com/fgarofalo56/csa-inabox/commit/81c0463d91ccdc130db1f144e08aeed20b76b20d))


### Bug Fixes

* **docs:** render direct-lake-replacement architecture as mermaid ([#411](https://github.com/fgarofalo56/csa-inabox/issues/411)) ([570f3fd](https://github.com/fgarofalo56/csa-inabox/commit/570f3fd7ed07970f4c8678c8487df18d4a415656)), closes [#405](https://github.com/fgarofalo56/csa-inabox/issues/405)
* **docs:** render federal-data-mesh pattern as mermaid diagram ([#413](https://github.com/fgarofalo56/csa-inabox/issues/413)) ([1bdebc4](https://github.com/fgarofalo56/csa-inabox/commit/1bdebc458dafe266a7b8cefa88b3d8e139ab131b)), closes [#404](https://github.com/fgarofalo56/csa-inabox/issues/404)
* **docs:** render hybrid-topology pattern as mermaid diagram ([#409](https://github.com/fgarofalo56/csa-inabox/issues/409)) ([91f85ae](https://github.com/fgarofalo56/csa-inabox/commit/91f85ae3db29cf325b65013c0060f3ddfcb9881a)), closes [#407](https://github.com/fgarofalo56/csa-inabox/issues/407)
* **docs:** render sovereign-agents architecture as mermaid diagram ([#410](https://github.com/fgarofalo56/csa-inabox/issues/410)) ([e7b6f64](https://github.com/fgarofalo56/csa-inabox/commit/e7b6f64132498c975a09f82f0aecc19129cbaade)), closes [#406](https://github.com/fgarofalo56/csa-inabox/issues/406)
* **docs:** stop .gitignore from excluding docs/build/ (Closes [#403](https://github.com/fgarofalo56/csa-inabox/issues/403)) ([#412](https://github.com/fgarofalo56/csa-inabox/issues/412)) ([5df11d8](https://github.com/fgarofalo56/csa-inabox/commit/5df11d8c46e0d04147d9b566cc9fc29dd56b668b))

## [0.13.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.12.0...csa-inabox-v0.13.0) (2026-05-28)


### Features

* **csa-loom-monitor:** add Refresh button + time-range filter to ActivityFeedPane ([#400](https://github.com/fgarofalo56/csa-inabox/issues/400)) ([3a63eaa](https://github.com/fgarofalo56/csa-inabox/commit/3a63eaad26c6c4aea625a469268be469d0c3d56c))
* **csa-loom:** RTI family — production-grade across 6 editors (Eventhouse/KQL/Eventstream/Activator) ([#368](https://github.com/fgarofalo56/csa-inabox/issues/368)) ([5d83f34](https://github.com/fgarofalo56/csa-inabox/commit/5d83f343a8b25ec3a7969fbd537caa847ad69caa))
* **csa-loom:** wire 5 F-grade editors (mirrored-databricks, mounted-adf, event-schema-set, sql-database, airflow-job) ([#401](https://github.com/fgarofalo56/csa-inabox/issues/401)) ([74dc5ac](https://github.com/fgarofalo56/csa-inabox/commit/74dc5ac605025bae89c119644a05a61ec778d988))

## [0.12.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.11.2...csa-inabox-v0.12.0) (2026-05-28)


### Features

* **csa-loom-admin:** full Purview + MIP + DLP management inside CSA Loom (no portal hand-offs) ([#373](https://github.com/fgarofalo56/csa-inabox/issues/373)) ([4efb227](https://github.com/fgarofalo56/csa-inabox/commit/4efb227ec7fd82db3329a56d6924a3efea439439))
* **csa-loom-admin:** scale-by-SKU dropdowns for every scalable service (Fabric capacity, Synapse, ADX, Databricks, AI Search, APIM, Cosmos, Container Apps, Foundry) ([#387](https://github.com/fgarofalo56/csa-inabox/issues/387)) ([2e064cc](https://github.com/fgarofalo56/csa-inabox/commit/2e064ccd2d75fd1507294ba701162e4002fb07cc))
* **csa-loom-copilot:** orchestrator status banner + per-tool direct invoke endpoint ([#384](https://github.com/fgarofalo56/csa-inabox/issues/384)) ([0a869d2](https://github.com/fgarofalo56/csa-inabox/commit/0a869d2c6aa0b0c76899ad4953263355eb653240))
* **csa-loom-tabs:** group-by-workspace default ON + workspace names + nested overflow ([#363](https://github.com/fgarofalo56/csa-inabox/issues/363)) ([d78ce68](https://github.com/fgarofalo56/csa-inabox/commit/d78ce684accc9a41739464a744dcb8332094e3fc))
* **csa-loom-workload-hub:** visual polish — alignment + spacing + rounded corners + per-family icon colors ([#367](https://github.com/fgarofalo56/csa-inabox/issues/367)) ([7808b83](https://github.com/fgarofalo56/csa-inabox/commit/7808b832f32fbc269c0407dc688a10b38aaac618))
* **csa-loom:** Data Engineering family — production-grade across 10 editors ([#371](https://github.com/fgarofalo56/csa-inabox/issues/371)) ([d555b60](https://github.com/fgarofalo56/csa-inabox/commit/d555b6091567f94f9f84e2efa132ec3edeaefdb7))
* **csa-loom:** Data Pipeline editor — full Fabric parity (palette + canvas + properties + ribbon + tabs) ([#388](https://github.com/fgarofalo56/csa-inabox/issues/388)) ([13f3c7e](https://github.com/fgarofalo56/csa-inabox/commit/13f3c7e537d7a78e074c125db3ab8fd3c4cfd987))
* **csa-loom:** docs-grounded Help Copilot floating widget (recovered from crash + wired) ([#375](https://github.com/fgarofalo56/csa-inabox/issues/375)) ([d8b1e28](https://github.com/fgarofalo56/csa-inabox/commit/d8b1e2828cfae095fee7be3f8ec90f6b81cd8e92))
* **csa-loom:** Eventhouse full toolset + SQL Database editor (no longer generic shell) ([#362](https://github.com/fgarofalo56/csa-inabox/issues/362)) ([cab9009](https://github.com/fgarofalo56/csa-inabox/commit/cab9009a35774fe5bcaf8e7fa98387cb146dc478))
* **csa-loom:** LOOM_GRAPH_USERS_ENABLED default-on + UAMI Graph role grant + screenshot popup fix ([#372](https://github.com/fgarofalo56/csa-inabox/issues/372)) ([e6d7a5f](https://github.com/fgarofalo56/csa-inabox/commit/e6d7a5f1b98e0a770ecb70dd888504669818f72d))
* **csa-loom:** Next.js 14 -&gt; 15 migration (closes [#158](https://github.com/fgarofalo56/csa-inabox/issues/158), picks up GHSA-8h8q-6873-q5fj DoS fix) ([#391](https://github.com/fgarofalo56/csa-inabox/issues/391)) ([bdae7f5](https://github.com/fgarofalo56/csa-inabox/commit/bdae7f5f00954e1815264e0197cee90c814bba30))
* **csa-loom:** no-cuts v3 ribbon salvage — wire 10 remaining disabled buttons (+2.4k LOC) ([#382](https://github.com/fgarofalo56/csa-inabox/issues/382)) ([58791fd](https://github.com/fgarofalo56/csa-inabox/commit/58791fd10e0bb52217dab0170fe100a9827aae28))
* **csa-loom:** Phase 2 — real artifact provisioning on app install + Fabric-style RBAC for admins ([#390](https://github.com/fgarofalo56/csa-inabox/issues/390)) ([afcab1e](https://github.com/fgarofalo56/csa-inabox/commit/afcab1e8900ba3c4797c95ea3d56c2078428869b))
* **csa-loom:** PRP validation receipts — move 9 PRPs from 🟡 to ✅ + close 4 outstanding parity items ([#386](https://github.com/fgarofalo56/csa-inabox/issues/386)) ([42f7019](https://github.com/fgarofalo56/csa-inabox/commit/42f70196ba808e4552cfaca06592ade38a5afb3f))
* **csa-loom:** Synapse / Databricks / ADF family — production-grade across 12 editors ([#364](https://github.com/fgarofalo56/csa-inabox/issues/364)) ([8640550](https://github.com/fgarofalo56/csa-inabox/commit/86405502def63a46c9ef42f9ceef25af8c4b5145))
* **csa-loom:** wire workspace create Capacity + Domain to real Fabric + Purview + Marketplace ([#379](https://github.com/fgarofalo56/csa-inabox/issues/379)) ([7f8c02a](https://github.com/fgarofalo56/csa-inabox/commit/7f8c02ab0ae07feb011d019a560a140473452a3f))


### Bug Fixes

* **csa-loom-aisearch:** strip 'description' from ScoringProfile in upsertIndex ([#396](https://github.com/fgarofalo56/csa-inabox/issues/396)) ([b9b182a](https://github.com/fgarofalo56/csa-inabox/commit/b9b182a614f917020624b2e91a86628714424f94))
* **csa-loom-bicep:** expose LOOM_ADMIN_RG + LOOM_AI_SEARCH_RG + LOOM_ACA_RG env vars ([#398](https://github.com/fgarofalo56/csa-inabox/issues/398)) ([de82346](https://github.com/fgarofalo56/csa-inabox/commit/de82346624664c02160df631add80fff2cd175fa))
* **csa-loom-bootstrap:** SCIM grants all 4 Databricks entitlements + PATCH existing SP ([#392](https://github.com/fgarofalo56/csa-inabox/issues/392)) ([bc62e7a](https://github.com/fgarofalo56/csa-inabox/commit/bc62e7a3ee4bb2001d5efe4369d0f910201af77b))
* **csa-loom-build:** unstuck image builds — toggle ACR publicNetworkAccess in build workflow ([#394](https://github.com/fgarofalo56/csa-inabox/issues/394)) ([bfb7914](https://github.com/fgarofalo56/csa-inabox/commit/bfb7914d9af69e6c62802a2b1714273c68628727))
* **csa-loom-lakehouse:** harden upload — accept ALL Spark file types + handle non-JSON error responses ([#360](https://github.com/fgarofalo56/csa-inabox/issues/360)) ([86e4cd7](https://github.com/fgarofalo56/csa-inabox/commit/86e4cd779ff2be3509540f65c47aa1ea1c84fb97))
* **csa-loom-pbi:** use Power BI groupIds (not Loom UUIDs) in Report/Dashboard/Semantic/Scorecard editors ([#361](https://github.com/fgarofalo56/csa-inabox/issues/361)) ([8b3e1bf](https://github.com/fgarofalo56/csa-inabox/commit/8b3e1bf850a249d9f5de17392070239911bd688b))
* **csa-loom-synapse:** remove duplicate trigger functions from PR [#371](https://github.com/fgarofalo56/csa-inabox/issues/371) merge ([#397](https://github.com/fgarofalo56/csa-inabox/issues/397)) ([59c293a](https://github.com/fgarofalo56/csa-inabox/commit/59c293a6590158d08fb00ad11575aa5772c26a4f))
* **portal-deps:** align react-dom/@types/react-dom/@testing-library/react with react 19 ([#389](https://github.com/fgarofalo56/csa-inabox/issues/389)) ([664aa79](https://github.com/fgarofalo56/csa-inabox/commit/664aa7945d4437741193b0772790cb119ff271ba))


### Documentation

* **csa-loom-deployment:** add 4 CI/CD pipeline guides + nav + icon refresh ([#370](https://github.com/fgarofalo56/csa-inabox/issues/370)) ([67b1ed7](https://github.com/fgarofalo56/csa-inabox/commit/67b1ed70e6084f4c084538966d8c89eac4cdb670))
* **csa-loom-marketing:** build out 30-min/60-min/2-hour pitch scripts to back up seller-playbook claims ([#374](https://github.com/fgarofalo56/csa-inabox/issues/374)) ([158eb13](https://github.com/fgarofalo56/csa-inabox/commit/158eb13dec73c7a5e468fbefc8216dabb2f1a0ea))
* **csa-loom-ops:** persistence + chargeback + multi-DLZ audit doc ([#383](https://github.com/fgarofalo56/csa-inabox/issues/383)) ([b7290ee](https://github.com/fgarofalo56/csa-inabox/commit/b7290eeb7fda7dd7c7f192fd9ac8d7b6cb83b1b6))
* **csa-loom:** clarify Azure Commercial / GCC = GA (GCC runs on Commercial regions) ([#377](https://github.com/fgarofalo56/csa-inabox/issues/377)) ([d0aa174](https://github.com/fgarofalo56/csa-inabox/commit/d0aa1744d4340f4f990186f08b11b8d658a16c7d))
* **csa-loom:** per-page Loom hero SVGs for architecture / parity-matrix / deployment / workloads / workshops ([#381](https://github.com/fgarofalo56/csa-inabox/issues/381)) ([872e5d2](https://github.com/fgarofalo56/csa-inabox/commit/872e5d2af1c85b71d8a0841cbc91840c2d0fb74e))
* **guides:** add 'Build an internal data marketplace' tutorial (closes [#298](https://github.com/fgarofalo56/csa-inabox/issues/298)) ([#359](https://github.com/fgarofalo56/csa-inabox/issues/359)) ([b77f16e](https://github.com/fgarofalo56/csa-inabox/commit/b77f16ed584a65d4de9e3a6de05b0bb6a4c07090))
* **learn:** add DQS glossary entry (closes [#246](https://github.com/fgarofalo56/csa-inabox/issues/246)) ([#357](https://github.com/fgarofalo56/csa-inabox/issues/357)) ([f5e667f](https://github.com/fgarofalo56/csa-inabox/commit/f5e667f5a570679e0685d6c44adf5019deeb6977))


### Tests

* **csa-loom:** no-cuts v3 ribbon Playwright UAT (complements PR [#382](https://github.com/fgarofalo56/csa-inabox/issues/382)) ([#385](https://github.com/fgarofalo56/csa-inabox/issues/385)) ([9223d1b](https://github.com/fgarofalo56/csa-inabox/commit/9223d1b51c3ff84822553d46adc856721c3e9020))


### Miscellaneous

* **deps:** Bump @azure/msal-react from 5.4.1 to 5.4.2 in /portal/react-webapp ([#276](https://github.com/fgarofalo56/csa-inabox/issues/276)) ([fde3146](https://github.com/fgarofalo56/csa-inabox/commit/fde3146299c953864e7d64aac1b1b10f2440d59c))

## [0.11.2](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.11.1...csa-inabox-v0.11.2) (2026-05-27)


### Bug Fixes

* **csa-loom-databricks:** cluster create 403 — add allow-cluster-create + allow-instance-pool-create entitlements ([#366](https://github.com/fgarofalo56/csa-inabox/issues/366)) ([8279537](https://github.com/fgarofalo56/csa-inabox/commit/827953796277b2d1717739aef6c50bf4c222ead0))


### Documentation

* **csa-loom:** add 'Why CSA Loom' name explanation to index page ([#356](https://github.com/fgarofalo56/csa-inabox/issues/356)) ([ebd8991](https://github.com/fgarofalo56/csa-inabox/commit/ebd89915a969cdbc84d069fb5d1f7925a30adfb1))

## [0.11.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.11.0...csa-inabox-v0.11.1) (2026-05-27)


### Bug Fixes

* **csa-loom-ci:** copilot-tools probe accepts 401 for unauthed CI ([#339](https://github.com/fgarofalo56/csa-inabox/issues/339)) ([7dbfc96](https://github.com/fgarofalo56/csa-inabox/commit/7dbfc96f7e3a578e8745ac448618c8ef84b375ff))


### Documentation

* **csa-loom:** rebuild hero SVG with full content (chip + title + schematic) ([#355](https://github.com/fgarofalo56/csa-inabox/issues/355)) ([79b7701](https://github.com/fgarofalo56/csa-inabox/commit/79b770101832b61889b28c7a1dc1b451bd50c673))

## [0.11.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.10.0...csa-inabox-v0.11.0) (2026-05-27)


### Features

* **csa-loom-ci:** deploy-validation loop + Dockerfile build-marker stamping ([#338](https://github.com/fgarofalo56/csa-inabox/issues/338)) ([688f1ba](https://github.com/fgarofalo56/csa-inabox/commit/688f1ba304ca43943021ae195b3bb09437c8349d))
* **csa-loom:** apps install — full code+data starter bundles for all 10 CSA apps ([#341](https://github.com/fgarofalo56/csa-inabox/issues/341)) ([7eea07a](https://github.com/fgarofalo56/csa-inabox/commit/7eea07aa8a34431d54da1bce7d3fa0da26c20496))
* **csa-loom:** Build Phase 1 — Monaco + PB embed + 17 BLOCKER fixes + Spark SQL hang fix ([#340](https://github.com/fgarofalo56/csa-inabox/issues/340)) ([936c567](https://github.com/fgarofalo56/csa-inabox/commit/936c567d95bdfe123cfb330af8a2c18caac4e02c))
* **csa-loom:** catalog 85/85 + Build Phase 1 + Foundry/Purview/Notebook P3 deploy stubs + DNS bicep fix ([#336](https://github.com/fgarofalo56/csa-inabox/issues/336)) ([9afb233](https://github.com/fgarofalo56/csa-inabox/commit/9afb2336f39a3fd2d1d68c52de9ad2434738ea38))
* **csa-loom:** compute lifecycle UI + backing-service pickers + pre-save silencing + /onelake WAF fix ([#345](https://github.com/fgarofalo56/csa-inabox/issues/345)) ([146d215](https://github.com/fgarofalo56/csa-inabox/commit/146d2158999b5e2ed851c4ebe04280370f1db48b))
* **csa-loom:** mega-batch — tab strip + workspace tree + workspaces tile/list + /apps polish + Multi-Cloud docs + CSA Loom moved last ([#353](https://github.com/fgarofalo56/csa-inabox/issues/353)) ([5fa28e0](https://github.com/fgarofalo56/csa-inabox/commit/5fa28e0c95a74a0d4d0d8a79cc461bf6633b616d))


### Bug Fixes

* **csa-loom:** Activator workspace dropdown was Power BI groups — swap to Loom workspaces ([#343](https://github.com/fgarofalo56/csa-inabox/issues/343)) ([4a6a9b3](https://github.com/fgarofalo56/csa-inabox/commit/4a6a9b3084fc8a171e3cb834b851c51ae11ed664))
* **csa-loom:** Monaco worker CSP — allow blob: in script-src/worker-src ([#342](https://github.com/fgarofalo56/csa-inabox/issues/342)) ([73192c2](https://github.com/fgarofalo56/csa-inabox/commit/73192c2899d7dadbbee2710e79a730b23ca8c171))
* **csa-loom:** wire ribbon buttons across 18 editors (175 onClick + 111 honestly disabled) ([#344](https://github.com/fgarofalo56/csa-inabox/issues/344)) ([1e4cb04](https://github.com/fgarofalo56/csa-inabox/commit/1e4cb0448e7f2d07db9326c1ddaa2799a1324072))


### Documentation

* **csa-loom:** hero gradient matches live app + re-drop --strict from docs deploy ([#354](https://github.com/fgarofalo56/csa-inabox/issues/354)) ([b49c756](https://github.com/fgarofalo56/csa-inabox/commit/b49c756a7ea9ece777b247e356d7f12abcb3cd4e))
* **csa-loom:** release 2026-05-27 notes + nav + apim-policy parser fix ([#347](https://github.com/fgarofalo56/csa-inabox/issues/347)) ([f709ce6](https://github.com/fgarofalo56/csa-inabox/commit/f709ce69debc0e7cb18583675804acf73297366e))
* update test script with live smoke results (46/48 walkthrough) ([#346](https://github.com/fgarofalo56/csa-inabox/issues/346)) ([86d6cfd](https://github.com/fgarofalo56/csa-inabox/commit/86d6cfd98ffde76bd42019c0bd263bad7c4d3b92))


### Continuous Integration

* add csa-loom-attempt-interactive-grants workflow on main ([#334](https://github.com/fgarofalo56/csa-inabox/issues/334)) ([66b4139](https://github.com/fgarofalo56/csa-inabox/commit/66b41395638b4b9ec4468da80a06c12f2da1202f))
* **docs:** drop --strict so docs site can deploy past tutorial cross-link warnings ([#352](https://github.com/fgarofalo56/csa-inabox/issues/352)) ([f0b5222](https://github.com/fgarofalo56/csa-inabox/commit/f0b52221eb7962ca3bbcccae4569b08415b9834c))

## [0.10.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.9.0...csa-inabox-v0.10.0) (2026-05-25)


### Features

* **csa-loom:** v1.5–v1.10 — Loom Console rebuild + governance + APIM + ATLAS logo ([#331](https://github.com/fgarofalo56/csa-inabox/issues/331)) ([8b1b40d](https://github.com/fgarofalo56/csa-inabox/commit/8b1b40d04dbfeac3d27107729bdcb4c584e8a257))


### Miscellaneous

* **deps:** Bump react and @types/react in /portal/react-webapp ([#272](https://github.com/fgarofalo56/csa-inabox/issues/272)) ([6986b77](https://github.com/fgarofalo56/csa-inabox/commit/6986b776cff9929dd09a5c01266448492adea096))

## [0.9.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.8.0...csa-inabox-v0.9.0) (2026-05-24)


### Features

* **csa-loom:** VPN + App Gateway + Front Door access patterns ([#329](https://github.com/fgarofalo56/csa-inabox/issues/329)) ([fd6c9c7](https://github.com/fgarofalo56/csa-inabox/commit/fd6c9c7289549ca7638fbb2dd4979125a9a480ee))


### Bug Fixes

* **csa-loom:** make 4 worker apps boot in a partially-configured env ([#327](https://github.com/fgarofalo56/csa-inabox/issues/327)) ([0d49273](https://github.com/fgarofalo56/csa-inabox/commit/0d49273be24be2e6a6d5a863a1a62736ba8b6afb))

## [0.8.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.7.0...csa-inabox-v0.8.0) (2026-05-24)


### Features

* **brand:** heroes on every page — 27 new defaults close the last gaps ([#270](https://github.com/fgarofalo56/csa-inabox/issues/270)) ([cf22e43](https://github.com/fgarofalo56/csa-inabox/commit/cf22e431154d1fbd3179731fc7505d2fd1183d6a))
* **csa-loom:** ACR Tasks image build + iteration log final ([#306](https://github.com/fgarofalo56/csa-inabox/issues/306)) ([b7c381d](https://github.com/fgarofalo56/csa-inabox/commit/b7c381d627924640d9d3648b5fce9bd3644042bf))
* **csa-loom:** brand cleanup + PRP audit + full-app-deploy workflow ([#308](https://github.com/fgarofalo56/csa-inabox/issues/308)) ([a63db5d](https://github.com/fgarofalo56/csa-inabox/commit/a63db5d9f7b504994869df4a6dc7dc8353fb9b40))
* **csa-loom:** deploy workflow iteration + image-build pipeline ([#296](https://github.com/fgarofalo56/csa-inabox/issues/296)) ([631894c](https://github.com/fgarofalo56/csa-inabox/commit/631894c1d86e9dd4cdbfe18b5607d0a985dac926))
* **csa-loom:** pillar v0.1 — Microsoft Fabric parity for Azure Gov ([#282](https://github.com/fgarofalo56/csa-inabox/issues/282)) ([9153768](https://github.com/fgarofalo56/csa-inabox/commit/915376879b70f5f5efddef152e01ec7b7c4f5d57))
* **csa-loom:** UAT jumpbox deploy workflow ([#323](https://github.com/fgarofalo56/csa-inabox/issues/323)) ([ebdcb29](https://github.com/fgarofalo56/csa-inabox/commit/ebdcb291c44a6eabb8bb640a6ccdc21a7a3c7a01))
* **csa-loom:** v2 PRP backlog scaffold ([#321](https://github.com/fgarofalo56/csa-inabox/issues/321)) ([487881c](https://github.com/fgarofalo56/csa-inabox/commit/487881c545e1d421d511b071a27f468a06e86f7f))
* **csa-loom:** Wave 1 — real implementation for PRP-02..09 + 11/12/13/14 ([#291](https://github.com/fgarofalo56/csa-inabox/issues/291)) ([c6737ac](https://github.com/fgarofalo56/csa-inabox/commit/c6737ac4c6b11d07dd84101407131cf270112297))
* **csa-loom:** Wave 2 — telemetry-everywhere + Synapse hardening + remaining sub-modules + deploy SP auth ([#292](https://github.com/fgarofalo56/csa-inabox/issues/292)) ([a6dfd9f](https://github.com/fgarofalo56/csa-inabox/commit/a6dfd9fa7bdf84b4b30764321da6ca4ce22a77e5))
* **csa-loom:** Wave 3 — workflow dry-run + Synapse audit + LAW monitoring playbooks ([#293](https://github.com/fgarofalo56/csa-inabox/issues/293)) ([02fa684](https://github.com/fgarofalo56/csa-inabox/commit/02fa684066017da4c8878c8587066045f78d5901))
* **csa-loom:** Wave 3 follow-ups — secret precheck + 3 operator runbooks + tests ([#295](https://github.com/fgarofalo56/csa-inabox/issues/295)) ([2e1e6b1](https://github.com/fgarofalo56/csa-inabox/commit/2e1e6b1eb680cb78b0a95492db7a4a6e72190c23))
* **visual:** branding cleanup, social cards, MS Learn fix, section heroes, raster→SVG ([#266](https://github.com/fgarofalo56/csa-inabox/issues/266)) ([5b2d38a](https://github.com/fgarofalo56/csa-inabox/commit/5b2d38a1ba89be02e58a563472ffd19f6b30ff15))


### Bug Fixes

* **brand+copilot:** ship og-card.png + MS Learn always supplements on-topic ([#269](https://github.com/fgarofalo56/csa-inabox/issues/269)) ([7a490bc](https://github.com/fgarofalo56/csa-inabox/commit/7a490bca98df75178dff4da415d0d7f9d9099b0e))
* **ci:** install mkdocs-material[imaging] for social plugin ([#268](https://github.com/fgarofalo56/csa-inabox/issues/268)) ([bf973f7](https://github.com/fgarofalo56/csa-inabox/commit/bf973f795e060887fd512bfcf9d9e4b980c3b26c))
* **csa-loom:** 3 build-time code errors in full-app-deploy iter D ([#314](https://github.com/fgarofalo56/csa-inabox/issues/314)) ([027f2dc](https://github.com/fgarofalo56/csa-inabox/commit/027f2dc567177f7728e87a2ae8057cf56cb9f69c))
* **csa-loom:** AcrPush role + Console telemetry + pnpm-lock ([#309](https://github.com/fgarofalo56/csa-inabox/issues/309)) ([e312cd2](https://github.com/fgarofalo56/csa-inabox/commit/e312cd22c0d93e02a7e646b7ebf2e78af5d670d8))
* **csa-loom:** default Commercial purviewEnabled to false ([#294](https://github.com/fgarofalo56/csa-inabox/issues/294)) ([1a4a657](https://github.com/fgarofalo56/csa-inabox/commit/1a4a6572a2177e5bcd552e8b5e800b01e48b4b26))
* **csa-loom:** full-app-deploy — Debezium tag + AcrPull UAMIs + login retry ([#312](https://github.com/fgarofalo56/csa-inabox/issues/312)) ([82103c6](https://github.com/fgarofalo56/csa-inabox/commit/82103c6074c7c5b88b37da6a61e2670fba155ed4))
* **csa-loom:** iter [#5](https://github.com/fgarofalo56/csa-inabox/issues/5) — cosmos containers parent: + teardown helper ([#302](https://github.com/fgarofalo56/csa-inabox/issues/302)) ([9183d7a](https://github.com/fgarofalo56/csa-inabox/commit/9183d7a3ebfd6778da52d9cd78ede43a9133e5d1))
* **csa-loom:** iter [#7](https://github.com/fgarofalo56/csa-inabox/issues/7) — Databricks NSG Network Intent Policy rules ([#305](https://github.com/fgarofalo56/csa-inabox/issues/305)) ([42535f2](https://github.com/fgarofalo56/csa-inabox/commit/42535f2d0a2eb62dcdc5e25b90e1a3c6d4974bb0))
* **csa-loom:** iter F — buildx-integrated login + MCP .NET 10 preview ([#315](https://github.com/fgarofalo56/csa-inabox/issues/315)) ([150d6b4](https://github.com/fgarofalo56/csa-inabox/commit/150d6b4647cdca97f707dac14f39d2f2244ed627))
* **csa-loom:** iter G — disable quarantine + Notary trust on ACR ([#316](https://github.com/fgarofalo56/csa-inabox/issues/316)) ([2a4e587](https://github.com/fgarofalo56/csa-inabox/commit/2a4e58772feec8df253a9d12a7cd68e461fe9405))
* **csa-loom:** iter H — MCP src/ path + Console Buffer cast ([#317](https://github.com/fgarofalo56/csa-inabox/issues/317)) ([f2d5182](https://github.com/fgarofalo56/csa-inabox/commit/f2d5182c861e99647f30acf79398d019d981b4b4))
* **csa-loom:** iter I — Console next.config skip TS/ESLint ([#319](https://github.com/fgarofalo56/csa-inabox/issues/319)) ([7bd939f](https://github.com/fgarofalo56/csa-inabox/commit/7bd939ff4c414c93bd3c53c55e2006399266e55a))
* **csa-loom:** iter J — Console public/ + v2 scope doc ([#320](https://github.com/fgarofalo56/csa-inabox/issues/320)) ([0c1a964](https://github.com/fgarofalo56/csa-inabox/commit/0c1a964bf740f4ce2db7476d4090720115e6fd42))
* **csa-loom:** jumpbox AAD-SSH only ([#324](https://github.com/fgarofalo56/csa-inabox/issues/324)) ([3ff8f9b](https://github.com/fgarofalo56/csa-inabox/commit/3ff8f9b82344679a5da04c59b4229028a6835196))
* **csa-loom:** provision iter [#2](https://github.com/fgarofalo56/csa-inabox/issues/2) — CIDR + ADX gate ([#299](https://github.com/fgarofalo56/csa-inabox/issues/299)) ([2c2aaf4](https://github.com/fgarofalo56/csa-inabox/commit/2c2aaf4b98239e0e0e964a969f89613b831c45c0))
* **csa-loom:** provision iter [#3](https://github.com/fgarofalo56/csa-inabox/issues/3) — remove broken diag-settings module call ([#300](https://github.com/fgarofalo56/csa-inabox/issues/300)) ([494c185](https://github.com/fgarofalo56/csa-inabox/commit/494c185a0f5dc67de758cf0637253fbd4bb94b21))
* **csa-loom:** provision iter [#4](https://github.com/fgarofalo56/csa-inabox/issues/4) — EH CG + storage versioning + Cosmos zonal ([#301](https://github.com/fgarofalo56/csa-inabox/issues/301)) ([6316ec5](https://github.com/fgarofalo56/csa-inabox/commit/6316ec5a4f218336055fee13bc6f30df1ce18d50))
* **csa-loom:** provision iter [#6](https://github.com/fgarofalo56/csa-inabox/issues/6) — synapse gates ([#304](https://github.com/fgarofalo56/csa-inabox/issues/304)) ([7547a90](https://github.com/fgarofalo56/csa-inabox/commit/7547a90009f2e968f8eef87feb755ac95d3a459b))
* **csa-loom:** provision iteration [#1](https://github.com/fgarofalo56/csa-inabox/issues/1) — KV principal + AI Search + container apps log config ([#297](https://github.com/fgarofalo56/csa-inabox/issues/297)) ([4655b64](https://github.com/fgarofalo56/csa-inabox/commit/4655b64c78dd1ba0fad39f16ff2cca6e4d5210b1))
* **csa-loom:** use ACR admin user for build push ([#313](https://github.com/fgarofalo56/csa-inabox/issues/313)) ([5709af2](https://github.com/fgarofalo56/csa-inabox/commit/5709af2b460114e748d9abf0e70678877ac1171f))


### Documentation

* **csa-loom:** deploy iteration log ([#303](https://github.com/fgarofalo56/csa-inabox/issues/303)) ([bfb7023](https://github.com/fgarofalo56/csa-inabox/commit/bfb70237f56bc67fda1b93937f0ab2bd5a35b30e))
* **csa-loom:** iteration log — ACR Tasks also blocked ([#307](https://github.com/fgarofalo56/csa-inabox/issues/307)) ([c0abefc](https://github.com/fgarofalo56/csa-inabox/commit/c0abefc4725337f892d771b77bc15d80dec0a517))
* **csa-loom:** live deploy status + UAT jumpbox Bicep ([#322](https://github.com/fgarofalo56/csa-inabox/issues/322)) ([37df4bd](https://github.com/fgarofalo56/csa-inabox/commit/37df4bd68ac8f31b710a47132b2684fc5ee7453c))
* **csa-loom:** portal architecture page ([#311](https://github.com/fgarofalo56/csa-inabox/issues/311)) ([7b0347f](https://github.com/fgarofalo56/csa-inabox/commit/7b0347f9947a41ac858ad1a5c651bd9839c56cb0))
* **csa-loom:** UAT report iter 1 + smoke test plumbing ([#325](https://github.com/fgarofalo56/csa-inabox/issues/325)) ([51c2b44](https://github.com/fgarofalo56/csa-inabox/commit/51c2b4438f35196cf75b201238afb8c9e72fb207))


### Miscellaneous

* **deps-dev:** Bump @types/node in /portal/react-webapp ([#271](https://github.com/fgarofalo56/csa-inabox/issues/271)) ([d592352](https://github.com/fgarofalo56/csa-inabox/commit/d592352e6f16942bda9511c23de0ad8af462affe))
* **deps-dev:** Bump ts-jest in /portal/react-webapp ([#274](https://github.com/fgarofalo56/csa-inabox/issues/274)) ([ff40d24](https://github.com/fgarofalo56/csa-inabox/commit/ff40d246123dfb218ad8880fd3093d4ab981abef))
* **deps-dev:** Update azure-mgmt-storage requirement ([#278](https://github.com/fgarofalo56/csa-inabox/issues/278)) ([1e6e41d](https://github.com/fgarofalo56/csa-inabox/commit/1e6e41d0de74a211a4c85fe73a3ddd28caef4a37))
* **deps:** Bump @azure/msal-browser in /portal/react-webapp ([#273](https://github.com/fgarofalo56/csa-inabox/issues/273)) ([9c84017](https://github.com/fgarofalo56/csa-inabox/commit/9c840175b4f76838259c9b53b4a36abcd674ca9b))
* **deps:** Bump @tanstack/react-query in /portal/react-webapp ([#275](https://github.com/fgarofalo56/csa-inabox/issues/275)) ([b133b10](https://github.com/fgarofalo56/csa-inabox/commit/b133b10483c6a569de4f4ac7d23510e11934209e))
* **deps:** Bump react-hook-form in /portal/react-webapp ([#277](https://github.com/fgarofalo56/csa-inabox/issues/277)) ([43dc5c8](https://github.com/fgarofalo56/csa-inabox/commit/43dc5c8e1804798cc85d237dfc23e07a13433c91))
* **session:** SESSION_KNOWLEDGE — UAT iter 1 outcome + follow-ups ([#326](https://github.com/fgarofalo56/csa-inabox/issues/326)) ([2c45c59](https://github.com/fgarofalo56/csa-inabox/commit/2c45c59e2a8b4257ce80373bde8d2a7a9d4dcc08))

## [0.7.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.9...csa-inabox-v0.7.0) (2026-05-21)


### Features

* **copilot:** MS Learn MCP fallback grounding live in chat Function (Phase 2) ([#264](https://github.com/fgarofalo56/csa-inabox/issues/264)) ([3b6c00d](https://github.com/fgarofalo56/csa-inabox/commit/3b6c00de264fce420021a3cbee58574246f1d703))
* **copilot:** MS Learn MCP search tool for external grounding (Phase 1) ([#261](https://github.com/fgarofalo56/csa-inabox/issues/261)) ([9c4991d](https://github.com/fgarofalo56/csa-inabox/commit/9c4991d0f8deb07e1f4b5953abcc9a5ee1f32178))
* **docs:** hero spans full grid width above sidebars + site brand rename ([#263](https://github.com/fgarofalo56/csa-inabox/issues/263)) ([6d1b5a8](https://github.com/fgarofalo56/csa-inabox/commit/6d1b5a85846bca6992162b7e7fbed48244016214))
* **docs:** redesigned homepage hero + spell-out H1 ([#259](https://github.com/fgarofalo56/csa-inabox/issues/259)) ([2f1b79c](https://github.com/fgarofalo56/csa-inabox/commit/2f1b79c78f5e8392526d315b0af43ae13b313705))


### Bug Fixes

* **docs:** hero banners above H1, fix Mermaid dark-mode readability ([#258](https://github.com/fgarofalo56/csa-inabox/issues/258)) ([c414ca4](https://github.com/fgarofalo56/csa-inabox/commit/c414ca4bcde16f9c6f2555f51aecb47acd5af6be))
* **docs:** hero images 404 on nested pages — resolve src + prepend base_url ([#265](https://github.com/fgarofalo56/csa-inabox/issues/265)) ([9661c88](https://github.com/fgarofalo56/csa-inabox/commit/9661c8887535531f797a0459ac28392b07c22be3))
* **docs:** un-ignore docs/learn/examples/architecture-patterns/batch/data/ ([#257](https://github.com/fgarofalo56/csa-inabox/issues/257)) ([20559cf](https://github.com/fgarofalo56/csa-inabox/commit/20559cf4802f2618c6e11b2a598184749f66f994))


### Code Refactoring

* **nav:** redistribute Additional Content (auto-indexed) into main categories ([#260](https://github.com/fgarofalo56/csa-inabox/issues/260)) ([8c0306e](https://github.com/fgarofalo56/csa-inabox/commit/8c0306e4ced034981db1f9c9efb86c9886e07d3c))


### Documentation

* visual redesign + nav cleanup (58 hero SVGs, A-grade audit) ([#255](https://github.com/fgarofalo56/csa-inabox/issues/255)) ([c15da9d](https://github.com/fgarofalo56/csa-inabox/commit/c15da9d359e29bb07fb8457110717ebeb60aa686))

## [0.6.9](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.8...csa-inabox-v0.6.9) (2026-05-18)


### Miscellaneous

* **deps-dev:** Bump @types/node from 25.6.2 to 25.9.0 in /portal/react-webapp ([#234](https://github.com/fgarofalo56/csa-inabox/issues/234)) ([ef5667f](https://github.com/fgarofalo56/csa-inabox/commit/ef5667fa599fafe3d1c1e58b37a987adddb6e9ee))
* **deps:** Bump @azure/msal-browser from 5.10.0 to 5.10.1 in /portal/react-webapp ([#232](https://github.com/fgarofalo56/csa-inabox/issues/232)) ([dded8ea](https://github.com/fgarofalo56/csa-inabox/commit/dded8eae54c2f95254bc73b10b3b1aed5232497c))
* **deps:** Bump @azure/msal-react from 5.4.0 to 5.4.1 in /portal/react-webapp ([#238](https://github.com/fgarofalo56/csa-inabox/issues/238)) ([ff0a5a4](https://github.com/fgarofalo56/csa-inabox/commit/ff0a5a42923a755969fb298346037a2c7c972682))
* **deps:** Bump @tanstack/react-query from 5.100.9 to 5.100.10 in /portal/react-webapp ([#236](https://github.com/fgarofalo56/csa-inabox/issues/236)) ([10210da](https://github.com/fgarofalo56/csa-inabox/commit/10210da80b1c5d8b18ad1caf9e6c94b0a506bad8))
* **deps:** Bump axios from 1.16.0 to 1.16.1 in /portal/react-webapp ([#233](https://github.com/fgarofalo56/csa-inabox/issues/233)) ([9134fbb](https://github.com/fgarofalo56/csa-inabox/commit/9134fbbc2437eb0ab6d3aa9472119e029dc13c4a))
* **deps:** Bump tailwind-merge from 3.5.0 to 3.6.0 in /portal/react-webapp ([#237](https://github.com/fgarofalo56/csa-inabox/issues/237)) ([2a41507](https://github.com/fgarofalo56/csa-inabox/commit/2a41507e643dd5194816caefd1d0be63b0411747))

## [0.6.8](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.7...csa-inabox-v0.6.8) (2026-05-18)


### Bug Fixes

* **docs-hook:** rewrite_example_links treats standalone docs/examples/*.md correctly ([#243](https://github.com/fgarofalo56/csa-inabox/issues/243)) ([56a809a](https://github.com/fgarofalo56/csa-inabox/commit/56a809a7db25d87101c9484df12c0e9a9a94a8f1))
* **docs:** correct ADR cross-link from 0023 to 0025 ([#240](https://github.com/fgarofalo56/csa-inabox/issues/240)) ([d2f57b7](https://github.com/fgarofalo56/csa-inabox/commit/d2f57b721fa467e6423f9a6f3b984086fe4d4142))
* **docs:** make Mermaid diagrams clickable for pan/zoom ([#231](https://github.com/fgarofalo56/csa-inabox/issues/231)) ([507bf7a](https://github.com/fgarofalo56/csa-inabox/commit/507bf7a1158d5e88fcb265705cdcefa9b9f2f1d8))


### Documentation

* add click-to-zoom + pan for images and Mermaid diagrams ([#230](https://github.com/fgarofalo56/csa-inabox/issues/230)) ([1736b9a](https://github.com/fgarofalo56/csa-inabox/commit/1736b9a4844aa76e73355c20f0c29b0443cefba1))
* API-First Data Strategy pillar (APIM, Dataverse, MuleSoft + AWS takedowns) ([#239](https://github.com/fgarofalo56/csa-inabox/issues/239)) ([fe3a5d7](https://github.com/fgarofalo56/csa-inabox/commit/fe3a5d7c7e877ed8056d9b615fabf8a412683b90))
* **bus-factor:** convert 5 tribal-knowledge topics from SUCCESSION §4 to durable docs ([#252](https://github.com/fgarofalo56/csa-inabox/issues/252)) ([f184ce0](https://github.com/fgarofalo56/csa-inabox/commit/f184ce0e6fabf60d53c6000a3ce7c6bccb2a1f5a))
* **examples:** add NASA API-first end-to-end deployment example ([#242](https://github.com/fgarofalo56/csa-inabox/issues/242)) ([bdaac11](https://github.com/fgarofalo56/csa-inabox/commit/bdaac11492e0571b2b87096b9e3b79d5efab8c98))
* full pillar voice scrub + NASA example in matched federal-agency style ([#245](https://github.com/fgarofalo56/csa-inabox/issues/245)) ([d0d5e2d](https://github.com/fgarofalo56/csa-inabox/commit/d0d5e2d351d3f6540250d724ab38922a18ac0a65))
* NASA API-first end-to-end implementation guide ([#241](https://github.com/fgarofalo56/csa-inabox/issues/241)) ([ea2561f](https://github.com/fgarofalo56/csa-inabox/commit/ea2561f26c379be5ba8f8634c76d36fd57bf6acc))
* rewrite API-First pillar in neutral CDO voice, remove customer-named framing ([#244](https://github.com/fgarofalo56/csa-inabox/issues/244)) ([7c7db20](https://github.com/fgarofalo56/csa-inabox/commit/7c7db20a468a331b2af840dcbb396b914aacc2f6))


### Miscellaneous

* add bus-factor succession plan + CODEOWNERS scaffolding ([#247](https://github.com/fgarofalo56/csa-inabox/issues/247)) ([43a743d](https://github.com/fgarofalo56/csa-inabox/commit/43a743d8f291b714d48dd58554e604e1acad191a))
* **bicep:** ratchet apiVersion across 38 modules to current GAs ([#248](https://github.com/fgarofalo56/csa-inabox/issues/248)) ([d7ef4ef](https://github.com/fgarofalo56/csa-inabox/commit/d7ef4ef0ec8f97d8a4934b3c6afbec2302594359))
* **coverage:** ratchet fail_under threshold 60 -&gt; 65 ([#249](https://github.com/fgarofalo56/csa-inabox/issues/249)) ([15b84bd](https://github.com/fgarofalo56/csa-inabox/commit/15b84bd9ed7966810bd24dfbfdd9de5a6de3cdf5))
* **devcontainer:** add Codespaces + VS Code Dev Container config ([#250](https://github.com/fgarofalo56/csa-inabox/issues/250)) ([4183e00](https://github.com/fgarofalo56/csa-inabox/commit/4183e00cb6da7d375fb315003b50753c6432d90c))
* **hygiene+community:** CI guard against root strays + CoC + MAINTAINERS ([#253](https://github.com/fgarofalo56/csa-inabox/issues/253)) ([fc69dda](https://github.com/fgarofalo56/csa-inabox/commit/fc69dda6acdc4ecf524c34e16440509d69807742))
* **hygiene:** delete stray root PNG + ratchet .gitignore for root-level images ([#251](https://github.com/fgarofalo56/csa-inabox/issues/251)) ([23d4c23](https://github.com/fgarofalo56/csa-inabox/commit/23d4c23e18169fcfea99a5d2b912a3d651386e9b))
* migrate off Archon v1 (rules + task ledger) ([#228](https://github.com/fgarofalo56/csa-inabox/issues/228)) ([51bc5e5](https://github.com/fgarofalo56/csa-inabox/commit/51bc5e560a1681dd4521e25a842a345c80bf7289))

## [0.6.7](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.6...csa-inabox-v0.6.7) (2026-05-11)


### Tests

* enable per-package test discovery + fix 3 latent bugs it surfaced ([#226](https://github.com/fgarofalo56/csa-inabox/issues/226)) ([56b482e](https://github.com/fgarofalo56/csa-inabox/commit/56b482e5692c389881f2be3081da5824169e489f))

## [0.6.6](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.5...csa-inabox-v0.6.6) (2026-05-10)


### Documentation

* add /guides/ &lt;-&gt; /learn/ cross-link admonitions + fix tutorial dir-style links ([#223](https://github.com/fgarofalo56/csa-inabox/issues/223)) ([d21ef95](https://github.com/fgarofalo56/csa-inabox/commit/d21ef954e87c275533b0d5e934213e074344d4b9))

## [0.6.5](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.4...csa-inabox-v0.6.5) (2026-05-10)


### Bug Fixes

* **checkov:** suppress CKV_AZURE_104 globally — same parser bug as CKV_AZURE_95 ([#221](https://github.com/fgarofalo56/csa-inabox/issues/221)) ([e04b66d](https://github.com/fgarofalo56/csa-inabox/commit/e04b66db7a5da9c1febe52e8ae6ee62061a9481c))

## [0.6.4](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.3...csa-inabox-v0.6.4) (2026-05-10)


### Documentation

* **learn:** beautify imported reference library ([#218](https://github.com/fgarofalo56/csa-inabox/issues/218)) ([db58c24](https://github.com/fgarofalo56/csa-inabox/commit/db58c24d132c84a918aeb2ce88775fe6f7be82b6))
* **learn:** fix 1160 inherited broken links + re-enable mkdocs --strict ([#220](https://github.com/fgarofalo56/csa-inabox/issues/220)) ([4801471](https://github.com/fgarofalo56/csa-inabox/commit/4801471050667348a1bd57d2915914490acf2221))

## [0.6.3](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.2...csa-inabox-v0.6.3) (2026-05-10)


### Documentation

* **learn:** import remaining csa-inabox-docs content (round 2) ([#216](https://github.com/fgarofalo56/csa-inabox/issues/216)) ([f0c03c1](https://github.com/fgarofalo56/csa-inabox/commit/f0c03c18c5ddcb842a05730e9b46480aa7c237da))

## [0.6.2](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.1...csa-inabox-v0.6.2) (2026-05-10)


### Documentation

* **learn:** import comprehensive Azure analytics reference library ([#215](https://github.com/fgarofalo56/csa-inabox/issues/215)) ([b1933f6](https://github.com/fgarofalo56/csa-inabox/commit/b1933f6062f3f62e744289c53af870bb94383602))


### Miscellaneous

* **deps-dev:** Bump @types/node in /portal/react-webapp ([#210](https://github.com/fgarofalo56/csa-inabox/issues/210)) ([8f0ee49](https://github.com/fgarofalo56/csa-inabox/commit/8f0ee4915b7a9a7e2a8bfb85e6980871fab5cdfc))
* **deps-dev:** Bump jest-environment-jsdom in /portal/react-webapp ([#208](https://github.com/fgarofalo56/csa-inabox/issues/208)) ([b085c6a](https://github.com/fgarofalo56/csa-inabox/commit/b085c6a154f6d9eefb57848023f7f8ce0683ee12))
* **deps-dev:** Update cryptography requirement ([#213](https://github.com/fgarofalo56/csa-inabox/issues/213)) ([d627d72](https://github.com/fgarofalo56/csa-inabox/commit/d627d72a4228605b4d311cb522ddf469d20509e6))
* **deps-dev:** Update mypy requirement ([#212](https://github.com/fgarofalo56/csa-inabox/issues/212)) ([a7e6987](https://github.com/fgarofalo56/csa-inabox/commit/a7e6987500677416bbb7f53dc3525cc283902f5f))
* **deps:** Bump axios from 1.15.2 to 1.16.0 in /portal/react-webapp ([#205](https://github.com/fgarofalo56/csa-inabox/issues/205)) ([e80d0a7](https://github.com/fgarofalo56/csa-inabox/commit/e80d0a77fa46e99af0d4ce6ee33fe3028049b16b))
* **deps:** Bump next from 16.2.4 to 16.2.6 in /portal/react-webapp ([#207](https://github.com/fgarofalo56/csa-inabox/issues/207)) ([fc7bf90](https://github.com/fgarofalo56/csa-inabox/commit/fc7bf908c31a6278ec6a3ce105c2c62560624ef1))

## [0.6.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.6.0...csa-inabox-v0.6.1) (2026-05-08)


### Bug Fixes

* **checkov:** suppress 4 parser-bug + scenario-misfire findings globally ([#203](https://github.com/fgarofalo56/csa-inabox/issues/203)) ([a34f313](https://github.com/fgarofalo56/csa-inabox/commit/a34f31314185e0ef27741d9b6d7f4b13b77580ee))
* **docs:** register azurecli as a Pygments alias for bash ([#204](https://github.com/fgarofalo56/csa-inabox/issues/204)) ([3ea1441](https://github.com/fgarofalo56/csa-inabox/commit/3ea1441caf849df09cb8c14be296d34dcbc73705))
* **security+docs:** clear all 4 deferred alerts + Cloud Shell button selector ([#201](https://github.com/fgarofalo56/csa-inabox/issues/201)) ([57f504a](https://github.com/fgarofalo56/csa-inabox/commit/57f504adcb278b3619243a4966321693309603c8))

## [0.6.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.9...csa-inabox-v0.6.0) (2026-05-08)


### Features

* **docs:** build out 4 roadmap items — Fabric-Gov, LLM safety, CSA-vs-Fabric, Cloud Shell runner ([#196](https://github.com/fgarofalo56/csa-inabox/issues/196)) ([eda2e6f](https://github.com/fgarofalo56/csa-inabox/commit/eda2e6fb91ed1c2dabe06231b8dec77a7a11e312)), closes [#165](https://github.com/fgarofalo56/csa-inabox/issues/165) [#167](https://github.com/fgarofalo56/csa-inabox/issues/167) [#177](https://github.com/fgarofalo56/csa-inabox/issues/177) [#178](https://github.com/fgarofalo56/csa-inabox/issues/178)


### Bug Fixes

* **ci:** re-post required checks on every open release PR ([#200](https://github.com/fgarofalo56/csa-inabox/issues/200)) ([459b2b3](https://github.com/fgarofalo56/csa-inabox/commit/459b2b3f2306e3ca70d0c981fd98ee4778a7f080))
* **security:** address GitHub Code/Secret-scanning alerts (CRITICAL + 5 HIGH + 8 MEDIUM) ([#198](https://github.com/fgarofalo56/csa-inabox/issues/198)) ([4192e0e](https://github.com/fgarofalo56/csa-inabox/commit/4192e0e905ce0daf31272eafea74aad1c0e01800))
* **security:** rewrite safe_for_log with re.sub so CodeQL recognises it ([#199](https://github.com/fgarofalo56/csa-inabox/issues/199)) ([0f0de4c](https://github.com/fgarofalo56/csa-inabox/commit/0f0de4c830b87c5c5ee015bc86d68d492cd54e5a))

## [0.5.9](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.8...csa-inabox-v0.5.9) (2026-05-08)


### Miscellaneous

* **deps:** Bump react-hook-form in /portal/react-webapp ([#142](https://github.com/fgarofalo56/csa-inabox/issues/142)) ([8ee9bb2](https://github.com/fgarofalo56/csa-inabox/commit/8ee9bb2a8f0417dcedd1023ca25386f86abbea9d))

## [0.5.8](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.7...csa-inabox-v0.5.8) (2026-05-08)


### Miscellaneous

* **deps:** Bump googleapis/release-please-action from 4.4.1 to 5.0.0 ([#137](https://github.com/fgarofalo56/csa-inabox/issues/137)) ([f37be9f](https://github.com/fgarofalo56/csa-inabox/commit/f37be9fe68922d8a84f07c2815c775c292e48bcf))

## [0.5.7](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.6...csa-inabox-v0.5.7) (2026-05-08)


### Miscellaneous

* **deps:** Bump @tanstack/react-query in /portal/react-webapp ([#141](https://github.com/fgarofalo56/csa-inabox/issues/141)) ([6e96352](https://github.com/fgarofalo56/csa-inabox/commit/6e96352459dbb0b22ab69624adfce57e1d5b85a8))

## [0.5.6](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.5...csa-inabox-v0.5.6) (2026-05-08)


### Miscellaneous

* **deps:** Bump anchore/sbom-action from 0.18.0 to 0.24.0 ([#136](https://github.com/fgarofalo56/csa-inabox/issues/136)) ([9152804](https://github.com/fgarofalo56/csa-inabox/commit/915280470adf02704d017a1c322d1c2b867378fb))

## [0.5.5](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.4...csa-inabox-v0.5.5) (2026-05-08)


### Miscellaneous

* **deps:** Bump @azure/msal-react in /portal/react-webapp ([#140](https://github.com/fgarofalo56/csa-inabox/issues/140)) ([2f9f27d](https://github.com/fgarofalo56/csa-inabox/commit/2f9f27d0648488d5a223217a3cf507cbfef723ef))

## [0.5.4](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.3...csa-inabox-v0.5.4) (2026-05-08)


### Miscellaneous

* **deps:** Bump github/codeql-action from 4.35.2 to 4.35.3 ([#144](https://github.com/fgarofalo56/csa-inabox/issues/144)) ([6e0ead9](https://github.com/fgarofalo56/csa-inabox/commit/6e0ead9554ac1d4d3277d3e08e6fda95b5c29c73))

## [0.5.3](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.2...csa-inabox-v0.5.3) (2026-05-08)


### Miscellaneous

* **deps:** Bump actions/upload-pages-artifact from 3.0.1 to 5.0.0 ([#146](https://github.com/fgarofalo56/csa-inabox/issues/146)) ([cfdb0de](https://github.com/fgarofalo56/csa-inabox/commit/cfdb0def2f63530b8b6c9b267608b22ac3ef1fcb))
* **deps:** Bump zod from 4.3.6 to 4.4.3 in /portal/react-webapp ([#139](https://github.com/fgarofalo56/csa-inabox/issues/139)) ([88dcebe](https://github.com/fgarofalo56/csa-inabox/commit/88dcebed292d80a97e621bb5095f6c5d5b26629a))

## [0.5.2](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.1...csa-inabox-v0.5.2) (2026-05-08)


### Miscellaneous

* **deps:** Bump actions/setup-python from 5.6.0 to 6.2.0 ([#147](https://github.com/fgarofalo56/csa-inabox/issues/147)) ([01bf19a](https://github.com/fgarofalo56/csa-inabox/commit/01bf19aacf5fe608fe341dcf22c4a7f28cf58904))

## [0.5.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.5.0...csa-inabox-v0.5.1) (2026-05-08)


### Miscellaneous

* **deps-dev:** Update azure-search-documents requirement ([#145](https://github.com/fgarofalo56/csa-inabox/issues/145)) ([16196e9](https://github.com/fgarofalo56/csa-inabox/commit/16196e9af6b13d80fe9a524e63a0ec3890649e83))

## [0.5.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.4.0...csa-inabox-v0.5.0) (2026-05-07)


### Features

* **ci:** auto-create PR from Claude's auto-fix branch ([#186](https://github.com/fgarofalo56/csa-inabox/issues/186)) ([5ee5a40](https://github.com/fgarofalo56/csa-inabox/commit/5ee5a404bbbff57fc0bbfe50b84776911a776d7d))
* **ci:** prefer Claude Max OAuth token for the auto-fix workflow ([#161](https://github.com/fgarofalo56/csa-inabox/issues/161)) ([7560c42](https://github.com/fgarofalo56/csa-inabox/commit/7560c428ba1fdb672d4a810a547305233210376f))
* **copilot+audit:** SEC-COPILOT H-3/H-5 + deploy workflow + 9 audit cleanups ([#156](https://github.com/fgarofalo56/csa-inabox/issues/156)) ([5b02242](https://github.com/fgarofalo56/csa-inabox/commit/5b022420756893b217447551e23ed3d8696014d2))
* **copilot+sec:** topic classification + autonomy guardrails ([#169](https://github.com/fgarofalo56/csa-inabox/issues/169)) ([5715913](https://github.com/fgarofalo56/csa-inabox/commit/57159134298262f28b00ae74442a685aa3101c09))
* **copilot:** chat analytics + feedback + autonomous bug-fix flow ([#153](https://github.com/fgarofalo56/csa-inabox/issues/153)) ([495919a](https://github.com/fgarofalo56/csa-inabox/commit/495919a330636465e2ee2b92d460afcccb75eb83))
* **copilot:** page analytics + analytics runbook + flush-on-emit fix ([#162](https://github.com/fgarofalo56/csa-inabox/issues/162)) ([e73ff19](https://github.com/fgarofalo56/csa-inabox/commit/e73ff19173da17cc865d7dc0a2ef09bcbd8fbee3))
* **copilot:** polish responses + inline citations + frontend-side RAG grounding ([#150](https://github.com/fgarofalo56/csa-inabox/issues/150)) ([aba0225](https://github.com/fgarofalo56/csa-inabox/commit/aba0225b7e6509f98bdbbae5f81fe0468552618f))


### Bug Fixes

* **ci:** add id-token: write permission for claude-code-action ([#182](https://github.com/fgarofalo56/csa-inabox/issues/182)) ([d03791c](https://github.com/fgarofalo56/csa-inabox/commit/d03791cc75603374f3a30780caead118a4f3de8b))
* **ci:** claude-code-action input is direct_prompt not prompt ([#181](https://github.com/fgarofalo56/csa-inabox/issues/181)) ([b4e66a3](https://github.com/fgarofalo56/csa-inabox/commit/b4e66a312682237e5c1c6d97b0d5f423e64025b9))
* **ci:** install function deps for test step in deploy workflow ([#157](https://github.com/fgarofalo56/csa-inabox/issues/157)) ([2f7f084](https://github.com/fgarofalo56/csa-inabox/commit/2f7f08473c83de3ead2f23c02d09fa7c2d2bb8f7))
* **ci:** sanitizer false-positive on markdown inline code ([#180](https://github.com/fgarofalo56/csa-inabox/issues/180)) ([89b6b13](https://github.com/fgarofalo56/csa-inabox/commit/89b6b13bb1757e1048b27e67d8477b1a127195de))
* **ci:** set label_trigger=auto-fix on claude-code-action ([#183](https://github.com/fgarofalo56/csa-inabox/issues/183)) ([d6e1e10](https://github.com/fgarofalo56/csa-inabox/commit/d6e1e105dae17d3b91d202fb3be707e8e675f193))
* **ci:** use mode=tag (default) so label_trigger is honored ([#184](https://github.com/fgarofalo56/csa-inabox/issues/184)) ([6daaf8e](https://github.com/fgarofalo56/csa-inabox/commit/6daaf8e9b7956c0292eef226121e4c25b20fd80a))
* **copilot:** repair function 500 + tighten search relevance + auto-deploy workflow ([#151](https://github.com/fgarofalo56/csa-inabox/issues/151)) ([2273bfb](https://github.com/fgarofalo56/csa-inabox/commit/2273bfbd8a2e4ac0a62ea43abe5c815190037218))
* update copilot-privacy.md date to reflect PR [#169](https://github.com/fgarofalo56/csa-inabox/issues/169) changes (auto-fix [#179](https://github.com/fgarofalo56/csa-inabox/issues/179)) ([#185](https://github.com/fgarofalo56/csa-inabox/issues/185)) ([6d8c975](https://github.com/fgarofalo56/csa-inabox/commit/6d8c975364e74f397f77abf6a0a2a30c13434a4e))


### Documentation

* add Supercharge Microsoft Fabric cross-references + link-check workflow ([#152](https://github.com/fgarofalo56/csa-inabox/issues/152)) ([c966845](https://github.com/fgarofalo56/csa-inabox/commit/c966845ba6ff5a95e9492716a190a53925d797df))
* simplechat-style polish + real Azure portal screenshots ([#148](https://github.com/fgarofalo56/csa-inabox/issues/148)) ([faad54c](https://github.com/fgarofalo56/csa-inabox/commit/faad54c908eef5ba10a07f859fc2af41ca2d2a62))

## [0.4.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.3.1...csa-inabox-v0.4.0) (2026-05-01)


### Features

* **docs:** add 14 Azure service guides, 2 migration paths, and hierarchical nav ([#125](https://github.com/fgarofalo56/csa-inabox/issues/125)) ([d915939](https://github.com/fgarofalo56/csa-inabox/commit/d915939f019cc589838a91afbc994968fe4b367e))
* **docs:** add 20 comprehensive migration packages with 300+ guides ([#132](https://github.com/fgarofalo56/csa-inabox/issues/132)) ([06fe293](https://github.com/fgarofalo56/csa-inabox/commit/06fe293264f2cb03da2593e56df4436f81762e10))
* **docs:** add comprehensive Palantir Foundry to Azure migration package ([#130](https://github.com/fgarofalo56/csa-inabox/issues/130)) ([36fec9a](https://github.com/fgarofalo56/csa-inabox/commit/36fec9a77e38d9224ef7607504af043e69a4bf73))
* **docs:** comprehensive enhancement — 50+ docs across architecture, examples, runbooks, compliance, tutorials, research ([#133](https://github.com/fgarofalo56/csa-inabox/issues/133)) ([ee67bc3](https://github.com/fgarofalo56/csa-inabox/commit/ee67bc351a72c41f26c4b877f85690b31cb94557))
* **docs:** expand all 10 migration paths to comprehensive packages ([#131](https://github.com/fgarofalo56/csa-inabox/issues/131)) ([07e0a96](https://github.com/fgarofalo56/csa-inabox/commit/07e0a96644ed57abf540477ff0984f47f6baff99))
* **docs:** rewrite GitHub Pages homepage with full platform overview ([#128](https://github.com/fgarofalo56/csa-inabox/issues/128)) ([96e66a3](https://github.com/fgarofalo56/csa-inabox/commit/96e66a3a5fd3385fd331ac946406cba47994572d))


### Bug Fixes

* **docs:** enable collapsible sidebar sections for better navigation ([#129](https://github.com/fgarofalo56/csa-inabox/issues/129)) ([e181584](https://github.com/fgarofalo56/csa-inabox/commit/e181584b04bbcaf31744d45dca6e0bf50d305126))
* **use-cases:** repair 2 broken external source links ([#135](https://github.com/fgarofalo56/csa-inabox/issues/135)) ([88c2900](https://github.com/fgarofalo56/csa-inabox/commit/88c2900cadd6453d2879cd00f7a2738aca9ed1b5))


### Documentation

* **migrations:** organize 31 migrations into Analytics vs Enterprise groups ([#134](https://github.com/fgarofalo56/csa-inabox/issues/134)) ([f502bf4](https://github.com/fgarofalo56/csa-inabox/commit/f502bf4413e8efa796e71e83c635be61fdcb2c7e))

## [0.3.1](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.3.0...csa-inabox-v0.3.1) (2026-04-27)


### Bug Fixes

* **dbt:** also delete domains/shared/dbt/package-lock.yml + simplify ignore ([#123](https://github.com/fgarofalo56/csa-inabox/issues/123)) ([8c0e9ad](https://github.com/fgarofalo56/csa-inabox/commit/8c0e9ad1b047bde3a66ccdc6b72053a13ef9a804))
* **dbt:** gitignore package-lock.yml — schema differs across dbt versions ([#122](https://github.com/fgarofalo56/csa-inabox/issues/122)) ([acddabf](https://github.com/fgarofalo56/csa-inabox/commit/acddabf94a8523c44860d73fbaa55eb64810a55d))
* **release-please:** auto-pass required checks on bot-created release PRs ([#124](https://github.com/fgarofalo56/csa-inabox/issues/124)) ([6c2b7dd](https://github.com/fgarofalo56/csa-inabox/commit/6c2b7dded0b1df8ee5888472c9c89de9c04bc9b1))


### Miscellaneous

* **security:** clear all 4 open security alerts + fix red dbt-ci ([#120](https://github.com/fgarofalo56/csa-inabox/issues/120)) ([9016763](https://github.com/fgarofalo56/csa-inabox/commit/9016763fe6996308bfd86190a43adfe614aab00c))

## [0.3.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.2.0...csa-inabox-v0.3.0) (2026-04-27)


### Features

* **ai-agents:** real impl — IaC + 3 contracts + 62-test eval suite (PR-C) ([#112](https://github.com/fgarofalo56/csa-inabox/issues/112)) ([c13c1c8](https://github.com/fgarofalo56/csa-inabox/commit/c13c1c80bfb393df12326bbeee57a5c3565302ff))
* **bicep:** add aifoundry.bicep + azureml.bicep shared modules (PR-D) ([#115](https://github.com/fgarofalo56/csa-inabox/issues/115)) ([63a9874](https://github.com/fgarofalo56/csa-inabox/commit/63a98749a51d0789a3cee04a6dffa454f5b21dbc))
* **copilot-evals:** expand goldens 37 → 75 + run all 3 sets in CI (PR-E) ([#116](https://github.com/fgarofalo56/csa-inabox/issues/116)) ([3504a06](https://github.com/fgarofalo56/csa-inabox/commit/3504a0668e787240926abf45065c385236994cf2))
* **fabric-e2e:** real end-to-end Fabric example with TMDL semantic model (PR-F) ([#117](https://github.com/fgarofalo56/csa-inabox/issues/117)) ([9592ae0](https://github.com/fgarofalo56/csa-inabox/commit/9592ae00072e184340b4066561c48c26e14fef79))


### Documentation

* collapse 15 flat tabs into 6 grouped + fill 34 missing/stub pages ([#110](https://github.com/fgarofalo56/csa-inabox/issues/110)) ([fd2113c](https://github.com/fgarofalo56/csa-inabox/commit/fd2113ca03bc8c085012dee570eff5051ddf5e94))
* **nav:** expose all 11 tutorials + 16 e2e example READMEs in Pages nav ([#109](https://github.com/fgarofalo56/csa-inabox/issues/109)) ([2fad3c8](https://github.com/fgarofalo56/csa-inabox/commit/2fad3c8c8c61075d4f08da033ff58024a17e1511))


### Miscellaneous

* **copilot-chat:** point widget at func-csa-inabox-copilot-fg in FedCiv DLZ + add DEPLOYMENT.md provenance ([#108](https://github.com/fgarofalo56/csa-inabox/issues/108)) ([72aa1ad](https://github.com/fgarofalo56/csa-inabox/commit/72aa1adcaf8e8917812c9751d74ea64c989d3a85))
* **deps:** bump @azure/msal-browser ^5.7.0 -&gt; ^5.8.0 (closes [#95](https://github.com/fgarofalo56/csa-inabox/issues/95)) ([#106](https://github.com/fgarofalo56/csa-inabox/issues/106)) ([37ff153](https://github.com/fgarofalo56/csa-inabox/commit/37ff153de8d77c3d72642d4c8ab5a55298d81767))
* **ai-agents:** bump pytest 8.3.4 → 9.0.3 + pytest-asyncio 0.24.0 → 1.3.0 ([#118](https://github.com/fgarofalo56/csa-inabox/issues/118)) ([03482ac](https://github.com/fgarofalo56/csa-inabox/commit/03482ac))
* **deps:** Bump semantic-kernel in /examples/ai-agents ([#114](https://github.com/fgarofalo56/csa-inabox/issues/114)) ([f50d9cc](https://github.com/fgarofalo56/csa-inabox/commit/f50d9cce2f10a3756571d9dc0aa37e3e197ec902))
* **docs:** zero-warning mkdocs build + SECURITY/SUPPORT/CODEOWNERS + strict gates ([#111](https://github.com/fgarofalo56/csa-inabox/issues/111)) ([f30379e](https://github.com/fgarofalo56/csa-inabox/commit/f30379e257b096e04f2141ad78157e5c115c4155))

## [0.2.0](https://github.com/fgarofalo56/csa-inabox/compare/csa-inabox-v0.1.0...csa-inabox-v0.2.0) (2026-04-26)


### ⚠ BREAKING CHANGES

* restructure repo for monorepo split, rename platform dirs ([#37](https://github.com/fgarofalo56/csa-inabox/issues/37))

### Features

* add inventory domain, production checklist, and CI/CD expansion ([da8e2b4](https://github.com/fgarofalo56/csa-inabox/commit/da8e2b4efcd1999b1bf9428fccd0f402c10711e8))
* add page search references and dark mode to chat widget ([#79](https://github.com/fgarofalo56/csa-inabox/issues/79)) ([694f641](https://github.com/fgarofalo56/csa-inabox/commit/694f641d04ace54bdbd030d03ba65206e0a2c5d9))
* close remaining audit gaps — contracts, tests, notebooks, seeds ([b1e186d](https://github.com/fgarofalo56/csa-inabox/commit/b1e186dc0e828f5d7bf21d9547cccf64db1acb4f))
* complete all verticals, portals, platform services, and documentation to 100% ([1e8fdca](https://github.com/fgarofalo56/csa-inabox/commit/1e8fdca688efa57c0a70408658a38a0632b17df2))
* complete audit remediation — platform tests, IaC hardening, CI fixes, and DX improvements ([6e787fb](https://github.com/fgarofalo56/csa-inabox/commit/6e787fb3f843053727bce97fe1fda6244d14310f))
* complete data platform — seed data, dbt models, ADF pipelines, finance domain, streaming, notebooks ([3342739](https://github.com/fgarofalo56/csa-inabox/commit/33427398d7a3080543747106dba02cf86eb4e36d))
* CSA Platform Expansion — Waves 1-3 ([#83](https://github.com/fgarofalo56/csa-inabox/issues/83)) ([948791e](https://github.com/fgarofalo56/csa-inabox/commit/948791eb5014640946452e91425b42b490e1e09a))
* **data-quality:** wire up Great Expectations checkpoint runner ([e0c1da9](https://github.com/fgarofalo56/csa-inabox/commit/e0c1da959e1aae229d0e35035fa9ed01688ca5c7))
* DOJ Antitrust domain, use cases docs, chat widget border, and dep fixes ([#86](https://github.com/fgarofalo56/csa-inabox/issues/86)) ([a627d47](https://github.com/fgarofalo56/csa-inabox/commit/a627d473b403f928de39a45ec00579ebb830e172))
* domain data products, dbt snapshots/exposures, ADF triggers, analyses dirs, notebooks ([cd9415c](https://github.com/fgarofalo56/csa-inabox/commit/cd9415c9e556f7b0cd9d7a36665abe8cf7082c21))
* Fabric-in-a-Box — complete data platform with 9 verticals, 4 portals, Gov deployment, and platform services ([070ae01](https://github.com/fgarofalo56/csa-inabox/commit/070ae0178cd62a7dc2b15c000e3e50d4dd80272c))
* governance framework, GE checkpoints, Purview lineage, ADF deploy, async Functions, structured logging ([47ac84f](https://github.com/fgarofalo56/csa-inabox/commit/47ac84f180c66e907e23060df0ce9d6dd0f09ad8))
* **logging:** structured JSON logging with trace IDs across services ([5487848](https://github.com/fgarofalo56/csa-inabox/commit/54878489b1781e0b6e914329f62fe5720d14ef96))
* make chat widget resizable via drag handle ([#81](https://github.com/fgarofalo56/csa-inabox/issues/81)) ([e6af57a](https://github.com/fgarofalo56/csa-inabox/commit/e6af57a057159a1ef3462f3906bc9c95af5a4d71))


### Bug Fixes

* **ci,build:** comprehensive audit remediation — SHA-pin actions, fix paths, type safety, and structural gaps ([f6e9320](https://github.com/fgarofalo56/csa-inabox/commit/f6e932062dbe689ba2eb3481e639e2d28deb7a21))
* **ci:** add types-requests stub and fix dbt seed column types ([7e06cff](https://github.com/fgarofalo56/csa-inabox/commit/7e06cff4520470a7a4de0fe76a89e40fb2ec576e))
* **ci:** correct deploy-pages action SHA pin ([#77](https://github.com/fgarofalo56/csa-inabox/issues/77)) ([7a44369](https://github.com/fgarofalo56/csa-inabox/commit/7a44369c5fed3f38b330338ba8c2f33879a14605))
* **ci:** fix platform test imports and filter generated schema to existing models ([00d2749](https://github.com/fgarofalo56/csa-inabox/commit/00d2749d034fd4582042688a5a8948bf85bec47c))
* **ci:** regenerate schema_contract_generated.yml from contracts ([c16cab5](https://github.com/fgarofalo56/csa-inabox/commit/c16cab5415fecbe58a949f835592b0e0f65394f3))
* **ci:** replace em-dashes with ASCII dashes to fix cross-platform drift ([263ae53](https://github.com/fgarofalo56/csa-inabox/commit/263ae53447b4b408e589f514ee24b126a4e87bdc))
* **ci:** resolve CI failures — contracts, bandit, repo hygiene, dbt ([d071263](https://github.com/fgarofalo56/csa-inabox/commit/d0712637ea1a68c7572e4a0241e60eac412dc39b))
* **ci:** resolve CI failures + standardize all documentation ([#35](https://github.com/fgarofalo56/csa-inabox/issues/35)) ([9190c6b](https://github.com/fgarofalo56/csa-inabox/commit/9190c6be9f36b4d1b384b13991eee1c3bc51c995))
* **ci:** revert platform coverage paths until test suites exist ([912b101](https://github.com/fgarofalo56/csa-inabox/commit/912b1019334b44bdb91612178dcd447a6a1b382a))
* **ci:** unbreak Bicep Lint, Lint Verticals, IaC Security Scan ([#98](https://github.com/fgarofalo56/csa-inabox/issues/98)) ([2aa39b2](https://github.com/fgarofalo56/csa-inabox/commit/2aa39b2d10d2fb86689d6d8d7e2c17a1c86124ed))
* close all audit gaps — GE suites, pre-commit, portal persistence, lint, env vars ([913ce14](https://github.com/fgarofalo56/csa-inabox/commit/913ce1402c3c32b2f6eb7b4b79efa6986722a8fa))
* close gaps — sales domain config, schema tests, shared contracts, packages.yml ([adce241](https://github.com/fgarofalo56/csa-inabox/commit/adce241d148de63f9a75e40ab18adfe1b756b273))
* comprehensive audit remediation — all layers to A grade ([1a2f797](https://github.com/fgarofalo56/csa-inabox/commit/1a2f7970071e7b220787ae93bc21245d14bcfe76))
* comprehensive audit remediation — bring all layers to A grade ([749f2fa](https://github.com/fgarofalo56/csa-inabox/commit/749f2faf853f30276ba536943577948368b62574))
* comprehensive codebase audit — security, architecture, DX hardening ([#76](https://github.com/fgarofalo56/csa-inabox/issues/76)) ([2dd9e33](https://github.com/fgarofalo56/csa-inabox/commit/2dd9e339574f2297136623ce7e812959cc7fca6e))
* convert GitHub alert syntax to MkDocs admonitions ([#78](https://github.com/fgarofalo56/csa-inabox/issues/78)) ([51f7c1e](https://github.com/fgarofalo56/csa-inabox/commit/51f7c1e8f5abf1d0678b33fc9f31f4b1d967174b))
* **dbt:** fix invalid YAML comments and Jinja config syntax ([50b9873](https://github.com/fgarofalo56/csa-inabox/commit/50b9873dfe758cd4fb682a944035e796afcc9f79))
* **dbt:** remove duplicate slv_orders entry from schema.yml ([a567ba0](https://github.com/fgarofalo56/csa-inabox/commit/a567ba0e9b607353903761b397bbc40b0cab6eb3))
* **dbt:** unblock CI integration tests with DuckDB compatibility layer ([#56](https://github.com/fgarofalo56/csa-inabox/issues/56)) ([ef57544](https://github.com/fgarofalo56/csa-inabox/commit/ef57544f7fb111f49184d563c0b8f6b63f7f9daa))
* details block rendering and chat widget double-slash URLs ([#82](https://github.com/fgarofalo56/csa-inabox/issues/82)) ([ce03506](https://github.com/fgarofalo56/csa-inabox/commit/ce03506aed0e41fde553e3e3cdef9b6817086719))
* **iac:** resolve Checkov security findings across Bicep modules ([#57](https://github.com/fgarofalo56/csa-inabox/issues/57)) ([9940973](https://github.com/fgarofalo56/csa-inabox/commit/9940973ef79c4e02c9489e33f57f92687beef285))
* **persistence:** serialize SQLite read-modify-write + add update_atomic ([#54](https://github.com/fgarofalo56/csa-inabox/issues/54)) ([e199d21](https://github.com/fgarofalo56/csa-inabox/commit/e199d21c96b45f65e09c0c85d8d821f05da08e1d))
* regenerate per-domain schema files with existing-model filter ([fee9d5c](https://github.com/fgarofalo56/csa-inabox/commit/fee9d5c8f695736b797f4fcae83ad1ef8e7ee235))
* rename shadowed variable in dbt_test_generator to fix mypy ([7581516](https://github.com/fgarofalo56/csa-inabox/commit/75815164cbc04e126c6c0e909ab254fccc9f5c7f))
* **security:** address critical findings from full-repo audit ([#53](https://github.com/fgarofalo56/csa-inabox/issues/53)) ([0643833](https://github.com/fgarofalo56/csa-inabox/commit/0643833e50e8f277b8554416218174ac9394d8b6))
* **tests:** update SDK exception tests to match retry-first behavior ([9b52667](https://github.com/fgarofalo56/csa-inabox/commit/9b52667e0d8ca629adf1281c6773f5890dfab7bb))
* **types+errors:** resolve 33 mypy strict errors, narrow 51 bare excepts, harden CORS ([#58](https://github.com/fgarofalo56/csa-inabox/issues/58)) ([5c865a0](https://github.com/fgarofalo56/csa-inabox/commit/5c865a0a4636ebb622a9378463881fdae425b55b))


### Code Refactoring

* comprehensive codebase audit remediation — 150 findings across 5 phases ([5d42043](https://github.com/fgarofalo56/csa-inabox/commit/5d420432bffaa60160e37d6122c73c4afe746ce1))
* **dbt:** move surrogate keys to Silver; flag bad rows instead of filtering ([499ddc2](https://github.com/fgarofalo56/csa-inabox/commit/499ddc260a263fc251e076e136778eca044fc1e7))
* decouple platform logging, add CI path filtering, fix portal tests ([#59](https://github.com/fgarofalo56/csa-inabox/issues/59)) ([9b7b80b](https://github.com/fgarofalo56/csa-inabox/commit/9b7b80b8e23ed5f993468fe23ba1504c5a36e985))
* restructure repo for monorepo split, rename platform dirs ([#37](https://github.com/fgarofalo56/csa-inabox/issues/37)) ([55304a5](https://github.com/fgarofalo56/csa-inabox/commit/55304a55b4b6e35ce82274c316d678bc3f217293))
* **tests,governance:** deduplicate script loader, fix test assertions, add env var config ([7078e07](https://github.com/fgarofalo56/csa-inabox/commit/7078e07e95f3172058d5cbf21f0470721033cd21))
* **validation:** consolidate three email regexes into one source ([d0cb142](https://github.com/fgarofalo56/csa-inabox/commit/d0cb14287ae4819f190b7390c4c19ae322e9a58e))


### Documentation

* add 13 agency use case pages + multi-cloud data virtualization ([#90](https://github.com/fgarofalo56/csa-inabox/issues/90)) ([8eef7f3](https://github.com/fgarofalo56/csa-inabox/commit/8eef7f3503c0809e4b4fdfeb6c66196bf993c71f))
* add 3 Microsoft Fabric use case pages ([#89](https://github.com/fgarofalo56/csa-inabox/issues/89)) ([130b095](https://github.com/fgarofalo56/csa-inabox/commit/130b0959553e8ba7bc894f600b8f8c0ed7d9524c))
* add Best Practices tab with 10 comprehensive guides ([#92](https://github.com/fgarofalo56/csa-inabox/issues/92)) ([1a55cfd](https://github.com/fgarofalo56/csa-inabox/commit/1a55cfd92668ac43dddc0f3ecf5801f319b3da2e))
* add documentation site link to README ([#80](https://github.com/fgarofalo56/csa-inabox/issues/80)) ([7e6dae9](https://github.com/fgarofalo56/csa-inabox/commit/7e6dae9bcdc660dd90d1f2723dcde3d6bf9d7ef9))
* add GETTING_STARTED + TROUBLESHOOTING guides and tests scaffold ([e75d85e](https://github.com/fgarofalo56/csa-inabox/commit/e75d85ef3102f4c011ad2e2a3df72f9c8a14bb5c))
* add verified white papers and official reports ([#87](https://github.com/fgarofalo56/csa-inabox/issues/87)) ([dce7835](https://github.com/fgarofalo56/csa-inabox/commit/dce783564408a19d6e81e50dc17fadf6c3ccb53d))
* ADF setup, Databricks guide, expanded troubleshooting, security runbook, cost management, multi-region/tenant, SHIR ([4ba4247](https://github.com/fgarofalo56/csa-inabox/commit/4ba4247edb8c1945b6e0dd66a4051b1d10344f2c))
* beautify all 80 project documentation files with consistent formatting ([18c3b6e](https://github.com/fgarofalo56/csa-inabox/commit/18c3b6e0af17e9f11f9bc2303f0ebce8e4b52a0d))
* beautify all 89 project markdown files with full formatting rules ([#36](https://github.com/fgarofalo56/csa-inabox/issues/36)) ([1819c0a](https://github.com/fgarofalo56/csa-inabox/commit/1819c0a76c567792a570650cf49d616769c64d69))
* close remaining beautification gaps across 9 files ([55b2f78](https://github.com/fgarofalo56/csa-inabox/commit/55b2f78c37c765009b809089b91037c87130f687))
* metadata headers, TOCs, em-dashes, code block language tags, section spacing. ([9190c6b](https://github.com/fgarofalo56/csa-inabox/commit/9190c6be9f36b4d1b384b13991eee1c3bc51c995))
* replace DOJ/FTC links with Azure ingestion how-to guides ([#88](https://github.com/fgarofalo56/csa-inabox/issues/88)) ([086ce0a](https://github.com/fgarofalo56/csa-inabox/commit/086ce0a5e821cb3d31f78041a472cc8e59902954))
* **session:** session-end protocol — log the 10-task completion pass ([395e007](https://github.com/fgarofalo56/csa-inabox/commit/395e007fc143d4e0a11cfead52b2e303c83729c6))


### Tests

* **load:** add Locust / k6 / dbt-bench harness and on-demand workflow ([3ed82e4](https://github.com/fgarofalo56/csa-inabox/commit/3ed82e438c72a5b8440fe4841d9ac8addb5915e7))
* utility script tests, e2e scaffold, secret rotation tests, Purview lineage tests, .gitignore + CI updates ([0c7f726](https://github.com/fgarofalo56/csa-inabox/commit/0c7f7260e04a08d47e4cc75039115434b120c4f3))


### Continuous Integration

* **coverage:** enforce 80% test coverage threshold and publish reports ([7e8174a](https://github.com/fgarofalo56/csa-inabox/commit/7e8174ab13c43756e26ff2efcb19906965a463ea))
* harden CI/CD safety gates per 2026-04-10 audit findings ([d998c6e](https://github.com/fgarofalo56/csa-inabox/commit/d998c6e11d6034da43db98103e8c96d5ddfe97c7))
* remove paths filter from test workflow on PRs ([#74](https://github.com/fgarofalo56/csa-inabox/issues/74)) ([5ef6db8](https://github.com/fgarofalo56/csa-inabox/commit/5ef6db8fd6fbb7fc092809ebcbe8067bf006859b))


### Performance Improvements

* **functions:** convert Azure Functions to async for concurrent throughput ([a40dbb1](https://github.com/fgarofalo56/csa-inabox/commit/a40dbb1b1348831db8ee179bb2d52dbbc50773ef))


### Miscellaneous

* add generated artifacts to .gitignore ([#85](https://github.com/fgarofalo56/csa-inabox/issues/85)) ([4d288eb](https://github.com/fgarofalo56/csa-inabox/commit/4d288eb1a6abf4cf189edf1f7a50624583f14812))
* **claude:** commit project rules + hooks, ignore global-synced dirs ([243d8a4](https://github.com/fgarofalo56/csa-inabox/commit/243d8a4f036f4e8c1f8b91e5a23e3a65a69bc5f4))
* copilot-evals slim, FSM conformance test, mypy real-fix ([#102](https://github.com/fgarofalo56/csa-inabox/issues/102)) ([60358c4](https://github.com/fgarofalo56/csa-inabox/commit/60358c44dea594c0c67df5d85c59cbde550f1806))
* **deps-dev:** Bump eslint-config-next in /portal/react-webapp ([#43](https://github.com/fgarofalo56/csa-inabox/issues/43)) ([38e3a34](https://github.com/fgarofalo56/csa-inabox/commit/38e3a34ca4e3fc1aa721cf114af3c2884e6d5ea8))
* **deps-dev:** Bump jest-environment-jsdom in /portal/react-webapp ([#44](https://github.com/fgarofalo56/csa-inabox/issues/44)) ([5bd7186](https://github.com/fgarofalo56/csa-inabox/commit/5bd71868e1e1a41bbeaa16ef998d138b48fc72c7))
* **deps-dev:** Bump the azure-sdk group with 3 updates ([#48](https://github.com/fgarofalo56/csa-inabox/issues/48)) ([ada8f8d](https://github.com/fgarofalo56/csa-inabox/commit/ada8f8dc12485754913d5f8087d370c3faf2d0ab))
* **deps-dev:** Update cachetools requirement ([#49](https://github.com/fgarofalo56/csa-inabox/issues/49)) ([f0cd0e4](https://github.com/fgarofalo56/csa-inabox/commit/f0cd0e49d788a07d86ec51d7a0dff1e32dcaa72e))
* **deps-dev:** Update cryptography requirement ([#50](https://github.com/fgarofalo56/csa-inabox/issues/50)) ([9641953](https://github.com/fgarofalo56/csa-inabox/commit/96419537c61d22a96d56483f271d10e59714f567))
* **deps-dev:** Update cryptography requirement ([#96](https://github.com/fgarofalo56/csa-inabox/issues/96)) ([ba2c582](https://github.com/fgarofalo56/csa-inabox/commit/ba2c58275844f59a266790d303df05bef15845e9))
* **deps-dev:** Update openai requirement ([#18](https://github.com/fgarofalo56/csa-inabox/issues/18)) ([cac42e6](https://github.com/fgarofalo56/csa-inabox/commit/cac42e688e8da1bd855a2bc6a23ebadfdb1426dd))
* **deps-dev:** Update pypdf requirement ([#73](https://github.com/fgarofalo56/csa-inabox/issues/73)) ([18cacee](https://github.com/fgarofalo56/csa-inabox/commit/18caceea6601e14295cece244b6c0413460008b1))
* **deps-dev:** Update pytest requirement ([55bddeb](https://github.com/fgarofalo56/csa-inabox/commit/55bddeb6aa32342cfdc053bbe126f53a6dcdb76b))
* **deps-dev:** Update pytest requirement from &lt;9.0.0,&gt;=7.0.0 to &gt;=7.0.0,&lt;10.0.0 ([08a16ca](https://github.com/fgarofalo56/csa-inabox/commit/08a16caee9302929e8129e4f64fabc79dba27c94))
* **deps-dev:** Update pytest-asyncio requirement ([8df670b](https://github.com/fgarofalo56/csa-inabox/commit/8df670b6d1f2b246fd8ed8d4a672e29626161cd7))
* **deps-dev:** Update pytest-asyncio requirement from &lt;1.0.0,&gt;=0.23.0 to &gt;=0.23.0,&lt;2.0.0 ([78bd129](https://github.com/fgarofalo56/csa-inabox/commit/78bd129da25a7e960fb5aa055b1cc6016b9392c2))
* **deps-dev:** Update pytest-cov requirement ([7ff4094](https://github.com/fgarofalo56/csa-inabox/commit/7ff40948db7af6626bee7cfffb6eedd87c8142c6))
* **deps-dev:** Update pytest-cov requirement ([#14](https://github.com/fgarofalo56/csa-inabox/issues/14)) ([6296d99](https://github.com/fgarofalo56/csa-inabox/commit/6296d99ffb10e25898a3ccb0620d13a0863c95fb))
* **deps-dev:** Update pytest-cov requirement from &lt;6.0.0,&gt;=4.0.0 to &gt;=4.0.0,&lt;8.0.0 ([a0f835d](https://github.com/fgarofalo56/csa-inabox/commit/a0f835d4a293646525e88ea82d89ccde912d313a))
* **deps-dev:** Update redis requirement ([#71](https://github.com/fgarofalo56/csa-inabox/issues/71)) ([1c32294](https://github.com/fgarofalo56/csa-inabox/commit/1c32294c2723620965e1d178f73db4373ba75efa))
* **deps-dev:** Update sse-starlette requirement ([#68](https://github.com/fgarofalo56/csa-inabox/issues/68)) ([33b8cbe](https://github.com/fgarofalo56/csa-inabox/commit/33b8cbe8bc02fc3c74223ad9e75df8f2b18a9bc2))
* **deps-dev:** Update structlog requirement ([4656308](https://github.com/fgarofalo56/csa-inabox/commit/46563082a999afc52ee9bbd2f36fc1e72ccde02d))
* **deps-dev:** Update structlog requirement ([#17](https://github.com/fgarofalo56/csa-inabox/issues/17)) ([a9c26be](https://github.com/fgarofalo56/csa-inabox/commit/a9c26be563daad1a2fd577d4e4478f529f8c7b87))
* **deps-dev:** Update structlog requirement from &lt;25.0.0,&gt;=24.1.0 to &gt;=24.1.0,&lt;26.0.0 ([02dbc4e](https://github.com/fgarofalo56/csa-inabox/commit/02dbc4e1fe65ad966076d7f5e9768532a7894514))
* **deps:** Bump @azure/msal-browser in /portal/react-webapp ([#47](https://github.com/fgarofalo56/csa-inabox/issues/47)) ([87b8e02](https://github.com/fgarofalo56/csa-inabox/commit/87b8e02fbe96052f735f37dcf433a1ada7db5321))
* **deps:** Bump @azure/msal-browser in /portal/react-webapp ([#64](https://github.com/fgarofalo56/csa-inabox/issues/64)) ([9ef0b9d](https://github.com/fgarofalo56/csa-inabox/commit/9ef0b9d32cf876dc8c3445051f583604c7b4f8c7))
* **deps:** Bump @azure/msal-react in /portal/react-webapp ([#93](https://github.com/fgarofalo56/csa-inabox/issues/93)) ([baa3850](https://github.com/fgarofalo56/csa-inabox/commit/baa38502a61543fe5933867ff61f569962562dd3))
* **deps:** Bump @tanstack/react-query in /portal/react-webapp ([#69](https://github.com/fgarofalo56/csa-inabox/issues/69)) ([d4f06de](https://github.com/fgarofalo56/csa-inabox/commit/d4f06de1ef0bb57d7007c15efd80a8118cc8b686))
* **deps:** Bump @tanstack/react-query in /portal/react-webapp ([#94](https://github.com/fgarofalo56/csa-inabox/issues/94)) ([f56c8f2](https://github.com/fgarofalo56/csa-inabox/commit/f56c8f24a2f9a5edddbcf6fbbcdc2f9e6a49de57))
* **deps:** Bump actions/checkout from 4 to 6 ([c84f87a](https://github.com/fgarofalo56/csa-inabox/commit/c84f87a9f03378d2b99c3a88f6dd7b626ba7418d))
* **deps:** Bump actions/checkout from 4 to 6 ([d655a30](https://github.com/fgarofalo56/csa-inabox/commit/d655a3093b35681d53d6021e4cab273e3b402f5c))
* **deps:** Bump actions/github-script from 7.1.0 to 9.0.0 ([32a3a83](https://github.com/fgarofalo56/csa-inabox/commit/32a3a83298813ccaa2942c321aa9cbfb2d6647c4))
* **deps:** Bump actions/github-script from 7.1.0 to 9.0.0 ([d68f8f8](https://github.com/fgarofalo56/csa-inabox/commit/d68f8f829c1f11935ed18e430e5696f93a28c5bc))
* **deps:** Bump actions/github-script from 7.1.0 to 9.0.0 ([#39](https://github.com/fgarofalo56/csa-inabox/issues/39)) ([4d61324](https://github.com/fgarofalo56/csa-inabox/commit/4d613240d2d2784178db79ac2dabe6e622dacda9))
* **deps:** Bump actions/setup-node from 4.4.0 to 6.3.0 ([#13](https://github.com/fgarofalo56/csa-inabox/issues/13)) ([e04afb0](https://github.com/fgarofalo56/csa-inabox/commit/e04afb06b777784c7a5473db712ec99e83fb6acf))
* **deps:** Bump actions/setup-python from 5.3.0 to 6.2.0 ([#31](https://github.com/fgarofalo56/csa-inabox/issues/31)) ([4660745](https://github.com/fgarofalo56/csa-inabox/commit/466074581a63e27d2621aece301eda2ec5d8b71b))
* **deps:** Bump actions/upload-artifact from 4.5.0 to 7.0.1 ([#12](https://github.com/fgarofalo56/csa-inabox/issues/12)) ([731ac0c](https://github.com/fgarofalo56/csa-inabox/commit/731ac0c0ecdf47d15ac8ee8bfe9b7b5e52aad150))
* **deps:** bump axios from 1.15.0 to 1.15.2 ([#75](https://github.com/fgarofalo56/csa-inabox/issues/75)) ([06bc0d8](https://github.com/fgarofalo56/csa-inabox/commit/06bc0d87d696467b6c0ab34d4802be93521432f4))
* **deps:** Bump azure/CLI ([#41](https://github.com/fgarofalo56/csa-inabox/issues/41)) ([1eb4003](https://github.com/fgarofalo56/csa-inabox/commit/1eb4003d191b0992ddfc6645e31edf1f3b51497d))
* **deps:** Bump bridgecrewio/checkov-action ([11651d5](https://github.com/fgarofalo56/csa-inabox/commit/11651d573529179d249841531948da55ad24c08f))
* **deps:** Bump bridgecrewio/checkov-action from 12.3093.0 to 12.3096.0 ([fa4d503](https://github.com/fgarofalo56/csa-inabox/commit/fa4d503a039c8a2da2df0acc59161676122d38b3))
* **deps:** Bump docker/build-push-action from 6.19.2 to 7.1.0 ([#42](https://github.com/fgarofalo56/csa-inabox/issues/42)) ([6b4a3f7](https://github.com/fgarofalo56/csa-inabox/commit/6b4a3f7a1c450b5d12b4cafecb1a633c6b05d50c))
* **deps:** Bump docker/login-action from 3.7.0 to 4.1.0 ([#15](https://github.com/fgarofalo56/csa-inabox/issues/15)) ([06b5d2b](https://github.com/fgarofalo56/csa-inabox/commit/06b5d2b24eb68d466233d7a97e0d9339a1f8e740))
* **deps:** Bump dorny/paths-filter from 3.0.2 to 4.0.1 ([0289670](https://github.com/fgarofalo56/csa-inabox/commit/0289670d91be8cf4a929296c6082dc3b7f394bc8))
* **deps:** Bump dorny/paths-filter from 3.0.2 to 4.0.1 ([d718ba4](https://github.com/fgarofalo56/csa-inabox/commit/d718ba4dcd6012c34c68e7152c7fe0e61a0f51e6))
* **deps:** Bump github/codeql-action from 3 to 4 ([c279a54](https://github.com/fgarofalo56/csa-inabox/commit/c279a54e168fd7749912748852bd513177b7a087))
* **deps:** Bump github/codeql-action from 3 to 4 ([eb0de4e](https://github.com/fgarofalo56/csa-inabox/commit/eb0de4edc432322a7ee156ee6abe85b426dfe29e))
* **deps:** Bump github/codeql-action from 4.35.1 to 4.35.2 ([#29](https://github.com/fgarofalo56/csa-inabox/issues/29)) ([6a706e1](https://github.com/fgarofalo56/csa-inabox/commit/6a706e16b994a198b3d36eb56fddf451cc3ca885))
* **deps:** Bump next from 14.2.35 to 15.5.15 in /portal/react-webapp ([de83f37](https://github.com/fgarofalo56/csa-inabox/commit/de83f37e014ba65aeb8a0c3c062a2a1e88a1475e))
* **deps:** Bump next from 14.2.35 to 15.5.15 in /portal/react-webapp ([6e2910c](https://github.com/fgarofalo56/csa-inabox/commit/6e2910c82ba9d875b287e97bd0971d035f3404f2))
* **deps:** Bump next from 15.5.15 to 16.2.4 in /portal/react-webapp ([#46](https://github.com/fgarofalo56/csa-inabox/issues/46)) ([9095d6a](https://github.com/fgarofalo56/csa-inabox/commit/9095d6aebefa4d53ca6baf60834d2264ed6387c4))
* **deps:** Bump react-hook-form in /portal/react-webapp ([#72](https://github.com/fgarofalo56/csa-inabox/issues/72)) ([7036c70](https://github.com/fgarofalo56/csa-inabox/commit/7036c70c19c09fc12ceaea47303b322c1ceabbfe))
* **deps:** Bump tailwind-merge in /portal/react-webapp ([#38](https://github.com/fgarofalo56/csa-inabox/issues/38)) ([6ae119b](https://github.com/fgarofalo56/csa-inabox/commit/6ae119b62b984c2a286019163ff81e934ecab537))
* **deps:** Bump zod from 3.25.76 to 4.3.6 in /portal/react-webapp ([#40](https://github.com/fgarofalo56/csa-inabox/issues/40)) ([c639317](https://github.com/fgarofalo56/csa-inabox/commit/c6393173b3414a78b0ddc32ff9fa87504a8cbea9))
* finish CI cleanup (SBOM/deploy/dr-drill/rollback) + remaining hygiene punch list ([#101](https://github.com/fgarofalo56/csa-inabox/issues/101)) ([95dabc7](https://github.com/fgarofalo56/csa-inabox/commit/95dabc74821f193b4840b57045c1991ed6befca6))
* finish the backlog -- Checkov 102-&gt;4, contracts canonical, bicep-whatif Node 24 ([#104](https://github.com/fgarofalo56/csa-inabox/issues/104)) ([f59d912](https://github.com/fgarofalo56/csa-inabox/commit/f59d912a738ab17c767c96112a3f1d67b5930cda))
* finish the deferred four -- mypy 0, ALZ provenance, ADRs 0021/0022 ([#105](https://github.com/fgarofalo56/csa-inabox/issues/105)) ([3dd52cd](https://github.com/fgarofalo56/csa-inabox/commit/3dd52cdbef13c29abf4de52ba47c94d8516a5abb))
* fix Dependabot vulnerabilities, ruff lint cleanup, and gitignore hygiene ([78c2680](https://github.com/fgarofalo56/csa-inabox/commit/78c268041b97e293d8bb85855302369ee87e687b))
* fix Trivy + release-please + pre-commit validators + drop dead semantic_kernel ([#99](https://github.com/fgarofalo56/csa-inabox/issues/99)) ([99963b6](https://github.com/fgarofalo56/csa-inabox/commit/99963b674264c99ad3392709bbd25b84b5719b76))
* **post-rename:** declare csa_platform package, fix mypy, delete Svelte archive ([#52](https://github.com/fgarofalo56/csa-inabox/issues/52)) ([0a348b8](https://github.com/fgarofalo56/csa-inabox/commit/0a348b8f8feab51388000ddc6538dadb1b7cf34e))
* repo hygiene — archive audit reports, bootstrap .claude tracking ([84aa05b](https://github.com/fgarofalo56/csa-inabox/commit/84aa05b6e8f9073867ee7cfc513f39950c069ad4))
* session tracking — cleanup pass complete, 451 tests, clean tree ([30dc84c](https://github.com/fgarofalo56/csa-inabox/commit/30dc84cbca02e48605372109e8124dd01e539ef0))
* strip notebook outputs, delete GE, rename tests/platform ([#55](https://github.com/fgarofalo56/csa-inabox/issues/55)) ([f32cfa4](https://github.com/fgarofalo56/csa-inabox/commit/f32cfa4e1c0fc8bf66ad827568aa35fd3234faf6))
* **types:** add type hints and enable strict mypy across Python code ([7494e38](https://github.com/fgarofalo56/csa-inabox/commit/7494e38f0ac7a96925aef80e5b4a3e4bbf6b0e08))
* update README with domain listing, session tracking, and agent harness config ([3150d25](https://github.com/fgarofalo56/csa-inabox/commit/3150d2598af3de68d5a71d0b4a3e8b4cee6e99c0))

## [0.1.0] - 2026-04-20

Initial internal release of csa-inabox — Azure-native reference
implementation of Microsoft's "Unify your data platform" guidance.

### Features

- Reference architectures for Fabric-parity on Azure PaaS (DMLZ +
  DLZ landing zones, medallion Delta Lake, streaming via Event Hubs
  + ADX, AI/ML via Azure OpenAI + Azure ML).
- 10 vertical examples (finance, sales, inventory, commerce, DOT,
  USDA, USPS, NOAA, EPA, Interior, tribal health, casino).
- Audit-remediation branch: 38+ CSA findings resolved spanning
  auth safety gates, JWT hardening, tamper-evident audit log,
  compliance matrices (NIST 800-53, CMMC 2.0 L2, HIPAA), Palantir +
  Snowflake + AWS + GCP migration playbooks, 8 decision trees, 11
  MADR ADRs, governance + shared-services consolidation, CLI
  promotion, IoT Entra-only, canonical DLQ pattern, and more.
- Dependabot configuration for pip and GitHub Actions.
- CodeQL SAST analysis workflow.
- NSG outbound security rules for all subnet types.
- Blob size limits and input validation in Function Apps.
- Connection pooling for AI enrichment clients.
- UUID-based event ID generation (replacing datetime-based).
- Load test baselines directory structure.
- DEPRECATED.md for ARM templates migration guide.

### Bug Fixes

- Fixed `gld_inventory_turnover` SQL syntax error (duplicate
  SELECT, stray parenthesis).
- Fixed non-existent `safety_stock` column reference in inventory
  turnover model.
- Removed hardcoded subscription IDs, IPs, and PII from ALZ
  parameter files.
- Added deployment guard to DLZ external storage module.
- Fixed DMLZ governance property name mismatches preventing
  deployment.
- Added Azure SDK retry logic to all Function Apps (secret
  rotation, AI enrichment, event processing).
- Fixed broken dbt incremental strategies in gold models.
- Fixed dbt schema test column name mismatches.
- Added source freshness checks to inventory and sales domains.
- Fixed CI/CD workflow bugs (secret names, timeouts, error
  handling).
- Fixed Bicep typos (Postgres DNS zone, "requirments",
  "Moddules").
- Fixed `privatelink.bicep` always-true logic bug.
- Fixed DLZ storage modules missing monitoring and CMK parameter
  pass-through.

### Code Refactoring

- Standardized dbt metadata columns to `_dbt_run_id`.
- Moved SHIR VM auth key to `protectedSettings`.
- Changed OpenLineage auth from API key to OAuth / managed
  identity.
- Changed Cosmos DB `disableKeyBasedMetadataWriteAccess` default to
  `true`.
- Parameterized ALZ tags (PrimaryContact, CostCenter).
- Parameterized ALZ storage IP rules.
- Improved PII redaction to use service's built-in `redacted_text`.
- Added type hints and docstrings to Python modules.
- Added encryption at host for SHIR VM.
- Added CMK parameter pass-through in lake zone storage.
- Added outbound NSG deny-all rules with service tag exceptions.

### Documentation

- 11 MADR architectural decision records.
- 8 mermaid + YAML decision trees with Copilot `walk_tree` contract.
- 4 migration playbooks (Palantir Foundry, Snowflake, AWS, GCP).
- 3 compliance framework control matrices (NIST 800-53 Rev 5, CMMC
  2.0 L2, HIPAA Security Rule) with 304 controls / 231 evidence
  items, validator script.
- Operator runbooks: DR drill, dead-letter, security-incident,
  rollback, troubleshooting.

### Tests

- 978+ passing tests across `csa_platform` / portal / CLI /
  governance / functions suites.
- Zero regressions across ~62 commits of audit remediation.

## [Unreleased]

<!-- release-please maintains this section automatically as
conventional-commit PRs land on main -->

---

## Related Documentation

| Document | Description |
|---|---|
| [README](README.md) | Project overview and quick start |
| [CONTRIBUTING](CONTRIBUTING.md) | Development guidelines and PR process |
| [RELEASE](RELEASE.md) | Release process and Conventional Commits reference |
