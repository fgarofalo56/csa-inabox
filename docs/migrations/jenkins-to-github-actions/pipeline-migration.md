# Pipeline Migration --- Jenkinsfile to GitHub Actions Workflow

**Audience:** DevOps Engineer, Platform Engineer, Developer
**Reading time:** 15 minutes
**Last updated:** 2026-04-30

---

## Overview

This guide walks through the systematic conversion of Jenkins declarative and scripted pipelines to GitHub Actions workflow YAML. Each section addresses a specific pipeline construct with before/after examples, behavioral differences, and migration tips.

---

## 1. Pipeline structure

### Declarative pipeline to workflow YAML

=== "Jenkins Declarative"

    ```groovy
    pipeline {
        agent any
        options {
            timeout(time: 30, unit: 'MINUTES')
            disableConcurrentBuilds()
        }
        stages {
            stage('Build') {
                steps {
                    sh 'make build'
                }
            }
            stage('Test') {
                steps {
                    sh 'make test'
                }
            }
            stage('Deploy') {
                when { branch 'main' }
                steps {
                    sh 'make deploy'
                }
            }
        }
    }
    ```

=== "GitHub Actions"

    ```yaml
    name: Build, Test, Deploy

    on:
      push:
        branches: [main, develop]
      pull_request:
        branches: [main]

    concurrency:
      group: ${{ github.workflow }}-${{ github.ref }}

    jobs:
      build:
        runs-on: ubuntu-latest
        timeout-minutes: 30
        steps:
          - uses: actions/checkout@v4
          - run: make build

      test:
        runs-on: ubuntu-latest
        needs: build
        timeout-minutes: 30
        steps:
          - uses: actions/checkout@v4
          - run: make test

      deploy:
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        needs: test
        timeout-minutes: 30
        steps:
          - uses: actions/checkout@v4
          - run: make deploy
    ```

**Key differences:**

- Each Jenkins `stage` maps to a GitHub Actions `job`. Jobs run on separate runners.
- `agent any` becomes `runs-on: ubuntu-latest` on each job.
- `disableConcurrentBuilds()` becomes `concurrency:` at the workflow level.
- `when { branch 'main' }` becomes `if: github.ref == 'refs/heads/main'` on the job.
- Each job needs its own `actions/checkout` step --- there is no shared workspace between jobs.

---

## 2. Parallel stages to matrix strategy

=== "Jenkins Parallel"

    ```groovy
    stage('Test') {
        parallel {
            stage('Unit Tests') {
                agent { label 'linux' }
                steps {
                    sh 'npm run test:unit'
                }
            }
            stage('Integration Tests') {
                agent { label 'linux' }
                steps {
                    sh 'npm run test:integration'
                }
            }
            stage('E2E Tests') {
                agent { label 'linux' }
                steps {
                    sh 'npm run test:e2e'
                }
            }
        }
    }
    ```

=== "GitHub Actions (matrix)"

    ```yaml
    test:
      runs-on: ubuntu-latest
      strategy:
        matrix:
          suite: [unit, integration, e2e]
        fail-fast: false
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 20
            cache: npm
        - run: npm ci
        - run: npm run test:${{ matrix.suite }}
    ```

=== "GitHub Actions (separate jobs)"

    ```yaml
    unit-tests:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: npm run test:unit

    integration-tests:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: npm run test:integration

    e2e-tests:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: npm run test:e2e
    ```

**When to use matrix vs separate jobs:**

- **Matrix strategy:** Best when jobs differ only by a parameter (test suite, OS, language version). Reduces YAML duplication.
- **Separate jobs:** Best when jobs have different steps, different runners, or different dependencies.

### Multi-dimensional matrix

```yaml
strategy:
    matrix:
        os: [ubuntu-latest, windows-latest]
        python: ["3.10", "3.11", "3.12"]
        exclude:
            - os: windows-latest
              python: "3.10"
        include:
            - os: ubuntu-latest
              python: "3.12"
              coverage: true
```

This generates 5 jobs (2 OS x 3 Python minus 1 exclusion) with a coverage flag on one combination. Jenkins requires a matrix plugin or manual parallel block to achieve this.

---

## 3. Post conditions to job control

