## 📌 Summary
<!-- Describe what this PR does in 1-3 bullet points -->


## 🔄 Changes
<!-- List the specific changes made -->
- 

## 🏷️ Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Infrastructure change (Bicep/ARM module addition or modification)
- [ ] Data pipeline change (dbt model, ADF pipeline, notebook)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

---

## ✅ Checklist

> [!IMPORTANT]
> All items below must be verified before requesting review.

- [ ] I have read the [CONTRIBUTING.md](../CONTRIBUTING.md) guide
- [ ] No secrets, credentials, or sensitive data are committed
- [ ] Bicep templates build successfully (`bicep build`)
- [ ] PowerShell scripts pass PSScriptAnalyzer
- [ ] Python code passes ruff lint
- [ ] New parameters use `<PLACEHOLDER>` values in template files
- [ ] All new resources use private endpoints (no public access)
- [ ] Diagnostic settings route to Log Analytics
- [ ] Managed identity is used (no access keys)
- [ ] Documentation is updated if applicable

---

## 🧪 Test Plan
<!-- How was this tested? -->
- [ ] Local validation (`bicep build`, `az deployment what-if`)
- [ ] CI pipeline passes
- [ ] Deployed to dev environment

---

## 🏗️ Infrastructure Impact
<!-- For Bicep/ARM changes only -->
- [ ] No new Azure resources
- [ ] New resources added: <!-- list them -->
- [ ] Estimated monthly cost impact: <!-- $ amount or "minimal" -->

---
Generated with [Claude Code](https://claude.com/claude-code)
