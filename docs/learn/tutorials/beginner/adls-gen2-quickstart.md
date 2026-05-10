---
title: "Azure Data Lake Storage Gen2 Quickstart"
description: "__Get started with Azure Data Lake Storage Gen2 in under an hour. Learn to create storage, organize data with hierarchical namespaces, and access data efficiently.__"
tags:
  - tutorials
  - beginner
---
# 💾 Azure Data Lake Storage Gen2 Quickstart

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-30--40_minutes-blue)

__Get started with Azure Data Lake Storage Gen2 in under an hour. Learn to create storage, organize data with hierarchical namespaces, and access data efficiently.__

## 🎯 Learning Objectives

After completing this quickstart, you will be able to:

- Understand what ADLS Gen2 is and when to use it
- Create a storage account with hierarchical namespace enabled
- Upload and organize files in containers and directories
- Set access controls and permissions
- Access data using Azure Storage Explorer and Python SDK

## 📋 Prerequisites

Before starting, ensure you have:

- [ ] __Azure subscription__ - [Create free account](https://azure.microsoft.com/free/)
- [ ] __Azure Portal access__ - [portal.azure.com](https://portal.azure.com)
- [ ] __Azure Storage Explorer__ - [Download here](https://azure.microsoft.com/features/storage-explorer/)
- [ ] __Python 3.7+__ (optional for SDK examples) - [Download Python](https://python.org/downloads/)

## 🔍 What is Azure Data Lake Storage Gen2?

ADLS Gen2 combines the best of Azure Blob Storage and Azure Data Lake Storage Gen1, providing:

- __Hierarchical namespace__ - File system semantics (directories, ACLs)
- __Hadoop compatibility__ - Works with HDInsight, Databricks, Synapse
- __High performance__ - Optimized for analytics workloads
- __Low cost__ - Blob storage pricing with enterprise features

### __Key Concepts__

- __Storage Account__: Top-level container for storage resources
- __Container__: Similar to a bucket or file system root
- __Directory__: Hierarchical folder structure
- __File__: The actual data objects
- __ACLs__: POSIX-style access control lists

### __When to Use ADLS Gen2__

✅ __Good For:__

- Big data analytics with Spark, Hive, or Databricks
- Data lake architectures
- Machine learning data storage
- Data warehousing staging areas
- Hierarchical data organization

❌ __Not Ideal For:__

- Small file storage (use Blob Storage)
- Database storage (use SQL Database)
- Frequent small updates (use Cosmos DB)

## 🚀 Step 1: Create Storage Account

### __Using Azure Portal__

1. __Navigate to Azure Portal__
   - Go to [portal.azure.com](https://portal.azure.com)
   - Click "Create a resource"
   - Search for "Storage account"
   - Click "Create"

2. __Configure Basics__
   - __Subscription__: Select your subscription
   - __Resource Group__: Create new "rg-adls-quickstart"
   - __Storage Account Name__: "adlsquickstart[yourname]" (lowercase, no spaces)
   - __Region__: Select nearest region
   - __Performance__: Standard (or Premium for high IOPS)
   - __Redundancy__: LRS (Locally-redundant storage) for quickstart

3. __Enable Hierarchical Namespace__
   - Click "Advanced" tab
   - __Hierarchical namespace__: Check "Enable"
   - This creates a Data Lake Storage Gen2 account!

4. __Review and Create__
   - Click "Review + create"
   - Click "Create"
   - Wait 1-2 minutes for deployment

> **💡 Important:** Hierarchical namespace cannot be changed after creation!

## 📂 Step 2: Create Container and Directories

### __Using Azure Portal__

1. __Navigate to Storage Account__
   - Go to your storage account
   - Click "Containers" in left menu

2. __Create Container__
   - Click "+ Container"
   - __Name__: "data"
   - __Public access level__: Private (no anonymous access)
   - Click "Create"

3. __Create Directory Structure__
   - Click on "data" container
   - Click "+ Add Directory"
   - Create these directories:
     - `raw` - For raw ingested data
     - `processed` - For processed/transformed data
     - `curated` - For business-ready data

### __Using Azure CLI__

```bash
# Set variables
RESOURCE_GROUP="rg-adls-quickstart"
STORAGE_ACCOUNT="adlsquickstart$RANDOM"
LOCATION="eastus"

# Create storage account with hierarchical namespace
az storage account create \
  --name $STORAGE_ACCOUNT \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --sku Standard_LRS \
  --kind StorageV2 \
  --hierarchical-namespace true

# Create container
az storage container create \
  --name data \
  --account-name $STORAGE_ACCOUNT \
  --auth-mode login

# Create directories
az storage fs directory create \
  --name raw \
  --file-system data \
  --account-name $STORAGE_ACCOUNT \
  --auth-mode login

az storage fs directory create \
  --name processed \
  --file-system data \
  --account-name $STORAGE_ACCOUNT \
  --auth-mode login

az storage fs directory create \
  --name curated \
  --file-system data \
  --account-name $STORAGE_ACCOUNT \
  --auth-mode login

echo "Storage Account: $STORAGE_ACCOUNT"
```

## 📤 Step 3: Upload Data

### __Create Sample Data File__

Create a file named `sales.csv`:

```csv
order_id,customer_id,product,category,amount,order_date
1001,C101,Laptop,Electronics,1299.99,2024-01-15
1002,C102,Chair,Furniture,249.99,2024-01-15
1003,C101,Monitor,Electronics,399.99,2024-01-16
1004,C103,Desk,Furniture,549.99,2024-01-16
1005,C102,Keyboard,Electronics,89.99,2024-01-17
```

### __Using Azure Storage Explorer__

1. __Open Storage Explorer__
   - Launch Azure Storage Explorer
   - Sign in with your Azure account

2. __Navigate to Container__
   - Expand your subscription
   - Expand "Storage Accounts"
   - Expand your storage account
   - Expand "Blob Containers"
   - Click "data" container

3. __Upload File__
   - Click "Upload" button
   - Select "Upload Files"
   - Choose `sales.csv`
   - Set destination to `raw/sales.csv`
   - Click "Upload"

### __Using Azure Portal__

1. Navigate to "data" container
2. Click on "raw" directory
3. Click "Upload"
4. Select `sales.csv`
5. Click "Upload"

### __Using Python SDK__

```python
"""
Upload file to ADLS Gen2
"""
from azure.storage.filedatalake import DataLakeServiceClient
from azure.identity import DefaultAzureCredential

# Configuration
STORAGE_ACCOUNT = "your-storage-account-name"
CONTAINER = "data"
DIRECTORY = "raw"
FILE_NAME = "sales.csv"

# Create service client
credential = DefaultAzureCredential()
service_client = DataLakeServiceClient(
    account_url=f"https://{STORAGE_ACCOUNT}.dfs.core.windows.net",
    credential=credential
)

# Get file system (container) client
file_system_client = service_client.get_file_system_client(CONTAINER)

# Get directory client
directory_client = file_system_client.get_directory_client(DIRECTORY)

# Get file client
file_client = directory_client.get_file_client(FILE_NAME)

# Upload file
with open(FILE_NAME, "rb") as data:
    file_client.upload_data(data, overwrite=True)
    print(f"✅ Uploaded {FILE_NAME} to {DIRECTORY}/")
```

## 🔐 Step 4: Set Access Controls

ADLS Gen2 supports both RBAC and ACLs for fine-grained access control.

### __Assign RBAC Role__

1. __Navigate to Storage Account__
   - Click "Access Control (IAM)" in left menu
   - Click "+ Add" > "Add role assignment"

2. __Select Role__
   - Search for "Storage Blob Data Contributor"
   - Click the role
   - Click "Next"

3. __Assign Access__
   - Select "User, group, or service principal"
   - Click "+ Select members"
   - Search for your user or app
   - Click "Select"
   - Click "Review + assign"

### __Set Directory ACLs__

```bash
# Get user object ID
USER_ID=$(az ad signed-in-user show --query id --output tsv)

# Set ACL on raw directory (read, write, execute)
az storage fs access set \
  --acl "user:${USER_ID}:rwx" \
  --path raw \
  --file-system data \
  --account-name $STORAGE_ACCOUNT
```

## 📥 Step 5: Access and Query Data

### __Using Azure Storage Explorer__

1. Navigate to your file in Storage Explorer
2. Right-click the file
3. Select "Open" to download and view
4. Select "Properties" to see metadata

### __Using Python SDK__

```python
"""
Read file from ADLS Gen2
"""
from azure.storage.filedatalake import DataLakeServiceClient
from azure.identity import DefaultAzureCredential
import pandas as pd
from io import StringIO

# Configuration
STORAGE_ACCOUNT = "your-storage-account-name"
CONTAINER = "data"
FILE_PATH = "raw/sales.csv"

# Create service client
credential = DefaultAzureCredential()
service_client = DataLakeServiceClient(
    account_url=f"https://{STORAGE_ACCOUNT}.dfs.core.windows.net",
    credential=credential
)

# Get file system client
file_system_client = service_client.get_file_system_client(CONTAINER)

# Get file client
file_client = file_system_client.get_file_client(FILE_PATH)

# Download and read file
download = file_client.download_file()
content = download.readall().decode('utf-8')

# Parse CSV
df = pd.read_csv(StringIO(content))
print(df.head())
print(f"\nTotal rows: {len(df)}")
```

### __Using Azure Synapse or Databricks__

```python
# Synapse Spark
df = spark.read.csv(
    "abfss://data@your-storage-account.dfs.core.windows.net/raw/sales.csv",
    header=True,
    inferSchema=True
)
df.show()

# Databricks
df = spark.read.format("csv") \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .load("abfss://data@your-storage-account.dfs.core.windows.net/raw/sales.csv")
df.display()
```

## 🏗️ Best Practices

### __Directory Organization__

```textdata/
├── raw/              # Raw ingested data (immutable)
│   ├── year=2024/
│   │   ├── month=01/
│   │   │   └── sales_20240115.csv
├── processed/        # Cleaned and transformed data
│   ├── year=2024/
│   │   ├── month=01/
│   │   │   └── sales_cleaned.parquet
└── curated/          # Business-ready datasets
    └── sales_summary/
        └── sales_monthly.parquet
```

### __Naming Conventions__

- Use lowercase for consistency
- Use hyphens for multi-word names
- Include date/time in file names: `sales_20240115_103045.csv`
- Use partitioning for large datasets: `year=2024/month=01/`

### __Performance Optimization__

1. __Use Parquet format__ for analytics (columnar, compressed)
2. __Partition large datasets__ by date or category
3. __Enable lifecycle management__ to move old data to cool/archive tiers
4. __Use concurrent uploads__ for large file sets

## 🔧 Troubleshooting

### __Common Issues__

__Error: "Hierarchical namespace not enabled"__

- ✅ Create new storage account with HNS enabled
- ❌ Cannot enable on existing account

__Error: "Forbidden" or "Authorization failed"__

- ✅ Check RBAC role assignment
- ✅ Verify ACL permissions
- ✅ Wait 5-10 minutes for permissions to propagate

__Slow Upload/Download__

- ✅ Use Azure Storage Explorer for GUI
- ✅ Use AzCopy for bulk transfers
- ✅ Enable concurrent operations

__Cannot Access from Synapse/Databricks__

- ✅ Verify storage account firewall settings
- ✅ Check managed identity permissions
- ✅ Use correct URL format: `abfss://`

## 🎓 Next Steps

### __Beginner Practice__

- [ ] Create additional directories for your data
- [ ] Upload multiple files
- [ ] Set different ACLs for different users
- [ ] Organize data using partitioning strategy

### __Intermediate Challenges__

- [ ] Implement lifecycle management policies
- [ ] Use AzCopy for bulk data transfer
- [ ] Set up Azure Monitor alerts
- [ ] Integrate with Azure Data Factory

### __Advanced Topics__

- [ ] Implement data lake zones (raw/bronze, processed/silver, curated/gold)
- [ ] Set up Azure Purview for data governance
- [ ] Configure private endpoints
- [ ] Implement encryption with customer-managed keys

## 📚 Additional Resources

### __Documentation__

- [ADLS Gen2 Overview](https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction)
- [Access Control in ADLS Gen2](https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-access-control)
- [Best Practices](https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-best-practices)

### __Next Tutorials__

- [Databricks Quickstart](databricks-quickstart.md) - Use Databricks with ADLS Gen2
- [Delta Lake Basics](delta-lake-basics.md) - Store data in Delta format
- [Data Engineer Path](../learning-paths/data-engineer-path.md)

### __Tools__

- [Azure Storage Explorer](https://azure.microsoft.com/features/storage-explorer/)
- [AzCopy](https://learn.microsoft.com/azure/storage/common/storage-use-azcopy-v10)
- [Azure Data Lake Tools for VS Code](https://marketplace.visualstudio.com/items?itemName=usqlextpublisher.usql-vscode-ext)

## 🧹 Cleanup

To avoid Azure charges, delete resources when done:

```bash
# Delete resource group (deletes everything)
az group delete --name rg-adls-quickstart --yes --no-wait
```

Or use Azure Portal:

1. Navigate to Resource Groups
2. Select "rg-adls-quickstart"
3. Click "Delete resource group"
4. Type resource group name to confirm
5. Click "Delete"

## 🎉 Congratulations!

You've successfully:

✅ Created an Azure Data Lake Storage Gen2 account
✅ Organized data with hierarchical namespaces
✅ Uploaded and accessed files
✅ Set access controls and permissions
✅ Learned best practices for data organization

You're ready to build scalable data lake solutions!

---

__Next Recommended Tutorial:__ [Delta Lake Basics](delta-lake-basics.md) to learn about transactional data lakes

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
*Tested with: Azure Storage Account with HNS enabled*
