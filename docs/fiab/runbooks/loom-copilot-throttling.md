# Runbook — Loom Copilot throttling

## Symptom

Loom Copilot returns 429 (rate-limited) errors. Console chat sidebar
shows "I'm temporarily rate-limited; please retry in a moment."

## Diagnosis

```bash
# 1. Check AOAI deployment TPM usage
az cognitiveservices account deployment list \
  --resource-group <rg> \
  --name <aoai-account> \
  --query "[].{name:name,tpm:properties.scaleSettings.capacity}"

# 2. Check actual TPM consumption (App Insights)
# Query:
CopilotChatLogs
| where TimeGenerated > ago(1h)
| where ResponseCode == "429"
| summarize count() by bin(TimeGenerated, 5m), deploymentName

# 3. Check per-user request rate
CopilotChatLogs
| where TimeGenerated > ago(1h)
| summarize requests = count() by userPrincipalName, bin(TimeGenerated, 5m)
| order by requests desc

# 4. Check the rate-limit configuration in azure-functions/copilot-chat
# See _rate_limits in function_app.py
```

## Common causes + fixes

| Cause | Fix |
|---|---|
| AOAI deployment TPM at quota | Scale TPM up via Azure portal; or split across multiple deployments |
| Single user / bot driving most traffic | Apply per-user rate limit (already in function_app.py); identify + contact user |
| Burst from multiple users (e.g., demo) | Pre-scale TPM before known demo windows |
| Cross-region TPM not provisioned (Data Zone Standard) | Add Data Zone Standard deployment in paired region |
| Long-context conversations (large input/output tokens) | Apply token budget per request (already in function_app.py) |
| AOAI deployment soft-deleted / wrong endpoint | Verify Console "Admin → AI Settings" points at active deployment |

## Remediation

1. **Identify** the throttling cause (which user / which deployment)
2. **Apply fix** per table — usually scale TPM or split deployments
3. **Verify** new requests succeed:
   ```bash
   curl https://<console-url>/api/loom-chat -X POST \
     -H "Authorization: Bearer <token>" \
     -d '{"message": "test"}'
   ```
4. **Backlog** any requests that 429'd during outage (Console
   "Copilot → Pending" pane shows queued)

## Prevention

- Monitor `copilot-429-rate` > 1% → alert
- Use Provisioned Managed Throughput (PMT) for stable production
  workloads instead of PAYG Standard
- Pre-scale TPM before known demos / training events
- Per-user rate limits already enforced in `function_app.py` (see
  [[copilot-chat-two-backends]] memory)

## Related

- Workload: [Copilot parity](../workloads/copilot-parity.md)
- Memory: [[copilot-chat-two-backends]]
- Parent runbook: [Azure OpenAI throttling](../../runbooks/openai-throttling.md)
