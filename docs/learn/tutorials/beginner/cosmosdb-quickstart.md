# 🌐 Azure Cosmos DB Quickstart

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-40--50_minutes-blue)

__Get started with Azure Cosmos DB in under an hour. Learn to create a globally distributed NoSQL database and perform basic CRUD operations.__

## 🎯 Learning Objectives

After completing this quickstart, you will be able to:

- Understand what Azure Cosmos DB is and its key features
- Create a Cosmos DB account with Core (SQL) API
- Create databases, containers, and items
- Perform CRUD operations using Python SDK
- Query data with SQL-like syntax
- Monitor performance and costs

## 📋 Prerequisites

Before starting, ensure you have:

- [ ] __Azure subscription__ - [Create free account](https://azure.microsoft.com/free/)
- [ ] __Python 3.7+__ - [Download Python](https://python.org/downloads/)
- [ ] __Azure Portal access__ - [portal.azure.com](https://portal.azure.com)
- [ ] __Code editor__ - VS Code recommended
- [ ] __Basic JSON knowledge__ - Understanding of key-value pairs

## 🔍 What is Azure Cosmos DB?

Azure Cosmos DB is a fully managed, globally distributed, multi-model NoSQL database service designed for:

- __Global distribution__ - Multi-region writes and reads
- __Low latency__ - Single-digit millisecond response times
- __High availability__ - 99.999% SLA
- __Flexible scaling__ - Elastic throughput and storage
- __Multiple APIs__ - SQL, MongoDB, Cassandra, Gremlin, Table

### __Key Concepts__

- __Account__: Top-level resource containing databases
- __Database__: Logical namespace for containers
- __Container__: Collection of items (like a table)
- __Item__: Individual JSON document
- __Partition Key__: Property used to distribute data

### __When to Use Cosmos DB__

✅ __Good For:__

- Globally distributed applications
- Low-latency requirements (<10ms)
- IoT and telemetry data
- Real-time analytics
- User profiles and catalogs
- Shopping carts and session data

❌ __Not Ideal For:__

- Traditional relational data (use SQL Database)
- Complex joins across tables
- Very large analytical queries (use Synapse)

## 🚀 Step 1: Create Cosmos DB Account

### __Using Azure Portal__

1. __Navigate to Azure Portal__
   - Go to [portal.azure.com](https://portal.azure.com)
   - Click "Create a resource"
   - Search for "Azure Cosmos DB"
   - Click "Create"

2. __Select API__
   - Choose __"Core (SQL)"__ - Recommended for beginners
   - Click "Create"

3. __Configure Basics__
   - __Subscription__: Select your subscription
   - __Resource Group__: Create new "rg-cosmos-quickstart"
   - __Account Name__: "cosmos-quickstart-[yourname]" (globally unique)
   - __Location__: Select nearest region
   - __Capacity mode__: Provisioned throughput
   - __Apply Free Tier Discount__: Yes (if available)

4. __Global Distribution__
   - __Geo-Redundancy__: Disable (for quickstart)
   - __Multi-region Writes__: Disable (for quickstart)

5. __Review and Create__
   - Click "Review + create"
   - Click "Create"
   - Wait 5-10 minutes for deployment

### __Using Azure CLI__

```bash
# Set variables
RESOURCE_GROUP="rg-cosmos-quickstart"
LOCATION="eastus"
ACCOUNT_NAME="cosmos-quickstart-$RANDOM"

# Create resource group
az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create Cosmos DB account
az cosmosdb create \
  --name $ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP \
  --locations regionName=$LOCATION failoverPriority=0 \
  --enable-free-tier true

echo "Cosmos DB Account: $ACCOUNT_NAME"
```

## 🗄️ Step 2: Create Database and Container

### __Using Azure Portal__

1. __Navigate to Data Explorer__
   - Go to your Cosmos DB account
   - Click "Data Explorer" in left menu

2. __Create Database__
   - Click "New Database"
   - __Database id__: "SampleDB"
   - __Provision throughput__: Uncheck (container-level)
   - Click "OK"

3. __Create Container__
   - Click "New Container"
   - __Database id__: Use existing "SampleDB"
   - __Container id__: "Products"
   - __Partition key__: `/category`
   - __Throughput__: 400 RU/s (minimum)
   - Click "OK"

### __Using Python SDK__

```bash
# Install SDK
pip install azure-cosmos
```

```python
"""
Create Cosmos DB database and container
"""
from azure.cosmos import CosmosClient, PartitionKey
import os

# Configuration
ENDPOINT = "https://your-account-name.documents.azure.com:443/"
KEY = "your-primary-key"  # Get from Azure Portal > Keys

# Create client
client = CosmosClient(ENDPOINT, KEY)

# Create database
database = client.create_database_if_not_exists(id="SampleDB")
print(f"✅ Database created: {database.id}")

# Create container
container = database.create_container_if_not_exists(
    id="Products",
    partition_key=PartitionKey(path="/category"),
    offer_throughput=400
)
print(f"✅ Container created: {container.id}")
```

## 📝 Step 3: Insert Data (Create)

### __Using Data Explorer__

1. Navigate to "Products" container
2. Click "New Item"
3. Replace default JSON with:

```json
{
    "id": "laptop-001",
    "name": "Gaming Laptop",
    "category": "Electronics",
    "price": 1299.99,
    "inStock": true,
    "specs": {
        "processor": "Intel i7",
        "ram": "16GB",
        "storage": "512GB SSD"
    },
    "tags": ["gaming", "laptop", "high-performance"]
}
```

4. Click "Save"

### __Using Python SDK__

```python
"""
Insert items into Cosmos DB
"""
from azure.cosmos import CosmosClient

# Configuration
ENDPOINT = "https://your-account-name.documents.azure.com:443/"
KEY = "your-primary-key"

# Create client and get container
client = CosmosClient(ENDPOINT, KEY)
database = client.get_database_client("SampleDB")
container = database.get_container_client("Products")

# Define products
products = [
    {
        "id": "laptop-001",
        "name": "Gaming Laptop",
        "category": "Electronics",
        "price": 1299.99,
        "inStock": True,
        "specs": {
            "processor": "Intel i7",
            "ram": "16GB",
            "storage": "512GB SSD"
        }
    },
    {
        "id": "desk-001",
        "name": "Standing Desk",
        "category": "Furniture",
        "price": 549.99,
        "inStock": True,
        "dimensions": {
            "width": 60,
            "depth": 30,
            "height": "adjustable"
        }
    },
    {
        "id": "monitor-001",
        "name": "4K Monitor",
        "category": "Electronics",
        "price": 399.99,
        "inStock": False,
        "specs": {
            "size": "27 inch",
            "resolution": "3840x2160"
        }
    }
]

# Insert items
for product in products:
    container.create_item(body=product)
    print(f"✅ Inserted: {product['name']}")

print(f"\n✅ Successfully inserted {len(products)} products")
```

## 📖 Step 4: Read Data

### __Read Single Item__

```python
"""
Read specific item by id and partition key
"""
# Read item
item_id = "laptop-001"
partition_key = "Electronics"

item = container.read_item(
    item=item_id,
    partition_key=partition_key
)

print(f"Product: {item['name']}")
print(f"Price: ${item['price']}")
print(f"In Stock: {item['inStock']}")
```

### __Query Multiple Items__

```python
"""
Query items using SQL-like syntax
"""
# Query all products
query = "SELECT * FROM Products p"
items = list(container.query_items(
    query=query,
    enable_cross_partition_query=True
))

print(f"Total products: {len(items)}")

# Query by category
query = "SELECT * FROM Products p WHERE p.category = 'Electronics'"
electronics = list(container.query_items(
    query=query,
    enable_cross_partition_query=True
))

for item in electronics:
    print(f"- {item['name']}: ${item['price']}")

# Query in-stock items
query = "SELECT * FROM Products p WHERE p.inStock = true"
in_stock = list(container.query_items(
    query=query,
    enable_cross_partition_query=True
))

print(f"\nIn stock: {len(in_stock)} items")
```

### __Using Data Explorer__

1. Navigate to "Products" container
2. Click "New SQL Query"
3. Enter query:

```sql
SELECT * FROM Products p WHERE p.price < 500
```

4. Click "Execute Query"
5. View results

## ✏️ Step 5: Update Data

```python
"""
Update existing item
"""
# Read item
item = container.read_item(
    item="laptop-001",
    partition_key="Electronics"
)

# Update fields
item['price'] = 1199.99  # Price reduction
item['inStock'] = True
item['lastUpdated'] = "2025-01-09"

# Replace item
container.replace_item(
    item=item['id'],
    body=item
)

print(f"✅ Updated {item['name']} to ${item['price']}")
```

## 🗑️ Step 6: Delete Data

```python
"""
Delete item
"""
# Delete item
container.delete_item(
    item="monitor-001",
    partition_key="Electronics"
)

print("✅ Deleted item")
```

## 💡 Understanding Partition Keys

The partition key is CRITICAL for performance and cost optimization.

### __Good Partition Keys__

✅ High cardinality (many unique values)
✅ Even distribution of data
✅ Commonly used in queries

```python
# Examples of good partition keys:
- userId (for user data)
- category (for product catalogs)
- deviceId (for IoT data)
- tenantId (for multi-tenant apps)
```

### __Bad Partition Keys__

❌ Low cardinality (few unique values)
❌ Hot partitions (uneven distribution)
❌ Not used in queries

```python
# Examples of bad partition keys:
- country (only ~200 values)
- boolean fields (only 2 values)
- timestamp (creates hot partition)
```

## 📊 Step 7: Monitor and Optimize

### __View Metrics__

1. Navigate to Cosmos DB account
2. Click "Metrics" in left menu
3. View:
   - __Total Requests__ - Request count
   - __Request Units__ - RU/s consumption
   - __Storage__ - Data size
   - __Throttled Requests__ - 429 errors

### __Estimate RU/s Cost__

```python
"""
Get RU charge for operations
"""
# Query with RU tracking
response = container.query_items(
    query="SELECT * FROM Products",
    enable_cross_partition_query=True
)

items = list(response)

# RU charge is in response headers
print(f"Query consumed: {response.get('x-ms-request-charge')} RU")
```

## 🔧 Troubleshooting

### __Common Issues__

__Error: "Entity with the specified id already exists"__

- ✅ Use `upsert_item()` instead of `create_item()`
- ✅ Check for duplicate IDs

__Error: "Request rate is large" (429)__

- ✅ You exceeded provisioned RU/s
- ✅ Solution: Increase RU/s or implement retry logic

__Error: "Partition key not found"__

- ✅ Ensure item has partition key property
- ✅ Verify partition key path matches container

__High Costs__

- ✅ Review RU/s consumption in metrics
- ✅ Reduce RU/s when not needed
- ✅ Optimize queries (use indexes)

## 🎓 Next Steps

### __Beginner Practice__

- [ ] Create different document types in same container
- [ ] Implement error handling and retries
- [ ] Query with filters and ordering
- [ ] Add more complex nested data

### __Intermediate Challenges__

- [ ] Implement stored procedures
- [ ] Use change feed for real-time updates
- [ ] Set up indexing policies
- [ ] Configure TTL (time-to-live)

### __Advanced Topics__

- [ ] Multi-region setup
- [ ] Implement consistency levels
- [ ] Use bulk operations
- [ ] Integrate with Azure Functions

## 📚 Additional Resources

### __Documentation__

- [Cosmos DB Overview](https://learn.microsoft.com/azure/cosmos-db/introduction)
- [Python SDK Reference](https://learn.microsoft.com/python/api/overview/azure/cosmos-readme)
- [Partitioning Best Practices](https://learn.microsoft.com/azure/cosmos-db/partitioning-overview)

### __Next Tutorials__

- [Synapse Quickstart](synapse-quickstart.md) - Query Cosmos DB with Synapse Link
- [Stream Analytics Tutorial](../stream-analytics/README.md) - Process Cosmos DB changes
- [Data Engineer Path](../learning-paths/data-engineer-path.md)

### __Tools__

- [Cosmos DB Emulator](https://learn.microsoft.com/azure/cosmos-db/local-emulator)
- [Data Explorer](https://cosmos.azure.com/)
- [Capacity Calculator](https://cosmos.azure.com/capacitycalculator/)

## 🧹 Cleanup

To avoid Azure charges, delete resources when done:

```bash
# Delete resource group
az group delete --name rg-cosmos-quickstart --yes --no-wait
```

Or use Azure Portal:

1. Navigate to Resource Groups
2. Select "rg-cosmos-quickstart"
3. Click "Delete resource group"
4. Type resource group name to confirm
5. Click "Delete"

## 🎉 Congratulations!

You've successfully:

✅ Created Azure Cosmos DB account
✅ Created database and container
✅ Performed CRUD operations
✅ Queried data with SQL syntax
✅ Understood partition keys and RU/s

You're ready to build globally distributed NoSQL applications!

---

__Next Recommended Tutorial:__ [Delta Lake Basics](delta-lake-basics.md) for analytics data storage

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
*Tested with: Python 3.11, azure-cosmos 4.5.1*
