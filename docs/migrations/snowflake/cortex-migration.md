# Cortex AI Migration Guide

**Status:** Authored 2026-04-30
**Audience:** Data engineers, ML engineers, AI architects migrating Snowflake Cortex workloads
**Scope:** Cortex LLM Functions to Azure OpenAI, Cortex Search to Azure AI Search, Cortex Analyst to Power BI Copilot, Cortex Guard to Azure AI Content Safety, Cortex Fine-tuning to Azure OpenAI fine-tuning

---

## 1. Cortex capability inventory

Before migrating, inventory your Cortex usage. Run this on your Snowflake account:

```sql
-- Find all Cortex function calls in query history
SELECT
    query_text,
    user_name,
    warehouse_name,
    start_time,
    total_elapsed_time,
    credits_used_cloud_services
FROM snowflake.account_usage.query_history
WHERE query_text ILIKE '%SNOWFLAKE.CORTEX.COMPLETE%'
   OR query_text ILIKE '%SNOWFLAKE.CORTEX.SUMMARIZE%'
   OR query_text ILIKE '%SNOWFLAKE.CORTEX.TRANSLATE%'
   OR query_text ILIKE '%SNOWFLAKE.CORTEX.EXTRACT_ANSWER%'
   OR query_text ILIKE '%SNOWFLAKE.CORTEX.SENTIMENT%'
   OR query_text ILIKE '%CORTEX.SEARCH%'
   OR query_text ILIKE '%CORTEX.ANALYST%'
AND start_time >= DATEADD(month, -3, CURRENT_TIMESTAMP())
ORDER BY start_time DESC;
```

---

## 2. LLM function migration (COMPLETE, SUMMARIZE, TRANSLATE)

### Cortex COMPLETE to Azure OpenAI

**Snowflake Cortex (before):**

```sql
-- Cortex COMPLETE: text generation
SELECT
    document_id,
    SNOWFLAKE.CORTEX.COMPLETE(
        'llama3.1-70b',
        'Summarize the following government report in 3 bullet points: ' || document_text
    ) AS summary
FROM raw.government_reports
WHERE report_date >= '2026-01-01';
```

**Azure OpenAI via Databricks `ai_query()` (after):**

```sql
-- Databricks SQL: Azure OpenAI via ai_query()
SELECT
    document_id,
    ai_query(
        'azure_openai_gpt4o',
        'Summarize the following government report in 3 bullet points: ' || document_text
    ) AS summary
FROM analytics_prod.raw.government_reports
WHERE report_date >= '2026-01-01';
```

**Azure OpenAI via dbt macro (after):**

```sql
-- dbt model using Azure OpenAI macro
-- models/enriched/enriched_reports.sql
{{ config(materialized='incremental', unique_key='document_id') }}

SELECT
    document_id,
    document_text,
    {{ azure_openai_complete(
        model='gpt-4o',
        prompt="'Summarize the following government report in 3 bullet points: ' || document_text",
        max_tokens=500
    ) }} AS summary,
    CURRENT_TIMESTAMP() AS enriched_at
FROM {{ source('raw', 'government_reports') }}
{% if is_incremental() %}
WHERE report_date > (SELECT MAX(report_date) FROM {{ this }})
{% endif %}
```

**Azure OpenAI via Python (after):**

```python
from openai import AzureOpenAI
import os

client = AzureOpenAI(
    api_key=os.environ["AZURE_OPENAI_API_KEY"],
    api_version="2024-12-01-preview",
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"]
)

def summarize_report(document_text: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "You are a federal analyst. Summarize government reports concisely."},
            {"role": "user", "content": f"Summarize in 3 bullet points:\n\n{document_text}"}
        ],
        max_tokens=500,
        temperature=0.3
    )
    return response.choices[0].message.content
```

### Cortex SUMMARIZE to Azure OpenAI

```sql
-- Snowflake Cortex SUMMARIZE (before)
SELECT SNOWFLAKE.CORTEX.SUMMARIZE(document_text) AS summary
FROM raw.memos;

-- Azure OpenAI (after) -- more control over output
SELECT ai_query(
    'azure_openai_gpt4o',
    CONCAT(
        'Provide a concise executive summary of the following document. ',
        'Focus on key findings, recommendations, and action items:\n\n',
        document_text
    )
) AS summary
FROM analytics_prod.raw.memos;
```

### Cortex TRANSLATE to Azure AI Translator

