# Tutorial: AutoML editor

> CSA Loom `automl` editor — a low-code **Automated ML** wizard that submits
> real **Azure Machine Learning** AutoML jobs and monitors them live. **No
> Microsoft Fabric required.**

## What it is

AutoML is a low-code wizard for Automated machine learning. In Loom it runs
real Azure Machine Learning AutoML jobs
(`Microsoft.MachineLearningServices/workspaces/<ws>/jobs`, `jobType: 'AutoML'`).
Pick a task, point at a dataset and target column, choose compute, and AutoML
trains and ranks candidate models while you watch the run.

## When to use it

- You want a trained model without hand-writing training code — AutoML sweeps
  algorithms and hyperparameters for you.
- You have tabular data and a clear label column to predict.
- You need a governed, reproducible AML job (visible in the AML workspace) —
  not a black box.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → AutoML** (Data Science). The
   editor opens at `/items/automl/<id>`.
2. **Pick a task type.** Choose **Classification** (binary or multi-class),
   **Regression**, or **Forecasting** — AutoML applies the right family of
   algorithms for the task.
3. **Choose dataset + target.** Select a datastore and the MLTable folder that
   holds your tabular data, then name the target (label) column AutoML should
   learn to predict.
4. **Select compute.** Pick an AmlCompute cluster from the workspace to run the
   model sweep on.
5. **Set limits and submit.** Choose the primary metric and limits (timeout,
   max trials, concurrency), then submit — a real AutoML job — and watch it on
   the **Runs** tab.

## The Azure backend it rides on

- **Jobs:** Azure Machine Learning workspace jobs REST
  (`jobType: 'AutoML'`) via the Console managed identity.
- **Compute:** an AmlCompute cluster in the bound AML workspace.
- **Gate:** a missing AML workspace surfaces the exact `LOOM_AML_*` env vars to
  set — the surface never fakes a run.

## No Fabric required

AutoML jobs run entirely on Azure Machine Learning; no Fabric capacity,
workspace, or OneLake is involved.

## Learn more

- Automated ML concepts:
  <https://learn.microsoft.com/azure/machine-learning/concept-automated-ml>
