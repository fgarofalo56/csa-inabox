/**
 * Azure Function proxy for /api/sources.
 * Forwards requests to the shared backend API.
 */

import { createProxyFunction } from '../shared/proxy';

export default createProxyFunction('sources');
