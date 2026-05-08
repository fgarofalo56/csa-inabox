[Home](../../README.md) > [Docs](../) > [Runbooks](./) > **Portal Rollout Strategy**

# Portal Backend Rollout Strategy

> CSA-0060. Choosing between the built-in Helm `Deployment` strategy and Argo Rollouts for the CSA portal backend, and how to override either one safely.

## When to use each option

| Use case | Use this | Notes |
| --- | --- | --- |
| Routine version bumps, low-risk releases | Built-in `Deployment.strategy.rollingUpdate` | Default. Configurable via `backend.strategy` in `values.yaml`. Honors `terminationGracePeriodSeconds` and the readiness probe already wired in `templates/backend.yaml`. |
| Progressive canary, traffic weighting, automated SLO-gated promotion | Argo Rollouts CRD | See [`portal/kubernetes/argo-rollouts.example.yaml`](../../portal/kubernetes/argo-rollouts.example.yaml). Requires the Argo Rollouts controller and (optionally) a traffic router (Istio / NGINX Ingress). |
| Blue-green with an instant cutover | Argo Rollouts (`blueGreen` strategy) | Easier to model in Argo than as raw `Deployment.strategy`. |

## Overriding the built-in `RollingUpdate` strategy

The Helm chart now exposes `backend.strategy` (see the inline comment block at the top of `templates/backend.yaml`). Set it in your environment-specific values override, for example:

```yaml
# values.canary.yaml
backend:
  replicas: 6
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
```

Apply with:

```bash
helm upgrade --install csa-portal portal/kubernetes/helm/csa-portal \
  -f values.yaml \
  -f values.canary.yaml
```

Reference: <https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#strategy>.

## Switching to Argo Rollouts

1. Install the controller (one-time, cluster-wide):

   ```bash
   kubectl create namespace argo-rollouts
   kubectl apply -n argo-rollouts \
     -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
   ```

2. Disable or delete the chart-managed `Deployment` for `csa-portal-backend` so the two controllers do not fight over the object.
3. Apply the example CRD:

   ```bash
   kubectl apply -f portal/kubernetes/argo-rollouts.example.yaml
   ```

4. Promote / abort with the Argo Rollouts CLI:

   ```bash
   kubectl argo rollouts get rollout csa-portal-backend
   kubectl argo rollouts promote csa-portal-backend
   kubectl argo rollouts abort   csa-portal-backend
   ```

Reference: <https://argo-rollouts.readthedocs.io/en/stable/features/canary/>.

## Rollback

| Scenario | Command |
| --- | --- |
| Built-in `Deployment` regression | `kubectl rollout undo deployment/csa-portal-backend` |
| Argo Rollouts canary regression | `kubectl argo rollouts abort csa-portal-backend` (then promote a known-good ReplicaSet) |
| Helm chart-level regression | `helm rollback csa-portal <REVISION>` |

## Related

- [`portal/kubernetes/helm/csa-portal/templates/backend.yaml`](../../portal/kubernetes/helm/csa-portal/templates/backend.yaml) — Helm chart with the new `backend.strategy` override
- [`portal/kubernetes/argo-rollouts.example.yaml`](../../portal/kubernetes/argo-rollouts.example.yaml) — Ready-to-paste Argo Rollouts CRD example
- [DR Drill runbook](dr-drill.md) — Failover testing procedure