```sql
-- Snowflake Cortex TRANSLATE (before)
SELECT SNOWFLAKE.CORTEX.TRANSLATE(
    document_text, 'en', 'es'
) AS translated_text
FROM raw.documents;

-- Azure: Two options

-- Option 1: Azure AI Translator (dedicated service, best for bulk)
-- Call via Azure Functions + Databricks external function

-- Option 2: Azure OpenAI (context-aware translation)
SELECT ai_query(
    'azure_openai_gpt4o',
    CONCAT(
        'Translate the following text from English to Spanish. ',
        'Preserve formatting and technical terminology:\n\n',
        document_text
    )
) AS translated_text
FROM analytics_prod.raw.documents;
```

---

## 3. Cortex EXTRACT_ANSWER to Azure OpenAI + RAG

### Simple extractive QA

```sql
-- Snowflake Cortex EXTRACT_ANSWER (before)
SELECT SNOWFLAKE.CORTEX.EXTRACT_ANSWER(
    document_text,
    'What is the total budget allocation for FY2026?'
) AS answer
FROM raw.budget_documents;

-- Azure OpenAI (after)
SELECT ai_query(
    'azure_openai_gpt4o',
    CONCAT(
        'Based on the following document, answer the question precisely. ',
        'If the answer is not in the document, say "Not found".\n\n',
        'Document:\n', document_text, '\n\n',
        'Question: What is the total budget allocation for FY2026?'
    )
) AS answer
FROM analytics_prod.raw.budget_documents;
```

### RAG pipeline (for corpus-level QA)

For answering questions across a large corpus rather than a single document, build a RAG pipeline with Azure AI Search:

```python
# RAG pipeline: Azure AI Search + Azure OpenAI
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery
from openai import AzureOpenAI
import os

# 1. Search for relevant documents
search_client = SearchClient(
    endpoint=os.environ["AZURE_SEARCH_ENDPOINT"],
    index_name="government-documents",
    credential=os.environ["AZURE_SEARCH_KEY"]
)

openai_client = AzureOpenAI(
    api_key=os.environ["AZURE_OPENAI_API_KEY"],
    api_version="2024-12-01-preview",
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"]
)

def ask_question(question: str) -> str:
    # Generate embedding for the question
    embedding = openai_client.embeddings.create(
        model="text-embedding-3-large",
        input=question
    ).data[0].embedding

    # Search for relevant documents
    results = search_client.search(
        search_text=question,
        vector_queries=[
            VectorizedQuery(
                vector=embedding,
                k_nearest_neighbors=5,
                fields="content_vector"
            )
        ],
        top=5
    )

    # Build context from search results
    context = "\n\n---\n\n".join([
        f"Source: {r['title']}\n{r['content']}"
        for r in results
    ])

    # Generate answer
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": "You are a federal analyst. Answer questions using only the provided context. Cite your sources."},
            {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {question}"}
        ],
        max_tokens=1000,
        temperature=0.1
    )

    return response.choices[0].message.content
```

See `csa_platform/ai_integration/rag/pipeline.py` for the full reference implementation.

---

## 4. Cortex SENTIMENT to Azure AI Language

```sql
-- Snowflake Cortex SENTIMENT (before)
SELECT
    feedback_id,
    feedback_text,
    SNOWFLAKE.CORTEX.SENTIMENT(feedback_text) AS sentiment_score
FROM raw.citizen_feedback;

-- Azure: Two options

-- Option 1: Azure AI Language (dedicated sentiment API)
-- Call via Azure Functions + Databricks external function

-- Option 2: Azure OpenAI (more nuanced analysis)
SELECT
    feedback_id,
    feedback_text,
    ai_query(
        'azure_openai_gpt4o',
        CONCAT(
            'Analyze the sentiment of the following text. ',
            'Return a JSON object with: score (-1.0 to 1.0), ',
            'label (positive/negative/neutral/mixed), ',
            'and a one-sentence explanation.\n\n',
            'Text: ', feedback_text
        )
    ) AS sentiment_analysis
FROM analytics_prod.raw.citizen_feedback;
```

---

## 5. Cortex Search to Azure AI Search

### Architecture comparison

| Cortex Search | Azure AI Search |
|---|---|
| Built into Snowflake SQL | Standalone Azure service |
| Hybrid vector + keyword search | Hybrid vector + keyword + semantic ranking |
| Snowflake-managed embeddings | You choose embedding model (Azure OpenAI) |
| Limited to data in Snowflake | Indexes any data source |
| SQL interface only | REST API + SDK + SQL (via external function) |
| Not available in Gov | **GA in Gov** |

