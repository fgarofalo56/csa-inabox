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