=== "Jenkins Post"

    ```groovy
    post {
        always {
            junit 'reports/**/*.xml'
            archiveArtifacts artifacts: 'dist/**', fingerprint: true
        }
        success {
            slackSend channel: '#builds', message: "Build passed"
        }
        failure {
            slackSend channel: '#alerts', message: "Build FAILED"
        }
        cleanup {
            cleanWs()
        }
    }
    ```

=== "GitHub Actions"

    ```yaml
    steps:
      - uses: actions/checkout@v4
      - run: npm run build
      - run: npm test

      # always() --- runs regardless of job status
      - uses: mikepenz/action-junit-report@v4
        if: always()
        with:
          report_paths: reports/**/*.xml

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: dist
          path: dist/

      # success() --- runs only on success (default)
      - uses: slackapi/slack-github-action@v1
        if: success()
        with:
          channel-id: builds
          slack-message: "Build passed"

      # failure() --- runs only on failure
      - uses: slackapi/slack-github-action@v1
        if: failure()
        with:
          channel-id: alerts
          slack-message: "Build FAILED"

      # No cleanup needed --- hosted runners are ephemeral
    ```

**Key differences:**

- Jenkins `post` blocks are structural sections. GitHub Actions uses `if:` conditions on individual steps.
- `always()`, `success()`, `failure()`, and `cancelled()` are built-in status check functions.
- Hosted runners do not need workspace cleanup --- each job gets a fresh VM.

---

## 4. Stash/unstash to artifacts

=== "Jenkins Stash"

    ```groovy
    stage('Build') {
        steps {
            sh 'npm run build'
            stash includes: 'dist/**', name: 'build-output'
        }
    }
    stage('Deploy') {
        steps {
            unstash 'build-output'
            sh 'deploy.sh'
        }
    }
    ```

=== "GitHub Actions Artifacts"

    ```yaml
    build:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - run: npm run build
        - uses: actions/upload-artifact@v4
          with:
            name: build-output
            path: dist/
            retention-days: 1

    deploy:
      runs-on: ubuntu-latest
      needs: build
      steps:
        - uses: actions/download-artifact@v4
          with:
            name: build-output
            path: dist/
        - run: ./deploy.sh
    ```

**Behavioral differences:**

- Jenkins stash is ephemeral within a single build. GitHub Actions artifacts persist beyond the workflow run (configurable retention).
- Artifacts are stored in GitHub's infrastructure and accessible via the UI/API.
- For large artifacts (>500 MB), consider using cloud storage (ADLS, S3) instead of GitHub Artifacts.

---

## 5. Parameters to workflow_dispatch inputs

=== "Jenkins Parameters"

    ```groovy
    pipeline {
        parameters {
            string(name: 'ENVIRONMENT', defaultValue: 'staging',
                   description: 'Target environment')
            choice(name: 'REGION', choices: ['eastus', 'westus2', 'centralus'],
                   description: 'Azure region')
            booleanParam(name: 'DRY_RUN', defaultValue: true,
                        description: 'Preview changes only')
        }
        stages {
            stage('Deploy') {
                steps {
                    sh """
                        az deployment group create \
                            --resource-group rg-${params.ENVIRONMENT} \
                            --template-file main.bicep \
                            --parameters location=${params.REGION} \
                            ${params.DRY_RUN ? '--what-if' : ''}
                    """
                }
            }
        }
    }
    ```

=== "GitHub Actions workflow_dispatch"

    ```yaml
    name: Deploy Infrastructure

    on:
      workflow_dispatch:
        inputs:
          environment:
            description: Target environment
            required: true
            default: staging
            type: choice
            options:
              - dev
              - staging
              - production
          region:
            description: Azure region
            required: true
            default: eastus
            type: choice
            options:
              - eastus
              - westus2
              - centralus
          dry-run:
            description: Preview changes only
            required: true
            default: true
            type: boolean

    jobs:
      deploy:
        runs-on: ubuntu-latest
        environment: ${{ inputs.environment }}
        steps:
          - uses: actions/checkout@v4
          - uses: azure/login@v2
            with:
              client-id: ${{ secrets.AZURE_CLIENT_ID }}
              tenant-id: ${{ secrets.AZURE_TENANT_ID }}
              subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          - name: Deploy Bicep
            run: |
              az deployment group create \
                --resource-group rg-${{ inputs.environment }} \
                --template-file main.bicep \
                --parameters location=${{ inputs.region }} \
                ${{ inputs.dry-run == 'true' && '--what-if' || '' }}
    ```

