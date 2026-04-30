# Tutorial --- Pipeline Conversion (Jenkinsfile to GitHub Actions)

**Audience:** DevOps Engineer, Developer
**Reading time:** 15 minutes (hands-on: 1--2 hours)
**Last updated:** 2026-04-30

---

## Overview

This tutorial walks through converting a real-world multi-stage Jenkinsfile to a GitHub Actions workflow. The sample pipeline builds a Docker image, runs tests, scans for vulnerabilities, and deploys to Azure using Bicep --- a pattern common in CSA-in-a-Box deployments. By the end, you will have a production-ready GitHub Actions workflow with OIDC authentication, matrix testing, caching, and Copilot-assisted refinements.

---

## The source Jenkinsfile

Here is the complete Jenkins pipeline we will convert:

```groovy
@Library('shared-pipeline-lib') _

pipeline {
    agent any

    parameters {
        choice(name: 'ENVIRONMENT', choices: ['dev', 'staging', 'prod'],
               description: 'Target deployment environment')
        booleanParam(name: 'SKIP_TESTS', defaultValue: false,
                     description: 'Skip test stage')
        booleanParam(name: 'DRY_RUN', defaultValue: true,
                     description: 'Run Bicep what-if only')
    }

    environment {
        AZURE_CREDS      = credentials('azure-service-principal')
        DOCKER_REGISTRY  = 'myacr.azurecr.io'
        IMAGE_NAME       = 'csa-data-api'
        IMAGE_TAG        = "${env.BUILD_NUMBER}-${env.GIT_COMMIT.take(7)}"
        SONAR_TOKEN      = credentials('sonarqube-token')
    }

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
        ansiColor('xterm')
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build Docker Image') {
            steps {
                sh """
                    docker build \
                        -t ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} \
                        -t ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest \
                        --build-arg BUILD_NUMBER=${env.BUILD_NUMBER} \
                        .
                """
            }
        }

        stage('Test') {
            when { not { expression { params.SKIP_TESTS } } }
            parallel {
                stage('Unit Tests') {
                    steps {
                        sh 'docker run --rm ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} npm test -- --coverage'
                        sh 'docker cp $(docker create ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}):/app/coverage ./coverage'
                    }
                    post {
                        always {
                            junit 'coverage/junit.xml'
                            publishHTML(target: [
                                reportDir: 'coverage/lcov-report',
                                reportFiles: 'index.html',
                                reportName: 'Coverage Report'
                            ])
                        }
                    }
                }
                stage('Lint') {
                    steps {
                        sh 'docker run --rm ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} npm run lint'
                    }
                }
                stage('Security Scan') {
                    steps {
                        sh """
                            docker run --rm \
                                -e SONAR_TOKEN=${SONAR_TOKEN} \
                                sonarsource/sonar-scanner-cli \
                                -Dsonar.projectKey=csa-data-api \
                                -Dsonar.host.url=https://sonar.example.com
                        """
                    }
                }
            }
        }

        stage('Push Image') {
            when { branch 'main' }
            steps {
                withCredentials([usernamePassword(credentialsId: 'acr-creds',
                    usernameVariable: 'ACR_USER', passwordVariable: 'ACR_PASS')]) {
                    sh """
                        docker login ${DOCKER_REGISTRY} -u ${ACR_USER} -p ${ACR_PASS}
                        docker push ${DOCKER_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}
                        docker push ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest
                    """
                }
            }
        }

        stage('Bicep What-If') {
            when { branch 'main' }
            steps {
                withCredentials([azureServicePrincipal('azure-service-principal')]) {
                    sh """
                        az login --service-principal \
                            -u ${AZURE_CLIENT_ID} \
                            -p ${AZURE_CLIENT_SECRET} \
                            --tenant ${AZURE_TENANT_ID}
                        az deployment group what-if \
                            --resource-group rg-csa-${params.ENVIRONMENT} \
                            --template-file infra/main.bicep \
                            --parameters imageTag=${IMAGE_TAG} environment=${params.ENVIRONMENT}
                    """
                }
            }
        }

        stage('Bicep Deploy') {
            when {
                allOf {
                    branch 'main'
                    expression { !params.DRY_RUN }
                }
            }
            input {
                message 'Deploy to ${ENVIRONMENT}?'
                ok 'Deploy'
            }
            steps {
                withCredentials([azureServicePrincipal('azure-service-principal')]) {
                    sh """
                        az login --service-principal \
                            -u ${AZURE_CLIENT_ID} \
                            -p ${AZURE_CLIENT_SECRET} \
                            --tenant ${AZURE_TENANT_ID}
                        az deployment group create \
                            --resource-group rg-csa-${params.ENVIRONMENT} \
                            --template-file infra/main.bicep \
                            --parameters imageTag=${IMAGE_TAG} environment=${params.ENVIRONMENT}
                    """
                }
            }
        }

        stage('dbt Test') {
            when {
                allOf {
                    branch 'main'
                    expression { !params.DRY_RUN }
                }
            }
            steps {
                sh """
                    pip install dbt-databricks
                    dbt deps --profiles-dir profiles/
                    dbt test --profiles-dir profiles/ --target ${params.ENVIRONMENT}
                """
            }
        }
    }

    post {
        always {
            archiveArtifacts artifacts: 'coverage/**', allowEmptyArchive: true
        }
        success {
            slackSend channel: '#deployments', color: 'good',
                message: "SUCCESS: ${env.JOB_NAME} #${env.BUILD_NUMBER} (${params.ENVIRONMENT})"
        }
        failure {
            slackSend channel: '#alerts', color: 'danger',
                message: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER} - ${env.BUILD_URL}"
        }
        cleanup {
            cleanWs()
        }
    }
}
```

