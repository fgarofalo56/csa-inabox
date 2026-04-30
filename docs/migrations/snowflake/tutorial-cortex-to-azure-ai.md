# Tutorial: Migrate Cortex AI to Azure AI Services

**Status:** Authored 2026-04-30
**Audience:** Data engineers and ML engineers replacing Snowflake Cortex functions with Azure AI
**Prerequisites:** Azure subscription with Azure OpenAI and AI Search deployed, Databricks workspace

---

## What you will build

By the end of this tutorial, you will have:

1. Replaced Cortex `COMPLETE` / `SUMMARIZE` / `TRANSLATE` calls with Azure OpenAI
2. Built a RAG pipeline using Azure AI Search to replace Cortex Search
3. Set up content safety guardrails to replace Cortex Guard
4. Created reusable dbt macros for AI enrichment
5. Validated quality parity with side-by-side comparison

---

## Step 1: Set up Azure OpenAI

### 1.1 Deploy Azure OpenAI resource

```bash
# Azure CLI: Create Azure OpenAI resource in Azure Government
az cognitiveservices account create \
    --name "aoai-acmegov-analytics" \
    --resource-group "rg-analytics-prod" \
    --kind "OpenAI" \
    --sku "S0" \
    --location "usgovvirginia" \
    --custom-domain "aoai-acmegov-analytics"
```

### 1.2 Deploy models

```bash
# Deploy GPT-4o for text generation (replaces Cortex COMPLETE)
az cognitiveservices account deployment create \
    --name "aoai-acmegov-analytics" \
    --resource-group "rg-analytics-prod" \
    --deployment-name "gpt-4o" \
    --model-name "gpt-4o" \
    --model-version "2024-11-20" \
    --model-format "OpenAI" \
    --sku-capacity 80 \
    --sku-name "Standard"

# Deploy text-embedding-3-large for embeddings (for RAG pipeline)
az cognitiveservices account deployment create \
    --name "aoai-acmegov-analytics" \
    --resource-group "rg-analytics-prod" \
    --deployment-name "text-embedding-3-large" \
    --model-name "text-embedding-3-large" \
    --model-version "1" \
    --model-format "OpenAI" \
    --sku-capacity 120 \
    --sku-name "Standard"
```

### 1.3 Get credentials

```bash
# Get endpoint and key
az cognitiveservices account show \
    --name "aoai-acmegov-analytics" \
    --resource-group "rg-analytics-prod" \
    --query "properties.endpoint" -o tsv

az cognitiveservices account keys list \
    --name "aoai-acmegov-analytics" \
    --resource-group "rg-analytics-prod" \
    --query "key1" -o tsv
```

Store these as environment variables:

```bash
export AZURE_OPENAI_ENDPOINT="https://aoai-acmegov-analytics.openai.azure.us/"
export AZURE_OPENAI_API_KEY="<your-key>"
```

---

## Step 2: Replace Cortex COMPLETE

### 2.1 Identify Cortex COMPLETE calls

```sql
-- Run on Snowflake to find all COMPLETE calls
SELECT DISTINCT
    REGEXP_SUBSTR(query_text, 'CORTEX\\.COMPLETE\\(''([^'']+)''', 1, 1, 'i', 1) AS model_used,
    COUNT(*) AS call_count,
    AVG(total_elapsed_time) AS avg_duration_ms
FROM snowflake.account_usage.query_history
WHERE query_text ILIKE '%CORTEX.COMPLETE%'
  AND start_time >= DATEADD(month, -1, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 2 DESC;
```

### 2.2 Python replacement function

