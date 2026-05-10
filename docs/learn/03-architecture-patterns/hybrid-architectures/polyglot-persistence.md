---
title: "️ Polyglot Persistence Architecture"
description: "Use different database technologies optimized for specific data patterns and access requirements, allowing each component to leverage the best tool for its unique characteristics."
tags:
  - architecture
  - hybrid-architectures
---
# 🗄️ Polyglot Persistence Architecture

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)
![Type](https://img.shields.io/badge/Type-Multi%20Database-teal?style=flat-square)

Use different database technologies optimized for specific data patterns and access requirements, allowing each component to leverage the best tool for its unique characteristics.

---

## 📋 Table of Contents

- [Overview](#overview)
- [Database Selection Matrix](#database-selection-matrix)
- [Architecture Components](#architecture-components)
- [Azure Service Mapping](#azure-service-mapping)
- [Implementation Patterns](#implementation-patterns)
- [Data Synchronization](#data-synchronization)
- [Use Cases](#use-cases)
- [Best Practices](#best-practices)
- [Related Patterns](#related-patterns)

---

## 🎯 Overview

Polyglot Persistence is an architectural approach that uses multiple database technologies within a single application or system, selecting the optimal data store for each specific use case based on data characteristics and access patterns.

### Core Principles

- __Right Tool for Right Job__: Match database to data characteristics
- __Bounded Contexts__: Each domain owns its data store choice
- __Data Synchronization__: Keep related data consistent across stores
- __Query Federation__: Unified query layer across databases
- __Operational Excellence__: Manage multiple technologies effectively

### Architecture Benefits

| Benefit | Description | Business Impact |
|---------|-------------|----------------|
| __Performance__ | Optimized storage for each data type | Better user experience |
| __Scalability__ | Independent scaling per database | Cost-effective growth |
| __Flexibility__ | Choose best technology per domain | Rapid innovation |
| __Resilience__ | Isolated failure domains | Higher availability |
| __Specialization__ | Leverage database-specific features | Advanced capabilities |

---

## 📊 Database Selection Matrix

### By Data Characteristics

```mermaid
graph TB
    Start{Data Characteristics}

    Start -->|Structured<br/>ACID Required| Relational[Relational Database<br/>Azure SQL Database]
    Start -->|Semi-Structured<br/>Flexible Schema| Document[Document Store<br/>Cosmos DB]
    Start -->|Relationships<br/>Connected Data| Graph[Graph Database<br/>Cosmos DB Gremlin API]
    Start -->|Time-Series<br/>High Frequency| TimeSeries[Time-Series Database<br/>Data Explorer]
    Start -->|Key-Value<br/>High Throughput| Cache[Cache/Key-Value<br/>Redis Cache]
    Start -->|Search<br/>Full-Text| Search[Search Engine<br/>Azure Cognitive Search]
    Start -->|Large Files<br/>Unstructured| Blob[Object Storage<br/>Blob Storage]
    Start -->|Analytics<br/>Large Scale| Warehouse[Data Warehouse<br/>Synapse Analytics]

    classDef relational fill:#e3f2fd
    classDef document fill:#f3e5f5
    classDef graph fill:#fff3e0
    classDef timeseries fill:#e8f5e9
    classDef cache fill:#fce4ec
    classDef search fill:#f1f8e9

    class Relational relational
    class Document document
    class Graph graph
    class TimeSeries timeseries
    class Cache cache
    class Search search
```

### Decision Matrix

| Database Type | Best For | Not Suitable For | Azure Service |
|---------------|----------|------------------|---------------|
| __Relational__ | ACID transactions, complex joins, structured data | Massive scale, unstructured data | Azure SQL Database |
| __Document__ | Flexible schema, semi-structured, global distribution | Complex joins, transactions | Cosmos DB (SQL API) |
| __Graph__ | Connected data, relationships, network analysis | Simple lookups, time-series | Cosmos DB (Gremlin API) |
| __Time-Series__ | IoT telemetry, metrics, events | Transactions, relationships | Azure Data Explorer |
| __Key-Value__ | Session state, caching, simple lookups | Complex queries, relationships | Redis Cache |
| __Search__ | Full-text search, faceted navigation | Transactions, source of truth | Cognitive Search |
| __Blob__ | Files, media, backups | Structured queries, transactions | Blob Storage |
| __Analytical__ | Large-scale analytics, BI, reporting | OLTP, low latency | Synapse Analytics |

---

## 🏗️ Architecture Components

```mermaid
graph TB
    subgraph "Application Layer"
        API[Application APIs]
        Gateway[API Gateway]
    end

    subgraph "Data Access Layer"
        Router[Data Router]
        Aggregator[Data Aggregator]
    end

    subgraph "Transactional Stores"
        SQL[Azure SQL Database<br/>OLTP Transactions]
        Cosmos[Cosmos DB<br/>Flexible Documents]
    end

    subgraph "Analytical Stores"
        Synapse[Synapse Analytics<br/>Data Warehouse]
        Explorer[Data Explorer<br/>Time-Series Analytics]
    end

    subgraph "Specialized Stores"
        Graph[Cosmos DB Gremlin<br/>Graph Relationships]
        Redis[Redis Cache<br/>Session State]
        Search[Cognitive Search<br/>Full-Text Search]
        Blob[Blob Storage<br/>Files & Media]
    end

    subgraph "Data Synchronization"
        CDC[Change Data Capture]
        EventHub[Event Hub<br/>Data Streaming]
        DataFactory[Data Factory<br/>Batch Sync]
    end

    Gateway --> Router
    Router --> SQL
    Router --> Cosmos
    Router --> Graph
    Router --> Redis

    Aggregator --> Synapse
    Aggregator --> Explorer
    Aggregator --> Search

    SQL --> CDC
    Cosmos --> EventHub
    CDC --> EventHub
    EventHub --> Synapse
    EventHub --> Explorer
    EventHub --> Search

    DataFactory --> Blob
    DataFactory --> Synapse

    classDef app fill:#e3f2fd
    classDef transactional fill:#f3e5f5
    classDef analytical fill:#fff3e0
    classDef specialized fill:#e8f5e9
    classDef sync fill:#fce4ec

    class API,Gateway app
    class SQL,Cosmos transactional
    class Synapse,Explorer analytical
    class Graph,Redis,Search,Blob specialized
    class CDC,EventHub,DataFactory sync
```

---

## ☁️ Azure Service Mapping

### Core Database Services

| Service | Type | Use Cases | Scaling Model |
|---------|------|-----------|---------------|
| __Azure SQL Database__ | Relational | OLTP, transactions, relational data | Vertical + Elastic Pools |
| __Cosmos DB__ | Multi-model | Global distribution, low latency | Horizontal (auto-scale) |
| __Synapse Analytics__ | Data Warehouse | Analytics, BI, reporting | MPP (massively parallel) |
| __Data Explorer__ | Time-Series | IoT, logs, metrics, telemetry | Auto-scale clusters |
| __Redis Cache__ | Key-Value | Caching, session state | Vertical + Clustering |
| __Cognitive Search__ | Search Engine | Full-text search, AI enrichment | Search units |
| __Blob Storage__ | Object Store | Files, backups, data lake | Unlimited horizontal |

### Integration Services

- __Azure Data Factory__: Batch data movement and transformation
- __Event Hubs__: Real-time event streaming
- __Stream Analytics__: Stream processing and routing
- __Logic Apps__: Workflow orchestration
- __Azure Functions__: Event-driven compute

---

## 🔧 Implementation Patterns

### Pattern 1: Microservices with Dedicated Data Stores

```mermaid
graph TB
    subgraph "User Service"
        UserAPI[User API]
        UserDB[(Azure SQL<br/>User Data)]
        UserCache[(Redis<br/>User Sessions)]
    end

    subgraph "Product Service"
        ProductAPI[Product API]
        ProductDB[(Cosmos DB<br/>Product Catalog)]
        ProductSearch[(Cognitive Search<br/>Product Index)]
    end

    subgraph "Order Service"
        OrderAPI[Order API]
        OrderDB[(Azure SQL<br/>Order Transactions)]
        OrderEvents[(Event Hub<br/>Order Events)]
    end

    subgraph "Analytics Service"
        AnalyticsAPI[Analytics API]
        AnalyticsDB[(Synapse<br/>Data Warehouse)]
        MetricsDB[(Data Explorer<br/>Metrics)]
    end

    UserAPI --> UserDB
    UserAPI --> UserCache
    ProductAPI --> ProductDB
    ProductAPI --> ProductSearch
    OrderAPI --> OrderDB
    OrderAPI --> OrderEvents

    OrderEvents --> AnalyticsDB
    ProductDB --> AnalyticsDB
    UserDB --> AnalyticsDB
    OrderEvents --> MetricsDB

    classDef service fill:#e3f2fd
    classDef sql fill:#f3e5f5
    classDef nosql fill:#fff3e0
    classDef analytics fill:#e8f5e9

    class UserAPI,ProductAPI,OrderAPI,AnalyticsAPI service
    class UserDB,OrderDB sql
    class ProductDB,UserCache,ProductSearch,OrderEvents nosql
    class AnalyticsDB,MetricsDB analytics
```

__Implementation Example - User Service (Azure SQL)__:

```python
from sqlalchemy import create_engine, Column, Integer, String, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import redis

# Azure SQL for transactional user data
engine = create_engine(
    'mssql+pyodbc://username:password@server.database.windows.net/userdb?driver=ODBC+Driver+17+for+SQL+Server'
)
Base = declarative_base()
Session = sessionmaker(bind=engine)

class User(Base):
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True)
    username = Column(String(50), unique=True, nullable=False)
    email = Column(String(100), unique=True, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, onupdate=datetime.utcnow)

# Redis for user sessions
redis_client = redis.Redis(
    host='mycache.redis.cache.windows.net',
    port=6380,
    password='your-redis-key',
    ssl=True
)

class UserService:
    """User service with polyglot persistence."""

    def __init__(self):
        self.session = Session()
        self.cache = redis_client

    def create_user(self, username: str, email: str) -> User:
        """Create user in Azure SQL."""
        user = User(username=username, email=email)
        self.session.add(user)
        self.session.commit()
        return user

    def get_user(self, user_id: int) -> User:
        """Get user with Redis caching."""
        # Check cache first
        cache_key = f"user:{user_id}"
        cached_user = self.cache.get(cache_key)

        if cached_user:
            return eval(cached_user)  # In production, use proper serialization

        # Fetch from database
        user = self.session.query(User).filter_by(id=user_id).first()

        # Cache for 1 hour
        if user:
            self.cache.setex(cache_key, 3600, str(user.__dict__))

        return user

    def set_user_session(self, user_id: int, session_data: dict):
        """Store session in Redis."""
        session_key = f"session:{user_id}"
        self.cache.setex(session_key, 1800, str(session_data))  # 30 min TTL
```

__Product Service (Cosmos DB + Cognitive Search)__:

```python
from azure.cosmos import CosmosClient, PartitionKey
from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential
import uuid

# Cosmos DB for product catalog
cosmos_client = CosmosClient(
    url='https://myaccount.documents.azure.com:443/',
    credential='your-cosmos-key'
)
database = cosmos_client.create_database_if_not_exists(id='products-db')
container = database.create_container_if_not_exists(
    id='products',
    partition_key=PartitionKey(path='/category')
)

# Cognitive Search for product search
search_client = SearchClient(
    endpoint='https://mysearch.search.windows.net',
    index_name='products-index',
    credential=AzureKeyCredential('your-search-key')
)

class ProductService:
    """Product service with Cosmos DB and Cognitive Search."""

    def create_product(self, name: str, category: str, price: float, description: str):
        """Create product in Cosmos DB and index in Search."""
        product = {
            'id': str(uuid.uuid4()),
            'name': name,
            'category': category,
            'price': price,
            'description': description,
            'created_at': datetime.utcnow().isoformat()
        }

        # Store in Cosmos DB
        container.create_item(body=product)

        # Index in Cognitive Search
        search_client.upload_documents(documents=[{
            'id': product['id'],
            'name': product['name'],
            'category': product['category'],
            'price': product['price'],
            'description': product['description']
        }])

        return product

    def get_product(self, product_id: str):
        """Get product from Cosmos DB."""
        return container.read_item(item=product_id, partition_key=product_id)

    def search_products(self, query: str, filters: dict = None):
        """Search products using Cognitive Search."""
        search_results = search_client.search(
            search_text=query,
            filter=filters.get('filter') if filters else None,
            top=20
        )
        return list(search_results)

    def get_products_by_category(self, category: str):
        """Query products by category from Cosmos DB."""
        query = "SELECT * FROM c WHERE c.category = @category"
        parameters = [{"name": "@category", "value": category}]

        items = container.query_items(
            query=query,
            parameters=parameters,
            enable_cross_partition_query=True
        )
        return list(items)
```

### Pattern 2: CQRS with Polyglot Persistence

```mermaid
graph LR
    subgraph "Command Side (Write)"
        Commands[Commands]
        CmdHandler[Command Handler]
        WriteDB[(Azure SQL<br/>Write Model)]
    end

    subgraph "Event Bus"
        Events[(Event Hub<br/>Domain Events)]
    end

    subgraph "Query Side (Read)"
        Queries[Queries]
        ReadDB1[(Cosmos DB<br/>Denormalized Views)]
        ReadDB2[(Redis<br/>Cached Aggregates)]
        ReadDB3[(Search<br/>Search Index)]
    end

    Commands --> CmdHandler
    CmdHandler --> WriteDB
    WriteDB --> Events
    Events --> ReadDB1
    Events --> ReadDB2
    Events --> ReadDB3
    Queries --> ReadDB1
    Queries --> ReadDB2
    Queries --> ReadDB3

    classDef write fill:#e3f2fd
    classDef event fill:#f3e5f5
    classDef read fill:#e8f5e9

    class Commands,CmdHandler,WriteDB write
    class Events event
    class Queries,ReadDB1,ReadDB2,ReadDB3 read
```

__CQRS Implementation Example__:

```python
from azure.eventhub import EventHubProducerClient, EventData
from dataclasses import dataclass
from typing import List
import json

@dataclass
class OrderCreatedEvent:
    """Domain event for order creation."""
    order_id: str
    customer_id: str
    total_amount: float
    items: List[dict]
    timestamp: str

class OrderCommandService:
    """Command side - writes to Azure SQL."""

    def __init__(self, sql_session, event_hub_client):
        self.session = sql_session
        self.event_hub = event_hub_client

    def create_order(self, customer_id: str, items: List[dict]) -> str:
        """Create order and publish event."""
        # Write to SQL (source of truth)
        order_id = str(uuid.uuid4())
        total_amount = sum(item['price'] * item['quantity'] for item in items)

        order = Order(
            id=order_id,
            customer_id=customer_id,
            total_amount=total_amount,
            status='pending',
            created_at=datetime.utcnow()
        )
        self.session.add(order)
        self.session.commit()

        # Publish event to Event Hub
        event = OrderCreatedEvent(
            order_id=order_id,
            customer_id=customer_id,
            total_amount=total_amount,
            items=items,
            timestamp=datetime.utcnow().isoformat()
        )

        event_data = EventData(json.dumps(event.__dict__))
        self.event_hub.send_event(event_data)

        return order_id

class OrderQueryService:
    """Query side - reads from optimized stores."""

    def __init__(self, cosmos_container, redis_client, search_client):
        self.cosmos = cosmos_container
        self.redis = redis_client
        self.search = search_client

    def get_order(self, order_id: str):
        """Get order from Cosmos DB (denormalized view)."""
        return self.cosmos.read_item(item=order_id, partition_key=order_id)

    def get_customer_orders(self, customer_id: str):
        """Get customer orders from Redis cache."""
        cache_key = f"customer_orders:{customer_id}"
        cached = self.redis.get(cache_key)

        if cached:
            return json.loads(cached)

        # Fetch from Cosmos DB
        query = "SELECT * FROM c WHERE c.customer_id = @customer_id ORDER BY c.created_at DESC"
        items = list(self.cosmos.query_items(
            query=query,
            parameters=[{"name": "@customer_id", "value": customer_id}]
        ))

        # Cache for 5 minutes
        self.redis.setex(cache_key, 300, json.dumps(items))
        return items

    def search_orders(self, search_text: str):
        """Search orders using Cognitive Search."""
        results = self.search.search(search_text=search_text, top=50)
        return list(results)

# Event handler to update read models
class OrderEventHandler:
    """Handle order events and update read models."""

    def __init__(self, cosmos_container, redis_client, search_client):
        self.cosmos = cosmos_container
        self.redis = redis_client
        self.search = search_client

    def handle_order_created(self, event: OrderCreatedEvent):
        """Update all read models."""
        # Update Cosmos DB denormalized view
        order_view = {
            'id': event.order_id,
            'customer_id': event.customer_id,
            'total_amount': event.total_amount,
            'items': event.items,
            'status': 'pending',
            'created_at': event.timestamp
        }
        self.cosmos.create_item(body=order_view)

        # Invalidate customer orders cache
        cache_key = f"customer_orders:{event.customer_id}"
        self.redis.delete(cache_key)

        # Index in search
        self.search.upload_documents(documents=[{
            'id': event.order_id,
            'customer_id': event.customer_id,
            'total_amount': event.total_amount,
            'items_text': ' '.join([item['name'] for item in event.items]),
            'created_at': event.timestamp
        }])
```

### Pattern 3: Graph Database Integration

```python
from gremlin_python.driver import client, serializer

# Cosmos DB Gremlin API for relationship data
gremlin_client = client.Client(
    url='wss://mygraph.gremlin.cosmos.azure.com:443/',
    traversal_source='g',
    username=f'/dbs/graphdb/colls/relationships',
    password='your-cosmos-key',
    message_serializer=serializer.GraphSONSerializersV2d0()
)

class SocialGraphService:
    """Manage social relationships in graph database."""

    def __init__(self, gremlin_client):
        self.client = gremlin_client

    def add_user(self, user_id: str, name: str, properties: dict):
        """Add user vertex to graph."""
        query = f"g.addV('user').property('id', '{user_id}').property('name', '{name}')"
        for key, value in properties.items():
            query += f".property('{key}', '{value}')"

        self.client.submit(query).all().result()

    def follow_user(self, follower_id: str, followee_id: str):
        """Create follow relationship."""
        query = f"""
        g.V('{follower_id}').addE('follows').to(g.V('{followee_id}'))
        """
        self.client.submit(query).all().result()

    def get_followers(self, user_id: str, limit: int = 100):
        """Get user's followers."""
        query = f"g.V('{user_id}').in('follows').limit({limit})"
        results = self.client.submit(query).all().result()
        return results

    def get_mutual_followers(self, user_id1: str, user_id2: str):
        """Find mutual followers between two users."""
        query = f"""
        g.V('{user_id1}').in('follows').as('f1')
         .V('{user_id2}').in('follows').as('f2')
         .where('f1', eq('f2'))
        """
        results = self.client.submit(query).all().result()
        return results

    def recommend_connections(self, user_id: str, limit: int = 10):
        """Recommend connections (friends of friends)."""
        query = f"""
        g.V('{user_id}').out('follows').out('follows')
         .where(neq('{user_id}'))
         .dedup()
         .limit({limit})
        """
        results = self.client.submit(query).all().result()
        return results
```

---

## 🔄 Data Synchronization

### Synchronization Patterns

```mermaid
graph TB
    subgraph "Real-time Sync"
        SQL[Azure SQL<br/>Change Tracking]
        CDC[Change Data Capture]
        EventHub1[Event Hub]
        StreamAnalytics[Stream Analytics]
        Target1[Target Databases]
    end

    subgraph "Batch Sync"
        Source[Source Databases]
        DataFactory[Data Factory]
        Target2[Target Databases]
    end

    subgraph "Event-Driven Sync"
        AppEvents[Application Events]
        EventHub2[Event Hub]
        Functions[Azure Functions]
        Target3[Target Databases]
    end

    SQL --> CDC
    CDC --> EventHub1
    EventHub1 --> StreamAnalytics
    StreamAnalytics --> Target1

    Source --> DataFactory
    DataFactory --> Target2

    AppEvents --> EventHub2
    EventHub2 --> Functions
    Functions --> Target3

    classDef realtime fill:#e8f5e9
    classDef batch fill:#fff3e0
    classDef event fill:#f3e5f5

    class SQL,CDC,EventHub1,StreamAnalytics,Target1 realtime
    class Source,DataFactory,Target2 batch
    class AppEvents,EventHub2,Functions,Target3 event
```

__Real-time Sync with Change Data Capture__:

```python
from azure.eventhub import EventHubProducerClient, EventData
import pyodbc
import json

class ChangDataCaptureSync:
    """Sync changes from Azure SQL to other databases."""

    def __init__(self, sql_conn_str: str, event_hub_client):
        self.sql_conn = pyodbc.connect(sql_conn_str)
        self.event_hub = event_hub_client

    def enable_cdc_on_table(self, schema: str, table: str):
        """Enable CDC on a table."""
        cursor = self.sql_conn.cursor()

        # Enable CDC on database
        cursor.execute(f"EXEC sys.sp_cdc_enable_db")

        # Enable CDC on table
        cursor.execute(f"""
            EXEC sys.sp_cdc_enable_table
                @source_schema = '{schema}',
                @source_name = '{table}',
                @role_name = NULL
        """)
        cursor.commit()

    def capture_changes(self, schema: str, table: str):
        """Capture and stream changes."""
        cursor = self.sql_conn.cursor()

        # Get CDC instance name
        cdc_table = f"cdc.{schema}_{table}_CT"

        # Query changes
        query = f"""
            SELECT
                __$operation as operation,
                *
            FROM {cdc_table}
            WHERE __$operation IN (1, 2, 4)  -- Delete, Insert, Update
            ORDER BY __$start_lsn
        """

        cursor.execute(query)
        changes = cursor.fetchall()

        # Stream changes to Event Hub
        for change in changes:
            event_data = {
                'table': f"{schema}.{table}",
                'operation': self._get_operation_name(change.operation),
                'data': dict(zip([col[0] for col in cursor.description], change))
            }

            self.event_hub.send_event(EventData(json.dumps(event_data)))

    def _get_operation_name(self, op_code: int) -> str:
        """Convert operation code to name."""
        operations = {1: 'delete', 2: 'insert', 4: 'update'}
        return operations.get(op_code, 'unknown')
```

---

## 💼 Use Cases

### 1. E-commerce Platform

__Database Allocation__:
- __Azure SQL__: Orders, payments, inventory (ACID transactions)
- __Cosmos DB__: Product catalog, shopping carts (global distribution)
- __Redis__: Session state, shopping cart cache
- __Cognitive Search__: Product search, recommendations
- __Synapse__: Sales analytics, business intelligence
- __Blob Storage__: Product images, user uploads

### 2. Social Media Application

__Database Allocation__:
- __Azure SQL__: User accounts, authentication
- __Cosmos DB Gremlin__: Social graph, relationships
- __Cosmos DB SQL__: Posts, comments (flexible schema)
- __Data Explorer__: User activity analytics, metrics
- __Redis__: Feed cache, session state
- __Cognitive Search__: User and content search
- __Blob Storage__: Media files, attachments

### 3. IoT Platform

__Database Allocation__:
- __Data Explorer__: Device telemetry, time-series data
- __Azure SQL__: Device registry, configurations
- __Cosmos DB__: Device state, metadata
- __Redis__: Real-time device status cache
- __Synapse__: Historical analytics, reporting
- __Blob Storage__: Firmware files, logs

---

## ✅ Best Practices

### 1. Database Selection Guidelines

```python
from enum import Enum
from dataclasses import dataclass

class DatabaseType(Enum):
    """Available database types."""
    AZURE_SQL = "azure_sql"
    COSMOS_DB = "cosmos_db"
    REDIS = "redis"
    SYNAPSE = "synapse"
    DATA_EXPLORER = "data_explorer"
    COGNITIVE_SEARCH = "cognitive_search"
    BLOB_STORAGE = "blob_storage"

@dataclass
class DataCharacteristics:
    """Data characteristics for database selection."""
    volume: str  # small, medium, large
    velocity: str  # batch, streaming, real-time
    variety: str  # structured, semi-structured, unstructured
    consistency: str  # eventual, strong
    query_pattern: str  # oltp, olap, search, graph
    latency_requirement_ms: int
    scale_out_required: bool

class DatabaseSelector:
    """Select appropriate database based on characteristics."""

    def select_database(self, characteristics: DataCharacteristics) -> DatabaseType:
        """Recommend database type."""

        # Strong consistency + OLTP -> Azure SQL
        if (characteristics.consistency == "strong" and
            characteristics.query_pattern == "oltp"):
            return DatabaseType.AZURE_SQL

        # Graph queries -> Cosmos DB Gremlin
        if characteristics.query_pattern == "graph":
            return DatabaseType.COSMOS_DB

        # Time-series data -> Data Explorer
        if (characteristics.velocity == "streaming" and
            characteristics.variety == "structured" and
            "time" in characteristics.query_pattern):
            return DatabaseType.DATA_EXPLORER

        # Low latency lookups -> Redis
        if (characteristics.latency_requirement_ms < 10 and
            characteristics.query_pattern == "key-value"):
            return DatabaseType.REDIS

        # Full-text search -> Cognitive Search
        if characteristics.query_pattern == "search":
            return DatabaseType.COGNITIVE_SEARCH

        # Analytics -> Synapse
        if characteristics.query_pattern == "olap":
            return DatabaseType.SYNAPSE

        # Default flexible option -> Cosmos DB
        return DatabaseType.COSMOS_DB
```

### 2. Consistency Management

| Pattern | Description | Implementation |
|---------|-------------|----------------|
| __Eventual Consistency__ | Accept temporary inconsistency | Event-driven updates |
| __Strong Consistency__ | Guarantee immediate consistency | Distributed transactions |
| __Read-your-writes__ | User sees their own changes | Session-based routing |
| __Monotonic Reads__ | No going back in time | Version tracking |
| __Bounded Staleness__ | Maximum staleness guarantee | Time-based sync |

### 3. Transaction Patterns

```python
from azure.cosmos import CosmosClient
from azure.storage.blob import BlobServiceClient
import pyodbc

class DistributedTransactionCoordinator:
    """Coordinate transactions across multiple databases."""

    def __init__(self, sql_conn, cosmos_client, blob_client):
        self.sql = sql_conn
        self.cosmos = cosmos_client
        self.blob = blob_client

    def execute_saga(self, order_data: dict):
        """Execute distributed transaction using Saga pattern."""
        compensation_actions = []

        try:
            # Step 1: Create order in Azure SQL
            order_id = self._create_order_sql(order_data)
            compensation_actions.append(lambda: self._delete_order_sql(order_id))

            # Step 2: Reserve inventory in Cosmos DB
            self._reserve_inventory_cosmos(order_data['items'])
            compensation_actions.append(
                lambda: self._release_inventory_cosmos(order_data['items'])
            )

            # Step 3: Store receipt in Blob Storage
            receipt_url = self._store_receipt_blob(order_id, order_data)
            compensation_actions.append(lambda: self._delete_receipt_blob(receipt_url))

            # All steps succeeded
            return {"status": "success", "order_id": order_id}

        except Exception as e:
            # Execute compensation in reverse order
            for compensate in reversed(compensation_actions):
                try:
                    compensate()
                except Exception as comp_error:
                    # Log compensation failure
                    print(f"Compensation failed: {comp_error}")

            return {"status": "failed", "error": str(e)}

    def _create_order_sql(self, order_data: dict) -> str:
        """Create order in Azure SQL."""
        cursor = self.sql.cursor()
        order_id = str(uuid.uuid4())

        cursor.execute("""
            INSERT INTO orders (id, customer_id, total_amount, status)
            VALUES (?, ?, ?, ?)
        """, (order_id, order_data['customer_id'], order_data['total'], 'pending'))

        cursor.commit()
        return order_id

    def _delete_order_sql(self, order_id: str):
        """Compensation: Delete order from SQL."""
        cursor = self.sql.cursor()
        cursor.execute("DELETE FROM orders WHERE id = ?", (order_id,))
        cursor.commit()

    def _reserve_inventory_cosmos(self, items: list):
        """Reserve inventory in Cosmos DB."""
        # Implementation for inventory reservation
        pass

    def _release_inventory_cosmos(self, items: list):
        """Compensation: Release inventory."""
        # Implementation for inventory release
        pass

    def _store_receipt_blob(self, order_id: str, order_data: dict) -> str:
        """Store receipt in Blob Storage."""
        # Implementation for receipt storage
        pass

    def _delete_receipt_blob(self, receipt_url: str):
        """Compensation: Delete receipt."""
        # Implementation for receipt deletion
        pass
```

---

## 🔗 Related Patterns

### Complementary Patterns

- [CQRS Pattern](../streaming-architectures/cqrs-pattern.md): Separate read and write models
- [Event Sourcing](../streaming-architectures/event-sourcing.md): Event-driven synchronization
- [Lambda-Kappa Hybrid](lambda-kappa-hybrid.md): Flexible processing architecture
- [Data Mesh](../batch-architectures/data-mesh.md): Domain-oriented data ownership

### Decision Guide

| Choose Polyglot When | Choose Single Database When |
|----------------------|----------------------------|
| Diverse data types | Simple, uniform data |
| Performance-critical | Simplicity preferred |
| Specialized features needed | Team expertise limited |
| Independent scaling required | Operational simplicity critical |
| Domain-driven architecture | Small to medium scale |

---

## 📚 Additional Resources

### Implementation Guides

- [Azure SQL Database Best Practices](https://docs.microsoft.com/azure/sql-database/)
- [Cosmos DB Multi-Model Guide](https://docs.microsoft.com/azure/cosmos-db/)
- [Data Synchronization Patterns](../../best-practices/README.md)

### Reference Architectures

- Microservices Architecture - Domain-oriented data ownership
- E-commerce Platform - Multi-database shopping experience
- IoT Platform - Device data across specialized stores

---

*Last Updated: 2025-01-28*
*Pattern Status: Active*
*Complexity: Advanced*