This is a realistic enterprise Jenkins pipeline with:

- Shared library reference
- Parameters (choice, boolean)
- Docker build and push
- Parallel test stages (unit, lint, security)
- Azure authentication via service principal
- Bicep what-if and deploy
- dbt testing
- Manual approval gate
- Post-build notifications

---

## Step 1: Analyze the pipeline

Before converting, identify each Jenkins construct and its GitHub Actions equivalent:

| Jenkins construct                       | GitHub Actions mapping                           | Notes                                 |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `@Library('shared-pipeline-lib')`       | Reusable workflow (if lib is used)               | Not used in this pipeline, so remove  |
| `parameters { choice(...) }`            | `workflow_dispatch: inputs:`                     | Preserves parameterization            |
| `environment { credentials(...) }`      | `secrets` + OIDC                                 | OIDC eliminates stored SP credentials |
| `options { timeout(...) }`              | `timeout-minutes:`                               | Per-job timeout                       |
| `options { disableConcurrentBuilds() }` | `concurrency:`                                   | Workflow-level concurrency            |
| `parallel { }`                          | Matrix strategy                                  | Three test types as matrix values     |
| `when { branch 'main' }`                | `if: github.ref == 'refs/heads/main'`            | Conditional job execution             |
| `input { message '...' }`               | Environment with required reviewers              | Approval gate                         |
| `post { always/success/failure }`       | `if: always()`, `if: success()`, `if: failure()` | Step conditions                       |
| `archiveArtifacts`                      | `actions/upload-artifact`                        | Artifact storage                      |
| `junit`                                 | `mikepenz/action-junit-report`                   | Test result display                   |
| `slackSend`                             | `slackapi/slack-github-action`                   | Notifications                         |

---

## Step 2: Create the GitHub Actions workflow

Create `.github/workflows/csa-data-api.yml`:

