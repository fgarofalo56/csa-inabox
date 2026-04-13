# Create_WHL.ps1
# DEPRECATED: This script is no longer used.
#
# Wheel packaging for Synapse custom libraries has been replaced by:
#   1. Databricks Repos / dbutils.library.install() for notebooks
#   2. pyproject.toml [build-system] for governance packages
#   3. Container Registry (DMLZ) for Function App dependencies
#
# This file is retained for historical reference only.
# See docs/DATABRICKS_GUIDE.md for the current library deployment workflow.

Write-Warning "Create_WHL.ps1 is deprecated. See docs/DATABRICKS_GUIDE.md for current workflows."
