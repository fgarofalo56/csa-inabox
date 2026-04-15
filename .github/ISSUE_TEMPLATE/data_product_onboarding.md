---
name: Data Product Onboarding
about: Request to onboard a new data domain/product
title: "[ONBOARD] Domain: "
labels: data-product, onboarding
assignees: ''
---

[Home](../../README.md) > [Issues](../ISSUE_TEMPLATE) > **Data Product Onboarding**

## 📋 Domain Information

| Field | Value |
|---|---|
| **Domain Name** | |
| **Domain Owner** | |
| **Data Steward** | |

---

## 🗄️ Data Sources

| Source System | Type | Format | Frequency | Volume |
|--------------|------|--------|-----------|--------|
| | | | | |

---

## ✨ Data Products to Publish

| Product Name | Layer | SLA | Consumers |
|-------------|-------|-----|-----------|
| | Gold | Daily | |

---

## 📎 Requirements

### 🧪 Data Quality
- [ ] Define source freshness SLA
- [ ] Define completeness thresholds
- [ ] Define business rules for validation

### 🔒 Security & Governance
- [ ] Data classification: (Public / Internal / Confidential / Restricted)
- [ ] PII present: Yes / No
- [ ] Purview scanning required: Yes / No
- [ ] Access control requirements documented

### 🏗️ Infrastructure
- [ ] Estimated storage (GB/TB):
- [ ] Compute requirements (cluster size):
- [ ] Real-time processing needed: Yes / No

---

## ✅ Onboarding Checklist
- [ ] Copy domain template: `cp -r templates/data-product/scaffold domains/<name>`
- [ ] Define sources in `models/bronze/sources.yml`
- [ ] Create bronze models
- [ ] Create silver models with quality checks
- [ ] Create gold models (data products)
- [ ] Define data contracts in `contracts/`
- [ ] Configure ADF pipeline for ingestion
- [ ] Register in Purview
- [ ] Set up RBAC for domain team
- [ ] Update platform dashboard
