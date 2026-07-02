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
];
