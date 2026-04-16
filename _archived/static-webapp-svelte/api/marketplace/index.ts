/**
 * Azure Function proxy for /api/marketplace.
 * Forwards requests to the shared backend API.
 */

import { createProxyFunction } from '../shared/proxy';

export default createProxyFunction('marketplace');