```python
# cortex_replacement.py
from openai import AzureOpenAI
import os

client = AzureOpenAI(
    api_key=os.environ["AZURE_OPENAI_API_KEY"],
    api_version="2024-12-01-preview",
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"]
)

def cortex_complete_replacement(prompt: str, model: str = "gpt-4o",
                                  max_tokens: int = 1000,
                                  temperature: float = 0.3) -> str:
    """
    Drop-in replacement for Snowflake CORTEX.COMPLETE.

    Cortex: SNOWFLAKE.CORTEX.COMPLETE('model', 'prompt')
    Azure:  cortex_complete_replacement(prompt, model='gpt-4o')
    """
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=temperature
    )
    return response.choices[0].message.content


def cortex_summarize_replacement(text: str, max_length: int = 500) -> str:
    """
    Drop-in replacement for Snowflake CORTEX.SUMMARIZE.

    Cortex: SNOWFLAKE.CORTEX.SUMMARIZE(text)
    Azure:  cortex_summarize_replacement(text)
    """
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": "You are a federal analyst. Provide concise, accurate summaries."
            },
            {
                "role": "user",
                "content": f"Summarize the following text in a clear, concise paragraph:\n\n{text}"
            }
        ],
        max_tokens=max_length,
        temperature=0.2
    )
    return response.choices[0].message.content


def cortex_translate_replacement(text: str, source_lang: str = "en",
                                   target_lang: str = "es") -> str:
    """
    Drop-in replacement for Snowflake CORTEX.TRANSLATE.

    Cortex: SNOWFLAKE.CORTEX.TRANSLATE(text, 'en', 'es')
    Azure:  cortex_translate_replacement(text, 'en', 'es')
    """
    lang_map = {
        "en": "English", "es": "Spanish", "fr": "French",
        "de": "German", "ja": "Japanese", "zh": "Chinese",
        "ko": "Korean", "pt": "Portuguese", "ar": "Arabic"
    }
    source = lang_map.get(source_lang, source_lang)
    target = lang_map.get(target_lang, target_lang)

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": f"You are a professional translator. Translate from {source} to {target}. "
                           f"Preserve formatting, technical terminology, and tone."
            },
            {"role": "user", "content": text}
        ],
        max_tokens=len(text) * 2,  # Allow room for expansion
        temperature=0.1
    )
    return response.choices[0].message.content


def cortex_sentiment_replacement(text: str) -> float:
    """
    Drop-in replacement for Snowflake CORTEX.SENTIMENT.

    Cortex: SNOWFLAKE.CORTEX.SENTIMENT(text) -> float (-1 to 1)
    Azure:  cortex_sentiment_replacement(text) -> float (-1 to 1)
    """
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": "Analyze the sentiment of the text. Return ONLY a number between -1.0 (very negative) "
                           "and 1.0 (very positive). 0.0 is neutral. Return only the number, nothing else."
            },
            {"role": "user", "content": text}
        ],
        max_tokens=10,
        temperature=0.0
    )
    try:
        return float(response.choices[0].message.content.strip())
    except ValueError:
        return 0.0
```

### 2.3 Register as Databricks UDF

```python
# Register functions as Databricks UDFs for SQL access
from pyspark.sql.functions import udf
from pyspark.sql.types import StringType, FloatType

# Register UDFs
spark.udf.register("ai_complete", cortex_complete_replacement, StringType())
spark.udf.register("ai_summarize", cortex_summarize_replacement, StringType())
spark.udf.register("ai_translate", cortex_translate_replacement, StringType())
spark.udf.register("ai_sentiment", cortex_sentiment_replacement, FloatType())
```

### 2.4 Use in SQL (via Databricks ai_query or UDF)

```sql
-- Using Databricks ai_query() with external model connection
-- First, create the external model connection (one-time setup):
-- See Databricks docs for CREATE MODEL syntax

-- Then use in SQL:
SELECT
    document_id,
    ai_query('azure_openai_gpt4o',
        CONCAT('Summarize this government report:\n\n', document_text)
    ) AS summary
FROM analytics_prod.raw.government_reports
WHERE report_date >= '2026-01-01';
```

### 2.5 dbt macro for AI enrichment

```sql
-- macros/azure_openai.sql
{% macro azure_openai_complete(prompt, model='gpt-4o', max_tokens=500) %}
    ai_query(
        'azure_openai_{{ model | replace("-", "_") }}',
        {{ prompt }},
        {{ max_tokens }}
    )
{% endmacro %}

{% macro azure_openai_summarize(text_column) %}
    ai_query(
        'azure_openai_gpt4o',
        CONCAT('Provide a concise summary of the following text:\n\n', {{ text_column }})
    )
{% endmacro %}

{% macro azure_openai_sentiment(text_column) %}
    ai_query(
        'azure_openai_gpt4o',
        CONCAT('Return only a sentiment score from -1.0 to 1.0 for: ', {{ text_column }})
    )
{% endmacro %}
```

Use in dbt models:

