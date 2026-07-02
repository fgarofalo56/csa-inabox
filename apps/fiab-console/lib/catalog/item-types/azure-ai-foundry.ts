import type { FabricItemType } from './types';

/**
 * Azure AI Foundry — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const azureAiFoundryItems: FabricItemType[] = [
  // --- Azure AI Foundry hub (Microsoft.MachineLearningServices/workspaces kind=Hub) ---
  { slug: 'ai-foundry-hub',              displayName: 'AI Foundry hub',              restType: 'AiFoundryHub',              category: 'Azure AI Foundry',
    description: 'Azure AI Foundry hub workspace — connections, models, online endpoints, computes, datastores, and jobs. Native in Loom.',
    learnContent: {
      "overview": "An AI Foundry hub is an Azure AI Foundry hub workspace (Microsoft.MachineLearningServices/workspaces kind=Hub) — connections, models, online endpoints, computes, datastores, and jobs. In Loom it is the shared parent for projects, prompt flows, and evaluations.",
      "steps": [
        {
          "title": "Connect models",
          "body": "Add connections to Azure OpenAI, the Foundry catalog, or your own endpoints."
        },
        {
          "title": "Create a project",
          "body": "Spin up an AI Foundry project under the hub that inherits its connections and datastores."
        },
        {
          "title": "Build a prompt flow",
          "body": "Chain retrieval, LLM, and post-processing nodes in a prompt flow."
        },
        {
          "title": "Evaluate before deploy",
          "body": "Run evaluations on a curated test set before promoting a deployment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/concepts/architecture"
    } },
  // v2.5 — Azure AI Foundry sub-editors (project + project-scoped surfaces)
  { slug: 'ai-foundry-project',          displayName: 'AI Foundry project',          restType: 'AiFoundryProject',          category: 'Azure AI Foundry',
    description: 'Child workspace under the Foundry hub. Inherits connections/models/datastores; scopes prompt flows, evaluations, and data assets.',
    learnContent: {
      "overview": "An AI Foundry project is a child workspace under the Foundry hub. It inherits connections, models, and datastores and scopes prompt flows, evaluations, and data assets. In Loom it is wired to its BFF route and discloses 503/notDeployed honestly.",
      "steps": [
        {
          "title": "Create under the hub",
          "body": "The project inherits the hub's connections, models, and datastores."
        },
        {
          "title": "Scope assets",
          "body": "Author project-scoped prompt flows, evaluations, and data assets."
        },
        {
          "title": "Run experiments",
          "body": "Iterate on flows and evaluations within the project boundary."
        },
        {
          "title": "Mind provisioning",
          "body": "If the Foundry runtime isn't provisioned the BFF returns 503/notDeployed and the editor surfaces the hint."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/concepts/architecture"
    } },
  { slug: 'prompt-flow',                 displayName: 'Prompt flow',                 restType: 'PromptFlow',                category: 'Azure AI Foundry',
    description: 'LangChain-style flow graph of LLM + tool nodes. Author the YAML/JSON definition, run with inputs, view run history.',
    learnContent: {
      "overview": "A Prompt flow is a LangChain-style graph of LLM and tool nodes. In Loom you author the YAML/JSON definition, run it with inputs, and view run history via the Foundry BFF route.",
      "steps": [
        {
          "title": "Author the flow",
          "body": "Define the node graph (retrieval, LLM, post-processing) in YAML/JSON."
        },
        {
          "title": "Run with inputs",
          "body": "Provide sample inputs and run to see node outputs end-to-end."
        },
        {
          "title": "View run history",
          "body": "Inspect prior runs for reproducibility and debugging."
        },
        {
          "title": "Evaluate",
          "body": "Pair with a Foundry evaluation to score the flow before promoting it."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/how-to/prompt-flow"
    } },
  { slug: 'evaluation',                  displayName: 'Foundry evaluation',          restType: 'FoundryEvaluation',         category: 'Azure AI Foundry',
    description: 'Run quality / safety / accuracy evaluators against a dataset + model deployment. Surfaces metric tables and pass/fail signals.',
    learnContent: {
      "overview": "A Foundry evaluation runs quality/safety/accuracy evaluators against a dataset plus a model deployment, surfacing metric tables and pass/fail signals. In Loom it is wired to the Foundry BFF route.",
      "steps": [
        {
          "title": "Pick a dataset",
          "body": "Select the test dataset to evaluate against."
        },
        {
          "title": "Choose evaluators",
          "body": "Add built-in evaluators (groundedness, relevance, fluency) plus any custom ones."
        },
        {
          "title": "Run the evaluation",
          "body": "Run against the model deployment to produce metric tables."
        },
        {
          "title": "Read pass/fail",
          "body": "Review pass/fail signals to decide whether to promote the deployment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/how-to/evaluate-generative-ai-app"
    } },
  { slug: 'content-safety',              displayName: 'Content Safety',              restType: 'ContentSafety',             category: 'Azure AI Foundry',
    description: 'Azure AI Content Safety: text + image moderation across hate/violence/sexual/self-harm with severity thresholds.',
    learnContent: {
      "overview": "Content Safety is Azure AI Content Safety — text and image moderation across hate/violence/sexual/self-harm with severity thresholds. In Loom you configure thresholds and wire it in front of any LLM call.",
      "steps": [
        {
          "title": "Set categories",
          "body": "Enable the harm categories you want screened (hate, violence, sexual, self-harm)."
        },
        {
          "title": "Tune severity thresholds",
          "body": "Set the severity threshold per category that should block content."
        },
        {
          "title": "Test content",
          "body": "Run sample text or images through to see the severity scores."
        },
        {
          "title": "Wire in front of the LLM",
          "body": "Place Content Safety ahead of prompt flow or agent calls to filter inputs and outputs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-services/content-safety/overview"
    } },
  { slug: 'tracing',                     displayName: 'Foundry tracing',             restType: 'FoundryTracing',            category: 'Azure AI Foundry',
    description: 'Operation traces (App Insights) for prompt flow runs, evaluator runs, and endpoint calls. Filter by operation + window.',
    learnContent: {
      "overview": "Foundry tracing surfaces operation traces (Application Insights) for prompt flow runs, evaluator runs, and endpoint calls. In Loom you filter by operation and time window to drill from a failed run into the actual span.",
      "steps": [
        {
          "title": "Pick an operation",
          "body": "Filter traces by operation type (flow run, evaluator, endpoint call)."
        },
        {
          "title": "Set a window",
          "body": "Choose the time window to scope the trace list."
        },
        {
          "title": "Open a span",
          "body": "Drill into a span to see latency, tokens, and errors for the call."
        },
        {
          "title": "Diagnose failures",
          "body": "Use traces to find the failing node or call behind a bad run."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/ai-studio/concepts/trace"
    } },
  { slug: 'ai-search-index',             displayName: 'AI Search index',             restType: 'AiSearchIndex',             category: 'Azure AI Foundry',
    description: 'Azure AI Search index — fields, scoring profiles, vector + hybrid query. Backs RAG grounding for Foundry agents.',
    learnContent: {
      "overview": "An AI Search index is an Azure AI Search index — fields, scoring profiles, vector and hybrid query — that backs RAG grounding for Foundry agents. In Loom it is wired to the Foundry BFF route.",
      "steps": [
        {
          "title": "Define the schema",
          "body": "Set content, vector, and metadata fields for the index."
        },
        {
          "title": "Run an indexer",
          "body": "Index data from Blob, ADLS, Cosmos, or SQL into the search index."
        },
        {
          "title": "Query hybrid",
          "body": "Run vector + BM25 + semantic-ranker hybrid queries."
        },
        {
          "title": "Ground an agent",
          "body": "Point a prompt flow or data agent at the index for RAG grounding."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/search/search-what-is-azure-search"
    } },
  { slug: 'compute',                     displayName: 'Foundry compute',             restType: 'FoundryCompute',            category: 'Azure AI Foundry',
    description: 'AML compute instances + clusters. Create, start, stop, scale, delete. Used by prompt flows, evaluations, training jobs.',
    learnContent: {
      "overview": "Foundry compute manages AML compute instances and clusters — create, start, stop, scale, delete. In Loom it is used by prompt flows, evaluations, and training jobs; auto-shutdown reduces idle cost.",
      "steps": [
        {
          "title": "Create compute",
          "body": "Provision a compute instance or cluster by VM size and node count."
        },
        {
          "title": "Set auto-shutdown",
          "body": "Configure auto-shutdown so idle compute stops billing."
        },
        {
          "title": "Start and scale",
          "body": "Start, stop, or scale the compute as workloads demand."
        },
        {
          "title": "Attach to workloads",
          "body": "Use the compute for prompt flows, evaluations, and training jobs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-compute-target"
    } },
  { slug: 'dataset',                     displayName: 'Foundry dataset',             restType: 'FoundryDataset',            category: 'Azure AI Foundry',
    description: 'AML data asset — URI file, URI folder, or MLTable. Versioned, used by prompt flows + evaluations + training runs.',
    learnContent: {
      "overview": "A Foundry dataset is an AML data asset — URI file, URI folder, or MLTable — versioned and used by prompt flows, evaluations, and training runs. In Loom it is wired to the Foundry BFF route.",
      "steps": [
        {
          "title": "Register a data asset",
          "body": "Create a URI file, URI folder, or MLTable pointing at your data."
        },
        {
          "title": "Version it",
          "body": "Each registration is versioned and lineage-tracked."
        },
        {
          "title": "Use in flows",
          "body": "Reference the dataset as input to prompt flows and evaluations."
        },
        {
          "title": "Feed training",
          "body": "Use it as the training input for ML jobs."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-data"
    } },
];
