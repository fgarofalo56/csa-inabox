import type { FabricItemType } from './types';

/**
 * Data Science — item-type catalog slice.
 *
 * Split out of lib/catalog/fabric-item-types.ts (barrel-preserving refactor):
 * the item literals are VERBATIM; grouping is by the item's `category` field.
 * Recomposed into FABRIC_ITEM_TYPES (in category-appearance order) by the barrel.
 */
export const dataScienceItems: FabricItemType[] = [
  // Data Science
  { slug: 'ml-model', displayName: 'ML model', restType: 'MLModel', category: 'Data Science',
    description: 'MLflow-backed registered model with versions and PREDICT endpoint.',
    learnContent: {
      "overview": "An ML model is an MLflow-backed registered model with versions and a PREDICT endpoint. In Loom it is wired live to the AI Foundry hub (Microsoft.MachineLearningServices/workspaces) via the BFF. Use it to register and deploy trained models.",
      "steps": [
        {
          "title": "Register a model",
          "body": "Log a model in MLflow format from an experiment run; it appears with its version history."
        },
        {
          "title": "Browse versions",
          "body": "The editor lists model versions sourced live from the Foundry hub."
        },
        {
          "title": "Deploy an endpoint",
          "body": "Promote a version to a managed online or batch endpoint for scoring."
        },
        {
          "title": "Score with PREDICT",
          "body": "Call the PREDICT endpoint from notebooks or pipelines to apply the model."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-mlflow-models"
    } },
  { slug: 'ml-experiment', displayName: 'ML experiment', restType: 'MLExperiment', category: 'Data Science',
    description: 'Track runs, parameters, metrics, and artifacts for a model family.',
    learnContent: {
      "overview": "An ML experiment tracks runs, parameters, metrics, and artifacts for a model family using MLflow. In Loom it is wired live to the AI Foundry hub via the BFF. Use it to compare hyperparameter sweeps and promote the winning run.",
      "steps": [
        {
          "title": "Create an experiment",
          "body": "Group related training runs under one experiment name."
        },
        {
          "title": "Log runs",
          "body": "From a notebook, log params, metrics, and artifacts with MLflow; runs appear in the editor."
        },
        {
          "title": "Compare runs",
          "body": "Sort and compare runs by metric to find the best configuration."
        },
        {
          "title": "Register the winner",
          "body": "Promote the winning run to a registered ML model for deployment."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-mlflow"
    } },
  { slug: 'automl', displayName: 'AutoML', restType: 'AutoMLJob', category: 'Data Science',
    description: 'Low-code Automated ML wizard — pick a task, dataset, and compute; AutoML finds the best model.',
    learnContent: {
      "overview": "AutoML is a low-code wizard for Automated machine learning. In Loom it runs real Azure Machine Learning AutoML jobs (Microsoft.MachineLearningServices/workspaces/<ws>/jobs, jobType:'AutoML') — no Fabric dependency. Pick a task (classification, regression, or forecasting), point at a dataset and target column, choose a compute cluster, and AutoML trains and ranks candidate models, then you monitor the run live.",
      "steps": [
        {
          "title": "Pick a task type",
          "body": "Choose Classification (binary or multi-class), Regression, or Forecasting. AutoML applies the right family of algorithms for the task."
        },
        {
          "title": "Choose dataset + target",
          "body": "Select a datastore and the MLTable folder that holds your tabular data, then name the target (label) column AutoML should learn to predict."
        },
        {
          "title": "Select compute",
          "body": "Pick an AmlCompute cluster from the workspace to run the model sweep on."
        },
        {
          "title": "Set limits and submit",
          "body": "Choose the primary metric and limits (timeout, max trials, concurrency), then submit a real AutoML job and watch it on the Runs tab."
        }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-automated-ml"
    } },
  // WS-1.2 — Model Serving as a first-class item (Databricks / AI-Foundry parity).
  { slug: 'model-serving-endpoint', displayName: 'Model serving endpoint', restType: 'ModelServingEndpoint', category: 'Data Science',
    description: 'Real-time model serving with traffic-split, autoscale, an invoke console, and live latency/error monitoring.',
    learnContent: {
      "overview": "A model-serving endpoint hosts one or more registered model versions behind an HTTPS scoring route with autoscale and blue/green traffic splitting. In Loom the Azure-native DEFAULT is an Azure Machine Learning managed online endpoint (Microsoft.MachineLearningServices/workspaces/onlineEndpoints — works in Azure Government); Databricks Mosaic AI Model Serving is an opt-in alternative (LOOM_MODEL_SERVING_BACKEND=databricks). No Microsoft Fabric dependency. Create an endpoint, split traffic to canary a new version, invoke it from the console, and watch live latency and error tiles from real Azure Monitor metrics.",
      "steps": [
        { "title": "Create an endpoint", "body": "Pick a registered model version, compute size, and scaling (manual instances or autoscale min/max); Loom provisions the endpoint and a 'blue' deployment serving 100% of traffic." },
        { "title": "Split traffic", "body": "Add a second deployment for a new model version and set a blue/green split (e.g. 80/20) to canary it against live traffic — applied via a real backend update." },
        { "title": "Invoke from the console", "body": "Send a real scoring request from the Invoke tab and see the model response plus the measured round-trip latency." },
        { "title": "Monitor", "body": "The Monitoring tab shows live request latency, requests-per-minute, and 5xx errors from Azure Monitor for the endpoint." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/machine-learning/concept-endpoints-online"
    } },
  // WS-2.1 — Feature Store as a first-class item (Databricks Feature Store parity).
  { slug: 'feature-table', displayName: 'Feature table', restType: 'FeatureTable', category: 'Data Science',
    description: 'Author governed feature tables, point-in-time-join them onto a training set, and serve features online at inference.',
    learnContent: {
      "overview": "A feature table is a governed, keyed table of ML features with an event-time column for point-in-time correctness. In Loom the Azure-native DEFAULT is a Unity Catalog feature table (Delta) authored + queried through the Databricks SQL warehouse; the sovereign / Gov path uses OSS Unity Catalog + Azure Database for PostgreSQL. Online serving (feature-lookup-at-inference) is backed by Lakebase / pgvector. No Microsoft Fabric dependency. Define entity keys + a timestamp key + typed features, point-in-time-join onto a spine/label table to build a training set, publish the latest features to the online store, then look up features at inference to enrich a model-serving-endpoint (WS-1.2) scoring call.",
      "steps": [
        { "title": "Define a feature table", "body": "Name the table (catalog.schema.table), the entity (primary) keys, the event-time column, and the typed feature columns; Loom creates the real offline (Delta / PostgreSQL) table and the online serving table." },
        { "title": "Point-in-time join", "body": "Pick a spine/label table and its keys + event-time column; Loom builds an AS-OF join that attaches the latest feature values as of each label's time and runs it against the real backend, returning the training set." },
        { "title": "Publish online", "body": "Materialise the latest features per entity into the Lakebase/pgvector online table for low-latency serving." },
        { "title": "Serve at inference", "body": "Provide entity keys and a serving endpoint; Loom looks up the online features, merges them into the scoring payload, and invokes the endpoint — the feature-lookup-at-serving path." }
      ],
      "docsUrl": "https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/"
    } },
];
