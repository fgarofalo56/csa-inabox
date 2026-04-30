# Secret Migration --- Jenkins Credentials to GitHub Secrets and OIDC

**Audience:** DevOps Engineer, Security Engineer, Platform Engineer
**Reading time:** 10 minutes
**Last updated:** 2026-04-30

---

## Overview

Jenkins credentials store sensitive values on the Jenkins controller's filesystem, encrypted with the controller's master key. If the controller is compromised, every credential is exposed. GitHub Actions provides a fundamentally different model: secrets are encrypted at rest, never exposed in logs, and --- for cloud provider authentication --- can be eliminated entirely using OIDC federation.

This guide covers migrating every Jenkins credential type to GitHub Secrets and OIDC, with specific patterns for Azure authentication in CSA-in-a-Box deployments.

---

## 1. Credential type mapping

| Jenkins credential type           | GitHub Actions equivalent                     | Migration complexity |
| --------------------------------- | --------------------------------------------- | -------------------- |
| **Secret text**                   | Repository/organization/environment secret    | XS                   |
| **Username with password**        | Two separate secrets                          | S                    |
| **SSH username with private key** | Secret + `webfactory/ssh-agent` action        | S                    |
| **Certificate (PFX)**             | Base64-encoded secret                         | S                    |
| **Secret file**                   | Base64-encoded secret                         | S                    |
| **Azure Service Principal**       | OIDC federation (no stored secret)            | M                    |
| **AWS credentials**               | OIDC federation (no stored secret)            | M                    |
| **GCP service account key**       | OIDC federation (no stored secret)            | M                    |
| **Docker registry**               | `docker/login-action` with secret             | S                    |
| **GitHub token**                  | `GITHUB_TOKEN` (automatic)                    | XS                   |
| **Vault AppRole**                 | `hashicorp/vault-action` with OIDC or AppRole | S                    |

---

## 2. GitHub Secrets --- scope and hierarchy

GitHub Secrets are available at three levels, providing credential scoping equivalent to Jenkins' global, folder, and job-level credentials.

### Organization secrets

Available to all repositories in the organization (or selected repositories).

```bash
# Create an organization secret
gh secret set API_KEY --org my-org --body "sk-abc123..."

# Restrict to specific repositories
gh secret set API_KEY --org my-org --repos "repo-a,repo-b" --body "sk-abc123..."
```

**Use for:** Shared credentials (Docker Hub token, Slack webhook, SonarQube token) that multiple repositories need.

### Repository secrets

Available only within a single repository.

```bash
# Create a repository secret
gh secret set DB_PASSWORD --body "P@ssw0rd!"
```

**Use for:** Repository-specific credentials (database passwords, API keys for services used only by this repo).

### Environment secrets

Available only to jobs that reference a specific environment. This is the most secure scope.

```bash
# Create an environment secret
gh secret set AZURE_CLIENT_ID --env production --body "12345678-..."
```

**Use for:** Deployment credentials that should only be accessible to production/staging deployment jobs.

```yaml
jobs:
    deploy:
        environment: production # Required to access environment secrets
        runs-on: ubuntu-latest
        steps:
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }} # Only available because environment: production
```

### Hierarchy comparison

| Jenkins scope                 | GitHub equivalent    | Access control                                                     |
| ----------------------------- | -------------------- | ------------------------------------------------------------------ |
| Global credentials            | Organization secrets | Organization admins set; available to all/selected repos           |
| Folder-scoped credentials     | Repository secrets   | Repository admins set; available to all workflows in repo          |
| Pipeline-specific credentials | Environment secrets  | Environment with protection rules (required reviewers, wait timer) |

---

## 3. OIDC federation --- Eliminate stored secrets for Azure

OIDC (OpenID Connect) federation is the single most impactful security improvement when migrating from Jenkins. Instead of storing Azure service principal passwords as Jenkins credentials (which must be rotated, can be leaked, and persist indefinitely), GitHub Actions requests short-lived tokens from Azure using the workflow's identity.

### How OIDC works

```
1. GitHub Actions workflow requests an OIDC token from GitHub's token endpoint
2. The token contains claims: repository, ref, environment, workflow, actor
3. The workflow presents this token to Azure's token endpoint
4. Azure validates the token against the federated credential configuration
5. Azure issues a short-lived access token (1 hour) for the service principal
6. The workflow uses this token to deploy resources
```

