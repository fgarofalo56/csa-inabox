# Example: workspace + lakehouse

A working root module that provisions a Loom **workspace** and a **lakehouse**
item inside it, using the `loom-workspace` and `loom-item` modules.

```bash
export TF_VAR_loom_token="loom_pat_<id>_<secret>"   # a read-write API token

terraform init
terraform plan  -var "loom_api_url=https://<your-loom-host>"
terraform apply -var "loom_api_url=https://<your-loom-host>"

terraform output workspace_id
terraform output lakehouse_id
```

`terraform destroy` removes the item and the workspace (in dependency order).

## What it exercises

- `POST /api/workspaces` → the workspace, then `GET /api/workspaces/{id}` for
  drift detection.
- `POST /api/workspaces/{id}/items` → the lakehouse, then
  `GET /api/cosmos-items/lakehouse/{id}` for reads and `PATCH`/`DELETE` for
  updates + teardown.

All calls carry `Authorization: Bearer $TF_VAR_loom_token`.
