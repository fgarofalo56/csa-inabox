# Deprecated ARM Templates

These ARM templates have been superseded by Bicep modules in `deploy/bicep/`.

## Migration Guide

All infrastructure is now managed via Bicep:
- ALZ: `deploy/bicep/LandingZone - ALZ/`
- DMLZ: `deploy/bicep/DMLZ/`
- DLZ: `deploy/bicep/DLZ/`

These ARM templates are retained for reference only and will be removed in a future release.

## Status
- **Status**: Deprecated
- **Replacement**: Bicep modules in `deploy/bicep/`
- **Planned removal**: Next major version
