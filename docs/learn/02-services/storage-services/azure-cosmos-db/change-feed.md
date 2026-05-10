---
title: "Change Feed in Azure Cosmos DB"
description: "Change Feed provides a persistent log of all changes to Cosmos DB documents, enabling real-time event-driven architectures, data synchronization, and audit trails."
tags:
  - services
  - cosmos-db
---
# 🔄 Change Feed in Azure Cosmos DB

![Real-time](https://img.shields.io/badge/Type-Real%20time-brightgreen?style=flat-square)

Change Feed provides a persistent log of all changes to Cosmos DB documents, enabling real-time event-driven architectures, data synchronization, and audit trails.

---

## 🎯 Overview

Change Feed is a feature that outputs a sorted list of documents that were changed in the order they were modified, enabling reactive applications that respond to data changes.

### Key Capabilities

- Real-time change notifications
- Guaranteed ordering within partition key
- Includes inserts and updates (deletes with TTL)
- Multiple consumers supported
- Processing from specific point in time

---

## 🏗️ Change Feed Modes

### Latest Version Mode

```python
from azure.cosmos import CosmosClient, PartitionKey

client = CosmosClient(url="<url>", credential="<credential>")
database = client.get_database_client("ecommerce")
container = database.get_container_client("orders")

# Read changes
for item in container.query_items_change_feed():
    print(f"Changed document: {item['id']}")
    # Process change
```

### All Versions and Deletes Mode

```python
# Track all versions including deletions
for item in container.query_items_change_feed(
    is_start_from_beginning=True,
    all_versions_and_deletes=True
):
    if item.get('_metadata', {}).get('operationType') == 'delete':
        print(f"Deleted: {item['id']}")
    else:
        print(f"Modified: {item['id']}")
```

---

## 🔧 Implementation Patterns

### Azure Functions Integration

```python
import azure.functions as func
import logging

def main(documents: func.DocumentList):
    """Process Cosmos DB changes with Azure Functions."""
    if documents:
        logging.info(f'Processing {len(documents)} changed documents')
        for doc in documents:
            # Process each changed document
            process_order_change(doc)

def process_order_change(order):
    """Handle order changes."""
    if order['status'] == 'completed':
        # Send notification
        send_order_confirmation(order)
```

### Change Feed Processor

```python
from azure.cosmos import CosmosClient
from azure.cosmos.partition_key import PartitionKey

# Initialize clients
client = CosmosClient(url="<url>", credential="<credential>")
database = client.get_database_client("ecommerce")
monitored_container = database.get_container_client("orders")
lease_container = database.get_container_client("leases")

# Process changes
def batch_processor(changes):
    for change in changes:
        print(f"Processing change: {change['id']}")
        # Handle change

# Start processor
monitored_container.query_items_change_feed(
    is_start_from_beginning=True,
    max_item_count=100
)
```

---

## 🔗 Related Resources

- [Cosmos DB Overview](README.md)
- [API Selection](api-selection.md)
- [Analytical Store](analytical-store.md)

---

*Last Updated: 2025-01-28*