No client secret is ever stored. No credential rotation is needed. The token is valid only for the specific workflow run.

### Setting up OIDC for Azure

**Step 1: Create an Entra ID app registration**

```bash
# Create the app registration
az ad app create --display-name "github-actions-csa-inabox"

# Note the Application (client) ID
APP_ID=$(az ad app list --display-name "github-actions-csa-inabox" --query "[0].appId" -o tsv)

# Create a service principal
az ad sp create --id $APP_ID

# Assign roles (Contributor on subscription for Bicep deployments)
az role assignment create \
  --assignee $APP_ID \
  --role Contributor \
  --scope /subscriptions/YOUR_SUBSCRIPTION_ID
```

**Step 2: Add federated credentials**

```bash
# Federated credential for main branch pushes
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-actions-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:my-org/csa-inabox:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# Federated credential for pull requests
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-actions-pr",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:my-org/csa-inabox:pull_request",
  "audiences": ["api://AzureADTokenExchange"]
}'

# Federated credential for specific environment
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-actions-production",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:my-org/csa-inabox:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

**Step 3: Configure GitHub Secrets (no client secret needed)**

```bash
gh secret set AZURE_CLIENT_ID --body "$APP_ID"
gh secret set AZURE_TENANT_ID --body "YOUR_TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --body "YOUR_SUBSCRIPTION_ID"
```

**Step 4: Use in workflow**

```yaml
permissions:
    id-token: write # Required for OIDC
    contents: read

jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
                  # No client-secret parameter --- OIDC handles authentication
            - run: az deployment group create ...
