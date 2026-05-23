# PRP-13 — Defender AI Threat Protection Workaround (Sentinel Pipeline)

## Context

Defender for Cloud AI Threat Protection is Commercial-only. Federal
customers running AI workloads in Gov need equivalent SOC alerting
via Azure Monitor + Sentinel custom rules + manual Content Safety log
wiring + self-hosted Presidio for PII.

PRD ref: `temp/fiab-prd/08-observability-security.md` §8.5.

## Goal

A Sentinel-based SOC pipeline that gives Gov customers equivalent
visibility to Defender for Cloud AI TP for Loom Copilot + Data Agents
workloads.

## Acceptance criteria

- [ ] Bicep module `platform/fiab/bicep/modules/admin-plane/sentinel-ai-rules.bicep`
  provisions:
  - LAW workspace tables for Loom Copilot telemetry (custom DCR)
  - Sentinel analytics rules (per PRD §8.5):
    - "Excessive PII redactions per user" (N/15-min)
    - "Off-topic refusals spike" (N/15-min — possible prompt injection)
    - "Unusually long outputs" (likely jailbreak)
    - "High-rate same-prompt repetition" (likely bot/script)
    - "Cross-workspace exfiltration pattern"
  - Sentinel workbook "Loom Copilot SOC Dashboard"
- [ ] Self-hosted Presidio container for PII detection where Content
  Safety unavailable (Gov-H/IL5)
- [ ] Loom Copilot telemetry emitter (existing `redaction.py` +
  `telemetry.py` from `azure-functions/copilot-chat/`) extended with
  fields: input length, output length, model invoked, PII detection
  results, Content Safety check results (where available), off-topic /
  refusal detection, user session ID, conversation ID
- [ ] DCR (Data Collection Rule) routes Copilot telemetry to the
  dedicated Sentinel table
- [ ] Documentation: `docs/fiab/compliance/defender-ai-workaround.md`
  (by PRP-18)

## Validation gates

- Inject synthetic high-PII prompts → assert Sentinel incident fires
  within 15 min
- Inject prompt-injection-style off-topic prompts → assert low-sev
  incident
- Workbook renders with realistic data

## Implementation outline

1. Bicep for Sentinel rules + workbook
2. Extend `redaction.py` to emit telemetry on every detection
3. DCR config to route Copilot telemetry table to Sentinel
4. Presidio Container App / AKS workload deploy module
5. Loom Copilot side-car call to Presidio before LLM (Gov-H / IL5)
6. Documentation in PRP-18

## File changes

```
platform/fiab/bicep/modules/admin-plane/sentinel-ai-rules.bicep    created
platform/fiab/bicep/modules/admin-plane/presidio-sidecar.bicep     created (Gov tiers only)
azure-functions/copilot-chat/redaction.py                          modified (emit telemetry)
azure-functions/copilot-chat/telemetry.py                          modified (new fields)
.github/scripts/sentinel-workbook-deploy.sh                        created
docs/fiab/compliance/defender-ai-workaround.md                     created (by PRP-18)
```

## References

- `temp/fiab-prd/08-observability-security.md` §8.5
- `temp/fiab-research/02-gov-boundary-availability.md` §1
- Memory: [[copilot-chat-two-backends]]
