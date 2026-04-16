#!/usr/bin/env bash
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner')

echo "Configuring GitHub Environments for $REPO"
echo "==========================================="

# Create environments
for env in dev staging prod; do
  gh api "repos/$REPO/environments/$env" -X PUT --input - <<EOF
{
  "wait_timer": 0,
  "deployment_branch_policy": {
    "protected_branches": $([ "$env" = "prod" ] && echo "true" || echo "false"),
    "custom_branch_policies": $([ "$env" = "prod" ] && echo "false" || echo "true")
  }
}
EOF
  echo "Created environment: $env"
done

echo ""
echo "==========================================="
echo "Manual steps required:"
echo "==========================================="
echo "1. Go to Settings -> Environments -> prod -> Required reviewers"
echo "   Add at least 2 reviewers for production deployments"
echo "   NOTE: prevent_self_review is currently DISABLED because there is"
echo "   only one reviewer. Enable it when a second reviewer is added."
echo "2. Go to Settings -> Environments -> prod -> Deployment branches"
echo "   Set to 'Protected branches only' (main)"
echo "3. Go to Settings -> Environments -> staging -> Deployment branches"
echo "   Set to 'Selected branches' and add 'release/*' and 'main'"
