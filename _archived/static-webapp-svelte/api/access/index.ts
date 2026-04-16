/**
 * Azure Function proxy for /api/access.
 * Forwards requests to the shared backend API.
 */

import { createProxyFunction } from '../shared/proxy';

export default createProxyFunction('access');