```yaml
name: CSA Data API - Build, Test, Deploy

on:
    push:
        branches: [main]
        paths:
            - "src/**"
            - "infra/**"
            - "Dockerfile"
            - ".github/workflows/csa-data-api.yml"
    pull_request:
        branches: [main]
    workflow_dispatch:
        inputs:
            environment:
                description: Target deployment environment
                required: true
                default: dev
                type: choice
                options:
                    - dev
                    - staging
                    - prod
            skip-tests:
                description: Skip test stage
                required: false
                default: false
                type: boolean
            dry-run:
                description: Run Bicep what-if only (no deploy)
                required: false
                default: true
                type: boolean

concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}

permissions:
    id-token: write
    contents: read
    checks: write
    pull-requests: write

env:
    DOCKER_REGISTRY: myacr.azurecr.io
    IMAGE_NAME: csa-data-api

jobs:
    # ===========================================================
    # Build Docker image
    # ===========================================================
    build:
        runs-on: ubuntu-latest
        timeout-minutes: 15
        outputs:
            image-tag: ${{ steps.meta.outputs.image-tag }}
        steps:
            - uses: actions/checkout@v4

            - name: Set image tag
              id: meta
              run: echo "image-tag=${{ github.run_number }}-${GITHUB_SHA::7}" >> $GITHUB_OUTPUT

            - uses: docker/setup-buildx-action@v3

            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

            - name: Login to ACR
              run: az acr login --name myacr

            - uses: docker/build-push-action@v6
              with:
                  context: .
                  push: ${{ github.ref == 'refs/heads/main' }}
                  tags: |
                      ${{ env.DOCKER_REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.image-tag }}
                      ${{ env.DOCKER_REGISTRY }}/${{ env.IMAGE_NAME }}:latest
                  build-args: |
                      BUILD_NUMBER=${{ github.run_number }}
                  cache-from: type=gha
                  cache-to: type=gha,mode=max

    # ===========================================================
    # Test (parallel via matrix)
    # ===========================================================
    test:
        if: inputs.skip-tests != true
        runs-on: ubuntu-latest
        needs: build
        timeout-minutes: 20
        strategy:
            fail-fast: false
            matrix:
                suite: [unit, lint, security]
        steps:
            - uses: actions/checkout@v4

            - name: Build test image
              run: |
                  docker build -t ${{ env.IMAGE_NAME }}:test .

            - name: Run unit tests
              if: matrix.suite == 'unit'
              run: |
                  docker run --rm -v $PWD/coverage:/app/coverage \
                    ${{ env.IMAGE_NAME }}:test npm test -- --coverage

            - name: Run lint
              if: matrix.suite == 'lint'
              run: |
                  docker run --rm ${{ env.IMAGE_NAME }}:test npm run lint

            - name: Run security scan
              if: matrix.suite == 'security'
              uses: github/codeql-action/analyze@v3
              with:
                  languages: javascript

            # Upload test results (unit tests only)
            - uses: mikepenz/action-junit-report@v4
              if: matrix.suite == 'unit' && always()
              with:
                  report_paths: coverage/junit.xml
                  fail_on_failure: true

            - uses: actions/upload-artifact@v4
              if: matrix.suite == 'unit' && always()
              with:
                  name: coverage-report
                  path: coverage/
                  retention-days: 14

    # ===========================================================
    # Bicep What-If (preview infrastructure changes)
    # ===========================================================
    bicep-what-if:
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        needs: [build, test]
        timeout-minutes: 10
        env:
            ENVIRONMENT: ${{ inputs.environment || 'dev' }}
        steps:
            - uses: actions/checkout@v4

            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

            - name: Bicep What-If
              run: |
                  az deployment group what-if \
                    --resource-group rg-csa-${{ env.ENVIRONMENT }} \
                    --template-file infra/main.bicep \
                    --parameters \
                      imageTag=${{ needs.build.outputs.image-tag }} \
                      environment=${{ env.ENVIRONMENT }}

    # ===========================================================
    # Bicep Deploy (requires approval for staging/prod)
    # ===========================================================
    bicep-deploy:
        if: github.ref == 'refs/heads/main' && inputs.dry-run != true
        runs-on: ubuntu-latest
        needs: bicep-what-if
        timeout-minutes: 15
        environment: ${{ inputs.environment || 'dev' }}
        steps:
            - uses: actions/checkout@v4

            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

            - name: Bicep Deploy
              run: |
                  az deployment group create \
                    --resource-group rg-csa-${{ inputs.environment || 'dev' }} \
                    --template-file infra/main.bicep \
                    --parameters \
                      imageTag=${{ needs.build.outputs.image-tag }} \
                      environment=${{ inputs.environment || 'dev' }}

    # ===========================================================
    # dbt Test (validate data models after deployment)
    # ===========================================================
    dbt-test:
        if: github.ref == 'refs/heads/main' && inputs.dry-run != true
        runs-on: ubuntu-latest
        needs: bicep-deploy
        timeout-minutes: 15
        steps:
            - uses: actions/checkout@v4

            - uses: actions/setup-python@v5
              with:
                  python-version: "3.11"
                  cache: pip

            - name: Install dbt
              run: pip install dbt-databricks

            - name: Run dbt tests
              run: |
                  dbt deps --profiles-dir profiles/
                  dbt test --profiles-dir profiles/ --target ${{ inputs.environment || 'dev' }}
              env:
                  DBT_PROFILES_DIR: profiles/

    # ===========================================================
    # Notifications
    # ===========================================================
    notify-success:
        if: success() && github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        needs: [build, test, bicep-deploy, dbt-test]
        steps:
            - uses: slackapi/slack-github-action@v1
              with:
                  channel-id: C0123456789
                  slack-message: |
                      :white_check_mark: SUCCESS: ${{ github.repository }} #${{ github.run_number }}
                      Environment: ${{ inputs.environment || 'dev' }}
                      Commit: ${{ github.sha }}
                      URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
              env:
                  SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}

    notify-failure:
        if: failure()
        runs-on: ubuntu-latest
        needs: [build, test, bicep-what-if, bicep-deploy, dbt-test]
        steps:
            - uses: slackapi/slack-github-action@v1
              with:
                  channel-id: C9876543210
                  slack-message: |
                      :x: FAILED: ${{ github.repository }} #${{ github.run_number }}
                      URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
              env:
                  SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

---

## Step 3: Set up OIDC authentication

Follow the [Secret Migration Guide](secret-migration.md) to configure OIDC federation for Azure. For this pipeline, you need:

```bash
# Create federated credentials
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "csa-data-api-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:my-org/csa-inabox:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "csa-data-api-pr",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:my-org/csa-inabox:pull_request",
  "audiences": ["api://AzureADTokenExchange"]
}'