```sql
-- models/enriched/enriched_feedback.sql
{{ config(materialized='incremental', unique_key='feedback_id') }}

SELECT
    feedback_id,
    feedback_text,
    {{ azure_openai_summarize('feedback_text') }} AS summary,
    CAST({{ azure_openai_sentiment('feedback_text') }} AS DOUBLE) AS sentiment_score,
    CURRENT_TIMESTAMP() AS enriched_at
FROM {{ source('raw', 'citizen_feedback') }}
{% if is_incremental() %}
WHERE submitted_at > (SELECT MAX(enriched_at) FROM {{ this }})
{% endif %}
```

---

## Step 3: Build a RAG pipeline (replace Cortex Search)

### 3.1 Set up Azure AI Search

```bash
# Create Azure AI Search resource
az search service create \
    --name "search-acmegov-analytics" \
    --resource-group "rg-analytics-prod" \
    --sku "standard" \
    --location "usgovvirginia" \
    --partition-count 1 \
    --replica-count 1
```

### 3.2 Create the search index

```python
# create_search_index.py
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex, SearchField, SearchFieldDataType,
    VectorSearch, HnswAlgorithmConfiguration,
    VectorSearchProfile, SemanticConfiguration,
    SemanticSearch, SemanticPrioritizedFields, SemanticField
)
from azure.core.credentials import AzureKeyCredential
import os

index_client = SearchIndexClient(
    endpoint=os.environ["AZURE_SEARCH_ENDPOINT"],
    credential=AzureKeyCredential(os.environ["AZURE_SEARCH_KEY"])
)

fields = [
    SearchField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
    SearchField(name="title", type=SearchFieldDataType.String, searchable=True, filterable=True),
    SearchField(name="content", type=SearchFieldDataType.String, searchable=True),
    SearchField(name="category", type=SearchFieldDataType.String, filterable=True, facetable=True),
    SearchField(name="agency", type=SearchFieldDataType.String, filterable=True, facetable=True),
    SearchField(name="published_date", type=SearchFieldDataType.DateTimeOffset, filterable=True, sortable=True),
    SearchField(
        name="content_vector",
        type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
        searchable=True,
        vector_search_dimensions=3072,
        vector_search_profile_name="vector-profile"
    )
]

vector_search = VectorSearch(
    algorithms=[HnswAlgorithmConfiguration(name="hnsw-config", parameters={"m": 4, "efConstruction": 400})],
    profiles=[VectorSearchProfile(name="vector-profile", algorithm_configuration_name="hnsw-config")]
)

semantic_config = SemanticConfiguration(
    name="semantic-config",
    prioritized_fields=SemanticPrioritizedFields(
        title_field=SemanticField(field_name="title"),
        content_fields=[SemanticField(field_name="content")]
    )
)

index = SearchIndex(
    name="government-documents",
    fields=fields,
    vector_search=vector_search,
    semantic_search=SemanticSearch(configurations=[semantic_config])
)

index_client.create_or_update_index(index)
print(f"Index 'government-documents' created successfully")
```

### 3.3 Index your documents

```python
# index_documents.py
from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential
from openai import AzureOpenAI
import os

openai_client = AzureOpenAI(
    api_key=os.environ["AZURE_OPENAI_API_KEY"],
    api_version="2024-12-01-preview",
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"]
)

search_client = SearchClient(
    endpoint=os.environ["AZURE_SEARCH_ENDPOINT"],
    index_name="government-documents",
    credential=AzureKeyCredential(os.environ["AZURE_SEARCH_KEY"])
)

def generate_embedding(text: str) -> list:
    """Generate embedding using Azure OpenAI."""
    response = openai_client.embeddings.create(
        model="text-embedding-3-large",
        input=text
    )
    return response.data[0].embedding

# Read documents from Delta Lake
documents_df = spark.table("analytics_prod.raw.government_documents").toPandas()

# Batch index documents
batch_size = 100
for i in range(0, len(documents_df), batch_size):
    batch = documents_df.iloc[i:i+batch_size]

    docs_to_upload = []
    for _, row in batch.iterrows():
        embedding = generate_embedding(row["content"][:8000])  # Truncate for token limit

        docs_to_upload.append({
            "id": str(row["document_id"]),
            "title": row["title"],
            "content": row["content"],
            "category": row["category"],
            "agency": row["agency"],
            "published_date": row["published_date"].isoformat(),
            "content_vector": embedding
        })

    result = search_client.upload_documents(documents=docs_to_upload)
    print(f"Indexed batch {i//batch_size + 1}: {len(docs_to_upload)} documents")

print(f"Total documents indexed: {len(documents_df)}")
```

