[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **OpenAI Throttling**

# Runbook — Azure OpenAI Throttling & Quota Management

> **Scope:** Detection, triage, and resolution of Azure OpenAI Service throttling events across all CSA-in-a-Box deployments. Covers quota management, model fallback strategies, prompt optimization, and PTU vs Pay-As-You-Go capacity planning.

---

## Before First Use — Customization Checklist

- [ ] Populate the [Contact Information](#contact-information) table.
- [ ] Confirm Azure OpenAI resource names per environment (dev / staging / prod).
- [ ] Confirm model deployment names and their assigned TPM / RPM quotas.
- [ ] Verify fallback model deployments exist in each region.
- [ ] Confirm Azure Monitor alert action groups are wired to your on-call rotation.

---

## Symptoms

| Symptom                                     | Where you see it                              | Severity                |
| ------------------------------------------- | --------------------------------------------- | ----------------------- |
| HTTP 429 responses from Azure OpenAI        | Application logs, Azure Monitor               | P1 if sustained > 5 min |
| Increased end-to-end latency on AI features | Application Insights, user reports            | P2                      |
| Request queue depth growing                 | Application metrics, Service Bus queue length | P2                      |
| Token-per-minute (TPM) limit warnings       | Azure Monitor metrics, OpenAI resource blade  | P3                      |
| Requests-per-minute (RPM) limit warnings    | Azure Monitor metrics                         | P3                      |
| Content filter triggering at elevated rate  | Azure OpenAI metrics                          | P3                      |

---

## Triage

### Step 1 — Confirm throttling is occurring

- [ ] Open Azure Monitor for the OpenAI resource and check the **Azure OpenAI Requests** metric filtered by `StatusCode = 429`:

```kql
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES"
| where OperationName == "ChatCompletions_Create" or OperationName == "Completions_Create"
| where TimeGenerated > ago(1h)
| where ResultSignature == "429"
| summarize throttledCount = count() by bin(TimeGenerated, 5m), _ResourceId
| order by TimeGenerated desc
```

### Step 2 — Identify which deployments are hitting limits

- [ ] Break down usage by model deployment:

```kql
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES"
| where TimeGenerated > ago(1h)
| extend deployment = tostring(properties_s)
| summarize totalRequests = count(), throttled = countif(ResultSignature == "429")
    by deployment, bin(TimeGenerated, 5m)
| extend throttleRate = round(100.0 * throttled / totalRequests, 1)
| order by throttleRate desc
```

### Step 3 — Check TPM and RPM quotas vs actual usage

- [ ] Open the Azure OpenAI resource blade > **Quotas** and compare assigned quota to the metrics from Step 2.
- [ ] Run the following to see token consumption over the last hour:

```bash
az monitor metrics list \
  --resource "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>" \
  --metric "TokenTransaction" \
  --interval PT1M \
  --aggregation Total \
  --start-time "$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)"
```

### Step 4 — Determine if spike is organic or runaway

- [ ] Check application logs for retry loops or recursive calls that may be amplifying requests.
- [ ] Look for batch jobs or data pipeline runs that started recently.
- [ ] Confirm no deployment or configuration change was pushed in the last hour.

---

## Response Actions

### P1 — Active throttling impacting users (429 rate > 10%)

!!! danger
User-facing AI features are degraded. Act immediately.

- [ ] **Implement circuit breaker.** If your application does not already have one, enable it now to stop sending requests to the throttled deployment:

```python
# Example: set circuit breaker threshold
CIRCUIT_BREAKER_THRESHOLD = 5  # consecutive 429s before opening circuit
CIRCUIT_BREAKER_RESET_SECONDS = 60
```

- [ ] **Route to fallback model.** Switch traffic from the throttled deployment to the fallback (see [Model Fallback Patterns](#model-fallback-patterns)).
- [ ] **Request quota increase** if the spike is legitimate growth:

```bash
# Check current quota
az cognitiveservices account deployment list \
  --name <account> --resource-group <rg> \
  --query '[].{name:name, model:properties.model.name, tpm:properties.rateLimits[0].count}'

# Request increase via support ticket or adjust in portal
# Azure Portal > OpenAI resource > Model deployments > Edit > Scale up TPM
```

- [ ] **Notify stakeholders** that AI features are operating in degraded mode.

### P2 — Approaching limits (429 rate 1–10%)

- [ ] **Add retry with exponential backoff** if not already in place:

```python
import tenacity

@tenacity.retry(
    retry=tenacity.retry_if_exception_type(openai.RateLimitError),
    wait=tenacity.wait_exponential(multiplier=1, min=1, max=60),
    stop=tenacity.stop_after_attempt(6),
)
def call_openai(prompt: str) -> str:
    ...
```

- [ ] **Enable request queuing.** Buffer non-urgent requests and process them at a controlled rate to stay within TPM limits.
- [ ] **Review recent traffic patterns** to determine if quota should be permanently increased.

### P3 — Optimization opportunity (no active impact)

- [ ] Review and optimize prompt lengths (see [Prompt Optimization](#prompt-optimization)).
- [ ] Implement semantic caching for repeated queries.
- [ ] Evaluate whether Batch API can absorb non-real-time workloads.

---

## PTU vs Pay-As-You-Go Decision

Provisioned Throughput Units (PTU) provide reserved capacity with guaranteed throughput. Use this decision framework when evaluating capacity strategy.

### When PTU makes sense

| Factor               | PTU recommended                 | PAYG recommended            |
| -------------------- | ------------------------------- | --------------------------- |
| Utilization pattern  | Predictable, > 60% sustained    | Bursty, < 40% average       |
| Latency requirements | Consistent low-latency required | Variable latency acceptable |
| Cost predictability  | Fixed monthly budget preferred  | Variable spend acceptable   |
| Scale                | High volume (> 100K TPM steady) | Low-to-moderate volume      |

### How to calculate PTU requirements

- [ ] Collect 7 days of token usage metrics (input + output tokens per minute).
- [ ] Identify the P95 peak TPM across that window.
- [ ] Use the [Azure OpenAI capacity calculator](https://oai.azure.com/portal/calculator) to map TPM to PTU count.
- [ ] Add 20% headroom above P95 for organic growth.

### Mixed deployment strategy (recommended)

!!! tip
Deploy a PTU-backed deployment for baseline load and a PAYG deployment for burst capacity. Route overflow traffic to PAYG when PTU utilization exceeds 80%.

```
┌──────────────┐     ┌───────────────────┐
│  Application │────>│  Load Balancer /  │
│              │     │  Router           │
└──────────────┘     └───┬───────────┬───┘
                         │           │
                    ┌────▼────┐ ┌────▼────┐
                    │  PTU    │ │  PAYG   │
                    │  (base) │ │ (burst) │
                    └─────────┘ └─────────┘
```

---

## Model Fallback Patterns

### Primary to fallback routing

Configure your application to route requests through a fallback chain when the primary model is throttled or unavailable:

| Priority      | Model                     | Use case                                 | TPM allocation |
| ------------- | ------------------------- | ---------------------------------------- | -------------- |
| 1 (primary)   | gpt-4o                    | Complex reasoning, structured output     | 80K TPM        |
| 2 (fallback)  | gpt-4o-mini               | Simpler tasks, high-volume summarization | 120K TPM       |
| 3 (emergency) | gpt-4o (secondary region) | DR / total regional failure              | 40K TPM        |

- [ ] Verify fallback deployments exist and are healthy before you need them.
- [ ] Test the fallback path monthly as part of DR drills.

### Multi-region deployment for HA

- [ ] Deploy Azure OpenAI resources in at least two regions (e.g., East US 2 + West US).
- [ ] Use Azure API Management or Azure Front Door to route between regions.
- [ ] Monitor per-region utilization to avoid asymmetric loading.

### Content safety filter impact

!!! warning
Content safety filters consume tokens and count toward your quota. High filter-trigger rates reduce effective throughput. Monitor the `ContentFilteredCount` metric and tune filter settings if false positives are excessive.

---

## Prompt Optimization

### Token reduction strategies

- [ ] **Remove boilerplate.** Strip redundant system instructions; move stable context to fine-tuned models or system message caching.
- [ ] **Compress few-shot examples.** Use the minimum number of examples needed for quality. Benchmark 0-shot vs 2-shot vs 5-shot.
- [ ] **Limit input context.** Truncate or summarize long documents before sending to the model. Use embeddings + retrieval instead of stuffing the full document into the prompt.
- [ ] **Use structured output.** Request JSON mode or constrained output to reduce wasted output tokens.

### Prompt caching

Azure OpenAI supports automatic prompt caching for prompts longer than 1,024 tokens. Cached prompt prefixes reduce both cost and latency.

- [ ] Structure prompts so the stable prefix (system message + instructions) comes first.
- [ ] Monitor the `CacheHitRate` metric to validate caching is working.

### Response length limits

- [ ] Set `max_tokens` on every request to prevent runaway output generation.
- [ ] Use `stop` sequences where applicable to terminate output early.

### Batch API for non-real-time workloads

- [ ] Migrate background processing (document summarization, bulk classification) to the Batch API for 50% cost reduction.
- [ ] Batch API has separate quota from real-time deployments and does not contribute to 429 pressure.

---

## Monitoring Setup

### Custom Azure Monitor dashboard

Create a dashboard with the following tiles:

1. **Requests by status code** — stacked bar chart, 5-minute granularity.
2. **Token consumption** — line chart, TPM vs quota limit.
3. **P95 latency** — line chart by model deployment.
4. **429 rate** — percentage gauge with threshold coloring.

### KQL queries for ongoing monitoring

```kql
// Token consumption trend — last 24 hours
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES"
| where TimeGenerated > ago(24h)
| extend promptTokens = toint(properties_promptTokens_d)
| extend completionTokens = toint(properties_completionTokens_d)
| summarize totalPrompt = sum(promptTokens), totalCompletion = sum(completionTokens)
    by bin(TimeGenerated, 15m)
| extend totalTokens = totalPrompt + totalCompletion
| render timechart
```

```kql
// Throttle events correlated with deployment
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES"
| where ResultSignature == "429"
| where TimeGenerated > ago(6h)
| summarize count() by bin(TimeGenerated, 5m), tostring(properties_modelDeploymentName_s)
| render timechart
```

### Alert rules

| Alert                | Condition                     | Severity | Action                         |
| -------------------- | ----------------------------- | -------- | ------------------------------ |
| Sustained throttling | 429 count > 50 in 5 min       | Sev 1    | Page on-call, trigger fallback |
| Quota approaching    | TPM > 80% of limit for 15 min | Sev 2    | Notify platform team           |
| Latency degradation  | P95 latency > 10s for 10 min  | Sev 2    | Notify platform team           |
| Batch API failures   | Batch job failure rate > 5%   | Sev 3    | Email platform team            |

---

## Contact Information

!!! warning
**Action Required:** Populate these before first production use.

| Role                | Contact                                                                                        | Phone                        | Escalation                   |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| AI Platform On-Call | _(set via your org's AI/ML team)_                                                              | _(see PagerDuty / OpsGenie)_ | Throttling P1 events         |
| Platform Team Lead  | _(set via your org's platform team)_                                                           | _(see PagerDuty / OpsGenie)_ | Quota increase requests      |
| Application Owner   | _(per-application — see service catalog)_                                                      | _(DL)_                       | Runaway loop investigation   |
| Azure Support       | [Case via Portal](https://portal.azure.com/#blade/Microsoft_Azure_Support/HelpAndSupportBlade) | N/A                          | PTU provisioning, quota lift |

---

## Related Documentation

- [Dead-Letter Queue](./dead-letter.md) — Failed AI request quarantine
- [Cost Alert Response](./cost-alert-response.md) — Budget impact from OpenAI spend
- [DR Drill](./dr-drill.md) — Multi-region failover testing
- [Security Incident](./security-incident.md) — Compromised API key response
- [AI/ML Platform Architecture](../reference-architecture/ai-ml-architecture.md) — Azure OpenAI architecture overview