# Store non-secret identifiers in GitHub Secrets
gh secret set AZURE_CLIENT_ID --body "12345678-..."
gh secret set AZURE_TENANT_ID --body "abcdefgh-..."
gh secret set AZURE_SUBSCRIPTION_ID --body "ijklmnop-..."
gh secret set SLACK_BOT_TOKEN --body "xoxb-..."
```

---

## Step 4: Configure environment protection

Set up environments in your repository settings:

1. Go to **Settings > Environments > New environment**
2. Create environments: `dev`, `staging`, `prod`
3. For `staging` and `prod`:
    - Add **required reviewers** (replaces Jenkins `input` step)
    - Add **wait timer** (optional --- e.g., 5 minutes for staging, 30 minutes for prod)
    - Restrict deployment branches to `main`

---

## Step 5: Use Copilot to refine the workflow

With GitHub Copilot Chat, you can ask for improvements:

**Ask Copilot:** "Review this GitHub Actions workflow for security best practices and suggest improvements."

Copilot might suggest:

1. **Pin action versions to SHA** for supply-chain security
2. **Add `permissions:` block** with minimum required permissions
3. **Add Dependabot** for action version updates
4. **Add path filtering** to skip CI on docs-only changes
5. **Add concurrency cancellation** for in-progress runs on the same branch

---

## Step 6: Test the migrated workflow

### Test on a feature branch

```bash
# Create a feature branch
git checkout -b test/actions-migration

# Add the workflow file
mkdir -p .github/workflows
cp csa-data-api.yml .github/workflows/

# Push and observe
git add .github/workflows/csa-data-api.yml
git commit -m "feat: migrate Jenkins pipeline to GitHub Actions"
git push -u origin test/actions-migration
```

### Open a pull request

Create a PR from `test/actions-migration` to `main`. The workflow will trigger on `pull_request` and run the build and test jobs. Review the workflow run in the **Actions** tab.

### Test workflow_dispatch

After merging to main, test the manual trigger:

1. Go to **Actions > CSA Data API - Build, Test, Deploy**
2. Click **Run workflow**
3. Select environment, dry-run, and skip-tests options
4. Click **Run workflow**

---

## Step 7: Validate parity with Jenkins

| Validation point        | Jenkins result | GitHub Actions result | Match? |
| ----------------------- | -------------- | --------------------- | ------ |
| Docker image built      | Yes            | Yes                   |        |
| Unit tests pass         | 42/42          | 42/42                 |        |
| Lint passes             | Yes            | Yes                   |        |
| Security scan completes | Yes            | Yes                   |        |
| Image pushed to ACR     | Yes            | Yes                   |        |
| Bicep what-if output    | Shows changes  | Shows changes         |        |
| Bicep deploy succeeds   | Yes            | Yes                   |        |
| dbt tests pass          | 18/18          | 18/18                 |        |
| Slack notification      | Received       | Received              |        |
| Approval gate works     | Yes (input)    | Yes (environment)     |        |
| Build time              | ~12 min        | ~8 min                | Faster |

---

## Key improvements over Jenkins version

| Improvement                | Detail                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| **No stored credentials**  | OIDC federation eliminates service principal password storage      |
| **No credential rotation** | OIDC tokens are ephemeral (1-hour lifetime)                        |
| **Docker layer caching**   | `cache-from: type=gha` uses GitHub Actions cache for Docker layers |
| **Dependency caching**     | `actions/setup-python` caches pip packages automatically           |
| **Parallel testing**       | Matrix strategy is more concise than Jenkins `parallel {}` block   |
| **Environment approval**   | Protection rules are configured once in settings, not per-pipeline |
| **Path filtering**         | Docs-only changes skip CI entirely                                 |
| **Concurrency control**    | Automatic cancellation of superseded runs                          |
| **Security scanning**      | CodeQL replaces SonarQube (no external server needed)              |
| **Hosted runners**         | No agent infrastructure to manage                                  |

---

## Next steps

1. **Disable the Jenkins job** --- After 2 weeks of successful dual-running, disable the Jenkins job.
2. **Convert remaining pipelines** --- Apply the same patterns to other Jenkins pipelines.
3. **Build reusable workflows** --- Extract common patterns (OIDC login, Bicep deploy, dbt test) into reusable workflows.
4. **Apply security hardening** --- Follow the [Best Practices](best-practices.md) guide.