### 3.4 Build the RAG query function

```python
# rag_pipeline.py
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery
from azure.core.credentials import AzureKeyCredential
from openai import AzureOpenAI
import os

openai_client = AzureOpenAI(
    api_key=os.environ["AZURE_OPENAI_API_KEY"],
    api_version="2024-12-01-preview",
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"]
)

search_client = SearchClient(
    endpoint=os.environ["AZURE_SEARCH_ENDPOINT"],
    index_name="government-documents",
    credential=AzureKeyCredential(os.environ["AZURE_SEARCH_KEY"])
)

def ask_question(question: str, top_k: int = 5,
                 category_filter: str = None) -> dict:
    """
    RAG pipeline: replace Cortex Search + EXTRACT_ANSWER.

    1. Embed the question
    2. Search Azure AI Search (hybrid: vector + keyword + semantic)
    3. Generate answer with Azure OpenAI using retrieved context
    """
    # Step 1: Generate question embedding
    embedding = openai_client.embeddings.create(
        model="text-embedding-3-large",
        input=question
    ).data[0].embedding

    # Step 2: Hybrid search
    filter_expr = f"category eq '{category_filter}'" if category_filter else None

    results = search_client.search(
        search_text=question,
        vector_queries=[
            VectorizedQuery(
                vector=embedding,
                k_nearest_neighbors=top_k,
                fields="content_vector"
            )
        ],
        filter=filter_expr,
        query_type="semantic",
        semantic_configuration_name="semantic-config",
        top=top_k
    )

    # Step 3: Build context from search results
    sources = []
    context_parts = []
    for result in results:
        sources.append({
            "id": result["id"],
            "title": result["title"],
            "score": result["@search.score"]
        })
        context_parts.append(
            f"[Source: {result['title']}]\n{result['content'][:2000]}"
        )

    context = "\n\n---\n\n".join(context_parts)

    # Step 4: Generate answer
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a federal analyst answering questions based on "
                    "government documents. Use ONLY the provided context to "
                    "answer. Cite your sources by title. If the context does "
                    "not contain the answer, say 'Information not found in "
                    "available documents.'"
                )
            },
            {
                "role": "user",
                "content": f"Context:\n{context}\n\nQuestion: {question}"
            }
        ],
        max_tokens=1000,
        temperature=0.1
    )

    return {
        "answer": response.choices[0].message.content,
        "sources": sources,
        "tokens_used": response.usage.total_tokens
    }


# Usage
result = ask_question("What is the budget allocation for cybersecurity in FY2026?")
print(f"Answer: {result['answer']}")
print(f"Sources: {result['sources']}")
```

---

## Step 4: Add content safety (replace Cortex Guard)

### 4.1 Set up Azure AI Content Safety

```bash
az cognitiveservices account create \
    --name "content-safety-acmegov" \
    --resource-group "rg-analytics-prod" \
    --kind "ContentSafety" \
    --sku "S0" \
    --location "usgovvirginia"
```

### 4.2 Implement guardrails

```python
# content_safety.py
from azure.ai.contentsafety import ContentSafetyClient
from azure.ai.contentsafety.models import AnalyzeTextOptions
from azure.core.credentials import AzureKeyCredential
import os

safety_client = ContentSafetyClient(
    endpoint=os.environ["AZURE_CONTENT_SAFETY_ENDPOINT"],
    credential=AzureKeyCredential(os.environ["AZURE_CONTENT_SAFETY_KEY"])
)

def check_safety(text: str, max_severity: int = 2) -> dict:
    """
    Check text for content safety issues.
    Returns: {"safe": bool, "categories": {...}, "blocked_reason": str|None}
    """
    request = AnalyzeTextOptions(text=text[:10000])  # API limit
    response = safety_client.analyze_text(request)

    categories = {}
    blocked = False
    blocked_reason = None

    for category in response.categories_analysis:
        categories[category.category] = category.severity
        if category.severity > max_severity:
            blocked = True
            blocked_reason = f"{category.category} severity: {category.severity}"

    return {
        "safe": not blocked,
        "categories": categories,
        "blocked_reason": blocked_reason
    }


def safe_ai_call(prompt: str, **kwargs) -> str:
    """Wrapper that adds content safety guardrails to any AI call."""
    # Check input safety
    input_check = check_safety(prompt)
    if not input_check["safe"]:
        return f"[BLOCKED] Input blocked: {input_check['blocked_reason']}"

    # Make AI call
    result = cortex_complete_replacement(prompt, **kwargs)

    # Check output safety
    output_check = check_safety(result)
    if not output_check["safe"]:
        return f"[BLOCKED] Output blocked: {output_check['blocked_reason']}"

    return result
```

