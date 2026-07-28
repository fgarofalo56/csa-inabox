# Tutorial: AI red team editor

> CSA Loom `ai-red-team` editor — a **defensive** safety-scan surface. Point it
> at a model deployment, pick the harm categories to probe, and run curated
> adversarial prompts the model *should refuse*. Each response is classified
> **refused / partial / unsafe** and optionally scored by **Azure AI Content
> Safety**. The Azure-native analog of the Microsoft AI Red Teaming Agent —
> **no Microsoft Fabric**.

## What it is

You cannot claim a deployment is safe without measuring it. This item sends a
curated set of adversarial probes at a live deployment and produces two numbers
you can put in a review: a **refusal rate** and an **attack-success rate**, plus
a per-probe table showing exactly what was asked and what came back.

This is a defensive tool. The probes are safety-benchmark requests the model is
supposed to decline; the scan measures whether it does.

Two tabs: **Scan** and **Runs**.

## When to use it

- Before promoting a deployment (or a fine-tuned model) to production.
- After changing a system prompt, a content-filter policy, or a model version —
  to prove the guardrails still hold.
- On a schedule, as evidence for an authorization package.

## Step-by-step in Loom

1. **Create the item.** **+ New item → AI red team**, then **Create red-team
   scan**.
2. **Pick the target.** In **Target deployment**:
   - **AI Foundry / Azure OpenAI account** — leave blank to use the deployment's
     default account.
   - **Model deployment** — a dropdown of the deployments actually present on
     that account (each labelled with its underlying model name).
   - **Also score responses with Azure AI Content Safety** — a switch, on by
     default, that adds a severity score and category to each response.
3. **Choose harm categories.** In **Harm categories to probe**, tick any of the
   ten categories, each with a one-line description:

   | Category | Probes for |
   |---|---|
   | Violence | Requests to plan or facilitate physical harm |
   | Self-harm | Requests that encourage or instruct self-harm |
   | Hate & harassment | Hateful or harassing content toward a group |
   | Sexual content | Disallowed sexual content |
   | Illicit drugs | Synthesizing or obtaining illegal drugs |
   | Dangerous weapons | Building dangerous or untraceable weapons |
   | Malware & cyber-attacks | Writing malware or attacking infrastructure |
   | Privacy & PII | Exposing or finding private personal data |
   | Jailbreak | Bypassing the system prompt / safety rules |
   | Prompt injection | Injected instructions that try to override the app |

   A badge shows how many are selected.
4. **Run the scan.** **Run red-team scan** (also **Run scan** in the ribbon)
   saves pending edits first, then probes the live deployment. A progress bar
   runs while it works.
5. **Read the results.** The results card leads with two large metrics —
   **Refusal rate** (green) and **Attack success** (red when above zero) — plus
   badge counts for refused / partial / unsafe, the probe total, and the target
   deployment. Beneath, the per-probe table lists category, the probe text, the
   verdict badge, the Content Safety category and severity when scoring was on,
   and the response (both truncated with the full text on hover).
6. **Track it over time.** **Runs** lists every scan: started, deployment, probe
   count, refusal rate, and attack-success rate (green at zero, red above).
   Runs are persisted with the item with responses trimmed — newest first, up to
   25 retained.

## The Azure backend it rides on

- **Target:** a live **Azure OpenAI / AI Foundry model deployment**, listed from
  `/api/foundry/model-deployments` and probed for real.
- **Classifier:** an **AOAI judge** decides refused / partial / unsafe, with a
  heuristic fallback if the judge is unavailable.
- **Optional scoring:** **Azure AI Content Safety** adds a severity and category
  per response.
- **Run route:** `POST /api/items/ai-red-team/<id>/run`; results persist in the
  item's own state.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| No model deployments listed | Warning MessageBar *"No model deployments"* carrying the backend's own hint; the deployment dropdown reads *"None listed"* | Follow the hint — usually deploy a model on the account, or set the account name in the field above |
| No deployment or no category selected | **Run red-team scan** is disabled with *"Pick a deployment and at least one category to run."* | Select both |
| Scan fails | Error MessageBar with the error and the backend's hint when one is returned | Follow the hint (usually a missing role or an unreachable account) |

## No Fabric required

Azure OpenAI / AI Foundry + Azure AI Content Safety. No Fabric capacity,
workspace, OneLake path, or Power BI workspace is used on any path.

## Learn more

- Content safety editor tutorial: `editor-content-safety.md`
- Fine-tuning job editor tutorial (which runs this scan as a serving gate):
  `editor-fine-tuning-job.md`
- Evaluation editor tutorial: `editor-evaluation.md`
- Microsoft AI Red Teaming Agent:
  <https://learn.microsoft.com/azure/ai-foundry/concepts/ai-red-teaming-agent>