---

## 6. Environment variables

=== "Jenkins Environment"

    ```groovy
    pipeline {
        environment {
            GLOBAL_VAR = 'available-everywhere'
            SECRET_VAR = credentials('my-secret')
        }
        stages {
            stage('Build') {
                environment {
                    STAGE_VAR = 'only-in-build'
                }
                steps {
                    sh 'echo $GLOBAL_VAR $STAGE_VAR $SECRET_VAR'
                }
            }
        }
    }
    ```

=== "GitHub Actions Environment"

    ```yaml
    env:
      GLOBAL_VAR: available-everywhere

    jobs:
      build:
        runs-on: ubuntu-latest
        env:
          JOB_VAR: only-in-build
        steps:
          - name: Use variables
            env:
              STEP_VAR: only-in-this-step
              SECRET_VAR: ${{ secrets.MY_SECRET }}
            run: echo "$GLOBAL_VAR $JOB_VAR $STEP_VAR $SECRET_VAR"
    ```

**Scoping:**

- GitHub Actions supports three levels of environment variable scoping: workflow, job, and step.
- Secrets are referenced via `${{ secrets.NAME }}` and are automatically masked in logs.
- Dynamic environment variables set with `echo "VAR=value" >> $GITHUB_ENV` are available to subsequent steps.

---

## 7. When conditions to if expressions

=== "Jenkins when"

    ```groovy
    stage('Deploy Staging') {
        when {
            branch 'develop'
            not { changeRequest() }
        }
        steps { sh 'deploy staging' }
    }

    stage('Deploy Production') {
        when {
            allOf {
                branch 'main'
                tag pattern: 'v\\d+\\.\\d+\\.\\d+', comparator: 'REGEXP'
            }
        }
        steps { sh 'deploy production' }
    }

    stage('Skip on Docs') {
        when {
            not { changeset '**/*.md' }
        }
        steps { sh 'run tests' }
    }
    ```

=== "GitHub Actions if"

    ```yaml
    deploy-staging:
      if: github.ref == 'refs/heads/develop' && github.event_name == 'push'
      runs-on: ubuntu-latest
      steps:
        - run: deploy staging

    deploy-production:
      if: >
        github.ref == 'refs/heads/main' &&
        startsWith(github.ref, 'refs/tags/v')
      runs-on: ubuntu-latest
      steps:
        - run: deploy production

    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: dorny/paths-filter@v3
          id: changes
          with:
            filters: |
              code:
                - '!**/*.md'
        - if: steps.changes.outputs.code == 'true'
          run: run tests
    ```

**Common if expressions:**

| Jenkins `when`                                            | GitHub Actions `if:`                                           |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `branch 'main'`                                           | `github.ref == 'refs/heads/main'`                              |
| `not { branch 'main' }`                                   | `github.ref != 'refs/heads/main'`                              |
| `changeRequest()`                                         | `github.event_name == 'pull_request'`                          |
| `tag pattern: 'v*'`                                       | `startsWith(github.ref, 'refs/tags/v')`                        |
| `expression { return env.DEPLOY == 'true' }`              | `env.DEPLOY == 'true'`                                         |
| `equals expected: 'SUCCESS', actual: currentBuild.result` | `success()`                                                    |
| `triggeredBy 'TimerTrigger'`                              | `github.event_name == 'schedule'`                              |
| `environment name: 'prod'`                                | Use `environment:` on job for approval gates                   |
| `beforeAgent true`                                        | Default behavior (conditions checked before runner allocation) |

---

## 8. Scripted pipeline conversion

Scripted pipelines use arbitrary Groovy and require more effort to convert. The strategy is to decompose the Groovy logic into discrete steps and conditional expressions.

