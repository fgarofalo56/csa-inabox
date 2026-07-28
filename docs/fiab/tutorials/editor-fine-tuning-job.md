# Tutorial: Fine-tuning job editor

> CSA Loom `fine-tuning-job` editor — fine-tune a base chat model on your own
> labelled examples using **Azure OpenAI in Azure AI Foundry fine-tuning** (the
> Azure-native **default**, Gov-correct against `*.openai.azure.us`), then deploy
> it, red-team it, and approve it for serving. One-for-one with the Foundry
> *Fine-tuning* experience. **No Microsoft Fabric.**

## What it is

A complete fine-tuning lifecycle in four tabs, with a **safety gate before
serving**:

| Tab | What it does |
|---|---|
| **Overview** | Backend badge, live job list with status, select / bind, per-row Cancel |
| **Submit job** | Base model + training JSONL (validated) + hyperparameters → a real job |
| **Progress** | Real per-step training / validation loss events |
| **Safety & deploy** | Deploy the resulting model, run the red-team + Content Safety evaluation, and approve it for serving **only on pass** |

## When to use it

- A base model needs your domain's tone, format, or terminology and prompting
  alone is not enough.
- You need evidence — a refusal rate, an attack-success rate, a harmful-completion
  count — before a tuned model is allowed anywhere near production.
- If you only need grounding on your own documents, use a data agent with
  retrieval instead; fine-tuning teaches behaviour, not facts.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Fine-tuning job**. The header badge names
   the active backend, and **Overview** lists live jobs with their status read
   from the real backend.
2. **Prepare training data.** One chat example per line of JSONL:
   ```json
   {"messages":[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
   ```
   **At least 10 valid examples** are required.
3. **Submit the job.** On **Submit job**:
   - **Base model** — a dropdown of the models actually available on your
     account (falls back to a text input if the list could not be read).
   - **Suffix** — names the resulting model.
   - **Epochs** — blank means auto.
   - **Seed** — optional, for reproducibility.
   - **Training data (JSONL)** — pasted into the editor.

   **Submit fine-tuning job** runs the **training-data-eval gate** first — the
   data is validated and uploaded before a real job is created. Invalid data is
   rejected with the reason, not silently accepted.
4. **Watch training.** Select the job and open **Progress**. The events table
   shows **step**, **train loss**, **valid loss**, and the message for each real
   training event (most recent 100). **Refresh** re-reads them. A queued job
   honestly reports *"No events yet"*.
5. **Cancel if needed.** Non-terminal jobs offer **Cancel** on their Overview row.
6. **Deploy the fine-tuned model.** On **Safety & deploy**, give the deployment a
   name and click **Deploy model**. Loom creates a real Azure OpenAI deployment
   with a **strict content-filter policy bound**. The deployment is *required* to
   run the safety evaluation and is the endpoint the Model serving item consumes.
7. **Run the safety evaluation.** **Run safety evaluation** probes the deployed
   model with adversarial requests (Loom red-team) and scores every completion
   with **Azure Content Safety** (Foundry RAI). You get three tiles:
   - **Refusal rate**
   - **Attack success** (red when above zero)
   - **Harmful completions** (red when above zero)

   plus a verdict banner with a grade. The model is **approved for serving only
   when it refuses at a high rate (grade A/B) with no harmful completions**;
   otherwise the banner reads *"Not approved for serving"* with the reason.
8. **Route it.** Once approved, the editor names the registered model and its
   deployment and points you at a **Model serving endpoint** item to route and
   monitor it.

## The Azure backend it rides on

- **Fine-tuning (default):** **Azure OpenAI in Azure AI Foundry** — real job
  create / list / cancel and real training events. Gov uses the correct
  `*.openai.azure.us` endpoints.
- **Fine-tuning (alternative backend):** **Databricks Mosaic AI**, when the
  deployment is configured for it.
- **Deployment:** a real **Azure OpenAI deployment** with a strict content-filter
  policy.
- **Safety:** Loom's red-team probes + **Azure AI Content Safety** (Foundry RAI).
- **Routes:** `GET/POST/DELETE /api/items/fine-tuning-job/<id>`, `…/events`,
  `…/deploy`, `…/safety-eval` — every control calls a real BFF route.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| No fine-tuning backend configured | The shared Fix-it gate (`svc-fine-tuning`) with an inline wizard; the surface still renders and the form's inputs are disabled — no red banner on a fresh item | Set the variable the gate names via its **Fix it** wizard |
| Fewer than 10 valid examples | Submit is refused with the reason | Add more valid chat examples |
| Job selected has no resulting model | *"Select a succeeded job with a fine-tuned model to deploy and evaluate it"* | Wait for the job to succeed |
| Safety evaluation fails | Warning banner *"Not approved for serving"* with the reason; the model is **not** approved | Improve the training data or the system prompt and re-tune |
| No job selected | Progress prompts you to select one | Pick a job on **Overview** |

## No Fabric required

Azure OpenAI in Azure AI Foundry + Azure AI Content Safety. No Fabric capacity,
workspace, OneLake path, or Power BI workspace is used on any path.

## Learn more

- Model serving endpoint editor tutorial: `editor-model-serving-endpoint.md`
- AI red team editor tutorial: `editor-ai-red-team.md`
- Content safety editor tutorial: `editor-content-safety.md`
- Parity source: `docs/fiab/parity/fine-tuning-job.md`
- Azure OpenAI fine-tuning:
  <https://learn.microsoft.com/azure/ai-services/openai/how-to/fine-tuning>
