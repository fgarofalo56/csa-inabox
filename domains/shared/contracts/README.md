# Shared Contracts Directory

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Data Engineers

> **Note:** This directory is intentionally empty. Data contracts in CSA-in-a-Box
> are defined alongside their data products, not in a centralized location.

## Table of Contents

- [Where to Find Data Contracts](#where-to-find-data-contracts)
- [Creating New Contracts](#creating-new-contracts)
- [Contract Validation](#contract-validation)
- [Related Documentation](#related-documentation)

## Where to Find Data Contracts

Data contracts live at the data product level within each domain:

```text
domains/<domain>/data-products/<product>/contract.yaml
```

### Existing contracts

| Domain | Product | Path |
|---|---|---|
| shared | customers | `domains/shared/data-products/customers/contract.yaml` |
| shared | orders | `domains/shared/data-products/orders/contract.yaml` |
| shared | products | `domains/shared/data-products/products/contract.yaml` |
| finance | invoices | `domains/finance/data-products/invoices/contract.yaml` |
| inventory | inventory | `domains/inventory/data-products/inventory/contract.yaml` |
| sales | orders | `domains/sales/data-products/orders/contract.yaml` |

## Creating New Contracts

Use the contract template to scaffold a new data product contract:

1. Copy the template from `templates/data-product/contract-template.json` (JSON Schema)
2. Use the scaffold at `templates/data-product/scaffold/` for a full data product directory structure
3. Fill in the `metadata`, `schema`, `sla`, and `quality_rules` sections
4. Save as `domains/<domain>/data-products/<product>/contract.yaml`
5. Run the CI validator to check your contract:
   ```bash
   python -m governance.contracts.contract_validator --ci
   ```

## Contract Validation

Tooling for validating contracts against the schema lives in:

- `governance/contracts/contract_validator.py` -- validates contract YAML against the JSON Schema template
- `governance/contracts/dbt_test_generator.py` -- generates dbt tests from contract quality rules
- `governance/contracts/pipeline_enforcer.py` -- enforces contract SLAs in pipeline runs

---

## Related Documentation

- [Architecture Overview](../../../docs/ARCHITECTURE.md) — Platform architecture reference
- [Examples](../../../examples/README.md) — Sample data pipelines and use cases