=== "Jenkins Scripted"

    ```groovy
    node('linux') {
        def services = ['api', 'web', 'worker']
        def deployEnv = env.BRANCH_NAME == 'main' ? 'production' : 'staging'

        stage('Checkout') {
            checkout scm
        }

        stage('Build') {
            for (svc in services) {
                stage("Build ${svc}") {
                    sh "docker build -t myapp-${svc}:${env.BUILD_NUMBER} ./services/${svc}"
                }
            }
        }

        stage('Test') {
            parallel services.collectEntries { svc ->
                [(svc): {
                    sh "docker run myapp-${svc}:${env.BUILD_NUMBER} npm test"
                }]
            }
        }

        stage('Deploy') {
            if (deployEnv == 'production') {
                input message: 'Deploy to production?'
            }
            for (svc in services) {
                sh "deploy ${svc} ${deployEnv}"
            }
        }
    }
    ```

=== "GitHub Actions"

    ```yaml
    name: Multi-Service Pipeline

    on:
      push:
        branches: [main, develop]

    jobs:
      build:
        runs-on: ubuntu-latest
        strategy:
          matrix:
            service: [api, web, worker]
        steps:
          - uses: actions/checkout@v4
          - run: >
              docker build
              -t myapp-${{ matrix.service }}:${{ github.run_number }}
              ./services/${{ matrix.service }}
          - uses: actions/upload-artifact@v4
            with:
              name: image-${{ matrix.service }}
              path: ./services/${{ matrix.service }}/Dockerfile

      test:
        runs-on: ubuntu-latest
        needs: build
        strategy:
          matrix:
            service: [api, web, worker]
        steps:
          - uses: actions/checkout@v4
          - run: >
              docker build
              -t myapp-${{ matrix.service }}:${{ github.run_number }}
              ./services/${{ matrix.service }}
          - run: >
              docker run myapp-${{ matrix.service }}:${{ github.run_number }}
              npm test

      deploy:
        runs-on: ubuntu-latest
        needs: test
        environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
        strategy:
          matrix:
            service: [api, web, worker]
          max-parallel: 1
        steps:
          - uses: actions/checkout@v4
          - run: deploy ${{ matrix.service }} ${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
    ```

**Conversion patterns for scripted pipelines:**

| Groovy pattern         | GitHub Actions equivalent                  |
| ---------------------- | ------------------------------------------ |
| `for (item in list)`   | `strategy: matrix:`                        |
| `if (condition)`       | `if:` expression on job or step            |
| `input message: '...'` | `environment:` with required reviewers     |
| `def var = ...`        | `env:` or step outputs                     |
| `parallel(map)`        | Matrix strategy or independent jobs        |
| `try/catch/finally`    | `continue-on-error: true` + `if: always()` |
| `node('label') { }`    | `runs-on: [self-hosted, label]`            |
| `load 'script.groovy'` | Composite action or reusable workflow      |

---

## 9. Shared libraries to reusable workflows

=== "Jenkins Shared Library"

    ```groovy
    // vars/standardPipeline.groovy
    def call(Map config) {
        pipeline {
            agent any
            stages {
                stage('Build') {
                    steps {
                        sh config.buildCommand ?: 'make build'
                    }
                }
                stage('Test') {
                    steps {
                        sh config.testCommand ?: 'make test'
                    }
                }
                stage('Deploy') {
                    when { branch 'main' }
                    steps {
                        sh "deploy ${config.appName} ${config.environment}"
                    }
                }
            }
        }
    }

    // Usage in Jenkinsfile:
    @Library('my-shared-lib') _
    standardPipeline(
        appName: 'my-app',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        environment: 'production'
    )
    ```

