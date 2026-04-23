"""CSA-in-a-Box Data Marketplace.

The marketplace API endpoints and models live in the portal package:

- Models: ``portal.shared.api.models.marketplace``
- Router: ``portal.shared.api.routers.marketplace``

This package provides supporting services:

- ``purview_sync``: Sync data products to Microsoft Purview
- ``notifications``: Publish marketplace events to Event Grid
- ``contract_validator``: Validate data product contracts
- ``deploy/marketplace.bicep``: Infrastructure deployment

See also: ``scripts/marketplace/`` for CLI tools and contract templates.
"""

from csa_platform.data_marketplace.notifications import NotificationService
from csa_platform.data_marketplace.purview_sync import PurviewSyncService

__all__ = ["NotificationService", "PurviewSyncService"]