### Migration steps

**Step 1: Create the Azure AI Search index**

```python
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SearchField,
    SearchFieldDataType,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
    SemanticConfiguration,
    SemanticSearch,
    SemanticPrioritizedFields,
    SemanticField
)

index_client = SearchIndexClient(
    endpoint=os.environ["AZURE_SEARCH_ENDPOINT"],
    credential=os.environ["AZURE_SEARCH_KEY"]
)

fields = [
    SearchField(name="id", type=SearchFieldDataType.String, key=True),
    SearchField(name="title", type=SearchFieldDataType.String, searchable=True),
    SearchField(name="content", type=SearchFieldDataType.String, searchable=True),
    SearchField(
        name="content_vector",
        type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
        searchable=True,
        vector_search_dimensions=3072,
        vector_search_profile_name="vector-profile"
    ),
    SearchField(name="category", type=SearchFieldDataType.String, filterable=True),
    SearchField(name="published_date", type=SearchFieldDataType.DateTimeOffset, filterable=True, sortable=True)
]

vector_search = VectorSearch(
    algorithms=[HnswAlgorithmConfiguration(name="hnsw-config")],
    profiles=[VectorSearchProfile(name="vector-profile", algorithm_configuration_name="hnsw-config")]
)

semantic_config = SemanticConfiguration(
    name="semantic-config",
    prioritized_fields=SemanticPrioritizedFields(
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
```

**Step 2: Index your data**

```python
from azure.search.documents import SearchClient

search_client = SearchClient(
    endpoint=os.environ["AZURE_SEARCH_ENDPOINT"],
    index_name="government-documents",
    credential=os.environ["AZURE_SEARCH_KEY"]
)

# Generate embeddings and upload documents
documents = []
for row in spark.table("analytics_prod.raw.documents").collect():
    embedding = openai_client.embeddings.create(
        model="text-embedding-3-large",
        input=row["content"]
    ).data[0].embedding
    
    documents.append({
        "id": row["document_id"],
        "title": row["title"],
        "content": row["content"],
        "content_vector": embedding,
        "category": row["category"],
        "published_date": row["published_date"].isoformat()
    })

# Upload in batches
search_client.upload_documents(documents)
```

**Step 3: Query from Databricks**

```python
# Create an external function for SQL access
def search_documents(query: str, top_k: int = 5) -> list:
    embedding = openai_client.embeddings.create(
        model="text-embedding-3-large",
        input=query
    ).data[0].embedding
    
    results = search_client.search(
        search_text=query,
        vector_queries=[
            VectorizedQuery(vector=embedding, k_nearest_neighbors=top_k, fields="content_vector")
        ],
        top=top_k
    )
    return [{"id": r["id"], "title": r["title"], "score": r["@search.score"]} for r in results]
```

---

## 6. Cortex Analyst to Power BI Copilot

### Cortex Analyst

Cortex Analyst provides natural-language querying over Snowflake data:

- User asks a question in English
- Cortex generates SQL and executes it
- Results returned as a table or visualization
- Limited to Snowflake data; limited model selection
- **Not available in Gov**

### Power BI Copilot

Power BI Copilot provides the same capability with deeper integration:

- Natural-language questions over Power BI semantic models
- Generates DAX queries and visualizations
- Creates report pages from descriptions
- Summarizes data insights
- Works with Direct Lake mode (no data import needed)
- **GA in Azure Government**

### Migration path

1. Ensure your data is accessible via a Power BI semantic model (Direct Lake on Delta Lake)
2. Enable Copilot in Power BI workspace settings
3. Train users on natural-language query patterns
4. No code migration needed -- Copilot works over the semantic model layer

---

## 7. Cortex Guard to Azure AI Content Safety

### Cortex Guard features

- Prompt injection detection
- PII detection in prompts/responses
- Content filtering (hate, violence, sexual, self-harm)
- **Not available in Gov**

### Azure AI Content Safety (replacement)