---

## Step 5: Validate quality parity

### 5.1 Side-by-side comparison

```python
# validate_quality.py
import pandas as pd

# Prepare test cases from actual Cortex usage
test_cases = spark.sql("""
    SELECT DISTINCT
        document_id,
        document_text,
        -- Capture existing Cortex outputs for comparison
        existing_summary,
        existing_sentiment
    FROM analytics_prod.validation.cortex_test_cases
    LIMIT 100
""").toPandas()

results = []
for _, row in test_cases.iterrows():
    # Azure OpenAI summary
    azure_summary = cortex_summarize_replacement(row["document_text"])

    # Azure OpenAI sentiment
    azure_sentiment = cortex_sentiment_replacement(row["document_text"])

    results.append({
        "document_id": row["document_id"],
        "cortex_summary": row["existing_summary"],
        "azure_summary": azure_summary,
        "cortex_sentiment": row["existing_sentiment"],
        "azure_sentiment": azure_sentiment,
        "sentiment_diff": abs(float(row["existing_sentiment"]) - azure_sentiment)
    })

results_df = pd.DataFrame(results)

# Summary statistics
print(f"Average sentiment difference: {results_df['sentiment_diff'].mean():.3f}")
print(f"Max sentiment difference: {results_df['sentiment_diff'].max():.3f}")
print(f"Sentiment correlation: {results_df['cortex_sentiment'].astype(float).corr(results_df['azure_sentiment']):.3f}")
```

### 5.2 Quality acceptance criteria

| Metric                             | Threshold         | Notes                                |
| ---------------------------------- | ----------------- | ------------------------------------ |
| Summary ROUGE-L score vs Cortex    | >= 0.6            | Azure OpenAI typically scores higher |
| Sentiment correlation              | >= 0.85           | Strong positive correlation          |
| Extract Answer accuracy            | >= 90% match rate | On same test corpus                  |
| Translation BLEU score             | >= 0.7            | For supported language pairs         |
| Latency (p90)                      | <= 5 seconds      | For single-document calls            |
| Content safety false positive rate | <= 5%             | Review blocked content manually      |

---

## Step 6: Deploy to production

### 6.1 Production checklist

- [ ] Azure OpenAI deployed in Azure Government
- [ ] AI Search index created and populated
- [ ] Content Safety resource deployed
- [ ] External model connections configured in Databricks
- [ ] dbt macros created and tested
- [ ] UDFs registered in Unity Catalog
- [ ] Quality validation passed (Step 5)
- [ ] Cost monitoring configured (Azure OpenAI usage dashboard)
- [ ] Rate limiting configured (Azure OpenAI TPM/RPM limits)
- [ ] Error handling and retry logic implemented
- [ ] Monitoring alerts for latency and errors

### 6.2 Production architecture

```
Delta Lake tables (source data)
    ↓
dbt models with Azure OpenAI macros (enrichment)
    ↓
Enriched Delta tables (output)
    ↓
Azure AI Search index (for RAG queries)
    ↓
Power BI Copilot / custom apps (consumption)
```

---

## Related documents

- [Cortex Migration](cortex-migration.md) -- comprehensive Cortex migration guide
- [Feature Mapping](feature-mapping-complete.md) -- Section 6 for Cortex features
- [Why Azure over Snowflake](why-azure-over-snowflake.md) -- Section 7 for AI comparison
- `csa_platform/ai_integration/rag/pipeline.py` -- RAG pipeline reference implementation
- `csa_platform/ai_integration/enrichment/` -- AI enrichment patterns

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
