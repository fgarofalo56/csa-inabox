---
title: "Environment Management"
description: "__Manage multiple environments (Dev/Test/Prod) with proper configuration, deployment strategies, and environment-specific settings.__"
tags:
  - tutorials
  - data-factory
---
# 🌍 Environment Management

![Tutorial](https://img.shields.io/badge/Tutorial-Environment_Management-blue)
![Duration](https://img.shields.io/badge/Duration-10_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-red)

__Manage multiple environments (Dev/Test/Prod) with proper configuration, deployment strategies, and environment-specific settings.__

## 📋 Table of Contents

- [Environment Strategy](#environment-strategy)
- [Configuration Management](#configuration-management)
- [Deployment Process](#deployment-process)
- [Environment Variables](#environment-variables)
- [Best Practices](#best-practices)
- [Summary](#summary)

## 🏗️ Environment Strategy

### Environment Setup

```text
Environments:
├── Development (DEV)
│   ├── Data Factory: adf-project-dev
│   ├── Resource Group: rg-adf-dev
│   └── Purpose: Active development
├── Testing (TEST)
│   ├── Data Factory: adf-project-test
│   ├── Resource Group: rg-adf-test
│   └── Purpose: QA and validation
└── Production (PROD)
    ├── Data Factory: adf-project-prod
    ├── Resource Group: rg-adf-prod
    └── Purpose: Live workloads
```

## ⚙️ Configuration Management

### ARM Template Parameters

```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "factoryName": {
      "value": "adf-project-prod"
    },
    "AzureSqlDatabase_connectionString": {
      "value": "Server=tcp:sql-prod.database.windows.net,1433;Database=salesdb;"
    },
    "AzureBlobStorage_accountName": {
      "value": "staprod"
    }
  }
}
```

### Environment-Specific Parameters

```json
{
  "dev": {
    "sqlServer": "sql-dev.database.windows.net",
    "storageAccount": "stadev",
    "keyVault": "kv-dev"
  },
  "test": {
    "sqlServer": "sql-test.database.windows.net",
    "storageAccount": "statest",
    "keyVault": "kv-test"
  },
  "prod": {
    "sqlServer": "sql-prod.database.windows.net",
    "storageAccount": "staprod",
    "keyVault": "kv-prod"
  }
}
```

## 🚀 Deployment Process

### Pre-Production Checklist

- [ ] Code review completed
- [ ] Unit tests passed
- [ ] Integration tests passed
- [ ] Performance testing completed
- [ ] Security scan passed
- [ ] Documentation updated
- [ ] Rollback plan documented

### Deployment Steps

1. __Stop Triggers__ (Production)
```powershell
# Stop all triggers
$triggers = Get-AzDataFactoryV2Trigger -ResourceGroupName "rg-adf-prod" -DataFactoryName "adf-project-prod"
$triggers | ForEach-Object { Stop-AzDataFactoryV2Trigger -ResourceGroupName "rg-adf-prod" -DataFactoryName "adf-project-prod" -Name $_.Name -Force }
```

2. __Deploy ARM Template__
```bash
az deployment group create \
  --resource-group "rg-adf-prod" \
  --template-file "ARMTemplateForFactory.json" \
  --parameters @ARMTemplateParametersForFactory.prod.json
```

3. __Start Triggers__ (Production)
```powershell
# Start all triggers
$triggers | ForEach-Object { Start-AzDataFactoryV2Trigger -ResourceGroupName "rg-adf-prod" -DataFactoryName "adf-project-prod" -Name $_.Name -Force }
```

## 📊 Environment Variables

### Use Global Parameters

```json
{
  "environment": {
    "dev": {
      "type": "string",
      "value": "development"
    },
    "test": {
      "type": "string",
      "value": "testing"
    },
    "prod": {
      "type": "string",
      "value": "production"
    }
  }
}
```

## 🎯 Best Practices

### Environment Isolation

- Separate subscriptions or resource groups
- Different service principals per environment
- Isolated networks (VNets)

### Configuration Management

- Store environment configs in Key Vault
- Use ARM template parameters
- Implement global parameters
- Version control all configurations

### Deployment Automation

- Automated testing before deployment
- Blue-green deployment strategy
- Automated rollback capability
- Deployment notifications

### Security

- Least privilege access per environment
- Separate service principals
- Environment-specific managed identities
- Regular security audits

## ✅ Summary

Congratulations! You've completed the Azure Data Factory Tutorial Series.

### What You've Learned

- ✅ ADF fundamentals and architecture
- ✅ Environment setup and configuration
- ✅ Integration runtime setup
- ✅ Multi-source data integration
- ✅ Secure connectivity patterns
- ✅ Pipeline development and orchestration
- ✅ Data transformation techniques
- ✅ Error handling and monitoring
- ✅ CI/CD implementation
- ✅ Environment management

### Next Steps

- __Build Production Pipelines__: Apply learnings to real projects
- __Explore Advanced Features__: Azure Purview integration, Delta Lake
- __Join Community__: Participate in forums and user groups
- __Continuous Learning__: Stay updated with new features

### Additional Resources

- [Azure Data Factory Documentation](https://docs.microsoft.com/azure/data-factory/)
- [ADF Best Practices](../../best-practices/README.md)
- [Architecture Patterns](../../architecture/README.md)
- [Community Forums](https://github.com/Azure/Azure-DataFactory/discussions)

### Feedback

We'd love to hear about your experience with this tutorial series!

- __GitHub Issues__: Report problems or suggest improvements
- __Discussions__: Share your implementations and ask questions
- __LinkedIn__: Connect with the Azure Data Factory community

---

__🎉 Tutorial Complete!__ You're now ready to build enterprise-scale data integration solutions with Azure Data Factory.

---

__Module Progress__: 18 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
