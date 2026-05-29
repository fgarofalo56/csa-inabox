# ai-builder-model — parity with AI Builder models

Source UI: Power Apps maker — AI hub (`make.powerapps.com → AI hub → AI models`).
Learn: <https://learn.microsoft.com/ai-builder/model-types>,
<https://learn.microsoft.com/ai-builder/train-model>,
<https://learn.microsoft.com/ai-builder/prediction-use#real-time-prediction>

## Feature inventory

1. List models (name, template/type, state, status, modified).
2. Model detail.
3. Train the model.
4. Publish the trained model.
5. Predict (real-time prediction by reference).
6. Create a new model (choose model type) — portal-only wizard.

## Loom coverage

| Row | Status | Notes |
| --- | --- | --- |
| List | built ✅ | `msdyn_aimodels` |
| Detail | built ✅ | metadata grid |
| Train | built ✅ | bound action `msdyn_AIModelTrain` |
| Publish | built ✅ | bound action `msdyn_AIConfigurationActivate` |
| Predict | built ✅ | unbound action `Predict` with JSON request editor |
| New model | honest-gate ⚠️ | `id=new` MessageBar + Maker deep-link (model-type wizard is portal-only) |

## Backend per control

- List → `listAiBuilderModels`; Detail → `getAiBuilderModel`
- Train → `POST .../[id]/train` → `trainAiBuilderModel`
- Publish → `POST .../[id]/publish` → `publishAiBuilderModel`
- Predict → `POST .../[id]/predict` → `predictAiBuilderModel` (Dataverse `Predict` action)
