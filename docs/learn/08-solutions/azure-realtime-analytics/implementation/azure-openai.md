---
title: "Azure OpenAI Integration"
tags:
  - solutions
  - azure-realtime-analytics
  - implementation
---
# Azure OpenAI Integration

---

![Azure OpenAI](https://img.shields.io/badge/Azure_OpenAI-412991?style=flat-square&logo=openai&logoColor=white)
![Status](https://img.shields.io/badge/Status-Production_Ready-brightgreen?style=flat-square)

## Overview

This guide covers integrating Azure OpenAI Service into the real-time analytics platform for advanced AI-powered analytics, natural language queries, and automated insights generation.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Azure OpenAI Setup](#azure-openai-setup)
- [Model Deployments](#model-deployments)
- [Integration Patterns](#integration-patterns)
- [Use Cases](#use-cases)
- [Best Practices](#best-practices)

---

## Prerequisites

- Azure OpenAI Service access approved
- Azure subscription with quota
- Databricks workspace configured
- Key Vault for secret management

---

## Azure OpenAI Setup

### Create Azure OpenAI Resource

```bash
# Create Azure OpenAI resource
az cognitiveservices account create \
  --name analytics-openai-prod \
  --resource-group analytics-rg \
  --kind OpenAI \
  --sku S0 \
  --location eastus \
  --custom-domain analytics-openai-prod \
  --tags "Environment=Production" "Project=RealTimeAnalytics"

# Get endpoint and key
ENDPOINT=$(az cognitiveservices account show \
  --name analytics-openai-prod \
  --resource-group analytics-rg \
  --query properties.endpoint -o tsv)

KEY=$(az cognitiveservices account keys list \
  --name analytics-openai-prod \
  --resource-group analytics-rg \
  --query key1 -o tsv)

# Store in Key Vault
az keyvault secret set \
  --vault-name analytics-kv-prod \
  --name "azure-openai-endpoint" \
  --value "$ENDPOINT"

az keyvault secret set \
  --vault-name analytics-kv-prod \
  --name "azure-openai-key" \
  --value "$KEY"
```

---

## Model Deployments

### Deploy GPT-4 for Advanced Reasoning

```bash
# Deploy GPT-4
az cognitiveservices account deployment create \
  --resource-group analytics-rg \
  --name analytics-openai-prod \
  --deployment-name gpt-4 \
  --model-name gpt-4 \
  --model-version "0125-Preview" \
  --model-format OpenAI \
  --sku-capacity 10 \
  --sku-name "Standard"
```

### Deploy GPT-3.5-Turbo for High Throughput

```bash
# Deploy GPT-3.5-Turbo
az cognitiveservices account deployment create \
  --resource-group analytics-rg \
  --name analytics-openai-prod \
  --deployment-name gpt-35-turbo \
  --model-name gpt-35-turbo \
  --model-version "0125" \
  --model-format OpenAI \
  --sku-capacity 60 \
  --sku-name "Standard"
```

### Deploy Embeddings Model

```bash
# Deploy text-embedding-3-large
az cognitiveservices account deployment create \
  --resource-group analytics-rg \
  --name analytics-openai-prod \
  --deployment-name text-embedding-3-large \
  --model-name text-embedding-3-large \
  --model-version "1" \
  --model-format OpenAI \
  --sku-capacity 100 \
  --sku-name "Standard"
```

---

## Integration Patterns

### Natural Language to SQL

```python
from openai import AzureOpenAI
import os

# Initialize client
client = AzureOpenAI(
    azure_endpoint=dbutils.secrets.get("kv-secrets", "azure-openai-endpoint"),
    api_key=dbutils.secrets.get("kv-secrets", "azure-openai-key"),
    api_version="2024-02-15-preview"
)

def natural_language_to_sql(user_query, schema_context):
    """
    Convert natural language to SQL query
    """
    system_prompt = f"""You are a SQL expert for Azure Databricks Delta Lake.

Schema context:
{schema_context}

Generate syntactically correct Spark SQL queries.
Use only the tables and columns provided in the schema.
"""

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_query}
        ],
        temperature=0,
        max_tokens=500
    )

    return response.choices[0].message.content

# Example usage
schema = """
Table: gold.customer_metrics
Columns: customer_id, customer_name, total_revenue, event_count, last_purchase_date

Table: gold.product_analytics
Columns: product_id, product_name, total_sales, avg_price
"""

query = "Show me the top 10 customers by revenue in the last 30 days"
sql = natural_language_to_sql(query, schema)
print(sql)

# Execute generated SQL
result = spark.sql(sql)
display(result)
```

### Automated Insights Generation

```python
def generate_insights(dataframe, context=""):
    """
    Generate insights from data using GPT-4
    """
    # Convert DataFrame to summary statistics
    summary = dataframe.describe().toPandas().to_string()

    prompt = f"""Analyze the following data and provide key insights:

Context: {context}

Data Summary:
{summary}

Provide:
1. Key trends
2. Anomalies or outliers
3. Actionable recommendations
"""

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=800
    )

    return response.choices[0].message.content

# Example
df = spark.table("gold.customer_metrics")
insights = generate_insights(df, "Customer behavior analysis for Q1 2025")
print(insights)
```

### Semantic Search with Embeddings

```python
from openai import AzureOpenAI
import numpy as np

def get_embedding(text, model="text-embedding-3-large"):
    """
    Generate embedding for text
    """
    response = client.embeddings.create(
        input=text,
        model=model
    )
    return response.data[0].embedding

def semantic_search(query, documents):
    """
    Search documents using semantic similarity
    """
    # Generate query embedding
    query_embedding = get_embedding(query)

    # Generate document embeddings (cache these in production)
    doc_embeddings = [get_embedding(doc) for doc in documents]

    # Calculate cosine similarity
    similarities = []
    for doc_emb in doc_embeddings:
        similarity = np.dot(query_embedding, doc_emb) / (
            np.linalg.norm(query_embedding) * np.linalg.norm(doc_emb)
        )
        similarities.append(similarity)

    # Return top results
    top_indices = np.argsort(similarities)[-3:][::-1]
    return [(documents[i], similarities[i]) for i in top_indices]

# Example
documents = [
    "Customer churn increased by 15% in Q1 due to pricing changes",
    "Revenue growth was 20% year-over-year driven by new product launches",
    "Website traffic declined 10% due to reduced marketing spend"
]

query = "Why did we lose customers?"
results = semantic_search(query, documents)
for doc, score in results:
    print(f"Score: {score:.3f} - {doc}")
```

---

## Use Cases

### Anomaly Explanation

```python
def explain_anomaly(metric_name, current_value, historical_values, context=""):
    """
    Explain detected anomalies using GPT-4
    """
    avg_value = np.mean(historical_values)
    std_value = np.std(historical_values)

    prompt = f"""An anomaly was detected in {metric_name}:
- Current value: {current_value}
- Historical average: {avg_value:.2f}
- Historical std dev: {std_value:.2f}
- Context: {context}

Explain possible causes and recommend actions."""

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.5
    )

    return response.choices[0].message.content
```

### Report Summarization

```python
def summarize_report(report_data):
    """
    Generate executive summary from detailed report
    """
    prompt = f"""Summarize this analytics report for executives:

{report_data}

Provide:
- Executive summary (3-4 sentences)
- Key metrics
- Critical insights
- Recommended actions
"""

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=600
    )

    return response.choices[0].message.content
```

### Predictive Insights

```python
def generate_predictions(historical_data, prediction_context):
    """
    Generate predictive insights
    """
    prompt = f"""Based on the following historical data:

{historical_data}

Context: {prediction_context}

Provide:
1. Trend predictions for next quarter
2. Confidence level
3. Key assumptions
4. Risk factors
"""

    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4
    )

    return response.choices[0].message.content
```

---

## Best Practices

### Rate Limiting and Retry Logic

```python
import time
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=4, max=10)
)
def call_openai_with_retry(messages, model="gpt-4"):
    """
    Call OpenAI with automatic retry on rate limits
    """
    try:
        response = client.chat.completions.create(
            model=model,
            messages=messages
        )
        return response.choices[0].message.content
    except Exception as e:
        if "rate_limit" in str(e).lower():
            time.sleep(5)
            raise
        else:
            raise
```

### Cost Optimization

```python
class OpenAICostTracker:
    """
    Track OpenAI API costs
    """
    PRICING = {
        "gpt-4": {"input": 0.03, "output": 0.06},  # per 1K tokens
        "gpt-35-turbo": {"input": 0.0005, "output": 0.0015}
    }

    def __init__(self):
        self.total_cost = 0

    def calculate_cost(self, response, model):
        """Calculate cost for a response"""
        input_tokens = response.usage.prompt_tokens
        output_tokens = response.usage.completion_tokens

        cost = (
            (input_tokens / 1000) * self.PRICING[model]["input"] +
            (output_tokens / 1000) * self.PRICING[model]["output"]
        )

        self.total_cost += cost
        return cost

# Usage
tracker = OpenAICostTracker()
response = client.chat.completions.create(model="gpt-4", messages=[...])
cost = tracker.calculate_cost(response, "gpt-4")
print(f"Request cost: ${cost:.4f}")
```

### Prompt Caching

```python
from functools import lru_cache

@lru_cache(maxsize=100)
def cached_completion(prompt_hash, model):
    """
    Cache OpenAI completions
    """
    # In production, use Redis or similar
    return client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt_hash}]
    )
```

### Security Best Practices

```python
# ✅ DO: Use managed identities or Key Vault
api_key = dbutils.secrets.get("kv-secrets", "azure-openai-key")

# ❌ DON'T: Hardcode credentials
# api_key = "sk-..."

# ✅ DO: Validate and sanitize user input
def sanitize_input(user_input):
    # Remove potential injection attempts
    dangerous_patterns = ["DROP", "DELETE", "TRUNCATE", "exec(", "eval("]
    for pattern in dangerous_patterns:
        if pattern.lower() in user_input.lower():
            raise ValueError("Potentially dangerous input detected")
    return user_input

# ✅ DO: Limit output tokens to control costs
response = client.chat.completions.create(
    model="gpt-4",
    messages=[...],
    max_tokens=500  # Prevent runaway generation
)
```

---

## Monitoring and Logging

```python
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def log_openai_request(prompt, response, model, duration):
    """
    Log OpenAI API requests for monitoring
    """
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "model": model,
        "prompt_length": len(prompt),
        "response_length": len(response),
        "tokens_used": response.usage.total_tokens,
        "duration_ms": duration * 1000,
        "cost": tracker.calculate_cost(response, model)
    }

    logger.info(f"OpenAI Request: {log_entry}")

    # Write to Delta table for analysis
    spark.createDataFrame([log_entry]).write.mode("append").saveAsTable("monitoring.openai_usage")
```

---

## Troubleshooting

### Common Issues

**Issue: Rate limit errors**

```python
# Solution: Implement exponential backoff
from tenacity import retry, wait_exponential

@retry(wait=wait_exponential(multiplier=1, min=4, max=60))
def resilient_call():
    return client.chat.completions.create(...)
```

**Issue: High costs**

```python
# Solution: Use cheaper models for simpler tasks
def choose_model(task_complexity):
    if task_complexity == "high":
        return "gpt-4"
    else:
        return "gpt-35-turbo"  # 60x cheaper
```

---

## Related Documentation

- [MLflow Integration](mlflow.md)
- [Data Quality Implementation](data-quality.md)
- [Architecture Components](../architecture/components.md)

---

**Last Updated:** January 2025
**Version:** 1.0.0
**Status:** Production Ready
