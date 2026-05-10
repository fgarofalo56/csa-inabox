---
title: "Tutorial 1: Environment Setup and Prerequisites"
description: "__Set up your Azure environment and local development tools for the complete Stream Analytics tutorial series. This foundation ensures smooth execution of all real-time analytics tutorials.__"
tags:
  - tutorials
  - stream-analytics
---
# 🚀 Tutorial 1: Environment Setup and Prerequisites

![Tutorial](https://img.shields.io/badge/Tutorial-01_Environment_Setup-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Beginner-brightgreen)

__Set up your Azure environment and local development tools for the complete Stream Analytics tutorial series. This foundation ensures smooth execution of all real-time analytics tutorials.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Configure Azure subscription__ with necessary permissions and quotas
- ✅ __Create Event Hubs namespace__ for data ingestion
- ✅ __Set up Stream Analytics workspace__ for real-time processing
- ✅ __Install development tools__ for testing and monitoring
- ✅ __Validate environment setup__ using test data flows

## ⏱️ Time Estimate: 30 minutes

- __Azure Setup__: 15 minutes
- __Event Hubs Configuration__: 10 minutes
- __Validation & Testing__: 5 minutes

## 📋 Prerequisites

### __Required Access__

- [ ] __Azure Subscription__ with Contributor or Owner role
- [ ] __Sufficient credits__ or payment method configured (~$100 recommended for full series)
- [ ] __Administrative access__ to local machine for tool installation

### __Basic Knowledge__

- [ ] __SQL fundamentals__ - SELECT, WHERE, GROUP BY operations
- [ ] __Azure fundamentals__ - Understanding of resource groups and subscriptions
- [ ] __JSON format__ - For event data structure

## 🛠️ Step 1: Azure Subscription Setup

### __1.1 Verify Subscription Access__

First, ensure your Azure subscription has the necessary permissions:

```powershell
# Login to Azure (will open browser for authentication)
az login

# List available subscriptions
az account list --output table

# Set the subscription you want to use for tutorials
az account set --subscription "your-subscription-id-here"

# Verify current subscription
az account show --output table
```

__Expected Output:__

```text
EnvironmentName    HomeTenantId    Id          Name               State    TenantId
-----------------  --------------  ----------  -----------------  -------  -----------
AzureCloud         xxxx-xxxx-...   yyyy-yyyy-... Your Subscription  Enabled  xxxx-xxxx-...
```

### __1.2 Enable Required Resource Providers__

Register necessary Azure resource providers:

```powershell
# Register required providers
$providers = @(
    'Microsoft.EventHub',
    'Microsoft.StreamAnalytics',
    'Microsoft.Storage',
    'Microsoft.Sql',
    'Microsoft.Web'
)

foreach ($provider in $providers) {
    Write-Host "Registering $provider..."
    az provider register --namespace $provider --wait
}

# Verify registration status
az provider list --query "[?namespace=='Microsoft.EventHub' || namespace=='Microsoft.StreamAnalytics'].{Provider:namespace, Status:registrationState}" --output table
```

__Expected Output:__

```text
Provider                    Status
--------------------------  ----------
Microsoft.EventHub          Registered
Microsoft.StreamAnalytics   Registered
```

### __1.3 Define Resource Naming Convention__

Establish consistent naming for all tutorial resources:

```powershell
# Set base variables for all tutorials
$location = "eastus"
$prefix = "streamtutorial"
$suffix = Get-Random -Minimum 1000 -Maximum 9999

# Define resource names
$resourceGroupName = "$prefix-rg-$suffix"
$eventHubNamespace = "$prefix-eh-$suffix"
$eventHubName = "sensordata"
$storageAccountName = "$($prefix)sa$suffix"
$streamAnalyticsJob = "$prefix-asa-$suffix"

# Save to environment variables for later tutorials
[Environment]::SetEnvironmentVariable("STREAM_RG", $resourceGroupName, "User")
[Environment]::SetEnvironmentVariable("STREAM_EH_NAMESPACE", $eventHubNamespace, "User")
[Environment]::SetEnvironmentVariable("STREAM_EH_NAME", $eventHubName, "User")
[Environment]::SetEnvironmentVariable("STREAM_SA", $storageAccountName, "User")
[Environment]::SetEnvironmentVariable("STREAM_JOB", $streamAnalyticsJob, "User")
[Environment]::SetEnvironmentVariable("STREAM_LOCATION", $location, "User")

Write-Host "Resource names configured and saved to environment variables"
```

## 🌐 Step 2: Create Core Azure Resources

### __2.1 Create Resource Group__

Create a dedicated resource group for all streaming resources:

```powershell
# Create resource group
az group create `
    --name $resourceGroupName `
    --location $location `
    --tags "Environment=Tutorial" "Purpose=StreamAnalytics" "CostCenter=Training"

# Verify creation
az group show --name $resourceGroupName --output table
```

__Expected Output:__

```text
Name                    Location    Status
----------------------  ----------  ---------
streamtutorial-rg-1234  eastus      Succeeded
```

### __2.2 Create Event Hubs Namespace__

Set up Event Hubs for streaming data ingestion:

```powershell
# Create Event Hubs namespace (Standard tier for production features)
az eventhubs namespace create `
    --name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --location $location `
    --sku Standard `
    --capacity 1 `
    --enable-auto-inflate false `
    --tags "Purpose=DataIngestion"

# Create Event Hub for sensor data
az eventhubs eventhub create `
    --name $eventHubName `
    --namespace-name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --partition-count 4 `
    --message-retention 1

# Verify Event Hub creation
az eventhubs eventhub show `
    --name $eventHubName `
    --namespace-name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --query "{Name:name, Partitions:partitionCount, Retention:messageRetentionInDays}" `
    --output table
```

__Expected Output:__

```text
Name        Partitions    Retention
----------  ------------  -----------
sensordata  4             1
```

### __2.3 Create Shared Access Policies__

Set up authentication for producers and consumers:

```powershell
# Create policy for data producers (send only)
az eventhubs eventhub authorization-rule create `
    --name SendPolicy `
    --eventhub-name $eventHubName `
    --namespace-name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --rights Send

# Create policy for Stream Analytics (listen only)
az eventhubs eventhub authorization-rule create `
    --name ListenPolicy `
    --eventhub-name $eventHubName `
    --namespace-name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --rights Listen

# Get connection strings for later use
$sendConnectionString = az eventhubs eventhub authorization-rule keys list `
    --name SendPolicy `
    --eventhub-name $eventHubName `
    --namespace-name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --query primaryConnectionString `
    --output tsv

$listenConnectionString = az eventhubs eventhub authorization-rule keys list `
    --name ListenPolicy `
    --eventhub-name $eventHubName `
    --namespace-name $eventHubNamespace `
    --resource-group $resourceGroupName `
    --query primaryConnectionString `
    --output tsv

# Save connection strings securely
[Environment]::SetEnvironmentVariable("STREAM_EH_SEND_CONN", $sendConnectionString, "User")
[Environment]::SetEnvironmentVariable("STREAM_EH_LISTEN_CONN", $listenConnectionString, "User")

Write-Host "Connection strings saved to environment variables"
```

### __2.4 Create Storage Account for Outputs__

Set up storage for archival and reference data:

```powershell
# Create storage account
az storage account create `
    --name $storageAccountName `
    --resource-group $resourceGroupName `
    --location $location `
    --sku Standard_LRS `
    --kind StorageV2 `
    --access-tier Hot `
    --enable-hierarchical-namespace false

# Create container for raw data archive
az storage container create `
    --name "rawdata" `
    --account-name $storageAccountName `
    --public-access off

# Create container for processed data
az storage container create `
    --name "processeddata" `
    --account-name $storageAccountName `
    --public-access off

# Get storage account key
$storageKey = az storage account keys list `
    --account-name $storageAccountName `
    --resource-group $resourceGroupName `
    --query "[0].value" `
    --output tsv

[Environment]::SetEnvironmentVariable("STREAM_SA_KEY", $storageKey, "User")

# Verify containers
az storage container list `
    --account-name $storageAccountName `
    --account-key $storageKey `
    --query "[].name" `
    --output table
```

__Expected Output:__

```text
Result
--------------
processeddata
rawdata
```

## 🔧 Step 3: Install Development Tools

### __3.1 Azure CLI and Extensions__

Ensure latest Azure CLI is installed:

```powershell
# Check Azure CLI version (should be 2.50.0 or higher)
az --version

# Install/update Stream Analytics extension
az extension add --name stream-analytics --upgrade

# Verify extension installation
az extension list --query "[?name=='stream-analytics'].{Name:name, Version:version}" --output table
```

### __3.2 Install Azure Storage Explorer__

Download and install for visual data inspection:

1. Download from: [Azure Storage Explorer](https://azure.microsoft.com/features/storage-explorer/)
2. Install following platform-specific instructions
3. Connect using storage account credentials

### __3.3 Install Visual Studio Code with Extensions__

Set up development environment:

```powershell
# Install VS Code (if not already installed)
# Download from: https://code.visualstudio.com/

# Install recommended extensions via command line
code --install-extension ms-azuretools.vscode-azurefunctions
code --install-extension ms-vscode.azure-account
code --install-extension ms-azuretools.vscode-azurestorage
```

### __3.4 Install Python and Required Libraries__

For data generator scripts (used in Tutorial 02):

```powershell
# Verify Python 3.8+ is installed
python --version

# Create virtual environment for tutorial scripts
python -m venv stream-tutorial-env

# Activate virtual environment
# Windows PowerShell:
.\stream-tutorial-env\Scripts\Activate.ps1

# Install required packages
pip install azure-eventhub==5.11.4
pip install faker==19.12.0
pip install python-dotenv==1.0.0

# Verify installations
pip list | Select-String "azure-eventhub|faker|python-dotenv"
```

__Expected Output:__

```text
azure-eventhub      5.11.4
faker               19.12.0
python-dotenv       1.0.0
```

## ✅ Step 4: Validate Environment Setup

### __4.1 Create Test Event Hub Message__

Verify Event Hub can receive data:

```powershell
# Create test script to send message
$testScript = @'
from azure.eventhub import EventHubProducerClient, EventData
import os
import json
from datetime import datetime

connection_string = os.environ.get("STREAM_EH_SEND_CONN")
eventhub_name = os.environ.get("STREAM_EH_NAME")

producer = EventHubProducerClient.from_connection_string(
    conn_str=connection_string,
    eventhub_name=eventhub_name
)

test_event = {
    "deviceId": "test-device-001",
    "temperature": 72.5,
    "humidity": 45.2,
    "timestamp": datetime.utcnow().isoformat()
}

event_data_batch = producer.create_batch()
event_data_batch.add(EventData(json.dumps(test_event)))

producer.send_batch(event_data_batch)
producer.close()

print("Test event sent successfully!")
'@

# Save and run test script
$testScript | Out-File -FilePath "test_eventhub.py" -Encoding UTF8
python test_eventhub.py
```

__Expected Output:__

```text
Test event sent successfully!
```

### __4.2 Verify Event Hub Metrics__

Check that message was received:

```powershell
# Get Event Hub metrics
az monitor metrics list `
    --resource "/subscriptions/$(az account show --query id -o tsv)/resourceGroups/$resourceGroupName/providers/Microsoft.EventHub/namespaces/$eventHubNamespace" `
    --metric IncomingMessages `
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ss") `
    --end-time (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss") `
    --interval PT1M `
    --query "value[0].timeseries[0].data[-5:]" `
    --output table
```

### __4.3 Environment Validation Checklist__

Run through this checklist to ensure setup is complete:

```powershell
# Create validation script
$validationScript = @'
Write-Host "`n=== Stream Analytics Environment Validation ===" -ForegroundColor Cyan

# Check environment variables
$requiredEnvVars = @(
    "STREAM_RG",
    "STREAM_EH_NAMESPACE",
    "STREAM_EH_NAME",
    "STREAM_SA",
    "STREAM_LOCATION",
    "STREAM_EH_SEND_CONN",
    "STREAM_EH_LISTEN_CONN",
    "STREAM_SA_KEY"
)

$missingVars = @()
foreach ($var in $requiredEnvVars) {
    $value = [Environment]::GetEnvironmentVariable($var, "User")
    if ($value) {
        Write-Host "[OK] $var is set" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $var is missing" -ForegroundColor Red
        $missingVars += $var
    }
}

# Check Azure resources
Write-Host "`nChecking Azure resources..." -ForegroundColor Cyan
$rgExists = az group exists --name $env:STREAM_RG
Write-Host "[$(if($rgExists -eq 'true'){'OK'}else{'FAIL'})] Resource Group exists" -ForegroundColor $(if($rgExists -eq 'true'){'Green'}else{'Red'})

$ehNamespace = az eventhubs namespace show --name $env:STREAM_EH_NAMESPACE --resource-group $env:STREAM_RG --query name -o tsv 2>$null
Write-Host "[$(if($ehNamespace){'OK'}else{'FAIL'})] Event Hubs Namespace exists" -ForegroundColor $(if($ehNamespace){'Green'}else{'Red'})

$eh = az eventhubs eventhub show --name $env:STREAM_EH_NAME --namespace-name $env:STREAM_EH_NAMESPACE --resource-group $env:STREAM_RG --query name -o tsv 2>$null
Write-Host "[$(if($eh){'OK'}else{'FAIL'})] Event Hub exists" -ForegroundColor $(if($eh){'Green'}else{'Red'})

$sa = az storage account show --name $env:STREAM_SA --resource-group $env:STREAM_RG --query name -o tsv 2>$null
Write-Host "[$(if($sa){'OK'}else{'FAIL'})] Storage Account exists" -ForegroundColor $(if($sa){'Green'}else{'Red'})

# Summary
Write-Host "`n=== Validation Summary ===" -ForegroundColor Cyan
if ($missingVars.Count -eq 0 -and $rgExists -eq 'true' -and $ehNamespace -and $eh -and $sa) {
    Write-Host "Environment setup is COMPLETE! Ready for Tutorial 02." -ForegroundColor Green
} else {
    Write-Host "Environment setup has ISSUES. Please review errors above." -ForegroundColor Red
}
'@

# Save and run validation
$validationScript | Out-File -FilePath "validate_environment.ps1" -Encoding UTF8
.\validate_environment.ps1
```

## 💰 Cost Considerations

### __Expected Monthly Costs (Tutorial Series)__

| Service | Configuration | Estimated Cost |
|---------|---------------|----------------|
| __Event Hubs Standard__ | 1M messages/month | $10-20 |
| __Storage Account__ | 100GB Standard LRS | $2-5 |
| __Stream Analytics__ | 1 Streaming Unit | $0 (stopped when not in use) |
| __Azure SQL Database__ | Basic tier | $5 (created in later tutorials) |

__Total Tutorial Cost__: ~$20-30/month if resources kept running

### __Cost Optimization Tips__

```powershell
# Stop Event Hub when not in use (for tutorials only)
# Note: This is NOT recommended for production scenarios

# Delete test resources when series is complete
az group delete --name $resourceGroupName --yes --no-wait
```

> __💡 Cost Alert:__ Set up budget alerts to monitor spending during tutorials

## 🎓 Key Concepts Learned

### __Event Hubs Architecture__

- __Namespace__: Logical container for multiple Event Hubs
- __Event Hub__: Individual streaming endpoint with partitions
- __Partitions__: Enable parallel processing (4 partitions = 4 parallel consumers)
- __Consumer Groups__: Allow multiple applications to read same stream independently

### __Authentication & Security__

- __Shared Access Policies__: Fine-grained access control (Send, Listen, Manage)
- __Connection Strings__: Contain endpoint, policy name, and key
- __Environment Variables__: Secure way to store credentials locally

### __Naming Conventions__

- Use lowercase with hyphens for resource names
- Include resource type abbreviations (rg, eh, sa, asa)
- Add unique suffix to avoid naming conflicts
- Tag resources for cost tracking and organization

## 🚀 Next Steps

Your environment is now ready for real-time streaming analytics! Continue to:

__[Tutorial 02: Data Generator Setup →](02-data-generator.md)__

In the next tutorial, you'll:

- Create realistic IoT sensor data simulators
- Implement different data generation patterns
- Configure data velocity and variety
- Test Event Hub ingestion at scale

## 📚 Additional Resources

- [Azure Event Hubs Documentation](https://docs.microsoft.com/azure/event-hubs/)
- [Azure Stream Analytics Overview](https://docs.microsoft.com/azure/stream-analytics/)
- [Event Hubs Quotas and Limits](https://docs.microsoft.com/azure/event-hubs/event-hubs-quotas)
- [Stream Analytics Pricing](https://azure.microsoft.com/pricing/details/stream-analytics/)

## 🔧 Troubleshooting

### __Issue: Provider Registration Fails__

__Symptoms:__ Error message "The subscription is not registered to use namespace 'Microsoft.EventHub'"

__Solution:__

```powershell
# Register provider manually
az provider register --namespace Microsoft.EventHub --wait
az provider register --namespace Microsoft.StreamAnalytics --wait

# Verify registration
az provider show --namespace Microsoft.EventHub --query "registrationState"
```

### __Issue: Resource Name Already Exists__

__Symptoms:__ "Storage account name is already taken" or similar

__Solution:__

```powershell
# Generate new unique suffix
$suffix = Get-Random -Minimum 10000 -Maximum 99999
$storageAccountName = "streamtutorialsa$suffix"

# Update environment variable
[Environment]::SetEnvironmentVariable("STREAM_SA", $storageAccountName, "User")
```

### __Issue: Python Package Installation Fails__

__Symptoms:__ pip install errors or import failures

__Solution:__

```powershell
# Upgrade pip first
python -m pip install --upgrade pip

# Install packages with verbose output
pip install azure-eventhub==5.11.4 --verbose

# If SSL errors occur, try:
pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org azure-eventhub
```

## 💬 Feedback

Was this tutorial helpful? Let us know:

- ✅ __Completed successfully__ - [Continue to Tutorial 02](02-data-generator.md)
- ⚠️ __Had issues__ - [Report a problem](https://github.com/fgarofalo56/csa-inabox-docs/issues)
- 💡 __Have suggestions__ - [Share feedback](https://github.com/fgarofalo56/csa-inabox-docs/discussions)

---

__Tutorial Progress:__ 1 of 11 complete | __Next:__ [Data Generator Setup](02-data-generator.md)

*Last Updated: January 2025*
