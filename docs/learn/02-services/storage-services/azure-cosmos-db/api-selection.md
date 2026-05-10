---
title: "API Selection Guide for Azure Cosmos DB"
description: "Choose the right API for your application based on data model, query patterns, and migration requirements."
tags:
  - services
  - cosmos-db
---
# 🔌 API Selection Guide for Azure Cosmos DB

![Multi-Model](https://img.shields.io/badge/APIs-5%20Supported-blue?style=flat-square)

Choose the right API for your application based on data model, query patterns, and migration requirements.

---

## 🎯 API Comparison Matrix

| API | Data Model | Query Language | Best For | Migration From |
|-----|------------|----------------|----------|----------------|
| __SQL (Core)__ | JSON documents | SQL-like | New applications | - |
| __MongoDB__ | BSON documents | MongoDB query | Existing MongoDB apps | MongoDB |
| __Cassandra__ | Wide-column | CQL | High-scale writes | Apache Cassandra |
| __Gremlin__ | Graph | Gremlin traversal | Connected data | Neo4j, TinkerPop |
| __Table__ | Key-value | OData/LINQ | Simple lookups | Azure Table Storage |

---

## 📊 SQL (Core) API

### When to Use

- Building new cloud-native applications
- Flexible JSON document storage
- Rich SQL query capabilities
- Need for transactions and stored procedures

### Example Usage

```python
from azure.cosmos import CosmosClient

client = CosmosClient(url="<cosmos-url>", credential="<credential>")
database = client.get_database_client("ecommerce")
container = database.get_container_client("products")

# Create document
product = {
    "id": "prod-001",
    "name": "Laptop",
    "category": "Electronics",
    "price": 999.99,
    "inventory": {"warehouse": "WH-01", "quantity": 50}
}
container.create_item(body=product)

# Query with SQL
query = """
    SELECT p.id, p.name, p.price 
    FROM products p 
    WHERE p.category = @category AND p.price < @maxPrice
"""
results = container.query_items(
    query=query,
    parameters=[
        {"name": "@category", "value": "Electronics"},
        {"name": "@maxPrice", "value": 1000}
    ]
)
```

---

## 🍃 MongoDB API

### When to Use

- Migrating from MongoDB
- Using MongoDB tools and drivers
- Need for MongoDB aggregation pipeline
- Existing MongoDB expertise in team

### Example Usage

```python
from pymongo import MongoClient

client = MongoClient("mongodb://<cosmos-account>.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb")
db = client['ecommerce']
products = db['products']

# Insert document
product = {
    "_id": "prod-001",
    "name": "Laptop",
    "category": "Electronics",
    "price": 999.99,
    "specs": {"cpu": "Intel i7", "ram": "16GB"}
}
products.insert_one(product)

# Aggregation pipeline
pipeline = [
    {"$match": {"category": "Electronics"}},
    {"$group": {"_id": "$category", "avgPrice": {"$avg": "$price"}}},
    {"$sort": {"avgPrice": -1}}
]
results = products.aggregate(pipeline)
```

---

## 🔷 Cassandra API

### When to Use

- Migrating from Apache Cassandra
- Time-series data workloads
- High write throughput requirements
- Need for wide-column storage

### Example Usage

```python
from cassandra.cluster import Cluster
from cassandra.auth import PlainTextAuthProvider

auth_provider = PlainTextAuthProvider(username='<username>', password='<password>')
cluster = Cluster(['<cosmos-account>.cassandra.cosmos.azure.com'], port=10350, auth_provider=auth_provider, ssl_options={'ssl_version': PROTOCOL_TLSv1_2})
session = cluster.connect()

# Create keyspace and table
session.execute("""
    CREATE KEYSPACE IF NOT EXISTS iot 
    WITH REPLICATION = {'class': 'SimpleStrategy', 'replication_factor': 1}
""")

session.execute("""
    CREATE TABLE iot.device_telemetry (
        device_id UUID,
        timestamp TIMESTAMP,
        temperature DECIMAL,
        humidity DECIMAL,
        PRIMARY KEY (device_id, timestamp)
    ) WITH CLUSTERING ORDER BY (timestamp DESC)
""")

# Insert data
session.execute("""
    INSERT INTO iot.device_telemetry (device_id, timestamp, temperature, humidity)
    VALUES (uuid(), toTimestamp(now()), 72.5, 45.2)
""")
```

---

## 📈 Gremlin (Graph) API

### When to Use

- Social networks and connections
- Recommendation engines
- Fraud detection patterns
- Network and IT operations topology

### Example Usage

```python
from gremlin_python.driver import client, serializer

gremlin_client = client.Client(
    'wss://<cosmos-account>.gremlin.cosmos.azure.com:443/',
    'g',
    username="/dbs/<database>/colls/<graph>",
    password="<primary-key>",
    message_serializer=serializer.GraphSONSerializersV2d0()
)

# Add vertices
gremlin_client.submit("g.addV('person').property('id', 'john').property('name', 'John Doe')")
gremlin_client.submit("g.addV('person').property('id', 'jane').property('name', 'Jane Smith')")

# Add edge
gremlin_client.submit("g.V('john').addE('knows').to(g.V('jane'))")

# Query graph
results = gremlin_client.submit("g.V('john').out('knows').values('name')")
for result in results:
    print(result)
```

---

## 🗂️ Table API

### When to Use

- Migrating from Azure Table Storage
- Simple key-value scenarios
- Need for minimal code changes from Table Storage

### Example Usage

```python
from azure.data.tables import TableServiceClient

connection_string = "<cosmos-table-connection-string>"
table_service = TableServiceClient.from_connection_string(connection_string)

table_client = table_service.create_table_if_not_exists("products")

# Insert entity
entity = {
    'PartitionKey': 'Electronics',
    'RowKey': 'prod-001',
    'Name': 'Laptop',
    'Price': 999.99
}
table_client.create_entity(entity)

# Query entities
entities = table_client.query_entities("PartitionKey eq 'Electronics'")
for entity in entities:
    print(entity)
```

---

## 🔗 Related Resources

- [Cosmos DB Overview](README.md)
- [Partitioning Strategies](partitioning-strategies.md)
- [Change Feed](change-feed.md)

---

*Last Updated: 2025-01-28*
*Documentation Status: Complete*