```python
from azure.ai.contentsafety import ContentSafetyClient
from azure.ai.contentsafety.models import AnalyzeTextOptions, TextCategory

client = ContentSafetyClient(
    endpoint=os.environ["AZURE_CONTENT_SAFETY_ENDPOINT"],
    credential=os.environ["AZURE_CONTENT_SAFETY_KEY"]
)

def check_content_safety(text: str) -> dict:
    request = AnalyzeTextOptions(text=text)
    response = client.analyze_text(request)
    
    results = {}
    for category_result in response.categories_analysis:
        results[category_result.category] = {
            "severity": category_result.severity
        }
    
    return results

# Use as a guardrail before/after LLM calls
def safe_generate(prompt: str) -> str:
    # Check input
    input_safety = check_content_safety(prompt)
    if any(r["severity"] >= 4 for r in input_safety.values()):
        return "Content blocked: input contains unsafe content"
    
    # Generate response
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}]
    )
    output = response.choices[0].message.content
    
    # Check output
    output_safety = check_content_safety(output)
    if any(r["severity"] >= 4 for r in output_safety.values()):
        return "Content blocked: response contains unsafe content"
    
    return output
```

### Azure OpenAI built-in content filtering

Azure OpenAI also includes built-in content filtering:

- Enabled by default on all Azure OpenAI deployments
- Configurable severity thresholds per category
- Prompt shields for jailbreak detection
- Groundedness detection for hallucination prevention
- No additional code needed -- it is part of the Azure OpenAI service

---

## 8. Cortex Fine-tuning to Azure OpenAI Fine-tuning

### Cortex Fine-tuning

- Fine-tune selected models on your data
- **Not available in Gov**

### Azure OpenAI Fine-tuning

```python
from openai import AzureOpenAI
import json

client = AzureOpenAI(
    api_key=os.environ["AZURE_OPENAI_API_KEY"],
    api_version="2024-12-01-preview",
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"]
)

# Step 1: Prepare training data (JSONL format)
training_data = [
    {
        "messages": [
            {"role": "system", "content": "You classify federal procurement documents."},
            {"role": "user", "content": "Contract for IT services with ABC Corp, value $2.5M, period of performance 2026-2028."},
            {"role": "assistant", "content": "Category: IT Services\nValue: $2,500,000\nPOP: 2026-2028\nVendor: ABC Corp"}
        ]
    },
    # ... more examples
]

with open("training_data.jsonl", "w") as f:
    for example in training_data:
        f.write(json.dumps(example) + "\n")

# Step 2: Upload training file
file = client.files.create(
    file=open("training_data.jsonl", "rb"),
    purpose="fine-tune"
)

# Step 3: Create fine-tuning job
job = client.fine_tuning.jobs.create(
    model="gpt-4o-mini-2024-07-18",
    training_file=file.id,
    hyperparameters={"n_epochs": 3}
)

# Step 4: Monitor and deploy
# Fine-tuned model available as a deployment in Azure OpenAI
```

---

## 9. Migration execution checklist

- [ ] Inventory all Cortex function calls in query history
- [ ] Classify by type: COMPLETE, SUMMARIZE, TRANSLATE, EXTRACT_ANSWER, SENTIMENT, Search, Analyst, Guard
- [ ] Deploy Azure OpenAI in Azure Government
- [ ] Deploy Azure AI Search (if using Cortex Search)
- [ ] Deploy Azure AI Content Safety (if using Cortex Guard)
- [ ] Create `ai_query()` external model connections in Databricks
- [ ] Migrate COMPLETE calls to Azure OpenAI
- [ ] Migrate SUMMARIZE calls to Azure OpenAI
- [ ] Migrate TRANSLATE calls to Azure AI Translator or Azure OpenAI
- [ ] Migrate EXTRACT_ANSWER calls to RAG pipeline
- [ ] Migrate SENTIMENT calls to Azure AI Language or Azure OpenAI
- [ ] Build Azure AI Search indexes (if using Cortex Search)
- [ ] Enable Power BI Copilot (if using Cortex Analyst)
- [ ] Implement content safety guardrails (if using Cortex Guard)
- [ ] Set up fine-tuned models (if using Cortex Fine-tuning)
- [ ] Benchmark quality: compare outputs side-by-side
- [ ] Benchmark cost: compare token usage and pricing
- [ ] Validate in Gov environment

---

## Related documents

- [Tutorial: Cortex to Azure AI](tutorial-cortex-to-azure-ai.md) -- step-by-step hands-on tutorial
- [Feature Mapping](feature-mapping-complete.md) -- Section 6 for Cortex features
- [Why Azure over Snowflake](why-azure-over-snowflake.md) -- Section 7 for AI comparison
- [Benchmarks](benchmarks.md) -- AI capability benchmarks
- `csa_platform/ai_integration/README.md` -- AI integration reference
- `csa_platform/ai_integration/rag/pipeline.py` -- RAG pipeline reference implementation

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
