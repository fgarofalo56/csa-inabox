# 🚀 Tutorial 1: Environment Setup and Prerequisites

![Tutorial](https://img.shields.io/badge/Tutorial-01_Environment_Setup-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Beginner-brightgreen)

__Set up your Azure environment and local development tools for the complete Synapse Analytics tutorial series. This foundation ensures smooth execution of all subsequent tutorials.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Configure Azure subscription__ with necessary permissions and quotas
- ✅ __Install and authenticate__ essential development tools
- ✅ __Validate environment setup__ using automated testing scripts
- ✅ __Understand cost implications__ and set up budget monitoring
- ✅ __Prepare resource naming conventions__ for consistent deployments

## ⏱️ Time Estimate: 30 minutes

- __Azure Setup__: 15 minutes
- __Tool Installation__: 10 minutes  
- __Validation & Testing__: 5 minutes

## 📋 Prerequisites

### __Required Access__

- [ ] __Azure Subscription__ with Owner or Contributor role
- [ ] __Sufficient credits__ or payment method configured (~$100 recommended for full series)
- [ ] __Administrative access__ to local machine for tool installation

### __Basic Knowledge__

- [ ] __Azure fundamentals__ - Understanding of resource groups and subscriptions
- [ ] __Command line basics__ - Comfortable with PowerShell or Bash
- [ ] __JSON/YAML familiarity__ - For configuration file modifications

## 🛠️ Step 1: Azure Subscription Setup

### __1.1 Verify Subscription Access__

First, let's ensure your Azure subscription has the necessary permissions and quotas:

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

### __1.2 Check Service Quotas__

Verify your subscription has sufficient quotas for the tutorial series:

```powershell
# Check Synapse Analytics quota
az synapse quota list --location "East US" --output table

# Check compute quotas (for Spark pools)
az vm list-usage --location "East US" --output table | Where-Object {$_.Name.LocalizedValue -like "*Standard D*"}

# Check storage account quotas
az storage account check-quota --output table
```

__Required Minimums:__

- __Synapse Workspaces__: 2 workspaces per subscription
- __Spark Pool Cores__: 50 cores (for medium-sized pools)
- __Storage Accounts__: 10 accounts per subscription
- __Dedicated SQL Pool__: DW100c or higher capability

> __💡 Quota Increase:__ If quotas are insufficient, request increases through Azure Portal → Subscriptions → Usage + quotas

### __1.3 Enable Required Resource Providers__

Register necessary Azure resource providers:

```powershell
# Register required providers
$providers = @(
    'Microsoft.Synapse',
    'Microsoft.Storage', 
    'Microsoft.EventHub',
    'Microsoft.StreamAnalytics',
    'Microsoft.DataFactory',
    'Microsoft.PowerBI',
    'Microsoft.Purview'
)

foreach ($provider in $providers) {
    Write-Host "Registering $provider..." -ForegroundColor Green
    az provider register --namespace $provider
}

# Check registration status
foreach ($provider in $providers) {
    az provider show --namespace $provider --query "registrationState" --output tsv
}
```

__Expected Output:__ All providers should show `Registered` status.

## 🔧 Step 2: Local Development Tools

### __2.1 Install Azure CLI (if not already installed)__

__Windows:__

```powershell
# Install via PowerShell
Invoke-WebRequest -Uri https://aka.ms/installazurecliwindows -OutFile .\AzureCLI.msi
Start-Process msiexec.exe -ArgumentList '/i AzureCLI.msi /quiet' -Wait
```

__macOS:__

```bash
# Install via Homebrew
brew update && brew install azure-cli
```

__Linux:__

```bash
# Install via package manager (Ubuntu/Debian)
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
```

### __2.2 Install Azure PowerShell Module__

```powershell
# Install Azure PowerShell module
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Install-Module -Name Az -Repository PSGallery -Force -AllowClobber

# Verify installation
Get-Module Az -ListAvailable | Select-Object Name, Version
```

### __2.3 Install Visual Studio Code with Extensions__

1. __Download and install VS Code__ from [https://code.visualstudio.com/](https://code.visualstudio.com/)

2. __Install essential extensions:__

```powershell
# Install VS Code extensions via command line
code --install-extension ms-vscode.azure-account
code --install-extension ms-azuretools.vscode-azureresourcegroups  
code --install-extension ms-python.python
code --install-extension ms-toolsai.jupyter
code --install-extension ms-mssql.mssql
code --install-extension redhat.vscode-yaml
```

### __2.4 Install Git and Configure__

__Windows:__

```powershell
# Install Git via winget
winget install --id Git.Git -e --source winget
```

__macOS/Linux:__

```bash
# macOS
brew install git

# Ubuntu/Debian
sudo apt update && sudo apt install git
```

__Configure Git:__

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### __2.5 Install Python and Required Packages__

```powershell
# Install Python 3.9+ (Windows)
winget install python.python.3

# Install required Python packages
pip install azure-cli azure-storage-blob azure-identity pandas numpy jupyter
```

## 📊 Step 3: Cost Management Setup

### __3.1 Create Budget Alerts__

Set up budget monitoring to prevent unexpected charges:

```powershell
# Create a budget for tutorial expenses
az consumption budget create \
  --budget-name "synapse-tutorial-budget" \
  --amount 100 \
  --time-grain Monthly \
  --start-date "$(Get-Date -Format 'yyyy-MM-01')" \
  --end-date "$(Get-Date -Year $((Get-Date).Year + 1) -Format 'yyyy-MM-01')" \
  --resource-group-filter "synapse-tutorial-rg"
```

### __3.2 Set Up Billing Alerts__

Configure email notifications when costs exceed thresholds:

```powershell
# Create action group for budget alerts
az monitor action-group create \
  --name "budget-alerts" \
  --resource-group "synapse-tutorial-rg" \
  --short-name "budget" \
  --email-receiver name="admin" email="your-email@example.com"
```

### __3.3 Implement Resource Tagging Strategy__

Define consistent tags for cost tracking:

```powershell
# Set default tags for tutorial resources
$defaultTags = @{
    'Project' = 'SynapseTutorial'
    'Environment' = 'Learning'
    'Owner' = 'YourName'
    'CostCenter' = 'Training'
    'AutoShutdown' = 'Enabled'
}

# Save tags for later use in tutorials
$defaultTags | ConvertTo-Json | Out-File "tutorial-tags.json"
```

## 🌍 Step 4: Azure Region Selection

### __4.1 Choose the Optimal Region__

Selecting the right Azure region is critical for performance, compliance, and cost optimization.

#### __Region Selection Criteria__

Consider these factors when choosing your region:

1. __Data Residency & Compliance__
   - GDPR requirements (EU regions)
   - HIPAA compliance (specific US regions)
   - Local data sovereignty laws

2. __Proximity to Users__
   - Minimize network latency
   - Improve user experience
   - Faster data access

3. __Feature Availability__
   - All Synapse features available
   - Availability Zones support
   - Latest preview features

4. __Cost Considerations__
   - Regional pricing variations
   - Data transfer costs
   - Geo-redundant storage options

#### __Recommended Regions for Tutorials__

| Region | Best For | Latency | Cost | Features |
|--------|----------|---------|------|----------|
| __East US__ | North America users | Low | Baseline | All features |
| __West Europe__ | EU users, GDPR compliance | Low | ~10% higher | All features |
| __Southeast Asia__ | Asia Pacific users | Low | ~15% higher | All features |
| __UK South__ | UK users, data residency | Low | ~15% higher | All features |
| __Australia East__ | Australia/NZ users | Low | ~20% higher | All features |

#### __Region Selection Script__

```powershell
# Interactive region selection
Write-Host "🌍 Azure Region Selection for Synapse Tutorials" -ForegroundColor Cyan
Write-Host ""

# Display available regions with Synapse support
$synapseRegions = @(
    @{Name="East US"; Code="eastus"; Compliance="HIPAA, SOC2"; Pricing="Baseline"},
    @{Name="East US 2"; Code="eastus2"; Compliance="HIPAA, SOC2"; Pricing="Baseline"},
    @{Name="West Europe"; Code="westeurope"; Compliance="GDPR, ISO 27001"; Pricing="+10%"},
    @{Name="North Europe"; Code="northeurope"; Compliance="GDPR, ISO 27001"; Pricing="+10%"},
    @{Name="UK South"; Code="uksouth"; Compliance="GDPR, UK DPA"; Pricing="+15%"},
    @{Name="Southeast Asia"; Code="southeastasia"; Compliance="PDPA"; Pricing="+15%"},
    @{Name="Australia East"; Code="australiaeast"; Compliance="IRAP, Privacy Act"; Pricing="+20%"}
)

Write-Host "Available Azure Regions for Synapse Analytics:" -ForegroundColor Green
$synapseRegions | ForEach-Object -Begin {$i=1} -Process {
    Write-Host "$i. $($_.Name) ($($_.Code))"
    Write-Host "   Compliance: $($_.Compliance)"
    Write-Host "   Relative Cost: $($_.Pricing)"
    Write-Host ""
    $i++
}

# Prompt for region selection
$regionChoice = Read-Host "Select region number (default: 1 - East US)"
if ([string]::IsNullOrWhiteSpace($regionChoice)) {
    $regionChoice = 1
}

$selectedRegion = $synapseRegions[$regionChoice - 1]
$location = $selectedRegion.Code
$locationName = $selectedRegion.Name

Write-Host "Selected Region: $locationName ($location)" -ForegroundColor Green
```

#### __Data Residency Validation__

For compliance-critical workloads, verify data residency:

```powershell
# Validate data residency requirements
function Test-DataResidency {
    param(
        [string]$Region,
        [string[]]$ComplianceRequirements
    )

    $regionCompliance = @{
        "eastus" = @("HIPAA", "SOC2", "ISO 27001")
        "westeurope" = @("GDPR", "ISO 27001", "ISO 27018")
        "uksouth" = @("GDPR", "UK DPA", "ISO 27001")
        "southeastasia" = @("PDPA", "ISO 27001")
    }

    $supportedCompliance = $regionCompliance[$Region]
    $allRequirementsMet = $true

    foreach ($requirement in $ComplianceRequirements) {
        if ($supportedCompliance -notcontains $requirement) {
            Write-Warning "Region $Region does not support $requirement compliance"
            $allRequirementsMet = $false
        }
    }

    return $allRequirementsMet
}

# Example: Validate GDPR compliance for EU deployment
if ($location -like "*europe*" -or $location -eq "uksouth") {
    $isCompliant = Test-DataResidency -Region $location -ComplianceRequirements @("GDPR")
    if ($isCompliant) {
        Write-Host "✅ Region meets GDPR compliance requirements" -ForegroundColor Green
    }
}
```

#### __Latency Testing__

Test network latency to your selected region:

```powershell
# Test latency to Azure region endpoints
function Test-RegionLatency {
    param([string]$Region)

    $endpoints = @{
        "eastus" = "eastus-management.azure.com"
        "westeurope" = "westeurope-management.azure.com"
        "southeastasia" = "southeastasia-management.azure.com"
    }

    $endpoint = $endpoints[$Region]
    if ($endpoint) {
        Write-Host "Testing latency to $Region..." -ForegroundColor Yellow
        $latency = Test-Connection -ComputerName $endpoint -Count 4 |
            Measure-Object -Property ResponseTime -Average

        $avgLatency = [math]::Round($latency.Average, 2)
        Write-Host "Average latency: $avgLatency ms" -ForegroundColor Cyan

        if ($avgLatency -lt 50) {
            Write-Host "✅ Excellent latency for interactive workloads" -ForegroundColor Green
        } elseif ($avgLatency -lt 150) {
            Write-Host "⚠️ Acceptable latency, consider closer region for real-time workloads" -ForegroundColor Yellow
        } else {
            Write-Host "❌ High latency, strongly recommend selecting closer region" -ForegroundColor Red
        }
    }
}

Test-RegionLatency -Region $location
```

### __4.2 Regional Cost Estimation__

Understand cost variations across regions:

```powershell
# Calculate estimated costs for selected region
function Get-RegionalCostEstimate {
    param(
        [string]$Region,
        [int]$SparkHoursPerMonth = 100,
        [int]$StorageGB = 1000
    )

    # Pricing multipliers (relative to East US baseline)
    $pricingMultipliers = @{
        "eastus" = 1.0
        "eastus2" = 1.0
        "westeurope" = 1.10
        "northeurope" = 1.10
        "uksouth" = 1.15
        "southeastasia" = 1.15
        "australiaeast" = 1.20
    }

    # Base pricing (East US)
    $baseSparkCostPerHour = 0.50
    $baseStorageCostPerGB = 0.02

    $multiplier = $pricingMultipliers[$Region]
    if (-not $multiplier) { $multiplier = 1.0 }

    $sparkCost = $SparkHoursPerMonth * $baseSparkCostPerHour * $multiplier
    $storageCost = $StorageGB * $baseStorageCostPerGB * $multiplier
    $totalCost = $sparkCost + $storageCost

    Write-Host "💰 Estimated Monthly Costs for $Region" -ForegroundColor Cyan
    Write-Host "   Spark Pool (100 hours): `$$([math]::Round($sparkCost, 2))"
    Write-Host "   Storage (1TB): `$$([math]::Round($storageCost, 2))"
    Write-Host "   Total Estimate: `$$([math]::Round($totalCost, 2))"
    Write-Host ""

    return $totalCost
}

Get-RegionalCostEstimate -Region $location
```

> __💡 Regional Guidance__: For this tutorial series, we recommend:
>
> - __North America__: East US or East US 2 (lowest cost, all features)
> - __Europe__: West Europe (GDPR compliant, good latency)
> - __Asia Pacific__: Southeast Asia (regional hub, good connectivity)
> - __UK__: UK South (data residency, GDPR compliant)
>
> __See Also__: [Azure Regions Reference](../../reference/azure-regions.md) | [Regional Compliance Guide](../../reference/regional-compliance.md)

## 🏗️ Step 5: Resource Naming Convention

### __5.1 Define Naming Standards__

Establish consistent naming patterns for all tutorial resources:

```powershell
# Define naming convention variables (using selected region)
$subscriptionId = (az account show --query "id" --output tsv)
$locationShort = switch ($location) {
    "eastus" { "eus" }
    "eastus2" { "eus2" }
    "westeurope" { "weu" }
    "northeurope" { "neu" }
    "uksouth" { "uks" }
    "southeastasia" { "sea" }
    "australiaeast" { "aue" }
    default { $location.Substring(0, 3) }
}
$environment = "dev"
$project = "syntut"  # synapse tutorial abbreviated

# Generate unique suffix
$uniqueSuffix = [System.Guid]::NewGuid().ToString().Substring(0, 8)

# Create naming convention object
$namingConvention = @{
    'Location' = $location
    'LocationName' = $locationName
    'ResourceGroupName' = "rg-$project-$environment-$locationShort"
    'SynapseWorkspace' = "syn-$project-$environment-$uniqueSuffix"
    'StorageAccount' = "st$project$environment$uniqueSuffix"  # Storage names must be globally unique
    'KeyVault' = "kv-$project-$environment-$uniqueSuffix"
    'SqlPool' = "sql-$project-$environment"
    'SparkPool' = "spark-$project-$environment"
}

# Save naming convention for use in subsequent tutorials
$namingConvention | ConvertTo-Json | Out-File "naming-convention.json"
Write-Host "✅ Naming convention saved to naming-convention.json" -ForegroundColor Green
Write-Host "   Region: $($namingConvention.LocationName) ($($namingConvention.Location))" -ForegroundColor Cyan
```

### __5.2 Validate Naming Convention__

Ensure names comply with Azure requirements:

```powershell
# Function to validate Azure resource names
function Test-AzureResourceName {
    param(
        [string]$Name,
        [string]$ResourceType
    )

    switch ($ResourceType) {
        'StorageAccount' {
            if ($Name.Length -gt 24 -or $Name -notmatch '^[a-z0-9]+$') {
                Write-Warning "Storage account name '$Name' is invalid. Must be 3-24 characters, lowercase letters and numbers only."
                return $false
            }
        }
        'SynapseWorkspace' {
            if ($Name.Length -gt 50 -or $Name -notmatch '^[a-zA-Z0-9-]+$') {
                Write-Warning "Synapse workspace name '$Name' is invalid. Must be 1-50 characters, letters, numbers, and hyphens only."
                return $false
            }
        }
    }
    return $true
}

# Validate our naming convention
$namingConvention = Get-Content "naming-convention.json" | ConvertFrom-Json
Test-AzureResourceName -Name $namingConvention.StorageAccount -ResourceType "StorageAccount"
Test-AzureResourceName -Name $namingConvention.SynapseWorkspace -ResourceType "SynapseWorkspace"
```

## ✅ Step 6: Environment Validation

### __6.1 Run Comprehensive Validation Script__

Create and execute a validation script to ensure everything is properly configured:

```powershell
# Create comprehensive validation script
$validationScript = @'
# Azure Synapse Tutorial Environment Validation Script
Write-Host "🔍 Validating Azure Synapse Tutorial Environment..." -ForegroundColor Cyan

$errors = @()
$warnings = @()

# Test 1: Azure CLI Authentication
Write-Host "Testing Azure CLI authentication..." -ForegroundColor Yellow
try {
    $account = az account show --query "id" --output tsv
    if ($account) {
        Write-Host "✅ Azure CLI authenticated successfully" -ForegroundColor Green
    } else {
        $errors += "❌ Azure CLI not authenticated"
    }
} catch {
    $errors += "❌ Azure CLI authentication failed: $_"
}

# Test 2: Required PowerShell Modules
Write-Host "Checking PowerShell modules..." -ForegroundColor Yellow
$requiredModules = @('Az.Accounts', 'Az.Synapse', 'Az.Storage', 'Az.Resources')
foreach ($module in $requiredModules) {
    if (Get-Module -ListAvailable -Name $module) {
        Write-Host "✅ Module $module installed" -ForegroundColor Green
    } else {
        $warnings += "⚠️ Module $module not installed (will install when needed)"
    }
}

# Test 3: Tool Availability  
Write-Host "Checking tool availability..." -ForegroundColor Yellow
$tools = @{
    'az' = 'Azure CLI'
    'git' = 'Git'
    'python' = 'Python'
    'code' = 'VS Code (optional)'
}

foreach ($tool in $tools.GetEnumerator()) {
    try {
        $null = Get-Command $tool.Key -ErrorAction Stop
        Write-Host "✅ $($tool.Value) available" -ForegroundColor Green
    } catch {
        if ($tool.Key -eq 'code') {
            $warnings += "⚠️ $($tool.Value) not found (optional)"
        } else {
            $errors += "❌ $($tool.Value) not found"
        }
    }
}

# Test 4: Resource Provider Registration
Write-Host "Checking resource provider registration..." -ForegroundColor Yellow
$providers = @('Microsoft.Synapse', 'Microsoft.Storage', 'Microsoft.EventHub')
foreach ($provider in $providers) {
    $status = az provider show --namespace $provider --query "registrationState" --output tsv
    if ($status -eq 'Registered') {
        Write-Host "✅ $provider registered" -ForegroundColor Green
    } else {
        $warnings += "⚠️ $provider not registered (status: $status)"
    }
}

# Test 5: Subscription Quotas
Write-Host "Checking subscription quotas..." -ForegroundColor Yellow
try {
    $location = "East US"
    $quotas = az vm list-usage --location $location --output json | ConvertFrom-Json
    $coresQuota = $quotas | Where-Object {$_.name.localizedValue -eq "Total Regional Cores"}
    
    if ($coresQuota.currentValue -lt ($coresQuota.limit - 20)) {
        Write-Host "✅ Sufficient compute quota available" -ForegroundColor Green
    } else {
        $warnings += "⚠️ Limited compute quota remaining"
    }
} catch {
    $warnings += "⚠️ Unable to check compute quotas"
}

# Summary
Write-Host "`n🎯 Validation Summary:" -ForegroundColor Cyan
if ($errors.Count -eq 0) {
    Write-Host "✅ Environment validation passed! Ready to proceed with tutorials." -ForegroundColor Green
    if ($warnings.Count -gt 0) {
        Write-Host "`nWarnings:" -ForegroundColor Yellow
        $warnings | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    }
} else {
    Write-Host "❌ Environment validation failed. Please resolve the following issues:" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    if ($warnings.Count -gt 0) {
        Write-Host "`nAdditional warnings:" -ForegroundColor Yellow
        $warnings | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    }
}
'@

# Save and execute validation script
$validationScript | Out-File "validate-environment.ps1"
.\validate-environment.ps1
```

### __6.2 Create Resource Group for Tutorials__

Create the main resource group that will contain all tutorial resources:

```powershell
# Load naming convention
$naming = Get-Content "naming-convention.json" | ConvertFrom-Json

# Create resource group
az group create \
  --name $naming.ResourceGroupName \
  --location "East US" \
  --tags Project=SynapseTutorial Environment=Learning

Write-Host "✅ Resource group '$($naming.ResourceGroupName)' created successfully" -ForegroundColor Green
```

### __6.3 Test Azure Connectivity__

Verify network connectivity to Azure services:

```powershell
# Test connectivity to key Azure endpoints
$endpoints = @(
    'https://management.azure.com',
    'https://login.microsoftonline.com',
    'https://graph.microsoft.com'
)

foreach ($endpoint in $endpoints) {
    try {
        $response = Invoke-WebRequest -Uri $endpoint -Method Head -TimeoutSec 10
        Write-Host "✅ Connectivity to $endpoint: OK" -ForegroundColor Green
    } catch {
        Write-Host "❌ Connectivity to $endpoint: Failed" -ForegroundColor Red
    }
}
```

## 📊 Step 7: Cost Estimation and Budget Planning

### __7.1 Estimate Tutorial Costs__

Understand the cost implications of running the complete tutorial series:

```powershell
# Tutorial cost estimation (approximate monthly costs)
$costEstimate = @{
    'Synapse Workspace' = '$0 (free tier available)'
    'Spark Pool (Medium)' = '$50-100/month (auto-pause enabled)'
    'Dedicated SQL Pool' = '$1,000+/month (DW100c, pause when not in use)'
    'Storage (ADLS Gen2)' = '$5-15/month'
    'Event Hubs' = '$10-20/month'
    'Power BI Premium' = '$20/user/month (Pro tier sufficient for tutorials)'
}

Write-Host "💰 Estimated Monthly Costs for Tutorial Environment:" -ForegroundColor Cyan
$costEstimate.GetEnumerator() | Sort-Object Key | ForEach-Object {
    Write-Host "  $($_.Key): $($_.Value)" -ForegroundColor White
}
```

### __7.2 Configure Auto-Pause and Scaling__

Set up automatic resource management to minimize costs:

```powershell
# Create configuration for auto-scaling and pausing
$autoScaleConfig = @{
    'SparkPool' = @{
        'AutoPause' = @{
            'Enabled' = $true
            'DelayInMinutes' = 15
        }
        'AutoScale' = @{
            'Enabled' = $true
            'MinNodeCount' = 3
            'MaxNodeCount' = 10
        }
    }
    'DedicatedSQLPool' = @{
        'AutoPause' = @{
            'Enabled' = $true
            'DelayInMinutes' = 60
        }
        'AutoScale' = @{
            'Enabled' = $false  # Manual scaling recommended
            'TargetServiceLevelObjective' = 'DW100c'
        }
    }
}

# Save configuration for use in later tutorials
$autoScaleConfig | ConvertTo-Json -Depth 3 | Out-File "auto-scale-config.json"
```

## 🎯 Step 8: Next Steps Preparation

### __8.1 Download Tutorial Assets__

Prepare sample data and scripts for upcoming tutorials:

```powershell
# Create directory structure for tutorial assets
$assetDirs = @(
    'sample-data',
    'scripts',
    'notebooks',
    'sql-scripts',
    'config-files'
)

foreach ($dir in $assetDirs) {
    New-Item -ItemType Directory -Path $dir -Force
    Write-Host "✅ Created directory: $dir" -ForegroundColor Green
}

# Download sample datasets (placeholder URLs - replace with actual assets)
$sampleData = @{
    'customer-data.csv' = 'https://raw.githubusercontent.com/your-org/synapse-tutorials/main/data/customers.csv'
    'transaction-data.json' = 'https://raw.githubusercontent.com/your-org/synapse-tutorials/main/data/transactions.json'
    'product-catalog.parquet' = 'https://raw.githubusercontent.com/your-org/synapse-tutorials/main/data/products.parquet'
}

foreach ($dataset in $sampleData.GetEnumerator()) {
    try {
        Invoke-WebRequest -Uri $dataset.Value -OutFile "sample-data\$($dataset.Key)"
        Write-Host "✅ Downloaded: $($dataset.Key)" -ForegroundColor Green
    } catch {
        Write-Host "⚠️ Could not download $($dataset.Key) - will create synthetic data in next tutorial" -ForegroundColor Yellow
    }
}
```

### __8.2 Create Environment Summary__

Document your setup for reference:

```powershell
# Create environment summary document
$environmentSummary = @"
# Azure Synapse Tutorial Environment Summary

## Setup Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')

## Azure Configuration
- Subscription ID: $(az account show --query "id" --output tsv)
- Default Location: East US
- Resource Group: $($naming.ResourceGroupName)

## Naming Convention
$(Get-Content "naming-convention.json" | ConvertFrom-Json | ConvertTo-Json)

## Tools Installed
- Azure CLI: $(az version --query '\"azure-cli\"' --output tsv)
- Azure PowerShell: $(if (Get-Module Az.Accounts -ListAvailable) { 'Installed' } else { 'Not Installed' })
- Git: $(if (Get-Command git -ErrorAction SilentlyContinue) { git --version } else { 'Not Available' })
- Python: $(if (Get-Command python -ErrorAction SilentlyContinue) { python --version } else { 'Not Available' })

## Cost Management
- Budget Name: synapse-tutorial-budget
- Budget Amount: $100/month
- Auto-pause Configuration: Enabled
- Resource Tags: Applied for cost tracking

## Next Steps
1. Proceed to Tutorial 2: Synapse Workspace Basics
2. Review cost monitoring dashboard regularly
3. Remember to pause/stop resources when not in use

## Support
- Documentation: https://docs.microsoft.com/azure/synapse-analytics/
- Community: https://techcommunity.microsoft.com/t5/azure-synapse-analytics/bd-p/AzureSynapseAnalytics
- Issues: Create issues in the tutorial repository
"@

$environmentSummary | Out-File "environment-summary.md" -Encoding UTF8
Write-Host "✅ Environment summary saved to environment-summary.md" -ForegroundColor Green
```

## ✅ Checkpoint Validation

Before proceeding to the next tutorial, verify your setup:

### __Validation Checklist__

- [ ] __Azure CLI authenticated__ and connected to correct subscription
- [ ] __Resource providers registered__ for all required services
- [ ] __Development tools installed__ (VS Code, Git, Python)
- [ ] __Resource group created__ with proper naming convention
- [ ] __Budget and cost alerts configured__
- [ ] __Sample data downloaded__ and organized
- [ ] __Environment validation script passed__ without errors

### __Quick Validation Command__

```powershell
# Run final validation
Write-Host "🔍 Final Environment Check..." -ForegroundColor Cyan

# Check resource group exists
$rgExists = az group exists --name (Get-Content "naming-convention.json" | ConvertFrom-Json).ResourceGroupName
if ($rgExists -eq 'true') {
    Write-Host "✅ Resource group exists and ready" -ForegroundColor Green
} else {
    Write-Host "❌ Resource group not found" -ForegroundColor Red
}

# Check configuration files exist
$configFiles = @('naming-convention.json', 'auto-scale-config.json', 'environment-summary.md')
foreach ($file in $configFiles) {
    if (Test-Path $file) {
        Write-Host "✅ Configuration file exists: $file" -ForegroundColor Green
    } else {
        Write-Host "⚠️ Configuration file missing: $file" -ForegroundColor Yellow
    }
}

Write-Host "`n🎯 Environment setup complete! Ready for Tutorial 2." -ForegroundColor Green
```

## 🎉 Congratulations

You've successfully set up your Azure environment for the Synapse Analytics tutorial series. Your setup includes:

- ✅ __Authenticated Azure environment__ with proper permissions
- ✅ __Essential development tools__ installed and configured
- ✅ __Cost management__ and budget monitoring in place
- ✅ __Consistent naming convention__ for all resources
- ✅ __Validated environment__ ready for hands-on learning

## 🚀 What's Next?

__Continue to Tutorial 2__: [Synapse Workspace Basics](02-workspace-basics.md)

In the next tutorial, you'll:

- Create your first Synapse workspace
- Explore the Synapse Studio interface
- Configure basic security and networking
- Set up your first Spark and SQL pools

## 💡 Troubleshooting

### __Common Issues and Solutions__

__Issue__: Azure CLI login fails

```powershell
# Clear cached credentials and retry
az account clear
az login --use-device-code
```

__Issue__: Insufficient permissions error  

```powershell
# Verify your role assignments
az role assignment list --assignee $(az account show --query user.name --output tsv) --output table
```

__Issue__: Resource provider registration stuck

```powershell
# Force re-registration
az provider register --namespace Microsoft.Synapse --wait
```

__Issue__: PowerShell execution policy blocks scripts

```powershell
# Set execution policy for current user
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

---

__Tutorial Progress__: 1 of 14 completed  
__Next__: [02. Synapse Workspace Basics →](02-workspace-basics.md)  
__Time Investment__: 30 minutes ✅

*Environment setup is the foundation of success. Take time to ensure everything is properly configured before proceeding.*
