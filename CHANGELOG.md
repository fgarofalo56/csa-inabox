# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is maintained automatically by
[release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/). See
[RELEASE.md](RELEASE.md) for the release process.

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