```

### OIDC subject claims

The `subject` claim in the federated credential controls which workflows can authenticate. Use specific claims for least-privilege.

| Subject claim                          | Scope                            |
| -------------------------------------- | -------------------------------- |
| `repo:org/repo:ref:refs/heads/main`    | Only main branch pushes          |
| `repo:org/repo:ref:refs/tags/v*`       | Only version tags                |
| `repo:org/repo:pull_request`           | Only pull requests               |
| `repo:org/repo:environment:production` | Only production environment jobs |
| `repo:org/repo:ref:refs/heads/*`       | Any branch push                  |

**Recommendation:** Use environment-scoped claims for production deployments and branch-scoped claims for CI builds.

---

## 4. Migrating specific credential types

### Secret text

```groovy
// Jenkins
environment {
    API_KEY = credentials('my-api-key')
}
steps {
    sh 'curl -H "Authorization: Bearer $API_KEY" https://api.example.com'
}
```

```yaml
# GitHub Actions
steps:
  - run: curl -H "Authorization: Bearer $API_KEY" https://api.example.com
    env:
      API_KEY: ${{ secrets.MY_API_KEY }}
```

### Username with password

```groovy
// Jenkins
withCredentials([usernamePassword(credentialsId: 'db-creds',
                                   usernameVariable: 'DB_USER',
                                   passwordVariable: 'DB_PASS')]) {
    sh 'psql -U $DB_USER -W $DB_PASS ...'
}
```

```yaml
# GitHub Actions
- run: psql -U "$DB_USER" ...
  env:
      DB_USER: ${{ secrets.DB_USER }}
      PGPASSWORD: ${{ secrets.DB_PASSWORD }}
```

### SSH private key

```groovy
// Jenkins
withCredentials([sshUserPrivateKey(credentialsId: 'deploy-key',
                                    keyFileVariable: 'SSH_KEY')]) {
    sh 'ssh -i $SSH_KEY user@server deploy.sh'
}
```

```yaml
# GitHub Actions
- uses: webfactory/ssh-agent@v0.9
  with:
      ssh-private-key: ${{ secrets.DEPLOY_SSH_KEY }}
- run: ssh user@server deploy.sh
```

### Certificate (PFX)

```groovy
// Jenkins
withCredentials([certificate(credentialsId: 'my-cert',
                              keystoreVariable: 'CERT_FILE',
                              passwordVariable: 'CERT_PASS')]) {
    sh 'deploy --cert $CERT_FILE --pass $CERT_PASS'
}
```

```yaml
# GitHub Actions
- name: Decode certificate
  run: |
      echo "${{ secrets.CERT_PFX_BASE64 }}" | base64 -d > cert.pfx
- run: deploy --cert cert.pfx --pass "${{ secrets.CERT_PASSWORD }}"
- name: Cleanup
  if: always()
  run: rm -f cert.pfx
```

### Docker registry

```groovy
// Jenkins
withDockerRegistry([credentialsId: 'docker-hub', url: '']) {
    sh 'docker push myimage:latest'
}
```

```yaml
# GitHub Actions
- uses: docker/login-action@v3
  with:
      username: ${{ secrets.DOCKER_USERNAME }}
      password: ${{ secrets.DOCKER_PASSWORD }}
- run: docker push myimage:latest
```

For GitHub Container Registry (GHCR), use the automatic `GITHUB_TOKEN`:

```yaml
- uses: docker/login-action@v3
  with:
      registry: ghcr.io
      username: ${{ github.actor }}
      password: ${{ secrets.GITHUB_TOKEN }}
```

---

## 5. HashiCorp Vault integration

If your Jenkins instance uses HashiCorp Vault for secret management, GitHub Actions can integrate with Vault directly.

### Vault with OIDC (preferred)

```yaml
- uses: hashicorp/vault-action@v3
  with:
      url: https://vault.example.com
      method: jwt
      role: github-actions
      jwtGithubAudience: https://vault.example.com
      secrets: |
          secret/data/myapp/config api_key | API_KEY ;
          secret/data/myapp/config db_password | DB_PASSWORD
- run: echo "Using API_KEY and DB_PASSWORD from Vault"
```

### Vault with AppRole

```yaml
- uses: hashicorp/vault-action@v3
  with:
      url: https://vault.example.com
      method: approle
      roleId: ${{ secrets.VAULT_ROLE_ID }}
      secretId: ${{ secrets.VAULT_SECRET_ID }}
      secrets: |
          secret/data/myapp/config api_key | API_KEY
```

---

## 6. Azure Key Vault integration

For CSA-in-a-Box deployments, Azure Key Vault is the recommended secret store for application secrets (distinct from CI/CD credentials).

```yaml
- uses: azure/login@v2
  with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

- uses: azure/get-keyvault-secrets@v1
  with:
      keyvault: kv-csa-prod
      secrets: "db-connection-string, storage-account-key"
  id: kv-secrets

- run: echo "DB connection available"
  env:
      DB_CONN: ${{ steps.kv-secrets.outputs.db-connection-string }}
```

---

## 7. Migration checklist

- [ ] Export Jenkins credentials inventory (Manage Jenkins > Credentials)
- [ ] Classify each credential by type (secret text, username/password, SSH, certificate, service principal)
- [ ] For Azure service principals: set up OIDC federation (eliminates stored secrets)
- [ ] For AWS credentials: set up AWS OIDC federation
- [ ] For Docker registries: migrate to `docker/login-action`
- [ ] For SSH keys: migrate to `webfactory/ssh-agent`
- [ ] For Vault: configure `hashicorp/vault-action` with OIDC
- [ ] Create GitHub Secrets at appropriate scope (org, repo, environment)
- [ ] Update workflow YAML to reference new secrets
- [ ] Verify secrets are masked in workflow logs
- [ ] Rotate all credentials that were stored in Jenkins (they may have been exposed)
- [ ] Document the new credential management process for your team
- [ ] Decommission Jenkins credentials after migration validation

---

## 8. Security improvements after migration

| Dimension                  | Jenkins credentials                                      | GitHub Secrets + OIDC                            |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Storage encryption         | AES-128 on controller filesystem                         | AES-256 in GitHub infrastructure                 |
| Log masking                | Plugin-dependent                                         | Automatic for all secrets                        |
| Credential rotation        | Manual (often neglected)                                 | OIDC: no rotation needed; tokens are ephemeral   |
| Blast radius of compromise | All credentials on controller exposed                    | Per-repo or per-environment scope                |
| Audit trail                | Jenkins audit log (if enabled)                           | GitHub audit log (always enabled)                |
| Least privilege            | Difficult (credentials available to all pipeline stages) | Environment-scoped secrets + OIDC subject claims |

---

## Next steps

1. **Start with OIDC** --- Set up Azure OIDC federation first; this has the highest security impact.
2. **Migrate remaining credentials** --- Use the type mapping above to migrate each credential.
3. **Update pipelines** --- Follow the [Pipeline Migration Guide](pipeline-migration.md) to update credential references in workflow YAML.
4. **Rotate everything** --- After migration, rotate all credentials that were stored in Jenkins.
