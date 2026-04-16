/**
 * Azure Function proxy for /api/pipelines.
 * Forwards requests to the shared backend API.
 */

import { createProxyFunction } from '../shared/proxy';

export default createProxyFunction('pipelines');
