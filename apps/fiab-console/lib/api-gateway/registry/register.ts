/**
 * Side-effect module: plugs the gateway registry into the environments feature
 * (W1-4) by registering its ClassificationStore at module load. Import it (once)
 * from any module that must see gateways as classifiable.
 */
import { registerClassificationStore } from '../environments/deps';
import { createGatewayClassificationStore } from './classification-store';
import { cosmosGatewayRepo } from './deps';

registerClassificationStore(createGatewayClassificationStore(cosmosGatewayRepo));