=== "GitHub Actions Reusable Workflow"

    ```yaml
    # .github/workflows/reusable-standard-pipeline.yml
    name: Standard Pipeline
    on:
      workflow_call:
        inputs:
          app-name:
            required: true
            type: string
          build-command:
            required: false
            type: string
            default: make build
          test-command:
            required: false
            type: string
            default: make test
          environment:
            required: true
            type: string
        secrets:
          AZURE_CLIENT_ID:
            required: true
          AZURE_TENANT_ID:
            required: true
          AZURE_SUBSCRIPTION_ID:
            required: true

    jobs:
      build:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
          - run: ${{ inputs.build-command }}

      test:
        runs-on: ubuntu-latest
        needs: build
        steps:
          - uses: actions/checkout@v4
          - run: ${{ inputs.test-command }}

      deploy:
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        needs: test
        environment: ${{ inputs.environment }}
        steps:
          - uses: actions/checkout@v4
          - uses: azure/login@v2
            with:
              client-id: ${{ secrets.AZURE_CLIENT_ID }}
              tenant-id: ${{ secrets.AZURE_TENANT_ID }}
              subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
          - run: deploy ${{ inputs.app-name }} ${{ inputs.environment }}
    ```

    ```yaml
    # Usage in consuming repository:
    # .github/workflows/ci.yml
    name: CI
    on: [push, pull_request]
    jobs:
      pipeline:
        uses: my-org/.github/.github/workflows/reusable-standard-pipeline.yml@main
        with:
          app-name: my-app
          build-command: npm run build
          test-command: npm test
          environment: production
        secrets:
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
    ```

---

## 10. CSA-in-a-Box pipeline conversion example

A typical CSA-in-a-Box Jenkins pipeline that deploys Bicep infrastructure and runs dbt tests converts as follows:

=== "Jenkins (CSA-in-a-Box)"

    ```groovy
    pipeline {
        agent any
        parameters {
            choice(name: 'ENVIRONMENT', choices: ['dev', 'staging', 'prod'])
        }
        environment {
            AZURE_CREDS = credentials('azure-sp')
        }
        stages {
            stage('Bicep What-If') {
                steps {
                    withCredentials([azureServicePrincipal('azure-sp')]) {
                        sh '''
                            az login --service-principal -u $AZURE_CLIENT_ID \
                                -p $AZURE_CLIENT_SECRET --tenant $AZURE_TENANT_ID
                            az deployment group what-if \
                                --resource-group rg-csa-${ENVIRONMENT} \
                                --template-file infra/main.bicep
                        '''
                    }
                }
            }
            stage('Bicep Deploy') {
                when { branch 'main' }
                input { message 'Deploy infrastructure?' }
                steps {
                    sh 'az deployment group create ...'
                }
            }
            stage('dbt Test') {
                steps {
                    sh 'pip install dbt-databricks && dbt test'
                }
            }
        }
    }
    ```

=== "GitHub Actions (CSA-in-a-Box)"

    ```yaml
    name: CSA-in-a-Box Deploy

    on:
      push:
        branches: [main]
      pull_request:
        branches: [main]
      workflow_dispatch:
        inputs:
          environment:
            type: choice
            options: [dev, staging, prod]
            default: dev

    permissions:
      id-token: write
      contents: read

    jobs:
      bicep-what-if:
        runs-on: ubuntu-latest
        environment: ${{ inputs.environment || 'dev' }}
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
                --resource-group rg-csa-${{ inputs.environment || 'dev' }} \
                --template-file infra/main.bicep

      bicep-deploy:
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        needs: bicep-what-if
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
                --template-file infra/main.bicep

      dbt-test:
        runs-on: ubuntu-latest
        needs: bicep-deploy
        steps:
          - uses: actions/checkout@v4
          - uses: actions/setup-python@v5
            with:
              python-version: "3.11"
              cache: pip
          - run: pip install dbt-databricks
          - run: dbt deps && dbt test
            env:
              DBT_PROFILES_DIR: ./profiles
    ```

**Key improvements in the GitHub Actions version:**

- OIDC authentication (no stored service principal password)
- Environment protection rules replace Jenkins `input` step
- Dependency caching for pip
- No service principal secret rotation needed

---

## Next steps

1. **Map your plugins** --- Check the [Plugin Migration Reference](plugin-migration.md) for each Jenkins plugin your pipelines use.
2. **Migrate credentials** --- Follow the [Secret Migration Guide](secret-migration.md) to set up OIDC and GitHub Secrets.
3. **Try the automated importer** --- The [Actions Importer Tutorial](tutorial-actions-importer.md) automates initial conversion.
4. **Walk through a real conversion** --- The [Pipeline Conversion Tutorial](tutorial-pipeline-conversion.md) provides a hands-on exercise.
